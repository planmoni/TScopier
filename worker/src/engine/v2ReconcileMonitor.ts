/**
 * v2 reconcile monitor (Phase 5/6, management-first cutover).
 *
 * ONE loop that drives every open basket on a v2-flagged broker toward its desired
 * state, replacing the competing v1 appliers (basketSlTpReconcileMonitor jobs,
 * channelStopApply, slTpRefresh, live mgmt modifies) for those brokers. Because only
 * this loop touches v2 baskets, the "SL reverts / flip-flops" class of bug - caused by
 * multiple appliers racing with stale data - cannot happen.
 *
 * Desired state is the instruction-ordered `basket_sl_tp_targets` row (written by the
 * existing management path). The loop:
 *   desired + open legs (trades) + broker snapshot (fxClient.OpenedOrders)
 *   -> buildDesiredLegTargets (pure) -> computeReconcileActions (pure)
 *   -> applyReconcileActions (strict fxClient, SL-first fallback)
 *
 * Safety: only drifted legs are modified (idempotent no-op when synced); present TPs
 * are never repainted (kept as-is), so a hit-then-retrace can't re-arm a taken TP;
 * vanished legs are marked closed in the DB (no broker action); orphan adoption is
 * log-only on the first run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { FxClient, getFxClient, type MtPlatform } from './fxClient'
import type { FxOpenOrder } from './fxContract'
import {
  applyReconcileActions,
  computeReconcileActions,
  type DesiredLegTarget,
} from './reconciler'
import { type BasketOpenLeg, closeStaleOpenTrades, loadOpenBasketLegs } from '../basketSlTpReconcile'
import { stripInvalidStopsForSide } from '../channelActiveTradeParams'
import {
  basketHasAutoBreakeven,
  isExplicitBasketSlSource,
  resolveEffectiveBasketStops,
  type EffectiveStopSource,
} from '../basketEffectiveStops'
import { breakevenStopLossForSymbol } from '../autoManagement'
import { brokerSessionUuid } from '../tradeExecutor/helpers'
import { hasFxsocketConfigured } from '../fxsocketClient'
import { purgeRangePendingLegsForBaskets } from '../rangePendingLegDelete'
import { isV2 } from './executionMode'
import type { PerLegStopTarget } from '../multiTradeMerge'
import {
  detectManualBrokerStopOverridesDetailed,
  notifyManualBrokerOverrideReverted,
} from '../manualBrokerOverrideNotification'

const TICK_MS = Math.min(60_000, Math.max(1_000, Number(process.env.V2_RECONCILE_TICK_MS ?? 4_000)))
const MANUAL_OVERRIDE_LOG_PREFIX = '[MANUAL_OVERRIDE_NOTIFY]'

function legTicket(leg: BasketOpenLeg): number | null {
  const t = Number(leg.metaapi_order_id)
  return Number.isFinite(t) && t > 0 ? t : null
}

function deepestTp(tpLevels: number[], isBuy: boolean): number | null {
  if (!tpLevels.length) return null
  // Deepest = farthest target: highest for buy, lowest for sell.
  return isBuy ? Math.max(...tpLevels) : Math.min(...tpLevels)
}

function tpInLadder(tp: number, levels: number[]): boolean {
  return levels.some(l => Math.abs(l - tp) < 1e-6)
}

/** Map a stale TP to the nearest level on the revised ladder (message-edit self-heal). */
export function closestLadderTp(tp: number, levels: number[]): number | null {
  if (!levels.length) return null
  let best = levels[0]!
  let bestDist = Math.abs(tp - best)
  for (const l of levels) {
    const d = Math.abs(tp - l)
    if (d < bestDist) {
      best = l
      bestDist = d
    }
  }
  return best
}

/**
 * Pure: compute the per-leg SL/TP the basket SHOULD have right now, given the
 * basket-level effective SL/TP (resolved upstream by v1's resolveEffectiveBasketStops,
 * which already merges target store + channel memory + latest mgmt instruction).
 *  - SL: the effective basket SL applied to every leg, EXCEPT a leg in a basket
 *    that is at breakeven (auto-breakeven OR manual channel breakeven, both stamp
 *    auto_be_applied_at). Those legs keep an entry-relative SL so a multi-entry
 *    range basket is never collapsed onto one shared breakeven SL — UNLESS the
 *    effective SL comes from an explicit, newer instruction (basket_target /
 *    mgmt_signal); then the latest instruction wins for the whole basket.
 *  - TP: the DB leg's TP is the basket's INTENDED per-leg target (set by the
 *    distributed plan, a management modify, or the merge apply) and is authoritative
 *    over the live broker snapshot. Preferring it (a) stops a reconcile tick that
 *    races an in-flight distribution from collapsing every leg to the deepest ladder
 *    TP when a leg still looks naked on the broker, and (b) lets the tick SELF-HEAL
 *    broker drift back to the intended distributed TP instead of getting stuck on a
 *    once-applied deepest TP. Order: intended DB TP > live broker TP > deepest ladder
 *    TP (only for a leg that is genuinely naked everywhere). A hit TP closes its leg,
 *    so an open leg's intended TP is never a taken target.
 */
