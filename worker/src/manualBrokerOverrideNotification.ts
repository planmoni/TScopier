import type { SupabaseClient } from '@supabase/supabase-js'
import { expandPerLegTargetsToCount } from './manualPlanning/tpBucketDistribution'
import type { PerLegStopTarget } from './multiTradeMerge'
import type { BasketOpenLeg, BasketReconcileJobRow } from './basketSlTpReconcile'
import { readBrokerOrderStopLoss, readBrokerOrderTakeProfit } from './signalEntryPendingHelpers'

export const MANUAL_BROKER_OVERRIDE_REVERTED_ACTION = 'broker_manual_stop_override_reverted'
const DEFAULT_DEDUPE_MS = 15 * 60_000

export type ManualBrokerStopOverride = {
  tradeId: string
  ticket: number
  brokerSl: number | null
  targetSl: number | null
  brokerTp: number | null
  targetTp: number | null
  changedSides: Array<'sl' | 'tp'>
}

function approxEq(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= 1e-6
}

function positive(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}function legDbMatchesTarget(
  leg: BasketOpenLeg,
  target: PerLegStopTarget,
  nImmCwe: number,
  index: number,
  effectiveStoploss?: number,
  tpFrozen?: boolean,
): boolean {
  const targetSl = positive(effectiveStoploss) ?? positive(target.stoploss)
  const targetTp = index < nImmCwe ? null : positive(target.takeprofit)
  const legSl = positive(leg.sl)
  const legTp = positive(leg.tp)

  if (targetSl != null ? !approxEq(legSl, targetSl) : legSl != null) return false
  if (tpFrozen === true) return true
  if (targetTp != null ? !approxEq(legTp, targetTp) : legTp != null) return false
  return true
}

function basketDbMatchesTargets(args: {
  familyTrades: BasketOpenLeg[]
  perLegTargets: PerLegStopTarget[]
  nImmCwe: number
  effectiveStoploss?: number
  tpFrozen?: boolean
}): boolean {
  const expanded = expandPerLegTargetsToCount({
    targets: args.perLegTargets,
    openLegCount: args.familyTrades.length,
    finalTps: args.perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: null,
  }) as PerLegStopTarget[]

  return args.familyTrades.every((leg, index) => {
    const target = expanded[index]
    return Boolean(target && legDbMatchesTarget(
      leg,
      target,
      args.nImmCwe,
      index,
      args.effectiveStoploss,
      args.tpFrozen,
    ))
  })
}

export function manageSignalPath(signalId: string | null | undefined): string {
  const id = String(signalId ?? '').trim()
  return id ? `/manage-signals?edit=${encodeURIComponent(id)}` : '/manage-signals'
}

export function isDriftSweepReconcileJob(job: Pick<BasketReconcileJobRow, 'last_error' | 'source_signal_id' | 'anchor_signal_id'>): boolean {
  return job.source_signal_id === job.anchor_signal_id
    && String(job.last_error ?? '').toLowerCase().startsWith('drift sweep:')
}

export function detectManualBrokerStopOverrides(args: {
  familyTrades: BasketOpenLeg[]
  perLegTargets: PerLegStopTarget[]
  ordersByTicket: Map<number, unknown>
  nImmCwe: number
  effectiveStoploss?: number
  tpFrozen?: boolean
}): ManualBrokerStopOverride[] {
  const { familyTrades, perLegTargets, ordersByTicket, nImmCwe } = args
  if (!familyTrades.length || !perLegTargets.length || !ordersByTicket.size) return []

  const dbAlreadyManaged = basketDbMatchesTargets({
    familyTrades,
    perLegTargets,
    nImmCwe,
    effectiveStoploss: args.effectiveStoploss,
    tpFrozen: args.tpFrozen,
  })
  if (!dbAlreadyManaged) return []

  const expanded = expandPerLegTargetsToCount({
    targets: perLegTargets,
    openLegCount: familyTrades.length,
    finalTps: perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: null,
  }) as PerLegStopTarget[]

  const out: ManualBrokerStopOverride[] = []
  for (let i = 0; i < familyTrades.length; i++) {
    const tr = familyTrades[i]!
    const target = expanded[i]
    if (!target) continue

    const ticket = Number(tr.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    const raw = ordersByTicket.get(ticket)
    if (!raw) continue

    const targetSl = positive(args.effectiveStoploss) ?? positive(target.stoploss)
    const targetTp = positive(target.takeprofit)
    const brokerSl = readBrokerOrderStopLoss(raw)
    const brokerTp = readBrokerOrderTakeProfit(raw)
    const changedSides: Array<'sl' | 'tp'> = []

    if (targetSl != null && brokerSl != null && !approxEq(brokerSl, targetSl)) changedSides.push('sl')
    if (targetTp != null && brokerTp != null && !approxEq(brokerTp, targetTp)) changedSides.push('tp')
    if (!changedSides.length) continue

    out.push({
      tradeId: tr.id,
      ticket,
      brokerSl,
      targetSl,
      brokerTp,
      targetTp,
      changedSides,
    })
  }
  return out
}

export function manualOverrideDedupeMs(): number {
  return Math.min(
    24 * 60 * 60_000,
    Math.max(60_000, Number(process.env.MANUAL_BROKER_OVERRIDE_NOTIFY_DEDUPE_MS ?? DEFAULT_DEDUPE_MS)),
  )
}

async function recentlyNotified(args: {
  supabase: SupabaseClient
  userId: string
  brokerAccountId: string
  anchorSignalId: string
  symbol: string
  nowMs?: number
}): Promise<boolean> {
  const cutoff = new Date((args.nowMs ?? Date.now()) - manualOverrideDedupeMs()).toISOString()
  const { data, error } = await args.supabase
    .from('trade_execution_logs')
    .select('id,created_at,request_payload')
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('signal_id', args.anchorSignalId)
    .eq('action', MANUAL_BROKER_OVERRIDE_REVERTED_ACTION)
    .eq('status', 'success')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) {
    console.warn(`[manualBrokerOverrideNotification] dedupe lookup failed: ${error.message}`)
    return true
  }

  const wanted = args.symbol.trim().toUpperCase()
  return ((data ?? []) as Array<{ request_payload?: Record<string, unknown> | null }>).some(row => {
    const payload = row.request_payload ?? {}
    return String(payload.anchor_signal_id ?? '') === args.anchorSignalId
      && String(payload.symbol ?? '').trim().toUpperCase() === wanted
  })
}

