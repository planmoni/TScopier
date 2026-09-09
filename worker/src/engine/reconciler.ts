/**
 * Reconciler (Phase 3) - ONE loop that drives every open basket toward its desired
 * state, replacing the old monitor zoo (basketSlTpReconcileMonitor, channelStopApply,
 * slTpRefresh, most of managementExecutor, basket_reconcile_jobs).
 *
 * Each tick, per basket:
 *   desired (basketStore) + tracked legs (trades) + broker snapshot (OpenedOrders)
 *   -> computeReconcileActions -> minimal idempotent diff:
 *     - modify: only legs whose broker SL/TP differ from desired (no-op when synced)
 *     - adopt:  broker positions with our magic not in trades (orphans from lost acks)
 *     - close:  tracked-open legs no longer at the broker (closed externally / by TP/SL)
 *
 * The diff is a pure function (fully unit-tested); the applier executes it via the
 * strict FxClient. No competing re-appliers, no blind re-modify loops.
 */
import type { FxClient, MtPlatform } from './fxClient'
import { type FxOpenOrder, isInvalidStopsRetcode, TSCOPIER_MAGIC } from './fxContract'

export type DesiredLegTarget = {
  ticket: number
  stoploss: number | null
  takeProfit: number | null
}

export type ReconcileActions = {
  modifies: { ticket: number; stoploss: number | null; takeProfit: number | null }[]
  adopt: FxOpenOrder[]
  closedTickets: number[]
}

function approxEq(a: number | null, b: number | null, eps: number): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return Math.abs(a - b) <= eps
}

/**
 * Pure diff: what minimal set of broker actions brings the basket to desired state?
 * A leg is only modified when a desired side (SL or TP) differs from the broker by
 * more than `epsilon`; if both already match, nothing is emitted (idempotent no-op).
 */
export function computeReconcileActions(args: {
  desired: DesiredLegTarget[]
  openOrders: FxOpenOrder[]
  trackedTickets: number[]
  ourMagic?: number
  /** When false (e.g. a TP was hit), do not repaint TP - only sync SL. */
  allowTpModify?: boolean
  epsilon?: number
}): ReconcileActions {
  const eps = args.epsilon ?? 1e-6
  const magic = args.ourMagic ?? TSCOPIER_MAGIC
  const allowTp = args.allowTpModify !== false
  const openByTicket = new Map<number, FxOpenOrder>()
  for (const o of args.openOrders) openByTicket.set(o.ticket, o)

  const modifies: ReconcileActions['modifies'] = []
  for (const d of args.desired) {
    const o = openByTicket.get(d.ticket)
    if (!o) continue // not at broker -> handled by closedTickets below
    const wantSl = d.stoploss != null && d.stoploss > 0 ? d.stoploss : null
    const wantTp = allowTp && d.takeProfit != null && d.takeProfit > 0 ? d.takeProfit : null
    const slDrift = wantSl != null && !approxEq(o.stopLoss, wantSl, eps)
    const tpDrift = wantTp != null && !approxEq(o.takeProfit, wantTp, eps)
    if (slDrift || tpDrift) {
      modifies.push({ ticket: d.ticket, stoploss: slDrift ? wantSl : null, takeProfit: tpDrift ? wantTp : null })
    }
  }

  const tracked = new Set(args.trackedTickets)
  const closedTickets = args.trackedTickets.filter(t => !openByTicket.has(t))
  const adopt = args.openOrders.filter(o => !tracked.has(o.ticket) && o.magic === magic)

  return { modifies, adopt, closedTickets }
}

export type ApplyReconcileDeps = {
  fx: FxClient
  accountId: string
  platform: MtPlatform
  /** Mark a tracked leg closed in trades (ticket no longer at broker). */
  markClosed: (ticket: number) => Promise<void>
  /** Record an orphan broker position into trades (adoption). */
  adoptOrphan: (order: FxOpenOrder) => Promise<void>
}

export type ApplyReconcileResult = {
  modified: number
  modifiedTickets: number[]
  modifyFailed: number
  closed: number
  adopted: number
}

/** Execute a computed diff via the strict client. SL-first on INVALID_STOPS so a bad
 * TP never blocks the protective SL. Modifies run within the client's per-terminal gate. */
export async function applyReconcileActions(
  deps: ApplyReconcileDeps,
  actions: ReconcileActions,
): Promise<ApplyReconcileResult> {
  let modified = 0
  const modifiedTickets: number[] = []
  let modifyFailed = 0

  for (const m of actions.modifies) {
    const combined = await deps.fx.orderModify(deps.accountId, deps.platform, {
      ticket: m.ticket,
      stopLoss: m.stoploss ?? undefined,
      takeProfit: m.takeProfit ?? undefined,
    })
    if (combined.ok) { modified++; modifiedTickets.push(m.ticket); continue }
    // If the combined modify was rejected for stops/price, protect the SL alone.
    if (isInvalidStopsRetcode(combined.retcode) && m.stoploss != null && m.takeProfit != null) {
      const slOnly = await deps.fx.orderModify(deps.accountId, deps.platform, { ticket: m.ticket, stopLoss: m.stoploss })
      if (slOnly.ok) { modified++; modifiedTickets.push(m.ticket); continue }
    }
    modifyFailed++
  }

  let closed = 0
  for (const ticket of actions.closedTickets) {
    await deps.markClosed(ticket).then(() => { closed++ }).catch(() => {})
  }

  let adopted = 0
  for (const o of actions.adopt) {
    await deps.adoptOrphan(o).then(() => { adopted++ }).catch(() => {})
  }

  return { modified, modifiedTickets, modifyFailed, closed, adopted }
}
