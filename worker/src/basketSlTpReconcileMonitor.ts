import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFxsocketConfigured } from './fxsocketClient'
import { apiForFxsocketAccount, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import {
  loadOpenBasketLegs,
  markBasketReconcileDone,
  parsePerLegTargets,
  reconcileBackoffMs,
  runBasketLegModifies,
  type BasketReconcileJobRow,
  type BasketSymbolParams,
  basketLegModifyMergeFailed,
} from './basketSlTpReconcile'
import { resolveFreshTargetsForJob, basketLegsOutOfSyncOnBroker, sweepOpenBasketsForReconcileDrift } from './basketReconcileTargets'
import { fetchBrokerOrdersByTicket } from './channelStopApply'
import {
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { normalizeSymbolParams } from './fxsocketClient'
import { isUserCopierPausedCached } from './copierPause'
import { brokerSessionUuid } from './tradeExecutor/helpers'
import { isV2 } from './engine/executionMode'
import { isExplicitBasketSlSource } from './basketEffectiveStops'
import {
  detectManualBrokerStopOverridesDetailed,
  isDriftSweepReconcileJob,
  notifyManualBrokerOverrideReverted,
} from './manualBrokerOverrideNotification'

const ACTIVE_MS = monitorActiveIntervalMs('BASKET_RECONCILE_TICK_MS', 5_000)
const IDLE_MS = monitorIdleIntervalMs('BASKET_RECONCILE_IDLE_MS', 15_000)
const JOB_BATCH_LIMIT = Math.min(
  80,
  Math.max(5, Number(process.env.BASKET_RECONCILE_SWEEP_BATCH ?? 50)),
)
const HOST_ID = `worker-${process.pid}`

function reconcileTargetsHaveSl(
  targets: Array<{ stoploss?: number; takeprofit?: number }>,
): boolean {
  return targets.some(t => (t.stoploss ?? 0) > 0)
}
const SWEEP_INTERVAL_MS = Math.min(
  600_000,
  Math.max(30_000, Number(process.env.BASKET_RECONCILE_SWEEP_MS ?? 90_000)),
)
/**
 * A job stuck in `claimed` longer than this (worker crashed mid-process, or pod
 * killed during deploy) is reset to `pending` so it is reprocessed. processJob
 * makes a single runBasketLegModifies pass, so legitimate work finishes well
 * within this window.
 */
const STALE_CLAIM_MS = Math.min(
  600_000,
  Math.max(60_000, Number(process.env.BASKET_RECONCILE_STALE_CLAIM_MS ?? 120_000)),
)

export class BasketSlTpReconcileMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByFxsocketId = new Map()
  private lastSweepAt = 0

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    if (!hasFxsocketConfigured()) {
      console.warn('[basketSlTpReconcileMonitor] MT4API_BASIC_USER/PASSWORD missing — disabled')
      return
    }
    this.loop = startMonitorLoop({
      name: 'basketSlTpReconcileMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: async sb => {
        const now = Date.now()
        if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) return true
        const ts = new Date().toISOString()
        return hasWorkOnShard(sb, 'basket_reconcile_jobs', q =>
          q.eq('status', 'pending').lte('next_run_at', ts),
        )
      },
      tick: () => this.runTick(),
    })
    console.log(`[basketSlTpReconcileMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms sweep=${SWEEP_INTERVAL_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } finally {
      this.ticking = false
    }
  }

  /**
   * Reset jobs stranded in `claimed` (crashed worker / killed pod) back to
   * `pending` so they are reprocessed. Without this they were invisible to both
   * the pending job select and the drift sweep (which skips claimed rows).
   */
  private async reclaimStaleClaimedJobs(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
    const nowIso = new Date().toISOString()
    const { data, error } = await this.supabase
      .from('basket_reconcile_jobs')
      .update({
        status: 'pending',
        next_run_at: nowIso,
        locked_at: null,
        locked_by: null,
        last_error: 'reclaimed stale claim',
        updated_at: nowIso,
      })
      .eq('status', 'claimed')
      .lt('locked_at', cutoff)
      .select('id')
    if (error) {
      console.warn(`[basketSlTpReconcileMonitor] stale-claim reclaim failed: ${error.message}`)
    } else if ((data ?? []).length > 0) {
      console.warn(`[basketSlTpReconcileMonitor] reclaimed ${(data ?? []).length} stale claimed job(s)`)
    }
  }

  private async tick(): Promise<void> {
    await this.reclaimStaleClaimedJobs()
    const now = new Date().toISOString()
    const { data: jobs, error } = await this.supabase
      .from('basket_reconcile_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('next_run_at', now)
      .order('next_run_at', { ascending: true })
      .limit(JOB_BATCH_LIMIT)

    if (error) {
      console.warn(`[basketSlTpReconcileMonitor] select failed: ${error.message}`)
    } else {
      for (const raw of (jobs ?? []) as BasketReconcileJobRow[]) {
        if (raw.attempts >= raw.max_attempts) {
          await this.supabase
            .from('basket_reconcile_jobs')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', raw.id)
          continue
        }
        await this.processJob(raw)
      }
    }

    if (Date.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = Date.now()
      try {
        await sweepOpenBasketsForReconcileDrift(this.supabase)
      } catch (err) {
        console.warn(
          `[basketSlTpReconcileMonitor] drift sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  private async processJob(job: BasketReconcileJobRow): Promise<void> {
    const { data: claimed, error: claimErr } = await this.supabase
      .from('basket_reconcile_jobs')
      .update({
        status: 'claimed',
        locked_at: new Date().toISOString(),
        locked_by: HOST_ID,
        attempts: job.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (claimErr || !claimed) return

    const row = claimed as BasketReconcileJobRow
    const { data: broker } = await this.supabase
      .from('broker_accounts')
      .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform,default_lot_size,manual_settings,channel_trading_configs,copier_mode,ai_settings')
      .eq('id', row.broker_account_id)
      .maybeSingle()

    const uuid = broker ? brokerSessionUuid(broker as { fxsocket_account_id?: string; metaapi_account_id?: string }) : null
    if (!broker || !uuid) {
      await this.releaseJob(row.id, 'broker not found', row.attempts)
      return
    }

    // Management-first v2 cutover: the single V2ReconcileMonitor owns background
    // convergence for v2-flagged brokers. Retire this v1 job so the two loops never
    // both modify the same basket (the old multi-applier flip-flop).
    if (isV2({ brokerAccountId: row.broker_account_id, userId: String(broker.user_id ?? '') || null })) {
      await markBasketReconcileDone(this.supabase, row.id)
      return
    }

    if (isUserCopierPausedCached(String(broker.user_id ?? ''))) {
      await this.releaseJob(row.id, 'copier paused', row.attempts)
      return
    }

    this.platformByUuid = await loadPlatformByFxsocketId(this.supabase, [uuid])
    const api = apiForFxsocketAccount(this.platformByUuid, uuid)
    if (!api) {
      await this.releaseJob(row.id, 'MT API not configured', row.attempts)
      return
    }

    const familyTrades = await loadOpenBasketLegs(
      this.supabase,
      row.broker_account_id,
      row.anchor_signal_id,
      row.symbol,
    )

    if (!familyTrades.length) {
      await markBasketReconcileDone(this.supabase, row.id)
      return
    }

    const { data: anchorSig } = await this.supabase
      .from('signals')
      .select('parsed_data, channel_id')
      .eq('id', row.anchor_signal_id)
      .maybeSingle()
    const anchorParsed = (anchorSig as { parsed_data?: { tp?: number[] }; channel_id?: string | null } | null)?.parsed_data
    const anchorChannelId = (anchorSig as { channel_id?: string | null } | null)?.channel_id ?? row.channel_id

    const manual = normalizeManualSettingsForExecution(
      resolveChannelTradingConfig(
        broker as Parameters<typeof resolveChannelTradingConfig>[0],
        anchorChannelId,
      ).manual_settings,
    )

    const storedTargets = parsePerLegTargets(row.per_leg_targets)
    const {
      perLegTargets: freshTargets,
      signalTps: freshSignalTps,
      effectiveStoploss,
      effectiveSlSource,
      tpFrozen,
    } = await resolveFreshTargetsForJob(
      this.supabase,
      row,
      familyTrades,
      manual,
    )
    const effectiveTargets = freshTargets.length ? freshTargets : storedTargets
    if (!effectiveTargets.length) {
      await this.releaseJob(row.id, 'empty per_leg_targets', row.attempts)
      return
    }
    const effectiveSignalTps = freshSignalTps.length
      ? freshSignalTps
      : (Array.isArray(anchorParsed?.tp)
        ? anchorParsed.tp.filter(
            (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
          )
        : [])

    let params: BasketSymbolParams | null = null
    try {
      const sp = await api.symbolParams(uuid, row.symbol)
      const n = normalizeSymbolParams(sp)
      params = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        lotStep: n.lotStep ?? 0.01,
        contractSize: n.contractSize ?? null,
        stopsLevel: n.stopsLevel ?? 0,
        freezeLevel: n.freezeLevel ?? 0,
      }
    } catch { /* optional */ }

    const preModifyOrdersByTicket = await fetchBrokerOrdersByTicket(api, uuid)
    const openedTickets = new Set(preModifyOrdersByTicket.keys())
    const driftSweepJob = isDriftSweepReconcileJob(row)
    const manualBrokerOverrideDetection = driftSweepJob
      ? detectManualBrokerStopOverridesDetailed({
          familyTrades,
          perLegTargets: effectiveTargets,
          ordersByTicket: preModifyOrdersByTicket,
          nImmCwe: row.n_imm_cwe ?? 0,
          effectiveStoploss: effectiveStoploss > 0 ? effectiveStoploss : undefined,
          tpFrozen,
        })
      : null
    const manualBrokerOverrides = manualBrokerOverrideDetection?.overrides ?? []
    if (driftSweepJob) {
      if (manualBrokerOverrides.length > 0) {
        console.log(`[MANUAL_OVERRIDE_NOTIFY] candidate job=${row.id} signal=${row.anchor_signal_id} broker=${row.broker_account_id} symbol=${row.symbol} overrides=${manualBrokerOverrides.length}`)
      } else {
        const reasons = [...new Set((manualBrokerOverrideDetection?.rejectedReasons ?? []).map(r => r.reason))].join(',') || 'none'
        console.log(`[MANUAL_OVERRIDE_NOTIFY] skipped job=${row.id} signal=${row.anchor_signal_id} broker=${row.broker_account_id} symbol=${row.symbol} reason=${reasons}`)
      }
    } else {
      console.log(`[MANUAL_OVERRIDE_NOTIFY] skipped job=${row.id} signal=${row.anchor_signal_id} broker=${row.broker_account_id} symbol=${row.symbol} reason=not_passive_drift_sweep`)
    }
    const baseLot = Number(broker.default_lot_size ?? 0.01)
    // One shared quote for the whole basket instead of one per leg.
    let sharedQuote: { bid: number; ask: number } | null = null
    try {
      sharedQuote = await api.quote(uuid, row.symbol)
    } catch { /* per-leg fallback inside runBasketLegModifies */ }
    const { summary, legErrors, modifiedTradeIds } = await runBasketLegModifies({
      supabase: this.supabase,
      api,
      uuid,
      symbol: row.symbol,
      direction: row.direction,
      baseLot,
      params,
      signalId: row.source_signal_id,
      userId: row.user_id,
      brokerAccountId: row.broker_account_id,
      familyTrades,
      perLegTargets: effectiveTargets,
      signalTps: effectiveSignalTps,
      tpLots: manual.tp_lots,
      nImmCwe: row.n_imm_cwe ?? 0,
      overrideTp: row.override_tp,
      strictEntryPrefetch: sharedQuote,
      openedTickets,
      skipAlreadySynced: true,
      parallelLegs: true,
      internalRebalance: manual.range_trading === true,
      effectiveStoploss: effectiveStoploss > 0 ? effectiveStoploss : undefined,
      orderCommentsEnabled: manual.order_comments_enabled !== false,
      // Explicit latest instruction (Manage Signals, basket target, or channel
      // Adjust) must apply even if it loosens; also when this job was enqueued
      // from a mgmt signal (source != anchor).
      explicitChannelTargets:
        row.source_signal_id !== row.anchor_signal_id
        || isExplicitBasketSlSource(effectiveSlSource),
    })

    const mergeFailed = basketLegModifyMergeFailed(summary)
    let brokerStillDrift = false
    if (!mergeFailed && reconcileTargetsHaveSl(effectiveTargets)) {
      const ordersByTicket = await fetchBrokerOrdersByTicket(api, uuid)
      brokerStillDrift = basketLegsOutOfSyncOnBroker(
        familyTrades,
        effectiveTargets,
        ordersByTicket,
        row.n_imm_cwe ?? 0,
        { effectiveStoploss: effectiveStoploss > 0 ? effectiveStoploss : undefined },
      )
    }
    const partialMsg = mergeFailed || brokerStillDrift
      ? `Reconcile: ${summary.modified}/${summary.openLegs} legs`
        + (summary.failed > 0 ? `; ${summary.failed} broker errors` : '')
        + (summary.skippedUnfixable > 0 ? `; ${summary.skippedUnfixable} skipped (market moved)` : '')
        + (brokerStillDrift ? '; broker SL still drifted' : '')
      : null

    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: row.user_id,
        signal_id: row.source_signal_id,
        broker_account_id: row.broker_account_id,
        action: 'basket_reconcile_tick',
        status: mergeFailed || brokerStillDrift ? 'failed' : 'success',
        error_message: partialMsg,
        request_payload: {
          job_id: row.id,
          anchor_signal_id: row.anchor_signal_id,
          ...summary,
          leg_errors: legErrors.slice(0, 5),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    if (!mergeFailed && !brokerStillDrift) {
      try {
        await this.supabase.from('trade_execution_logs').insert({
          user_id: row.user_id,
          signal_id: row.source_signal_id,
          broker_account_id: row.broker_account_id,
          action: 'merge_modify_summary',
          status: 'success',
          error_message: partialMsg,
          request_payload: {
            parent_signal_id: row.anchor_signal_id,
            symbol: row.symbol,
            modify_only: true,
            reconcile_job_id: row.id,
            user_message: partialMsg,
            ...summary,
            leg_errors: legErrors.slice(0, 10),
          } as unknown as Record<string, unknown>,
        })
      } catch { /* best-effort */ }
      if (manualBrokerOverrides.length > 0 && summary.modified <= summary.benignModify) {
        console.log(`[MANUAL_OVERRIDE_NOTIFY] skipped job=${row.id} signal=${row.anchor_signal_id} broker=${row.broker_account_id} symbol=${row.symbol} reason=no_non_benign_restore modified=${summary.modified} benign=${summary.benignModify}`)
      }
      if (manualBrokerOverrides.length > 0 && summary.modified > summary.benignModify) {
        await notifyManualBrokerOverrideReverted({
          supabase: this.supabase,
          userId: row.user_id,
          brokerAccountId: row.broker_account_id,
          anchorSignalId: row.anchor_signal_id,
          sourceSignalId: row.source_signal_id,
          channelId: anchorChannelId,
          symbol: row.symbol,
          direction: row.direction,
          reconcileJobId: row.id,
          overrides: manualBrokerOverrides,
          restoredTradeIds: modifiedTradeIds,
        })
      }
      await markBasketReconcileDone(this.supabase, row.id)
      await this.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', row.source_signal_id)
        .eq('status', 'parsed')
      return
    }

    if (row.attempts >= row.max_attempts) {
      await this.supabase
        .from('basket_reconcile_jobs')
        .update({
          status: 'failed',
          last_error: partialMsg,
          locked_at: null,
          locked_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      return
    }

    const backoff = reconcileBackoffMs(row.attempts)
    await this.supabase
      .from('basket_reconcile_jobs')
      .update({
        status: 'pending',
        last_error: partialMsg,
        next_run_at: new Date(Date.now() + backoff).toISOString(),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
  }

  private async releaseJob(jobId: string, err: string, attempts: number): Promise<void> {
    const backoff = reconcileBackoffMs(attempts)
    await this.supabase
      .from('basket_reconcile_jobs')
      .update({
        status: 'pending',
        last_error: err,
        next_run_at: new Date(Date.now() + backoff).toISOString(),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
  }
}