function perLegEntryBreakevenSl(leg: BasketOpenLeg, isBuy: boolean): number | null {
  const entry = Number(leg.entry_price)
  if (!Number.isFinite(entry) || entry <= 0) return null
  const offsetRaw = leg.auto_be_offset_pips
  const offset = offsetRaw == null ? null : Number(offsetRaw)
  if (offset == null || !Number.isFinite(offset) || offset < 0) return null
  const sl = breakevenStopLossForSymbol({
    isBuy,
    entryPrice: entry,
    manual: { breakeven_offset_pips: offset },
    symbol: leg.symbol,
  })
  return Number.isFinite(sl) && sl > 0 ? sl : null
}

export function buildDesiredLegTargets(args: {
  legs: BasketOpenLeg[]
  snapshot: FxOpenOrder[]
  effectiveSl: number | null
  effectiveTpLevels: number[]
  isBuy: boolean
  /** Source of effectiveSl; explicit instructions (basket_target/mgmt_signal) win over per-leg BE. */
  effectiveSource?: EffectiveStopSource
  /** Per-basket target store source when effectiveSource is basket_target. */
  basketTargetSource?: string
}): DesiredLegTarget[] {
  const byTicket = new Map<number, FxOpenOrder>()
  for (const o of args.snapshot) byTicket.set(o.ticket, o)
  const baseSl = args.effectiveSl != null && args.effectiveSl > 0 ? args.effectiveSl : null
  const explicitBasketInstruction = isExplicitBasketSlSource(args.effectiveSource)
  const explicitAdjustRevision =
    (args.effectiveSource === 'basket_target' && args.basketTargetSource === 'adjust')
    || args.effectiveSource === 'user_override'
  const basketAtAutoBe = basketHasAutoBreakeven(args.legs)
  const siblingOffset = args.legs
    .map(l => Number(l.auto_be_offset_pips))
    .find(n => Number.isFinite(n) && n >= 0)

  const out: DesiredLegTarget[] = []
  for (const leg of args.legs) {
    const ticket = legTicket(leg)
    if (ticket == null) continue
    const o = byTicket.get(ticket)
    if (!o) continue // not at broker -> reconciler closedTickets handles it

    let sl = baseSl
    const computedBe = perLegEntryBreakevenSl(
      siblingOffset != null && leg.auto_be_offset_pips == null
        ? { ...leg, auto_be_offset_pips: siblingOffset }
        : leg,
      args.isBuy,
    )
    const beSl = leg.auto_be_applied_at && leg.sl != null && leg.sl > 0 ? leg.sl : null
    if (!explicitBasketInstruction && (beSl != null || basketAtAutoBe)) {
      // Entry-relative BE wins over the basket most-protective SL. Recompute from
      // fill + offset when possible so a previously unified 4504.10 is restored.
      sl = computedBe ?? beSl ?? (leg.sl != null && leg.sl > 0 ? leg.sl : null)
    } else if (beSl != null) {
      sl = explicitBasketInstruction ? (baseSl ?? beSl) : beSl
    }

    const intendedTp = leg.tp != null && leg.tp > 0 ? leg.tp : null
    const existingTp = o.takeProfit != null && o.takeProfit > 0 ? o.takeProfit : null
    let fillTp: number | null
    if (explicitAdjustRevision && args.effectiveTpLevels.length > 0) {
      const staleTp = intendedTp ?? existingTp
      if (staleTp != null && !tpInLadder(staleTp, args.effectiveTpLevels)) {
        fillTp = closestLadderTp(staleTp, args.effectiveTpLevels)
      } else {
        fillTp = intendedTp ?? existingTp ?? deepestTp(args.effectiveTpLevels, args.isBuy)
      }
    } else {
      fillTp = intendedTp ?? existingTp ?? deepestTp(args.effectiveTpLevels, args.isBuy)
    }

    out.push({ ticket, stoploss: sl, takeProfit: fillTp })
  }
  return out
}

