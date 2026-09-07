import type { TradeNotificationsTranslations } from '../i18n/tradeNotifications/types'
import { interpolate } from '../i18n/interpolate'
import {
  resolveInstrumentSymbol,
  type ChannelWorkerLogRow,
} from './channelWorkerLogMessage'

export type TradeNotificationHeadline =
  | 'execution_completed'
  | 'modification_completed'
  | 'layering_completed'
  | 'trades_closed'
  | 'review_required'
  | 'manual_override_reverted'

export type TradeExecutionLogRow = ChannelWorkerLogRow & {
  id: string
  created_at: string
  signal_id?: string | null
  broker_account_id?: string | null
}

export interface TradeNotificationEvent {
  id: string
  headline: TradeNotificationHeadline
  signalId: string | null
  brokerAccountId: string | null
  channelId: string | null
  symbol: string | null
  createdAt: string
  count: number
  side: 'buy' | 'sell' | null
  oldSl: number | null
  newSl: number | null
  newTp: number | null
  newTpLevels: number[]
  closeReason: string | null
  actionUrl: string | null
  actionLabel: string | null
}

export interface TradeNotification {
  id: string
  headline: TradeNotificationHeadline
  title: string
  body: string
  symbol: string | null
  createdAt: string
  actionUrl?: string | null
  actionLabel?: string | null
}

export interface TradeNotificationContext {
  channelDisplayNames: Record<string, string>
  brokerLabels: Record<string, string>
}

const EXECUTION_ACTIONS = new Set(['order_send', 'signal_entry_pending_filled'])
const LAYERING_ACTIONS = new Set(['virtual_pending_fired'])
const MODIFY_SUMMARY_ACTIONS = new Set(['merge_modify_summary'])
const SIGNAL_MODIFY_ACTIONS = new Set([
  'mgmt_modify',
  'mgmt_breakeven',
  'mgmt_partial_breakeven',
  'merge_routed_modify_only',
  'signal_merge_into_open_trade',
  'basket_leg_modify',
])
/** Automated monitors — logged for copier history but too noisy for the bell. */
const AUTOMATED_MODIFY_ACTIONS = new Set(['trailing_stop', 'auto_be'])
const MODIFY_LEG_ACTIONS = new Set([...SIGNAL_MODIFY_ACTIONS, ...AUTOMATED_MODIFY_ACTIONS])
const MANUAL_OVERRIDE_ACTIONS = new Set(['broker_manual_stop_override_reverted'])
const CLOSED_ACTIONS = new Set([
  'mgmt_close',
  'mgmt_close_worse_entries',
  'cwe_close',
  'opposite_signal_close',
  'partial_tp_fired',
])

const SUPPRESSED_ACTIONS = new Set([
  'virtual_pending_inserted',
  'pipeline_parse_dispatch',
  'pipeline_parse',
  'dispatch_received',
  'range_basket_tp_rebalance',
])

const MODIFY_BATCH_MS = 5000
const SUMMARY_SUPPRESS_MS = 60_000

function isSuccessStatus(status: string): boolean {
  return status.toLowerCase() === 'success'
}

