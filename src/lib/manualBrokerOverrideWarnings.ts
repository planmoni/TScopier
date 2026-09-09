import type { SupabaseClient } from '@supabase/supabase-js'
import type { MtTrade } from './fxsocketBroker'

export const MANUAL_BROKER_OVERRIDE_REVERTED_ACTION = 'broker_manual_stop_override_reverted'

export type ManualBrokerOverrideWarning = {
  id: string
  createdAt: string
  signalId: string | null
  brokerAccountId: string | null
  symbol: string | null
  title: string
  body: string
  actionLabel: string
  actionUrl: string
  restoredTradeIds: string[]
  changedSides: Array<'sl' | 'tp'>
}

type ManualBrokerOverrideLogRow = {
  id: string
  created_at: string
  signal_id: string | null
  broker_account_id: string | null
  request_payload: Record<string, unknown> | null
}

type ManualBrokerOverrideTradeRow = {
  id: string
  signal_id: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string | null
}

export type ManualBrokerOverrideWarningMaps = {
  byBrokerTicket: Map<string, ManualBrokerOverrideWarning>
  bySignalBrokerSymbol: Map<string, ManualBrokerOverrideWarning>
}

export function emptyManualBrokerOverrideWarningMaps(): ManualBrokerOverrideWarningMaps {
  return { byBrokerTicket: new Map(), bySignalBrokerSymbol: new Map() }
}

export function manualOverrideManageSignalUrl(signalId: string | null | undefined): string {
  const id = String(signalId ?? '').trim()
  return id ? `/manage-signals?edit=${encodeURIComponent(id)}` : '/manage-signals'
}

function readPayload(row: ManualBrokerOverrideLogRow): Record<string, unknown> {
  return row.request_payload && typeof row.request_payload === 'object' && !Array.isArray(row.request_payload)
    ? row.request_payload
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(v => String(v ?? '').trim()).filter(Boolean)
    : []
}

function changedSides(value: unknown): Array<'sl' | 'tp'> {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is 'sl' | 'tp' => v === 'sl' || v === 'tp'))]
    : []
}

function warningFromLog(row: ManualBrokerOverrideLogRow): ManualBrokerOverrideWarning {
  const payload = readPayload(row)
  const signalId = String(payload.anchor_signal_id ?? row.signal_id ?? '').trim() || null
  const actionUrl = String(payload.manage_signal_url ?? '').trim() || manualOverrideManageSignalUrl(signalId)
  return {
    id: row.id,
    createdAt: row.created_at,
    signalId,
    brokerAccountId: String(row.broker_account_id ?? '').trim() || null,
    symbol: String(payload.symbol ?? '').trim().toUpperCase() || null,
    title: 'Manual broker changes were reverted',
    body: "TScopier detected an SL/TP change made directly on your broker account and restored this signal's managed values. To change SL or TP, use Manage Signal.",
    actionLabel: String(payload.cta_label ?? '').trim() || 'Manage Signal',
    actionUrl,
    restoredTradeIds: stringArray(payload.restored_trade_ids),
    changedSides: changedSides(payload.changed_sides),
  }
}

function brokerTicketKey(brokerAccountId: string | null | undefined, ticket: string | number | null | undefined): string | null {
  const broker = String(brokerAccountId ?? '').trim()
  const t = String(ticket ?? '').trim()
  return broker && t ? `${broker}|${t}` : null
}

function signalBrokerSymbolKey(
  signalId: string | null | undefined,
  brokerAccountId: string | null | undefined,
  symbol: string | null | undefined,
): string | null {
  const signal = String(signalId ?? '').trim()
  const broker = String(brokerAccountId ?? '').trim()
  const sym = String(symbol ?? '').trim().toUpperCase()
  return signal && broker && sym ? `${signal}|${broker}|${sym}` : null
}

function setNewest(map: Map<string, ManualBrokerOverrideWarning>, key: string, warning: ManualBrokerOverrideWarning): void {
  const prev = map.get(key)
  if (!prev || new Date(warning.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
    map.set(key, warning)
  }
}

export function buildManualBrokerOverrideWarningMaps(
  logRows: ManualBrokerOverrideLogRow[],
  tradeRows: ManualBrokerOverrideTradeRow[],
): ManualBrokerOverrideWarningMaps {
  const warnings = logRows.map(warningFromLog)
  const warningByRestoredTradeId = new Map<string, ManualBrokerOverrideWarning>()
  for (const warning of warnings) {
    const primaryTradeId = warning.restoredTradeIds[0]
    if (primaryTradeId) warningByRestoredTradeId.set(primaryTradeId, warning)
  }

  const byBrokerTicket = new Map<string, ManualBrokerOverrideWarning>()
  for (const trade of tradeRows) {
    const warning = warningByRestoredTradeId.get(trade.id)
    const key = brokerTicketKey(trade.broker_account_id, trade.metaapi_order_id)
    if (warning && key) setNewest(byBrokerTicket, key, warning)
  }

  const bySignalBrokerSymbol = new Map<string, ManualBrokerOverrideWarning>()
  for (const warning of warnings) {
    if (warning.restoredTradeIds.length > 0) continue
    const key = signalBrokerSymbolKey(warning.signalId, warning.brokerAccountId, warning.symbol)
    if (key) setNewest(bySignalBrokerSymbol, key, warning)
  }

  return { byBrokerTicket, bySignalBrokerSymbol }
}

export function getManualBrokerOverrideWarningForTrade(
  maps: ManualBrokerOverrideWarningMaps,
  trade: MtTrade,
  signalId?: string | null,
): ManualBrokerOverrideWarning | null {
  const direct = brokerTicketKey(trade.broker_id, trade.ticket)
  if (direct && maps.byBrokerTicket.has(direct)) return maps.byBrokerTicket.get(direct) ?? null

  const fallback = signalBrokerSymbolKey(signalId, trade.broker_id, trade.symbol)
  return fallback ? (maps.bySignalBrokerSymbol.get(fallback) ?? null) : null
}

export async function fetchManualBrokerOverrideWarningsForTrades(
  supabase: SupabaseClient,
  userId: string,
): Promise<ManualBrokerOverrideWarningMaps> {
  const { data: logRows, error } = await supabase
    .from('trade_execution_logs')
    .select('id,created_at,signal_id,broker_account_id,request_payload')
    .eq('user_id', userId)
    .eq('action', MANUAL_BROKER_OVERRIDE_REVERTED_ACTION)
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw new Error(error.message)

  const rows = (logRows ?? []) as ManualBrokerOverrideLogRow[]
  const restoredTradeIds = [...new Set(rows.flatMap(row => stringArray(readPayload(row).restored_trade_ids)))]
  if (!restoredTradeIds.length) return buildManualBrokerOverrideWarningMaps(rows, [])

  const { data: tradeRows, error: tradeError } = await supabase
    .from('trades')
    .select('id,signal_id,broker_account_id,metaapi_order_id,symbol')
    .in('id', restoredTradeIds)

  if (tradeError) throw new Error(tradeError.message)

  return buildManualBrokerOverrideWarningMaps(rows, (tradeRows ?? []) as ManualBrokerOverrideTradeRow[])
}
