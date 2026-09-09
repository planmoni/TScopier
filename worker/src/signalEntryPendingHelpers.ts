import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'

export type SignalEntryPendingRow = {
  id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  trade_id: string | null
  broker_ticket: string
  is_buy: boolean
}

export function rawOrderTicket(o: Record<string, unknown>): number {
  const t = Number(
    o.ticket
    ?? o.Ticket
    ?? o.order
    ?? o.Order
    ?? o.orderId
    ?? o.OrderID
    ?? o.deal
    ?? o.Deal
    ?? 0,
  )
  return Number.isFinite(t) ? t : 0
}

export function rawOrderOperation(o: Record<string, unknown>): string {
  return String(o.operation ?? o.Operation ?? '').toLowerCase()
}

export function rawNumericOrderKind(o: Record<string, unknown>): number | undefined {
  const pick = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return undefined
  }
  return pick(o.type ?? o.Type ?? o.orderType ?? o.OrderType ?? o.cmd ?? o.Cmd)
}

/**
 * True when /OpenedOrders row is a pending stop/limit entry (not a net position row).
 *
 * MetaTrader / REST shims often omit "limit" from `operation` and only send a
 * numeric `type` / `orderType` (MT4: BuyLimit=2, SellLimit=3, BuyStop=4, SellStop=5).
 * Missing that caused false "fills" while the broker pending was still live — then
 * `partialTpMonitor` called /OrderClose on the pending ticket and cancelled it.
 */
export function isPendingEntryRow(o: Record<string, unknown>): boolean {
  const op = rawOrderOperation(o)
  if (op.includes('limit') || op.includes('stop')) return true
  const ot = String(o.orderType ?? o.OrderType ?? '').toLowerCase()
  if (ot.includes('limit') || ot.includes('stop')) return true
  const t = rawNumericOrderKind(o)
  if (t != null && t >= 2 && t <= 5) return true
  if (o.pending === true || o.isPending === true) return true
  const st = String(o.state ?? o.State ?? '').toLowerCase()
  if (st === 'placed') return true
  return false
}

/**
 * True when the row looks like an executed market **position** in /OpenedOrders,
 * not a resting pending. Used to avoid treating ambiguous API rows as fills.
 */
export function isLikelyMarketPositionRow(o: Record<string, unknown>): boolean {
  if (isPendingEntryRow(o)) return false
  const op = rawOrderOperation(o).replace(/\s+/g, '')
  if (op.includes('limit') || op.includes('stop')) return false
  if (op === 'buy' || op === 'sell') return true
  const t = rawNumericOrderKind(o)
  if (t === 0 || t === 1) return true
  return false
}

export function findOpenedRowByTicket(orders: unknown[], ticket: number): Record<string, unknown> | null {
  if (!Number.isFinite(ticket) || ticket <= 0) return null
  for (const raw of orders ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    if (rawOrderTicket(o) === ticket) return o
  }
  return null
}

/** Read SL from /OpenedOrders rows (FxSocket often uses camelCase `stopLoss`). */
export function readBrokerOrderStopLoss(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  for (const key of [
    'stopLoss',
    'StopLoss',
    'stoploss',
    'Stoploss',
    'sl',
    'SL',
    'stop_loss',
  ]) {
    const v = o[key]
    if (v === null || v === undefined || v === '') continue
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/** Read TP from /OpenedOrders rows (FxSocket often uses camelCase `takeProfit`). */
export function readBrokerOrderTakeProfit(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  for (const key of [
    'takeProfit',
    'TakeProfit',
    'takeprofit',
    'Takeprofit',
    'tp',
    'TP',
    'take_profit',
  ]) {
    const v = o[key]
    if (v === null || v === undefined || v === '') continue
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}
/**
 * Best-effort fill lookup in /ClosedOrders for a pending ticket that disappeared
 * from /OpenedOrders (limit filled or cancelled).
 */
export function findClosedRowForTicket(
  closed: unknown[],
  ticket: number,
): { openPrice?: number; profit?: number; state?: string; brokerTicket?: number } | null {
  if (!Number.isFinite(ticket) || ticket <= 0) return null
  for (const raw of closed ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    if (rawOrderTicket(o) !== ticket) continue
    const num = (v: unknown): number | undefined => {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string' && v.trim()) {
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
      }
      return undefined
    }
    const brokerTicket = rawOrderTicket(o)
    return {
      openPrice: num(o.openPrice ?? o.OpenPrice ?? o.price ?? o.Price ?? o.priceOpen ?? o.PriceOpen),
      profit: num(o.profit ?? o.Profit),
      state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
      brokerTicket: brokerTicket > 0 ? brokerTicket : undefined,
    }
  }
  return null
}

/**
 * Delete broker pending via OrderClose (MT REST convention for removing pendings)
 * and mark DB rows terminal.
 */
export async function cancelSignalEntryRowAtBroker(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient,
  row: SignalEntryPendingRow,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const uuid = row.metaapi_account_id
  const ticket = Number(row.broker_ticket)
  if (!Number.isFinite(ticket) || ticket <= 0) {
    return { ok: false, error: 'invalid_ticket' }
  }
  try {
    await api.orderClose(uuid, { ticket })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabase
      .from('signal_entry_pending_orders')
      .update({
        status: 'cancel_failed',
        error_message: msg,
        cancel_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'broker_pending')
    return { ok: false, error: msg }
  }

  const now = new Date().toISOString()
  await supabase
    .from('signal_entry_pending_orders')
    .update({
      status: 'cancelled',
      cancel_reason: reason,
      updated_at: now,
    })
    .eq('id', row.id)
    .eq('status', 'broker_pending')

  if (row.trade_id) {
    await supabase
      .from('trades')
      .update({ status: 'cancelled', closed_at: now })
      .eq('id', row.trade_id)
      .eq('status', 'pending')
  }

  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: row.user_id,
      signal_id: row.signal_id,
      broker_account_id: row.broker_account_id,
      action: 'signal_entry_pending_cancelled',
      status: 'success',
      request_payload: { row_id: row.id, ticket, reason } as unknown as Record<string, unknown>,
    })
  } catch {
    /* best-effort */
  }
  return { ok: true }
}

