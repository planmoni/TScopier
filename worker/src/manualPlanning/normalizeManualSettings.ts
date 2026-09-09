import { computeMultiTradeOrderCount } from './computeMultiTradeOrderCount'
import { DEFAULT_DYNAMIC_STEP_PIPS, normalizeLayeringModeSettings } from './layeringModes'
import { resolveManualLotForSettings } from './resolveManualLot'
import type { ManualSettings, ManualTpLot } from './types'

/** Default Targets % rows — keep aligned with AccountConfigPage `DEFAULT_MANUAL_TP_LOTS`. */
export const DEFAULT_MANUAL_TP_LOTS: ManualTpLot[] = [
  { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
  { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
  { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
]

function splitIntEqual(count: number, total: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(total / count)
  const rem = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0))
}

function sumEnabledTpPercents(rows: ManualTpLot[]): number {
  return rows.reduce((s, r) => s + (r.enabled ? Math.max(0, Number(r.percent) || 0) : 0), 0)
}

/** Disabled rows show 0%; percents clamped to 0..100 — matches AccountConfig `sanitizeTpLots`. */
export function sanitizeTpLots(rows: ManualTpLot[]): ManualTpLot[] {
  return rows.map(r => ({
    ...r,
    lot: r.lot ?? 0.01,
    percent: r.enabled ? Math.max(0, Math.min(100, Math.round(Number(r.percent) || 0))) : 0,
  }))
}

/**
 * Normalize `manual_settings` from DB for execution (Targets %, leg %, range).
 * Mirrors `normalizeManualSettings` in AccountConfigPage — without UI-only fields.
 */
export function normalizeManualSettingsForExecution(
  raw: unknown,
  opts?: { accountBalance?: number | null },
): ManualSettings {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const tpLotsRaw = Array.isArray(j.tp_lots) ? j.tp_lots : DEFAULT_MANUAL_TP_LOTS
  const tpLots = tpLotsRaw.map((x, i) => {
    const row = x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
    const pct = Number(row.percent)
    return {
      label: String(row.label ?? `TP${i + 1}`),
      lot: Number(row.lot ?? 0.01) || 0.01,
      percent: Number.isFinite(pct) && pct > 0 ? pct : 0,
      enabled: row.enabled !== false,
    } as ManualTpLot
  })

  const legPctRaw = Number(j.multi_trade_leg_percent)
  const legPct = Number.isFinite(legPctRaw) && legPctRaw > 0 ? Math.min(100, legPctRaw) : 5

  const legacyMaxLegsRaw = Number(j.multi_trade_max_legs)
  const tradeStyle = j.trade_style === 'multi' ? 'multi' : 'single'
  const riskMode = String(j.risk_mode ?? 'fixed_lot')
  const accountBalance = opts?.accountBalance
  let maxOrders: number | undefined

  const seedMaxOrdersFromLot = (manualLot: number): void => {
    if (!Number.isFinite(manualLot) || manualLot <= 0) return
    const preview = computeMultiTradeOrderCount({
      manualLot,
      legPercent: legPct,
      rangeTrading: j.range_trading === true,
      rangePercent: Number(j.range_percent),
      rangeStepPips: Number(j.range_step_pips),
      rangeDistancePips: Number(j.range_distance_pips),
      useSignalEntryRange: j.use_signal_entry_range === true,
    })
    if (preview > 0) maxOrders = preview
  }

  if (tradeStyle === 'multi' && riskMode === 'dynamic_balance_percent' && Number(accountBalance) > 0) {
    // Recompute from live balance — stored cap goes stale when balance or % changes.
    seedMaxOrdersFromLot(resolveManualLotForSettings(j as ManualSettings, accountBalance))
  } else if (tradeStyle === 'multi' && Number.isFinite(legacyMaxLegsRaw) && legacyMaxLegsRaw > 0) {
    maxOrders = Math.max(1, Math.min(500, Math.floor(legacyMaxLegsRaw)))
  } else if (tradeStyle === 'multi') {
    seedMaxOrdersFromLot(resolveManualLotForSettings(j as ManualSettings, accountBalance))
  }

  const readNumber = (key: string, fallback: number): number => {
    const v = Number(j[key])
    return Number.isFinite(v) ? v : fallback
  }

  const tpSanitized = sanitizeTpLots(tpLots)
  let tpFinal = tpSanitized
  if (sumEnabledTpPercents(tpSanitized) === 0) {
    const enabledCount = tpSanitized.filter(r => r.enabled).length
    if (enabledCount > 0) {
      const parts = splitIntEqual(enabledCount, 100)
      let k = 0
      tpFinal = tpSanitized.map(r =>
        r.enabled ? { ...r, percent: parts[k++] ?? 0 } : { ...r, percent: 0 },
      )
    }
  }

  const rangePercent = Math.max(0, Math.min(100, readNumber('range_percent', 50)))
  const rangeStepPips = Math.max(0, readNumber('range_step_pips', 0))
  const rangeDistancePips = Math.max(0, readNumber('range_distance_pips', 30))
  const layeringModeSettings = normalizeLayeringModeSettings({
    ...j,
    range_step_pips: rangeStepPips > 0 ? rangeStepPips : DEFAULT_DYNAMIC_STEP_PIPS,
  })

  const predefinedTpPips = Array.isArray(j.predefined_tp_pips)
    ? j.predefined_tp_pips.map(Number).filter(Number.isFinite)
    : [20, 40, 60]
  const singleTpTargetRaw = String(j.single_tp_target ?? 'farthest').toLowerCase()
  const tpMatch = singleTpTargetRaw.match(/^tp(\d+)$/)
  const singleTpTarget: ManualSettings['single_tp_target'] =
    tpMatch ? (`tp${tpMatch[1]}` as `tp${number}`) : 'farthest'

  return {
    ...(j as ManualSettings),
    multi_trade_leg_percent: legPct,
    ...(maxOrders != null ? { multi_trade_max_orders: maxOrders } : {}),
    range_percent: rangePercent,
    range_step_pips: rangeStepPips,
    range_distance_pips: rangeDistancePips,
    ...layeringModeSettings,
    tp_lots: tpFinal,
    single_tp_target: singleTpTarget,
    predefined_tp_pips: predefinedTpPips,
    use_signal_entry_price: j.use_signal_entry_price === true,
    trade_style: j.trade_style === 'multi' ? 'multi' : 'single',
    range_trading: j.range_trading === true,
    range_layer_till_close: j.range_layer_till_close === true,
    range_layering_type: j.range_layering_type === 'pending_order' ? 'pending_order' : 'auto',
    use_signal_entry_range: j.use_signal_entry_range === true,
    close_worse_entries: j.close_worse_entries === true,
    close_worse_entries_pips: Math.max(0, readNumber('close_worse_entries_pips', 30)),
    use_predefined_sl_pips: j.use_predefined_sl_pips === true,
    use_predefined_tp_pips: j.use_predefined_tp_pips === true,
    add_new_trades_to_existing: j.add_new_trades_to_existing !== false,
    order_comments_enabled: j.order_comments_enabled !== false,
    copy_limits: j.copy_limits && typeof j.copy_limits === 'object'
      ? (j.copy_limits as Record<string, unknown>)
      : undefined,
  }
}
