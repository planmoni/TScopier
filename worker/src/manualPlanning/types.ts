import type { OrderSendArgs } from '../fxsocketClient'
import type { PipQuote } from '../pipCalculator'

export interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[] | null
  tp_unit?: 'price' | 'pips'
  sl_unit?: 'price' | 'pips'
  lot_size: number | null
  open_tp?: boolean
  partial_close_fraction?: number | null
  raw_instruction?: string
  /** Explicit channel intent to open a new trade (not modify existing). */
  re_enter?: boolean
  /** Provider-side trade id (e.g. ForexBro Signal #899). */
  provider_signal_number?: number | null
}

export interface ManualTpLot {
  label: string
  lot: number
  percent?: number
  enabled: boolean
}

export type LayeringMode = 'legacy' | 'static' | 'dynamic'
export type LayerSizingOptimizationStrategy = 'adjust_percent' | 'reduce_layers' | 'widen_step'
export type LayerPlanAnchorSource = 'signal' | 'quote' | 'fill' | 'unknown'
export type LayerPlanSide = 'buy' | 'sell'

export interface ManualSettings {
  symbol_mapping?: Record<string, string>
  symbol_prefix?: string
  symbol_suffix?: string
  symbol_to_trade?: string | null
  symbols_exclude?: string[]
  risk_mode?: 'fixed_lot' | 'dynamic_balance_percent'
  fixed_lot?: number
  dynamic_balance_percent?: number
  tp_lots?: ManualTpLot[]
  single_tp_target?: `tp${number}` | 'farthest'
  multi_trade_leg_percent?: number
  /**
   * Optional cap on simultaneous market orders per entry burst. When set below
   * the planned leg count, legs sharing the same TP are consolidated into fewer,
   * larger orders (volume + TP split preserved). Default 500 = one order per leg.
   */
  multi_trade_max_orders?: number
  trade_style?: 'single' | 'multi'
  range_trading?: boolean
  range_percent?: number
  range_step_pips?: number
  range_distance_pips?: number
  range_layer_till_close?: boolean
  /**
   * Product layering algorithm. `legacy` preserves the existing production
   * range-percent/step/distance behavior. Static/dynamic execution is gated
   * until the future calculators are integrated.
   */
  layering_mode?: LayeringMode
  /** Static V1 foundation: fixed total layer count, including first/immediate entry. */
  static_layer_count?: number
  /** Dynamic V1 foundation: preferred spacing in pips. */
  dynamic_step_pips?: number
  /** Dynamic V1 foundation: maximum total layer count, including first fill. */
  dynamic_max_layers?: number
  /** Constraint solver preference when range/step/lots/percent cannot all be preserved. */
  layering_optimization_strategy?: LayerSizingOptimizationStrategy
  /** Range layering execution mechanism, independent of `layering_mode`. */
  range_layering_type?: 'auto' | 'pending_order'
  /** When true with range_trading, cap layering depth from parsed entry zone instead of range_distance_pips. */
  use_signal_entry_range?: boolean
  close_worse_entries?: boolean
  close_worse_entries_pips?: number
  /** @deprecated Replaced by `range_percent`. */
  range_total_lot?: number
  reverse_signal?: boolean
  use_signal_entry_price?: boolean | string | number
  signal_entry_pip_tolerance?: number
  use_predefined_sl_pips?: boolean
  predefined_sl_pips?: number
  use_predefined_tp_pips?: boolean
  predefined_tp_pips?: number[]
  rr_for_sl_enabled?: boolean
  rr_for_sl?: number
  rr_for_tps_enabled?: boolean
  rr_for_tps?: number[]
  pending_expiry_hours?: number
  add_new_trades_to_existing?: boolean
  close_on_opposite_signal?: boolean
  /** When false, OrderSend comments are left empty. Default on. */
  order_comments_enabled?: boolean
  time_filter_enabled?: boolean
  trade_start_time?: string
  trade_end_time?: string
  days_filter_enabled?: boolean
  trade_days?: number[]
  trailing_enabled?: boolean
  trailing_start_pips?: number
  trailing_step_pips?: number
  trailing_distance_pips?: number
  move_sl_to_entry_after_mode?: 'none' | 'pips' | 'rr' | 'money' | 'tp_hit'
  move_sl_to_entry_after_value?: number
  move_sl_to_entry_tp_index?: number
  move_sl_to_entry_type?: 'sl_only' | 'sl_and_close_half'
  breakeven_offset_pips?: number
  copy_limits?: Record<string, unknown>
}

export interface ChannelKeywords {
  signal_phrases?: { buy?: string; sell?: string; entry_point?: string; sl?: string; tp?: string; market_order?: string }
  additional?: {
    ignore_keyword?: string
    skip_keyword?: string
    sl_in_pips?: boolean
    tp_in_pips?: boolean
    prefer_entry?: 'first_price' | 'last_price'
    delay_msec?: number
    all_order?: boolean
    remove_sl?: string
  }
}