function filterDirectionallyValidModifies(
  modifies: { ticket: number; stoploss: number | null; takeProfit: number | null }[],
  snapshot: FxOpenOrder[],
  isBuy: boolean,
): typeof modifies {
  const byTicket = new Map<number, FxOpenOrder>()
  for (const o of snapshot) byTicket.set(o.ticket, o)
  return modifies.filter(m => {
    const o = byTicket.get(m.ticket)
    if (!o) return false
    const ref = o.openPrice ?? 0
    if (!Number.isFinite(ref) || ref <= 0) return true
    const wantSl = m.stoploss != null && m.stoploss > 0 ? m.stoploss : 0
    const wantTp = m.takeProfit != null && m.takeProfit > 0 ? m.takeProfit : 0
    if (wantSl === 0 && wantTp === 0) return false
    const stripped = stripInvalidStopsForSide({
      stoploss: wantSl,
      takeprofit: wantTp,
      referencePrice: ref,
      isBuy,
      symbol: o.symbol,
    })
    if (m.stoploss != null && m.stoploss > 0 && stripped.stoploss === 0) return false
    if (m.takeProfit != null && m.takeProfit > 0 && stripped.takeprofit === 0) return false
    return true
  })
}

type BasketKey = { brokerAccountId: string; anchorSignalId: string; symbol: string; isBuy: boolean }

type BrokerSession = { uuid: string; platform: MtPlatform; userId: string | null }

function perLegTargetsForManualOverrideDetection(
  legs: BasketOpenLeg[],
  desiredTargets: DesiredLegTarget[],
): PerLegStopTarget[] {
  const desiredByTicket = new Map(desiredTargets.map(t => [t.ticket, t]))
  return legs.map(leg => {
    const ticket = legTicket(leg)
    const desired = ticket == null ? null : desiredByTicket.get(ticket)
    return {
      stoploss: desired?.stoploss ?? 0,
      takeprofit: desired?.takeProfit ?? 0,
    }
  })
}

