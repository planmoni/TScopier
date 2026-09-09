/**
 * Fresh SL/TP target resolution for basket reconcile jobs and drift sweeps.
 * Rebuilds per-leg targets from channel memory + entry-quality distribution
 * instead of trusting stale job JSON (e.g. all legs stuck on TP1).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PerLegStopTarget } from './multiTradeMerge'
import {
  isExplicitBasketSlSource,
  logEffectiveBasketStops,
  resolveEffectiveBasketStops,
  type EffectiveStopSource,
} from './basketEffectiveStops'
import { parseUserOverride } from './signalOverride'
import { expandPerLegTargetsToCount } from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { stopsAlreadyMatchDb } from './orderModifyBenign'
import { readBrokerOrderStopLoss } from './signalEntryPendingHelpers'
import {
  type BasketOpenLeg,
  type BasketReconcileJobRow,
  loadOpenBasketLegs,
  parsePerLegTargets,
  upsertBasketReconcileJob,
} from './basketSlTpReconcile'
import {
  backfillNakedLegTakeProfits,
  buildRangeBasketTpTargets,
  fillZeroTargetsWithDeepest,
  hasClosedBasketLegs,
  loadRangePendingMeta,
  resolveRangeBasketFinalTps,
  resolveRangeBasketLegCounts,
  resolveRangeTpRebalanceGate,
  toRangeBasketParsedSlice,
} from './rangeBasketTpSync'
import { hasTpTouchedLock } from './rangePendingFireGuard'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import { isUserCopierPausedCached } from './copierPause'
import { hasFxsocketConfigured } from './fxsocketClient'
import { apiForFxsocketAccount, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import { fetchBrokerOrdersByTicket } from './channelStopApply'
import { brokerSessionUuid } from './tradeExecutor/helpers'
import { passiveDriftSweepSnapshot } from './manualBrokerOverrideNotification'

export type FreshReconcileTargetsArgs = {
  anchorSignalId: string
  channelId: string | null
  symbol: string
  direction: 'buy' | 'sell'
  userId: string
  brokerAccountId: string
  familyTrades: BasketOpenLeg[]
  storedTargets: PerLegStopTarget[]
  manual: { range_trading?: boolean; tp_lots?: ManualTpLot[] | null }
  nImmCwe: number
  overrideTp: number | null
}

export type FreshReconcileTargetsResult = {
  perLegTargets: PerLegStopTarget[]
  signalTps: number[]
  effectiveStoploss: number
  effectiveSlSource: EffectiveStopSource
  tpFrozen?: boolean
}

export async function resolveFreshBasketReconcileTargets(
  supabase: SupabaseClient,
  args: FreshReconcileTargetsArgs,
): Promise<FreshReconcileTargetsResult> {
  const stored = args.storedTargets

  const { data: anchorSig } = await supabase
    .from('signals')
    .select('parsed_data, created_at, channel_id, user_override')
    .eq('id', args.anchorSignalId)
    .maybeSingle()

  const anchorCreatedAt =
    (anchorSig as { created_at?: string } | null)?.created_at
    ?? args.familyTrades[0]?.opened_at
    ?? null
  const channelId =
    args.channelId
    ?? (anchorSig as { channel_id?: string | null } | null)?.channel_id
    ?? null

  const anchorParsed = toRangeBasketParsedSlice(
    (anchorSig as { parsed_data?: unknown } | null)?.parsed_data as { sl?: unknown; tp?: unknown } | undefined,
  )

  const effective = await resolveEffectiveBasketStops({
    supabase,
    userId: args.userId,
    channelId,
    anchorSignalId: args.anchorSignalId,
    symbol: args.symbol,
    basketCreatedAt: anchorCreatedAt,
    anchorParsed,
    familyTrades: args.familyTrades,
    brokerAccountId: args.brokerAccountId,
    userOverride: parseUserOverride(
      (anchorSig as { user_override?: unknown } | null)?.user_override,
    ),
  })
  logEffectiveBasketStops('[basketReconcileTargets]', args.anchorSignalId, effective)

  const parsed = { ...effective.parsedSlice }
  const channelTpLevels = effective.tpLevels.length ? effective.tpLevels : null

  const signalTps = resolveRangeBasketFinalTps({
    parsed,
    familyTrades: args.familyTrades,
    channelTpLevels,
    direction: args.direction,
  })

  let perLegTargets: PerLegStopTarget[]
  let tpFrozen = false

  if (args.manual.range_trading === true && args.familyTrades.length > 0) {
    const { activePendingCount, maxPendingStepIdx } = await loadRangePendingMeta(
      supabase,
      args.brokerAccountId,
      args.anchorSignalId,
    )
    const planImmediateLegCount = Math.max(1, args.familyTrades.length - maxPendingStepIdx)
    const { phase } = resolveRangeBasketLegCounts({
      openLegCount: args.familyTrades.length,
      planImmediateLegCount,
      activePendingCount,
      maxPendingStepIdx,
    })
    const hasClosedLegs = await hasClosedBasketLegs(
      supabase,
      args.brokerAccountId,
      args.anchorSignalId,
    )
    const tpTouched = await hasTpTouchedLock(supabase, {
      signalId: args.anchorSignalId,
      brokerAccountId: args.brokerAccountId,
      symbol: args.symbol,
    })
    const tpGate = resolveRangeTpRebalanceGate({
      activePendingCount,
      maxPendingStepIdx,
      phase,
      hasClosedBasketLegs: hasClosedLegs,
      tpTouched,
    })
    const built = buildRangeBasketTpTargets({
      familyTrades: args.familyTrades,
      plan: null,
      parsed,
      tpLots: args.manual.tp_lots,
      direction: args.direction,
      activePendingCount,
      maxPendingStepIdx,
      channelTpLevels,
      finalTpsOverride: signalTps.length ? signalTps : null,
      stoplossOverride: effective.stoploss > 0 ? effective.stoploss : null,
      explicitSl: isExplicitBasketSlSource(effective.source),
    })
    const isBuy = args.direction === 'buy'
    let mapped = built.map(t => ({
      stoploss: Number(t.stoploss) || 0,
      takeprofit: Number(t.takeprofit) || 0,
    }))
    // Frozen (a TP was hit): never repaint existing legs; only backfill naked
    // legs with the deepest TP. Otherwise distribute, but never leave a 0 TP.
    mapped = (tpGate.mode === 'backfill_only'
      ? backfillNakedLegTakeProfits(args.familyTrades, mapped, signalTps, isBuy)
      : fillZeroTargetsWithDeepest(mapped, signalTps, isBuy)
    ).map(t => ({
      stoploss: Number(t.stoploss) || 0,
      takeprofit: Number(t.takeprofit) || 0,
    }))
    perLegTargets = mapped
    tpFrozen = tpGate.mode === 'backfill_only'
  } else {
    const slNum = typeof parsed.sl === 'number' && parsed.sl > 0 ? parsed.sl : 0
    const sl = slNum > 0 ? slNum : (stored[0]?.stoploss ?? 0)
    const seed = stored.length
      ? stored.map(t => ({ ...t, stoploss: sl || t.stoploss }))
      : [{ stoploss: sl, takeprofit: 0 }]
    perLegTargets = expandPerLegTargetsToCount({
      targets: seed,
      openLegCount: args.familyTrades.length,
      finalTps: signalTps,
      tpLots: args.manual.tp_lots,
    }).map(t => ({
      stoploss: Number(t.stoploss) || 0,
      takeprofit: Number(t.takeprofit) || 0,
    }))
  }

  if (args.overrideTp != null && args.overrideTp > 0) {
    for (let i = 0; i < perLegTargets.length; i++) {
      perLegTargets[i] = { ...perLegTargets[i]!, takeprofit: args.overrideTp }
    }
  }

  for (let i = 0; i < Math.min(args.nImmCwe, perLegTargets.length); i++) {
    perLegTargets[i] = { ...perLegTargets[i]!, takeprofit: 0 }
  }

  return {
    perLegTargets,
    signalTps,
    effectiveStoploss: effective.stoploss,
    effectiveSlSource: effective.source,
    tpFrozen: tpFrozen || undefined,
  }
}

/** True when any open leg's DB SL/TP differs from freshly resolved targets. */
export function basketLegsOutOfSync(
  familyTrades: BasketOpenLeg[],
  perLegTargets: PerLegStopTarget[],
  nImmCwe: number,
  opts?: { effectiveStoploss?: number; tpFrozen?: boolean },
): boolean {
  if (!familyTrades.length || !perLegTargets.length) return false
  const expanded = expandPerLegTargetsToCount({
    targets: perLegTargets,
    openLegCount: familyTrades.length,
    finalTps: perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: null,
  })
  const effectiveSl = opts?.effectiveStoploss != null && opts.effectiveStoploss > 0
    ? opts.effectiveStoploss
    : null
  const tpFrozen = opts?.tpFrozen === true
  for (let i = 0; i < familyTrades.length; i++) {
    const target = expanded[i]
    if (!target) return true
    let compareTarget = target
    if (effectiveSl != null) {
      const legSl = Number(familyTrades[i]!.sl)
      if (
        Number.isFinite(legSl)
        && Math.abs(legSl - effectiveSl) < 1e-8
        && Math.abs(target.stoploss - effectiveSl) > 1e-8
      ) {
        compareTarget = { ...target, stoploss: effectiveSl }
      }
    }
    if (tpFrozen) {
      const legSl = Number(familyTrades[i]!.sl)
      const targetSl = compareTarget.stoploss
      if (targetSl > 0) {
        if (!Number.isFinite(legSl) || Math.abs(legSl - targetSl) > 1e-8) return true
      } else if (Number.isFinite(legSl) && legSl > 0) {
        return true
      }
      continue
    }
    if (!stopsAlreadyMatchDb(familyTrades[i]!, compareTarget, nImmCwe, i)) return true
  }
  return false
}