export interface PlannerContext {
  /** MT point size for the symbol (e.g. 0.0001 for EURUSD, 0.01 for XAUUSD). Used for pip math. */
  point: number
  /** Number of decimal places to keep on prices when rounding. */
  digits: number
  minLot: number
  lotStep: number
  contractSize?: number | null
  stopsLevel?: number
  freezeLevel?: number
  defaultLot: number
  lastBalance: number | null
  now?: Date
  liveBid?: number
  liveAsk?: number
}

export interface VirtualPendingLeg {
  stepIdx: number
  stepPriceOffset: number
  isBuy: boolean
  volume: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string
  expertID?: number
  expiryHours?: number
  cweClosePrice?: number | null
}

export interface PlannerCloseWorseEntries {
  immediates: number
  pipsFromAnchor: number
}

export interface PlannerAnchor {
  source: 'signal' | 'unknown'
  value: number | null
}

export interface PlannerStrictEntry {
  entryPrice: number
  isBuy: boolean
}

/** Virtual range-entry gate metadata (no broker pending). */
export interface PlannerRangeEntryWait {
  isBuy: boolean
  entryPrice: number | null
  zoneLo: number | null
  zoneHi: number | null
  tolerancePips: number
}

export interface PlannerPartialTp {
  tpIdx: number
  triggerPrice: number
  closeLots: number
  percent: number
}

export interface PlannerRangeLayering {
  rangeStepPips: number
  rangeDistancePips: number
  effectiveStepPips: number
  stepPriceOffset: number
  maxStepIdx: number
  reservedPendingLegs: number
  activePendingLegs: number
  /** Hard open-trade ceiling for this basket: immediateLegs + activePendingLegs. */
  basketLegCap?: number
  plannedImmediateLegs?: number
  useSignalEntryRange?: boolean
  signalRangeBoundary?: number | null
  signalZoneLo?: number | null
  signalZoneHi?: number | null
  effectiveDistancePips?: number
  rangeLayeringType?: 'auto' | 'pending_order'
}

export interface PlannerResult {
  orders: OrderSendArgs[]
  virtualPendings?: VirtualPendingLeg[]
  anchor?: PlannerAnchor
  pip?: number
  pipQuote?: PipQuote
  isBuy?: boolean
  closeWorseEntries?: PlannerCloseWorseEntries
  partialTps?: PlannerPartialTp[]
  /** Absolute TP price for Move-SL-on-TP-hit (from finalTps ladder / partials). */
  autoBeTpHitTriggerPrice?: number | null
  strictEntry?: PlannerStrictEntry
  rangeEntryWait?: PlannerRangeEntryWait
  rangeLayering?: PlannerRangeLayering
  skip_reason?: string
  fallback_reason?: string
  delay_ms: number
}

export interface LayeringPlanSnapshot {
  schemaVersion: number
  calculatorVersion: string
  planId: string
  mode: LayeringMode
  signalId: string
  brokerAccountId: string
  basketKey: string | null
  symbol: string
  side: LayerPlanSide
  originalRangeLow: number | null
  originalRangeHigh: number | null
  /** Raw anchor from the signal/quote/fill before executable precision normalization. */
  anchorPrice: number | null
  /** Precision-normalized executable anchor, when one exists. */
  executableAnchorPrice: number | null
  anchorSource: LayerPlanAnchorSource
  configuredStaticLayerCount: number | null
  configuredDynamicStepPips: number | null
  configuredDynamicMaxLayers: number | null
  optimizationStrategy?: LayerSizingOptimizationStrategy | null
  theoreticalLayerCount?: number | null
  effectiveStepPips?: number | null
  requestedLayerPercent?: number | null
  effectiveLayerPercent?: number | null
  allocationPercentTotal?: number | null
  requestedLayerCount: number | null
  plannedLayerCount: number | null
  plannedTotalLot: number | null
  allocatedTotalLot: number | null
  unallocatedLot: number | null
  fundedPrices: readonly number[] | null
  lots: readonly number[] | null
  reasons: readonly string[]
  createdAt: string
  lockedAt: string | null
}

export interface RangePendingLegPlanColumns {
  layer_plan_id: string | null
  layer_plan_metadata: unknown | null
}

export interface PlanRangeSplitArgs {
  totalLegs: number
  baseIsPendingSignal: boolean
  rangeOn: boolean
  rangePct: number
  stepPips: number
  distPips: number
  pip: number
  minStepPriceUnits: number
  hasSignalAnchor: boolean
  /** Pending Order: keep user step/distance; do not expand step for broker SL/TP minimums. */
  skipMinStepExpansion?: boolean
  /**
   * Force Auto step (distance / reserved) even when a manual step is stored.
   * Used for virtual layering mode where the Step field is hidden.
   */
  forceAutoStep?: boolean
}

export interface PlanRangeSplitResult {
  immediateLegs: number
  /** Legs reserved by range_percent (preview count). */
  pendingLegs: number
  /** Legs actually emitted after range_distance depth cap. */
  activePendingLegs: number
  /** Deepest step index allowed: floor(distPips / effectiveStepPips). */
  maxStepIdx: number
  effectiveStepPips: number
  stepPriceOffset: number
  fallbackReason?: string
}

export interface ComputeCwOverrideTpArgs {
  policy: PlannerCloseWorseEntries
  anchor: number
  isBuy: boolean
  pip: number
  digits: number
  minStopDistance: number
}