export async function markSignalEntryFilled(
  supabase: SupabaseClient,
  row: SignalEntryPendingRow & { entry_price: number },
  fillPrice: number,
  opts?: {
    partialTpPlan?: Array<{ tpIdx: number; triggerPrice: number; closeLots: number }> | null
    /** When the broker exposes the live position ticket after fill, persist it for partialTpMonitor. */
    brokerPositionTicket?: string | null
  },
): Promise<void> {
  const now = new Date().toISOString()
  const px = Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : row.entry_price
  await supabase
    .from('signal_entry_pending_orders')
    .update({ status: 'filled', filled_at: now, updated_at: now })
    .eq('id', row.id)
    .eq('status', 'broker_pending')

  if (row.trade_id) {
    const ticket = opts?.brokerPositionTicket?.trim()
    const useTicket = ticket && /^\d+$/.test(ticket) && Number(ticket) > 0
    await supabase
      .from('trades')
      .update({
        status: 'open',
        entry_price: px,
        opened_at: now,
        ...(useTicket ? { metaapi_order_id: ticket } : {}),
      })
      .eq('id', row.trade_id)
      .eq('status', 'pending')
  }

  const plan = opts?.partialTpPlan
  if (plan && plan.length > 0 && row.trade_id) {
    const partialRows = plan.map(p => ({
      trade_id: row.trade_id,
      signal_id: row.signal_id,
      user_id: row.user_id,
      broker_account_id: row.broker_account_id,
      metaapi_account_id: row.metaapi_account_id,
      symbol: row.symbol,
      is_buy: row.is_buy,
      tp_idx: p.tpIdx,
      trigger_price: p.triggerPrice,
      close_lots: p.closeLots,
      status: 'pending',
    }))
    const { error: pErr } = await supabase.from('partial_tp_legs').insert(partialRows)
    if (pErr) {
      console.warn(`[signalEntryPendingHelpers] partial_tp_legs insert failed row=${row.id}: ${pErr.message}`)
    }
  }

  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: row.user_id,
      signal_id: row.signal_id,
      broker_account_id: row.broker_account_id,
      action: 'signal_entry_pending_filled',
      status: 'success',
      request_payload: { row_id: row.id, ticket: row.broker_ticket, fill_price: px } as unknown as Record<
        string,
        unknown
      >,
    })
  } catch {
    /* best-effort */
  }
}

export async function markSignalEntryGoneFromBroker(
  supabase: SupabaseClient,
  row: SignalEntryPendingRow,
  note: string,
): Promise<void> {
  const now = new Date().toISOString()
  await supabase
    .from('signal_entry_pending_orders')
    .update({
      status: 'cancelled',
      cancel_reason: 'broker_missing',
      error_message: note,
      updated_at: now,
    })
    .eq('id', row.id)
    .eq('status', 'broker_pending')

  if (row.trade_id) {
    await supabase
      .from('trades')
      .update({ status: 'cancelled', closed_at: now })
      .eq('id', row.trade_id)
      .eq('status', 'pending')
  }

  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: row.user_id,
      signal_id: row.signal_id,
      broker_account_id: row.broker_account_id,
      action: 'signal_entry_pending_sync',
      status: 'info',
      request_payload: { row_id: row.id, ticket: row.broker_ticket, note } as unknown as Record<string, unknown>,
    })
  } catch {
    /* best-effort */
  }
}