function brokerSlMatchesTarget(brokerSl: number | null, targetSl: number): boolean {
  if (brokerSl == null || !(brokerSl > 0) || !(targetSl > 0)) return false
  return Math.abs(brokerSl - targetSl) <= 1e-6
}

/**
 * True when broker /OpenedOrders SL differs from target (DB may already match).
 * Falls back to DB-only basketLegsOutOfSync when orders map is empty.
 */
export function basketLegsOutOfSyncOnBroker(
  familyTrades: BasketOpenLeg[],
  perLegTargets: PerLegStopTarget[],
  ordersByTicket: Map<number, unknown>,
  nImmCwe: number,
  opts?: { effectiveStoploss?: number; tpFrozen?: boolean },
): boolean {
  if (basketLegsOutOfSync(familyTrades, perLegTargets, nImmCwe, opts)) return true
  if (!ordersByTicket.size) return false

  const expanded = expandPerLegTargetsToCount({
    targets: perLegTargets,
    openLegCount: familyTrades.length,
    finalTps: perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: null,
  })

  for (let i = 0; i < familyTrades.length; i++) {
    const target = expanded[i]
    if (!target || !(target.stoploss > 0)) continue
    const ticket = Number(familyTrades[i]!.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    const raw = ordersByTicket.get(ticket)
    if (!raw) continue
    const brokerSl = readBrokerOrderStopLoss(raw)
    if (!brokerSlMatchesTarget(brokerSl, target.stoploss)) return true
  }
  return false
}

const SWEEP_BATCH = Math.min(
  80,
  Math.max(5, Number(process.env.BASKET_RECONCILE_SWEEP_BATCH ?? 50)),
)

type SweepBasketRow = {
  broker_account_id: string
  signal_id: string
  symbol: string
  direction: string
  telegram_channel_id: string | null
  /** Best available leg timestamp for sweep freshness (trades has no updated_at). */
  opened_at?: string | null
}

type SweepBrokerRow = {
  id: string
  user_id: string
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  platform?: string | null
  manual_settings?: unknown
  channel_trading_configs?: unknown
  copier_mode?: string | null
  ai_settings?: unknown
}

/** Prefer baskets whose channel SL/TP memory is newer than leg rows (recent mgmt modify). */
export function sortSweepBasketsByChannelParamFreshness(
  rows: SweepBasketRow[],
  channelParamUpdatedAt: Map<string, string>,
  legUpdatedAtByKey: Map<string, string>,
): SweepBasketRow[] {
  return [...rows].sort((a, b) => {
    const keyA = `${a.broker_account_id}|${a.signal_id}`
    const keyB = `${b.broker_account_id}|${b.signal_id}`
    const chKeyA = a.telegram_channel_id && a.symbol
      ? `${a.telegram_channel_id}|${a.symbol}`
      : ''
    const chKeyB = b.telegram_channel_id && b.symbol
      ? `${b.telegram_channel_id}|${b.symbol}`
      : ''
    const paramA = chKeyA ? channelParamUpdatedAt.get(chKeyA) : null
    const paramB = chKeyB ? channelParamUpdatedAt.get(chKeyB) : null
    const legA = legUpdatedAtByKey.get(keyA)
    const legB = legUpdatedAtByKey.get(keyB)
    const freshA = paramA && legA ? new Date(paramA).getTime() > new Date(legA).getTime() : false
    const freshB = paramB && legB ? new Date(paramB).getTime() > new Date(legB).getTime() : false
    if (freshA !== freshB) return freshA ? -1 : 1
    const tA = paramA ? new Date(paramA).getTime() : 0
    const tB = paramB ? new Date(paramB).getTime() : 0
    return tB - tA
  })
}

async function loadSweepBrokerOrders(
  supabase: SupabaseClient,
  broker: SweepBrokerRow,
  platformByUuid: PlatformByFxsocketId,
  cache: Map<string, Map<number, unknown>>,
): Promise<Map<number, unknown>> {
  const uuid = brokerSessionUuid(broker)
  if (!uuid) return new Map()
  const cached = cache.get(uuid)
  if (cached) return cached

  const api = apiForFxsocketAccount(platformByUuid, uuid)
  if (!api) return new Map()

  const orders = await fetchBrokerOrdersByTicket(api, uuid)
  cache.set(uuid, orders)
  return orders
}

/**
 * Scan open baskets and enqueue reconcile jobs when legs drift from channel SL/TP ladder.
 * Runs periodically from BasketSlTpReconcileMonitor (not only when jobs already exist).
 */
export async function sweepOpenBasketsForReconcileDrift(
  supabase: SupabaseClient,
): Promise<number> {
  const { data: tradeRows, error } = await supabase
    .from('trades')
    .select('broker_account_id,signal_id,symbol,direction,telegram_channel_id,opened_at')
    .eq('status', 'open')
    .not('broker_account_id', 'is', null)
    .limit(500)

  if (error || !tradeRows?.length) return 0

  const basketKeys = new Map<string, SweepBasketRow>()
  const legUpdatedAtByKey = new Map<string, string>()
  for (const raw of tradeRows) {
    const row = raw as SweepBasketRow
    const key = `${row.broker_account_id}|${row.signal_id}`
    if (!basketKeys.has(key)) basketKeys.set(key, row)
    const prev = legUpdatedAtByKey.get(key)
    const rowAt = row.opened_at ?? ''
    if (!prev || (rowAt && new Date(rowAt).getTime() > new Date(prev).getTime())) {
      legUpdatedAtByKey.set(key, rowAt)
    }
  }

  const channelIds = [...new Set(
    [...basketKeys.values()]
      .map(r => r.telegram_channel_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )]
  const channelParamUpdatedAt = new Map<string, string>()
  if (channelIds.length) {
    const { data: paramRows } = await supabase
      .from('channel_active_trade_params')
      .select('channel_id,symbol,updated_at')
      .in('channel_id', channelIds)
    for (const raw of paramRows ?? []) {
      const pr = raw as { channel_id?: string; symbol?: string; updated_at?: string }
      if (!pr.channel_id || !pr.symbol || !pr.updated_at) continue
      const k = `${pr.channel_id}|${pr.symbol}`
      const prev = channelParamUpdatedAt.get(k)
      if (!prev || new Date(pr.updated_at).getTime() > new Date(prev).getTime()) {
        channelParamUpdatedAt.set(k, pr.updated_at)
      }
    }
  }

  const sortedBaskets = sortSweepBasketsByChannelParamFreshness(
    [...basketKeys.values()],
    channelParamUpdatedAt,
    legUpdatedAtByKey,
  )

  const brokerIds = [...new Set(sortedBaskets.map(r => r.broker_account_id))]
  const { data: brokers } = await supabase
    .from('broker_accounts')
    .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform,manual_settings,channel_trading_configs,copier_mode,ai_settings')
    .in('id', brokerIds)

  const brokerById = new Map(
    ((brokers ?? []) as SweepBrokerRow[]).map(b => [b.id, b]),
  )

  const brokerUuids = [...new Set(
    ((brokers ?? []) as SweepBrokerRow[])
      .map(b => brokerSessionUuid(b))
      .filter((u): u is string => typeof u === 'string' && u.length > 0 && !u.includes('|')),
  )]
  const platformByUuid = brokerUuids.length && hasFxsocketConfigured()
    ? await loadPlatformByFxsocketId(supabase, brokerUuids)
    : new Map()
  const ordersCache = new Map<string, Map<number, unknown>>()

  let enqueued = 0
  let scanned = 0

  for (const row of sortedBaskets) {
    if (scanned >= SWEEP_BATCH) break
    scanned += 1

    const broker = brokerById.get(row.broker_account_id)
    if (!broker?.user_id) continue
    if (isUserCopierPausedCached(String(broker.user_id))) continue

    const manual = normalizeManualSettingsForExecution(
      resolveChannelTradingConfig(
        broker as Parameters<typeof resolveChannelTradingConfig>[0],
        row.telegram_channel_id,
      ).manual_settings,
    )

    const familyTrades = await loadOpenBasketLegs(
      supabase,
      row.broker_account_id,
      row.signal_id,
      row.symbol,
    )
    if (familyTrades.length === 0) continue

    const direction = (row.direction === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell'

    const { data: existingJob } = await supabase
      .from('basket_reconcile_jobs')
      .select('id,status,next_run_at')
      .eq('broker_account_id', row.broker_account_id)
      .eq('anchor_signal_id', row.signal_id)
      .maybeSingle()

    const jobStatus = (existingJob as { status?: string } | null)?.status
    if (jobStatus === 'pending' || jobStatus === 'claimed') continue

    const { perLegTargets, signalTps, effectiveStoploss, tpFrozen } = await resolveFreshBasketReconcileTargets(supabase, {
      anchorSignalId: row.signal_id,
      channelId: row.telegram_channel_id,
      symbol: row.symbol,
      direction,
      userId: broker.user_id,
      brokerAccountId: row.broker_account_id,
      familyTrades,
      storedTargets: [],
      manual,
      nImmCwe: 0,
      overrideTp: null,
    })

    if (!perLegTargets.length) continue

    const ordersByTicket = hasFxsocketConfigured()
      ? await loadSweepBrokerOrders(supabase, broker, platformByUuid, ordersCache)
      : new Map<number, unknown>()
    const outOfSync = basketLegsOutOfSyncOnBroker(
      familyTrades,
      perLegTargets,
      ordersByTicket,
      0,
      { effectiveStoploss, tpFrozen },
    )
    if (!outOfSync) continue

    const jobId = await upsertBasketReconcileJob(supabase, {
      userId: broker.user_id,
      brokerAccountId: row.broker_account_id,
      anchorSignalId: row.signal_id,
      sourceSignalId: row.signal_id,
      channelId: row.telegram_channel_id,
      symbol: row.symbol,
      direction,
      perLegTargets,
      familyTrades,
      signalTps,
      tpLots: manual.tp_lots,
      virtualPendingsSnapshot: passiveDriftSweepSnapshot(),
      nImmCwe: 0,
      overrideTp: null,
      lastError: 'Drift sweep: open legs out of sync with channel SL/TP ladder',
    })

    if (jobId) {
      enqueued += 1
      console.log(
        `[basketReconcileTargets] drift sweep enqueued job=${jobId}`
        + ` broker=${row.broker_account_id} anchor=${row.signal_id} legs=${familyTrades.length}`,
      )
    }
  }

  if (enqueued > 0) {
    console.log(`[basketReconcileTargets] drift sweep enqueued ${enqueued} reconcile job(s)`)
  }
  return enqueued
}

export async function resolveFreshTargetsForJob(
  supabase: SupabaseClient,
  job: BasketReconcileJobRow,
  familyTrades: BasketOpenLeg[],
  manual: { range_trading?: boolean; tp_lots?: ManualTpLot[] | null },
): Promise<FreshReconcileTargetsResult> {
  return resolveFreshBasketReconcileTargets(supabase, {
    anchorSignalId: job.anchor_signal_id,
    channelId: job.channel_id,
    symbol: job.symbol,
    direction: job.direction,
    userId: job.user_id,
    brokerAccountId: job.broker_account_id,
    familyTrades,
    storedTargets: parsePerLegTargets(job.per_leg_targets),
    manual,
    nImmCwe: job.n_imm_cwe ?? 0,
    overrideTp: job.override_tp,
  })
}
