import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { runEphemeralBacktestSync, runWithEphemeralListener } from './backtestSync'
import { TelegramSessionInvalidError } from './telegramClient'
import { ChannelInfo, ListenerStatus, UserListener, type SignalReconcileStats } from './userListener'
import {
  acquireSessionLease,
  countFreshListenerLeasesForUsers,
  ensureSessionLeaseFresh,
  isLeaseRowLive,
  listActiveLeases,
  listOwnedActiveLeases,
  releaseOwnedSessionLeases,
  releaseSessionLease,
} from './sessionLease'
import { getMetricsSnapshot } from './workerMetrics'
import { leaseRoleLabel, userBelongsToShard, workerConfig } from './workerConfig'
import { parallelMap } from './parallelPool'
import type { TradeExecutor } from './tradeExecutor'
import type { SignalRow } from './tradeExecutor/types'
import { dispatchPriorityForAction, parsedAction } from './tradeSignalActions'
import { ChannelListenerManager } from './channelListenerManager'
import { ChannelReconcileMonitor } from './channelReconcileMonitor'
import { isChannelFeedLiveForSubscriber } from './channelFeedGate'
import { channelListenerPrimaryMode } from './channelListenerConfig'
import { userMayRunCopierListener } from './subscriptionAccess'
import { authKeyDupReconnectDelayMs, authKeyDupReconnectDelaysMs } from './authKeyDuplicatedRecovery'
import { captureWorkerError, captureWorkerWarning } from './observability/sentry'
import { captureBusinessIssue } from './observability/businessEvents'
import { maybeCaptureCopierOffline, persistCopierHealth } from './copierHealth'

/**
 * Race a promise against a timeout so a single wedged network call cannot
 * stall a whole loop forever. Does not cancel the underlying work (the
 * caller just stops waiting), which is enough to keep periodic loops alive.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function listenerInProcessDispatch(executor: TradeExecutor, row: SignalRow): boolean {
  return executor.acceptDispatchSignal(row, {
    priority: dispatchPriorityForAction(parsedAction(row.parsed_data)),
    source: row.dispatch_source ?? 'in_process',
  })
}

export { TelegramSessionInvalidError }

function gramjsListenerEnabled(): boolean {
  const engine = String(process.env.LISTENER_ENGINE ?? 'gramjs').toLowerCase().trim()
  return engine !== 'telethon'
}

function shouldRunGramjsForSession(session: { listener_engine?: string | null }): boolean {
  if (!gramjsListenerEnabled()) return false
  const engine = String(session.listener_engine ?? 'gramjs').toLowerCase().trim()
  return engine !== 'telethon'
}

/** Wait after disconnect so Telegram releases the auth key before a new connect. */
function authKeyReleaseDelayMs(): number {
  return Math.max(500, Math.min(120_000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)))
}

function listenerStartTimeoutMs(): number {
  return Math.max(
    15_000,
    Math.min(180_000, Number(process.env.LISTENER_START_TIMEOUT_MS ?? 60_000)),
  )
}

/** Consecutive renew ticks with MTProto down before hard-resetting the Map entry. */
function disconnectedRenewHealTicks(): number {
  return Math.max(
    2,
    Math.min(20, Number(process.env.LISTENER_DISCONNECT_HEAL_TICKS ?? 3)),
  )
}