/** The single management-first reconcile loop for v2 brokers. */
export class V2ReconcileMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private fx: FxClient

  constructor(private readonly supabase: SupabaseClient, fx?: FxClient) {
    this.fx = fx ?? getFxClient()
  }

  start(): void {
    if (this.timer) return
    if (!hasFxsocketConfigured() && !process.env.FXSOCKET_API_KEY) {
      console.warn('[v2ReconcileMonitor] FxSocket not configured — disabled')
      return
    }
    this.timer = setInterval(() => void this.runTick(), TICK_MS)
    console.log(`[v2ReconcileMonitor] started tick=${TICK_MS}ms (v2 brokers only)`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } catch (err) {
      console.warn(`[v2ReconcileMonitor] tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.ticking = false
    }
  }

  /** Enumerate v2 baskets, then reconcile each. */
  async tick(): Promise<{ baskets: number; modified: number; closed: number }> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('broker_account_id,signal_id,symbol,direction')
      .eq('status', 'open')
      .limit(5000)
    if (error || !data) return { baskets: 0, modified: 0, closed: 0 }

    const baskets = new Map<string, BasketKey>()
    for (const r of data as Array<{ broker_account_id: string; signal_id: string; symbol: string; direction: string }>) {
      if (!r.broker_account_id || !r.signal_id) continue
      if (!isV2({ brokerAccountId: r.broker_account_id })) continue
      const key = `${r.broker_account_id}|${r.signal_id}|${r.symbol}`
      if (!baskets.has(key)) {
        baskets.set(key, {
          brokerAccountId: r.broker_account_id,
          anchorSignalId: r.signal_id,
          symbol: r.symbol,
          isBuy: String(r.direction).toLowerCase().startsWith('buy'),
        })
      }
    }

    const sessions = await this.loadSessions([...baskets.values()].map(b => b.brokerAccountId))
    let modified = 0
    let closed = 0
    for (const basket of baskets.values()) {
      const session = sessions.get(basket.brokerAccountId)
      if (!session) continue
      const res = await this.reconcileBasket(basket, session).catch(() => null)
      if (res) { modified += res.modified; closed += res.closed }
    }
    return { baskets: baskets.size, modified, closed }
  }

  private async loadSessions(brokerIds: string[]): Promise<Map<string, BrokerSession>> {
    const out = new Map<string, BrokerSession>()
    const unique = [...new Set(brokerIds)]
    if (!unique.length) return out
    const { data } = await this.supabase
      .from('broker_accounts')
      .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform')
      .in('id', unique)
    for (const b of (data ?? []) as Array<{ id: string; user_id?: string; fxsocket_account_id?: string; metaapi_account_id?: string; platform?: string }>) {
      const uuid = brokerSessionUuid(b)
      if (!uuid) continue
      const platform: MtPlatform = String(b.platform).toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
      out.set(b.id, { uuid, platform, userId: b.user_id ?? null })
    }
    return out
  }

  private async reconcileBasket(basket: BasketKey, session: BrokerSession): Promise<{ modified: number; closed: number }> {
    const legs = await loadOpenBasketLegs(this.supabase, basket.brokerAccountId, basket.anchorSignalId, basket.symbol)
    if (!legs.length) return { modified: 0, closed: 0 }

    // Resolve the basket's effective SL/TP exactly like v1 (target store + channel
    // memory + latest mgmt instruction + auto-BE recency) so merged baskets and
    // channel-memory adjustments are honored - not just the raw target-store row.
    const { data: anchorSig } = await this.supabase
      .from('signals')
      .select('parsed_data, channel_id, user_id, created_at')
      .eq('id', basket.anchorSignalId)
      .maybeSingle()
    const anchorParsed = (anchorSig as { parsed_data?: { sl?: number | null; tp?: number[] | null } } | null)?.parsed_data ?? {}
    const eff = await resolveEffectiveBasketStops({
      supabase: this.supabase,
      userId: (anchorSig as { user_id?: string } | null)?.user_id ?? session.userId ?? '',
      channelId: (anchorSig as { channel_id?: string | null } | null)?.channel_id ?? null,
      anchorSignalId: basket.anchorSignalId,
      symbol: basket.symbol,
      basketCreatedAt: (anchorSig as { created_at?: string | null } | null)?.created_at ?? legs[0]?.opened_at ?? null,
      anchorParsed: { sl: anchorParsed.sl ?? null, tp: anchorParsed.tp ?? null },
      familyTrades: legs,
      brokerAccountId: basket.brokerAccountId,
    }).catch(() => null)

    // SAFETY: the broker snapshot is the source of truth for "is this leg still open?".
    // If the fetch FAILS we must NOT proceed - an empty list would be read as
    // "every leg vanished" and wrongly mark all legs closed in the DB. Abort instead.
    let snapshot: FxOpenOrder[]
    try {
      snapshot = await this.fx.openedOrders(session.uuid, session.platform)
    } catch (err) {
      console.warn(`[v2ReconcileMonitor] snapshot failed broker=${basket.brokerAccountId} anchor=${basket.anchorSignalId} — skipping (no close): ${err instanceof Error ? err.message : String(err)}`)
      return { modified: 0, closed: 0 }
    }

    const desiredTargets = buildDesiredLegTargets({
      legs,
      snapshot,
      effectiveSl: eff && eff.stoploss > 0 ? eff.stoploss : null,
      effectiveTpLevels: eff?.tpLevels ?? [],
      isBuy: basket.isBuy,
      effectiveSource: eff?.source,
      basketTargetSource: eff?.basketTargetSource,
    })
    const trackedTickets = legs.map(legTicket).filter((t): t is number => t != null)

    const actions = computeReconcileActions({
      desired: desiredTargets,
      openOrders: snapshot,
      trackedTickets,
    })
    actions.modifies = filterDirectionallyValidModifies(actions.modifies, snapshot, basket.isBuy)
    // Orphan adoption is log-only on the first management-first run.
    const orphanCount = actions.adopt.length
    actions.adopt = []

    const manualBrokerOverrideDetection = actions.modifies.length > 0
      ? detectManualBrokerStopOverridesDetailed({
          familyTrades: legs,
          perLegTargets: perLegTargetsForManualOverrideDetection(legs, desiredTargets),
          ordersByTicket: new Map(snapshot.map(order => [order.ticket, order])),
          nImmCwe: 0,
        })
      : null
    if (manualBrokerOverrideDetection) {
      if (manualBrokerOverrideDetection.overrides.length > 0) {
        console.log(`${MANUAL_OVERRIDE_LOG_PREFIX} v2 candidate signal=${basket.anchorSignalId} broker=${basket.brokerAccountId} symbol=${basket.symbol} overrides=${manualBrokerOverrideDetection.overrides.length}`)
      } else {
        const reasons = [...new Set(manualBrokerOverrideDetection.rejectedReasons.map(r => r.reason))].join(',') || 'none'
        console.log(`${MANUAL_OVERRIDE_LOG_PREFIX} v2 skipped signal=${basket.anchorSignalId} broker=${basket.brokerAccountId} symbol=${basket.symbol} reason=${reasons}`)
      }
    }
    // SAFETY: never mass-close a basket off an empty snapshot. A disconnected
    // FxSocket session can return an empty (but successful) OpenedOrders list; that
    // must not be read as "all legs closed". Only honor closes when the snapshot
    // actually shows other open orders (a real account picture).
    if (snapshot.length === 0 && actions.closedTickets.length > 0) {
      console.warn(`[v2ReconcileMonitor] empty snapshot with ${actions.closedTickets.length} tracked legs broker=${basket.brokerAccountId} anchor=${basket.anchorSignalId} — deferring close (suspected disconnect)`)
      actions.closedTickets = []
    }

    const ticketToTradeId = new Map<number, string>()
    for (const leg of legs) {
      const t = legTicket(leg)
      if (t != null) ticketToTradeId.set(t, leg.id)
    }

    const result = await applyReconcileActions(
      {
        fx: this.fx,
        accountId: session.uuid,
        platform: session.platform,
        markClosed: async ticket => {
          const id = ticketToTradeId.get(ticket)
          if (id) await closeStaleOpenTrades(this.supabase, [id])
        },
        adoptOrphan: async () => {},
      },
      actions,
    )

    if (result.closed > 0) {
      await purgeRangePendingLegsForBaskets(
        this.supabase,
        [{ signalId: basket.anchorSignalId, brokerAccountId: basket.brokerAccountId }],
        'basket_flat_reconcile',
      )
    }

    const successfulModifiedTickets = new Set(result.modifiedTickets)
    const restoredManualBrokerOverrides = (manualBrokerOverrideDetection?.overrides ?? [])
      .filter(override => successfulModifiedTickets.has(override.ticket))
    if ((manualBrokerOverrideDetection?.overrides.length ?? 0) > 0 && restoredManualBrokerOverrides.length === 0) {
      console.log(`${MANUAL_OVERRIDE_LOG_PREFIX} v2 skipped signal=${basket.anchorSignalId} broker=${basket.brokerAccountId} symbol=${basket.symbol} reason=no_successful_restore modified=${result.modified} failed=${result.modifyFailed}`)
    }
    if (restoredManualBrokerOverrides.length > 0) {
      const userId = (anchorSig as { user_id?: string } | null)?.user_id ?? session.userId
      if (!userId) {
        console.log(`${MANUAL_OVERRIDE_LOG_PREFIX} v2 skipped signal=${basket.anchorSignalId} broker=${basket.brokerAccountId} symbol=${basket.symbol} reason=no_user`)
      } else {
        const emitted = await notifyManualBrokerOverrideReverted({
          supabase: this.supabase,
          userId,
          brokerAccountId: basket.brokerAccountId,
          anchorSignalId: basket.anchorSignalId,
          sourceSignalId: basket.anchorSignalId,
          channelId: (anchorSig as { channel_id?: string | null } | null)?.channel_id ?? null,
          symbol: basket.symbol,
          direction: basket.isBuy ? 'buy' : 'sell',
          overrides: restoredManualBrokerOverrides,
          reconcileJobId: `v2:${basket.brokerAccountId}:${basket.anchorSignalId}:${basket.symbol}`,
          restoredTradeIds: restoredManualBrokerOverrides.map(override => override.tradeId),
        })
        if (emitted) {
          console.log(`${MANUAL_OVERRIDE_LOG_PREFIX} v2 emitted signal=${basket.anchorSignalId} broker=${basket.brokerAccountId} symbol=${basket.symbol} restored=${restoredManualBrokerOverrides.length}`)
        }
      }
    }

    if (result.modified > 0 || result.closed > 0 || result.modifyFailed > 0 || orphanCount > 0) {
      const logResult: Record<string, unknown> = { ...result }
      delete logResult.modifiedTickets
      await this.logTick(basket, session.userId, { ...logResult, legs: legs.length, orphanCount })
    }
    return { modified: result.modified, closed: result.closed }
  }

  private async logTick(
    basket: BasketKey,
    userId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!userId) return
    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: userId,
        signal_id: basket.anchorSignalId,
        broker_account_id: basket.brokerAccountId,
        action: 'v2_reconcile_tick',
        status: (payload.modifyFailed as number) > 0 ? 'failed' : 'success',
        request_payload: {
          anchor_signal_id: basket.anchorSignalId,
          symbol: basket.symbol,
          ...payload,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }
  }
}
