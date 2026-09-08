import { randomUUID } from 'node:crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import bigInt from 'big-integer'
import { TelegramClient } from 'telegram'
import { utils } from 'telegram'
import { NewMessage } from 'telegram/events'
import type { NewMessageEvent } from 'telegram/events/NewMessage'
import { EditedMessage } from 'telegram/events/EditedMessage'
import type { EditedMessageEvent } from 'telegram/events/EditedMessage'
import { Api } from 'telegram/tl'
import {
  buildClient,
  tgInvoke,
  isAuthKeyDuplicated,
  isAuthKeyUnregistered,
  isMalformedRpcResult,
  rethrowIfSessionInvalid,
  TelegramSessionInvalidError,
} from './telegramClient'
import {
  authKeyDupDeferredRetryMs,
  authKeyDupMaxRecoveryAttempts,
  authKeyDupReconnectDelayMs,
  authKeyDupReconnectDelaysMs,
  redactTelegramConnectionLog,
  shouldEmitAuthKeyDupEvent,
} from './authKeyDuplicatedRecovery'
import { tradeableFromParsed } from './backtestSignal'
import type { SignalRow } from './tradeExecutor'
import { enqueueParsedSignal } from './queue/signalQueuePublisher'
import { signalQueueConfig } from './queue/signalQueueConfig'
import {
  pushParsedSignalToTradeWorker,
  pushParsedSignalToTradeWorkerAccept,
} from './tradeSignalPush'
import { persistListenerEvent } from './listenerEvents'
import { getChannelParseContext, invalidateChannelParseCache } from './channelKeywordsCache'
import { parseChannelMessageSync, parseModificationDeterministic, parseRawChannelMessage } from './parseSignal'
import { looksLikeTradingSignal, looksLikeTrainingCandidate } from './signalTradingHeuristic'
import { looksLikeChannelManagementUpdate } from './signalManagementIntent'
import { normalizeSignalMessageForParse } from './normalizeTelegramMessageText'
import {
  buildPipelineCorrelation,
  emitPipelineEvent,
  setPipelineTimestamp,
  type PipelineTimestamps,
} from './pipelineTimestamps'
import { addWorkerBreadcrumb, captureWorkerError } from './observability/sentry'
import { captureBusinessIssue } from './observability/businessEvents'
import { incMetric } from './workerMetrics'
import { workerConfig } from './workerConfig'
import { isManagementAction, parsedAction } from './tradeSignalActions'
import { applyCopierPauseProfileUpdate, loadCachedUserCopierPaused } from './copierPause'
import {
  copierHealthFreshnessThresholdMs,
  maybeCaptureCopierOffline,
  persistCopierHealth,
  resolveCopierEngineState,
  type SignalListenerState,
} from './copierHealth'
import {
  MESSAGE_REVISION_DISPATCH_SOURCE,
  buildRevisionDispatchRow,
  entryDispatchLooksSettleable,
  isIncomingRevisionStale,
  isOpenAiRateLimitMessage,
  loadSignalByTelegramMessage,
  revisionHasDeterministicActionableParse,
  storedMessageDiffersFromTelegram,
  updateSignalAfterRevision,
} from './signalRevision'
import { aiParseModification, aiResultToParseResult } from './aiParseModification'
import { aiParseEntry, aiEntryResultToParseResult, isAiEntryParseEnabled } from './aiParseEntry'
import {
  RECONCILE_POLL_HOOK_MAX_SIGNALS,
  RECONCILE_POLL_HOOK_WINDOW_MS,
  RECONCILE_SWEEP_INTERVAL_MS,
  chunkTelegramMessageIds,
  findSignalsNeedingReconcile,
  groupSignalsByChannel,
  loadSignalsForReconcile,
  markSignalsReconciled,
  normalizedSlTpTargets,
  parsedTargetsDrift,
  snapshotsFromTelegramMessages,
  telegramEditDateSec,
  telegramMessageText,
} from './signalTelegramReconcile'
import { evaluateParsedSignalExecutionEligibility, deterministicEntryNeedsAiRepair } from './signalExecutionEligibility'
import { getUniversalParseMode } from './signalIntent/parseConfig'
import { routeSignalParse } from './signalIntent/parseRouting'
import { parseUniversalSignal } from './signalIntent/universalSignalParser'
import { withParseRetry } from './withParseRetry'
import { resolveEntrySignalIdByProviderNumber, findRecentEntrySignalByProviderNumber } from './managementScope'
import {
  handlePostParseChannelIngest,
  isChannelRowPassive,
  refreshPassiveSignalChannels,
  resolveSignalChannelIdForRow,
  shouldSkipPassiveChannelIngest,
  syncUserChannelReaderLeases,
} from './channelListenerIntegration'
import { channelListenerShadowMode } from './channelListenerConfig'
import { inheritChannelHistory } from './channelRegistry'
import { ensureSignalRow } from './ensureSignalRow'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PARSE_SIGNAL_URL = process.env.PARSE_SIGNAL_URL ?? (
  SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/parse-signal` : ''
)
const RAW_PARSE_SIGNAL_KEY = process.env.PARSE_SIGNAL_KEY ?? ''
const isJwt = (v: string) => v.split('.').length === 3
const PARSE_SIGNAL_AUTH_KEY = isJwt(RAW_PARSE_SIGNAL_KEY)
  ? RAW_PARSE_SIGNAL_KEY
  : SUPABASE_SERVICE_ROLE_KEY
const PARSE_SIGNAL_API_KEY = SUPABASE_SERVICE_ROLE_KEY

/** Fire-and-forget call to the signal-review-email edge function (best-effort). */
function notifyHumanReviewEmail(signalId: string): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/signal-review-email`
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ signal_id: signalId }),
  }).catch((err: unknown) => {
    console.warn(`[userListener] signal-review-email notification failed id=${signalId}: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function listenerInlineParseEnabled(): boolean {
  const v = String(process.env.LISTENER_INLINE_PARSE ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Min seconds between client.connect() and first getDialogs on a fresh session. */
const COLD_FANOUT_DELAY_MS = 8000
const DIALOG_CACHE_TTL_MS = 60_000
const DIALOG_MAX_SCAN = 500
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_FAILURE_THRESHOLD = 2
const SAFETY_POLL_INTERVAL_MS = Math.max(
  5_000,
  Math.min(60_000, Number(process.env.TELEGRAM_SAFETY_POLL_MS ?? 10_000)),
)
const CHANNEL_POLL_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.TELEGRAM_CHANNEL_POLL_CONCURRENCY ?? 4)),
)
const CHANNEL_INVALID_DISABLE_THRESHOLD = Math.max(
  1,
  Math.min(20, Number(process.env.TELEGRAM_CHANNEL_INVALID_DISABLE_THRESHOLD ?? 5)),
)
const CHANNEL_UNAVAILABLE_USER_MESSAGE =
  'Channel unavailable or access was removed. Reconnect or update the channel.'
/**
 * Fast poll for channels Telegram is NOT pushing live updates for (last_live_at
 * stale/null). Telegram silently stops pushing updates for broadcast channels it
 * considers inactive on a session; without this, those signals are only picked
 * up by the safety poll (avg ~5s extra latency at 10s safety interval).
 */
const FAST_POLL_INTERVAL_MS = Math.max(
  1_000, Math.min(15_000, Number(process.env.TELEGRAM_FAST_POLL_MS ?? 3_000)),
)
/** A channel counts as live-dead when no live push has been seen for this long. */
const FAST_POLL_LIVE_STALE_MS = Math.max(
  60_000, Number(process.env.TELEGRAM_FAST_POLL_LIVE_STALE_MS ?? 2 * 60_000),
)
/**
 * Max channels fetched per fast-poll tick. Bounds total read RPCs per account
 * regardless of channel count (incident 2026-08-24: one user with 22 live-dead
 * channels generated ~440 requests/min and constant Telegram flood waits).
 */
const FAST_POLL_BATCH = (() => {
  const n = Number(process.env.TELEGRAM_FAST_POLL_BATCH ?? 6)
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 6
})()
/**
 * Per-channel pacing inside the fast-poll set: a channel is re-fetched at
 * most once per this interval, which doubles for each consecutive quiet poll
 * (no new messages) up to the cap. A poll that finds messages resets the
 * channel to base cadence so active channels keep low pickup latency.
 */
const FAST_POLL_MAX_CHANNEL_INTERVAL_MS = (() => {
  const n = Number(process.env.TELEGRAM_FAST_POLL_MAX_CHANNEL_INTERVAL_MS ?? 30_000)
  const cap = Number.isFinite(n) ? Math.min(300_000, n) : 30_000
  return Math.max(FAST_POLL_INTERVAL_MS, cap)
})()

export type FastPollOutcome = 'messages' | 'empty' | 'failed' | 'skipped'

/** Interval until a channel's next fast poll, given its consecutive-quiet-poll streak. */
export function fastPollChannelIntervalMs(cleanStreak: number): number {
  const doubled = FAST_POLL_INTERVAL_MS * 2 ** Math.max(0, cleanStreak)
  return Math.min(doubled, FAST_POLL_MAX_CHANNEL_INTERVAL_MS)
}

/**
 * Next clean streak after a poll outcome. Quiet polls stretch the interval;
 * finding messages or an error resets to base; skipped polls leave it as-is.
 */
export function nextFastPollCleanStreak(cleanStreak: number, outcome: FastPollOutcome): number {
  if (outcome === 'empty') return cleanStreak + 1
  if (outcome === 'messages' || outcome === 'failed') return 0
  return cleanStreak
}
const SESSION_PERSIST_INTERVAL_MS = 30 * 60_000
const CATCHUP_BACKPRESSURE_MS = 250
const CATCHUP_PER_CHANNEL_CAP = 200
const BACKFILL_PER_CHANNEL_CAP = 1000
const REPLY_CHAIN_SWEEP_MS = 60_000
/** Re-fetch teaser entries (e.g. "Gold buy now") after channel adds SL/TP via edit. */
const ENTRY_MESSAGE_SETTLE_MS = Math.max(
  3_000,
  Math.min(30_000, Number(process.env.ENTRY_MESSAGE_SETTLE_MS ?? 10_000)),
)
const REVISION_AI_RETRY_COOLDOWN_MS = Math.max(
  30_000,
  Math.min(60 * 60_000, Number(process.env.REVISION_AI_RETRY_COOLDOWN_MS ?? 10 * 60_000)),
)

function entryMessageSettleDelaysMs(): number[] {
  const raw = String(process.env.ENTRY_MESSAGE_SETTLE_DELAYS_MS ?? '').trim()
  if (raw) {
    const parsed = raw
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n >= 3_000)
      .map(n => Math.min(30_000, Math.floor(n)))
    if (parsed.length) return [...new Set(parsed)]
  }
  const second = Math.min(30_000, ENTRY_MESSAGE_SETTLE_MS * 3)
  return second > ENTRY_MESSAGE_SETTLE_MS
    ? [ENTRY_MESSAGE_SETTLE_MS, second]
    : [ENTRY_MESSAGE_SETTLE_MS]
}
const ENTITY_WARMUP_INTERVAL_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.TELEGRAM_ENTITY_WARMUP_INTERVAL_MS ?? 10 * 60_000)),
)
/**
 * Cooldown between attempts to join/resolve a public channel that keeps
 * failing to resolve. Prevents an unresolvable channel (dead username,
 * renamed, private) from hammering contacts.ResolveUsername / GetDialogs
 * on every poll and warmup cycle, which sustains Telegram flood-waits.
 */
const CHANNEL_RESOLVE_COOLDOWN_MS = (() => {
  const raw = Number(process.env.TELEGRAM_CHANNEL_RESOLVE_COOLDOWN_MS ?? 10 * 60_000)
  return Number.isFinite(raw) ? Math.max(60_000, Math.min(30 * 60_000, raw)) : 10 * 60_000
})()

/**
 * Per-session backoff after a Telegram flood-wait / retry-exhaustion burst.
 * Without it, the fast poll (every 3s) keeps issuing getMessages into a
 * throttled session; each request sleeps inside GramJS (avg 28s) × 5 retries,
 * piling up hundreds of concurrent pending requests + timers (observed: 500-725
 * flood-waits/min sustained → OOM/silent kill of the listener on 2026-08-18).
 */
const POLL_FLOOD_BACKOFF_MS = (() => {
  const raw = Number(process.env.TELEGRAM_POLL_FLOOD_BACKOFF_MS ?? 2 * 60_000)
  return Number.isFinite(raw) ? Math.max(30_000, Math.min(10 * 60_000, raw)) : 2 * 60_000
})()

/**
 * Ceiling for the adaptive flood-wait backoff. The pause grows on repeated
 * flood bursts (start at POLL_FLOOD_BACKOFF_MS, double each time) up to this cap
 * so a heavily-throttled session backs off for longer instead of re-flooding.
 */
const MAX_POLL_FLOOD_BACKOFF_MS = 10 * 60_000

/**
 * Consecutive flood-free poll cycles required before a flood-wait backoff is
 * lifted and the adaptive window resets to base. Keeps the pause from being
 * cleared on a single quiet check, so a session only resumes after a sustained
 * calm stretch (does NOT affect normal polling, where no backoff is armed).
 */
const POLL_FLOOD_CLEAN_CYCLES = (() => {
  const raw = Number(process.env.TELEGRAM_POLL_FLOOD_CLEAN_CYCLES ?? 3)
  return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 3
})()

function catchUpOnStartEnabled(): boolean {
  const v = String(process.env.TELEGRAM_CATCHUP_ON_START ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Skip catch-up parse/trade for Telegram posts older than this (avoids stale fills after deploy). */
function catchUpMaxAgeMs(): number {
  const minutes = Math.max(1, Math.min(24 * 60, Number(process.env.TELEGRAM_CATCHUP_MAX_AGE_MINUTES ?? 20)))
  return minutes * 60_000
}

function catchUpParseConcurrency(): number {
  return Math.max(1, Math.min(4, Number(process.env.TELEGRAM_CATCHUP_PARSE_CONCURRENCY ?? 2)))
}

/** Parse retries on transient failure (AI timeout/429/transport). 1 = no retry. */
function listenerParseMaxAttempts(): number {
  return Math.max(1, Math.min(5, Number(process.env.LISTENER_PARSE_MAX_ATTEMPTS ?? 3)))
}

function livePriorityPauseMs(): number {
  return Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_LIVE_PRIORITY_PAUSE_MS ?? 3000)))
}

function reconnectCooldownMs(): number {
  return Math.max(500, Math.min(120_000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)))
}

/**
 * Hard cap on a single Telegram connect()/probe inside forceReconnect. A hung
 * socket must not wedge reconnectInFlight forever (incident 2026-09-07: a wedged
 * connect left requestReconnect returning the same stuck promise, so the listener
 * flapped "disconnected but renewing lease anyway" for hours and no hard-reset
 * could ever run). The underlying promise is NOT cancelled — the cycle just stops
 * waiting and treats the attempt as failed so retry/exhaust logic can proceed.
 */
function telegramConnectTimeoutMs(): number {
  return Math.max(5_000, Math.min(120_000, Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS ?? 45_000)))
}

export async function withTelegramTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function malformedRpcResultMaxRecoveries(): number {
  return Math.max(
    1,
    Math.min(100, Math.floor(Number(process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES ?? 10))),
  )
}

function malformedRpcResultRecoveryWindowMs(): number {
  return Math.max(
    60_000,
    Math.min(60 * 60_000, Number(process.env.TELEGRAM_MALFORMED_RPC_RECOVERY_WINDOW_MS ?? 10 * 60_000)),
  )
}

function startConnectJitterMaxMs(): number {
  return Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_START_JITTER_MAX_MS ?? 2000)))
}

const HEARTBEAT_INTERVAL_MS = Math.max(
  10_000,
  Math.min(300_000, Number(process.env.TELEGRAM_HEARTBEAT_INTERVAL_MS ?? 60_000)),
)

export interface ChannelInfo {
  id: string
  title: string
  username: string
  members_count: number
}

export interface ListenerStatus {
  user_id: string
  connected: boolean
  listener_status: SignalListenerState
  last_event_at: number
  last_successful_poll_at: number
  last_reconnect_at: number
  monitored_channels: number
  consecutive_probe_failures: number
}

export interface StartOptions {
  alreadyConnected?: boolean
}

export type AuthKeyDuplicatedExhaustedHandler = (userId: string, reason: string) => void

interface ChannelRow {
  id: string
  channel_id: string
  channel_username: string
  signal_channel_id?: string | null
  last_seen_message_id: number | string | null
  last_seen_at?: string | null
  last_live_at?: string | null
}

type Handler = (event: NewMessageEvent) => void
type EditHandler = (event: EditedMessageEvent) => void

export type SignalReconcileStats = {
  checked: number
  mismatches: number
  revised: number
  errors: number
}

interface MessageLike {
  id: number | bigint
  text?: string | null
  message?: string | null
  replyTo?: unknown
}

interface ChatIdentity {
  chatId: string
  chatIdVariants: string[]
  chatUsername: string
}

interface ChannelInvalidFailureState {
  consecutiveCount: number
  firstFailureAt: number
  lastFailureAt: number
  lastSuccessfulPollAt: number
  channelRowId: string
  channelId: string
  channelUsername: string
}

/** Telegram / gramjs: extract numeric reply target message id when present. */
function extractReplyToMsgId(replyTo: unknown): string | null {
  if (replyTo == null || typeof replyTo !== 'object') return null
  const r = replyTo as { replyToMsgId?: unknown; reply_to_msg_id?: unknown }
  const v = r.replyToMsgId ?? r.reply_to_msg_id
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function normalizeChannelUsername(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^@/, '').toLowerCase()
}

function isValidTelegramUsername(raw: string | null | undefined): boolean {
  const value = normalizeChannelUsername(raw)
  if (!value) return false
  return /^[a-z0-9_]{5,32}$/i.test(value)
}

function isNumericTelegramChatId(raw: string | null | undefined): boolean {
  return /^-?\d+$/.test(String(raw ?? '').trim())
}

function toChannelIdVariants(raw: string): string[] {
  const value = (raw ?? '').trim()
  if (!value) return []

  const out = new Set<string>([value])
  const n = Number(value)
  if (!Number.isFinite(n)) return [...out]

  const abs = String(Math.abs(Math.trunc(n)))
  out.add(abs)

  if (value.startsWith('-100')) {
    out.add(value.slice(4))
  } else if (!value.startsWith('-')) {
    // Telegram often represents channel peers as -100<id> in updates,
    // while dialogs/list results can expose plain positive ids.
    out.add(`-100${value}`)
  } else {
    out.add(`-100${abs}`)
  }

  return [...out]
}

function safeChannelIdentifier(row: ChannelRow): Record<string, string> {
  return {
    channel_row_id: row.id,
    channel_id: String(row.channel_id ?? '').trim(),
    channel_username: normalizeChannelUsername(row.channel_username),
  }
}

function safeTelegramErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? '')).slice(0, 300)
}

function normalizedTelegramErrorCode(err: unknown): string {
  const raw = safeTelegramErrorMessage(err).toUpperCase()
  // GramJS rewrites Telegram's USERNAME_NOT_OCCUPIED into a plain
  // Error('No user has "X" as username') (telegram/client/users.js).
  // Map it back so unresolvable public channels can be auto-disabled.
  if (/NO USER HAS .* AS USERNAME/.test(raw)) return 'USERNAME_NOT_OCCUPIED'
  const match = raw.match(/[A-Z][A-Z0-9_]{2,}/)
  return match?.[0] ?? raw
}

function isConfirmedChannelInvalidError(err: unknown): boolean {
  const code = normalizedTelegramErrorCode(err)
  return code.includes('CHANNEL_INVALID')
    || code.includes('USERNAME_INVALID')
    || code.includes('USERNAME_NOT_OCCUPIED')
    || code.includes('CHANNEL_PRIVATE')
}

/**
 * True when an MTProto request failed because Telegram is throttling the
 * session. GramJS retries internally (sleeping ~flood-wait seconds × 5) and
 * finally throws `Request was unsuccessful N time(s)`; a FloodWaitError above
 * floodSleepThreshold surfaces as `A wait of N seconds is required ...`.
 * Used to back off polling instead of hammering a rate-limited session (the
 * 2026-08-18 listener crash driver).
 */
function isFloodWaitOrRetryExhaustion(err: unknown): boolean {
  const m = safeTelegramErrorMessage(err)
  return m.includes('FLOOD_WAIT')
    || /Request was unsuccessful \d+ time\(s\)/.test(m)
    || /A wait of \d+ seconds is required/.test(m)
}

export class UserListener {
  private client: TelegramClient
  private userId: string
  private supabase: SupabaseClient
  private monitoredChannels = new Set<string>()
  private currentHandler: Handler | null = null
  private currentEventBuilder: NewMessage | null = null
  private currentEditHandler: EditHandler | null = null
  private currentEditEventBuilder: EditedMessage | null = null
  private startedAt = 0
  /** Set when start() reuses the auth-time client (no second connect). */
  private startedWithLiveClient = false
  private dialogsCache: ChannelInfo[] | null = null
  private dialogsCacheAt = 0
  private safetyPollTimer: NodeJS.Timeout | null = null
  private fastPollTimer: NodeJS.Timeout | null = null
  private fastPollRows: ChannelRow[] = []
  private fastPollRowsAt = 0
  private fastPollInFlight = false
  /** Per-channel fast-poll pacing: row id → last attempt started at. */
  private fastPollAttemptByRow = new Map<string, number>()
  /** Per-channel fast-poll pacing: row id → consecutive quiet (no new messages) polls. */
  private fastPollCleanStreakByRow = new Map<string, number>()
  /** In-memory live-push freshness per channel row (DB last_live_at can lag). */
  private lastLiveByRow = new Map<string, number>()
  private watchdogTimer: NodeJS.Timeout | null = null
  private sessionPersistTimer: NodeJS.Timeout | null = null
  private replyChainSweepTimer: NodeJS.Timeout | null = null
  private signalReconcileSweepTimer: NodeJS.Timeout | null = null
  private signalReconcileInFlight = false
  private entityWarmupTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private catchUpInFlight = false
  private catchUpParseActive = 0
  private lastLiveMessageAt = 0
  private isConnected = false
  private lastEventAt = 0
  private lastSuccessfulPollAt = 0
  private lastReconnectAt = 0
  private lastReconnectEndedAt = 0
  private deferredRetryTimer: NodeJS.Timeout | null = null
  private consecutiveProbeFailures = 0
  /** Serializes forceReconnect so poll/watchdog/warmup cannot stack competing connects. */
  private reconnectInFlight: Promise<void> | null = null
  /** Rate-limit AUTH_KEY_DUPLICATED poll_error rows (safety+fast poll can fire every few seconds). */
  private lastAuthKeyDupPollErrorAt = 0
  private lastAuthKeyDupLogAt = 0
  private lastSavedSession: string
  private readonly canRecreateClient: boolean
  private clientGeneration = 0
  private stopping = false
  private channelInvalidFailures = new Map<string, ChannelInvalidFailureState>()
  private autoDisabledChannelRows = new Set<string>()
  /** Cooldown (ms epoch) until the next resolve/join attempt per channel row. */
  private channelResolveCooldownUntil = new Map<string, { until: number; lastError?: Error }>()
  /** When the next fast/safety poll may run again after a flood-wait burst (0 = no backoff). */
  private pollBackoffUntil = 0
  /** Flood-wait errors observed during the current poll cycle (used to clear backoff at cycle level). */
  private floodErrorsThisCycle = 0
  /** Current adaptive flood-wait pause length; grows on repeated bursts, resets to base after sustained calm. */
  private floodBackoffMs = POLL_FLOOD_BACKOFF_MS
  /** Consecutive flood-free poll cycles — the backoff is cleared only after POLL_FLOOD_CLEAN_CYCLES of them. */
  private consecutiveCleanCycles = 0
  /** Last time a flood-wait backoff was logged — rate-limits the warning. */
  private lastPollBackoffLogAt = 0
  private malformedRpcRecoveryCount = 0
  private lastMalformedRpcRecoveryAt = 0
  private onSignalParsed: ((row: SignalRow) => boolean) | null = null
  /** Recent live message ids — avoids a Supabase round-trip on hot-path dedup. */
  private liveMessageDedup = new Map<string, number>()
  private userProfilesCopierPauseChannel: ReturnType<SupabaseClient['channel']> | null = null
  /** Serializes message revision apply per channel row + telegram message id. */
  private revisionChains = new Map<string, Promise<boolean>>()
  /** In-process dedupe for revision dispatches (edit handler vs settle poll vs HTTP push). */
  private revisionDispatchDedup = new Map<string, number>()
  /** Per-signal cooldown after OpenAI 429s so reconcile cannot hammer the API. */
  private revisionAiCooldowns = new Map<string, number>()
  /** signal_channel_ids where canonical feed is live — skip poll/reconcile in primary mode. */
  private passiveSignalChannelIds = new Set<string>()
  private readonly healthLeaseAcquiredAt = new Date().toISOString()
  private readonly healthOwnershipEpoch = this.healthLeaseAcquiredAt

  private persistHealth(patch: Parameters<typeof persistCopierHealth>[2], opts?: { force?: boolean }): void {
    void persistCopierHealth(this.supabase, this.userId, patch, {
      ...opts,
      ownershipEpoch: this.healthOwnershipEpoch,
      leaseAcquiredAt: this.healthLeaseAcquiredAt,
    })
  }

  /** Fire-and-forget: send a Telegram self-message (Saved Messages) for human review. */
  private notifyHumanReviewTelegram(
    signalId: string,
    rawMessage: string,
    parsed: Record<string, unknown>,
  ): void {
    const appUrl = process.env.APP_URL || 'https://app.tscopier.ai'
    const reviewUrl = `${appUrl}/account-trades?review=${signalId}`

    const symbol = String(parsed.symbol ?? '').trim()
    const action = String(parsed.action ?? '').trim()
    const entry = parsed.entry_price ?? parsed.entry_zone_low ?? ''
    const sl = parsed.sl != null ? String(parsed.sl) : ''
    const tp = Array.isArray(parsed.tp) && parsed.tp.length > 0 ? parsed.tp.join(', ') : ''

    const lines: string[] = ['Signal review required', '']
    if (symbol) lines.push(`Symbol: ${symbol}`)
    if (action) lines.push(`Action: ${action}`)
    if (entry) lines.push(`Entry: ${entry}`)
    if (sl) lines.push(`SL: ${sl}`)
    if (tp) lines.push(`TP: ${tp}`)
    if (rawMessage) { lines.push(''); lines.push(rawMessage) }
    lines.push('')
    lines.push(`Review: ${reviewUrl}`)
    lines.push('(Auto-expires in 2 minutes)')

    const message = lines.join('\n')

    tgInvoke(this.client, new Api.messages.SendMessage({
      peer: new Api.InputPeerSelf(),
      message,
      randomId: bigInt(Date.now()),
    })).catch((err: unknown) => {
      console.warn(`[userListener] Telegram review notification failed id=${signalId}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private currentListenerStatus(): SignalListenerState {
    if (this.isConnected) return 'connected'
    if (this.reconnectInFlight || this.deferredRetryTimer) return 'reconnecting'
    if (this.stopping) return 'disconnected'
    return 'unknown'
  }

  private updateHealth(reason: string, opts?: { force?: boolean; recoveryExhausted?: boolean }): void {
    const listenerStatus: SignalListenerState = opts?.recoveryExhausted
      ? 'failed'
      : reason === 'watchdog_probe_failed'
        ? 'reconnecting'
        : this.currentListenerStatus()
    const lastSuccessful = this.lastSuccessfulPollAt || null
    const combined = resolveCopierEngineState({
      linked: true,
      listenerStatus,
      owned: true,
      mtprotoConnected: this.isConnected,
      lastSuccessfulProbeAt: lastSuccessful,
      recoveryExhausted: opts?.recoveryExhausted,
      shutdownInProgress: this.stopping,
      freshnessThresholdMs: copierHealthFreshnessThresholdMs(),
    })
    const nowIso = new Date().toISOString()
    this.persistHealth({
      ...combined,
      listenerStatus,
      mtprotoConnected: this.isConnected,
      lastConnectedAt: this.isConnected ? nowIso : undefined,
      lastDisconnectedAt: !this.isConnected ? nowIso : undefined,
      lastProbeAt: nowIso,
      lastSuccessfulProbeAt: lastSuccessful ? new Date(lastSuccessful).toISOString() : null,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      reconnectStartedAt: this.reconnectInFlight ? nowIso : null,
      recoveryExhausted: opts?.recoveryExhausted === true,
      shutdownInProgress: this.stopping,
      healthReason: reason || combined.healthReason,
      ownershipEpoch: this.healthOwnershipEpoch,
      leaseAcquiredAt: this.healthLeaseAcquiredAt,
      freshnessThresholdMs: copierHealthFreshnessThresholdMs(),
    }, opts)
  }

  getHealthOwnershipEpoch(): string {
    return this.healthOwnershipEpoch
  }

  getHealthLeaseAcquiredAt(): string {
    return this.healthLeaseAcquiredAt
  }

  constructor(
    userId: string,
    sessionString: string,
    supabase: SupabaseClient,
    adoptedClient?: TelegramClient,
    private onAuthKeyDuplicatedRecoveryExhausted?: AuthKeyDuplicatedExhaustedHandler,
    private readonly clientFactory: (sessionString: string) => TelegramClient = buildClient,
  ) {
    this.userId = userId
    this.supabase = supabase
    this.canRecreateClient = !adoptedClient
    this.client = adoptedClient ?? this.clientFactory(sessionString)
    this.attachClientErrorHandler()
    this.lastSavedSession = sessionString
  }

  private attachClientErrorHandler(): void {
    this.client.onError = async (err: Error) => {
      if (isMalformedRpcResult(err)) {
        await this.noteMalformedRpcResult(err)
        return
      }
      const msg = err?.message ?? ''
      if (msg.includes('readUInt32LE') || msg.includes('Cannot read properties of undefined')) {
        console.warn(
          `[userListener] raw GramJS BinaryReader crash for ${this.userId}`
          + ` — treating as malformed RPC result`,
        )
        await this.noteMalformedRpcResult(err)
        return
      }
      if (msg.includes('TIMEOUT') && this.isConnected) {
        console.warn(`[userListener] _updateLoop TIMEOUT for ${this.userId} — requesting reconnect`)
        addWorkerBreadcrumb({
          category: 'telegram',
          message: 'update loop timeout; reconnect requested',
          level: 'warning',
          data: { reason: 'update_loop_timeout' },
        })
        this.requestReconnect('update_loop_timeout')
      }
    }
  }

  /** Immediate trade dispatch after parse (avoids waiting on Supabase Realtime). */
  setOnSignalParsed(handler: ((row: SignalRow) => boolean) | null): void {
    this.onSignalParsed = handler
  }

  private connectionTrace(event: string, detail?: Record<string, unknown>): void {
    const suffix = detail
      ? ` ${Object.entries(detail).map(([k, v]) => `${k}=${redactTelegramConnectionLog(v)}`).join(' ')}`
      : ''
    console.log(
      `[telegram-conn] event=${event} worker=${workerConfig.instanceId}`
      + ` user=${this.userId} generation=${this.clientGeneration}${suffix}`,
    )
  }

  private isChannelLocallyDisabled(row: ChannelRow): boolean {
    return this.autoDisabledChannelRows.has(row.id)
  }

  private removeChannelFromMonitoring(row: ChannelRow): void {
    this.autoDisabledChannelRows.add(row.id)
    this.fastPollRows = this.fastPollRows.filter(r => r.id !== row.id)
    this.channelResolveCooldownUntil.delete(row.id)
    this.fastPollAttemptByRow.delete(row.id)
    this.fastPollCleanStreakByRow.delete(row.id)
    if (row.channel_id && isNumericTelegramChatId(String(row.channel_id))) {
      for (const v of toChannelIdVariants(String(row.channel_id))) this.monitoredChannels.delete(v)
    }
    if (isValidTelegramUsername(row.channel_username)) {
      this.monitoredChannels.delete(normalizeChannelUsername(row.channel_username))
    }
  }

  private resetChannelInvalidFailure(row: ChannelRow, source: string): boolean {
    const previous = this.channelInvalidFailures.get(row.id)
    const wasLocallyDisabled = this.autoDisabledChannelRows.delete(row.id)
    if (!previous && !wasLocallyDisabled) return false

    this.channelInvalidFailures.delete(row.id)
    this.channelResolveCooldownUntil.delete(row.id)
    // Start a re-enabled channel back at base fast-poll cadence.
    this.fastPollCleanStreakByRow.delete(row.id)
    const detail = {
      source,
      ...safeChannelIdentifier(row),
      previous_count: previous?.consecutiveCount ?? 0,
      last_successful_poll_at: previous?.lastSuccessfulPollAt
        ? new Date(previous.lastSuccessfulPollAt).toISOString()
        : null,
    }
    console.log(
      `[userListener] channel_reactivated user=${this.userId}`
      + ` channel=${row.id} source=${source} previousCount=${detail.previous_count}`,
    )
    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'channel_reactivated',
      channelRowId: row.id,
      detail,
    })
    return true
  }

  private resetChannelInvalidFailuresForActiveRows(rows: ChannelRow[], source: string): boolean {
    let changed = false
    for (const row of rows) {
      if (this.channelInvalidFailures.has(row.id) || this.autoDisabledChannelRows.has(row.id)) {
        changed = this.resetChannelInvalidFailure(row, source) || changed
      }
    }
    return changed
  }

  private noteChannelPollSuccess(row: ChannelRow, source: string): void {
    const now = Date.now()
    const state = this.channelInvalidFailures.get(row.id)
    if (state) state.lastSuccessfulPollAt = now
    this.resetChannelInvalidFailure(row, source)
  }

  /** Arm a session-wide poll backoff after a flood-wait / retry-exhaustion burst. */
  private noteFloodWaitBackoff(reason: string): void {
    const now = Date.now()
    this.floodErrorsThisCycle += 1
    this.consecutiveCleanCycles = 0
    // A new flood arriving after a previous pause has already expired means the
    // throttling is recurring — escalate the next pause (start at base, double
    // up to the cap). `pollBackoffUntil === 0` means no pause was ever armed, so
    // the very first flood starts at base without escalating. A flood while
    // already paused does not re-arm or escalate.
    if (this.pollBackoffUntil > 0 && now >= this.pollBackoffUntil && this.floodBackoffMs < MAX_POLL_FLOOD_BACKOFF_MS) {
      this.floodBackoffMs = Math.min(this.floodBackoffMs * 2, MAX_POLL_FLOOD_BACKOFF_MS)
    }
    if (now < this.pollBackoffUntil) return
    this.pollBackoffUntil = now + this.floodBackoffMs
    if (now - this.lastPollBackoffLogAt >= this.floodBackoffMs) {
      this.lastPollBackoffLogAt = now
      console.warn(
        `[userListener] flood-wait backoff user=${this.userId}`
        + ` pausing polls for ${Math.round(this.floodBackoffMs / 1000)}s`
        + ` reason=${reason}`,
      )
    }
    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'poll_flood_backoff',
      detail: { reason: reason.slice(0, 200), backoff_ms: this.floodBackoffMs },
    })
  }

  private setChannelResolveCooldown(rowId: string, err?: unknown): void {
    this.channelResolveCooldownUntil.set(rowId, {
      until: Date.now() + CHANNEL_RESOLVE_COOLDOWN_MS,
      lastError: err instanceof Error ? err : undefined,
    })
  }

  /**
   * Throw the representative error captured when the resolve cooldown was armed
   * (falls back to a plain message). During cooldown the caller skips all
   * Telegram RPCs but still surfaces the original classification — so
   * confirmed-invalid channels keep progressing toward auto-disable without
   * hammering contacts.ResolveUsername / GetDialogs.
   */
  private throwChannelResolveCooldown(rowId: string): never {
    const entry = this.channelResolveCooldownUntil.get(rowId)
    const lastError = entry?.lastError
    if (lastError) throw lastError
    throw new Error(`channel resolve cooling down until ${entry?.until ?? 0}`)
  }

  /**
   * End of a poll cycle: clear the backoff only if no flood-wait error was
   * recorded anywhere since this cycle began (snapshot at cycle start). The
   * counter is deliberately NOT reset here — it is monotonic per session and
   * only zeroed on reconnect — so overlapping poll cycles (fast poll, safety
   * poll, initial poll) can't race each other into clearing a backoff that one
   * of them just armed. Each cycle compares against its own snapshot, so a
   * clean cycle still clears an expired backoff, while any flood during any
   * overlapping cycle keeps the backoff armed.
   */
  private endPollCycle(floodAtCycleStart: number): void {
    if (this.floodErrorsThisCycle === floodAtCycleStart) {
      // Clean cycle. Only lift the backoff (and reset the adaptive window to
      // base) after several consecutive flood-free cycles, so a session resumes
      // only after sustained calm. When no backoff is armed this is a no-op,
      // so normal polling is unaffected.
      if (this.pollBackoffUntil > 0) {
        this.consecutiveCleanCycles += 1
        if (this.consecutiveCleanCycles >= POLL_FLOOD_CLEAN_CYCLES) {
          this.pollBackoffUntil = 0
          this.floodBackoffMs = POLL_FLOOD_BACKOFF_MS
          this.consecutiveCleanCycles = 0
        }
      }
    } else {
      this.consecutiveCleanCycles = 0
    }
  }

  private async noteChannelInvalid(
    row: ChannelRow,
    source: string,
    err: unknown,
  ): Promise<void> {
    const now = Date.now()
    const previous = this.channelInvalidFailures.get(row.id)
    const state: ChannelInvalidFailureState = {
      consecutiveCount: (previous?.consecutiveCount ?? 0) + 1,
      firstFailureAt: previous?.firstFailureAt ?? now,
      lastFailureAt: now,
      lastSuccessfulPollAt: previous?.lastSuccessfulPollAt ?? 0,
      channelRowId: row.id,
      channelId: String(row.channel_id ?? '').trim(),
      channelUsername: normalizeChannelUsername(row.channel_username),
    }
    this.channelInvalidFailures.set(row.id, state)
    const errorCode = normalizedTelegramErrorCode(err)
    const detail = {
      source,
      error_code: errorCode,
      consecutive_count: state.consecutiveCount,
      threshold: CHANNEL_INVALID_DISABLE_THRESHOLD,
      first_failure_at: new Date(state.firstFailureAt).toISOString(),
      last_failure_at: new Date(state.lastFailureAt).toISOString(),
      last_successful_poll_at: state.lastSuccessfulPollAt
        ? new Date(state.lastSuccessfulPollAt).toISOString()
        : null,
      ...safeChannelIdentifier(row),
    }

    console.warn(
      `[userListener] channel_invalid_detected user=${this.userId}`
      + ` channel=${row.id} count=${state.consecutiveCount}/${CHANNEL_INVALID_DISABLE_THRESHOLD}`
      + ` source=${source} code=${errorCode}`,
    )
    incMetric('channel_invalid_detected')
    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'channel_invalid_detected',
      channelRowId: row.id,
      detail,
    })

    if (state.consecutiveCount >= CHANNEL_INVALID_DISABLE_THRESHOLD) {
      await this.disableInvalidChannel(row, state, source, errorCode)
    }
  }

  private async disableInvalidChannel(
    row: ChannelRow,
    state: ChannelInvalidFailureState,
    source: string,
    errorCode: string,
  ): Promise<void> {
    this.removeChannelFromMonitoring(row)
    const detail = {
      source,
      error_code: errorCode,
      consecutive_count: state.consecutiveCount,
      threshold: CHANNEL_INVALID_DISABLE_THRESHOLD,
      first_failure_at: new Date(state.firstFailureAt).toISOString(),
      last_failure_at: new Date(state.lastFailureAt).toISOString(),
      last_successful_poll_at: state.lastSuccessfulPollAt
        ? new Date(state.lastSuccessfulPollAt).toISOString()
        : null,
      message: CHANNEL_UNAVAILABLE_USER_MESSAGE,
      ...safeChannelIdentifier(row),
    }

    const { error } = await this.supabase
      .from('telegram_channels')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('user_id', this.userId)

    if (error) {
      console.error(
        `[userListener] channel_auto_disabled db_update_failed user=${this.userId}`
        + ` channel=${row.id} count=${state.consecutiveCount}:`,
        error.message,
      )
      captureWorkerError(error, {
        subsystem: 'telegram',
        operation: 'channel_auto_disable_persist_failed',
        errorCode: 'CHANNEL_AUTO_DISABLE_PERSIST_FAILED',
        fingerprint: ['telegram', 'CHANNEL_AUTO_DISABLE_PERSIST_FAILED', errorCode],
        context: {
          user_id: this.userId,
          channel_id: row.id,
          stage: 'channel_auto_disable',
          retry_attempt: state.consecutiveCount,
          extra: { source, error_code: errorCode },
        },
      })
      incMetric('channel_auto_disable_update_failed')
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'channel_auto_disabled',
        channelRowId: row.id,
        detail: { ...detail, persisted: false, db_error: error.message.slice(0, 300) },
      })
      return
    }

    console.warn(
      `[userListener] channel_auto_disabled user=${this.userId}`
      + ` channel=${row.id} count=${state.consecutiveCount} code=${errorCode}`,
    )
    captureBusinessIssue({
      category: 'telegram',
      event: 'telegram_channel_auto_disabled',
      severity: 'warning',
      reasonCode: errorCode || 'CHANNEL_INVALID',
      message: 'Telegram channel auto-disabled after repeated invalid-channel failures',
      userImpact: 'failed',
      fingerprint: ['telegram_channel_auto_disabled', errorCode || 'CHANNEL_INVALID', 'channel_auto_disabled'],
      context: {
        user_id: this.userId,
        channel_id: row.id,
        stage: 'channel_auto_disabled',
        operation: 'channel_monitoring',
        retry_attempt: state.consecutiveCount,
        extra: { source, threshold: CHANNEL_INVALID_DISABLE_THRESHOLD },
      },
    })
    incMetric('channel_auto_disabled')
    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'channel_auto_disabled',
      channelRowId: row.id,
      detail: { ...detail, persisted: true },
    })
    await this.refreshChannelSubscription().catch(err =>
      console.warn(`[userListener] refresh after channel auto-disable failed channel=${row.id}:`, err),
    )
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async start(opts: StartOptions = {}) {
    if (!opts.alreadyConnected) {
      const jm = startConnectJitterMaxMs()
      if (jm > 0) {
        const jitter = Math.floor(Math.random() * (jm + 1))
        if (jitter > 0) await new Promise(r => setTimeout(r, jitter))
      }
      try {
        this.clientGeneration += 1
        this.connectionTrace('connect_start', { source: 'initial' })
        await this.client.connect()
      } catch (err) {
        if (isAuthKeyUnregistered(err)) throw new TelegramSessionInvalidError()
        if (isAuthKeyDuplicated(err)) {
          this.connectionTrace('auth_key_duplicated_detected', { source: 'initial' })
          const authDupDelayMs = authKeyDupReconnectDelayMs()
          console.warn(
            `[userListener] AUTH_KEY_DUPLICATED on initial connect for ${this.userId}`
            + ` — old session still releasing; waiting ${authDupDelayMs}ms then retrying`,
          )
          incMetric('auth_key_duplicated')
          this.connectionTrace('disconnect_start', { source: 'initial_auth_dup' })
          try { await this.client.disconnect() } catch { /* ignore */ }
          this.connectionTrace('disconnect_complete', { source: 'initial_auth_dup' })
          await new Promise(r => setTimeout(r, authDupDelayMs))
          this.clientGeneration += 1
          this.connectionTrace('connect_start', { source: 'initial_auth_dup_retry', attempt: 2 })
          await this.client.connect()
        } else {
          throw err
        }
      }
    }
    this.isConnected = true
    this.startedAt = Date.now()
    this.lastEventAt = Date.now()
    this.lastSuccessfulPollAt = Date.now()
    this.updateHealth('listener_started', { force: true })

    // Do not await getDialogs warmup here — flood-wait / hung dialogs blocked
    // startListener, held the connection lock, and left users with No lease.
    // Periodic startEntityWarmup + initial fire-and-forget cover the same work.
    void this.warmEntityCache().catch(err =>
      console.warn(`[userListener] initial entity warmup failed for ${this.userId}:`, err),
    )
    await this.refreshChannelSubscription()
    await this.refreshChannelListenerState()
    this.scheduleCatchUpOnStart()

    this.startWatchdog()
    this.startSafetyPoll()
    this.startFastPoll()
    void this.pollMonitoredChannelsForMessages().catch(err =>
      console.warn(`[userListener] initial channel poll failed for ${this.userId}:`, err),
    )
    this.startSessionPersist()
    this.startReplyChainSweep()
    this.startSignalReconcileSweep()
    this.startEntityWarmup()
    this.startHeartbeat()
    this.subscribeCopierPauseState()
  }

  async stop() {
    this.stopping = true
    try {
      if (this.userProfilesCopierPauseChannel) {
        await this.supabase.removeChannel(this.userProfilesCopierPauseChannel)
        this.userProfilesCopierPauseChannel = null
      }
      this.stopTimer('watchdogTimer')
      this.stopTimer('safetyPollTimer')
      this.stopTimer('fastPollTimer')
      this.stopTimer('sessionPersistTimer')
      this.stopTimer('replyChainSweepTimer')
      this.stopTimer('signalReconcileSweepTimer')
      this.stopTimer('entityWarmupTimer')
      this.stopTimer('heartbeatTimer')
      this.removeCurrentHandler()
      if (this.deferredRetryTimer) {
        clearTimeout(this.deferredRetryTimer)
        this.deferredRetryTimer = null
      }
      if (this.reconnectInFlight) {
        // A wedged connect can leave reconnectInFlight pending forever; never
        // let stop() hang on it (incident 2026-09-07 — a stuck reconnect blocked
        // disconnectTelegramSession and the lease-renew hard-reset path).
        await withTelegramTimeout(
          this.reconnectInFlight.catch(() => {}),
          telegramConnectTimeoutMs(),
          `listener stop await reconnect ${this.userId}`,
        ).catch(() => {})
      }
      await this.persistSessionIfChanged()
      this.connectionTrace('disconnect_start', { source: 'stop' })
      await this.client.disconnect()
      this.connectionTrace('disconnect_complete', { source: 'stop' })
    } catch (err) {
      this.connectionTrace('disconnect_failed', { source: 'stop', error: err })
      throw err
    } finally {
      this.isConnected = false
      this.clearDialogsCache()
      this.updateHealth('listener_stopped', { force: true })
    }
  }

  private clearDialogsCache() {
    this.dialogsCache = null
    this.dialogsCacheAt = 0
  }

  /**
   * Clear per-channel resolve cooldowns + session poll backoff after a fresh
   * connect/reconnect. The session and entity cache are reset, so a channel
   * that was cooling down (possibly from a transient failure) must be allowed
   * to attempt resolution again; a genuinely dead channel re-fails and re-arms
   * the cooldown immediately.
   */
  private resetTelegramBackoffState() {
    this.channelResolveCooldownUntil.clear()
    this.pollBackoffUntil = 0
    this.floodErrorsThisCycle = 0
    this.floodBackoffMs = POLL_FLOOD_BACKOFF_MS
    this.consecutiveCleanCycles = 0
  }

  private stopTimer(field: 'watchdogTimer' | 'safetyPollTimer' | 'fastPollTimer' | 'sessionPersistTimer' | 'replyChainSweepTimer' | 'signalReconcileSweepTimer' | 'entityWarmupTimer' | 'heartbeatTimer') {
    const t = this[field]
    if (t) {
      clearInterval(t)
      this[field] = null
    }
  }

  /** True while MTProto is up after connect/reconnect (false during disconnect/reconnect). */
  isTelegramConnected(): boolean {
    return this.isConnected
  }

  /**
   * Kick recovery when the listener is in the Map but MTProto is down (lease renew
   * skips disconnected users — without this they stay offline until process restart).
   */
  requestReconnectIfDisconnected(reason = 'disconnected_recovery'): void {
    if (this.stopping) return
    if (this.isConnected) return
    void this.requestReconnect(reason)
  }

  /** Await recovery until MTProto is up, or throw a client-safe busy error. */
  async ensureTelegramConnected(reason = 'ensure'): Promise<void> {
    if (this.isConnected) return
    await this.requestReconnect(reason)
    if (!this.isConnected) {
      throw new Error(
        'Telegram connection is temporarily busy (another copy is still closing). Wait 30 seconds, press Refresh, or use Reconnect Telegram if it persists.',
      )
    }
  }

  getStatus(): ListenerStatus {
    return {
      user_id: this.userId,
      connected: this.isConnected,
      listener_status: this.currentListenerStatus(),
      last_event_at: this.lastEventAt,
      last_successful_poll_at: this.lastSuccessfulPollAt,
      last_reconnect_at: this.lastReconnectAt,
      monitored_channels: this.monitoredChannels.size,
      consecutive_probe_failures: this.consecutiveProbeFailures,
    }
  }

  getClient(): TelegramClient {
    return this.client
  }

  /** Public wrapper for channel reconcile monitor peer resolution. */
  async resolveChannelPeerForReconcile(row: ChannelRow): Promise<unknown> {
    return this.resolveChannelPeer(row)
  }

  /** Used by session manager to skip lease renew when listener is stale. */
  isListenerHealthy(staleMs: number): boolean {
    const now = Date.now()
    const lastActivity = Math.max(this.lastEventAt, this.lastSuccessfulPollAt)
    return this.isConnected && (lastActivity === 0 || now - lastActivity < staleMs)
  }

  private async refreshChannelListenerState(): Promise<void> {
    this.passiveSignalChannelIds = await refreshPassiveSignalChannels(this.supabase, this.userId)
    const acquired = await syncUserChannelReaderLeases(this.supabase, this.userId)
    if (acquired > 0) {
      console.log(`[userListener] acquired ${acquired} channel reader lease(s) user=${this.userId}`)
    }
  }

  // ── channel subscription ──────────────────────────────────────────────

  /**
   * Public hook for the session manager's Realtime subscription. Called
   * whenever telegram_channels changes for this user. Refreshes the
   * NewMessage filter and runs catch-up for any newly added channels.
   */
  async onChannelsChanged() {
    const { data: activeChannelRows } = await this.supabase
      .from('telegram_channels')
      .select('id')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    for (const row of activeChannelRows ?? []) {
      const id = (row as { id?: string }).id
      if (id) invalidateChannelParseCache(id)
    }
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, signal_channel_id, last_seen_message_id, last_seen_at, last_live_at')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    const changed = this.resetChannelInvalidFailuresForActiveRows((rows ?? []) as ChannelRow[], 'channel_config_changed')
    const activeRows = ((rows ?? []) as ChannelRow[]).filter(row => !this.isChannelLocallyDisabled(row))

    const previous = new Set(this.monitoredChannels)
    await this.refreshChannelSubscription()

    if (changed) await this.refreshChannelSubscription()

    await this.refreshChannelListenerState()

    const added = [...this.monitoredChannels].filter(c => !previous.has(c))

    const lookup = new Map<string, ChannelRow>()
    for (const row of activeRows) {
      if (row.channel_id && isNumericTelegramChatId(String(row.channel_id))) {
        for (const v of toChannelIdVariants(String(row.channel_id))) {
          lookup.set(v, row)
        }
      }
      if (isValidTelegramUsername(row.channel_username)) {
        lookup.set(normalizeChannelUsername(row.channel_username), row)
      }
    }
    for (const key of added) {
      const row = lookup.get(key)
      if (row) {
        if (row.signal_channel_id) {
          void inheritChannelHistory(this.supabase, this.userId, row.signal_channel_id).catch(err =>
            console.warn(`[userListener] inheritChannelHistory failed channel=${row.id}:`, err),
          )
        }
        await this.warmChannelEntity(row).catch(err =>
          console.warn(`[userListener] entity warmup failed channel=${row.id}:`, err),
        )
        await this.catchUpChannel(row).catch(err =>
          console.error(`[userListener] catchUp (added) failed for ${row.id}:`, err),
        )
      }
    }

    // Keep entity cache hot for every active channel (not only newly added keys).
    for (const row of activeRows) {
      await this.warmChannelEntity(row).catch(() => { /* logged inside */ })
      await this.ensureJoinedPublicChannel(row).catch(err =>
        console.warn(`[userListener] join channel failed ${row.id}:`, err),
      )
    }

    // Poll channels with no recent activity (missed live events or stale entity).
    const pollStaleMs = 5 * 60_000
    const now = Date.now()
    const staleRows = activeRows.filter(row => {
      const lastLive = row.last_live_at ? new Date(row.last_live_at).getTime() : 0
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0
      const lastActivity = Math.max(lastLive, lastSeen)
      return lastActivity <= 0 || now - lastActivity >= pollStaleMs
    })
    await this.mapWithConcurrency(staleRows, CHANNEL_POLL_CONCURRENCY, async row => {
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll (stale) failed for ${row.id}:`, err),
      )
    })

    // Never heard from Telegram at all.
    const neverHeardRows = activeRows.filter(row => !row.last_seen_at)
    await this.mapWithConcurrency(neverHeardRows, CHANNEL_POLL_CONCURRENCY, async row => {
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll (never-heard) failed for ${row.id}:`, err),
      )
    })
  }

  /**
   * Read the active channel set for this user and (re)subscribe the
   * NewMessage handler scoped to those chats only. Listening globally
   * (NewMessage({})) and filtering in JS is one of the userbot
   * fingerprints Telegram flags on cold accounts.
   */
  private async refreshChannelSubscription() {
    const next = await this.loadChannels()

    if (this.currentHandler && this.setsEqual(next, this.monitoredChannels)) {
      return
    }

    this.removeCurrentHandler()
    this.monitoredChannels = next

    if (next.size === 0) return

    const handler: Handler = (event: NewMessageEvent) => {
      this.handleMessage(event).catch(err => {
        console.error(`[userListener] handleMessage error for ${this.userId}:`, err)
      })
    }
    // NOTE:
    // Passing `chats:` here depends on Telegram/gramjs resolving each chat
    // identifier exactly as expected. In practice, channel ids can vary in
    // representation (e.g. -100 prefix / raw ids), and a mismatch can result
    // in silently missing all updates. We subscribe to all incoming messages
    // and apply strict user/channel filtering in handleMessage() instead.
    // Important: do not use `incoming: true` here — channel posts are not
    // always classified as "incoming", which can cause silent drops.
    const editHandler: EditHandler = (event: EditedMessageEvent) => {
      this.handleEditedMessage(event).catch(err => {
        console.error(`[userListener] handleEditedMessage error for ${this.userId}:`, err)
      })
    }
    const builder = new NewMessage({})
    const editBuilder = new EditedMessage({})
    this.client.addEventHandler(handler, builder)
    this.client.addEventHandler(editHandler, editBuilder)
    this.currentHandler = handler
    this.currentEventBuilder = builder
    this.currentEditHandler = editHandler
    this.currentEditEventBuilder = editBuilder
  }

  private removeCurrentHandler(client: TelegramClient = this.client) {
    if (this.currentHandler && this.currentEventBuilder) {
      try {
        client.removeEventHandler(this.currentHandler, this.currentEventBuilder)
      } catch {
        // ignore
      }
    }
    if (this.currentEditHandler && this.currentEditEventBuilder) {
      try {
        client.removeEventHandler(this.currentEditHandler, this.currentEditEventBuilder)
      } catch {
        // ignore
      }
    }
    this.currentHandler = null
    this.currentEventBuilder = null
    this.currentEditHandler = null
    this.currentEditEventBuilder = null
  }

  private setsEqual(a: Set<string>, b: Set<string>) {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }

  private async loadChannels(): Promise<Set<string>> {
    const { data } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    const next = new Set<string>()
    for (const ch of data ?? []) {
      const rowId = (ch as { id?: string }).id
      if (rowId && this.autoDisabledChannelRows.has(rowId)) continue
      if (ch.channel_id && isNumericTelegramChatId(String(ch.channel_id))) {
        for (const v of toChannelIdVariants(String(ch.channel_id))) next.add(v)
      }
      if (isValidTelegramUsername(ch.channel_username)) {
        next.add(normalizeChannelUsername(ch.channel_username))
      }
    }
    return next
  }

  private async resolveChannelRowForChat(
    chatIdVariants: string[],
    chatUsername: string,
  ): Promise<ChannelRow | null> {
    const { data: rows, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    if (error || !rows?.length) return null

    const variantSet = new Set(chatIdVariants)
    for (const row of rows as ChannelRow[]) {
      const storedId = String(row.channel_id ?? '').trim()
      if (storedId && isNumericTelegramChatId(storedId)) {
        if (toChannelIdVariants(storedId).some(v => variantSet.has(v))) {
          return row
        }
      }
    }

    if (chatUsername) {
      const wanted = normalizeChannelUsername(chatUsername)
      for (const row of rows as ChannelRow[]) {
        const stored = normalizeChannelUsername(row.channel_username)
        if (stored && stored === wanted) return row
      }
    }

    return null
  }

  /**
   * Return user's channels/groups. Delays the first call after start to
   * avoid cold-session fan-out, pages with a small limit, and caches the
   * result briefly so onboarding UI re-renders don't re-hit Telegram.
   */
  async listChannels(opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    if (!this.isConnected) {
      await this.ensureTelegramConnected('list_channels')
    }

    if (!opts?.skipColdDelay && !this.startedWithLiveClient) {
      const elapsed = Date.now() - this.startedAt
      if (elapsed >= 0 && elapsed < COLD_FANOUT_DELAY_MS) {
        await new Promise(r => setTimeout(r, COLD_FANOUT_DELAY_MS - elapsed))
      }
    }

    if (this.dialogsCache && (Date.now() - this.dialogsCacheAt) < DIALOG_CACHE_TTL_MS) {
      return this.dialogsCache
    }

    let dialogs: Awaited<ReturnType<TelegramClient['getDialogs']>>
    try {
      dialogs = await this.fetchAllDialogs()
    } catch (err) {
      if (isAuthKeyDuplicated(err)) {
        dialogs = await this.reconnectAndRetryDialogs()
      } else {
        rethrowIfSessionInvalid(err)
      }
    }

    const byId = new Map<string, ChannelInfo>()
    for (const d of dialogs) {
      if (!d.isChannel && !d.isGroup) continue
      const entity = (d.entity ?? {}) as { username?: string; participantsCount?: number }
      const id = String(d.id ?? '')
      if (!id) continue
      byId.set(id, {
        id,
        title: d.title ?? 'Unknown',
        username: entity.username ?? '',
        members_count: entity.participantsCount ?? 0,
      })
    }
    const channels = [...byId.values()]

    this.dialogsCache = channels
    this.dialogsCacheAt = Date.now()
    return channels
  }

  private async reconnectAndRetryDialogs(): Promise<Awaited<ReturnType<TelegramClient['getDialogs']>>> {
    const cycleId = crypto.randomUUID().slice(0, 8)
    console.warn(
      `[userListener] AUTH_KEY_DUPLICATED on getDialogs for ${this.userId}`
      + ' — disconnecting, waiting for old session to release, then reconnecting',
    )
    incMetric('auth_key_duplicated')
    this.connectionTrace('auth_key_duplicated_detected', { source: 'getDialogs', cycleId })
    const delays = authKeyDupReconnectDelaysMs(
      reconnectCooldownMs(),
      authKeyDupReconnectDelayMs(),
      authKeyDupMaxRecoveryAttempts(),
    )
    let lastErr: unknown
    for (let attempt = 0; attempt < delays.length; attempt++) {
      this.isConnected = false
      this.connectionTrace('disconnect_start', { source: `getDialogs:retry_${attempt + 1}`, cycleId })
      try { await this.client.disconnect() } catch { /* ignore */ }
      this.connectionTrace('disconnect_complete', { source: `getDialogs:retry_${attempt + 1}`, cycleId })
      await new Promise(r => setTimeout(r, delays[attempt]))
      if (this.stopping) break
      try {
        this.clientGeneration += 1
        this.connectionTrace('connect_start', { source: 'getDialogs', cycleId, attempt: attempt + 1 })
        await withTelegramTimeout(
          this.client.connect(),
          telegramConnectTimeoutMs(),
          `telegram connect getDialogs ${this.userId}`,
        )
        if (this.stopping) { try { await this.client.disconnect() } catch { /* ignore */ } break }
        this.isConnected = true
        const dialogs = await this.fetchAllDialogs()
        this.connectionTrace('recovery_complete', { source: 'getDialogs', cycleId, attempt: attempt + 1 })
        return dialogs
      } catch (err) {
        lastErr = err
        if (!isAuthKeyDuplicated(err)) rethrowIfSessionInvalid(err)
        this.connectionTrace('auth_key_duplicated_retry', { source: 'getDialogs', cycleId, attempt: attempt + 1 })
        console.warn(
          `[userListener] AUTH_KEY_DUPLICATED reconnect attempt ${attempt + 1}/${delays.length}`
          + ` for ${this.userId} cycle=${cycleId}`,
        )
      }
    }
    this.connectionTrace('recovery_invalidated', { source: 'getDialogs', cycleId, attempts: delays.length })
    setImmediate(() => this.onAuthKeyDuplicatedRecoveryExhausted?.(this.userId, 'getDialogs'))
    throw lastErr
  }

  /**
   * Load channel/group dialogs (capped). Uses gramjs built-in pagination, which
   * offsets by top *message* id — not dialog/peer id (large channel ids overflow int32).
   */
  private async fetchAllDialogs(): Promise<Awaited<ReturnType<TelegramClient['getDialogs']>>> {
    return this.client.getDialogs({ limit: DIALOG_MAX_SCAN })
  }

  /**
   * Explicit historical import used by channel insights profiling.
   * Fetches and stores matching messages for the last N days even when
   * last_seen_message_id is still empty (seed-only mode).
   */
  async backfillChannelHistory(
    channelRowId: string,
    days: number,
    opts?: { forTraining?: boolean },
  ): Promise<{ imported: number; messages: string[] }> {
    const lookbackDays = Math.max(1, Math.min(90, Number(days || 30)))
    const { data: row, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('id', channelRowId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Channel not found')

    const messages = await this.backfillChannelFromDate(row as ChannelRow, lookbackDays, opts)
    return { imported: messages.length, messages }
  }

  /**
   * Fetch Telegram messages in [fromIso, toIso] for backtest only.
   * Does not write to `signals` or trigger copier parse/trade execution.
   */
  async importBacktestChannelHistory(
    channelRowId: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ messages: Array<{ telegram_message_id: string; raw_message: string; signal_at: string }>; messages_scanned: number }> {
    const fromMs = new Date(fromIso).getTime()
    const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new Error('Invalid backtest date range')
    }

    const { data: row, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('id', channelRowId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Channel not found')

    const collected = await this.fetchMessagesBetweenForBacktest(row as ChannelRow, fromMs, toMs)
    const messages: Array<{ telegram_message_id: string; raw_message: string; signal_at: string }> = []

    for (const m of collected) {
      const raw = telegramMessageText(m)
      if (!raw) continue
      const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
      const signalAt = epoch > 0
        ? new Date(epoch * 1000).toISOString()
        : new Date().toISOString()
      messages.push({
        telegram_message_id: String(m.id),
        raw_message: raw,
        signal_at: signalAt,
      })
    }

    return { messages, messages_scanned: collected.length }
  }

  /**
   * Sync Telegram history into backtest_channel_signals (parse + upsert on worker).
   */
  async syncBacktestSignals(
    channelRowId: string,
    fromIso: string,
    toIso: string,
    opts?: { runId?: string },
  ): Promise<{
    messages_scanned: number
    candidates: number
    imported: number
    errors: string[]
  }> {
    const fromMs = new Date(fromIso).getTime()
    const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new Error('Invalid backtest date range')
    }

    if (!PARSE_SIGNAL_URL || !PARSE_SIGNAL_AUTH_KEY) {
      throw new Error('PARSE_SIGNAL_URL / service role key not configured on worker')
    }

    const { data: row, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('id', channelRowId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Channel not found')

    const runId = opts?.runId
    if (runId) {
      await this.supabase.from('backtest_runs').update({
        progress_pct: 1,
        progress_message: 'Fetching messages from Telegram…',
        updated_at: new Date().toISOString(),
      }).eq('id', runId).eq('user_id', this.userId)
    }

    const collected = await this.fetchMessagesBetweenForBacktest(row as ChannelRow, fromMs, toMs)
    const errors: string[] = []
    const heuristicCtx = await getChannelParseContext(this.supabase, channelRowId)
    const rangeFromIso = new Date(fromMs).toISOString()
    const rangeToIso = new Date(toMs).toISOString()

    const { error: delErr } = await this.supabase
      .from('backtest_channel_signals')
      .delete()
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('source', 'telegram_import')
      .gte('signal_at', rangeFromIso)
      .lte('signal_at', rangeToIso)
    if (delErr) errors.push(`clear prior import: ${delErr.message}`)

    type Candidate = {
      raw: string
      signalAt: string
      telegramMessageId: string
    }
    const candidates: Candidate[] = []
    for (const m of collected) {
      const raw = telegramMessageText(m)
      if (!raw) continue
      const isReply = !!(m as MessageLike & { replyTo?: unknown }).replyTo
      if (!looksLikeTradingSignal(raw, isReply, heuristicCtx)) continue
      const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
      candidates.push({
        raw,
        signalAt: epoch > 0 ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
        telegramMessageId: String(m.id),
      })
    }

    let imported = 0
    const parseConcurrency = Math.max(1, Math.min(8, Number(process.env.BACKTEST_PARSE_CONCURRENCY ?? 4)))
    const parseDelayMs = Math.max(0, Number(process.env.BACKTEST_PARSE_DELAY_MS ?? 0))

    const reportSyncProgress = async (parsed: number, total: number) => {
      if (!runId) return
      const pct = total > 0 ? 5 + Math.floor((parsed / total) * 90) : 5
      await this.supabase.from('backtest_runs').update({
        progress_pct: pct,
        progress_message: `Parsing signals ${parsed}/${total}…`,
        updated_at: new Date().toISOString(),
      }).eq('id', runId).eq('user_id', this.userId)
    }

    if (runId) {
      await this.supabase.from('backtest_runs').update({
        progress_pct: 5,
        progress_message: candidates.length > 0
          ? `Found ${candidates.length} candidate message(s) — parsing…`
          : 'No trade-like messages in range',
        updated_at: new Date().toISOString(),
      }).eq('id', runId).eq('user_id', this.userId)
    }

    await reportSyncProgress(0, candidates.length)

    let parsedCount = 0
    await this.mapWithConcurrency(candidates, parseConcurrency, async (c) => {
      try {
        const parsed = await this.parseSignalForBacktest(channelRowId, c.raw)
        if (!parsed) return
        const tradeable = tradeableFromParsed(parsed)
        if (!tradeable) return

        const { error: upsertErr } = await this.supabase.rpc('upsert_backtest_channel_signal', {
          p_user_id: this.userId,
          p_channel_id: channelRowId,
          p_signal_id: null,
          p_telegram_message_id: c.telegramMessageId,
          p_source: 'telegram_import',
          p_direction: tradeable.direction,
          p_symbol: tradeable.symbol,
          p_entry_price: tradeable.entry_price,
          p_sl: tradeable.sl,
          p_tp_levels: tradeable.tp_levels,
          p_lot_size: tradeable.lot_size,
          p_raw_message: c.raw,
          p_parsed_data: parsed,
          p_signal_at: c.signalAt,
        })
        if (upsertErr) {
          errors.push(upsertErr.message)
          return
        }
        imported++
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      } finally {
        parsedCount++
        if (parsedCount % 3 === 0 || parsedCount === candidates.length) {
          await reportSyncProgress(parsedCount, candidates.length)
        }
        if (parseDelayMs > 0) {
          await new Promise(r => setTimeout(r, parseDelayMs))
        }
      }
    })

    if (collected.length === 0) {
      errors.push('0 messages from Telegram — check session and channel access')
    } else if (candidates.length === 0) {
      errors.push('No messages looked like trade signals in this range')
    } else if (imported === 0 && errors.length === 0) {
      errors.push('No tradeable signals — messages need buy/sell, valid symbol, and SL or TP')
    }

    return {
      messages_scanned: collected.length,
      candidates: candidates.length,
      imported,
      errors,
    }
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) break
        await fn(items[i])
      }
    })
    await Promise.all(workers)
  }

  private async parseSignalForBacktest(
    channelRowId: string,
    rawMessage: string,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('parse-timeout'), 15_000)
    try {
      const res = await fetch(PARSE_SIGNAL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
          apikey: PARSE_SIGNAL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parse_only: true,
          channel_id: channelRowId,
          raw_message: rawMessage,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({})) as {
        parsed?: Record<string, unknown>
        error?: string
      }
      if (!res.ok) {
        throw new Error(data.error ?? `parse-signal ${res.status}`)
      }
      if (data.error) throw new Error(data.error)
      return data.parsed ?? null
    } finally {
      clearTimeout(timeout)
    }
  }

  // ── live message handling ─────────────────────────────────────────────

  private async handleMessage(event: NewMessageEvent) {
    this.lastEventAt = Date.now()
    this.lastLiveMessageAt = Date.now()
    incMetric('telegram_live_events')

    const message = event.message
    if (!message) return

    const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event)
    if (!chatId && !chatUsername) return

    // We subscribe broadly and filter by our own monitored set.
    const isMonitored =
      chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
      (!!chatUsername && this.monitoredChannels.has(chatUsername))
    if (!isMonitored) return

    console.log(
      `[userListener] message candidate user=${this.userId} chatId=${chatId} variants=${chatIdVariants.join(',')} username=${chatUsername || '-'} msgId=${String(message.id)}`,
    )

    // Prefer channel_id matching across normalized variants, fallback to username.
    const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername)

    if (!channelRow) {
      const { data: configured } = await this.supabase
        .from('telegram_channels')
        .select('display_name, channel_id, channel_username')
        .eq('user_id', this.userId)
        .eq('is_active', true)
      const configuredSummary = (configured ?? [])
        .map(c => `${c.display_name ?? '?'} id=${c.channel_id ?? '-'} @${c.channel_username ?? '-'}`)
        .join('; ')
      console.warn(
        `[userListener] monitored message could not map to telegram_channels row user=${this.userId}`
        + ` chatId=${chatId} username=${chatUsername || '-'} variants=${chatIdVariants.join(',')}`
        + ` configured=[${configuredSummary}]`,
      )
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'unmapped_channel',
        telegramMessageId: String(message.id),
        detail: {
          chat_id: chatId,
          chat_username: chatUsername || null,
          variants: chatIdVariants,
          configured: configuredSummary,
        },
      })
      return
    }

    await this.logSignal(
      channelRow,
      {
        id: message.id,
        text: message.text ?? message.message,
        replyTo: message.replyTo,
        date: (message as MessageLike & { date?: number | Date | string }).date,
      },
      { source: 'live' },
    )
    void this.bumpLastLive(channelRow.id)
  }

  private async handleEditedMessage(event: EditedMessageEvent) {
    this.lastEventAt = Date.now()
    incMetric('telegram_edit_events')

    const message = event.message
    if (!message) return

    const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event)
    if (!chatId && !chatUsername) return

    const isMonitored =
      chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
      (!!chatUsername && this.monitoredChannels.has(chatUsername))
    if (!isMonitored) return

    const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername)
    if (!channelRow) return

    const rawMessage = telegramMessageText(message)
    if (!rawMessage.trim()) return

    await this.tryApplyMessageRevision({
      channelRow,
      messageId: String(message.id),
      rawMessage,
      source: 'live_edit',
      telegramEditDateSeen: telegramEditDateSec(message),
    })
    void this.bumpLastLive(channelRow.id)
  }

  private revisionLockKey(channelRowId: string, messageId: string): string {
    return `${channelRowId}:${messageId}`
  }

  private runRevisionExclusive(
    key: string,
    fn: () => Promise<boolean>,
  ): Promise<boolean> {
    const prev = this.revisionChains.get(key) ?? Promise.resolve(false)
    const next = prev.catch(() => false).then(fn)
    this.revisionChains.set(key, next.catch(() => false))
    void next.finally(() => {
      if (this.revisionChains.get(key) === next) {
        this.revisionChains.delete(key)
      }
    })
    return next
  }

  private async tryApplyMessageRevision(args: {
    channelRow: ChannelRow
    messageId: string
    rawMessage: string
    source: string
    telegramEditDateSeen?: number | null
  }): Promise<boolean> {
    const key = this.revisionLockKey(args.channelRow.id, args.messageId)
    return this.runRevisionExclusive(key, () => this.tryApplyMessageRevisionInner(args))
  }

  private async tryApplyMessageRevisionInner(args: {
    channelRow: ChannelRow
    messageId: string
    rawMessage: string
    source: string
    telegramEditDateSeen?: number | null
  }  ): Promise<boolean> {
    const { channelRow, messageId, rawMessage, source } = args
    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) return false

    const existing = await loadSignalByTelegramMessage(this.supabase, {
      userId: this.userId,
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
    })
    if (!existing) return false
    if (isIncomingRevisionStale(existing.telegram_edit_date_seen, args.telegramEditDateSeen)) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'message_revision_stale_skipped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: existing.id,
          source,
          stored_edit_date: existing.telegram_edit_date_seen,
          incoming_edit_date: args.telegramEditDateSeen ?? null,
        },
      })
      return false
    }
    if (!storedMessageDiffersFromTelegram(existing.raw_message, rawMessage)) return false

    const deterministicRevision = await this.tryDeterministicRevisionCompletion({
      channelRowId: channelRow.id,
      rawMessage,
      existingParsed: (existing.parsed_data ?? null) as Record<string, unknown> | null,
    })

    let aiResult: Awaited<ReturnType<typeof aiParseModification>>
    let parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    if (deterministicRevision) {
      parseResult = deterministicRevision
      aiResult = {
        parsed: deterministicRevision.parsed as Awaited<ReturnType<typeof aiParseModification>>['parsed'],
        status: 'parsed',
        skip_reason: null,
        intent: 'parameter_refresh',
        typo_corrected: false,
        confidence: typeof deterministicRevision.parsed.confidence === 'number'
          ? deterministicRevision.parsed.confidence
          : 1,
        source: 'deterministic',
      }
    } else {
      const cooldownRemainingMs = this.getRevisionAiCooldownRemainingMs(existing.id)
      if (cooldownRemainingMs > 0) {
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'ai_modification_skipped',
          channelRowId: channelRow.id,
          telegramMessageId: messageId,
          detail: {
            signal_id: existing.id,
            source,
            revision: true,
            skip_reason: `OpenAI revision parse cooling down after rate limit (${cooldownRemainingMs}ms remaining)`,
            intent: 'ignore',
          },
        })
        return false
      }
      try {
        if (getUniversalParseMode() !== 'off') {
          const universal = await parseUniversalSignal(this.supabase, {
            userId: this.userId,
            channelRowId: channelRow.id,
            rawMessage,
            revision: {
              prior_raw_message: existing.raw_message,
              prior_parsed_data: (existing.parsed_data ?? null) as Record<string, unknown> | null,
            },
          })
          if (universal.parseResult.status === 'parsed' && universal.parseResult.parsed.action !== 'ignore') {
            parseResult = universal.parseResult
            aiResult = {
              parsed: universal.parseResult.parsed as Awaited<ReturnType<typeof aiParseModification>>['parsed'],
              status: 'parsed',
              skip_reason: null,
              intent: universal.intent.kind === 'commentary' ? 'commentary' : universal.intent.kind === 'ignore' ? 'ignore' : 'modify',
              typo_corrected: false,
              confidence: universal.intent.confidence,
              source: universal.source === 'openai' ? 'openai' : 'deterministic',
            }
          } else {
            // Universal/OpenAI unavailable or non-actionable — fall back to full
            // deterministic entry/mgmt parse so SL/TP ladder edits still apply.
            const detFallback = await this.tryDeterministicRevisionCompletion({
              channelRowId: channelRow.id,
              rawMessage,
              existingParsed: (existing.parsed_data ?? null) as Record<string, unknown> | null,
            })
            if (detFallback) {
              parseResult = detFallback
              aiResult = {
                parsed: detFallback.parsed as Awaited<ReturnType<typeof aiParseModification>>['parsed'],
                status: 'parsed',
                skip_reason: null,
                intent: 'parameter_refresh',
                typo_corrected: false,
                confidence: typeof detFallback.parsed.confidence === 'number'
                  ? detFallback.parsed.confidence
                  : 1,
                source: 'deterministic',
              }
            } else {
              parseResult = universal.parseResult
              aiResult = {
                parsed: universal.parseResult.parsed as Awaited<ReturnType<typeof aiParseModification>>['parsed'],
                status: universal.parseResult.status === 'parsed' ? 'parsed' : 'skipped',
                skip_reason: universal.parseResult.skip_reason,
                intent: universal.intent.kind === 'commentary' ? 'commentary' : universal.intent.kind === 'ignore' ? 'ignore' : 'modify',
                typo_corrected: false,
                confidence: universal.intent.confidence,
                source: universal.source === 'openai' ? 'openai' : 'deterministic',
              }
            }
          }
        } else {
          aiResult = await aiParseModification(this.supabase, {
            userId: this.userId,
            channelRowId: channelRow.id,
            rawMessage,
            revision: {
              prior_raw_message: existing.raw_message,
              prior_parsed_data: (existing.parsed_data ?? null) as Record<string, unknown> | null,
            },
          })
          parseResult = aiResultToParseResult(aiResult)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (isOpenAiRateLimitMessage(errMsg)) this.setRevisionAiCooldown(existing.id)
        console.error(
          `[userListener] message revision AI parse failed user=${this.userId} signalId=${existing.id}:`,
          errMsg,
        )
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'ai_modification_failed',
          channelRowId: channelRow.id,
          telegramMessageId: messageId,
          detail: { error: errMsg.slice(0, 300), signal_id: existing.id, source, revision: true },
        })
        return false
      }
    }

    if (parseResult!.status !== 'parsed') {
      if (isOpenAiRateLimitMessage(parseResult.skip_reason)) {
        this.setRevisionAiCooldown(existing.id)
      }
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_modification_skipped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: existing.id,
          source,
          revision: true,
          skip_reason: parseResult.skip_reason,
          intent: aiResult.intent,
        },
      })
      return false
    }
    this.revisionAiCooldowns.delete(existing.id)

    const fresh = await loadSignalByTelegramMessage(this.supabase, {
      userId: this.userId,
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
    })
    if (!fresh) return false
    if (isIncomingRevisionStale(fresh.telegram_edit_date_seen, args.telegramEditDateSeen)) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'message_revision_stale_skipped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: fresh.id,
          source,
          phase: 'pre_update',
          stored_edit_date: fresh.telegram_edit_date_seen,
          incoming_edit_date: args.telegramEditDateSeen ?? null,
        },
      })
      return false
    }
    if (!storedMessageDiffersFromTelegram(fresh.raw_message, rawMessage)) return false

    const updated = await updateSignalAfterRevision(this.supabase, {
      signalId: fresh.id,
      rawMessage,
      parseResult,
      telegramEditDateSeen: args.telegramEditDateSeen,
      existingStatus: fresh.status,
    })
    if (!updated) {
      if (
        args.telegramEditDateSeen != null
        && args.telegramEditDateSeen > 0
        && isIncomingRevisionStale(fresh.telegram_edit_date_seen, args.telegramEditDateSeen)
      ) {
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'message_revision_stale_skipped',
          channelRowId: channelRow.id,
          telegramMessageId: messageId,
          detail: {
            signal_id: fresh.id,
            source,
            phase: 'update_rejected',
            stored_edit_date: fresh.telegram_edit_date_seen,
            incoming_edit_date: args.telegramEditDateSeen,
          },
        })
      } else {
        console.error(
          `[userListener] message revision update failed user=${this.userId} signalId=${fresh.id}`,
        )
      }
      return false
    }

    const tRevision = Date.now()
    const dispatchRow = buildRevisionDispatchRow(fresh, parseResult, {
      t_ai_parse_done: tRevision,
      t_dispatch_sent: tRevision,
    }, args.telegramEditDateSeen)
    dispatchRow.dispatch_source = MESSAGE_REVISION_DISPATCH_SOURCE
    if (fresh.parsed_data?.action) {
      dispatchRow.revision_prior_action = String(fresh.parsed_data.action)
    }

    console.log(
      `[userListener] message revision dispatch user=${this.userId} signalId=${fresh.id}`
      + ` channelRow=${channelRow.id} messageId=${messageId} source=${source}`,
    )

    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'message_revision_applied',
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
      detail: {
        signal_id: fresh.id,
        source,
        intent: aiResult.intent,
        ai_source: aiResult.source,
        sl: parseResult.parsed.sl ?? null,
        tp: parseResult.parsed.tp ?? [],
      },
    })

    if (this.shouldSkipDuplicateRevisionDispatch(fresh.id, args.telegramEditDateSeen)) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'message_revision_dispatch_deduped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: { signal_id: fresh.id, source, edit_date: args.telegramEditDateSeen ?? null },
      })
      return true
    }

    this.dispatchRevisionSignal(dispatchRow)
    return true
  }

  private revisionDispatchDedupKey(signalId: string, editDate?: number | null): string {
    return `${signalId}|${editDate != null && editDate > 0 ? Math.floor(editDate) : 0}`
  }

  private shouldSkipDuplicateRevisionDispatch(signalId: string, editDate?: number | null): boolean {
    const key = this.revisionDispatchDedupKey(signalId, editDate)
    const now = Date.now()
    const seenAt = this.revisionDispatchDedup.get(key)
    if (seenAt != null && now - seenAt < 120_000) return true
    this.revisionDispatchDedup.set(key, now)
    if (this.revisionDispatchDedup.size > 500) {
      for (const [k, at] of this.revisionDispatchDedup) {
        if (now - at > 120_000) this.revisionDispatchDedup.delete(k)
      }
    }
    return false
  }

  private pruneRevisionAiCooldowns(now = Date.now()): void {
    if (this.revisionAiCooldowns.size <= 500) return
    for (const [signalId, until] of this.revisionAiCooldowns) {
      if (until <= now) this.revisionAiCooldowns.delete(signalId)
    }
  }

  private getRevisionAiCooldownRemainingMs(signalId: string, now = Date.now()): number {
    const until = this.revisionAiCooldowns.get(signalId) ?? 0
    if (until <= now) {
      if (until > 0) this.revisionAiCooldowns.delete(signalId)
      return 0
    }
    return until - now
  }

  private setRevisionAiCooldown(signalId: string, now = Date.now()): number {
    const until = now + REVISION_AI_RETRY_COOLDOWN_MS
    this.revisionAiCooldowns.set(signalId, until)
    this.pruneRevisionAiCooldowns(now)
    return until
  }

  private async tryDeterministicRevisionCompletion(args: {
    channelRowId: string
    rawMessage: string
    existingParsed: Record<string, unknown> | null | undefined
  }): Promise<Awaited<ReturnType<typeof parseChannelMessageSync>> | null> {
    const { keywords, lexicon } = await getChannelParseContext(this.supabase, args.channelRowId)
    const det = parseChannelMessageSync(args.rawMessage, keywords, lexicon)
    if (det.status !== 'parsed' || det.parsed.action === 'ignore') return null
    if (!revisionHasDeterministicActionableParse(args.existingParsed, det.parsed)) return null
    return det
  }

  private scheduleEntryMessageSettlePoll(channelRow: ChannelRow, messageId: string) {
    for (const delayMs of entryMessageSettleDelaysMs()) {
      setTimeout(() => {
        this.pollEntryMessageRevision(channelRow, messageId, delayMs).catch(err => {
          console.error(
            `[userListener] entry settle poll failed user=${this.userId} messageId=${messageId}:`,
            err instanceof Error ? err.message : err,
          )
        })
      }, delayMs)
    }
  }

  private async pollEntryMessageRevision(
    channelRow: ChannelRow,
    messageId: string,
    delayMs?: number,
  ) {
    const existing = await loadSignalByTelegramMessage(this.supabase, {
      userId: this.userId,
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
    })
    if (!existing) return

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(channelRow)
    } catch {
      return
    }

    const numericId = Number(messageId)
    if (!Number.isFinite(numericId) || numericId <= 0) return

    const batch = (await this.client.getMessages(peer as never, {
      ids: [numericId],
    })) as unknown[]
    const message = batch?.[0]
    const rawMessage = telegramMessageText(message)
    if (!rawMessage.trim()) return
    if (!storedMessageDiffersFromTelegram(existing.raw_message, rawMessage)) return

    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'entry_settle_poll_mismatch',
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
      detail: {
        signal_id: existing.id,
        delay_ms: delayMs ?? null,
        stored_len: existing.raw_message.length,
        fetched_len: rawMessage.length,
      },
    })

    const revised = await this.tryApplyMessageRevision({
      channelRow,
      messageId,
      rawMessage,
      source: 'entry_settle_poll',
      telegramEditDateSeen: telegramEditDateSec(message),
    })
    if (revised) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'entry_settle_poll_applied',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: { signal_id: existing.id, delay_ms: delayMs ?? null },
      })
    }
  }

  private dispatchRevisionSignal(dispatchRow: SignalRow): void {
    void loadCachedUserCopierPaused(this.supabase, this.userId).then(paused => {
      if (paused) return
      const dispatchedInProcess = this.onSignalParsed
        ? this.onSignalParsed(dispatchRow) === true
        : false
      this.routeDispatchToTradeWorker(dispatchRow, dispatchedInProcess)
    }).catch(() => {})
  }

  private isModificationClassMessage(
    rawMessage: string,
    isReply: boolean,
    channelKeywords?: import('./parseSignal').ChannelKeywords | null,
    lexicon?: import('./parseSignal').ChannelLexiconRow | null,
  ): boolean {
    const message = normalizeSignalMessageForParse(rawMessage)
    return isReply || looksLikeChannelManagementUpdate(message, channelKeywords, lexicon)
  }

  private async parseSignalForListener(args: {
    channelRowId: string
    rawMessage: string
    signalId: string
    isReply: boolean
    parentSignalId: string | null
    pipelineTs?: Record<string, unknown>
  }): Promise<{
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    aiMeta?: {
      intent: string
      source: string
      fallbackReason?: string
      reviewRequired?: boolean
    }
    channelKeywords: Awaited<ReturnType<typeof getChannelParseContext>>['keywords']
  }> {
    const { keywords, lexicon } = await getChannelParseContext(this.supabase, args.channelRowId)

    if (listenerInlineParseEnabled() && getUniversalParseMode() !== 'off') {
      const isModificationClass = this.isModificationClassMessage(
        args.rawMessage,
        args.isReply,
        keywords,
        lexicon,
      )
      const routed = await routeSignalParse({
        supabase: this.supabase,
        userId: this.userId,
        channelRowId: args.channelRowId,
        signalId: args.signalId,
        rawMessage: args.rawMessage,
        isReply: args.isReply,
        parentSignalId: args.parentSignalId,
        isModificationClass,
        keywords,
        lexicon,
        pipelineTs: args.pipelineTs,
      })
      if (
        routed.parseResult.status === 'parsed'
        && routed.aiMeta?.source
        && ['openai', 'cerebras', 'gpt4o'].includes(routed.aiMeta.source)
      ) {
        console.log(
          `[userListener] universal parse user=${this.userId} channelRow=${args.channelRowId}`
          + ` intent=${routed.aiMeta.intent} action=${routed.parseResult.parsed.action}`
          + ` symbol=${routed.parseResult.parsed.symbol ?? 'null'}`,
        )
      }
      const parseResult = routed.verification
        ? {
            ...routed.parseResult,
            parsed: {
              ...routed.parseResult.parsed,
              _verification: routed.verification,
            },
          }
        : routed.parseResult
      return {
        parseResult,
        aiMeta: routed.aiMeta,
        channelKeywords: keywords,
      }
    }

    if (this.isModificationClassMessage(args.rawMessage, args.isReply, keywords, lexicon)) {
      if (listenerInlineParseEnabled()) {
        const detMod = parseModificationDeterministic(args.rawMessage, keywords, lexicon)
        if (detMod.status === 'parsed' && detMod.parsed.action !== 'ignore') {
          return { parseResult: detMod, channelKeywords: keywords }
        }
      }
      const aiResult = await aiParseModification(this.supabase, {
        userId: this.userId,
        channelRowId: args.channelRowId,
        rawMessage: args.rawMessage,
        isReply: args.isReply,
        parentSignalId: args.parentSignalId,
      })
      return {
        parseResult: aiResultToParseResult(aiResult),
        aiMeta: { intent: aiResult.intent, source: aiResult.source },
        channelKeywords: keywords,
      }
    }
    if (listenerInlineParseEnabled()) {
      const det = parseChannelMessageSync(args.rawMessage, keywords, lexicon)
      const detEntryParsed =
        det.status === 'parsed'
        && (det.parsed.action === 'buy' || det.parsed.action === 'sell')
      // A deterministically-parsed management action (breakeven / modify / close /
      // partial / close-worse) must never be overridden by the AI entry parser —
      // otherwise an instruction like "SL to Entry" gets re-guessed as a fresh
      // entry on a hallucinated symbol and skipped as entry_requires_now.
      const detManagementParsed =
        det.status === 'parsed' && isManagementAction(parsedAction(det.parsed))
      if (detManagementParsed) {
        return { parseResult: det, channelKeywords: keywords }
      }

      const tryAiEntryParse = async (
        detFallback: Awaited<ReturnType<typeof parseChannelMessageSync>>,
      ): Promise<{
        parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
        aiMeta?: { intent: string; source: string }
      } | null> => {
        if (this.isModificationClassMessage(args.rawMessage, args.isReply, keywords, lexicon)) {
          return null
        }
        const aiEntry = await aiParseEntry(this.supabase, {
          userId: this.userId,
          channelRowId: args.channelRowId,
          rawMessage: args.rawMessage,
          isReply: args.isReply,
          parentSignalId: args.parentSignalId,
        })
        const aiMeta = { intent: 'entry', source: aiEntry.source }
        if (aiEntry.status === 'parsed') {
          console.log(
            `[userListener] ai entry parsed user=${this.userId} channelRow=${args.channelRowId}`
            + ` action=${aiEntry.parsed.action} symbol=${aiEntry.parsed.symbol ?? 'null'}`,
          )
          return {
            parseResult: aiEntryResultToParseResult(aiEntry),
            aiMeta,
          }
        }
        if (isAiEntryParseEnabled()) {
          console.warn(
            `[userListener] ai entry skipped user=${this.userId} channelRow=${args.channelRowId}:`
            + ` ${aiEntry.skip_reason ?? 'unknown'}`,
          )
          return {
            parseResult: {
              ...detFallback,
              skip_reason: aiEntry.skip_reason ?? detFallback.skip_reason,
            },
            aiMeta,
          }
        }
        return null
      }

      if (detEntryParsed) {
        if (!deterministicEntryNeedsAiRepair(det.parsed, args.rawMessage, keywords)) {
          return { parseResult: det, channelKeywords: keywords }
        }
        console.log(
          `[userListener] deterministic entry failed eligibility — trying AI repair`
          + ` user=${this.userId} channelRow=${args.channelRowId}`,
        )
        const aiParsed = await tryAiEntryParse(det)
        if (aiParsed?.parseResult.status === 'parsed') {
          return { ...aiParsed, channelKeywords: keywords }
        }
        return { parseResult: det, channelKeywords: keywords }
      }

      const aiParsed = await tryAiEntryParse(det)
      if (aiParsed) {
        return { ...aiParsed, channelKeywords: keywords }
      }
      return { parseResult: det, channelKeywords: keywords }
    }
    if (PARSE_SIGNAL_URL) {
      return {
        parseResult: await this.parseViaEdgeFunction(args.signalId, args.rawMessage, args.channelRowId),
        channelKeywords: keywords,
      }
    }
    return {
      parseResult: await parseRawChannelMessage(this.supabase, args.channelRowId, args.rawMessage),
      channelKeywords: keywords,
    }
  }

  /**
   * Resolve chat identity for an update without depending solely on
   * getChat(), which can fail transiently when gramjs entity cache is cold.
   */
  private async resolveChatIdentity(event: NewMessageEvent | EditedMessageEvent): Promise<ChatIdentity> {
    const message = event.message
    const fallbackId = event.chatId != null ? String(event.chatId) : ''
    let chatId = fallbackId
    let chatUsername = ''

    if ((!chatId || chatId === 'undefined') && message?.peerId) {
      try {
        chatId = utils.getPeerId(message.peerId, false).toString()
      } catch {
        // keep fallback
      }
    }

    try {
      const chat = await event.message?.getChat()
      if (chat) {
        const chatRaw = chat as unknown as { id?: unknown; username?: string }
        if (chatRaw.id != null) chatId = String(chatRaw.id)
        chatUsername = (chatRaw.username ?? '').toLowerCase()
      }
    } catch {
      // Fallback to event.chatId / peerId if entity lookup fails.
    }

    return {
      chatId,
      chatIdVariants: toChannelIdVariants(chatId),
      chatUsername,
    }
  }

  /**
   * Single insert path used by both live events (handleMessage) and
   * catch-up (catchUpChannel). Idempotent via the unique partial index
   * on signals(user_id, channel_id, telegram_message_id) — a row that already exists
   * is left untouched and parse-signal is not re-fired.
   */
  private async waitForCatchUpParseSlot(): Promise<void> {
    const max = catchUpParseConcurrency()
    while (this.catchUpParseActive >= max) {
      await new Promise(r => setTimeout(r, 50))
    }
    this.catchUpParseActive++
  }

  private releaseCatchUpParseSlot(): void {
    this.catchUpParseActive = Math.max(0, this.catchUpParseActive - 1)
  }

  private async deferCatchUpWhileLiveBusy(): Promise<void> {
    const pauseMs = livePriorityPauseMs()
    if (pauseMs <= 0) return
    while (Date.now() - this.lastLiveMessageAt < pauseMs) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  private async logSignal(
    channelRow: ChannelRow,
    message: MessageLike & { date?: number | Date | string },
    opts?: { source?: 'live' | 'catchup' },
  ): Promise<boolean> {
    const isCatchUp = opts?.source === 'catchup'
    if (isCatchUp) {
      await this.deferCatchUpWhileLiveBusy()
      await this.waitForCatchUpParseSlot()
    } else {
      incMetric('telegram_live_log_signal')
    }

    try {
      return await this.logSignalInner(channelRow, message, opts)
    } finally {
      if (isCatchUp) this.releaseCatchUpParseSlot()
    }
  }

  private async logSignalInner(
    channelRow: ChannelRow,
    message: MessageLike & { date?: number | Date | string },
    opts?: { source?: 'live' | 'catchup' },
  ): Promise<boolean> {
    if (await this.skipMessageWhileCopierPaused(channelRow, String(message.id))) return false

    const signalChannelId = await resolveSignalChannelIdForRow(this.supabase, channelRow)
    if (signalChannelId) {
      channelRow.signal_channel_id = signalChannelId
      if (await shouldSkipPassiveChannelIngest(
        this.supabase,
        this.userId,
        signalChannelId,
        this.passiveSignalChannelIds,
      )) {
        incMetric('channel_passive_ingest_skipped')
        return false
      }
    }

    const messageId = String(message.id)
    const rawMessage = telegramMessageText(message)
    const isReply = !!message.replyTo
    const messageEpochSec = this.messageEpochSec(message)
    // Stamp listener arrival as early as possible so telegram_to_listener_ms
    // reflects only Telegram delivery time (not our dedup/parent lookup DB calls).
    const tListenerReceived = Date.now()

    if (opts?.source === 'catchup' && messageEpochSec > 0) {
      const ageMs = Date.now() - messageEpochSec * 1000
      if (ageMs > catchUpMaxAgeMs()) {
        await this.bumpLastSeen(channelRow.id, messageId)
        console.log(
          `[userListener] catch-up skipped stale message user=${this.userId} channelRow=${channelRow.id}`
          + ` messageId=${messageId} ageMin=${Math.round(ageMs / 60_000)}`,
        )
        return false
      }
    }
    const replyToMessageId = extractReplyToMsgId(message.replyTo)
    let parentSignalId: string | null = null
    if (replyToMessageId) {
      parentSignalId = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
    }

    const heuristicCtx = await getChannelParseContext(this.supabase, channelRow.id)
    if (!looksLikeTradingSignal(rawMessage, isReply, heuristicCtx)) {
      console.log(
        `[userListener] skipped non-signal user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      void this.persistNonSignalSkip({
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
      })
      return false
    }

    const dedupKey = `${channelRow.id}:${messageId}`

    const { count: dupCount } = await this.supabase
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', this.userId)
      .eq('channel_id', channelRow.id)
      .eq('telegram_message_id', messageId)
    if ((dupCount ?? 0) > 0) {
      const revised = await this.tryApplyMessageRevision({
        channelRow,
        messageId,
        rawMessage,
        source: opts?.source === 'catchup' ? 'catchup' : 'duplicate_fallback',
        telegramEditDateSeen: telegramEditDateSec(message),
      })
      if (revised) return true
      console.log(
        `[userListener] duplicate message ignored user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      return false
    }

    const dedupAt = this.liveMessageDedup.get(dedupKey)
    if (dedupAt != null && Date.now() - dedupAt < 120_000) {
      return false
    }
    // Claim the message in-memory BEFORE the parse. The old code only set the
    // map after parse completed (~1.4s later), so two deliveries of the same
    // telegram message arriving within that window (live event + fast poll +
    // catch-up overlap) BOTH passed the DB count check and created two signals
    // that double-executed the same management action (partial_profit 4108 race).
    this.liveMessageDedup.set(dedupKey, Date.now())

    const signalId = randomUUID()
    const pipelineTs: PipelineTimestamps = {}
    if (messageEpochSec > 0) {
      setPipelineTimestamp(pipelineTs, 'telegram_source_message_at', messageEpochSec * 1000)
    }
    setPipelineTimestamp(pipelineTs, 'telegram_message_received_at', tListenerReceived)
    setPipelineTimestamp(pipelineTs, 'message_normalized_at', Date.now())
    const correlation = buildPipelineCorrelation({
      userId: this.userId,
      signalId,
      telegramMessageId: messageId,
      channelId: channelRow.id,
      dispatchSource: opts?.source ?? 'live',
    })
    emitPipelineEvent({
      event: 'signal_received',
      correlation,
      timestamps: pipelineTs,
      path: opts?.source ?? 'live',
    })

    let parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    let aiMeta: {
      intent: string
      source: string
      fallbackReason?: string
      reviewRequired?: boolean
    } | undefined
    let channelKeywords: Awaited<ReturnType<typeof getChannelParseContext>>['keywords'] | undefined
    try {
      const parsed = await withParseRetry({
        maxAttempts: listenerParseMaxAttempts(),
        backoffMs: attemptIndex => 750 * (attemptIndex + 1),
        onRetry: (err, attemptIndex) => {
          setPipelineTimestamp(pipelineTs, 'parse_started_at', Date.now())
          console.warn(
            `[userListener] parse retry ${attemptIndex + 1}/${listenerParseMaxAttempts()}`
            + ` user=${this.userId} signalId=${signalId}:`
            + ` ${err instanceof Error ? err.message : String(err)}`,
          )
        },
        attempt: () => {
          setPipelineTimestamp(pipelineTs, 'parse_started_at', Date.now())
          return this.parseSignalForListener({
            channelRowId: channelRow.id,
            rawMessage,
            signalId,
            isReply,
            parentSignalId,
            pipelineTs,
          })
        },
      })
      parseResult = parsed.parseResult
      aiMeta = parsed.aiMeta
      channelKeywords = parsed.channelKeywords
    } catch (err) {
      setPipelineTimestamp(pipelineTs, 'parse_completed_at', Date.now())
      // Release the early in-memory claim: the parse failed and nothing was
      // dispatched, so a later re-delivery of this message may be retried.
      this.liveMessageDedup.delete(dedupKey)
      const errMsg = err instanceof Error ? err.message : String(err)
      emitPipelineEvent({
        event: 'signal_parse_failed',
        correlation,
        timestamps: pipelineTs,
        outcome: 'failed',
        error_code: errMsg.slice(0, 120),
        path: opts?.source ?? 'live',
      })
      console.error(`[userListener] parse failed user=${this.userId} signalId=${signalId}:`, errMsg)
      void this.persistSignalBackground({
        signalId,
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
        parseResult: {
          parsed: {
            action: 'ignore',
            symbol: null,
            entry_price: null,
            entry_zone_low: null,
            entry_zone_high: null,
            sl: null,
            tp: [],
            lot_size: null,
            confidence: 0,
            raw_instruction: rawMessage,
            open_tp: false,
          },
          status: 'error',
          skip_reason: errMsg,
        },
        pipelineTs,
      })
      return false
    }
    setPipelineTimestamp(pipelineTs, 'parse_completed_at', Date.now())
    if (aiMeta) pipelineTs.t_ai_parse_done = pipelineTs.t_parse_done
    emitPipelineEvent({
      event: 'signal_parse_completed',
      correlation,
      timestamps: pipelineTs,
      outcome: parseResult.status,
      path: opts?.source ?? 'live',
      extra: {
        parser: aiMeta?.source ?? 'inline',
        parse_intent: aiMeta?.intent ?? null,
      },
    })

    if (!parentSignalId && parseResult.status === 'parsed') {
      const providerNum = (parseResult.parsed as { provider_signal_number?: number | null }).provider_signal_number
      if (typeof providerNum === 'number' && Number.isFinite(providerNum) && providerNum > 0) {
        const linked = await resolveEntrySignalIdByProviderNumber(this.supabase, {
          userId: this.userId,
          channelId: channelRow.id,
          providerSignalNumber: providerNum,
        })
        if (linked) parentSignalId = linked
      }
    }

    if (aiMeta && parseResult.status === 'parsed') {
      const eventType = aiMeta.intent === 'entry' ? 'ai_entry_parsed' : 'ai_modification_parsed'
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType,
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          intent: aiMeta.intent,
          ai_source: aiMeta.source,
        },
      })
    } else if (aiMeta && parseResult.status !== 'parsed') {
      const eventType = aiMeta.intent === 'entry' ? 'ai_entry_skipped' : 'ai_modification_skipped'
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType,
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          intent: aiMeta.intent,
          skip_reason: parseResult.skip_reason,
        },
      })
    }

    if (aiMeta?.fallbackReason) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_parse_fallback',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          reason: aiMeta.fallbackReason,
          deterministic_status: parseResult.status,
          deterministic_action: parseResult.parsed.action,
          ai_intent: aiMeta.intent,
          ai_source: aiMeta.source,
        },
      })
    }
    if (aiMeta?.reviewRequired) {
      notifyHumanReviewEmail(signalId)
      this.notifyHumanReviewTelegram(signalId, rawMessage, parseResult.parsed as unknown as Record<string, unknown>)
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_parse_review_required',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          ai_intent: aiMeta.intent,
          ai_source: aiMeta.source,
          skip_reason: parseResult.skip_reason,
          review_required: true,
        },
      })
    }

    const executionEligibility = evaluateParsedSignalExecutionEligibility(
      parseResult.parsed,
      rawMessage,
      channelKeywords,
    )
    let effectiveParseResult = (
      parseResult.status === 'parsed' && !executionEligibility.eligible
    )
      ? {
          ...parseResult,
          parsed: {
            ...parseResult.parsed,
            action: 'ignore',
            confidence: 0,
          },
          status: 'skipped',
          skip_reason: executionEligibility.skipReason ?? parseResult.skip_reason,
        }
      : parseResult

    if (effectiveParseResult.status === 'parsed') {
      const entryAction = String(effectiveParseResult.parsed.action ?? '').toLowerCase()
      const providerNum = (effectiveParseResult.parsed as { provider_signal_number?: number | null })
        .provider_signal_number
      const entrySymbol = effectiveParseResult.parsed.symbol
      if (
        (entryAction === 'buy' || entryAction === 'sell')
        && typeof providerNum === 'number'
        && Number.isFinite(providerNum)
        && providerNum > 0
      ) {
        const dupEntry = await findRecentEntrySignalByProviderNumber(this.supabase, {
          userId: this.userId,
          channelId: channelRow.id,
          providerSignalNumber: providerNum,
          symbol: typeof entrySymbol === 'string' ? entrySymbol : null,
          excludeTelegramMessageId: messageId,
        })
        if (dupEntry) {
          effectiveParseResult = {
            ...effectiveParseResult,
            parsed: {
              ...effectiveParseResult.parsed,
              action: 'ignore',
              confidence: 0,
            },
            status: 'skipped',
            skip_reason: 'duplicate_provider_signal',
          }
        }
      }
    }

    if (effectiveParseResult.status !== 'parsed') {
      if (signalChannelId) {
        const channelResult = await handlePostParseChannelIngest({
          supabase: this.supabase,
          userId: this.userId,
          channelRow,
          signalChannelId,
          messageId,
          rawMessage,
          replyToMessageId,
          parseResult: {
            parsed: effectiveParseResult.parsed as unknown as Record<string, unknown>,
            status: effectiveParseResult.status,
            skip_reason: effectiveParseResult.skip_reason,
          },
          pipelineTs: pipelineTs as Record<string, unknown>,
        })
        if (channelResult.skipPerUserIngest) return true
      }
      void this.persistSignalBackground({
        signalId,
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
        parseResult: effectiveParseResult,
        pipelineTs,
      })
      return true
    }

    if (signalChannelId) {
      const channelResult = await handlePostParseChannelIngest({
        supabase: this.supabase,
        userId: this.userId,
        channelRow,
        signalChannelId,
        messageId,
        rawMessage,
        replyToMessageId,
        parseResult: {
          parsed: effectiveParseResult.parsed as unknown as Record<string, unknown>,
          status: effectiveParseResult.status,
          skip_reason: effectiveParseResult.skip_reason,
        },
        pipelineTs: pipelineTs as Record<string, unknown>,
        dispatch: this.onSignalParsed ?? undefined,
      })
      if (channelResult.skipPerUserIngest) {
        this.liveMessageDedup.set(dedupKey, Date.now())
        await this.bumpLastSeen(channelRow.id, messageId)
        return true
      }
      if (channelResult.canonicalWritten && channelListenerShadowMode()) {
        // shadow mode: fall through to per-user ingest below
      }
    }

    pipelineTs.t_dispatch_sent = Date.now()
    const dispatchRow: SignalRow = {
      id: signalId,
      user_id: this.userId,
      channel_id: channelRow.id,
      parsed_data: effectiveParseResult.parsed as SignalRow['parsed_data'],
      status: effectiveParseResult.status,
      parent_signal_id: parentSignalId,
      is_modification: isReply,
      telegram_message_id: messageId,
      reply_to_message_id: replyToMessageId,
      created_at: new Date().toISOString(),
      pipeline_ts: pipelineTs,
    }
    // AI-lane dispatches carry their source so the trade worker can apply the
    // adverse-price entry guard only to AI-parsed / GPT-4o-reconciled entries.
    if (aiMeta?.source === 'cerebras' || aiMeta?.source === 'openai') {
      dispatchRow.dispatch_source = 'ai_parsed'
    } else if (aiMeta?.source === 'gpt4o') {
      dispatchRow.dispatch_source = 'ai_reconciled'
    }
    console.log(
      `[userListener] dispatch signal user=${this.userId} signalId=${signalId} channelRow=${channelRow.id} messageId=${messageId}`,
    )

    this.liveMessageDedup.set(dedupKey, Date.now())

    // Persist BEFORE dispatch so trades / order_send logs / range_pending_legs
    // can satisfy signal_id FKs (avoids ghost MT fills with empty Activities).
    setPipelineTimestamp(pipelineTs, 'signal_persist_started_at', Date.now())
    const ensured = await ensureSignalRow(this.supabase, {
      id: signalId,
      user_id: this.userId,
      channel_id: channelRow.id,
      raw_message: rawMessage,
      status: effectiveParseResult.status,
      parsed_data: effectiveParseResult.parsed as unknown as Record<string, unknown>,
      skip_reason: effectiveParseResult.skip_reason,
      telegram_message_id: messageId,
      reply_to_message_id: replyToMessageId,
      parent_signal_id: parentSignalId,
      is_modification: isReply,
      pipeline_ts: pipelineTs as Record<string, unknown>,
    })
    if (ensured.duplicate && ensured.existingSignalId) {
      // Another signal already owns this telegram message (duplicate delivery
      // that raced the parse window). Do NOT dispatch — the owner signal is
      // already being handled; dispatching would double-execute the action.
      console.log(
        `[userListener] duplicate telegram message dropped user=${this.userId} channelRow=${channelRow.id}`
        + ` messageId=${messageId} existingSignal=${ensured.existingSignalId} signalId=${signalId}`,
      )
      await this.bumpLastSeen(channelRow.id, messageId)
      return true
    }
    if (!ensured.ok) {
      console.error(
        `[userListener] ensureSignalRow before dispatch failed signalId=${signalId}: ${ensured.error ?? 'unknown'}`,
      )
    } else {
      setPipelineTimestamp(pipelineTs, 'signal_persist_completed_at', Date.now())
    }

    const dispatchedInProcess = this.onSignalParsed ? this.onSignalParsed(dispatchRow) === true : false
    this.routeDispatchToTradeWorker(dispatchRow, dispatchedInProcess, { persistBeforeDispatch: true })

    if (entryDispatchLooksSettleable(effectiveParseResult.parsed)) {
      this.scheduleEntryMessageSettlePoll(channelRow, messageId)
    }

    // Finish last_seen / parent relink without blocking the trade path again.
    void this.persistSignalBackground({
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult: effectiveParseResult,
      pipelineTs,
      skipUpsert: ensured.ok,
    })

    return true
  }

  /** Fire-and-forget handoff to trade worker (in-process, queue, or HTTP push). */
  private routeDispatchToTradeWorker(
    dispatchRow: SignalRow,
    dispatchedInProcess: boolean,
    opts?: { persistBeforeDispatch?: boolean },
  ): void {
    const shouldPush = workerConfig.runsListener && (!workerConfig.runsTrade || !dispatchedInProcess)
    if (!shouldPush) return

    void enqueueParsedSignal(this.supabase, dispatchRow).then(async queueResult => {
      const queueCfg = signalQueueConfig()
      const queueSucceeded = queueResult?.ok === true
      const shouldHttpPush = !queueSucceeded
        && (queueCfg.pushFallbackOnQueueFail || !queueResult || queueResult.skipped)
      let httpPushOk: boolean | null = null
      if (shouldHttpPush) {
        const action = parsedAction(dispatchRow.parsed_data)
        if (isManagementAction(action)) {
          httpPushOk = await pushParsedSignalToTradeWorkerAccept(dispatchRow)
        } else {
          pushParsedSignalToTradeWorker(dispatchRow)
          httpPushOk = true
        }
      }
      void this.supabase.from('trade_execution_logs').insert({
        user_id: this.userId,
        signal_id: dispatchRow.id,
        action: 'dispatch_route_decision',
        status: 'success',
        request_payload: {
          dispatched_in_process: dispatchedInProcess,
          should_push: shouldPush,
          queue_enabled: queueCfg.enabled,
          queue_enqueued: queueSucceeded,
          queue_skipped_reason: queueResult?.skipped ? queueResult.reason : null,
          queue_error: queueResult?.error ?? null,
          http_push_fallback: shouldHttpPush,
          http_push_ok: httpPushOk,
          mgmt_push_accept_only: isManagementAction(parsedAction(dispatchRow.parsed_data)),
          runs_trade: workerConfig.runsTrade,
          runs_listener: workerConfig.runsListener,
          persist_before_dispatch: opts?.persistBeforeDispatch === true,
        },
      })
    })
  }

  /** @deprecated Use persistSignalBackground after dispatch-first handoff. */
  private async persistSignalSync(args: {
    signalId: string
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
  }): Promise<boolean> {
    const {
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult,
    } = args

    const { error: insertErr } = await this.supabase.from('signals').upsert(
      {
        id: signalId,
        user_id: this.userId,
        channel_id: channelRow.id,
        raw_message: rawMessage,
        raw_image_url: null,
        status: parseResult.status,
        parsed_data: parseResult.parsed,
        skip_reason: parseResult.skip_reason,
        telegram_message_id: messageId,
        is_modification: isReply,
        parent_signal_id: parentSignalId,
        reply_to_message_id: replyToMessageId,
      },
      { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true },
    )
    if (insertErr) {
      console.error(`[userListener] signal upsert failed signalId=${signalId}:`, insertErr.message)
      return false
    }
    await this.bumpLastSeen(channelRow.id, messageId)
    let resolvedParent = parentSignalId
    if (replyToMessageId && !resolvedParent) {
      resolvedParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
      if (resolvedParent) {
        await this.supabase
          .from('signals')
          .update({ parent_signal_id: resolvedParent })
          .eq('id', signalId)
      }
    }
    await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalId)
    return true
  }

  /** Edge parse fallback when LISTENER_INLINE_PARSE=false (UI preview path unchanged on edge). */
  private async parseViaEdgeFunction(
    signalId: string,
    rawMessage: string,
    channelRowId: string,
  ): Promise<Awaited<ReturnType<typeof parseChannelMessageSync>>> {
    if (!PARSE_SIGNAL_URL) {
      return parseRawChannelMessage(this.supabase, channelRowId, rawMessage)
    }
    const parseTimeoutMs = Math.max(
      2_000,
      Math.min(15_000, Number(process.env.PARSE_SIGNAL_TIMEOUT_MS ?? 6_000)),
    )
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('parse-timeout'), parseTimeoutMs)
    try {
      await this.supabase.from('signals').upsert({
        id: signalId,
        user_id: this.userId,
        channel_id: channelRowId,
        raw_message: rawMessage,
        raw_image_url: null,
        status: 'pending',
      })
      const res = await fetch(PARSE_SIGNAL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
          apikey: PARSE_SIGNAL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ signal_id: signalId }),
        signal: controller.signal,
      })
      const body = await res.json().catch(() => ({})) as {
        parsed?: Record<string, unknown>
        status?: string
        skip_reason?: string | null
        error?: string
      }
      if (!res.ok) {
        throw new Error(body.error ?? `parse-signal returned ${res.status}`)
      }
      return {
        parsed: (body.parsed ?? {}) as unknown as Awaited<ReturnType<typeof parseChannelMessageSync>>['parsed'],
        status: String(body.status ?? 'parsed'),
        skip_reason: body.skip_reason ?? null,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private persistNonSignalSkip(args: {
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
  }): void {
    const { channelRow, rawMessage, messageId, parentSignalId, replyToMessageId, isReply } = args
    void (async () => {
      void rawMessage
      void parentSignalId
      void replyToMessageId
      void isReply
      // Non-trade chatter should not be persisted as skipped signal rows.
      await this.bumpLastSeen(channelRow.id, messageId)
    })().catch(err => {
      console.error('[userListener] persistNonSignalSkip failed:', err)
    })
  }

  private persistSignalBackground(args: {
    signalId: string
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    pipelineTs?: PipelineTimestamps
    /** When true, row was already ensured before dispatch — only bump last_seen / relink. */
    skipUpsert?: boolean
  }): void {
    const {
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult,
      pipelineTs,
      skipUpsert,
    } = args
    void (async () => {
      if (!skipUpsert) {
        if (pipelineTs) setPipelineTimestamp(pipelineTs, 'signal_persist_started_at', Date.now())
        const ensured = await ensureSignalRow(this.supabase, {
          id: signalId,
          user_id: this.userId,
          channel_id: channelRow.id,
          raw_message: rawMessage,
          status: parseResult.status,
          parsed_data: parseResult.parsed as unknown as Record<string, unknown>,
          skip_reason: parseResult.skip_reason,
          telegram_message_id: messageId,
          reply_to_message_id: replyToMessageId,
          parent_signal_id: parentSignalId,
          is_modification: isReply,
          pipeline_ts: pipelineTs as Record<string, unknown> | undefined,
        })
        if (!ensured.ok) {
          console.error(`[userListener] signal upsert failed signalId=${signalId}:`, ensured.error)
          return
        }
        if (pipelineTs) {
          setPipelineTimestamp(pipelineTs, 'signal_persist_completed_at', Date.now())
          emitPipelineEvent({
            event: 'signal_persisted',
            correlation: buildPipelineCorrelation({
              userId: this.userId,
              signalId,
              telegramMessageId: messageId,
              channelId: channelRow.id,
            }),
            timestamps: pipelineTs,
            outcome: parseResult.status,
          })
        }
      }
      await this.bumpLastSeen(channelRow.id, messageId)
      let resolvedParent = parentSignalId
      if (replyToMessageId && !resolvedParent) {
        resolvedParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
        if (resolvedParent) {
          await this.supabase
            .from('signals')
            .update({ parent_signal_id: resolvedParent })
            .eq('id', signalId)
        }
      }
      await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalId)
    })().catch(err => {
      console.error(`[userListener] persistSignalBackground failed signalId=${signalId}:`, err)
    })
  }

  /** Resolve `signals.id` of the parent message in this channel (telegram_channels row id). */
  private async resolveParentSignalIdForReply(
    channelRowId: string,
    replyToMessageId: string,
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from('signals')
      .select('id')
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('telegram_message_id', replyToMessageId)
      .maybeSingle()
    return (data as { id?: string } | null)?.id ?? null
  }

  /** Link orphan replies that pointed at this Telegram message id before the parent row existed. */
  private async relinkReplyOrphansAfterParentInsert(
    channelRowId: string,
    parentTelegramMessageId: string,
    parentSignalUuid: string,
  ): Promise<void> {
    await this.supabase
      .from('signals')
      .update({ parent_signal_id: parentSignalUuid })
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('reply_to_message_id', parentTelegramMessageId)
      .is('parent_signal_id', null)
  }

  private startReplyChainSweep() {
    if (this.replyChainSweepTimer) return
    this.replyChainSweepTimer = setInterval(() => {
      this.runReplyChainSweep().catch(err =>
        console.error(`[userListener] reply-chain sweep error for ${this.userId}:`, err),
      )
    }, REPLY_CHAIN_SWEEP_MS)
    this.replyChainSweepTimer.unref?.()
  }

  private startSignalReconcileSweep() {
    if (this.signalReconcileSweepTimer) return
    this.signalReconcileSweepTimer = setInterval(() => {
      this.runSignalTelegramReconcile('reconcile_sweep').catch(err =>
        console.error(`[userListener] signal reconcile sweep error for ${this.userId}:`, err),
      )
    }, RECONCILE_SWEEP_INTERVAL_MS)
    this.signalReconcileSweepTimer.unref?.()
    console.log(
      `[userListener] signal reconcile sweep started user=${this.userId}`
      + ` intervalMs=${RECONCILE_SWEEP_INTERVAL_MS}`,
    )
  }

  /**
   * Fetch live Telegram text for recent signals and reconcile mismatches with AI revision.
   */
  async runSignalTelegramReconcile(
    source: 'reconcile_sweep' | 'reconcile_poll_hook' | 'cron' | 'live_edit',
    channelRow?: ChannelRow,
  ): Promise<SignalReconcileStats> {
    const stats: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    if (this.signalReconcileInFlight) return stats
    this.signalReconcileInFlight = true
    try {
      const windowMs = source === 'reconcile_poll_hook' ? RECONCILE_POLL_HOOK_WINDOW_MS : undefined
      const maxSignals = source === 'reconcile_poll_hook' ? RECONCILE_POLL_HOOK_MAX_SIGNALS : undefined
      const signals = await loadSignalsForReconcile(this.supabase, {
        userId: this.userId,
        windowMs,
        maxSignals,
        channelRowId: channelRow?.id,
      })
      if (!signals.length) return stats

      const grouped = groupSignalsByChannel(signals)
      for (const [channelRowId, rows] of grouped) {
        const row = channelRow?.id === channelRowId
          ? channelRow
          : this.fastPollRows.find(r => r.id === channelRowId)
            ?? (await this.supabase
              .from('telegram_channels')
              .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
              .eq('id', channelRowId)
              .maybeSingle()).data as ChannelRow | null
        if (!row) continue

        const channelStats = await this.runSignalReconcileForChannel(row, rows, source)
        stats.checked += channelStats.checked
        stats.mismatches += channelStats.mismatches
        stats.revised += channelStats.revised
        stats.errors += channelStats.errors
      }
      return stats
    } finally {
      this.signalReconcileInFlight = false
    }
  }

  private async runSignalReconcileForChannel(
    channelRow: ChannelRow,
    signals: Awaited<ReturnType<typeof loadSignalsForReconcile>>,
    source: string,
  ): Promise<SignalReconcileStats> {
    const stats: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    const signalChannelId = channelRow.signal_channel_id
      ?? await resolveSignalChannelIdForRow(this.supabase, channelRow)
    if (isChannelRowPassive(signalChannelId, this.passiveSignalChannelIds)) {
      incMetric('channel_passive_reconcile_skipped')
      return stats
    }

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(channelRow)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      stats.errors += 1
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'signal_reconcile_sweep_error',
        channelRowId: channelRow.id,
        detail: { source, error: msg.slice(0, 300), phase: 'peer_resolve' },
      })
      return stats
    }

    const snapshots = new Map<string, { text: string; editDateSec: number | null }>()
    const ids = signals.map(s => s.telegram_message_id)
    for (const chunk of chunkTelegramMessageIds(ids)) {
      const numericIds = chunk
        .map(id => Number(id))
        .filter(n => Number.isFinite(n) && n > 0)
      if (!numericIds.length) continue
      try {
        const batch = (await this.client.getMessages(peer as never, {
          ids: numericIds,
        })) as unknown[]
        for (const [id, snap] of snapshotsFromTelegramMessages(batch ?? [])) {
          snapshots.set(id, snap)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        stats.errors += 1
        incMetric('signal_reconcile_get_messages_failed')
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'signal_reconcile_sweep_error',
          channelRowId: channelRow.id,
          detail: {
            source,
            error: msg.slice(0, 300),
            phase: 'get_messages',
            ids: chunk.slice(0, 10),
          },
        })
      }
    }

    const checkedIds: string[] = []
    const editDateBySignalId = new Map<string, number | null>()
    for (const signal of signals) {
      const mid = signal.telegram_message_id?.trim()
      const snap = mid ? snapshots.get(mid) : undefined
      if (!snap) continue
      checkedIds.push(signal.id)
      editDateBySignalId.set(signal.id, snap.editDateSec)
    }
    stats.checked = checkedIds.length

    const textMismatches = findSignalsNeedingReconcile(signals, snapshots)
    const textMismatchIds = new Set(textMismatches.map(m => m.signal.id))

    const { keywords, lexicon } = await getChannelParseContext(this.supabase, channelRow.id)
    const parsedDrift: typeof textMismatches = []
    for (const signal of signals) {
      if (textMismatchIds.has(signal.id)) continue
      const mid = signal.telegram_message_id?.trim()
      const snap = mid ? snapshots.get(mid) : undefined
      if (!snap) continue
      const reparsed = parseChannelMessageSync(snap.text, keywords, lexicon)
      if (reparsed.status !== 'parsed') continue
      const freshRecord = {
        action: reparsed.parsed.action,
        sl: reparsed.parsed.sl,
        tp: reparsed.parsed.tp,
      }
      if (!parsedTargetsDrift(signal.parsed_data, freshRecord)) continue
      parsedDrift.push({ signal, rawMessage: snap.text, editDateSec: snap.editDateSec })
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'signal_reconcile_parsed_drift',
        channelRowId: channelRow.id,
        telegramMessageId: signal.telegram_message_id,
        detail: {
          source,
          signal_id: signal.id,
          stored: normalizedSlTpTargets(signal.parsed_data),
          fresh: normalizedSlTpTargets(freshRecord),
        },
      })
    }

    const mismatches = [...textMismatches, ...parsedDrift]
    const mismatchIds = new Set(mismatches.map(m => m.signal.id))
    const reconciledIds = checkedIds.filter(id => !mismatchIds.has(id))
    if (reconciledIds.length) {
      await markSignalsReconciled(this.supabase, {
        signalIds: reconciledIds,
        editDateBySignalId,
      })
    }
    if (!mismatches.length) {
      if (stats.checked > 0) {
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'signal_reconcile_checked',
          channelRowId: channelRow.id,
          detail: { source, checked: stats.checked, mismatches: 0 },
        })
      }
      return stats
    }

    stats.mismatches = mismatches.length
    for (const candidate of mismatches) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'signal_reconcile_mismatch',
        channelRowId: channelRow.id,
        telegramMessageId: candidate.signal.telegram_message_id,
        detail: {
          source,
          signal_id: candidate.signal.id,
          edit_date_sec: candidate.editDateSec,
        },
      })
      try {
        const revised = await this.tryApplyMessageRevision({
          channelRow,
          messageId: candidate.signal.telegram_message_id,
          rawMessage: candidate.rawMessage,
          source: `reconcile_${source}`,
          telegramEditDateSeen: candidate.editDateSec,
        })
        if (revised) {
          stats.revised += 1
          await markSignalsReconciled(this.supabase, {
            signalIds: [candidate.signal.id],
            editDateBySignalId,
          })
        }
      } catch {
        stats.errors += 1
      }
    }
    return stats
  }

  /** Re-resolve `parent_signal_id` for recent replies (parent may have arrived later). */
  private async runReplyChainSweep() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: orphans, error } = await this.supabase
      .from('signals')
      .select('id, channel_id, reply_to_message_id')
      .eq('user_id', this.userId)
      .not('reply_to_message_id', 'is', null)
      .is('parent_signal_id', null)
      .gte('created_at', since)
      .limit(80)
    if (error || !orphans?.length) return

    for (const row of orphans as { id: string; channel_id: string; reply_to_message_id: string }[]) {
      const rid = row.reply_to_message_id?.trim()
      if (!rid || !row.channel_id) continue
      const parentId = await this.resolveParentSignalIdForReply(row.channel_id, rid)
      if (parentId) {
        await this.supabase
          .from('signals')
          .update({ parent_signal_id: parentId })
          .eq('id', row.id)
      }
    }
  }

  private async skipMessageWhileCopierPaused(channelRow: ChannelRow, messageId: string): Promise<boolean> {
    if (!(await loadCachedUserCopierPaused(this.supabase, this.userId))) return false
    await this.bumpLastSeen(channelRow.id, messageId)
    return true
  }

  private subscribeCopierPauseState(): void {
    if (this.userProfilesCopierPauseChannel) return
    this.userProfilesCopierPauseChannel = this.supabase
      .channel(`user_listener_copier_pause_${this.userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_profiles',
          filter: `user_id=eq.${this.userId}`,
        } as never,
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new
          if (!row) return
          const copierPaused = row.copier_paused === true
          const previousPaused = payload.old?.copier_paused === true
          const transition = applyCopierPauseProfileUpdate(this.userId, copierPaused, previousPaused)
          if (transition === 'resumed') {
            void this.advanceAllChannelsLastSeenToLatest()
          }
        },
      )
      .subscribe()
  }

  private async advanceChannelLastSeenToLatest(row: ChannelRow, peer?: unknown): Promise<void> {
    try {
      const resolvedPeer = peer ?? await this.resolveChannelPeer(row)
      const latest = await this.client.getMessages(resolvedPeer as never, { limit: 1 })
      const latestId = Number(latest[0]?.id)
      if (!Number.isFinite(latestId)) return
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] advance last_seen failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
    }
  }

  private async advanceAllChannelsLastSeenToLatest(): Promise<void> {
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    for (const row of (rows ?? []) as ChannelRow[]) {
      await this.advanceChannelLastSeenToLatest(row)
    }
  }

  private async bumpLastSeen(channelRowId: string, messageId: string) {
    const num = Number(messageId)
    if (!Number.isFinite(num)) return

    // Only advance the high-water mark forwards.
    await this.supabase
      .from('telegram_channels')
      .update({
        last_seen_message_id: num,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', channelRowId)
      .or(`last_seen_message_id.is.null,last_seen_message_id.lt.${num}`)
  }

  private async bumpLastLive(channelRowId: string) {
    this.lastLiveByRow.set(channelRowId, Date.now())
    await this.supabase
      .from('telegram_channels')
      .update({ last_live_at: new Date().toISOString() })
      .eq('id', channelRowId)
  }

  /** Resolve + join every monitored channel so live NewMessage fires for all of them. */
  private async warmAllMonitoredChannelEntities(): Promise<void> {
    if (!this.isConnected) return
    if (Date.now() < this.pollBackoffUntil) return
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    for (const row of ((rows ?? []) as ChannelRow[]).filter(r => !this.isChannelLocallyDisabled(r))) {
      await this.ensureJoinedPublicChannel(row).catch(() => { /* optional */ })
      await this.warmChannelEntity(row).catch(() => { /* logged inside */ })
    }
  }

  /**
   * Join public channels by @username so getMessages and live updates work for
   * external signal providers the user has not opened in Telegram yet.
   */
  private async ensureJoinedPublicChannel(row: ChannelRow): Promise<void> {
    if (this.isChannelLocallyDisabled(row)) return
    const username = normalizeChannelUsername(row.channel_username)
    if (!username) return
    const cooldownUntil = this.channelResolveCooldownUntil.get(row.id)?.until ?? 0
    if (Date.now() < cooldownUntil) return
    try {
      const entity = await this.client.getInputEntity(username)
      await tgInvoke(this.client, new Api.channels.JoinChannel({ channel: entity }))
      this.resetChannelInvalidFailure(row, 'ensure_joined_public_channel')
      this.channelResolveCooldownUntil.delete(row.id)
      incMetric('channel_join_ok')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.includes('USER_ALREADY_PARTICIPANT')
        || msg.includes('CHANNELS_TOO_MUCH')
        || msg.includes('INVITE_HASH_EMPTY')
        || msg.includes('INVITE_HASH_EXPIRED')
      ) {
        this.channelResolveCooldownUntil.delete(row.id)
        return
      }
      if (isConfirmedChannelInvalidError(err)) {
        this.setChannelResolveCooldown(row.id, err)
        await this.noteChannelInvalid(row, 'ensure_joined_public_channel', err)
        return
      }
      this.setChannelResolveCooldown(row.id, err)
      console.warn(
        `[userListener] ensureJoinedPublicChannel @${username} channel=${row.id}:`,
        msg.slice(0, 200),
      )
    }
  }

  // ── catch-up after connect/reconnect ──────────────────────────────────

  /** Non-blocking so live NewMessage handling is not delayed behind history replay. */
  private scheduleCatchUpOnStart() {
    if (!catchUpOnStartEnabled()) {
      console.log(`[userListener] catch-up on start disabled user=${this.userId}`)
      return
    }
    console.log(
      `[userListener] catch-up scheduled (background) user=${this.userId} maxAgeMin=${Math.round(catchUpMaxAgeMs() / 60_000)}`,
    )
    void this.runCatchUp().catch(err =>
      console.error(`[userListener] catch-up failed for ${this.userId}:`, err),
    )
  }

  private async runCatchUp() {
    if (this.catchUpInFlight) return
    if (Date.now() < this.pollBackoffUntil) return
    this.catchUpInFlight = true
    try {
      const { data: rows } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)

      for (const row of (rows ?? []) as ChannelRow[]) {
        await this.catchUpChannel(row).catch(err =>
          console.error(`[userListener] catchUp failed for channel ${row.id}:`, err)
        )
      }
    } finally {
      this.catchUpInFlight = false
    }
  }

  private async runRecentCatchUp(): Promise<void> {
    if (this.catchUpInFlight) return
    if (Date.now() < this.pollBackoffUntil) return
    this.catchUpInFlight = true
    try {
      const { data: rows } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)

      for (const row of (rows ?? []) as ChannelRow[]) {
        await this.catchUpChannelRecent(row).catch(err =>
          console.error(`[userListener] recent catchUp failed for channel ${row.id}:`, err)
        )
      }
    } finally {
      this.catchUpInFlight = false
    }
  }

  private async pollMonitoredChannelsForMessages(): Promise<void> {
    if (!this.isConnected) return
    if (Date.now() < this.pollBackoffUntil) return
    const floodAtCycleStart = this.floodErrorsThisCycle
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, signal_channel_id, last_seen_message_id, last_seen_at, last_live_at')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    const activeRows = ((rows ?? []) as ChannelRow[]).filter(row => !this.isChannelLocallyDisabled(row))
    await this.mapWithConcurrency(activeRows, CHANNEL_POLL_CONCURRENCY, async row => {
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll failed channel=${row.id}:`, err),
      )
    })
    this.endPollCycle(floodAtCycleStart)
  }

  /**
   * Poll Telegram history for channels where live NewMessage updates are missing
   * (common when the linked account broadcasts to its own channel).
   */
  private async pollChannelNewMessages(row: ChannelRow): Promise<FastPollOutcome> {
    if (this.isChannelLocallyDisabled(row)) return 'skipped'
    const signalChannelId = row.signal_channel_id
      ?? await resolveSignalChannelIdForRow(this.supabase, row)
    if (isChannelRowPassive(signalChannelId, this.passiveSignalChannelIds)) {
      incMetric('channel_passive_poll_skipped')
      return 'skipped'
    }

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch (err) {
      if (isAuthKeyDuplicated(err)) {
        this.noteAuthKeyDuplicated('poll_peer_resolve', row.id, {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        })
        return 'failed'
      }
      if (isConfirmedChannelInvalidError(err)) {
        await this.noteChannelInvalid(row, 'poll_peer_resolve', err)
        return 'failed'
      }
      if (isFloodWaitOrRetryExhaustion(err)) {
        this.noteFloodWaitBackoff(safeTelegramErrorMessage(err))
        return 'failed'
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] poll peer resolve failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
      incMetric('poll_peer_resolve_failed')
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'poll_peer_resolve_failed',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300) },
      })
      return 'failed'
    }
    let minId = Number(row.last_seen_message_id ?? 0)
    if (!Number.isFinite(minId) || minId < 0) minId = 0

    let batch: Array<MessageLike & { id: number | bigint }>
    try {
      batch = (await this.client.getMessages(peer as never, {
        limit: minId === 0 ? 20 : 30,
        ...(minId > 0 ? { minId } : {}),
      })) as unknown as Array<MessageLike & { id: number | bigint }>
    } catch (err) {
      if (isAuthKeyDuplicated(err)) {
        this.noteAuthKeyDuplicated('poll_getMessages', row.id, {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          min_id: minId,
        })
        return 'failed'
      }
      if (isConfirmedChannelInvalidError(err)) {
        await this.noteChannelInvalid(row, 'poll_getMessages', err)
        return 'failed'
      }
      if (isFloodWaitOrRetryExhaustion(err)) {
        this.noteFloodWaitBackoff(safeTelegramErrorMessage(err))
        return 'failed'
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] poll getMessages failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
      incMetric('poll_get_messages_failed')
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'poll_error',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300), min_id: minId },
      })
      return 'failed'
    }

    this.lastSuccessfulPollAt = Date.now()
    this.noteChannelPollSuccess(row, 'poll_getMessages')

    if (!batch.length) {
      await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
      return 'empty'
    }

    const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id))
    const latestId = Number(sorted[sorted.length - 1]?.id)
    if (!Number.isFinite(latestId)) return 'failed'

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
      return 'messages'
    }

    if (minId === 0) {
      const now = Date.now()
      const recentWindowMs = 15 * 60_000
      for (const m of sorted) {
        const mid = Number(m.id)
        if (!Number.isFinite(mid)) continue
        const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
        if (epoch > 0 && now - epoch * 1000 <= recentWindowMs) {
          await this.logSignal(row, m, { source: 'catchup' })
        }
      }
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
      console.log(
        `[userListener] poll seeded channel=${row.id} username=${row.channel_username || '-'} lastMsg=${latestId}`,
      )
      return 'messages'
    }

    const toProcess = sorted.filter(m => Number(m.id) > minId)
    if (!toProcess.length) {
      await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
      return 'empty'
    }

    for (const m of toProcess) {
      await this.logSignal(row, m, { source: 'catchup' })
    }
    // Advance the caller's row in place so cached rows (fast poll) don't
    // refetch the same batch on the next tick while the DB bump lags.
    row.last_seen_message_id = latestId
    await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
    return 'messages'
  }

  private async catchUpChannelRecent(row: ChannelRow): Promise<void> {
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch {
      return
    }

    const minIdRaw = row.last_seen_message_id
    const minId = minIdRaw == null ? 0 : Number(minIdRaw)
    if (!Number.isFinite(minId) || minId <= 0) return

    let batch: Array<MessageLike & { id: number | bigint }>
    try {
      batch = (await this.client.getMessages(peer as never, {
        limit: 20,
        minId,
      })) as unknown as Array<MessageLike & { id: number | bigint }>
    } catch {
      return
    }

    if (!batch.length) return

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id))
      const latestId = Number(sorted[sorted.length - 1]?.id)
      if (Number.isFinite(latestId) && latestId > minId) {
        await this.bumpLastSeen(row.id, String(latestId))
        row.last_seen_message_id = latestId
      }
      return
    }

    const now = Date.now()
    const maxAgeMs = 60_000
    const recent = batch
      .filter(m => {
        const mid = Number(m.id)
        if (!Number.isFinite(mid) || mid <= minId) return false
        const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
        return epoch > 0 && (now - epoch * 1000) <= maxAgeMs
      })
      .sort((a, b) => Number(a.id) - Number(b.id))

    for (const m of recent) {
      await this.logSignal(row, m, { source: 'catchup' })
    }
  }

  private async warmChannelEntity(row: ChannelRow): Promise<void> {
    if (this.isChannelLocallyDisabled(row)) return
    try {
      await this.resolveChannelPeer(row)
      this.resetChannelInvalidFailure(row, 'warm_channel_entity')
    } catch (err) {
      if (isConfirmedChannelInvalidError(err)) {
        await this.noteChannelInvalid(row, 'warm_channel_entity', err)
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[userListener] warmChannelEntity failed channel=${row.id}:`, msg)
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'peer_resolve_failed',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300) },
      })
    }
  }

  private async resolveChannelPeer(row: ChannelRow): Promise<unknown> {
    const key = row.channel_username?.replace(/^@/, '') || row.channel_id
    // If a recent resolve failed, skip BOTH the ResolveUsername RPC and the
    // expensive dialog scan, and rethrow the captured representative error so
    // confirmed-invalid channels keep progressing toward auto-disable without
    // hammering Telegram every poll tick.
    const cooldownUntil = this.channelResolveCooldownUntil.get(row.id)?.until ?? 0
    if (Date.now() < cooldownUntil) {
      this.throwChannelResolveCooldown(row.id)
    }
    try {
      const peer = await this.client.getInputEntity(key)
      this.channelResolveCooldownUntil.delete(row.id)
      return peer
    } catch (err) {
      if (isConfirmedChannelInvalidError(err)) {
        this.setChannelResolveCooldown(row.id, err)
        throw err
      }
      // Entity cache miss — warm from dialogs (common right after connect).
      // Fall through to the dialog scan below.
    }

    const wantUser = (row.channel_username ?? '').replace(/^@/, '').toLowerCase()
    const idVariants = new Set(toChannelIdVariants(row.channel_id))

    try {
      const dialogs = await this.fetchAllDialogs()
      for (const d of dialogs) {
        if (!d.isChannel && !d.isGroup) continue
        const entity = d.entity
        if (!entity) continue
        const id = String(d.id ?? '')
        const username = String((entity as { username?: string }).username ?? '').toLowerCase()
        const matches =
          (wantUser && username === wantUser)
          || idVariants.has(id)
          || [...idVariants].some(v => id === v || id.endsWith(v))
        if (matches) {
          this.channelResolveCooldownUntil.delete(row.id)
          return await this.client.getInputEntity(entity)
        }
      }
      const peer = await this.client.getInputEntity(key)
      this.channelResolveCooldownUntil.delete(row.id)
      return peer
    } catch (err) {
      // Flood / retry-exhaustion errors are transient and handled by the
      // session-wide poll backoff — do NOT cache them in the 10-min resolve
      // cooldown, or a stale cached flood error would keep re-arming the
      // session backoff (via throwChannelResolveCooldown) for the whole window.
      if (!isFloodWaitOrRetryExhaustion(err)) {
        this.setChannelResolveCooldown(row.id, err)
      }
      rethrowIfSessionInvalid(err)
    }
  }

  private async catchUpChannel(row: ChannelRow): Promise<void> {
    if (this.isChannelLocallyDisabled(row)) return
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch (err) {
      if (isConfirmedChannelInvalidError(err)) {
        await this.noteChannelInvalid(row, 'catchup_peer_resolve', err)
        return
      }
      console.warn(`[userListener] resolveChannelPeer miss for channel ${row.id}; skipping catch-up this round`, err)
      return
    }
    this.resetChannelInvalidFailure(row, 'catchup_peer_resolve')

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      await this.advanceChannelLastSeenToLatest(row, peer)
      return
    }

    const minIdRaw = row.last_seen_message_id
    const minId = minIdRaw == null ? 0 : Number(minIdRaw)
    if (!Number.isFinite(minId) || minId < 0) {
      console.warn(`[userListener] invalid last_seen for channel ${row.id}; skipping catch-up`)
      return
    }

    if (minId === 0) {
      // Seed-only on first-ever listen — do not backfill historical messages.
      // Without this, a user picking a 5-year-old signal channel would
      // import its entire history.
      try {
        const latest = await this.client.getMessages(peer as never, { limit: 1 })
        if (latest[0]) await this.bumpLastSeen(row.id, String(latest[0].id))
      } catch (err) {
        console.warn(`[userListener] seed last_seen failed for channel ${row.id}:`, err)
      }
      return
    }

    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 50

    while (collected.length < CATCHUP_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
          minId,
        })) as unknown as Array<MessageLike & { id: number | bigint }>
      } catch (err) {
        console.error(`[userListener] getMessages failed for channel ${row.id}:`, err)
        break
      }

      if (!batch.length) break
      for (const m of batch) collected.push(m)
      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    // gramjs returns newest-first; insert oldest-first so last_seen
    // monotonically advances and parse-signal sees signals in order.
    collected.sort((a, b) => Number(a.id) - Number(b.id))
    const toProcess = collected.filter(m => {
      const mid = Number(m.id)
      return Number.isFinite(mid) && mid > minId
    })

    incMetric('catchup_messages_queued', toProcess.length)

    await this.mapWithConcurrency(toProcess, catchUpParseConcurrency(), async m => {
      await this.logSignal(row, m, { source: 'catchup' })
    })

    console.log(
      `[userListener] catch-up channel done user=${this.userId} channelRow=${row.id} processed=${toProcess.length}`,
    )
  }

  private messageEpochSec(m: MessageLike & { date?: number | Date | string }): number {
    const dateRaw = m.date
    if (typeof dateRaw === 'number') return dateRaw
    if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
    if (typeof dateRaw === 'string') {
      const t = Date.parse(dateRaw)
      return Number.isFinite(t) ? Math.floor(t / 1000) : 0
    }
    return 0
  }

  /** All non-empty messages in range (no trading heuristic) — used for backtest import only. */
  private async fetchMessagesBetweenForBacktest(
    row: ChannelRow,
    fromMs: number,
    toMs: number,
  ): Promise<MessageLike[]> {
    return this.fetchMessagesBetween(row, fromMs, toMs, { forBacktest: true })
  }

  private async fetchMessagesBetween(
    row: ChannelRow,
    fromMs: number,
    toMs: number,
    opts?: { forBacktest?: boolean },
  ): Promise<MessageLike[]> {
    const fromSec = Math.floor(fromMs / 1000)
    const toSec = Math.floor(toMs / 1000)

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch {
      throw new Error('Failed to resolve Telegram channel entity')
    }

    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 100
    const heuristicCtx = await getChannelParseContext(this.supabase, row.id)

    while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
        })) as unknown as Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      } catch {
        break
      }
      if (!batch.length) break

      let reachedOlderThanRange = false
      for (const m of batch) {
        const msgEpochSec = this.messageEpochSec(m)
        if (msgEpochSec && msgEpochSec < fromSec) {
          reachedOlderThanRange = true
          continue
        }
        if (msgEpochSec && msgEpochSec > toSec) {
          continue
        }
        const raw = telegramMessageText(m)
        if (!raw) continue
        const isReply = !!m.replyTo
        const fetchAllForBacktest = process.env.BACKTEST_FETCH_ALL_MESSAGES === 'true'
        if (!opts?.forBacktest) {
          if (!looksLikeTradingSignal(raw, isReply, heuristicCtx)) continue
        } else if (!fetchAllForBacktest) {
          if (!looksLikeTradingSignal(raw, isReply, heuristicCtx)) continue
        }
        collected.push(m)
      }

      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize || reachedOlderThanRange) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    collected.sort((a, b) => Number(a.id) - Number(b.id))
    return collected
  }

  private async backfillChannelFromDate(
    row: ChannelRow,
    days: number,
    opts?: { forTraining?: boolean },
  ): Promise<string[]> {
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch {
      throw new Error('Failed to resolve Telegram channel entity')
    }

    const sinceEpochSec = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000)
    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 100
    const heuristicCtx = opts?.forTraining
      ? null
      : await getChannelParseContext(this.supabase, row.id)

    while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
        })) as unknown as Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      } catch {
        break
      }
      if (!batch.length) break

      for (const m of batch) {
        const dateRaw = m.date
        const msgEpochSec = (() => {
          if (typeof dateRaw === 'number') return dateRaw
          if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
          if (typeof dateRaw === 'string') {
            const t = Date.parse(dateRaw)
            return Number.isFinite(t) ? Math.floor(t / 1000) : 0
          }
          return 0
        })()
        if (msgEpochSec && msgEpochSec < sinceEpochSec) {
          // We've reached older-than-lookback history.
          break
        }
        collected.push(m)
      }

      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize) break
      const oldest = batch[batch.length - 1]
      const oldestEpochSec = (() => {
        const dateRaw = oldest?.date
        if (typeof dateRaw === 'number') return dateRaw
        if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
        if (typeof dateRaw === 'string') {
          const t = Date.parse(dateRaw)
          return Number.isFinite(t) ? Math.floor(t / 1000) : 0
        }
        return 0
      })()
      if (oldestEpochSec && oldestEpochSec < sinceEpochSec) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    collected.sort((a, b) => Number(a.id) - Number(b.id))
    const out: string[] = []
    for (const m of collected) {
      const raw = telegramMessageText(m)
      if (!raw) continue
      const isReply = !!m.replyTo
      const passes = opts?.forTraining
        ? looksLikeTrainingCandidate(raw)
        : looksLikeTradingSignal(raw, isReply, heuristicCtx)
      if (!passes) continue
      out.push(raw)
      if (out.length >= 300) break
    }
    return out
  }

  // ── watchdog ──────────────────────────────────────────────────────────

  private startWatchdog() {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      this.runWatchdog().catch(err =>
        console.error(`[userListener] watchdog tick error for ${this.userId}:`, err)
      )
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref?.()
  }

  /**
   * Probe MTProto with a cheap authenticated call. With library autoReconnect
   * disabled (see `buildClient`), TCP drops and zombie sockets are handled here:
   * the probe forces a round-trip; consecutive failures trigger an explicit
   * disconnect + cooldown + reconnect in `forceReconnect`.
   */
  private async runWatchdog() {
    try {
      await tgInvoke(this.client, new Api.updates.GetState())
      this.consecutiveProbeFailures = 0
      this.lastEventAt = this.lastEventAt || Date.now()
      this.lastSuccessfulPollAt = Date.now()
      this.updateHealth('watchdog_probe_ok')
    } catch (err) {
      if (isAuthKeyDuplicated(err)) {
        this.noteAuthKeyDuplicated('watchdog_probe')
        return
      }
      this.consecutiveProbeFailures++
      this.updateHealth('watchdog_probe_failed')
      console.warn(
        `[watchdog] probe failed (${this.consecutiveProbeFailures}/${WATCHDOG_FAILURE_THRESHOLD}) for ${this.userId}:`,
        err instanceof Error ? err.message : String(err),
      )
      if (this.consecutiveProbeFailures >= WATCHDOG_FAILURE_THRESHOLD) {
        await this.requestReconnect('watchdog')
      }
    }
  }

  private noteAuthKeyDuplicated(
    source: string,
    channelRowId?: string,
    detail?: Record<string, unknown>,
  ): void {
    this.isConnected = false
    const now = Date.now()
    if (shouldEmitAuthKeyDupEvent(this.lastAuthKeyDupLogAt, now, 30_000)) {
      this.lastAuthKeyDupLogAt = now
      incMetric('auth_key_duplicated')
      this.connectionTrace('auth_key_duplicated_detected', { source })
      console.warn(
        `[userListener] AUTH_KEY_DUPLICATED (${source}) for ${this.userId}`
        + ' — marking disconnected and reconnecting',
      )
    }
    if (
      channelRowId
      && shouldEmitAuthKeyDupEvent(this.lastAuthKeyDupPollErrorAt, now, 60_000)
    ) {
      this.lastAuthKeyDupPollErrorAt = now
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'poll_error',
        channelRowId,
        detail: detail ?? { error: 'AUTH_KEY_DUPLICATED', source },
      })
    }
    // Avoid awaiting/nesting the in-flight reconnect (e.g. warmEntityCache during forceReconnect).
    if (this.reconnectInFlight || this.stopping) return
    void this.requestReconnect(`auth_key_duplicated:${source}`)
  }

  private requestReconnect(reason: string): Promise<void> {
    if (this.stopping) return Promise.resolve()
    if (this.reconnectInFlight) return this.reconnectInFlight

    const cycleId = crypto.randomUUID().slice(0, 8)
    // Enforce a minimum cooldown between reconnect cycles to prevent cascading loops.
    const cooldown = reconnectCooldownMs()
    const elapsed = Date.now() - this.lastReconnectEndedAt
    const delay = elapsed < cooldown ? cooldown - elapsed : 0

    this.reconnectInFlight = (async () => {
      this.updateHealth(reason, { force: true })
      if (delay > 0) {
        console.log(`[userListener] reconnect cooldown ${delay}ms for ${this.userId} cycle=${cycleId}`)
        await new Promise(r => setTimeout(r, delay))
      }
      await this.forceReconnect(reason, cycleId)
    })().finally(() => {
      this.lastReconnectEndedAt = Date.now()
      this.reconnectInFlight = null
    })
    // Attach a rejection handler so a failing reconnect cycle can never
    // become an unhandled rejection and kill the whole worker — the
    // original promise is still returned to awaiters unchanged.
    this.reconnectInFlight.catch(err => {
      console.error(
        `[userListener] reconnect cycle failed for ${this.userId} reason=${reason} cycle=${cycleId}:`,
        redactTelegramConnectionLog(err),
      )
    })
    return this.reconnectInFlight
  }

  private async noteMalformedRpcResult(err: unknown): Promise<void> {
    const now = Date.now()
    if (now - this.lastMalformedRpcRecoveryAt > malformedRpcResultRecoveryWindowMs()) {
      this.malformedRpcRecoveryCount = 0
    }
    this.lastMalformedRpcRecoveryAt = now
    this.malformedRpcRecoveryCount += 1
    this.connectionTrace('malformed_rpc_result_detected', {
      attempt: this.malformedRpcRecoveryCount,
      max: malformedRpcResultMaxRecoveries(),
      error: err,
    })
    if (this.malformedRpcRecoveryCount > malformedRpcResultMaxRecoveries()) {
      console.error(
        `[userListener] malformed Telegram RPC result recovery exhausted for ${this.userId}`
        + ` (${this.malformedRpcRecoveryCount}/${malformedRpcResultMaxRecoveries()})`,
      )
      captureBusinessIssue({
        category: 'telegram',
        event: 'telegram_recovery_exhausted',
        severity: 'error',
        reasonCode: 'GRAMJS_MALFORMED_RPC_RESULT',
        message: 'Malformed Telegram RPC result recovery exhausted',
        userImpact: 'failed',
        fingerprint: ['telegram_recovery_exhausted', 'malformed_rpc_result', 'exhausted'],
        context: {
          user_id: this.userId,
          stage: 'malformed_rpc_recovery',
          operation: 'telegram_rpc_recovery',
          retry_attempt: this.malformedRpcRecoveryCount,
          extra: { max_recoveries: malformedRpcResultMaxRecoveries() },
        },
      })
      this.connectionTrace('recovery_invalidated', {
        source: 'malformed_rpc_result',
        attempts: this.malformedRpcRecoveryCount,
      })
      this.updateHealth('malformed_rpc_recovery_exhausted', { force: true, recoveryExhausted: true })
      return
    }
    console.warn(
      `[userListener] malformed Telegram RPC result for ${this.userId}`
      + ` (${this.malformedRpcRecoveryCount}/${malformedRpcResultMaxRecoveries()})`
      + ' — reconnecting Telegram client',
    )
    await this.requestReconnect('malformed_rpc_result')
  }

  private scheduleDeferredRetry(cycleId: string): void {
    if (this.deferredRetryTimer) return
    const delayMs = authKeyDupDeferredRetryMs()
    console.warn(
      `[userListener] reconnect exhausted for ${this.userId} cycle=${cycleId}`
      + ` — deferred retry in ${delayMs}ms`,
    )
    this.deferredRetryTimer = setTimeout(() => {
      this.deferredRetryTimer = null
      if (this.isConnected || this.stopping) return
      void this.requestReconnect('deferred_retry')
    }, delayMs)
    this.deferredRetryTimer.unref?.()
  }

  private async forceReconnect(reason = 'force', cycleId = 'none') {
    console.log(`[userListener] force reconnect for ${this.userId} reason=${reason} cycle=${cycleId}`)
    this.clearDialogsCache()
    this.lastReconnectAt = Date.now()
    this.consecutiveProbeFailures = 0
    this.isConnected = false
    this.updateHealth(reason, { force: true })
    this.connectionTrace('disconnect_start', { source: reason, cycleId })
    const oldClient = this.client
    let sessionSnapshot = this.lastSavedSession
    try {
      const saved = (oldClient.session.save() as unknown) as string
      if (saved) sessionSnapshot = saved
    } catch { /* keep last known persisted session */ }
    if (reason === 'malformed_rpc_result' && this.canRecreateClient) {
      this.removeCurrentHandler(oldClient)
    }
    try { await oldClient.disconnect() } catch { /* ignore */ }
    this.connectionTrace('disconnect_complete', { source: reason, cycleId })
    if (this.stopping) return
    if (reason === 'malformed_rpc_result' && this.canRecreateClient) {
      this.connectionTrace('client_recreate_start', { source: reason, cycleId })
      this.client = this.clientFactory(sessionSnapshot)
      this.lastSavedSession = sessionSnapshot
      this.attachClientErrorHandler()
      this.connectionTrace('client_recreate_complete', { source: reason, cycleId })
    }

    const delays = authKeyDupReconnectDelaysMs(
      reconnectCooldownMs(),
      authKeyDupReconnectDelayMs(),
      authKeyDupMaxRecoveryAttempts(),
    )
    let lastErr: unknown
    for (let attempt = 0; attempt < delays.length; attempt++) {
      await new Promise(r => setTimeout(r, delays[attempt]))
      if (this.stopping) return
      try {
        this.clientGeneration += 1
        this.connectionTrace('connect_start', { source: reason, cycleId, attempt: attempt + 1 })
        await withTelegramTimeout(
          this.client.connect(),
          telegramConnectTimeoutMs(),
          `telegram connect ${this.userId}`,
        )
        if (this.stopping) { try { await this.client.disconnect() } catch { /* ignore */ } return }
        this.connectionTrace('probe_start', { source: reason, cycleId, attempt: attempt + 1 })
        await withTelegramTimeout(
          tgInvoke(this.client, new Api.updates.GetState()),
          telegramConnectTimeoutMs(),
          `telegram probe ${this.userId}`,
        )
        if (this.stopping) { try { await this.client.disconnect() } catch { /* ignore */ } return }
        this.isConnected = true
        this.resetTelegramBackoffState()
        this.lastSuccessfulPollAt = Date.now()
        if (reason === 'malformed_rpc_result') {
          this.malformedRpcRecoveryCount = 0
          this.lastMalformedRpcRecoveryAt = 0
        }
        this.updateHealth('reconnect_success', { force: true })
        lastErr = undefined
        this.connectionTrace('recovery_complete', { source: reason, cycleId, attempt: attempt + 1 })
        break
      } catch (err) {
        lastErr = err
        console.error(
          `[userListener] reconnect attempt ${attempt + 1}/${delays.length} failed for ${this.userId}: cycle=${cycleId}`,
          redactTelegramConnectionLog(err),
        )
        if (isAuthKeyUnregistered(err)) return
        if (!isAuthKeyDuplicated(err)) {
          // Transient network errors / connect timeouts: keep trying remaining
          // delays. Disconnect first so a connect() that timed out but later
          // completes in the background cannot double-connect on the next
          // attempt (AUTH_KEY_DUPLICATED risk).
          this.connectionTrace('disconnect_start', { source: `${reason}:retry_${attempt + 1}`, cycleId })
          try {
            await withTelegramTimeout(
              this.client.disconnect(),
              telegramConnectTimeoutMs(),
              `telegram disconnect ${this.userId}`,
            )
          } catch { /* ignore */ }
          this.connectionTrace('disconnect_complete', { source: `${reason}:retry_${attempt + 1}`, cycleId })
          continue
        }
        incMetric('auth_key_duplicated')
        this.connectionTrace('auth_key_duplicated_retry', { source: reason, cycleId, attempt: attempt + 1 })
        console.warn(
          `[userListener] AUTH_KEY_DUPLICATED reconnect attempt ${attempt + 1}/${delays.length}`
          + ` for ${this.userId} cycle=${cycleId}`,
        )
        this.connectionTrace('disconnect_start', { source: `${reason}:retry_${attempt + 1}`, cycleId })
        try {
          await withTelegramTimeout(
            this.client.disconnect(),
            telegramConnectTimeoutMs(),
            `telegram disconnect ${this.userId}`,
          )
        } catch { /* ignore */ }
        this.connectionTrace('disconnect_complete', { source: `${reason}:retry_${attempt + 1}`, cycleId })
      }
    }

    if (!this.isConnected) {
      const malformedRpcReconnect = reason === 'malformed_rpc_result'
      console.error(
        `[userListener] reconnect failed for ${this.userId} cycle=${cycleId}:`,
        redactTelegramConnectionLog(lastErr ?? 'unknown'),
      )
      if (!malformedRpcReconnect) {
        captureBusinessIssue({
          category: 'telegram',
          event: 'telegram_listener_failed',
          severity: 'error',
          reasonCode: 'TELEGRAM_RECONNECT_EXHAUSTED',
          message: 'Telegram reconnect attempts exhausted and listener deferred retry',
          userImpact: 'delayed',
          fingerprint: ['telegram_listener_failed', 'reconnect', 'TELEGRAM_RECONNECT_EXHAUSTED', reason],
          context: {
            user_id: this.userId,
            stage: 'reconnect',
            operation: 'telegram_reconnect',
            extra: { reason, cycle_id: cycleId, attempts: delays.length },
          },
        })
      }
      this.connectionTrace('recovery_invalidated', { source: reason, cycleId, attempts: delays.length })
      this.updateHealth('reconnect_exhausted', { force: true })
      if (!malformedRpcReconnect) {
        maybeCaptureCopierOffline({
          userId: this.userId,
          listenerStatus: 'failed',
          reasonCode: 'TELEGRAM_RECONNECT_EXHAUSTED',
          reason,
          sinceMs: this.lastReconnectAt || null,
        })
      }
      this.scheduleDeferredRetry(cycleId)
      return
    }

    // Rebind handler — the previous one was attached to the disconnected
    // session and may not survive the reconnect cleanly.
    this.removeCurrentHandler()
    this.monitoredChannels.clear()
    // Warm entity cache BEFORE registering the handler so gramjs can
    // deliver NewMessage events for all monitored channels.
    try {
      await this.warmEntityCache()
    } catch (err) {
      if (isAuthKeyUnregistered(err) || isAuthKeyDuplicated(err)) {
        // Session died again between connect() and warmup (e.g. the auth key
        // is invalidated/duplicated by a peer replica). Never let this escape
        // forceReconnect — treat it like the exhausted-recovery path instead
        // of crashing the whole worker with an unhandled rejection.
        console.error(
          `[userListener] session invalid during reconnect warmup for ${this.userId} cycle=${cycleId}:`,
          redactTelegramConnectionLog(err),
        )
        this.isConnected = false
        this.connectionTrace('recovery_invalidated', { source: reason, cycleId, stage: 'warmup' })
        this.scheduleDeferredRetry(cycleId)
        return
      }
      throw err
    }
    if (!this.isConnected || this.stopping) {
      return
    }
    await this.refreshChannelSubscription()
    // Run a lightweight catch-up for very recent messages (last 60s) that
    // may have arrived during the reconnect window. Full history replay is
    // NOT done here to avoid stale trade execution.
    void this.runRecentCatchUp().catch(err =>
      console.error(`[userListener] recent catch-up after reconnect failed for ${this.userId}:`, err)
    )
    await this.runReplyChainSweep()
  }

  // ── safety poll (Realtime drop fallback) ──────────────────────────────

  private startSafetyPoll() {
    if (this.safetyPollTimer) return
    this.safetyPollTimer = setInterval(() => {
      if (!this.isConnected) return
      this.refreshChannelSubscription().catch(err =>
        console.error(`[userListener] safety poll error for ${this.userId}:`, err),
      )
      this.warmAllMonitoredChannelEntities().catch(err =>
        console.error(`[userListener] entity warm (poll tick) error for ${this.userId}:`, err),
      )
      this.pollMonitoredChannelsForMessages().catch(err =>
        console.error(`[userListener] channel poll error for ${this.userId}:`, err),
      )
    }, SAFETY_POLL_INTERVAL_MS)
    this.safetyPollTimer.unref?.()
  }

  // ── fast poll (channels with no live push from Telegram) ──────────────

  private startFastPoll() {
    if (this.fastPollTimer) return
    this.fastPollTimer = setInterval(() => {
      this.runFastPoll().catch(err =>
        console.error(`[userListener] fast poll error for ${this.userId}:`, err),
      )
    }, FAST_POLL_INTERVAL_MS)
    this.fastPollTimer.unref?.()
    console.log(
      `[userListener] fast poll started user=${this.userId}`
      + ` intervalMs=${FAST_POLL_INTERVAL_MS} liveStaleMs=${FAST_POLL_LIVE_STALE_MS}`,
    )
  }

  /**
   * Poll only the channels Telegram is not delivering live NewMessage updates
   * for (last_live_at null or stale). Channels with healthy live push are left
   * to the event handler + 10s safety poll. The channel list is cached and
   * refreshed every SAFETY_POLL_INTERVAL_MS to keep DB load flat.
   *
   * Volume is bounded two ways (incident 2026-08-24): at most FAST_POLL_BATCH
   * channels per tick, least-recently-polled first; and each channel is paced
   * by its quiet streak — quiet channels are re-fetched at doubling intervals
   * up to FAST_POLL_MAX_CHANNEL_INTERVAL_MS, active channels stay at base.
   */
  private async runFastPoll(): Promise<void> {
    if (!this.isConnected || this.fastPollInFlight) return
    if (Date.now() < this.pollBackoffUntil) return
    this.fastPollInFlight = true
    try {
      const now = Date.now()
      if (now - this.fastPollRowsAt > SAFETY_POLL_INTERVAL_MS) {
        const { data } = await this.supabase
          .from('telegram_channels')
          .select('id, channel_id, channel_username, signal_channel_id, last_seen_message_id, last_seen_at, last_live_at')
          .eq('user_id', this.userId)
          .eq('is_active', true)
        this.fastPollRows = ((data ?? []) as ChannelRow[]).filter(row => !this.isChannelLocallyDisabled(row))
        this.fastPollRowsAt = now
      }

      const floodAtCycleStart = this.floodErrorsThisCycle
      const dueRows = this.fastPollRows.filter(row => {
        if (this.isChannelLocallyDisabled(row)) return false
        const liveDb = row.last_live_at ? new Date(row.last_live_at).getTime() : 0
        const liveMem = this.lastLiveByRow.get(row.id) ?? 0
        const lastLive = Math.max(liveDb, liveMem)
        const isStale = lastLive <= 0 || now - lastLive >= FAST_POLL_LIVE_STALE_MS
        if (!isStale) return false
        // Per-channel pacing: skip channels fetched recently enough for their
        // current quiet-streak (incident 2026-08-24 flood-wait pressure).
        const lastAttempt = this.fastPollAttemptByRow.get(row.id) ?? 0
        return now - lastAttempt >= fastPollChannelIntervalMs(this.fastPollCleanStreakByRow.get(row.id) ?? 0)
      })
      // Least-recently-polled first so the batch cap cannot starve channels.
      dueRows.sort((a, b) =>
        (this.fastPollAttemptByRow.get(a.id) ?? 0) - (this.fastPollAttemptByRow.get(b.id) ?? 0))
      const batch = dueRows.slice(0, FAST_POLL_BATCH)
      await this.mapWithConcurrency(batch, CHANNEL_POLL_CONCURRENCY, async row => {
        this.fastPollAttemptByRow.set(row.id, Date.now())
        const outcome = await this.pollChannelNewMessages(row)
          .catch((err): FastPollOutcome => {
            console.warn(`[userListener] fast poll failed channel=${row.id}:`, err)
            return 'failed'
          })
        this.fastPollCleanStreakByRow.set(
          row.id,
          nextFastPollCleanStreak(this.fastPollCleanStreakByRow.get(row.id) ?? 0, outcome),
        )
      })
      this.endPollCycle(floodAtCycleStart)
    } finally {
      this.fastPollInFlight = false
    }
  }

  // ── heartbeat ─────────────────────────────────────────────────────────

  private startHeartbeat() {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      const uptime = Date.now() - this.startedAt
      const lastEventAge = Date.now() - this.lastEventAt
      this.connectionTrace('listener_healthy', {
        uptimeMs: uptime,
        connected: this.isConnected,
        lastEventAgeMs: lastEventAge,
      })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  // ── entity cache warmup ────────────────────────────────────────────────

  private startEntityWarmup() {
    if (this.entityWarmupTimer) return
    this.entityWarmupTimer = setInterval(() => {
      this.warmEntityCache().catch(err =>
        console.error(`[userListener] entity warmup error for ${this.userId}:`, err)
      )
    }, ENTITY_WARMUP_INTERVAL_MS)
    this.entityWarmupTimer.unref?.()
  }

  private async warmEntityCache(): Promise<void> {
    if (!this.isConnected) return
    if (Date.now() < this.pollBackoffUntil) return
    try {
      const dialogs = await this.client.getDialogs({ limit: DIALOG_MAX_SCAN })
      const channelCount = dialogs.filter(
        (d: { isChannel?: boolean; isGroup?: boolean }) => d.isChannel || d.isGroup,
      ).length
      console.log(
        `[userListener] entity cache warmed user=${this.userId} dialogs=${dialogs.length} channels=${channelCount}`,
      )
      incMetric('entity_cache_warmed')
      await this.warmAllMonitoredChannelEntities()
    } catch (err: unknown) {
      if (isAuthKeyDuplicated(err)) {
        this.noteAuthKeyDuplicated('warm_entity_cache')
        return
      }
      if (isAuthKeyUnregistered(err)) rethrowIfSessionInvalid(err)
      console.warn(
        `[userListener] entity warmup getDialogs failed for ${this.userId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── session string rotation ───────────────────────────────────────────

  private startSessionPersist() {
    if (this.sessionPersistTimer) return
    this.sessionPersistTimer = setInterval(() => {
      this.persistSessionIfChanged().catch(err =>
        console.error(`[userListener] session persist error for ${this.userId}:`, err)
      )
    }, SESSION_PERSIST_INTERVAL_MS)
    this.sessionPersistTimer.unref?.()
  }

  /**
   * gramjs occasionally rotates auth_key state inside the session. If we
   * crash without persisting the new state, the next start re-handshakes
   * from a stale snapshot which can look suspicious to Telegram. Persist
   * on a 30-min cadence and on graceful shutdown.
   */
  private async persistSessionIfChanged() {
    let current: string
    try {
      current = (this.client.session.save() as unknown) as string
    } catch {
      return
    }
    if (!current || current === this.lastSavedSession) return

    const { error } = await this.supabase
      .from('telegram_sessions')
      .update({ session_string: current })
      .eq('user_id', this.userId)

    if (error) {
      console.error(`[userListener] session_string update failed for ${this.userId}:`, error.message)
      return
    }
    this.lastSavedSession = current
  }
}