export class UserSessionManager {
  private listeners = new Map<string, UserListener>()
  private supabase: SupabaseClient
  private channelChannel: RealtimeChannel | null = null
  private authPendingChannel: RealtimeChannel | null = null
  private realtimeHealthTimer: NodeJS.Timeout | null = null
  /** One pending retry timer per realtime topic — prevents retry storms. */
  private realtimeRetryTimers = new Map<string, NodeJS.Timeout>()
  /** Consecutive failed attempts per topic; drives exponential backoff. */
  private realtimeRetryAttempts = new Map<string, number>()
  /** Monotonic counter so every realtime channel gets a unique topic name. */
  private realtimeChannelSeq = 0
  private tradeExecutor: TradeExecutor | null = null
  /** Serializes start/stop/adopt for one user — prevents AUTH_KEY_DUPLICATED races. */
  private userConnectionLocks = new Map<string, Promise<void>>()
  /** True while adoptClient is handing off the auth-time MTProto socket. */
  private adoptingUsers = new Set<string>()
  private authGuard: ((userId: string) => boolean) | null = null
  /** Guards renewAllLeases so slow cycles cannot stack up and exhaust sockets. */
  private renewLeasesInFlight = false
  /** Wall-clock start of the in-flight renew cycle (for stuck-guard). */
  private renewLeasesInFlightSinceMs = 0
  /** Renew ticks spent disconnected; cleared when connected again. */
  private disconnectedRenewTicks = new Map<string, number>()
  private channelListenerManager: ChannelListenerManager | null = null
  private channelReconcileMonitor: ChannelReconcileMonitor | null = null
  private shuttingDown = false
  /** Tracks start failures with timestamps so syncSessions doesn't retry in a tight loop. */
  private recentlyFailed = new Map<string, number>()

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase
    this.channelListenerManager = new ChannelListenerManager(supabase)
    this.channelReconcileMonitor = new ChannelReconcileMonitor(
      supabase,
      async (readerUserId, signalChannelId, telegramChatId) => {
        const listener = this.listeners.get(readerUserId)
        if (!listener?.isTelegramConnected()) return null
        const row = {
          id: '',
          channel_id: telegramChatId,
          channel_username: '',
          signal_channel_id: signalChannelId,
          last_seen_message_id: null,
        }
        return {
          client: listener.getClient(),
          resolvePeer: () => listener.resolveChannelPeerForReconcile(row),
        }
      },
    )
  }

  getListener(userId: string): UserListener | undefined {
    return this.listeners.get(userId)
  }

  async startChannelListenerServices(): Promise<void> {
    if (!this.channelListenerManager) return
    await this.channelListenerManager.startup()
    this.channelListenerManager.startPeriodicSync()
    this.channelReconcileMonitor?.start()
  }

  stopChannelListenerServices(): void {
    this.stopRealtimeHealthCheck()
    this.channelListenerManager?.stop()
    this.channelReconcileMonitor?.stop()
  }

  /** In-memory pending auth check (send_code → verify_code window on this process). */
  setAuthGuard(fn: (userId: string) => boolean): void {
    this.authGuard = fn
  }

  private async withConnectionLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userConnectionLocks.get(userId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const chain = prev.then(() => gate)
    this.userConnectionLocks.set(userId, chain)
    try {
      await prev
      return await fn()
    } finally {
      release()
      if (this.userConnectionLocks.get(userId) === chain) {
        this.userConnectionLocks.delete(userId)
      }
    }
  }

  private isAuthBlocked(userId: string): boolean {
    return this.adoptingUsers.has(userId) || Boolean(this.authGuard?.(userId))
  }

  private async hasActivePendingAuthInDb(userId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('telegram_auth_pending')
      .select('user_id')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return Boolean(data)
  }

  private async shouldSkipListenerStart(userId: string): Promise<boolean> {
    if (this.isAuthBlocked(userId)) return true
    if (await this.hasActivePendingAuthInDb(userId)) return true
    if (!(await userMayRunCopierListener(this.supabase, userId))) return true
    return false
  }

  private async listenerStartBlockReason(userId: string): Promise<string | null> {
    if (this.isAuthBlocked(userId)) return 'Telegram auth is in progress. Finish linking, then try again.'
    if (await this.hasActivePendingAuthInDb(userId)) {
      return 'Telegram auth is in progress. Finish linking, then try again.'
    }
    if (!(await userMayRunCopierListener(this.supabase, userId))) {
      return 'An active subscription is required to connect Telegram.'
    }
    return null
  }

  /** Stop listener + release lease when subscription is no longer active. */
  private async stopListenerIfCopierInactive(userId: string): Promise<void> {
    if (await userMayRunCopierListener(this.supabase, userId)) return
    if (this.listeners.has(userId)) {
      console.log(`[sessionManager] stopping listener for ${userId}: subscription inactive`)
      await this.stopListener(userId)
    } else {
      await releaseSessionLease(this.supabase, userId)
    }
  }

  getSupabase(): SupabaseClient {
    return this.supabase
  }

  setTradeExecutor(executor: TradeExecutor | null): void {
    this.tradeExecutor = executor
    for (const listener of this.listeners.values()) {
      listener.setOnSignalParsed(
        executor ? row => listenerInProcessDispatch(executor, row) : null,
      )
    }
  }

  async loadAll() {
    if (this.shuttingDown) return
    if (!workerConfig.runsListener) return
    if (!gramjsListenerEnabled()) {
      console.log('[sessionManager] LISTENER_ENGINE=telethon — gramjs listener disabled on this service')
      return
    }

    const { data: sessions, error } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, phone_number, listener_engine')
      .eq('is_active', true)

    if (error) {
      console.error('[sessionManager] Failed to load sessions:', error.message)
      return
    }

    const owned = (sessions ?? []).filter(
      s => userBelongsToShard(s.user_id) && shouldRunGramjsForSession(s),
    )
    console.log(
      `[sessionManager] Loading ${owned.length}/${sessions?.length ?? 0} sessions`
      + ` (shard ${workerConfig.shardId}/${workerConfig.shardCount})`,
    )

    const staggerMs = Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)))
    const startTimeoutMs = listenerStartTimeoutMs()
    let i = 0
    for (const session of owned) {
      if (i++ > 0 && staggerMs > 0) {
        await new Promise(r => setTimeout(r, staggerMs))
      }
      try {
        // Bound each connect so one wedged listener (e.g. a hung Telegram
        // warm-up) cannot stall startup for every other session.
        await withTimeout(
          this.startListener(session.user_id, session.session_string),
          startTimeoutMs,
          `startListener ${session.user_id}`,
        )
      } catch (err) {
        console.error(
          `[sessionManager] Failed to start listener for ${session.user_id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    this.subscribeToChannelChanges()
    this.subscribeToAuthPendingChanges()
    this.startRealtimeHealthCheck()
  }

  async renewAllLeases(): Promise<void> {
    if (this.shuttingDown) return
    // A previous cycle is still running (a wedged Supabase / Telegram call).
    // Skip rather than stacking overlapping runs — but if the previous cycle
    // has been stuck longer than the budget, force-clear the guard. Without
    // this, one hung eligibility/auth/stopListener call leaves renewLeasesInFlight
    // true forever: every later tick skips, all leases expire, Admin shows
    // every copier offline while Telegram listeners stay connected in-memory.
    const cycleBudgetMs = Math.max(
      30_000,
      Math.min(180_000, Number(process.env.WORKER_LEASE_RENEW_CYCLE_TIMEOUT_MS ?? 90_000)),
    )
    if (this.renewLeasesInFlight) {
      const stuckForMs = Date.now() - this.renewLeasesInFlightSinceMs
      if (stuckForMs < cycleBudgetMs) {
        console.warn('[sessionManager] renewAllLeases skipped — previous cycle still running')
        return
      }
      console.error(
        `[sessionManager] renewAllLeases force-clearing stuck in-flight guard`
        + ` after ${stuckForMs}ms (budget ${cycleBudgetMs}ms)`,
      )
      this.renewLeasesInFlight = false
    }
    this.renewLeasesInFlight = true
    this.renewLeasesInFlightSinceMs = Date.now()
    try {
      const staleMs = Math.max(
        60_000,
        Math.min(600_000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000)),
      )
      const perUserTimeoutMs = Math.max(
        3_000,
        Math.min(30_000, Number(process.env.WORKER_LEASE_RENEW_TIMEOUT_MS ?? 8_000)),
      )
      // Eligibility + auth checks + optional stopListener are not covered by the
      // lease-write timeout alone — budget the whole per-user renew body.
      const perUserBudgetMs = Math.max(
        perUserTimeoutMs + 5_000,
        Math.min(45_000, Number(process.env.WORKER_LEASE_RENEW_USER_BUDGET_MS ?? 20_000)),
      )
      const concurrency = Math.max(
        1,
        Math.min(16, Number(process.env.WORKER_LEASE_RENEW_CONCURRENCY ?? 6)),
      )

      // Renew with bounded parallelism and a per-user timeout so a single slow
      // or wedged lease write cannot block renewal for every other listener.
      const entries = Array.from(this.listeners.entries())
      await withTimeout(
        parallelMap(entries, concurrency, async ([userId, listener]) => {
          try {
            await withTimeout(
              this.renewOneListenerLease(userId, listener, {
                staleMs,
                perUserTimeoutMs,
              }),
              perUserBudgetMs,
              `lease renew body ${userId}`,
            )
          } catch (err) {
            console.warn(
              `[sessionManager] lease renew body failed ${userId}:`,
              err instanceof Error ? err.message : err,
            )
          }
        }),
        cycleBudgetMs,
        'renewAllLeases cycle',
      )
    } catch (err) {
      console.warn(
        '[sessionManager] renewAllLeases cycle aborted:',
        err instanceof Error ? err.message : err,
      )
    } finally {
      this.renewLeasesInFlight = false
    }
  }

  private async renewOneListenerLease(
    userId: string,
    listener: UserListener,
    opts: { staleMs: number; perUserTimeoutMs: number },
  ): Promise<void> {
    if (!(await userMayRunCopierListener(this.supabase, userId))) {
      await this.stopListenerIfCopierInactive(userId)
      return
    }
    // Realtime can lag; also stop when auth / mtproto_hold appears in DB.
    if (await this.hasActivePendingAuthInDb(userId)) {
      await this.stopListenerForPendingAuth(userId)
      return
    }
    if (!listener.isTelegramConnected()) {
      // Dead Map entries used to skip renew forever (UI "Copier engine offline").
      // Kick reconnect first; after several failed ticks, hard-reset so syncSessions
      // can startListener cleanly (reconnect-only can leave No lease forever).
      const ticks = (this.disconnectedRenewTicks.get(userId) ?? 0) + 1
      this.disconnectedRenewTicks.set(userId, ticks)
      const healAfter = disconnectedRenewHealTicks()
      if (ticks >= healAfter) {
        console.warn(
          `[sessionManager] hard-reset disconnected listener user=${userId}`
          + ` after ${ticks} renew ticks — syncSessions will restart`,
        )
        this.disconnectedRenewTicks.delete(userId)
        await this.stopListener(userId)
        return
      }
      console.log(
        `[sessionManager] listener disconnected but renewing lease anyway`
        + ` user=${userId} — kicking reconnect in background`,
      )
      listener.requestReconnectIfDisconnected('lease_renew_disconnected')
    } else {
      // Only reset the counter when the listener is actually connected — an
      // unconditional delete here wiped the count every tick, so the
      // hard-reset after healAfter failed ticks never fired and a wedged
      // listener flapped "disconnected but renewing" forever (incident
      // 2026-09-07, users af75b63e/30c3fa79/494bdb70/dd18ad68).
      this.disconnectedRenewTicks.delete(userId)
    }

    try {
      const result = await withTimeout(
        ensureSessionLeaseFresh(this.supabase, userId),
        opts.perUserTimeoutMs,
        `lease renew ${userId}`,
      )
      if (!result.ok) {
        console.warn(`[sessionManager] lease refresh failed ${userId}: ${result.reason}`)
        return
      }
      if (result.recovered && this.tradeExecutor) {
        const { replaySignalsAfterListenerRecovery } = await import('./listenerSignalReplay')
        void replaySignalsAfterListenerRecovery(this.tradeExecutor, userId)
      }
    } catch (err) {
      console.warn(
        `[sessionManager] lease refresh failed ${userId}:`,
        err instanceof Error ? err.message : err,
      )
      return
    }

    if (!listener.isListenerHealthy(opts.staleMs)) {
      console.warn(
        `[sessionManager] listener quiet but lease renewed user=${userId}`
        + ' (no Telegram events recently — normal for low-traffic channels)',
      )
    }
  }

  private realtimeRetryBaseMs(): number {
    const n = Number(process.env.REALTIME_RETRY_BASE_MS ?? 5000)
    return Number.isFinite(n) && n >= 0 ? n : 5000
  }

  /**
   * Re-subscribe after a realtime channel failure. supabase-js .channel()
   * always registers a NEW channel object, so every failed attempt can leave
   * a zombie behind if removeChannel() never confirms. Sweep ALL channels
   * under the topic prefix (unique names per attempt) before re-subscribing.
   */
  private async resubscribeRealtime(topicPrefix: string, subscribe: () => void) {
    const stale = this.supabase.getChannels().filter(c => c.topic.startsWith(topicPrefix))
    await Promise.all(
      stale.map(c => this.supabase.removeChannel(c).catch(() => { /* best effort */ })),
    )
    subscribe()
  }

  private scheduleRealtimeRetry(topic: string, subscribe: () => void) {
    // Dedup: many zombie channels can fire CLOSED in the same flap; a single
    // pending timer per topic is enough (incident 2026-08-25 retry storm).
    if (this.realtimeRetryTimers.has(topic)) return
    const attempt = this.realtimeRetryAttempts.get(topic) ?? 0
    const delay = Math.min(this.realtimeRetryBaseMs() * 2 ** attempt, 60_000)
    this.realtimeRetryAttempts.set(topic, attempt + 1)
    const timer = setTimeout(() => {
      this.realtimeRetryTimers.delete(topic)
      this.resubscribeRealtime(topic, subscribe).catch(err =>
        console.warn(`[sessionManager] realtime resubscribe for ${topic} failed:`, err),
      )
    }, delay)
    this.realtimeRetryTimers.set(topic, timer)
  }

  private clearRealtimeRetryTimer(topic: string): void {
    const timer = this.realtimeRetryTimers.get(topic)
    if (timer) {
      clearTimeout(timer)
      this.realtimeRetryTimers.delete(topic)
    }
  }

  private subscribeToChannelChanges() {
    if (this.channelChannel) return

    try {
      const topic = 'realtime:telegram_channels_changes'
      const name = `telegram_channels_changes_${++this.realtimeChannelSeq}`
      const ch = this.supabase
        .channel(name)
        .on(
          'postgres_changes' as never,
          { event: '*', schema: 'public', table: 'telegram_channels' } as never,
          (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
            const userId = (payload.new?.user_id ?? payload.old?.user_id) as string | undefined
            if (!userId) return
            if (!userBelongsToShard(userId)) return
            const listener = this.listeners.get(userId)
            if (!listener) return
            listener.onChannelsChanged().catch(err =>
              console.error(`[sessionManager] onChannelsChanged failed for ${userId}:`, err),
            )
          },
        )
      this.channelChannel = ch
      ch.subscribe(status => {
          if (status === 'SUBSCRIBED') {
            console.log('[sessionManager] Realtime telegram_channels subscription active')
            this.realtimeRetryAttempts.delete(topic)
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            // Ignore callbacks from zombie channels that are no longer the
            // current subscription; only the live ref may schedule a retry.
            if (this.channelChannel !== ch) return
            console.warn(`[sessionManager] Realtime telegram_channels subscription ${status} — retrying`)
            const failed = this.channelChannel
            this.channelChannel = null
            // Remove the errored channel from the client registry before
            // retrying; otherwise supabase-js returns the same already-
            // subscribed instance and re-registering handlers throws an
            // uncaught error that kills the worker (incident 2026-08-24).
            if (failed) this.supabase.removeChannel(failed).catch(() => { /* swept by resubscribeRealtime */ })
            this.scheduleRealtimeRetry(topic, () => this.subscribeToChannelChanges())
          }
        })
    } catch (err) {
      console.warn(
        '[sessionManager] telegram_channels resubscribe failed — retrying:',
        err instanceof Error ? err.message : err,
      )
      this.channelChannel = null
      this.scheduleRealtimeRetry('realtime:telegram_channels_changes', () => this.subscribeToChannelChanges())
    }
  }

  private subscribeToAuthPendingChanges() {
    if (this.authPendingChannel) return

    try {
      const topic = 'realtime:telegram_auth_pending_changes'
      const name = `telegram_auth_pending_changes_${++this.realtimeChannelSeq}`
      const ch = this.supabase
        .channel(name)
        .on(
          'postgres_changes' as never,
          { event: '*', schema: 'public', table: 'telegram_auth_pending' } as never,
          (payload: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
            const userId = (payload.new?.user_id ?? payload.old?.user_id) as string | undefined
            if (!userId || !userBelongsToShard(userId)) return
            if (payload.eventType === 'DELETE') {
              void this.onAuthPendingCleared(userId)
              return
            }
            void this.stopListenerForPendingAuth(userId)
          },
        )
      this.authPendingChannel = ch
      ch.subscribe(status => {
          if (status === 'SUBSCRIBED') {
            console.log('[sessionManager] Realtime telegram_auth_pending subscription active')
            this.realtimeRetryAttempts.delete(topic)
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            if (this.authPendingChannel !== ch) return
            console.warn(`[sessionManager] Realtime telegram_auth_pending subscription ${status} — retrying`)
            const failed = this.authPendingChannel
            this.authPendingChannel = null
            if (failed) this.supabase.removeChannel(failed).catch(() => { /* swept by resubscribeRealtime */ })
            this.scheduleRealtimeRetry(topic, () => this.subscribeToAuthPendingChanges())
          }
        })
    } catch (err) {
      console.warn(
        '[sessionManager] telegram_auth_pending resubscribe failed — retrying:',
        err instanceof Error ? err.message : err,
      )
      this.authPendingChannel = null
      this.scheduleRealtimeRetry('realtime:telegram_auth_pending_changes', () => this.subscribeToAuthPendingChanges())
    }
  }

  private startRealtimeHealthCheck(): void {
    this.stopRealtimeHealthCheck()
    this.realtimeHealthTimer = setInterval(() => {
      if (!this.channelChannel) {
        console.warn('[sessionManager] Health check: telegram_channels subscription missing — re-subscribing')
        this.subscribeToChannelChanges()
      }
      if (!this.authPendingChannel) {
        console.warn('[sessionManager] Health check: telegram_auth_pending subscription missing — re-subscribing')
        this.subscribeToAuthPendingChanges()
      }
    }, 60_000)
  }

  private stopRealtimeHealthCheck(): void {
    if (this.realtimeHealthTimer) {
      clearInterval(this.realtimeHealthTimer)
      this.realtimeHealthTimer = null
    }
  }

  /**
   * Stop the live listener and wait until the session lease is gone before opening
   * a fresh MTProto client for phone/QR auth (avoids AUTH_KEY_DUPLICATED and
   * headless sessions eating login codes).
   */
  async prepareForAuth(userId: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Telegram worker is shutting down')
    }
    if (workerConfig.runsListener) {
      await this.withConnectionLock(userId, async () => {
        await this.disconnectListener(userId)
      })
    }
    await this.waitForListenerLeaseReleased(userId)
    const delay = authKeyReleaseDelayMs()
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
  }

  /** Stop the live listener before send_code so the auth key slot is free on this host. */
  async pauseForAuth(userId: string, opts?: { releaseDelay?: boolean }): Promise<void> {
    if (this.shuttingDown) return
    if (!workerConfig.runsListener) return
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
      if (opts?.releaseDelay === false) return
      const delay = authKeyReleaseDelayMs()
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    })
  }

  private async stopListenerForPendingAuth(userId: string): Promise<void> {
    if (!this.listeners.has(userId)) return
    console.log(`[sessionManager] stopping listener for ${userId} — telegram auth / mtproto hold`)
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
    })
  }

  /**
   * Ask the listener shard to release this user's MTProto slot (via telegram_auth_pending
   * Realtime + lease renew guard), then wait until the session lease is gone.
   */
  private async acquireMtprotoHold(userId: string): Promise<boolean> {
    const { data: existing } = await this.supabase
      .from('telegram_auth_pending')
      .select('auth_method, expires_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (
      existing
      && existing.auth_method
      && existing.auth_method !== 'mtproto_hold'
      && new Date(existing.expires_at).getTime() > Date.now()
    ) {
      throw new Error('Telegram auth is in progress. Finish linking, then retry.')
    }

    const holdMs = Math.max(
      5 * 60_000,
      Math.min(2 * 60 * 60_000, Number(process.env.MTPROTO_HOLD_TTL_MS ?? 45 * 60_000)),
    )
    const expiresAt = new Date(Date.now() + holdMs).toISOString()
    const { error } = await this.supabase.from('telegram_auth_pending').upsert(
      {
        user_id: userId,
        auth_method: 'mtproto_hold',
        phone: null,
        phone_code_hash: null,
        expires_at: expiresAt,
        awaiting_password: false,
        auth_session_string: null,
        qr_expires_at: null,
      },
      { onConflict: 'user_id' },
    )
    if (error) {
      console.error(`[sessionManager] mtproto_hold upsert failed for ${userId}:`, error.message)
      throw new Error('Could not pause live Telegram for this task. Try again in a minute.')
    }
    console.log(`[sessionManager] acquired mtproto_hold for ${userId}`)
    return true
  }

  private async releaseMtprotoHold(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('telegram_auth_pending')
      .delete()
      .eq('user_id', userId)
      .eq('auth_method', 'mtproto_hold')
    if (error) {
      console.warn(`[sessionManager] mtproto_hold release failed for ${userId}:`, error.message)
      return
    }
    console.log(`[sessionManager] released mtproto_hold for ${userId}`)
  }

  /** Poll until the listener shard has dropped its session lease (or timeout). */
  private async waitForListenerLeaseReleased(userId: string): Promise<void> {
    const timeoutMs = Math.max(
      10_000,
      Math.min(120_000, Number(process.env.MTPROTO_HOLD_WAIT_MS ?? 45_000)),
    )
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const { data } = await this.supabase
        .from('worker_session_leases')
        .select('expires_at, role')
        .eq('user_id', userId)
        .maybeSingle()
      if (!isLeaseRowLive(data)) {
        console.log(
          `[sessionManager] listener lease released for ${userId}`
          + ` after ${Date.now() - started}ms`,
        )
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(
      'Telegram is still connected on the live worker. Wait a minute and retry, or use Reconnect Telegram.',
    )
  }

  private async onAuthPendingCleared(userId: string): Promise<void> {
    // Debounce brief DELETE→upsert races (verify finalize, cancel). Auth start now
    // upserts in place so send_code no longer clears into an empty window.
    await new Promise(r => setTimeout(r, 2500))
    if (this.listeners.has(userId) || this.isAuthBlocked(userId)) return
    if (await this.hasActivePendingAuthInDb(userId)) return
    const { data: sess } = await this.supabase
      .from('telegram_sessions')
      .select('session_string, is_active, listener_engine')
      .eq('user_id', userId)
      .maybeSingle()
    if (!sess?.session_string || !sess.is_active || !shouldRunGramjsForSession(sess)) return
    try {
      await this.startListener(userId, sess.session_string)
    } catch (err) {
      console.warn(`[sessionManager] restart after auth cleared failed for ${userId}:`, err)
    }
  }

  async syncSessions() {
    if (!workerConfig.runsListener) return

    const { data: sessions } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, is_active, listener_engine')

    const activeOnShard = (sessions ?? []).filter(
      s => s.is_active && userBelongsToShard(s.user_id) && shouldRunGramjsForSession(s),
    )
    const activeSessions = new Set(activeOnShard.map(s => s.user_id))

    for (const [userId] of this.listeners) {
      if (!activeSessions.has(userId) || await this.hasActivePendingAuthInDb(userId)) {
        await this.stopListener(userId)
      }
    }

    const cooldownMs = Math.max(
      30_000,
      Math.min(3_600_000, Number(process.env.TELEGRAM_RETRY_COOLDOWN_MS ?? 300_000)),
    )
    const now = Date.now()

    for (const session of activeOnShard) {
      const userId = session.user_id
      if (this.listeners.has(userId)) continue
      if (await this.shouldSkipListenerStart(userId)) continue
      const failedAt = this.recentlyFailed.get(userId)
      if (failedAt && now - failedAt < cooldownMs) continue
      try {
        await withTimeout(
          this.startListener(userId, session.session_string),
          listenerStartTimeoutMs(),
          `syncSessions startListener ${userId}`,
        )
        this.recentlyFailed.delete(userId)
      } catch (err) {
        this.recentlyFailed.set(userId, Date.now())
        console.error(`[sessionManager] Failed to start listener for ${userId}:`, err)
      }
    }
  }

  hasListener(userId: string): boolean {
    return this.listeners.has(userId)
  }

  canExecuteTelegramCopierTrades(userId: string): boolean {
    if (workerConfig.runsListener) {
      const listener = this.listeners.get(userId)
      if (listener?.isTelegramConnected()) return true
    }
    return false
  }

  /** Async lease check for trade-only workers; canonical feed satisfies gate in primary mode. */
  async canExecuteTelegramCopierTradesAsync(
    userId: string,
    subscriptionChannelId?: string | null,
  ): Promise<boolean> {
    if (subscriptionChannelId && channelListenerPrimaryMode()) {
      const { data } = await this.supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('id', subscriptionChannelId)
        .maybeSingle()
      const signalChannelId = (data as { signal_channel_id?: string | null } | null)?.signal_channel_id
      if (signalChannelId) {
        const feedLive = await isChannelFeedLiveForSubscriber(this.supabase, userId, signalChannelId)
        if (feedLive) return true
      }
    }

    if (workerConfig.runsListener) {
      return this.canExecuteTelegramCopierTrades(userId)
    }
    const { isTelegramListenerLiveForUser } = await import('./sessionLease')
    return isTelegramListenerLiveForUser(this.supabase, userId)
  }

  getStatus(): ListenerStatus[] {
    const out: ListenerStatus[] = []
    for (const [, listener] of this.listeners) {
      out.push(listener.getStatus())
    }
    return out
  }

  async getHealthPayload(): Promise<{
    ok: boolean
    role: string
    shard: string
    instance: string
    listeners: number
    connected_listeners: number
    detail: ListenerStatus[]
    active_leases: number
    fresh_leases_for_connected: number
    lease_mismatch: boolean
    lease_gap: number
    lease_mismatch_user_ids?: string[]
    metrics: Record<string, number>
    checked_at: string
  }> {
    const status = this.getStatus()
    const now = Date.now()
    const staleMs = Math.max(
      60_000,
      Math.min(600_000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000)),
    )
    const connectedStatus = status.filter(s => s.connected)
    const listenerActivityOk = !workerConfig.runsListener
      || status.length === 0
      || status.every(s =>
        s.connected && (s.last_event_at === 0 || now - s.last_event_at < staleMs),
      )

    let freshLeasesForConnected = 0
    let leaseMismatchUserIds: string[] = []
    if (workerConfig.runsListener && connectedStatus.length > 0) {
      const leaseCheck = await countFreshListenerLeasesForUsers(
        this.supabase,
        connectedStatus.map(s => s.user_id),
      )
      freshLeasesForConnected = leaseCheck.fresh
      leaseMismatchUserIds = leaseCheck.missingUserIds
    }

    const leaseGap = Math.max(0, connectedStatus.length - freshLeasesForConnected)
    const leaseMismatch = workerConfig.runsListener && leaseGap > 0

    const leases = workerConfig.runsListener
      ? await listActiveLeases(this.supabase)
      : []

    if (leaseMismatch) {
      console.warn(
        `[sessionManager] lease mismatch connected=${connectedStatus.length}`
        + ` fresh_leases=${freshLeasesForConnected} gap=${leaseGap}`
        + ` users=${leaseMismatchUserIds.join(',')}`,
      )
    }

    return {
      ok: listenerActivityOk && !leaseMismatch,
      role: workerConfig.role,
      shard: `${workerConfig.shardId}/${workerConfig.shardCount}`,
      instance: workerConfig.instanceId,
      listeners: status.length,
      connected_listeners: connectedStatus.length,
      detail: status,
      active_leases: leases.length,
      fresh_leases_for_connected: freshLeasesForConnected,
      lease_mismatch: leaseMismatch,
      lease_gap: leaseGap,
      ...(leaseMismatchUserIds.length > 0
        ? { lease_mismatch_user_ids: leaseMismatchUserIds }
        : {}),
      metrics: getMetricsSnapshot(),
      checked_at: new Date(now).toISOString(),
    }
  }

  async adoptClient(userId: string, client: TelegramClient, sessionString: string) {
    if (this.shuttingDown) {
      throw new Error('Telegram worker is shutting down')
    }
    if (!workerConfig.runsListener) {
      throw new Error('Telegram listener not enabled on this worker (WORKER_ROLE)')
    }

    return this.withConnectionLock(userId, async () => {
      this.adoptingUsers.add(userId)
      try {
        await this.disconnectListener(userId)

        const lease = await acquireSessionLease(this.supabase, userId)
        if (!lease.ok) {
          throw new Error(`Cannot adopt Telegram client: ${lease.reason}`)
        }

        const listener = new UserListener(
          userId,
          sessionString,
          this.supabase,
          client,
          (id, reason) => this.onAuthKeyDuplicatedRecoveryExhausted(id, reason),
        )
        if (this.tradeExecutor) {
          listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor!, row))
        }
        try {
          await listener.start({ alreadyConnected: true })
        } catch (err) {
          await releaseSessionLease(this.supabase, userId)
          throw err
        }
        this.listeners.set(userId, listener)
        console.log(`[sessionManager] Adopted live client for user ${userId}`)
      } catch (err) {
        try { await client.disconnect() } catch { /* ignore */ }
        throw err
      } finally {
        this.adoptingUsers.delete(userId)
      }
    })
  }

  /** List channels on the listener adoptClient just registered — never opens a second MTProto socket. */
  async listChannelsForAdoptedUser(userId: string, opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    const listener = this.listeners.get(userId)
    if (!listener) throw new Error('No listener after Telegram auth')
    return listener.listChannels(opts)
  }

  /**
   * Telegram revoked the auth key (AUTH_KEY_UNREGISTERED). Drop the dead session
   * so we stop reconnect loops, but keep configured telegram_channels — the user
   * reconnects manually without re-adding channels.
   */
  async invalidateTelegramSession(userId: string): Promise<void> {
    await this.stopListener(userId)
    await releaseSessionLease(this.supabase, userId)
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
    const { error } = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId)
    if (error) {
      console.warn(`[sessionManager] invalidateTelegramSession session delete failed for ${userId}:`, error.message)
    }
    void persistCopierHealth(this.supabase, userId, {
      telegramAccountStatus: 'reconnect_required',
      listenerStatus: 'failed',
      copierEngineStatus: 'stopped',
      workerOwnershipStatus: 'unowned',
      mtprotoConnected: false,
      recoveryExhausted: true,
      healthReason: 'telegram_session_invalidated',
    }, { force: true, allowWithoutLease: true })
  }

  async listChannels(userId: string, opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    const local = this.listeners.get(userId)
    if (local) {
      if (!local.isTelegramConnected()) {
        await local.ensureTelegramConnected('list_channels')
      }
      return local.listChannels(opts)
    }
    const listener = await this.ensureListener(userId)
    return listener.listChannels(opts)
  }

  /**
   * User-initiated recovery: stop + restart the live listener with the saved session
   * (does not require phone/QR). Used by Copier Engine "Reconnect Telegram".
   * On persistent failure, invalidates the session so the UI opens a fresh link flow
   * (same outcome as Disconnect-then-reconnect).
   */
  async reconnectTelegramSession(userId: string): Promise<{ channels: ChannelInfo[] }> {
    if (this.shuttingDown) {
      throw new Error('Telegram worker is shutting down')
    }
    if (!workerConfig.runsListener) {
      throw new Error('Live Telegram listener not available on this worker')
    }

    // Stale ephemeral holds block startListener; clear them on explicit reconnect.
    await this.supabase
      .from('telegram_auth_pending')
      .delete()
      .eq('user_id', userId)
      .eq('auth_method', 'mtproto_hold')

    if (await this.hasActivePendingAuthInDb(userId)) {
      throw new Error('Telegram auth is in progress. Finish linking, then try again.')
    }

    const { data: sess, error } = await this.supabase
      .from('telegram_sessions')
      .select('session_string, is_active')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw new Error(`Failed to load session: ${error.message}`)
    if (!sess?.session_string) {
      throw new TelegramSessionInvalidError('No Telegram session for this user')
    }
    if (!sess.is_active) throw new Error('Telegram session is paused')

    const sessionString = sess.session_string
    const delays = authKeyDupReconnectDelaysMs(authKeyReleaseDelayMs(), authKeyDupReconnectDelayMs())
    let lastErr: unknown

    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt] ?? authKeyReleaseDelayMs()
      try {
        if (this.listeners.has(userId)) {
          console.log(
            `[sessionManager] user reconnect: stopping listener for ${userId}`
            + ` (attempt ${attempt + 1}/${delays.length})`,
          )
          await this.stopListener(userId)
        } else {
          await releaseSessionLease(this.supabase, userId)
        }

        await this.waitForListenerLeaseReleased(userId)
        if (delay > 0) await new Promise(r => setTimeout(r, delay))

        await this.startListener(userId, sessionString)
        const listener = this.listeners.get(userId)
        if (!listener) throw new Error('Failed to start listener for user')
        if (!listener.isTelegramConnected()) {
          await listener.ensureTelegramConnected('user_reconnect')
        }
        const channels = await listener.listChannels({ skipColdDelay: true })
        return { channels }
      } catch (err) {
        lastErr = err
        if (err instanceof TelegramSessionInvalidError) throw err
        console.warn(
          `[sessionManager] user reconnect attempt ${attempt + 1} failed for ${userId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    console.error(
      `[sessionManager] user reconnect exhausted for ${userId}`
      + ' — invalidating session so UI can re-link',
      lastErr instanceof Error ? lastErr.message : lastErr,
    )
    await this.invalidateTelegramSession(userId)
    throw new TelegramSessionInvalidError(
      'Could not reconnect Telegram. Please link your account again.',
    )
  }

  /**
   * User Disconnect: drop pending auth, stop listener immediately, delete session row.
   * Configured telegram_channels are kept. This is a local TScopier disconnect:
   * it does not call Telegram auth.LogOut, so Telegram may still list the old
   * authorization until the user revokes it in Telegram or a future hard-logout
   * flow is designed.
   */
  async disconnectTelegramSession(userId: string): Promise<{ ok: true }> {
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
    if (this.listeners.has(userId)) {
      await this.stopListener(userId)
    } else {
      await releaseSessionLease(this.supabase, userId)
    }
    const { error } = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId)
    if (error) {
      console.warn(`[sessionManager] disconnectTelegramSession delete failed for ${userId}:`, error.message)
    }
    void persistCopierHealth(this.supabase, userId, {
      telegramAccountStatus: 'not_linked',
      listenerStatus: 'disconnected',
      copierEngineStatus: 'stopped',
      workerOwnershipStatus: 'unowned',
      mtprotoConnected: false,
      healthReason: 'user_disconnected_telegram',
    }, { force: true, allowWithoutLease: true })
    return { ok: true }
  }

  private async ensureListener(userId: string): Promise<UserListener> {
    if (this.shuttingDown) {
      throw new Error('Telegram worker is shutting down')
    }
    const existing = this.listeners.get(userId)
    if (existing) {
      if (!existing.isTelegramConnected()) {
        await existing.ensureTelegramConnected('ensure_listener')
      }
      return existing
    }

    if (!workerConfig.runsListener) {
      throw new Error('Live Telegram listener not available on this worker')
    }

    if (await this.shouldSkipListenerStart(userId)) {
      const reason = await this.listenerStartBlockReason(userId)
      throw new Error(reason ?? 'Telegram listener is unavailable for this account.')
    }

    const { data: sess, error } = await this.supabase
      .from('telegram_sessions')
      .select('session_string, is_active')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw new Error(`Failed to load session: ${error.message}`)
    if (!sess?.session_string) throw new Error('No Telegram session for this user')
    if (!sess.is_active) throw new Error('Telegram session is paused')

    await this.startListener(userId, sess.session_string)
    const listener = this.listeners.get(userId)
    if (!listener) throw new Error('Failed to start listener for user')
    return listener
  }

  async backfillChannelHistory(
    userId: string,
    channelRowId: string,
    days: number,
    opts?: { forTraining?: boolean },
  ) {
    // Prefer the live listener (listener-only deploys). Avoids a second MTProto
    // connection that would trigger AUTH_KEY_DUPLICATED.
    if (workerConfig.runsListener) {
      let listener = this.listeners.get(userId)
      if (!listener?.isTelegramConnected()) {
        try {
          listener = await this.ensureListener(userId)
        } catch {
          listener = undefined
        }
      }
      if (listener?.isTelegramConnected()) {
        return listener.backfillChannelHistory(channelRowId, days, opts)
      }
    }

    if (!workerConfig.runsBacktestHttp) {
      throw new Error(
        'Telegram listener is not connected. Link Telegram on Copier Engine, wait a few seconds, then refresh.',
      )
    }
    return this.withEphemeralTelegram(userId, () =>
      runWithEphemeralListener(this.supabase, userId, listener =>
        listener.backfillChannelHistory(channelRowId, days, opts),
      ),
    )
  }

  async importBacktestChannelHistory(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
  ) {
    if (!workerConfig.runsBacktestHttp) {
      throw new Error('Backtest not enabled on this worker')
    }
    return this.withEphemeralTelegram(userId, () =>
      runWithEphemeralListener(this.supabase, userId, listener =>
        listener.importBacktestChannelHistory(channelRowId, fromIso, toIso),
      ),
    )
  }

  async syncBacktestSignals(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
    runId?: string,
  ) {
    if (!workerConfig.runsBacktestHttp) {
      throw new Error(
        'Backtest sync is not enabled on this worker. Use a WORKER_ROLE=backtest or all service.',
      )
    }

    if (workerConfig.role === 'listener') {
      throw new Error(
        'Backtest sync blocked on listener-only workers. Point BACKTEST_WORKER_URL to a backtest service.',
      )
    }

    return this.withEphemeralTelegram(userId, () =>
      runEphemeralBacktestSync(this.supabase, userId, channelRowId, fromIso, toIso, runId),
    )
  }

  /**
   * Runs fn while the live listener is stopped so ephemeral Telegram can use the sole
   * MTProto slot — including across dedicated backtest vs listener workers.
   */
  private async withEphemeralTelegram<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new Error('Telegram worker is shutting down')
    }
    const pauseLiveLocal = workerConfig.runsListener
      && (workerConfig.role === 'all' || process.env.BACKTEST_PAUSE_LIVE_LISTENER !== 'false')

    let sessionString: string | null = null
    let hadLiveListener = false
    let crossServiceHold = false

    if (pauseLiveLocal) {
      sessionString = (await this.supabase
        .from('telegram_sessions')
        .select('session_string')
        .eq('user_id', userId)
        .maybeSingle()).data?.session_string ?? null
      hadLiveListener = this.listeners.has(userId)
      if (hadLiveListener) {
        console.log(`[sessionManager] pausing live listener for ephemeral Telegram user=${userId}`)
        await this.stopListener(userId)
      }
      if (sessionString) {
        await new Promise(r => setTimeout(r, authKeyReleaseDelayMs()))
      }
    } else {
      // Dedicated backtest worker: pause remote listener via DB hold.
      crossServiceHold = await this.acquireMtprotoHold(userId)
      await this.waitForListenerLeaseReleased(userId)
      await new Promise(r => setTimeout(r, authKeyReleaseDelayMs()))
    }

    try {
      return await fn()
    } finally {
      if (pauseLiveLocal && sessionString && hadLiveListener) {
        await this.restartListenerAfterBacktest(userId, sessionString)
      }
      if (crossServiceHold) {
        await this.releaseMtprotoHold(userId)
      }
    }
  }

  /** Backtest pauses the copier listener; retry MTProto restart so Telegram does not stay offline. */
  private async restartListenerAfterBacktest(userId: string, sessionString: string): Promise<void> {
    const retryDelaysMs = [0, 3_000, 5_000, 10_000]
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      const delay = retryDelaysMs[attempt] ?? 0
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      if (this.listeners.has(userId)) {
        console.log(`[sessionManager] listener restored after backtest user=${userId}`)
        return
      }
      try {
        await this.startListener(userId, sessionString)
      } catch (err) {
        console.warn(
          `[sessionManager] restart listener after backtest attempt ${attempt + 1} for ${userId}:`,
          err instanceof Error ? err.message : err,
        )
      }
      if (this.listeners.has(userId)) return
    }
    console.error(
      `[sessionManager] failed to restart listener after backtest user=${userId}`
      + ' — open Copier Engine and use Reconnect Telegram',
    )
  }

  private async startListener(userId: string, sessionString: string): Promise<void> {
    if (this.shuttingDown) return
    if (this.listeners.has(userId)) return
    if (!userBelongsToShard(userId)) return
    if (await this.shouldSkipListenerStart(userId)) {
      console.log(`[sessionManager] skip listener for ${userId}: auth in progress`)
      return
    }

    await this.withConnectionLock(userId, async () => {
      if (this.shuttingDown) return
      if (this.listeners.has(userId)) return
      if (await this.shouldSkipListenerStart(userId)) return

      const lease = await acquireSessionLease(this.supabase, userId)
      if (!lease.ok) {
        console.warn(`[sessionManager] skip listener for ${userId}: ${lease.reason}`)
        return
      }

      const listener = new UserListener(
        userId,
        sessionString,
        this.supabase,
        undefined,
        (id, reason) => this.onAuthKeyDuplicatedRecoveryExhausted(id, reason),
      )
      if (this.tradeExecutor) {
        listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor!, row))
      }
      try {
        await withTimeout(
          listener.start(),
          listenerStartTimeoutMs(),
          `listener.start ${userId}`,
        )
      } catch (err) {
        try { await listener.stop() } catch { /* ignore */ }
        await releaseSessionLease(this.supabase, userId)
        void persistCopierHealth(this.supabase, userId, {
          telegramAccountStatus: err instanceof TelegramSessionInvalidError ? 'reconnect_required' : 'linked',
          listenerStatus: err instanceof TelegramSessionInvalidError ? 'failed' : 'disconnected',
          copierEngineStatus: err instanceof TelegramSessionInvalidError ? 'stopped' : 'offline',
          workerOwnershipStatus: 'unowned',
          mtprotoConnected: false,
          recoveryExhausted: err instanceof TelegramSessionInvalidError,
          healthReason: err instanceof TelegramSessionInvalidError ? 'telegram_session_invalid' : 'listener_start_failed',
        }, {
          force: true,
          ownershipEpoch: listener.getHealthOwnershipEpoch(),
          leaseAcquiredAt: listener.getHealthLeaseAcquiredAt(),
          allowWithoutLease: true,
        })
        if (!(err instanceof TelegramSessionInvalidError)) {
          maybeCaptureCopierOffline({
            userId,
            listenerStatus: 'failed',
            reasonCode: 'LISTENER_START_FAILED',
            reason: 'listener_start_failed',
            sinceMs: Date.now() - 2 * 60_000,
          })
        }
        if (err instanceof TelegramSessionInvalidError) {
          // Do not call invalidateTelegramSession here — it re-enters
          // withConnectionLock while we still hold it (deadlock).
          await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
          const { error } = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId)
          if (error) {
            console.warn(
              `[sessionManager] session delete after invalid start failed for ${userId}:`,
              error.message,
            )
          }
        }
        throw err
      }
      this.listeners.set(userId, listener)
      this.recentlyFailed.delete(userId)
      this.disconnectedRenewTicks.delete(userId)
      console.log(`[sessionManager] Started listener for user ${userId}`)
    })
  }

  private async disconnectListener(userId: string): Promise<void> {
    const listener = this.listeners.get(userId)
    if (!listener) return
    void persistCopierHealth(this.supabase, userId, {
      telegramAccountStatus: 'linked',
      listenerStatus: 'disconnected',
      copierEngineStatus: 'stopped',
      workerOwnershipStatus: 'owned',
      mtprotoConnected: false,
      shutdownInProgress: true,
      healthReason: 'listener_stop_requested',
    }, {
      force: true,
      ownershipEpoch: listener.getHealthOwnershipEpoch(),
      leaseAcquiredAt: listener.getHealthLeaseAcquiredAt(),
    })
    await listener.stop()
    this.listeners.delete(userId)
    this.disconnectedRenewTicks.delete(userId)
    await releaseSessionLease(this.supabase, userId)
    void persistCopierHealth(this.supabase, userId, {
      telegramAccountStatus: 'linked',
      listenerStatus: 'disconnected',
      copierEngineStatus: 'stopped',
      workerOwnershipStatus: 'unowned',
      mtprotoConnected: false,
      shutdownInProgress: false,
      healthReason: 'listener_stopped',
    }, {
      force: true,
      ownershipEpoch: listener.getHealthOwnershipEpoch(),
      leaseAcquiredAt: listener.getHealthLeaseAcquiredAt(),
      allowWithoutLease: true,
    })
    console.log(`[sessionManager] Stopped listener for user ${userId}`)
  }

  private async stopListener(userId: string) {
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
    })
  }

  async reconcileUserSignals(
    userId: string,
    opts?: { channelRowId?: string },
  ): Promise<{ ok: boolean; reason?: string; stats?: SignalReconcileStats }> {
    if (!userBelongsToShard(userId)) {
      return { ok: false, reason: 'wrong_shard' }
    }
    const listener = this.listeners.get(userId)
    if (!listener) {
      return { ok: false, reason: 'listener_not_running' }
    }
    let channelRow: { id: string; channel_id: string; channel_username: string } | undefined
    if (opts?.channelRowId) {
      const { data } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
        .eq('id', opts.channelRowId)
        .eq('user_id', userId)
        .maybeSingle()
      if (data) channelRow = data as typeof channelRow
    }
    const stats = await listener.runSignalTelegramReconcile('cron', channelRow as never)
    return { ok: true, stats }
  }

  async reconcileAllListenersOnShard(): Promise<{
    users: number
    stats: SignalReconcileStats
  }> {
    const totals: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    let users = 0
    for (const [, listener] of this.listeners) {
      users += 1
      const stats = await listener.runSignalTelegramReconcile('cron')
      totals.checked += stats.checked
      totals.mismatches += stats.mismatches
      totals.revised += stats.revised
      totals.errors += stats.errors
    }
    return { users, stats: totals }
  }

  async disconnectAll() {
    this.shuttingDown = true
    for (const timer of this.realtimeRetryTimers.values()) clearTimeout(timer)
    this.realtimeRetryTimers.clear()
    if (this.channelChannel) {
      try { await this.supabase.removeChannel(this.channelChannel) } catch { /* noop */ }
      this.channelChannel = null
    }
    if (this.authPendingChannel) {
      try { await this.supabase.removeChannel(this.authPendingChannel) } catch { /* noop */ }
      this.authPendingChannel = null
    }
    this.stopChannelListenerServices()

    const entries = Array.from(this.listeners.entries())
    const stopResults = await Promise.allSettled(
      entries.map(async ([userId, listener]) => {
        try {
          await listener.stop()
          console.log(`[sessionManager] Disconnected ${userId}`)
        } finally {
          try {
            await releaseSessionLease(this.supabase, userId)
          } catch (err) {
            console.error(
              `[sessionManager] lease release failed during shutdown user=${userId}:`,
              err instanceof Error ? err.message : err,
            )
            captureWorkerWarning(err instanceof Error ? err : new Error(String(err)), {
              subsystem: 'worker',
              operation: 'lease_release_failed',
              errorCode: 'LEASE_RELEASE_FAILED',
              fingerprint: ['worker', 'LEASE_RELEASE_FAILED', leaseRoleLabel()],
              context: {
                user_id: userId,
                stage: 'shutdown',
              },
            })
          }
        }
      }),
    )

    for (let i = 0; i < stopResults.length; i++) {
      const result = stopResults[i]
      if (result.status === 'rejected') {
        const userId = entries[i]?.[0] ?? 'unknown'
        console.error(
          `[sessionManager] listener disconnect failed during shutdown user=${userId}:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        )
        captureWorkerError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)), {
          subsystem: 'worker',
          operation: 'listener_disconnect_failed',
          errorCode: 'LISTENER_DISCONNECT_FAILED',
          fingerprint: ['worker', 'LISTENER_DISCONNECT_FAILED', leaseRoleLabel()],
          context: {
            user_id: userId,
            stage: 'shutdown',
          },
        })
      }
    }

    await releaseOwnedSessionLeases(this.supabase)
    this.listeners.clear()
    const unresolvedLeases = await listOwnedActiveLeases(this.supabase).catch(err => {
      console.error(
        '[sessionManager] failed to check unresolved leases after shutdown:',
        err instanceof Error ? err.message : err,
      )
      return []
    })
    if (unresolvedLeases.length > 0) {
      console.error(
        `[sessionManager] unresolved owned leases after shutdown count=${unresolvedLeases.length}`
        + ` users=${unresolvedLeases.map(l => l.user_id).join(',')}`,
      )
      captureWorkerError(new Error('Unresolved owned listener leases after shutdown'), {
        subsystem: 'worker',
        operation: 'unresolved_listener_leases',
        errorCode: 'UNRESOLVED_LISTENER_LEASES',
        fingerprint: ['worker', 'UNRESOLVED_LISTENER_LEASES', leaseRoleLabel()],
        context: {
          stage: 'shutdown',
          extra: {
            unresolved_count: unresolvedLeases.length,
          },
        },
      })
    }
  }

  private onAuthKeyDuplicatedRecoveryExhausted(userId: string, reason: string): void {
    console.error(
      `[sessionManager] AUTH_KEY_DUPLICATED recovery exhausted user=${userId}`
      + ` reason=${reason} — invalidating session so UI can re-link`,
    )
    captureBusinessIssue({
      category: 'telegram',
      event: 'telegram_recovery_exhausted',
      severity: 'error',
      reasonCode: 'AUTH_KEY_DUPLICATED',
      message: 'Telegram AUTH_KEY_DUPLICATED recovery exhausted and session was invalidated',
      userImpact: 'failed',
      fingerprint: ['telegram_recovery_exhausted', 'auth_key_duplicated', 'exhausted'],
      context: {
        user_id: userId,
        stage: 'auth_key_duplicated_recovery',
        operation: 'telegram_reconnect',
        extra: { reason },
      },
    })
    void this.invalidateTelegramSession(userId).catch(err =>
      console.error(
        `[sessionManager] AUTH_KEY_DUPLICATED invalidation failed user=${userId}:`,
        err instanceof Error ? err.message : err,
      ),
    )
  }
}
