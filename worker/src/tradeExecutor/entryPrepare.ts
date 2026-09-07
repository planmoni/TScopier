import {
  hasFxsocketConfigured,
  MT_SESSION_EXPIRED_HINT,
  FxsocketBrokerClient,
  MtOperation,
  OrderSendArgs,
} from '../fxsocketClient'
import {
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  signalEntryRangeStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { findActiveNewsBlackout } from '../newsTrading/blackout'
import { getCalendarEventsCached } from '../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../newsTrading/settings'
import { shouldRouteAsBasketParameterRefresh } from '../multiTradeMerge'
import { parsedHasReEnterIntent } from '../signalPriceInference'
import {
  ENTRY_ZONE_FAR_FROM_MARKET_REASON,
  entryZoneFarFromQuote,
} from '../signalEntryZoneSanity'
import {
  ENTRY_PRICE_MOVED_ADVERSE_REASON,
  entryPriceMovedAdverse,
} from '../signalEntryPriceGuard'
import { ENTRY_TP_WITHOUT_SL_REASON } from '../signalEntryNowRequirement'
import { pipCalculator } from '../pipCalculator'
import {
  SIGNAL_MISSING_REQUIRED_SL,
  tradeFailureReasonFromCode,
} from '../brokerTradeError'
import {
  convertPipOffsetToPrice,
  convertPipOffsetsToPrices,
  resolvePipSize,
} from '../signalStopUnits'
import {
  applyChannelParamsToVirtualPendingList,
  parsedSignalHasExplicitStops,
  refreshChannelParamsFromSignal,
  resolveEntryChannelStops,
  shouldPreferParsedStopsOnEntry,
  type ChannelActiveTradeParams,
} from '../channelActiveTradeParams'
import { resolveTscopierCommentPrefix } from '../tradeComment'
import type { TradeExecutorContext } from './context'
import { applySymbolMapping, computeLot, isBuySideOp, isExcluded, isMt5OnlyOperation, roundLot, triggerPriceFor, brokerSessionUuid, type Leg } from './helpers'
import { missingRequiredSlFailure } from './entryPrepareMissingSl'

export { missingRequiredSlFailure } from './entryPrepareMissingSl'
import type {
  BrokerRow,
  ParsedSignal,
  SendOrderOutcome,
  SignalRow,
  SymbolCacheEntry,
  SymbolMappingResult,
} from './types'
import {
  logSignalRangeEntryNoPrice,
  logSignalRangeEntryWaiting,
  logSignalRangeEntryWakeRetry,
  SIGNAL_RANGE_WAKE_DISPATCH_SOURCE,
  upsertSignalRangeEntryWait,
} from '../signalRangeEntryHelpers'
import {
  evaluatePreEntryStaleness,
  evaluateWakeEligibility,
  expireWait,
} from '../signalRangeEntryService'
import { releaseSignalBrokerDispatchClaim } from './signalBrokerDispatchClaim'
import { shouldBlockNewEntryOnRevision } from './messageRevisionEntryGuard'
import { setPipelineTimestamp } from '../pipelineTimestamps'
import type { LayeringModeRuntime } from './layeringModeIntegration'

export type EntryArgs = {
  signal: SignalRow
  parsed: ParsedSignal
  op: MtOperation
  broker: BrokerRow
  channelKeywords: ChannelKeywords | null
  pipelineT0?: number
  sendOpts?: {
    liveEntryFast?: boolean
    liveMgmtFast?: boolean
    commentSlug?: string | null
    commentPrefix?: string
    sameSignalRefresh?: boolean
    blockNewEntry?: boolean
  }
}

export type PreparedEntry = {
  ctx: TradeExecutorContext
  signal: SignalRow
  parsed: ParsedSignal
  broker: BrokerRow
  manual: ManualSettings
  api: FxsocketBrokerClient
  uuid: string
  symbol: string
  requestedSymbol: string
  mapping: SymbolMappingResult
  params: SymbolCacheEntry | null
  liveEntryFast: boolean
  pipelineT0?: number
  strictEntryPrefetch: { bid: number; ask: number } | null
  commentPrefix: string
  channelDelayMs: number
  channelDelaySkipped: boolean
  plan: PlannerResult
  capped: OrderSendArgs[]
  virtualPendings: VirtualPendingLeg[]
  legs: Leg[]
  deferVirtualAnchor: boolean
  /** Pending Order mode: place broker limits after immediate fills (fill-price anchor). */
  deferBrokerRangePendingMaterialize: boolean
  strictDeferred: boolean
  op: MtOperation
  channelKeywords: ChannelKeywords | null
  baseLot: number
  anchor: number | null
  anchorSource: 'signal' | 'quote' | 'fill' | 'unknown'
  isManual: boolean
  layeringRuntime?: LayeringModeRuntime
}

export type PrepareEntryResult =
  | { ok: false; outcome: SendOrderOutcome }
  | { ok: true; prep: PreparedEntry }

/** Fill missing symbol for re-enter posts that omit instrument name. */
async function resolveReEnterSymbolFromChannel(
  ctx: TradeExecutorContext,
  signal: SignalRow,
  broker: BrokerRow,
  parsed: ParsedSignal,
): Promise<ParsedSignal> {
  if (!parsedHasReEnterIntent(parsed)) return parsed
  if (parsed.symbol?.trim()) return parsed
  if (!signal.channel_id) return parsed

  const direction = String(parsed.action ?? '').toLowerCase()
  if (direction !== 'buy' && direction !== 'sell') return parsed

  const { data: openTrades, error } = await ctx.supabase
    .from('trades')
    .select('symbol, signal_id, opened_at')
    .eq('user_id', signal.user_id)
    .eq('broker_account_id', broker.id)
    .eq('status', 'open')
    .eq('direction', direction)
    .order('opened_at', { ascending: false })
    .limit(100)
  if (error || !openTrades?.length) return parsed

  const signalIds = [...new Set(
    (openTrades as { signal_id: string }[]).map(r => r.signal_id).filter(Boolean),
  )]
  if (!signalIds.length) return parsed

  const { data: sigRows } = await ctx.supabase
    .from('signals')
    .select('id, channel_id')
    .in('id', signalIds)
  const channelSignalIds = new Set(
    ((sigRows ?? []) as { id: string; channel_id: string | null }[])
      .filter(s => s.channel_id === signal.channel_id)
      .map(s => s.id),
  )
  if (!channelSignalIds.size) return parsed

  const symbols = new Set<string>()
  for (const row of openTrades as { symbol: string; signal_id: string }[]) {
    if (!channelSignalIds.has(row.signal_id)) continue
    const sym = row.symbol?.trim()
    if (sym) symbols.add(sym)
  }
  if (symbols.size !== 1) {
    if (symbols.size > 1) {
      await ctx.logSendSkipped(signal, broker, 're_enter_ambiguous_channel_symbols', {
        symbols: [...symbols],
        channel_id: signal.channel_id,
      })
    }
    return parsed
  }

  const resolvedSymbol = [...symbols][0]!
  return { ...parsed, symbol: resolvedSymbol }
}

export async function prepareEntryExecution(
  ctx: TradeExecutorContext,
  args: EntryArgs,
): Promise<PrepareEntryResult> {
  const { signal, op, broker, channelKeywords, pipelineT0, sendOpts } = args
  let parsed = args.parsed
  parsed = await resolveReEnterSymbolFromChannel(ctx, signal, broker, parsed)
  if (parsedHasReEnterIntent(parsed) && !parsed.symbol?.trim()) {
    await ctx.logSendSkipped(signal, broker, 're_enter_missing_symbol_context', {
      channel_id: signal.channel_id,
    })
    return { ok: false, outcome: {} }
  }
  const liveEntryFast = sendOpts?.liveEntryFast === true
  if (!hasFxsocketConfigured()) return { ok: false, outcome: {} }
  const api = ctx.apiFor(broker)
  if (!api) return { ok: false, outcome: {} }
  const uuid = brokerSessionUuid(broker)!
  const signalSymbol = (parsed.symbol ?? '').trim()
  if (isExcluded(signalSymbol, broker)) {
    await ctx.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
      signal_symbol: parsed.symbol ?? null,
      reason: 'symbols_exclude',
    })
    return { ok: false, outcome: {} }
  }

  const mapping = applySymbolMapping(parsed.symbol!, broker)

  if (broker.platform === 'MT4' && isMt5OnlyOperation(op)) {
    await ctx.logSendSkipped(signal, broker, 'mt4_unsupported_operation', { operation: op })
    return { ok: false, outcome: { finalizeSkipReason: 'mt4_unsupported_operation' } }
  }

  // Whitelist mode: when the user listed multiple symbols, only let signals
  // matching one of them through. Skip the signal otherwise.
  if (mapping.whitelist.length > 0) {
    const sig = (parsed.symbol ?? '').toUpperCase()
    if (!mapping.whitelist.includes(sig)) {
      await ctx.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
        signal_symbol: parsed.symbol ?? null,
        allowed: mapping.whitelist,
      })
      return { ok: false, outcome: {} }
    }
  }

  const requestedSymbol = mapping.symbol

  const isManual = (broker.copier_mode ?? 'ai') === 'manual'
  const manual = (broker.manual_settings ?? {}) as ManualSettings
  const commentPrefix = resolveTscopierCommentPrefix(
    signal.id,
    sendOpts?.commentSlug,
    manual,
    sendOpts?.commentPrefix,
  )

  const needsQuotePrefetch =
    isManual
    && (
      (signalEntryPriceStrictEnabled(manual) && parsedHasExplicitEntryAnchor(parsed))
      || signalEntryRangeStrictEnabled(manual)
      || manual.reverse_signal === true
      || manual.use_predefined_sl_pips === true
      || manual.use_predefined_tp_pips === true
    )

  if (signal.pipeline_ts) {
    setPipelineTimestamp(signal.pipeline_ts, 'broker_resolution_started_at', Date.now())
  }
  const stampOnResolve = liveEntryFast && !!signal.pipeline_ts
  const sessionPromise = ctx.ensureBrokerSessionLiveFast(api, uuid, broker).then(r => {
    if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_session_resolved == null) {
      signal.pipeline_ts.t_session_resolved = Date.now()
    }
    return r
  })
  const resolveOpts = { userDecorated: mapping.userDecorated }
  const symbolPromise = (liveEntryFast
    ? ctx.resolveBrokerSymbolForLiveEntry(uuid, requestedSymbol, resolveOpts)
    : ctx.resolveBrokerSymbol(uuid, requestedSymbol, resolveOpts)
  ).then(r => {
    if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_symbol_resolved == null) {
      signal.pipeline_ts.t_symbol_resolved = Date.now()
    }
    return r
  })
  const paramsPromise = ctx.getSymbolParams(uuid, requestedSymbol).catch(() => null)
  const [sessionOk, symbol, paramsFromRequested] = await Promise.all([
    sessionPromise,
    symbolPromise,
    paramsPromise,
  ])
  let params = paramsFromRequested
  if (symbol.toUpperCase() !== requestedSymbol.toUpperCase()) {
    params = await ctx.getSymbolParams(uuid, symbol).catch(() => params)
  }
  if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_params_resolved == null) {
    signal.pipeline_ts.t_params_resolved = Date.now()
  }
  if (liveEntryFast && signal.pipeline_ts && signal.pipeline_ts.t_send_caches_resolved == null) {
    setPipelineTimestamp(signal.pipeline_ts, 'broker_ready_at', Date.now())
  } else if (!liveEntryFast && signal.pipeline_ts) {
    setPipelineTimestamp(signal.pipeline_ts, 'broker_ready_at', Date.now())
  }
  if (!sessionOk) {
    await ctx.logSendSkipped(signal, broker, 'broker_session_not_connected', {
      symbol: requestedSymbol,
      metaapi_account_id: uuid,
      hint: MT_SESSION_EXPIRED_HINT,
    })
    return { ok: false, outcome: {} }
  }
  if (symbol.toUpperCase() !== requestedSymbol.toUpperCase()) {
    console.log(`[tradeExecutor] symbol resolved broker=${broker.id} ${requestedSymbol} → ${symbol}`)
  } else if (mapping.userDecorated && !params) {
    console.warn(
      `[tradeExecutor] user-decorated symbol params missing broker=${broker.id} symbol=${symbol}`,
    )
  }
  const baseLot = roundLot(computeLot(broker, parsed), params)
  const sameSignalRefresh = sendOpts?.sameSignalRefresh === true
  const missingSl = isManual && !sameSignalRefresh ? missingRequiredSlFailure(parsed, manual) : null
  if (missingSl) {
    const skipReason = missingSl.reason
    const tradeFailure = tradeFailureReasonFromCode(
      skipReason === ENTRY_TP_WITHOUT_SL_REASON ? ENTRY_TP_WITHOUT_SL_REASON : SIGNAL_MISSING_REQUIRED_SL,
      {
        missingField: 'stop_loss',
        withheldByProvider: missingSl.withheldByProvider,
        requestedSymbol,
        brokerSymbol: symbol,
      },
    )
    await ctx.logSendSkipped(signal, broker, skipReason, {
      symbol,
      reason_code: skipReason,
      ...(tradeFailure ? { trade_failure: tradeFailure } : {}),
    })
    return { ok: false, outcome: { finalizeSkipReason: skipReason } }
  }

  // A Telegram revision is never a new entry once the first dispatch already
  // materialized (order_send / trades / pending legs). Route those through the
  // modify-only path before any entry-zone, teaser, range, or OrderSend logic.
  // BUT when the first dispatch SKIPPED without materializing anything (e.g. the
  // channel edited the message to add the entry price), the revision carries the
  // real entry and must fall through to the normal entry path — otherwise the
  // edited signal can never trade.
  if (sameSignalRefresh) {
    const revisionMaterialized = await ctx.manualDispatchAlreadyMaterialized(signal.id, broker.id)
    if (revisionMaterialized) {
      const paramOutcome = await ctx.tryParameterFollowUpMergeModifyOnly({
        signal,
        parsed,
        broker,
        channelKeywords,
        baseLot,
        params,
        symbol,
        uuid,
        strictEntryPrefetch: null,
        commentPrefix,
        sameSignalRefresh: true,
        liveMgmtFast: sendOpts?.liveMgmtFast === true,
      })
      return {
        ok: false,
        outcome: { openedOrMerged: paramOutcome.handled === true && paramOutcome.success === true },
      }
    }
  }

  let strictEntryPrefetch: { bid: number; ask: number } | null = null
  if (needsQuotePrefetch) {
    try {
      strictEntryPrefetch = await api.quote(uuid, symbol)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] /Quote prefetch failed ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
      )
    }
  }

  const entryDirection = String(parsed.action ?? '').toLowerCase()
  const hasEntryZone =
    parsed.entry_zone_low != null
    || parsed.entry_zone_high != null
  if (
    isManual
    && hasEntryZone
    && !signalEntryRangeStrictEnabled(manual)
    && (entryDirection === 'buy' || entryDirection === 'sell')
    && sendOpts?.sameSignalRefresh !== true
  ) {
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      if (
        entryZoneFarFromQuote({
          parsed,
          quoteBid: q.bid,
          quoteAsk: q.ask,
          direction: entryDirection,
        })
      ) {
        await ctx.logSendSkipped(signal, broker, ENTRY_ZONE_FAR_FROM_MARKET_REASON, {
          symbol,
          quote_bid: q.bid,
          quote_ask: q.ask,
          entry_zone_low: parsed.entry_zone_low ?? null,
          entry_zone_high: parsed.entry_zone_high ?? null,
        })
        return {
          ok: false,
          outcome: { finalizeSkipReason: ENTRY_ZONE_FAR_FROM_MARKET_REASON },
        }
      }
    } catch {
      // Best-effort guard — proceed when quote is unavailable.
    }
  }

  // ── AI-lane adverse-price guard ─────────────────────────────────────────
  // AI-parsed/reconciled entries (dispatch_source ai_parsed / ai_reconciled)
  // must not execute when the live market has moved against the signal entry
  // beyond the broker's signal_entry_pip_tolerance — that would open at a
  // worse price than the signal published and risk an immediate loss.
  // Strict-entry and range-strict brokers are excluded: they already handle
  // adverse prices by deferring to broker pendings at the signal entry.
  if (
    (signal.dispatch_source === 'ai_parsed' || signal.dispatch_source === 'ai_reconciled')
    && (entryDirection === 'buy' || entryDirection === 'sell')
    && !signalEntryPriceStrictEnabled(manual)
    && !signalEntryRangeStrictEnabled(manual)
    && sendOpts?.sameSignalRefresh !== true
    && api
  ) {
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      strictEntryPrefetch = q
      const tolerancePips = Math.max(0, Number(manual.signal_entry_pip_tolerance ?? 10))
      const moved = entryPriceMovedAdverse({
        action: entryDirection as 'buy' | 'sell',
        entryPrice: typeof parsed.entry_price === 'number' ? parsed.entry_price : null,
        zoneLow: typeof parsed.entry_zone_low === 'number' ? parsed.entry_zone_low : null,
        zoneHigh: typeof parsed.entry_zone_high === 'number' ? parsed.entry_zone_high : null,
        bid: q.bid,
        ask: q.ask,
        tolerancePips,
        pipSize: params?.point ?? 0.00001,
      })
      if (moved) {
        await ctx.logSendSkipped(signal, broker, ENTRY_PRICE_MOVED_ADVERSE_REASON, {
          symbol,
          quote_bid: q.bid,
          quote_ask: q.ask,
          entry_price: parsed.entry_price ?? null,
          entry_zone_low: parsed.entry_zone_low ?? null,
          entry_zone_high: parsed.entry_zone_high ?? null,
          tolerance_pips: tolerancePips,
          dispatch_source: signal.dispatch_source,
        })
        return {
          ok: false,
          outcome: { finalizeSkipReason: ENTRY_PRICE_MOVED_ADVERSE_REASON },
        }
      }
    } catch {
      // Best-effort guard — proceed when quote is unavailable.
    }
  }

  // Basket SL/TP refresh — always before OrderSend (not deferred to post-fill).
  // Skip when Use signal range is on: zone+market-now+SL/TP must open via range entry wait,
  // not merge into a prior teaser that may never have opened.
  const basketRefreshSucceeded = false
  const blockNewEntry = sendOpts?.blockNewEntry === true
  const rangeEntryStrict = signalEntryRangeStrictEnabled(manual)
  const basketParameterRefresh = shouldRouteAsBasketParameterRefresh(parsed)
  if (isManual && !rangeEntryStrict && (basketParameterRefresh || sameSignalRefresh)) {
    const paramOutcome = await ctx.tryParameterFollowUpMergeModifyOnly({
      signal,
      parsed,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      commentPrefix,
      sameSignalRefresh,
      liveMgmtFast: sendOpts?.liveMgmtFast === true,
    })
    if (sameSignalRefresh && paramOutcome.handled) {
      return {
        ok: false,
        outcome: {
          openedOrMerged: paramOutcome.success === true,
        },
      }
    }
    if (paramOutcome.handled && paramOutcome.success) {
      return { ok: false, outcome: { openedOrMerged: true } }
    }
    // handled + !success: anchor had no open legs — fall through unless revision already opened.
  }

  // Message revision / re-dispatch must never place a second market or broker-pending basket
  // after the first entry already logged order_send / trades / range legs (live-fast used to skip this).
  if (sameSignalRefresh || blockNewEntry) {
    const alreadyMaterialized = blockNewEntry
      || await ctx.manualDispatchAlreadyMaterialized(signal.id, broker.id)
    if (shouldBlockNewEntryOnRevision({
      sameSignalRefresh,
      blockNewEntry,
      alreadyMaterialized,
    })) {
      console.warn(
        `[tradeExecutor] skip new entry on message revision — already materialized`
        + ` signal=${signal.id} broker=${broker.id} blockNewEntry=${blockNewEntry}`,
      )
      return { ok: false, outcome: { openedOrMerged: true } }
    }
  }

  if (isManual && !sameSignalRefresh && !basketRefreshSucceeded && !rangeEntryStrict) {
    const teaserOutcome = await ctx.tryTeaserCompletionMerge({
      signal,
      parsed,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      commentPrefix,
    })
    if (teaserOutcome.handled) {
      return {
        ok: false,
        outcome: { openedOrMerged: teaserOutcome.success === true },
      }
    }
  }

  // Stack-into-basket — before OrderSend on every path (not post-fill only).
  if (
    isManual
    && manual.add_new_trades_to_existing === true
    && !basketRefreshSucceeded
  ) {
    const mergeOutcome = await ctx.tryMergeSignalIntoExistingOpenTrade({
      signal,
      parsed,
      op,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      commentPrefix,
    })
    if (mergeOutcome.handled && mergeOutcome.success) {
      return { ok: false, outcome: { openedOrMerged: true } }
    }
  }

  if (isManual && manual.add_new_trades_to_existing === false && !parsedSignalHasExplicitStops(parsed)) {
    await ctx.logSendSkipped(signal, broker, 'explicit_stops_required_when_add_to_existing_off', { symbol })
    return { ok: false, outcome: { finalizeSkipReason: 'explicit_stops_required_when_add_to_existing_off' } }
  }

  if (!liveEntryFast && isManual && manual.close_on_opposite_signal === true) {
    await ctx.closeOppositeDirectionTrades(signal, parsed, broker, symbol)
  }

  if (isManual && manual.add_new_trades_to_existing === false) {
    const already = await ctx.hasOpenTradeForSymbol(broker.id, symbol)
    if (already) {
      await ctx.logSendSkipped(signal, broker, 'add_new_trades_to_existing=false', { symbol })
      return { ok: false, outcome: { finalizeSkipReason: 'add_new_trades_to_existing=false' } }
    }
  }

  if (!liveEntryFast) {
    const newsPreFill = String(process.env.EXECUTOR_NEWS_BLACKOUT_PRE_FILL ?? 'false').toLowerCase()
    if (
      (newsPreFill === '1' || newsPreFill === 'true' || newsPreFill === 'yes')
      && isManual
      && !isNewsTradingEnabled(manual)
    ) {
      const events = await getCalendarEventsCached()
      const blackout = findActiveNewsBlackout(events, manual, symbol)
      if (blackout) {
        await ctx.logSendSkipped(signal, broker, 'filtered_news', {
          symbol,
          phase: blackout.phase,
          event: blackout.event.event,
          currency: blackout.event.currency,
        })
        return { ok: false, outcome: {} }
      }
    }
  }

  // Build the order list. In AI mode we keep the original single-order shape;
  // manual mode delegates to the planner so filters / multi-TP / pip-derived
  // SL & TP / pending expiry / reverse all apply consistently.
  let entryChannelParams: ChannelActiveTradeParams | null = null
  let channelParamsRefreshedFromSignal = false
  let plan: PlannerResult
  if (isManual) {
    const rpe = resolvedParsedEntryPrice(parsed)
    const rzo = resolvedParsedEntryZone(parsed)
    let plannerParsed: PlannerParsedSignal = {
      action: parsed.action,
      symbol: parsed.symbol,
      entry_price: rpe,
      entry_zone_low: rzo?.lo ?? parsed.entry_zone_low,
      entry_zone_high: rzo?.hi ?? parsed.entry_zone_high,
      sl: parsed.sl,
      tp: parsed.tp,
      tp_unit: parsed.tp_unit,
      sl_unit: parsed.sl_unit,
      lot_size: parsed.lot_size,
      open_tp: parsed.open_tp,
      partial_close_fraction: parsed.partial_close_fraction,
      raw_instruction: parsed.raw_instruction,
    }
    if (signal.channel_id) {
      if (!liveEntryFast) {
        const resolved = await resolveEntryChannelStops(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountId: broker.id,
          symbol,
          plannerParsed,
          signalId: signal.id,
        })
        plannerParsed = resolved.plannerParsed
        entryChannelParams = resolved.channelParams
        channelParamsRefreshedFromSignal = parsedSignalHasExplicitStops(plannerParsed)
      } else if (parsedSignalHasExplicitStops(plannerParsed)) {
        entryChannelParams = await refreshChannelParamsFromSignal(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          symbol,
          plannerParsed,
        })
        channelParamsRefreshedFromSignal = entryChannelParams != null
      }
    }
    const planningManual = isManual
      && manual.range_trading === true
      && (manual.layering_mode === 'static' || manual.layering_mode === 'dynamic')
      ? { ...manual, layering_mode: 'legacy' as const }
      : manual
    plan = planManualOrders({
      parsed: plannerParsed,
      resolvedSymbol: symbol,
      baseOperation: op,
      manual: planningManual,
      channelKeywords,
      manualLot: baseLot,
      ctx: {
        point: params?.point ?? 0.00001,
        digits: params?.digits ?? 5,
        minLot: params?.minLot ?? 0.01,
        lotStep: params?.lotStep ?? 0.01,
        contractSize: params?.contractSize ?? null,
        stopsLevel: params?.stopsLevel ?? 0,
        freezeLevel: params?.freezeLevel ?? 0,
        defaultLot: Number(broker.default_lot_size ?? 0.01),
        lastBalance: broker.last_balance ?? null,
        liveBid: strictEntryPrefetch?.bid,
        liveAsk: strictEntryPrefetch?.ask,
      },
      commentPrefix,
      expertId: 909090,
      slippage: 20,
    })
  } else {
    const entryAnchor =
      resolvedParsedEntryPrice(parsed)
      ?? (() => {
        const z = resolvedParsedEntryZone(parsed)
        return z != null ? (z.lo + z.hi) / 2 : null
      })()
      ?? (Number.isFinite(strictEntryPrefetch?.bid) && Number.isFinite(strictEntryPrefetch?.ask)
        ? ((Number(strictEntryPrefetch!.bid) + Number(strictEntryPrefetch!.ask)) / 2)
        : null)
    const isBuy = isBuySideOp(String(op))
    const pipQuote = pipCalculator(
      symbol,
      params?.point ?? 0.00001,
      params?.digits ?? 5,
      params?.contractSize ?? null,
    )
    const pip = resolvePipSize({ symbol, brokerPipPrice: pipQuote.pipPrice })
    const tpInPips =
      parsed.tp_unit === 'pips' || channelKeywords?.additional?.tp_in_pips === true
    const slInPips =
      parsed.sl_unit === 'pips' || channelKeywords?.additional?.sl_in_pips === true

    let stoploss = parsed.sl ?? 0
    let takeprofit = parsed.tp?.[0] ?? 0
    if (entryAnchor != null && entryAnchor > 0) {
      if (slInPips && parsed.sl != null && Number.isFinite(parsed.sl) && parsed.sl > 0) {
        stoploss = convertPipOffsetToPrice({
          offset: parsed.sl,
          entryAnchor,
          isBuy,
          pipSize: pip,
        }) ?? 0
      }
      if (tpInPips && Array.isArray(parsed.tp) && parsed.tp.length) {
        const converted = convertPipOffsetsToPrices({
          offsets: parsed.tp,
          entryAnchor,
          isBuy,
          pipSize: pip,
        })
        takeprofit = converted[0] ?? 0
      }
    }

    plan = {
      orders: [{
        symbol,
        operation: op,
        volume: baseLot,
        price: resolvedParsedEntryPrice(parsed) ?? 0,
        stoploss,
        takeprofit,
        slippage: 20,
        comment: commentPrefix,
        expertID: 909090,
      }],
      delay_ms: 0,
    }
  }

  const plannedVirtualPendings = plan.virtualPendings ?? []
  if (plan.orders.length === 0 && plannedVirtualPendings.length === 0) {
    await ctx.logSendSkipped(signal, broker, plan.skip_reason ?? 'filtered', { symbol })
    // Nothing will be opened: release the dispatch claim so a later dispatch of
    // the same signal (message revision after a provider edit, retry, range wake)
    // can re-claim and execute. A stale claim left here permanently blocked
    // edited signals (entry_not_opened incident 30ec1794).
    await releaseSignalBrokerDispatchClaim(ctx.supabase, signal.id, broker.id)
    const entryStrict =
      isManual && plan.skip_reason === SKIP_REASON_SIGNAL_ENTRY_REQUIRED
    if (isManual && plan.skip_reason === SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED) {
      await logSignalRangeEntryNoPrice(ctx.supabase, signal, broker, parsed, symbol)
      return { ok: false, outcome: { signalRangeEntryRequiredSkip: true } }
    }
    return { ok: false, outcome: entryStrict ? { signalEntryRequiredSkip: true } : {} }
  }

  if (plan.fallback_reason) {
    // Non-fatal: the planner had to soften its strategy (e.g. multi → single because
    // the per-leg target was below minLot). Surface the reason in worker logs and
    // also persist it for the trades UI.
    console.warn(
      `[tradeExecutor] plan_fallback signal=${signal.id} broker=${broker.id} symbol=${symbol} reason=${plan.fallback_reason}`,
    )
    const fallbackRow = {
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: broker.id,
      action: 'plan_fallback',
      status: 'success',
      request_payload: {
        reason: plan.fallback_reason,
        manual_lot: baseLot,
        target_leg: +(baseLot * ((Number(manual.multi_trade_leg_percent ?? 5)) / 100)).toFixed(4),
        min_lot: params?.minLot ?? null,
        lot_step: params?.lotStep ?? null,
        stops_level: params?.stopsLevel ?? null,
        freeze_level: params?.freezeLevel ?? null,
        symbol,
      } as unknown as Record<string, unknown>,
    }
    if (liveEntryFast) {
      void ctx.supabase.from('trade_execution_logs').insert(fallbackRow)
    } else {
      try {
        await ctx.supabase.from('trade_execution_logs').insert(fallbackRow)
      } catch {
        // Logging failure is non-fatal.
      }
    }
  }

  const channelDelayMs = Math.max(0, plan.delay_ms)
  const channelDelaySkipped = liveEntryFast && channelDelayMs > 0
  if (channelDelayMs > 0) {
    if (liveEntryFast) {
      console.log(
        `[tradeExecutor] live fast: skipping channel delay_msec=${channelDelayMs} signal=${signal.id} broker=${broker.id}`,
      )
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.min(channelDelayMs, 30_000)))
    }
  }

  // Hard cap: planner already respects 500; this is a final guard rail.
  // Total Open Trades (basketLegCap) must never be exceeded by immediates + layering.
  const basketLegCap = plan.rangeLayering?.basketLegCap
  const plannedImmediateLegs = plan.rangeLayering?.plannedImmediateLegs
  const absLegCap = basketLegCap != null && basketLegCap > 0
    ? Math.min(500, Math.floor(basketLegCap))
    : 500
  const capped = plan.orders.slice(0, absLegCap)
  if (capped.length < plan.orders.length) {
    console.warn(
      `[tradeExecutor] capped immediate legs ${plan.orders.length} → ${capped.length} signal=${signal.id} broker=${broker.id}`,
    )
  }
  let virtualPendings = plannedVirtualPendings.slice(0, 500)
  if (absLegCap < 500) {
    const immBudget = plannedImmediateLegs != null && plannedImmediateLegs >= 0
      ? plannedImmediateLegs
      : capped.length
    const maxVirtualByPlan = Math.max(0, absLegCap - immBudget)
    const maxVirtualByTickets = Math.max(0, absLegCap - capped.length)
    const maxVirtual = Math.min(maxVirtualByPlan, maxVirtualByTickets)
    if (virtualPendings.length > maxVirtual) {
      console.warn(
        `[tradeExecutor] trim virtual pendings ${virtualPendings.length}→${maxVirtual}`
        + ` basket_cap=${absLegCap} signal=${signal.id} broker=${broker.id}`,
      )
      virtualPendings = virtualPendings.slice(0, maxVirtual)
    }
  }
  const totalPlannedLegCount = capped.length + virtualPendings.length
  if (
    virtualPendings.length > 0
    && signal.channel_id
    && entryChannelParams
    && (
      channelParamsRefreshedFromSignal
      || !shouldPreferParsedStopsOnEntry(parsed)
    )
  ) {
    virtualPendings = applyChannelParamsToVirtualPendingList(
      virtualPendings,
      entryChannelParams,
      capped.length,
      manual.tp_lots,
      totalPlannedLegCount,
    )
  }

  // Always re-check materialization (including live-fast): claim is first line of
  // defense; this catches races where another worker already OrderSent.
  const already = await ctx.manualDispatchAlreadyMaterialized(signal.id, broker.id)
  if (already) {
    console.warn(
      `[tradeExecutor] skip duplicate entry dispatch signal=${signal.id} broker=${broker.id}`
      + ` liveFast=${liveEntryFast}`,
    )
    return { ok: false, outcome: { openedOrMerged: true } }
  }

  // ── Strict signal entry (post-delay live quote) ───────────────────────
  // Buy: immediate market only when ask ≤ entry; else one virtual pending at entry.
  // Sell: immediate only when bid ≥ entry; else virtual at entry. Quote failure → defer.
  let strictDeferred = false
  if (isManual && plan.strictEntry && api) {
    const se = plan.strictEntry
    const pipTol = Math.max(0, Number(manual.signal_entry_pip_tolerance ?? 0))
    const pipSize = plan.pip ?? params?.point ?? 0.00001
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      strictEntryPrefetch = q
      strictDeferred = !strictSignalEntryQuoteAllowsImmediate({
        isBuy: se.isBuy,
        entryPrice: se.entryPrice,
        bid: q.bid,
        ask: q.ask,
        tolerancePips: pipTol,
        pipSize,
      })
      if (strictDeferred) {
        console.log(
          `[tradeExecutor] strict entry deferred signal=${signal.id} broker=${broker.id} symbol=${symbol}`
          + ` entry=${se.entryPrice} isBuy=${se.isBuy} bid=${q.bid} ask=${q.ask}`,
        )
      }
    } catch (err) {
      strictDeferred = true
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] strict entry /Quote failed; deferring to broker pending signal=${signal.id} broker=${broker.id} symbol=${symbol}: ${msg}`,
      )
    }
  }

  let rangeEntryDeferred = false
  if (
    isManual
    && signalEntryRangeStrictEnabled(manual)
    && plan.rangeEntryWait
    && api
    && !strictDeferred
  ) {
    const wait = plan.rangeEntryWait
    const zoneFromParsed = resolvedParsedEntryZone(parsed)
    const waitToStore = zoneFromParsed
      ? { ...wait, zoneLo: zoneFromParsed.lo, zoneHi: zoneFromParsed.hi }
      : wait
    const pipSize = plan.pip ?? params?.point ?? 0.00001
    const fromWake = signal.dispatch_source === SIGNAL_RANGE_WAKE_DISPATCH_SOURCE
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      strictEntryPrefetch = q
      const stale = evaluatePreEntryStaleness({
        parsed,
        bid: q.bid,
        ask: q.ask,
        isBuy: wait.isBuy,
      })
      if (stale.stale && stale.reason) {
        const { data: waitRow } = await ctx.supabase
          .from('signal_range_entry_waits')
          .select('id')
          .eq('signal_id', signal.id)
          .eq('broker_account_id', broker.id)
          .eq('status', 'waiting')
          .maybeSingle()
        if (waitRow?.id) {
          await expireWait(ctx.supabase, {
            waitId: waitRow.id,
            signalId: signal.id,
            userId: signal.user_id,
            brokerAccountId: broker.id,
            reason: stale.reason,
            symbol,
            bid: q.bid,
            ask: q.ask,
          })
        }
        return {
          ok: false,
          outcome: { finalizeSkipReason: 'signal_entry_range_expired' },
        }
      }
      const allowed = evaluateWakeEligibility({
        wait: waitToStore,
        bid: q.bid,
        ask: q.ask,
        pipSize,
      })
      if (!allowed) {
        rangeEntryDeferred = true
        await upsertSignalRangeEntryWait(ctx.supabase, {
          signal,
          broker,
          uuid,
          symbol,
          wait: waitToStore,
          manual,
          parsed,
        })
        if (fromWake) {
          await logSignalRangeEntryWakeRetry(ctx.supabase, signal, broker.id, symbol, q.bid, q.ask)
        } else {
          await logSignalRangeEntryWaiting(
            ctx.supabase,
            signal,
            broker,
            waitToStore,
            symbol,
            q.bid,
            q.ask,
          )
        }
        console.log(
          `[tradeExecutor] signal range entry deferred signal=${signal.id} broker=${broker.id} symbol=${symbol}`
          + ` isBuy=${wait.isBuy} bid=${q.bid} ask=${q.ask} tol=${wait.tolerancePips}p fromWake=${fromWake}`,
        )
      }
    } catch (err) {
      rangeEntryDeferred = true
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] signal range entry /Quote failed; deferring signal=${signal.id} broker=${broker.id} symbol=${symbol}: ${msg}`,
      )
      await upsertSignalRangeEntryWait(ctx.supabase, {
        signal,
        broker,
        uuid,
        symbol,
        wait: waitToStore,
        manual,
        parsed,
      })
    }
  }

  if (rangeEntryDeferred) {
    await releaseSignalBrokerDispatchClaim(ctx.supabase, signal.id, broker.id)
    return {
      ok: false,
      outcome: { signalRangeEntryDeferred: true, channelDelayMs, channelDelaySkipped },
    }
  }

  const effectiveCapped = strictDeferred ? [] : capped

  if (!strictDeferred && plan.strictEntry) {
    for (const o of effectiveCapped) {
      if (o.operation === 'Buy' || o.operation === 'Sell') {
        o.price = 0
      }
    }
  }

  // Build immediate legs with rounded volumes. Immediates already carry the
  // planner's intended entry price (signal entry or zero for true market orders).
  //
  // The planner only ever emits a single-trade `partialTps` schedule when
  // `capped.length === 1` (single mode → one order). We attach it to that
  // single leg so the post-INSERT path can fan out the partials.
  const volumeRounded = effectiveCapped.map(o => ({ ...o, volume: roundLot(o.volume, params) }))
  const legs: Leg[] = volumeRounded.map((args, idx) => ({
    args,
    idx,
    ...(idx === 0 && plan.partialTps?.length ? { partialTps: plan.partialTps } : {}),
    ...(plan.autoBeTpHitTriggerPrice != null
      ? { autoBeTpHitTriggerPrice: plan.autoBeTpHitTriggerPrice }
      : {}),
  }))

  // Single trade style: one broker order only (partials ride on partial_tp_legs).
  // If the planner somehow emitted multiple immediates, hard-block rather than
  // silently sending the first leg (that masked config/planner bugs).
  if (isManual && manual.trade_style !== 'multi' && legs.length > 1) {
    console.error(
      `[tradeExecutor] single trade_style multi_leg_blocked ${legs.length} legs`
      + ` signal=${signal.id} broker=${broker.id}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'single_style_multi_leg_blocked',
        status: 'failed',
        request_payload: { leg_count: legs.length } as unknown as Record<string, unknown>,
        error_message: `single trade_style refused ${legs.length} immediate legs`,
      })
    } catch { /* best-effort */ }
    return {
      ok: false,
      outcome: {
        channelDelayMs,
        channelDelaySkipped,
        failureReason: 'single_style_multi_leg_blocked',
      },
    }
  }

  // ── Anchor resolution ────────────────────────────────────────────────
  // Priority: parsed signal entry → live /Quote (Ask for buy, Bid for sell).
  // Needed whenever we have virtual pendings to persist (so we can compute trigger prices).
  // The Quote is a ~50-150ms GET that we issue BEFORE sending immediates so every
  // leg + every virtual trigger sees the same deterministic reference price.
  // Live fast + immediate legs: defer virtual-only anchor work until after OrderSend.
  const deferVirtualAnchor = liveEntryFast
    && legs.length > 0
    && virtualPendings.length > 0
  const brokerRangePendingMode = manual.range_layering_type === 'pending_order'
  const deferBrokerRangePendingMaterialize = brokerRangePendingMode
    && virtualPendings.length > 0
    && legs.length > 0
  const needsAnchor = !deferVirtualAnchor
    && !deferBrokerRangePendingMaterialize
    && virtualPendings.length > 0
  let anchor: number | null = plan.anchor?.value ?? plan.strictEntry?.entryPrice ?? null
  let anchorSource: 'signal' | 'quote' | 'unknown' = plan.anchor?.source ?? 'unknown'
  if (needsAnchor && (anchor == null || anchor <= 0)) {
    const parsedEntry = resolvedParsedEntryPrice(parsed)
    if (parsedEntry != null && parsedEntry > 0) {
      anchor = parsedEntry
      anchorSource = 'signal'
    } else if (api && !liveEntryFast) {
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      if (!strictEntryPrefetch) strictEntryPrefetch = q
      anchor = plan.isBuy === false ? q.bid : q.ask
      anchorSource = 'quote'
      console.log(
        `[tradeExecutor] quote anchor signal=${signal.id} broker=${broker.id} symbol=${symbol} bid=${q.bid} ask=${q.ask} anchor=${anchor}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] /Quote failed for ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
      )
    }
    } else if (api && liveEntryFast) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        if (!strictEntryPrefetch) strictEntryPrefetch = q
        anchor = plan.isBuy === false ? q.bid : q.ask
        anchorSource = 'quote'
      } catch {
        /* virtual ladder may drop without anchor */
      }
    }
  }

  if (isManual) {
    // One-line plan summary so it's obvious whether Range Trading / CWE are
    // actually firing, and at which anchor. Helps debug "settings not applying".
    const point = Number(params?.point) || 0
    const stopsLevel = Number(params?.stopsLevel) || 0
    const freezeLevel = Number(params?.freezeLevel) || 0
    const pipValue = plan.pipQuote?.pipValuePerStdLot
    const contractSize = plan.pipQuote?.contractSize
    const quoteCcy = plan.pipQuote?.quoteCurrency ?? ''
    const partialCount = plan.partialTps?.length ?? 0
    let rangeLayerLog = ''
    if (plan.rangeLayering) {
      const rl = plan.rangeLayering
      rangeLayerLog = ` range_step=${rl.rangeStepPips} range_dist=${rl.rangeDistancePips}`
        + ` eff_step=${rl.effectiveStepPips} step_offset=${rl.stepPriceOffset}`
        + ` max_step_idx=${rl.maxStepIdx} reserved_pending=${rl.reservedPendingLegs} active_pending=${rl.activePendingLegs}`
      if (anchor != null && virtualPendings.length > 0) {
        const logDigits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
        const first = triggerPriceFor(virtualPendings[0]!, anchor, logDigits)
        const last = triggerPriceFor(virtualPendings[virtualPendings.length - 1]!, anchor, logDigits)
        rangeLayerLog += ` trigger_first=${first} trigger_last=${last}`
      }
    }
    console.log(
      `[tradeExecutor] manual plan signal=${signal.id} broker=${broker.id} symbol=${symbol}`
      + ` style=${manual.trade_style ?? 'single'} legs=${legs.length + virtualPendings.length}`
      + ` (immediate=${legs.length}, virtual_pending=${virtualPendings.length}${partialCount > 0 ? `, partial_tp=${partialCount}` : ''})`
      + ` rangeOn=${manual.range_trading === true}`
      + ` pip=${plan.pip ?? 'n/a'}`
      + (pipValue != null ? ` pipValue=${pipValue.toFixed(4)}${quoteCcy ? '_' + quoteCcy : ''}/lot` : '')
      + (contractSize != null ? ` contractSize=${contractSize}` : '')
      + ` anchorSource=${anchorSource} anchor=${anchor ?? 'n/a'}`
      + ` stops_level=${stopsLevel} freeze_level=${freezeLevel} point=${point}`
      + rangeLayerLog
      + (plan.fallback_reason ? ` fallback=${plan.fallback_reason}` : ''),
    )
  }


  return {
    ok: true,
    prep: {
      ctx,
      signal,
      parsed,
      broker,
      manual,
      api,
      uuid,
      symbol,
      requestedSymbol,
      mapping,
      params,
      liveEntryFast,
      pipelineT0,
      strictEntryPrefetch,
      commentPrefix,
      channelDelayMs,
      channelDelaySkipped,
      plan,
      capped,
      virtualPendings,
      legs,
      deferVirtualAnchor,
      deferBrokerRangePendingMaterialize,
      strictDeferred,
      op,
      channelKeywords,
      baseLot,
      anchor,
      anchorSource,
      isManual,
    },
  }
}