function pairKey(signalId: string | null | undefined, brokerId: string | null | undefined): string {
  return `${signalId ?? ''}|${brokerId ?? ''}`
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function formatPrice(v: number | null): string {
  if (v == null) return ''
  return Number.isInteger(v) ? String(v) : String(v)
}

export function extractSide(row: TradeExecutionLogRow): 'buy' | 'sell' | null {
  const payload = row.request_payload ?? {}
  const op = payload.operation
  if (typeof op === 'string') {
    const v = op.toLowerCase()
    if (v.includes('sell') || v === '1') return 'sell'
    if (v.includes('buy') || v === '0') return 'buy'
  }
  const parsed = row.signals?.parsed_data
  if (parsed && typeof parsed === 'object') {
    const action = String((parsed as Record<string, unknown>).action ?? '').toLowerCase()
    if (action.includes('sell')) return 'sell'
    if (action.includes('buy')) return 'buy'
  }
  const direction = payload.direction
  if (typeof direction === 'string') {
    const v = direction.toLowerCase()
    if (v.includes('sell')) return 'sell'
    if (v.includes('buy')) return 'buy'
  }
  return null
}

function parsedTpLevels(parsed: Record<string, unknown> | null | undefined): number[] {
  if (!parsed || !Array.isArray(parsed.tp)) return []
  return (parsed.tp as unknown[])
    .map(v => num(v))
    .filter((v): v is number => v != null && v > 0)
}

function extractSlValues(row: TradeExecutionLogRow): { oldSl: number | null; newSl: number | null } {
  const payload = row.request_payload ?? {}
  const parsed = row.signals?.parsed_data as Record<string, unknown> | null | undefined
  const oldSl = num(payload.old_sl)
  const newSl =
    num(payload.new_sl) ??
    num(payload.target_sl) ??
    num(payload.sl) ??
    (parsed ? num(parsed.sl) : null)
  return { oldSl, newSl }
}

function extractTpValues(row: TradeExecutionLogRow): { newTp: number | null; newTpLevels: number[] } {
  const payload = row.request_payload ?? {}
  const parsed = row.signals?.parsed_data as Record<string, unknown> | null | undefined
  const parsedLevels = parsedTpLevels(parsed)
  const targetTp = num(payload.target_tp)
  const singleTp = num(payload.new_tp) ?? num(payload.takeprofit)
  let levels = parsedLevels
  if (!levels.length && targetTp != null && targetTp > 0) levels = [targetTp]
  if (!levels.length && singleTp != null && singleTp > 0) levels = [singleTp]
  if (!levels.length && Array.isArray(payload.tp)) {
    levels = (payload.tp as unknown[])
      .map(v => num(v))
      .filter((v): v is number => v != null && v > 0)
  }
  return {
    newTp: levels[0] ?? targetTp ?? singleTp,
    newTpLevels: levels,
  }
}

function mergeTpLevels(existing: number[], incoming: number[]): number[] {
  if (incoming.length > 0) return incoming
  return existing
}

function resolveChannelId(row: TradeExecutionLogRow): string | null {
  const payload = row.request_payload ?? {}
  if (typeof payload.channel_id === 'string' && payload.channel_id) return payload.channel_id
  return row.signals?.channel_id ?? null
}

function classifyRow(row: TradeExecutionLogRow): TradeNotificationHeadline | null {
  if (!isSuccessStatus(row.status)) return null
  const action = row.action.toLowerCase()
  if (SUPPRESSED_ACTIONS.has(action)) return null
  if (AUTOMATED_MODIFY_ACTIONS.has(action)) return null
  if (['attempt', 'failed', 'skipped'].includes(row.status.toLowerCase())) return null
  if (MANUAL_OVERRIDE_ACTIONS.has(action)) return 'manual_override_reverted'
  if (EXECUTION_ACTIONS.has(action)) return 'execution_completed'
  if (LAYERING_ACTIONS.has(action)) return 'layering_completed'
  if (MODIFY_SUMMARY_ACTIONS.has(action) || SIGNAL_MODIFY_ACTIONS.has(action)) return 'modification_completed'
  if (CLOSED_ACTIONS.has(action)) return 'trades_closed'
  if (action.startsWith('pipeline_') || action.startsWith('dispatch_')) return null
  return null
}

function shouldSuppressModifyLeg(
  row: TradeExecutionLogRow,
  summaryTimes: Map<string, number>,
): boolean {
  const action = row.action.toLowerCase()
  if (!MODIFY_LEG_ACTIONS.has(action)) return false
  const key = pairKey(row.signal_id, row.broker_account_id)
  const summaryMs = summaryTimes.get(key)
  if (summaryMs == null) return false
  const rowMs = Date.parse(row.created_at)
  return Number.isFinite(rowMs) && Math.abs(rowMs - summaryMs) <= SUMMARY_SUPPRESS_MS
}

function mergeEvent(existing: TradeNotificationEvent, row: TradeExecutionLogRow): TradeNotificationEvent {
  const rowMs = Date.parse(row.created_at)
  const existingMs = Date.parse(existing.createdAt)
  const useRow = Number.isFinite(rowMs) && (!Number.isFinite(existingMs) || rowMs >= existingMs)
  const { oldSl, newSl } = extractSlValues(row)
  const { newTp, newTpLevels } = extractTpValues(row)
  const side = extractSide(row) ?? existing.side
  const mergedTpLevels = mergeTpLevels(existing.newTpLevels, newTpLevels)
  return {
    ...existing,
    id: useRow ? row.id : existing.id,
    createdAt: useRow ? row.created_at : existing.createdAt,
    count: existing.count + 1,
    symbol: existing.symbol ?? resolveInstrumentSymbol(row),
    channelId: existing.channelId ?? resolveChannelId(row),
    side: side ?? existing.side,
    oldSl: oldSl ?? existing.oldSl,
    newSl: newSl ?? existing.newSl,
    newTp: newTp ?? existing.newTp ?? mergedTpLevels[0] ?? null,
    newTpLevels: mergedTpLevels,
  }
}

function createEvent(row: TradeExecutionLogRow, headline: TradeNotificationHeadline, count = 1): TradeNotificationEvent {
  const { oldSl, newSl } = extractSlValues(row)
  const { newTp, newTpLevels } = extractTpValues(row)
  const payload = row.request_payload ?? {}
  let closeReason: string | null = null
  if (row.action.toLowerCase() === 'partial_tp_fired') {
    const tpIdx = num(payload.tp_idx)
    closeReason = tpIdx != null ? `TP${tpIdx}` : null
  }
  const summaryModified = num(payload.modified)
  return {
    id: row.id,
    headline,
    signalId: row.signal_id ?? null,
    brokerAccountId: row.broker_account_id ?? null,
    channelId: resolveChannelId(row),
    symbol: resolveInstrumentSymbol(row),
    createdAt: row.created_at,
    count: headline === 'modification_completed' && summaryModified != null ? summaryModified : count,
    side: extractSide(row),
    oldSl,
    newSl,
    newTp,
    newTpLevels,
    closeReason,
    actionUrl: typeof payload.manage_signal_url === 'string' ? payload.manage_signal_url : null,
    actionLabel: typeof payload.cta_label === 'string' ? payload.cta_label : null,
  }
}

export function aggregateTradeNotificationEvents(
  rows: TradeExecutionLogRow[],
): TradeNotificationEvent[] {
  const sorted = [...rows].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  )

  const summaryTimes = new Map<string, number>()
  for (const row of sorted) {
    if (row.action.toLowerCase() === 'merge_modify_summary' && isSuccessStatus(row.status)) {
      summaryTimes.set(pairKey(row.signal_id, row.broker_account_id), Date.parse(row.created_at))
    }
  }

  const events: TradeNotificationEvent[] = []
  const execBuckets = new Map<string, TradeNotificationEvent>()
  const layerBuckets = new Map<string, TradeNotificationEvent>()
  const modBuckets = new Map<string, TradeNotificationEvent>()
  const closeBuckets = new Map<string, TradeNotificationEvent>()
  const manualOverrideBuckets = new Map<string, TradeNotificationEvent>()

  for (const row of sorted) {
    const headline = classifyRow(row)
    if (!headline) continue

    const action = row.action.toLowerCase()

    if (shouldSuppressModifyLeg(row, summaryTimes)) continue

    if (headline === 'execution_completed') {
      const key = pairKey(row.signal_id, row.broker_account_id)
      const existing = execBuckets.get(key)
      if (existing) {
        execBuckets.set(key, mergeEvent(existing, row))
      } else {
        execBuckets.set(key, createEvent(row, headline))
      }
      continue
    }

    if (headline === 'layering_completed') {
      const key = pairKey(row.signal_id, row.broker_account_id)
      const existing = layerBuckets.get(key)
      if (existing) {
        layerBuckets.set(key, mergeEvent(existing, row))
      } else {
        layerBuckets.set(key, createEvent(row, headline))
      }
      continue
    }

    if (headline === 'modification_completed') {
      if (MODIFY_SUMMARY_ACTIONS.has(action)) {
        events.push(createEvent(row, headline))
        continue
      }
      const pair = pairKey(row.signal_id, row.broker_account_id)
      const rowMs = Date.parse(row.created_at)
      let bucketKey: string | null = null
      for (const [key, bucket] of modBuckets) {
        if (!key.startsWith(`${pair}:`)) continue
        const bucketMs = Date.parse(bucket.createdAt)
        if (Number.isFinite(rowMs) && Number.isFinite(bucketMs) && rowMs - bucketMs <= MODIFY_BATCH_MS) {
          bucketKey = key
          break
        }
      }
      if (bucketKey) {
        modBuckets.set(bucketKey, mergeEvent(modBuckets.get(bucketKey)!, row))
      } else {
        modBuckets.set(`${pair}:${row.id}`, createEvent(row, headline))
      }
      continue
    }

    if (headline === 'manual_override_reverted') {
      const payload = row.request_payload ?? {}
      const anchor = typeof payload.anchor_signal_id === 'string' ? payload.anchor_signal_id : row.signal_id
      const key = `${pairKey(anchor, row.broker_account_id)}:${String(payload.symbol ?? '').trim().toUpperCase()}`
      if (!manualOverrideBuckets.has(key)) manualOverrideBuckets.set(key, createEvent(row, headline))
      continue
    }

    if (headline === 'trades_closed') {
      const pair = pairKey(row.signal_id, row.broker_account_id)
      const tpIdx = action === 'partial_tp_fired' ? num(row.request_payload?.tp_idx) : null
      const reasonKey = tpIdx != null ? `:tp${tpIdx}` : ':gen'
      const key = `${pair}${reasonKey}`
      const existing = closeBuckets.get(key)
      if (existing) {
        closeBuckets.set(key, mergeEvent(existing, row))
      } else {
        closeBuckets.set(key, createEvent(row, headline))
      }
    }
  }

  events.push(...manualOverrideBuckets.values(), ...execBuckets.values(), ...layerBuckets.values(), ...modBuckets.values(), ...closeBuckets.values())
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function resolveBrokerLabel(
  brokerAccountId: string | null,
  ctx: TradeNotificationContext,
  t: TradeNotificationsTranslations,
): string {
  if (brokerAccountId && ctx.brokerLabels[brokerAccountId]?.trim()) {
    return ctx.brokerLabels[brokerAccountId].trim()
  }
  return t.fallbacks.broker
}

function resolveChannelLabel(
  channelId: string | null,
  ctx: TradeNotificationContext,
  t: TradeNotificationsTranslations,
): string {
  if (channelId && ctx.channelDisplayNames[channelId]?.trim()) {
    return ctx.channelDisplayNames[channelId].trim()
  }
  return t.fallbacks.channel
}

function resolveSideLabel(
  side: 'buy' | 'sell' | null,
  t: TradeNotificationsTranslations,
): string {
  if (side === 'buy') return t.sides.buy
  if (side === 'sell') return t.sides.sell
  return t.sides.trade
}

export function formatHolisticNotification(
  event: TradeNotificationEvent,
  t: TradeNotificationsTranslations,
  ctx: TradeNotificationContext,
): TradeNotification {
  const broker = resolveBrokerLabel(event.brokerAccountId, ctx, t)
  const channel = resolveChannelLabel(event.channelId, ctx, t)
  const side = resolveSideLabel(event.side, t)
  const count = event.count

  let title: string
  let body: string

  switch (event.headline) {
    case 'execution_completed':
      title = t.headlines.executionCompleted
      body =
        count > 1
          ? interpolate(t.bodies.executionBatch, { count, side, broker, channel })
          : interpolate(t.bodies.executionSingle, { side, broker, channel })
      break
    case 'modification_completed': {
      title = t.headlines.modificationCompleted
      const hasSl = event.newSl != null
      const tpLevels = event.newTpLevels.length
        ? event.newTpLevels
        : event.newTp != null
          ? [event.newTp]
          : []
      const hasTp = tpLevels.length > 0
      const tpList = tpLevels.map(formatPrice).join(', ')
      if (hasSl && hasTp) {
        body = interpolate(t.bodies.slAndTpsModifiedTo, {
          newSl: formatPrice(event.newSl),
          tpList,
          side,
          broker,
          channel,
        })
      } else if (event.oldSl != null && hasSl) {
        body = interpolate(t.bodies.slModifiedFromTo, {
          oldSl: formatPrice(event.oldSl),
          newSl: formatPrice(event.newSl),
          side,
          broker,
          channel,
        })
      } else if (hasSl) {
        body = interpolate(t.bodies.slModifiedTo, {
          newSl: formatPrice(event.newSl),
          side,
          broker,
          channel,
        })
      } else if (hasTp && tpLevels.length > 1) {
        body = interpolate(t.bodies.tpsModifiedTo, { tpList, side, broker, channel })
      } else if (hasTp) {
        body = interpolate(t.bodies.tpModifiedTo, {
          newTp: formatPrice(tpLevels[0]!),
          side,
          broker,
          channel,
        })
      } else if (count > 1) {
        body = interpolate(t.bodies.modificationBatch, { count, broker, channel })
      } else {
        body = interpolate(t.bodies.modificationBatch, { count: Math.max(1, count), broker, channel })
      }
      break
    }
    case 'layering_completed':
      title = t.headlines.layeringCompleted
      body =
        count > 1
          ? interpolate(t.bodies.layeringBatch, { count, broker, channel })
          : interpolate(t.bodies.layeringSingle, { broker, channel })
      break
    case 'trades_closed':
      title = t.headlines.tradesClosed
      if (event.closeReason) {
        body = interpolate(t.bodies.tradesClosedTp, {
          count,
          broker,
          channel,
          reason: event.closeReason,
        })
      } else if (count > 1) {
        body = interpolate(t.bodies.tradesClosedGeneric, { count, broker, channel })
      } else {
        body = interpolate(t.bodies.tradesClosedSingle, { broker, channel })
      }
      break
    case 'manual_override_reverted':
      title = t.headlines.manualOverrideReverted
      body = t.bodies.manualOverrideReverted
      break
    case 'review_required':
      // Review items are built directly via reviewNotificationFromSignal; this
      // branch exists only so the log-driven formatter stays exhaustive.
      title = t.headlines.reviewRequired
      body = interpolate(t.bodies.reviewRequired, { channel })
      break
  }

  return {
    id: `${event.headline}:${event.id}`,
    headline: event.headline,
    title,
    body,
    symbol: event.symbol,
    createdAt: event.createdAt,
    actionUrl: event.actionUrl,
    actionLabel: event.actionLabel ?? (event.actionUrl ? t.actions.manageSignal : null),
  }
}

/** Success log actions that can produce a bell notification (excludes monitor noise). */
export const TRADE_NOTIFICATION_LOG_ACTIONS = [
  ...EXECUTION_ACTIONS,
  ...LAYERING_ACTIONS,
  ...MODIFY_SUMMARY_ACTIONS,
  ...SIGNAL_MODIFY_ACTIONS,
  ...MANUAL_OVERRIDE_ACTIONS,
  ...CLOSED_ACTIONS,
] as const

export function tradeNotificationsFromLogs(
  rows: TradeExecutionLogRow[],
  t: TradeNotificationsTranslations,
  ctx: TradeNotificationContext,
): TradeNotification[] {
  return aggregateTradeNotificationEvents(rows).map(event =>
    formatHolisticNotification(event, t, ctx),
  )
}

/** Minimal shape of a signals row used to build a review-required notification. */
export type ReviewRequiredSignal = {
  id: string
  created_at: string
  channel_id?: string | null
  parsed_data?: Record<string, unknown> | null
  status?: string | null
  skip_reason?: string | null
}

/** Builds a bell notification for a signal that the AI escalated to the user. */
export function reviewNotificationFromSignal(
  signal: ReviewRequiredSignal,
  t: TradeNotificationsTranslations,
  ctx: TradeNotificationContext,
): TradeNotification {
  const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>
  const symbol = String(parsed.symbol ?? '').trim() || null
  return {
    id: `review_required:${signal.id}`,
    headline: 'review_required',
    title: t.headlines.reviewRequired,
    body: interpolate(t.bodies.reviewRequired, {
      channel: resolveChannelLabel(signal.channel_id ?? null, ctx, t),
    }),
    symbol,
    createdAt: signal.created_at,
    actionUrl: '/account-trades',
    actionLabel: null,
  }
}

export const REVIEW_REQUIRED_SIGNAL_SELECT = `
  id,
  created_at,
  channel_id,
  parsed_data,
  status,
  skip_reason
`

const LAST_READ_KEY_PREFIX = 'tsc_notifications_last_read_at:'

export function readNotificationsLastReadAt(userId: string): string | null {
  try {
    return localStorage.getItem(`${LAST_READ_KEY_PREFIX}${userId}`)
  } catch {
    return null
  }
}

export function writeNotificationsLastReadAt(userId: string, iso: string): void {
  try {
    localStorage.setItem(`${LAST_READ_KEY_PREFIX}${userId}`, iso)
  } catch {
    // ignore quota / private mode
  }
}

export function countUnreadNotifications(
  items: TradeNotification[],
  lastReadAt: string | null,
): number {
  if (!lastReadAt) return items.length
  const readMs = Date.parse(lastReadAt)
  if (!Number.isFinite(readMs)) return items.length
  return items.filter(n => Date.parse(n.createdAt) > readMs).length
}

export const TRADE_EXECUTION_LOG_NOTIFICATION_SELECT = `
  id,
  created_at,
  action,
  status,
  request_payload,
  response_payload,
  error_message,
  signal_id,
  broker_account_id,
  signals ( channel_id, parsed_data, raw_message, status, skip_reason )
`