export function sendManualBrokerOverrideEmail(args: {
  userId: string
  signalId: string
  brokerAccountId: string
  symbol: string
  manageSignalPath: string
  changedSides: Array<'sl' | 'tp'>
}): void {
  const supabaseUrl = String(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return

  const url = `${supabaseUrl}/functions/v1/manual-broker-override-email`
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      user_id: args.userId,
      signal_id: args.signalId,
      broker_account_id: args.brokerAccountId,
      symbol: args.symbol,
      manage_signal_path: args.manageSignalPath,
      changed_sides: args.changedSides,
    }),
  }).catch(err => {
    console.warn(
      `[manualBrokerOverrideNotification] email notification failed signal=${args.signalId}: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export async function notifyManualBrokerOverrideReverted(args: {
  supabase: SupabaseClient
  userId: string
  brokerAccountId: string
  anchorSignalId: string
  sourceSignalId: string
  channelId: string | null
  symbol: string
  direction: 'buy' | 'sell'
  reconcileJobId: string
  overrides: ManualBrokerStopOverride[]
  restoredTradeIds: string[]
  nowMs?: number
}): Promise<boolean> {
  const restored = args.overrides.filter(o => args.restoredTradeIds.includes(o.tradeId))
  if (!restored.length) return false

  if (await recentlyNotified(args)) return false

  const changedSides = [...new Set(restored.flatMap(o => o.changedSides))].sort() as Array<'sl' | 'tp'>
  const path = manageSignalPath(args.anchorSignalId)
  const payload = {
    notification_type: MANUAL_BROKER_OVERRIDE_REVERTED_ACTION,
    title: 'Manual trade changes were reverted',
    body: 'TScopier detected a manual SL/TP change made directly on your broker account and restored the signal managed values. To change SL or TP for a copied signal, use Manage Signal in TScopier.',
    cta_label: 'Manage Signal',
    manage_signal_url: path,
    anchor_signal_id: args.anchorSignalId,
    source_signal_id: args.sourceSignalId,
    channel_id: args.channelId,
    symbol: args.symbol,
    direction: args.direction,
    reconcile_job_id: args.reconcileJobId,
    restored_legs: restored.length,
    restored_trade_ids: restored.map(o => o.tradeId),
    changed_sides: changedSides,
  }

  const { error } = await args.supabase.from('trade_execution_logs').insert({
    user_id: args.userId,
    signal_id: args.anchorSignalId,
    broker_account_id: args.brokerAccountId,
    action: MANUAL_BROKER_OVERRIDE_REVERTED_ACTION,
    status: 'success',
    request_payload: payload as unknown as Record<string, unknown>,
  })
  if (error) {
    console.warn(`[manualBrokerOverrideNotification] in-app log insert failed: ${error.message}`)
    return false
  }

  sendManualBrokerOverrideEmail({
    userId: args.userId,
    signalId: args.anchorSignalId,
    brokerAccountId: args.brokerAccountId,
    symbol: args.symbol,
    manageSignalPath: path,
    changedSides,
  })
  return true
}