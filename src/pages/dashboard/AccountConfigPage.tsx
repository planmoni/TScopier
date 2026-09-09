import { useCallback, useEffect, useState, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import {
  Plus, Trash2, Server, Activity, GitBranch, Eye, DollarSign, RefreshCw,
  SlidersHorizontal, Radio, Target, Filter, Wallet, Link2,
  ChevronLeft, ChevronRight, Search, Settings2, Bookmark, Pencil, ScrollText, AlertTriangle,
  Infinity as InfinityIcon, Coins, X, MessageSquareText, FileUp, FileDown,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../../components/ui/Card'
import { Select } from '../../components/ui/Select'
import { Toggle } from '../../components/ui/Toggle'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Alert } from '../../components/ui/Alert'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { RiskLotCalculatorModal } from '../../components/configure/RiskLotCalculatorModal'
import { CopyLimitsTargetsSection } from '../../components/configure/CopyLimitsTargetsSection'
import { ChannelSignalExamplesSection } from '../../components/configure/ChannelSignalExamplesSection'
import { useUserProfile } from '../../context/UserProfileContext'
import { normalizeCopyLimitState, type CopyLimitState } from '../../lib/copyLimitTypes'
import { ConfigTitle, ConfigToggleLabel, ConfigureInput, ConfigureSelect, InfoTooltip } from '../../components/ui/InfoTooltip'
import { fxsocketBroker, BrokerHealthCheckUnsupportedError } from '../../lib/fxsocketBroker'
import { isLegacyBrokerLink, countLinkedBrokerSessions, hasFxsocketBrokerSession } from '../../lib/brokerLink'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import { brokerCanReconnect, brokerConnectionBadgeVariant, brokerConnectionStatusLabel } from '../../lib/brokerReconnect'
import {
  brokerTerminalHealthBadgeVariant,
  brokerTerminalHealthLabel,
  brokerAccountHealthPatchFromMtStatus,
} from '../../lib/brokerHealth'
import { BrokerStatusModal } from '../../components/broker/BrokerStatusModal'
import {
  brokerConnectErrorLabelsFromI18n,
  brokerConnectErrorText,
  brokerReconnectBannerText,
  classifyBrokerConnectError,
} from '../../lib/brokerConnectError'
import {
  BROKER_ACCOUNT_CLIENT_SELECT,
  sortBrokerAccountsNewestFirst,
} from '../../lib/brokerAccountSelect'
import { triggerBackgroundChannelAiTraining } from '../../lib/channelAiTrainingBackground'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import {
  effectivePlan as resolveEffectivePlan,
  normalizeManualSettingsForPlan,
  planContextForManualSettings,
} from '../../lib/planLimits'
import type { SubscriptionPlan } from '../../lib/planLimits'
import { PaywallErrorAlert } from '../../components/billing/PaywallErrorAlert'
import { UpgradePrompt } from '../../components/billing/UpgradePrompt'
import {
  inferBrokerLabelFromServer,
  resolveLinkedAccountTypeForBroker,
  formatLinkedAccountTypeLabel,
  linkedAccountTypeValueClass,
  type LinkedAccountType,
  type LinkedAccountTypeLabels,
} from '../../lib/brokerFromServer'
import { estimateMultiTradeOrderCount, formatMultiTradeTotalOpenTradesPreview } from '../../lib/estimateMultiTradeOrders'
import { computeMinMultiTradeLegPercent, resolveMultiTradePerLegLot } from '../../lib/multiTradeLegUnits'
import { formatPreviewLotSize, resolvePreviewManualLot } from '../../lib/manualLotSizing'
import {
  draftNumberError,
  parseDraftNumber,
  type DraftNumberRules,
} from '../../lib/draftNumberField'
import { pipCalculator, pipValueForLots, type PipQuote } from '../../lib/pipCalculator'
import { classifySymbol } from '../../lib/pipMath'
import { signalPipPrice } from '../../lib/signalPip'
import { formatMoneyWithCode } from '../../lib/currency'
import type { BrokerAccount, ManualSettings, ManualTpLot } from '../../types/database'
import {
  DEFAULT_CHANNEL_FILTERS,
  BASIC_PLAN_CHANNEL_FILTERS,
  defaultChannelFiltersForPlan,
  normalizeChannelFilters,
  normalizeChannelMessageFiltersMap,
  type ChannelFilterDecision,
  type ChannelFilterKey,
  type ChannelFilters,
  type ChannelMessageFiltersMap,
} from '../../lib/channelMessageFilters'
import { isAutoManagementEnabled } from '../../lib/autoManagementDisplay'
import {
  buildChannelTradingConfigsFromDraft,
  buildDefaultChannelTradingConfig,
  channelManualSettingsComplete,
  filterChannelIdsToActiveOptions,
  healChannelTradingConfigsMap,
  normalizeChannelTradingConfigsMap,
  normalizeChannelUuid,
  resolveChannelConfigEntry,
  restrictChannelTradingConfigsMap,
  storedPerChannelConfigComplete,
} from '../../lib/channelTradingConfig'
import {
  deleteBrokerChannelTradingConfigsExcept,
  fetchBrokerChannelTradingConfigRows,
  mergeBrokerWithChannelTradingConfigRows,
  upsertBrokerChannelTradingConfigs,
} from '../../lib/brokerChannelTradingConfigs'
import { parseSymbolToTradeList } from '../../lib/channelSymbolDetection'
import {
  deleteTradingPreset,
  downloadTradingPresetsFile,
  importTradingPresetsFromFile,
  listTradingPresets,
  presetToChannelConfigDraft,
  renameTradingPreset,
  upsertTradingPreset,
  TSCOPIER_PRESETS_EXTENSION,
  type ChannelTradingPreset,
} from '../../lib/tradingPresets'
import {
  connectChannelToBroker,
  getBrokerDisplayLabel,
} from '../../lib/brokerChannelLink'
import { DEFAULT_MANUAL_SETTINGS, DEFAULT_MANUAL_TP_LOTS } from '../../lib/defaultManualSettings'
import { normalizeLayeringModeSettings } from '../../lib/layeringModes'
import {
  fetchLayeringModeCapabilities,
  layeringMechanismIsSelectable,
  LEGACY_ONLY_LAYERING_CAPABILITIES,
  type LayeringModeCapabilities,
} from '../../lib/layeringModeCapabilities'
import { updateLayeringSettings } from '../../lib/updateLayeringSettings'
import { computeSingleTpLotBreakdown } from '../../lib/singleTpLotBreakdown'
import { marketingUrl } from '../../lib/site'
import {
  choosePersistedSelectedChannelId,
  hasBlockedMultiTradeSplit,
  hasRequestedMultiTradeStyle,
  shouldBlockMultiTradeSave,
} from './accountConfigPersistence'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import {
  describeAutoManagementRuleI18n,
  describePredefinedStopsOverrideI18n,
  formatPipHintI18n,
  getChannelFilterCategories,
} from './configureModalI18n'

interface ChannelOption {
  id: string
  display_name: string
  channel_username: string
  is_active: boolean
  created_at: string
}

/** Survives route unmount so sidebar navigation does not flash the loading skeleton. */
const channelOptionsCache = new Map<string, ChannelOption[]>()

const BROKER_PAGE_SIZE = 10

function symbolWhitelistToInput(value: string | null | undefined): string {
  if (value == null || !String(value).trim()) return ''
  return String(value)
}

function symbolWhitelistFromInput(raw: string): string | null {
  const list = parseSymbolToTradeList(raw)
  if (!list.length) return null
  return list.join(', ')
}

function symbolsExcludeToInput(value: string[] | null | undefined): string {
  if (!value?.length) return ''
  return value.join(', ')
}

function symbolsExcludeFromInput(raw: string): string[] {
  return parseSymbolToTradeList(raw)
}

function resolveBrokerFilterLabel(broker: BrokerAccount): string {
  return (
    broker.broker_name
    || inferBrokerLabelFromServer(broker.broker_server ?? null)
    || broker.broker_server
    || '—'
  )
}

function brokerMatchesSearch(broker: BrokerAccount, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    broker.label,
    broker.account_login,
    broker.broker_server,
    broker.broker_name,
    broker.platform,
    resolveBrokerFilterLabel(broker),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

function normalizeSignalChannelIds(b: BrokerAccount | undefined): string[] {
  const raw = b?.signal_channel_ids
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return []
}

/** When false, the configure modal only shows manual settings (AI tab hidden). */
const AI_CONFIGURATION_ENABLED = false

interface ChannelConfigDraft {
  mode: 'ai' | 'manual'
  manualSettings: ManualSettings
  channelFilters: ChannelFilters
}

interface AccountConfigDraft {
  channelIds: string[]
  selectedChannelId: string | null
  channelConfigs: Record<string, ChannelConfigDraft>
}

/** Split `total` across `count` slots as non-negative integers that sum exactly to `total`. */
function splitIntEqual(count: number, total: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(total / count)
  const rem = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0))
}

function cloneTpLots(rows: ManualTpLot[] | undefined, fallback: ManualTpLot[]): ManualTpLot[] {
  const src = rows?.length ? rows : fallback
  return src.map(r => ({ ...r, lot: r.lot ?? 0.01 }))
}

function clonePredefinedTpPips(list: number[] | undefined): number[] {
  const fallback = DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60]
  const src = list?.length ? list : fallback
  return src.map(n => (Number.isFinite(Number(n)) ? Number(n) : 0))
}

type RiskNumberDraftKey =
  | 'fixed_lot'
  | 'dynamic_balance_percent'
  | 'signal_entry_pip_tolerance'
  | 'multi_trade_leg_percent'
  | 'range_percent'
  | 'range_step_pips'
  | 'range_distance_pips'
  | 'static_layer_count'
  | 'dynamic_step_pips'
  | 'dynamic_max_layers'

type RiskNumberDrafts = Partial<Record<RiskNumberDraftKey, string>>

function numberFieldDisplay(
  stored: number | undefined,
  draft: string | undefined,
  fallback: number,
): string {
  if (draft !== undefined) return draft
  const value = stored ?? fallback
  return Number.isFinite(value) ? String(value) : ''
}

function commitPositiveNumber(raw: string, fallback: number): number {
  const parsed = parseDraftNumber(raw, { positive: true })
  return parsed ?? fallback
}

function riskNumberRules(
  key: RiskNumberDraftKey,
  minLegPercent: number,
): DraftNumberRules {
  switch (key) {
    case 'fixed_lot':
      return { positive: true, min: 0.01 }
    case 'dynamic_balance_percent':
      return { min: 0.1 }
    case 'signal_entry_pip_tolerance':
      return { min: 0 }
    case 'multi_trade_leg_percent':
      return { min: minLegPercent, max: 100 }
    case 'range_percent':
      return { min: 0, max: 100 }
    case 'range_step_pips':
      // Manual mode only — Auto is selected via dropdown (stores 0).
      return { min: 1, positive: true }
    case 'range_distance_pips':
      return { min: 1 }
    case 'static_layer_count':
    case 'dynamic_max_layers':
      return { min: 1, max: 20, integer: true }
    case 'dynamic_step_pips':
      return { positive: true }
  }
}

function riskDraftManualPatch(
  drafts: RiskNumberDrafts,
  minLegPercent: number,
): { patch: Partial<ManualSettings>; hasInvalid: boolean } {
  const patch: Partial<ManualSettings> = {}
  let hasInvalid = false
  for (const key of Object.keys(drafts) as RiskNumberDraftKey[]) {
    if (!Object.prototype.hasOwnProperty.call(drafts, key)) continue
    const raw = drafts[key]
    if (raw === undefined) continue
    const parsed = parseDraftNumber(raw, riskNumberRules(key, minLegPercent))
    if (parsed == null) {
      hasInvalid = true
      continue
    }
    ;(patch as Record<string, number>)[key] = parsed
  }
  return { patch, hasInvalid }
}

/** Commit in-progress number inputs (e.g. fixed lot) before save or dirty checks. */
function applyPendingConfigureDraftFields(
  draft: AccountConfigDraft,
  riskNumberDrafts: RiskNumberDrafts,
  symbolsExcludeDraft: string | null = null,
  minLegPercent = 1,
): AccountConfigDraft {
  const id = draft.selectedChannelId
  if (!id || !draft.channelConfigs[id]) return draft

  let entry = draft.channelConfigs[id]
  let changed = false

  const { patch } = riskDraftManualPatch(riskNumberDrafts, minLegPercent)
  if (Object.keys(patch).length > 0) {
    entry = { ...entry, manualSettings: { ...entry.manualSettings, ...patch } }
    changed = true
  }

  if (symbolsExcludeDraft !== null) {
    const list = symbolsExcludeFromInput(symbolsExcludeDraft)
    const prev = entry.manualSettings.symbols_exclude ?? []
    if (JSON.stringify(prev) !== JSON.stringify(list)) {
      entry = { ...entry, manualSettings: { ...entry.manualSettings, symbols_exclude: list } }
      changed = true
    }
  }

  if (!changed) return draft
  return {
    ...draft,
    channelConfigs: {
      ...draft.channelConfigs,
      [id]: entry,
    },
  }
}

/** Sum percent across enabled rows. Disabled rows always contribute 0. */
function sumEnabledTpPercents(rows: ManualTpLot[]): number {
  return rows.reduce((s, r) => s + (r.enabled ? Math.max(0, Number(r.percent) || 0) : 0), 0)
}

/**
 * Apply `rawNew` percent to `editedIdx`, **without touching any other row**.
 * The value is clamped to the remaining budget so the enabled total can never
 * exceed 100%. Disabled rows are pinned at 0%.
 */
function applyTpPercentEdit(rows: ManualTpLot[], editedIdx: number, rawNew: number): ManualTpLot[] {
  const out = cloneTpLots(rows, DEFAULT_MANUAL_TP_LOTS)
  if (editedIdx < 0 || editedIdx >= out.length) return out

  const target = out[editedIdx]!
  if (!target.enabled) {
    out[editedIdx] = { ...target, percent: 0 }
    return out
  }

  const requested = Math.max(0, Math.min(100, Math.round(Number(rawNew) || 0)))
  const otherEnabledSum = out.reduce(
    (s, r, i) => (i !== editedIdx && r.enabled ? s + Math.max(0, Number(r.percent) || 0) : s),
    0,
  )
  const budget = Math.max(0, 100 - otherEnabledSum)
  const next = Math.min(requested, budget)
  out[editedIdx] = { ...target, percent: next }
  return out
}

/** Ensures disabled rows show 0% and percents stay in 0..100 — no auto-redistribute. */
function sanitizeTpLots(rows: ManualTpLot[]): ManualTpLot[] {
  return rows.map(r => ({
    ...r,
    lot: r.lot ?? 0.01,
    percent: r.enabled ? Math.max(0, Math.min(100, Math.round(Number(r.percent) || 0))) : 0,
  }))
}

function normalizeManualSettings(
  raw: unknown,
  opts?: { accountBalance?: number | null },
): ManualSettings {
  const j = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const map = j.symbol_mapping && typeof j.symbol_mapping === 'object' ? j.symbol_mapping as Record<string, unknown> : {}
  const tpLotsRaw = Array.isArray(j.tp_lots) ? j.tp_lots : DEFAULT_MANUAL_TP_LOTS
  const tpLots = tpLotsRaw.map((x, i) => {
    const row = (x && typeof x === 'object') ? x as Record<string, unknown> : {}
    const pct = Number(row.percent)
    return {
      label: String(row.label ?? `TP${i + 1}`),
      lot: Number(row.lot ?? 0.01) || 0.01,
      percent: Number.isFinite(pct) && pct > 0 ? pct : 0,
      enabled: row.enabled !== false,
    } as ManualTpLot
  })
  const legPctRaw = Number(j.multi_trade_leg_percent)
  const legPct = Number.isFinite(legPctRaw) && legPctRaw > 0
    ? Math.min(100, legPctRaw)
    : (DEFAULT_MANUAL_SETTINGS.multi_trade_leg_percent ?? 7)
  const legacyMaxLegsRaw = Number(j.multi_trade_max_legs)

  const merged = { ...DEFAULT_MANUAL_SETTINGS, ...(j as ManualSettings) }
  // Drop legacy keys if they sneak in from older DB rows.
  delete (merged as Record<string, unknown>).multi_tp_volume_mode
  delete (merged as Record<string, unknown>).multi_trade_max_legs
  delete (merged as Record<string, unknown>).range_total_lot

  const readNumber = (key: string, fallback: number): number => {
    const v = Number((j as Record<string, unknown>)[key])
    return Number.isFinite(v) ? v : fallback
  }
  const rangePercent = Math.max(0, Math.min(100, readNumber('range_percent', DEFAULT_MANUAL_SETTINGS.range_percent ?? 50)))
  const rangeStepPips = Math.max(0, readNumber('range_step_pips', DEFAULT_MANUAL_SETTINGS.range_step_pips ?? 0))
  const rangeDistancePips = Math.max(0, readNumber('range_distance_pips', DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30))
  const rangeLayerTillClose = (j as Record<string, unknown>).range_layer_till_close === true
  const rangeLayeringTypeRaw = String((j as Record<string, unknown>).range_layering_type ?? 'auto').toLowerCase()
  const rangeLayeringType: ManualSettings['range_layering_type'] =
    rangeLayeringTypeRaw === 'pending_order' ? 'pending_order' : 'auto'
  const useSignalEntryRange = (j as Record<string, unknown>).use_signal_entry_range === true
  const layeringModeSettings = normalizeLayeringModeSettings({
    ...(j as Record<string, unknown>),
    // dynamic_step fallback needs a positive value; Auto (0) maps to default dynamic step.
    range_step_pips: rangeStepPips > 0 ? rangeStepPips : 3,
  })
  const closeWorseEntries = (j as Record<string, unknown>).close_worse_entries === true
  const closeWorseEntriesPips = Math.max(0, readNumber('close_worse_entries_pips', DEFAULT_MANUAL_SETTINGS.close_worse_entries_pips ?? 30))
  const singleTpTargetRaw = String((j as Record<string, unknown>).single_tp_target ?? 'farthest').toLowerCase()
  const tpMatch = singleTpTargetRaw.match(/^tp(\d+)$/)
  const singleTpTarget: ManualSettings['single_tp_target'] =
    tpMatch ? (`tp${tpMatch[1]}` as `tp${number}`) : 'farthest'

  // Manual control: keep whatever the user saved. Only seed an equal split when
  // there is literally nothing enabled with a positive percent (empty / legacy row).
  const tpSanitized = sanitizeTpLots(tpLots)
  let tpFinal = tpSanitized
  if (sumEnabledTpPercents(tpSanitized) === 0) {
    const enabledCount = tpSanitized.filter(r => r.enabled).length
    if (enabledCount > 0) {
      const parts = splitIntEqual(enabledCount, 100)
      let k = 0
      tpFinal = tpSanitized.map(r => (r.enabled ? { ...r, percent: parts[k++] ?? 0 } : { ...r, percent: 0 }))
    }
  }

  const multiTradeMaxOrders = (() => {
    if (merged.trade_style !== 'multi') return undefined

    const manualLot = resolvePreviewManualLot({
      manualSettings: merged,
      accountBalance: opts?.accountBalance,
    })

    const recomputeFromLot = (): number | undefined => {
      if (!Number.isFinite(manualLot) || manualLot <= 0) return undefined
      const preview = estimateMultiTradeOrderCount({
        manualLot,
        legPercent: legPct,
        range: merged.range_trading
          ? {
              enabled: true,
              percent: rangePercent,
              stepPips: rangeStepPips,
              distancePips: rangeDistancePips,
              useSignalEntryRange: useSignalEntryRange,
            }
          : undefined,
      })
      return preview.totalOrders > 0 ? preview.totalOrders : undefined
    }

    if (merged.risk_mode === 'dynamic_balance_percent' && Number(opts?.accountBalance) > 0) {
      return recomputeFromLot()
    }

    if (Number.isFinite(legacyMaxLegsRaw) && legacyMaxLegsRaw > 0) {
      return Math.max(1, Math.min(500, Math.floor(legacyMaxLegsRaw)))
    }
    return recomputeFromLot()
  })()

  return {
    ...merged,
    multi_trade_leg_percent: legPct,
    ...(multiTradeMaxOrders != null ? { multi_trade_max_orders: multiTradeMaxOrders } : {}),
    range_percent: rangePercent,
    range_step_pips: rangeStepPips,
    range_distance_pips: rangeDistancePips,
    range_layer_till_close: rangeLayerTillClose,
    ...layeringModeSettings,
    range_layering_type: rangeLayeringType,
    use_signal_entry_range: useSignalEntryRange,
    close_worse_entries: closeWorseEntries,
    close_worse_entries_pips: closeWorseEntriesPips,
    single_tp_target: singleTpTarget,
    use_signal_entry_price: (j as Record<string, unknown>).use_signal_entry_price === true,
    signal_entry_pip_tolerance: Math.max(0, readNumber('signal_entry_pip_tolerance', DEFAULT_MANUAL_SETTINGS.signal_entry_pip_tolerance ?? 10)),
    symbol_mapping: Object.fromEntries(Object.entries(map).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
    symbol_prefix: '',
    symbol_suffix: '',
    symbol_to_trade: (() => {
      const raw = j.symbol_to_trade
      if (raw == null || !String(raw).trim()) return null
      const list = parseSymbolToTradeList(String(raw))
      return list.length ? list.join(',') : null
    })(),
    symbols_exclude: Array.isArray(j.symbols_exclude)
      ? j.symbols_exclude.map(String).map(s => s.toUpperCase()).filter(s => s.length > 0)
      : parseSymbolToTradeList(typeof j.symbols_exclude === 'string' ? j.symbols_exclude : ''),
    tp_lots: tpFinal,
    predefined_tp_pips: Array.isArray(j.predefined_tp_pips) ? j.predefined_tp_pips.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.predefined_tp_pips,
    rr_for_tps: Array.isArray(j.rr_for_tps) ? j.rr_for_tps.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.rr_for_tps,
    trade_days: Array.isArray(j.trade_days) ? j.trade_days.map(Number).filter(Number.isFinite) : DEFAULT_MANUAL_SETTINGS.trade_days,
    pending_expiry_hours: (() => {
      const peRaw = readNumber('pending_expiry_hours', DEFAULT_MANUAL_SETTINGS.pending_expiry_hours ?? 1)
      if (peRaw <= 0) return 0
      return Math.max(1, Math.min(24, Math.floor(peRaw)))
    })(),
    news_trading_enabled: (() => {
      if (j.news_trading_enabled === true) return true
      if (j.news_trading_enabled === false) return false
      return j.allow_high_impact_news === true
    })(),
    news_avoid_impacts: (() => {
      const raw = j.news_avoid_impacts
      if (Array.isArray(raw)) {
        const valid = raw.filter(
          (i): i is 'high' | 'medium' | 'low' => i === 'high' || i === 'medium' || i === 'low',
        )
        if (valid.length) return valid
      }
      return DEFAULT_MANUAL_SETTINGS.news_avoid_impacts ?? ['high']
    })(),
    allow_high_impact_news: (() => {
      if (j.news_trading_enabled === true) return true
      if (j.news_trading_enabled === false) return false
      return j.allow_high_impact_news === true
    })(),
    close_before_news_minutes: Math.max(
      0,
      Math.min(24 * 60, Math.floor(readNumber('close_before_news_minutes', DEFAULT_MANUAL_SETTINGS.close_before_news_minutes ?? 30))),
    ),
    resume_after_news_minutes: Math.max(
      0,
      Math.min(24 * 60, Math.floor(readNumber('resume_after_news_minutes', DEFAULT_MANUAL_SETTINGS.resume_after_news_minutes ?? 15))),
    ),
  }
}

function getPlatformIconPath(platform: string): string | null {
  const key = platform.trim()
  if (!key) return null
  return `/${key}.png`
}

function PlatformIcon({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const iconPath = getPlatformIconPath(platform)
  if (!iconPath || failed) return <Server className="w-4 h-4 text-primary-600" />
  return (
    <img
      src={iconPath}
      alt={`${platform} icon`}
      className="w-8 h-8 object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatBrokerMoney(value: number | null | undefined, currency?: string | null): string {
  return formatMoneyWithCode(value, currency?.trim() || undefined)
}

function accountTypeLabelsFromBrokerList(bl: {
  accountTypeDemo: string
  accountTypeLive: string
  accountTypePropFirm: string
}): LinkedAccountTypeLabels {
  return {
    demo: bl.accountTypeDemo,
    live: bl.accountTypeLive,
    propFirm: bl.accountTypePropFirm,
  }
}

function AccountDetailCell({
  label,
  value,
  className,
}: {
  label: string
  value: ReactNode
  className?: string
}) {
  return (
    <div className={clsx('min-w-0 px-4 py-2.5', className)}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50 truncate" title={typeof value === 'string' ? value : undefined}>
        {value}
      </p>
    </div>
  )
}

type ManualSubTabId = 'symbols' | 'channel_instructions' | 'signal_examples' | 'risk' | 'stops' | 'management' | 'filters'

interface ManualSubTabDef {
  id: ManualSubTabId
  label: string
  icon: typeof SlidersHorizontal
}

function defaultChannelConfigDraft(keywordFiltersEnabled = true): ChannelConfigDraft {
  return {
    mode: 'manual',
    manualSettings: normalizeManualSettings(buildDefaultChannelTradingConfig().manual_settings),
    channelFilters: defaultChannelFiltersForPlan(keywordFiltersEnabled),
  }
}

function channelConfigDraftSignature(draft: ChannelConfigDraft): string {
  return JSON.stringify({
    mode: draft.mode,
    manualSettings: draft.manualSettings,
    channelFilters: normalizeChannelFilters(draft.channelFilters),
  })
}

/** Stable signature of what `saveConfigureModal` persists (linked channels + per-channel settings). */
function accountConfigDraftPersistSignature(
  draft: AccountConfigDraft,
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
  keywordFiltersEnabled: boolean,
): string {
  const channelIds = draft.channelIds
  const channels: Record<string, unknown> = {}
  for (const id of channelIds) {
    const entry = draft.channelConfigs[id]
    const mode = entry?.mode ?? 'manual'
    channels[id] = {
      mode: AI_CONFIGURATION_ENABLED && mode === 'ai' ? 'ai' : 'manual',
      manualSettings: normalizeManualSettingsForPlan(
        plan,
        status,
        (entry?.manualSettings ?? DEFAULT_MANUAL_SETTINGS) as Record<string, unknown>,
      ),
      channelFilters: keywordFiltersEnabled
        ? normalizeChannelFilters(entry?.channelFilters ?? DEFAULT_CHANNEL_FILTERS)
        : normalizeChannelFilters(BASIC_PLAN_CHANNEL_FILTERS),
    }
  }
  return JSON.stringify({ channelIds, channels })
}

function isChannelConfigDefault(draft: ChannelConfigDraft, keywordFiltersEnabled = true): boolean {
  return channelConfigDraftSignature(draft) === channelConfigDraftSignature(defaultChannelConfigDraft(keywordFiltersEnabled))
}

function buildChannelConfigDraftFromBroker(
  broker: BrokerAccount,
  channelIds: string[],
  keywordFiltersEnabled = true,
): AccountConfigDraft {
  const storedConfigs = healChannelTradingConfigsMap(broker)
  const persistedFilters = normalizeChannelMessageFiltersMap(broker.channel_message_filters)
  const channelConfigs: Record<string, ChannelConfigDraft> = {}
  const legacyMode = AI_CONFIGURATION_ENABLED && broker.copier_mode !== 'manual' ? 'ai' : 'manual'
  const fallbackManual = normalizeManualSettings(
    broker.manual_settings && typeof broker.manual_settings === 'object'
      ? (broker.manual_settings as Record<string, unknown>)
      : buildDefaultChannelTradingConfig().manual_settings,
    { accountBalance: resolveBrokerTotalBalance(broker) },
  )
  const defaultManual = normalizeManualSettings(buildDefaultChannelTradingConfig().manual_settings)

  for (const id of channelIds) {
    const stored = resolveChannelConfigEntry(storedConfigs, id)
    channelConfigs[id] = {
      mode: stored?.copier_mode === 'ai' ? 'ai' : stored?.copier_mode === 'manual' ? 'manual' : legacyMode,
      manualSettings: stored?.manual_settings && storedPerChannelConfigComplete(storedConfigs, id)
        ? normalizeManualSettings(stored.manual_settings, { accountBalance: resolveBrokerTotalBalance(broker) })
        : fallbackManual ?? defaultManual,
      channelFilters: keywordFiltersEnabled
        ? normalizeChannelFilters(persistedFilters[id] ?? DEFAULT_CHANNEL_FILTERS)
        : normalizeChannelFilters(BASIC_PLAN_CHANNEL_FILTERS),
    }
  }

  return {
    channelIds,
    selectedChannelId: channelIds[0] ?? null,
    channelConfigs,
  }
}

async function resolveLatestManualSettingsPlanContext(args: {
  userId: string
  isAdmin: boolean
  fallback: { plan: SubscriptionPlan | null | undefined; status: string | null | undefined }
}): Promise<{
  plan: SubscriptionPlan | null | undefined
  status: string | null | undefined
  effectivePlan: SubscriptionPlan | null
}> {
  if (args.isAdmin) {
    return {
      plan: 'advanced',
      status: 'active',
      effectivePlan: 'advanced',
    }
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan,status')
    .eq('user_id', args.userId)
    .maybeSingle()

  if (error) {
    const fallbackEffective = resolveEffectivePlan(args.fallback.plan, args.fallback.status)
    return {
      ...args.fallback,
      effectivePlan: fallbackEffective,
    }
  }

  const subscription = data as { plan?: SubscriptionPlan; status?: string | null } | null
  const effective = resolveEffectivePlan(subscription?.plan, subscription?.status ?? null)
  const planCtx = planContextForManualSettings(effective, subscription ?? null)
  return {
    ...planCtx,
    effectivePlan: effective,
  }
}

export function AccountConfigPage() {
  const t = useT()
  const navigate = useNavigate()
  const cm = t.accountConfig.configureModal
  const bl = t.accountConfig.brokerList

  const manualSubTabs = useMemo<ManualSubTabDef[]>(
    () => [
      { id: 'signal_examples', label: cm.manualSubTabs.aiTraining, icon: MessageSquareText },
      { id: 'symbols', label: cm.manualSubTabs.symbols, icon: Coins },
      { id: 'channel_instructions', label: cm.manualSubTabs.channelInstructions, icon: ScrollText },
      { id: 'risk', label: cm.manualSubTabs.risk, icon: Wallet },
      { id: 'stops', label: cm.manualSubTabs.stops, icon: Target },
      { id: 'management', label: cm.manualSubTabs.management, icon: Settings2 },
      { id: 'filters', label: cm.manualSubTabs.filters, icon: Filter },
    ],
    [
      cm.manualSubTabs.aiTraining,
      cm.manualSubTabs.symbols,
      cm.manualSubTabs.channelInstructions,
      cm.manualSubTabs.risk,
      cm.manualSubTabs.stops,
      cm.manualSubTabs.management,
      cm.manualSubTabs.filters,
    ],
  )

  const channelFilterCategories = useMemo(
    () => getChannelFilterCategories(cm),
    [cm],
  )
  const { user } = useAuth()
  const { profile } = useUserProfile()
  const userId = user?.id ?? null
  const {
    brokers,
    loading: brokersLoading,
    loadError: brokersLoadError,
    replaceBroker,
    removeBroker,
    setBrokers,
    toggleBrokerActive: toggleBrokerActiveInStore,
    reconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting: isBrokerReconnecting,
    setReconnectErrorHandler,
    setHealthPollingPaused,
    upsertBroker,
  } = useBrokerAccounts()
  const brokerBalanceRefreshStartedRef = useRef(false)
  const { openAddTradingAccount, pendingConfigureBrokerId, clearPendingConfigureBroker } = useAddTradingAccount()
  const {
    subscription,
    effectivePlan,
    refresh: refreshSubscription,
    canUseFeature: canUsePlanFeature,
    limits,
    isAdmin,
    usage,
    usageLoading,
  } = useSubscription()
  const manualSettingsPlanCtx = useMemo(
    () => planContextForManualSettings(effectivePlan, subscription),
    [effectivePlan, subscription],
  )
  const pw = t.pricing.paywall
  const connectErrorLabels = useMemo(() => brokerConnectErrorLabelsFromI18n(bl), [bl])
  const reconnectBannerText = useMemo(
    () => brokerReconnectBannerText(brokersNeedingReconnect, {
      ...connectErrorLabels,
      droppedOne: bl.reconnectDroppedOne,
      droppedMany: bl.reconnectDroppedMany,
    }),
    [brokersNeedingReconnect, connectErrorLabels, bl.reconnectDroppedOne, bl.reconnectDroppedMany],
  )

  // Re-sync balance (cash + broker credit) when cached last_balance is stale cash-only.
  useEffect(() => {
    if (brokersLoading || brokerBalanceRefreshStartedRef.current) return
    const connected = brokers.filter(
      b => hasFxsocketBrokerSession(b) && b.connection_status === 'connected',
    )
    if (connected.length === 0) return

    const stale = connected.filter(b => {
      const bal = b.last_balance
      const eq = b.last_equity
      if (bal == null || eq == null) return true
      if (eq > bal + 0.01 && bal < eq * 0.2) return true
      const syncedAt = b.last_synced_at ? Date.parse(b.last_synced_at) : 0
      return !syncedAt || Date.now() - syncedAt > 5 * 60_000
    })
    if (stale.length === 0) return

    brokerBalanceRefreshStartedRef.current = true
    let cancelled = false
    void (async () => {
      for (const b of stale) {
        if (cancelled) return
        try {
          const { account } = await fxsocketBroker.refreshSummary(b.id)
          if (!cancelled) replaceBroker(account)
        } catch {
          /* best-effort — throttle must not mark the account disconnected */
        }
        // Space multi-account refreshes to reduce FxSocket throttle storms.
        await new Promise(r => setTimeout(r, 1_200))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [brokers, brokersLoading, replaceBroker])

  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>(() =>
    userId ? (channelOptionsCache.get(userId) ?? []) : [],
  )
  const [configAccount, setConfigAccount] = useState<BrokerAccount | null>(null)
  const [layeringCapabilities, setLayeringCapabilities] = useState<LayeringModeCapabilities>(LEGACY_ONLY_LAYERING_CAPABILITIES)
  const configAccountTotalBalance = useMemo(
    () => (configAccount ? resolveBrokerTotalBalance(configAccount) : null),
    [configAccount],
  )
  const [channelCopyLimitState, setChannelCopyLimitState] = useState<Record<string, CopyLimitState>>({})
  const [configDraft, setConfigDraft] = useState<AccountConfigDraft>({
    channelIds: [],
    selectedChannelId: null,
    channelConfigs: {},
  })
  const [activeManualSubTab, setActiveManualSubTab] = useState<ManualSubTabId>('signal_examples')
  const configScrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Partial<Record<ManualSubTabId, HTMLElement | null>>>({})
  const tabButtonRefs = useRef<Partial<Record<ManualSubTabId, HTMLButtonElement | null>>>({})
  const programmaticScrollRef = useRef(false)
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setSectionRef = useCallback((id: ManualSubTabId, el: HTMLElement | null) => {
    sectionRefs.current[id] = el
  }, [])

  const setTabButtonRef = useCallback((id: ManualSubTabId, el: HTMLButtonElement | null) => {
    tabButtonRefs.current[id] = el
  }, [])

  const scrollToConfigSection = useCallback((id: ManualSubTabId) => {
    const el = sectionRefs.current[id]
    if (!el) {
      setActiveManualSubTab(id)
      return
    }
    programmaticScrollRef.current = true
    if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current)
    setActiveManualSubTab(id)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    programmaticScrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false
      programmaticScrollTimerRef.current = null
    }, 700)
  }, [])

  const resetConfigSectionScroll = useCallback((id: ManualSubTabId = 'signal_examples') => {
    setActiveManualSubTab(id)
    const scroller = configScrollRef.current
    if (scroller) scroller.scrollTop = 0
  }, [])

  const [trainingRunningByChannel, setTrainingRunningByChannel] = useState<Record<string, boolean>>({})
  const [trainingSavingByChannel, setTrainingSavingByChannel] = useState<Record<string, boolean>>({})
  const [trainingProgressByChannel, setTrainingProgressByChannel] = useState<Record<string, number>>({})
  const [configSaving, setConfigSaving] = useState(false)
  const [channelConnecting, setChannelConnecting] = useState(false)
  const [configSavedAt, setConfigSavedAt] = useState<number | null>(null)
  const [configSavedSignature, setConfigSavedSignature] = useState('')
  const [tradingPresets, setTradingPresets] = useState<ChannelTradingPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetStatusMessage, setPresetStatusMessage] = useState<string | null>(null)
  const [showPresetNameModal, setShowPresetNameModal] = useState(false)
  const [showManagePresetsModal, setShowManagePresetsModal] = useState(false)
  const [showExportPresetsModal, setShowExportPresetsModal] = useState(false)
  const [exportNameDraft, setExportNameDraft] = useState('')
  const [exportSelectedIds, setExportSelectedIds] = useState<string[]>([])
  const [presetNameDraft, setPresetNameDraft] = useState('')
  const [pendingApplyPreset, setPendingApplyPreset] = useState<ChannelTradingPreset | null>(null)
  const [editingPreset, setEditingPreset] = useState<ChannelTradingPreset | null>(null)
  const [pendingDeletePreset, setPendingDeletePreset] = useState<ChannelTradingPreset | null>(null)
  const presetImportInputRef = useRef<HTMLInputElement | null>(null)
  const [channelLinkEditMode, setChannelLinkEditMode] = useState(false)
  const [error, setError] = useState('')
  const [channelsLoading, setChannelsLoading] = useState(() =>
    !(userId && channelOptionsCache.has(userId)),
  )
  const loading =
    (brokersLoading && brokers.length === 0)
    || (channelsLoading && channelOptions.length === 0)
  const [brokerPendingDelete, setBrokerPendingDelete] = useState<BrokerAccount | null>(null)
  const [statusModalBroker, setStatusModalBroker] = useState<BrokerAccount | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)

  useEffect(() => {
    setHealthPollingPaused(Boolean(configAccount || brokerPendingDelete || statusModalBroker))
  }, [brokerPendingDelete, configAccount, setHealthPollingPaused, statusModalBroker])
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  const [brokerFilter, setBrokerFilter] = useState('all')
  const [brokerSearchQuery, setBrokerSearchQuery] = useState('')
  const [brokerPage, setBrokerPage] = useState(1)
  const [riskNumberDrafts, setRiskNumberDrafts] = useState<RiskNumberDrafts>({})
  const [symbolsExcludeDraft, setSymbolsExcludeDraft] = useState<string | null>(null)
  const [riskCalcOpen, setRiskCalcOpen] = useState(false)
  const brokerHealthSyncKey = useMemo(
    () => brokers
      .filter(b => hasFxsocketBrokerSession(b))
      .map(b => b.id)
      .sort()
      .join(','),
    [brokers],
  )

  const brokerFilterOptions = useMemo(() => {
    const labels = new Set<string>()
    for (const broker of brokers) {
      const label = resolveBrokerFilterLabel(broker)
      if (label && label !== '—') labels.add(label)
    }
    return [...labels].sort((a, b) => a.localeCompare(b))
  }, [brokers])

  const filteredBrokers = useMemo(() => {
    return brokers.filter(broker => {
      if (brokerFilter !== 'all' && resolveBrokerFilterLabel(broker) !== brokerFilter) return false
      return brokerMatchesSearch(broker, brokerSearchQuery)
    })
  }, [brokers, brokerFilter, brokerSearchQuery])

  const brokerTotalPages = Math.max(1, Math.ceil(filteredBrokers.length / BROKER_PAGE_SIZE))
  const safeBrokerPage = Math.min(brokerPage, brokerTotalPages)

  const paginatedBrokers = useMemo(() => {
    const start = (safeBrokerPage - 1) * BROKER_PAGE_SIZE
    return filteredBrokers.slice(start, start + BROKER_PAGE_SIZE)
  }, [filteredBrokers, safeBrokerPage])

  const brokerRangeStart = filteredBrokers.length === 0 ? 0 : (safeBrokerPage - 1) * BROKER_PAGE_SIZE + 1
  const brokerRangeEnd = Math.min(safeBrokerPage * BROKER_PAGE_SIZE, filteredBrokers.length)

  const linkedBrokerCount = useMemo(
    () => countLinkedBrokerSessions(brokers),
    [brokers],
  )
  const connectedAccountCount = usageLoading ? linkedBrokerCount : usage.brokerAccounts
  const connectedAccountLimit = limits.maxBrokerAccounts

  useEffect(() => {
    setBrokerPage(1)
  }, [brokerFilter, brokerSearchQuery])

  useEffect(() => {
    if (brokerPage > brokerTotalPages) setBrokerPage(brokerTotalPages)
  }, [brokerPage, brokerTotalPages])

  useEffect(() => {
    if (!configAccount) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [configAccount])

  useEffect(() => {
    let cancelled = false
    if (!configAccount?.id) {
      void Promise.resolve().then(() => {
        if (!cancelled) setLayeringCapabilities(LEGACY_ONLY_LAYERING_CAPABILITIES)
      })
      return () => {
        cancelled = true
      }
    }
    const accountId = configAccount.id
    void fetchLayeringModeCapabilities(accountId)
      .then(capabilities => {
        if (!cancelled) setLayeringCapabilities(capabilities)
      })
      .catch(() => {
        if (!cancelled) setLayeringCapabilities(LEGACY_ONLY_LAYERING_CAPABILITIES)
      })
    return () => {
      cancelled = true
    }
  }, [configAccount?.id])

  useEffect(() => {
    if (!brokerHealthSyncKey) return
    void syncBrokerAccountTypesFromHealth(brokers)
  }, [brokerHealthSyncKey])

  const channelManualSettings = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id) return DEFAULT_MANUAL_SETTINGS
    return configDraft.channelConfigs[id]?.manualSettings ?? DEFAULT_MANUAL_SETTINGS
  }, [configDraft.selectedChannelId, configDraft.channelConfigs])

  useEffect(() => {
    setRiskNumberDrafts({})
    setSymbolsExcludeDraft(null)
  }, [configDraft.selectedChannelId])

  const channelMode = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id) return 'manual' as const
    return configDraft.channelConfigs[id]?.mode ?? 'manual'
  }, [configDraft.selectedChannelId, configDraft.channelConfigs])

  const selectedChannelOption = useMemo(
    () => channelOptions.find(c => c.id === configDraft.selectedChannelId) ?? null,
    [channelOptions, configDraft.selectedChannelId],
  )

  const configureAccountType = useMemo((): LinkedAccountType | undefined => {
    if (!configAccount) return undefined
    return resolveLinkedAccountTypeForBroker(configAccount)
  }, [configAccount])

  const keywordFiltersEnabled = canUsePlanFeature('channel_keyword_filters')
  const multiTradeStyleEnabled = canUsePlanFeature('multi_trade_style')
  // Static/dynamic layering modes stay legacy-only in the UI for now.
  const selectedLayeringMode = 'legacy' as const
  const selectedLayeringMechanism = channelManualSettings.range_layering_type === 'pending_order'
    ? 'pending_order'
    : 'auto'
  const selectedModeAutoSelectable = layeringMechanismIsSelectable(layeringCapabilities, selectedLayeringMode, 'auto')

  const previewManualLot = useMemo(() => {
    const ms = channelManualSettings
    const fixedDraft = riskNumberDrafts.fixed_lot
    const fixedLot = fixedDraft !== undefined && ms.risk_mode !== 'dynamic_balance_percent'
      ? commitPositiveNumber(fixedDraft, ms.fixed_lot ?? DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01)
      : ms.fixed_lot
    const { patch } = riskDraftManualPatch(riskNumberDrafts, 0)
    return resolvePreviewManualLot({
      manualSettings: { ...ms, ...patch, fixed_lot: fixedLot },
      accountBalance: configAccountTotalBalance,
    })
  }, [
    channelManualSettings,
    riskNumberDrafts,
    configAccountTotalBalance,
  ])

  const multiTradeMinLegPercent = useMemo(
    () => computeMinMultiTradeLegPercent(previewManualLot),
    [previewManualLot],
  )

  const setRiskNumberDraft = useCallback((key: RiskNumberDraftKey, raw: string) => {
    setRiskNumberDrafts(prev => ({ ...prev, [key]: raw }))
  }, [])

  const riskNumberFieldError = useCallback((key: RiskNumberDraftKey): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(riskNumberDrafts, key)) return undefined
    const raw = riskNumberDrafts[key] ?? ''
    return draftNumberError(
      raw,
      riskNumberRules(key, multiTradeMinLegPercent),
      cm.risk.fieldErrors,
      interpolate,
    ) ?? undefined
  }, [riskNumberDrafts, multiTradeMinLegPercent, cm.risk.fieldErrors])

  const commitRiskNumberField = useCallback((key: RiskNumberDraftKey) => {
    if (!Object.prototype.hasOwnProperty.call(riskNumberDrafts, key)) return
    const raw = riskNumberDrafts[key] ?? ''
    const rules = riskNumberRules(key, multiTradeMinLegPercent)
    const parsed = parseDraftNumber(raw, rules)
    if (parsed == null) return
    setConfigDraft(prev => {
      const id = prev.selectedChannelId
      if (!id || !prev.channelConfigs[id]) return prev
      const entry = prev.channelConfigs[id]!
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [id]: {
            ...entry,
            manualSettings: { ...entry.manualSettings, [key]: parsed },
          },
        },
      }
    })
    setRiskNumberDrafts(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [riskNumberDrafts, multiTradeMinLegPercent])

  const riskNumberFieldProps = useCallback((
    key: RiskNumberDraftKey,
    stored: number | undefined,
    fallback: number,
  ) => ({
    type: 'text' as const,
    inputMode: 'decimal' as const,
    value: numberFieldDisplay(stored, riskNumberDrafts[key], fallback),
    error: riskNumberFieldError(key),
    onChange: (e: { target: { value: string } }) => setRiskNumberDraft(key, e.target.value),
    onBlur: () => commitRiskNumberField(key),
    onKeyDown: (e: { key: string; preventDefault: () => void; target: EventTarget }) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
    },
  }), [
    riskNumberDrafts,
    riskNumberFieldError,
    setRiskNumberDraft,
    commitRiskNumberField,
  ])

  const configureModalDirty = useMemo(() => {
    if (!configAccount) return false
    const draftForSignature = applyPendingConfigureDraftFields(
      configDraft,
      riskNumberDrafts,
      symbolsExcludeDraft,
      multiTradeMinLegPercent,
    )
    const current = accountConfigDraftPersistSignature(
      draftForSignature,
      manualSettingsPlanCtx.plan,
      manualSettingsPlanCtx.status,
      keywordFiltersEnabled,
    )
    return current !== configSavedSignature
  }, [
    configAccount,
    configDraft,
    riskNumberDrafts,
    symbolsExcludeDraft,
    multiTradeMinLegPercent,
    configSavedSignature,
    manualSettingsPlanCtx.plan,
    manualSettingsPlanCtx.status,
    keywordFiltersEnabled,
  ])

  const selectedChannelNeedsPersistedSave = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id || !configAccount || !configDraft.channelIds.includes(id)) return false
    const stored = healChannelTradingConfigsMap(configAccount)
    return !storedPerChannelConfigComplete(stored, id)
  }, [configDraft.selectedChannelId, configDraft.channelIds, configAccount])

  const canSaveConfigureModal = configureModalDirty || selectedChannelNeedsPersistedSave

  const multiTradeSplitSaveBlocked = useMemo(() => {
    const draftForCheck = applyPendingConfigureDraftFields(
      configDraft,
      riskNumberDrafts,
      symbolsExcludeDraft,
      multiTradeMinLegPercent,
    )
    return hasBlockedMultiTradeSplit(
      draftForCheck.channelIds,
      draftForCheck.channelConfigs,
      configAccountTotalBalance,
    )
  }, [configDraft, riskNumberDrafts, symbolsExcludeDraft, multiTradeMinLegPercent, configAccountTotalBalance])

  const selectedChannelEditedFromDefault = useMemo(() => {
    const id = configDraft.selectedChannelId
    if (!id || !configDraft.channelIds.includes(id)) return false
    const entry = configDraft.channelConfigs[id]
    if (!entry) return false
    return !isChannelConfigDefault(entry, keywordFiltersEnabled)
  }, [configDraft.selectedChannelId, configDraft.channelIds, configDraft.channelConfigs, keywordFiltersEnabled])

  const selectedChannelLinked = Boolean(
    configDraft.selectedChannelId
    && configDraft.channelIds.includes(configDraft.selectedChannelId),
  )

  const activeChannelTrainingRunning = configDraft.selectedChannelId
    ? trainingRunningByChannel[configDraft.selectedChannelId] === true
    : false
  const activeChannelTrainingSaving = configDraft.selectedChannelId
    ? trainingSavingByChannel[configDraft.selectedChannelId] === true
    : false
  const activeChannelTrainingProgress = configDraft.selectedChannelId
    ? Math.max(0, Math.min(100, Math.round(trainingProgressByChannel[configDraft.selectedChannelId] ?? 0)))
    : 0

  const dynamicBalanceLotPreview = useMemo(() => {
    if (channelManualSettings.risk_mode !== 'dynamic_balance_percent') return null
    const lot = resolvePreviewManualLot({
      manualSettings: channelManualSettings,
      accountBalance: configAccountTotalBalance,
    })
    const balance = Number(configAccountTotalBalance ?? 0)
    const percent = Number(channelManualSettings.dynamic_balance_percent ?? 1) || 1
    const lotLabel = formatPreviewLotSize(lot)
    const hint = balance > 0
      ? interpolate(cm.risk.dynamicBalanceLotSizeHint, {
          lot: lotLabel,
          percent: String(percent),
          balance: formatBrokerMoney(balance, configAccount?.last_currency),
        })
      : interpolate(cm.risk.dynamicBalanceLotSizeFallback, { lot: lotLabel })
    return { lot, lotLabel, hint }
  }, [
    channelManualSettings.risk_mode,
    channelManualSettings.dynamic_balance_percent,
    channelManualSettings.fixed_lot,
    configAccountTotalBalance,
    configAccount?.last_currency,
    cm.risk.dynamicBalanceLotSizeHint,
    cm.risk.dynamicBalanceLotSizeFallback,
  ])

  const multiTradePreview = useMemo(() => {
    const ms = channelManualSettings
    const legPct = Number(ms.multi_trade_leg_percent ?? 5) || 5
    const range = ms.range_trading
      ? {
          enabled: true,
          percent: Number(ms.range_percent ?? 50) || 0,
          stepPips: Number(ms.range_step_pips ?? 0) || 0,
          distancePips: Number(ms.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0,
          useSignalEntryRange: ms.use_signal_entry_range === true,
        }
      : undefined
    return estimateMultiTradeOrderCount({ manualLot: previewManualLot, legPercent: legPct, range })
  }, [
    previewManualLot,
    channelManualSettings.multi_trade_leg_percent,
    channelManualSettings.range_trading,
    channelManualSettings.range_percent,
    channelManualSettings.range_step_pips,
    channelManualSettings.range_distance_pips,
    channelManualSettings.use_signal_entry_range,
  ])

  const multiTradeTotalOpenTradesLabel = useMemo(() => {
    const legPct = Number(channelManualSettings.multi_trade_leg_percent ?? 5) || 5
    const perLeg = resolveMultiTradePerLegLot({ manualLot: previewManualLot, legPercent: legPct })
    return formatMultiTradeTotalOpenTradesPreview(perLeg, multiTradePreview, {
      fallbackSingle: cm.risk.previewFallbackSingle,
      lotsXTrades: cm.risk.previewLotsXTrades,
      lotsXTradesLayered: cm.risk.previewLotsXTradesLayered,
    }, formatPreviewLotSize)
  }, [
    previewManualLot,
    channelManualSettings.multi_trade_leg_percent,
    multiTradePreview,
    cm.risk.previewFallbackSingle,
    cm.risk.previewLotsXTrades,
    cm.risk.previewLotsXTradesLayered,
  ])

  /** Broker min lot cannot be partially closed — half/partial channel instructions close the full trade. */
  const showMinLotPartialCloseWarning = useMemo(() => {
    if (!configDraft.selectedChannelId) return false
    const filters = normalizeChannelFilters(
      configDraft.channelConfigs[configDraft.selectedChannelId]?.channelFilters
        ?? defaultChannelFiltersForPlan(keywordFiltersEnabled),
    )
    if (filters.close_half !== 'allow') return false

    const tradeStyle = channelManualSettings.trade_style ?? 'single'
    let effectiveLot = previewManualLot
    if (tradeStyle === 'multi') {
      const legPct = Number(channelManualSettings.multi_trade_leg_percent ?? 5) || 5
      const perLeg = resolveMultiTradePerLegLot({ manualLot: previewManualLot, legPercent: legPct })
      if (perLeg != null) effectiveLot = perLeg
    }
    return Number.isFinite(effectiveLot) && +(effectiveLot).toFixed(2) <= 0.01
  }, [
    configDraft.selectedChannelId,
    configDraft.channelConfigs,
    keywordFiltersEnabled,
    channelManualSettings.trade_style,
    channelManualSettings.multi_trade_leg_percent,
    previewManualLot,
  ])

  const singleTpLotBreakdownText = useMemo(() => {
    if ((channelManualSettings.trade_style ?? 'single') === 'multi') return null
    const slices = computeSingleTpLotBreakdown({
      manualLot: previewManualLot,
      singleTpTarget: channelManualSettings.single_tp_target ?? 'farthest',
      tpLots: channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS,
    })
    if (!slices.length) return null
    const join = cm.risk.singleTpLotBreakdownJoin
    return slices
      .map(s => interpolate(cm.risk.singleTpLotBreakdownSlice, {
        lot: String(Number(s.lots.toFixed(2))),
        tp: s.tpLabel,
      }))
      .join(join)
  }, [
    channelManualSettings.trade_style,
    channelManualSettings.single_tp_target,
    channelManualSettings.tp_lots,
    previewManualLot,
    cm.risk.singleTpLotBreakdownJoin,
    cm.risk.singleTpLotBreakdownSlice,
  ])

  const multiTradePreviewTooltip = useMemo(() => {
    const ms = channelManualSettings
    let text = cm.risk.previewFooter
    if (ms.risk_mode === 'dynamic_balance_percent') text += cm.risk.previewDynamicRisk
    const activePending = multiTradePreview.activePending ?? multiTradePreview.pending ?? 0
    if (
      ms.range_trading
      && multiTradePreview.effectiveDistancePips != null
      && activePending > 0
    ) {
      text += interpolate(cm.risk.previewLadderSpan, {
        active: String(activePending),
        step: String(Number(ms.range_step_pips ?? 0) || 0),
        distance: String(multiTradePreview.effectiveDistancePips),
      })
      const reservedPending = multiTradePreview.pending ?? 0
      if (activePending < reservedPending) {
        text += interpolate(cm.risk.previewLadderDistanceCap, {
          active: String(activePending),
          pending: String(reservedPending),
        })
      }
    }
    if (ms.use_signal_entry_range === true) {
      text += cm.risk.previewSignalRangeFootnote
    }
    return text
  }, [channelManualSettings, cm.risk, multiTradePreview])

  const brokersNeedingRelink = useMemo(
    () => brokers.filter(b => isLegacyBrokerLink(b.metaapi_account_id)),
    [brokers],
  )

  useEffect(() => {
    setReconnectErrorHandler(message => setError(message))
    return () => setReconnectErrorHandler(null)
  }, [setReconnectErrorHandler])

  const tpLegPercentTotal = useMemo(() => {
    const rows = channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
    return rows.filter(r => r.enabled).reduce((s, r) => s + (Number(r.percent) || 0), 0)
  }, [channelManualSettings.tp_lots])

  /**
   * Live pip quote for the Account Config page.
   *
   * Why we derive `point` / `digits` from the symbol class instead of calling
   * /SymbolParams: this panel is an editor, not an executor. The broker round-
   * trip would add latency to every keystroke and we already have the trader-
   * conventional defaults baked into `pipCalculator`. The actual trade
   * execution uses real broker data (see worker/src/tradeExecutor.ts), so
   * server-side risk pricing is always exact.
   *
   * `null` means the user hasn't entered a symbol (or entered more than one).
   * Hints in that case fall back to the legacy static text.
   */
  const livePipQuote: PipQuote | null = useMemo(() => {
    const raw = (channelManualSettings.symbol_to_trade ?? '').trim()
    if (!raw) return null
    // Symbol-to-Trade is a whitelist; only compute when there's exactly one
    // symbol so the hint can't lie about an ambiguous multi-symbol config.
    const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    if (parts.length !== 1) return null
    const symbol = parts[0].toUpperCase()
    const klass = classifySymbol(symbol)
    // Trader-conventional broker quote precision per class. These mirror the
    // pip price floors inside `pipCalculator` so the displayed pip value
    // always matches what the planner will use on a sane 2/3/4/5-digit
    // broker.
    let point: number
    let digits: number
    switch (klass) {
      case 'fx_jpy':       point = 0.001;   digits = 3; break
      case 'fx_major':     point = 0.00001; digits = 5; break
      case 'metal':        point = 0.01;    digits = 2; break
      case 'index':        point = 1;       digits = 0; break
      case 'crypto':       point = 0.01;    digits = 2; break
      case 'energy':       point = 0.01;    digits = 2; break
      default:             point = 0.00001; digits = 5; break
    }
    return pipCalculator(symbol, point, digits)
  }, [channelManualSettings.symbol_to_trade])

  /**
   * Pip-count hint: signal pip size (matches backtest) plus optional $/lot from pipCalculator.
   */
  const formatPipHint = useMemo(() => {
    return (pipCount: number): string | null => {
      const raw = (channelManualSettings.symbol_to_trade ?? '').trim()
      if (!raw) return null
      const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
      if (parts.length !== 1) return null
      const symbol = parts[0].toUpperCase()
      const pipPx = livePipQuote?.pipPrice ?? signalPipPrice(symbol)
      const klass = classifySymbol(symbol)
      const priceDigits =
        klass === 'fx_major' ? 4
          : klass === 'fx_jpy' ? 2
            : klass === 'index' ? 0
              : 2
      const fmtPrice = (n: number) => n.toFixed(priceDigits)
      const priceOffset = pipCount > 0 ? pipCount * pipPx : pipPx
      const fixedLot = Number(channelManualSettings.fixed_lot ?? 0.01) || 0.01
      const perPip = livePipQuote ? pipValueForLots(livePipQuote, fixedLot) : 0
      const ccy = livePipQuote?.quoteCurrency ?? undefined
      const fmtMoney = (n: number) => formatMoneyWithCode(n, ccy, { nullAsDash: false })
      return formatPipHintI18n(cm.pipHint, {
        pipCount,
        symbol,
        fmtPrice,
        priceOffset,
        pipPx,
        fixedLot,
        perPip,
        fmtMoney,
      })
    }
  }, [cm.pipHint, livePipQuote, channelManualSettings.fixed_lot, channelManualSettings.symbol_to_trade])

  const rangeDistanceFieldHint = useMemo(() => {
    if (channelManualSettings.use_signal_entry_range === true) {
      return cm.risk.useSignalRangeDistanceDisabledHint
    }
    const distPips = Number(channelManualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0
    const base = formatPipHint(distPips) ?? cm.risk.rangeDistanceFallback
    if (channelManualSettings.range_trading) {
      const activePending = multiTradePreview.activePending ?? 0
      const pending = multiTradePreview.pending ?? 0
      if (activePending > 0 && activePending < pending) {
        return `${base}${interpolate(cm.risk.previewLadderDistanceCap, {
          active: String(activePending),
          pending: String(pending),
        })}`
      }
    }
    return base
  }, [
    channelManualSettings.use_signal_entry_range,
    channelManualSettings.range_trading,
    channelManualSettings.range_distance_pips,
    cm.risk,
    formatPipHint,
    multiTradePreview.activePending,
    multiTradePreview.pending,
  ])

  const resolvedSingleSymbol = useMemo(() => {
    const raw = (channelManualSettings.symbol_to_trade ?? '').trim()
    if (!raw) return ''
    const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    return parts.length === 1 ? parts[0]!.toUpperCase() : ''
  }, [channelManualSettings.symbol_to_trade])

  useEffect(() => {
    if (!userId) return
    void loadData(userId)
  }, [userId])

  useEffect(() => {
    if (configSavedAt == null) return
    const t = setTimeout(() => setConfigSavedAt(null), 2500)
    return () => clearTimeout(t)
  }, [configSavedAt])

  useEffect(() => {
    if (presetStatusMessage == null) return
    const t = setTimeout(() => setPresetStatusMessage(null), 2500)
    return () => clearTimeout(t)
  }, [presetStatusMessage])

  useEffect(() => {
    if (!selectedChannelLinked) return
    const root = configScrollRef.current
    if (!root) return

    const sectionIds = manualSubTabs.map(s => s.id)
    let observer: IntersectionObserver | null = null
    let cancelled = false
    let attempts = 0

    const attach = () => {
      if (cancelled) return
      const els = sectionIds
        .map(id => sectionRefs.current[id])
        .filter((el): el is HTMLElement => Boolean(el))
      if (els.length < sectionIds.length && attempts < 10) {
        attempts += 1
        requestAnimationFrame(attach)
        return
      }
      if (els.length === 0) return
      observer = new IntersectionObserver(
        entries => {
          if (programmaticScrollRef.current) return
          const visible = entries
            .filter(e => e.isIntersecting)
            .map(e => {
              const id = (e.target as HTMLElement).dataset.configSection as ManualSubTabId | undefined
              return id ? { id, top: e.boundingClientRect.top } : null
            })
            .filter((v): v is { id: ManualSubTabId; top: number } => Boolean(v))
          if (visible.length === 0) return
          visible.sort((a, b) => a.top - b.top)
          const next = visible[0]?.id
          if (!next) return
          setActiveManualSubTab(prev => (prev === next ? prev : next))
        },
        {
          root,
          rootMargin: '-10% 0px -65% 0px',
          threshold: [0, 0.1, 0.25],
        },
      )
      for (const el of els) observer.observe(el)
    }

    attach()

    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [manualSubTabs, selectedChannelLinked, configDraft.selectedChannelId])

  useEffect(() => {
    if (!selectedChannelLinked) return
    const btn = tabButtonRefs.current[activeManualSubTab]
    btn?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [activeManualSubTab, selectedChannelLinked])

  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current)
    }
  }, [])

  const startBackgroundAiTraining = useCallback((channelId: string, opts?: { force?: boolean }) => {
    if (!userId) {
      return Promise.resolve({ trained: false, error: 'Not signed in' })
    }
    return triggerBackgroundChannelAiTraining(channelId, {
      userId,
      skipIfAlreadyTrained: opts?.force ? false : true,
      progress: {
        onRunningChange: running =>
          setTrainingRunningByChannel(prev => ({ ...prev, [channelId]: running })),
        onSavingChange: saving =>
          setTrainingSavingByChannel(prev => ({ ...prev, [channelId]: saving })),
        onProgressChange: progress =>
          setTrainingProgressByChannel(prev => ({ ...prev, [channelId]: progress })),
      },
    })
  }, [userId])

  const refreshTradingPresets = async (uid: string) => {
    setPresetsLoading(true)
    try {
      const rows = await listTradingPresets(uid)
      setTradingPresets(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets')
    } finally {
      setPresetsLoading(false)
    }
  }

  const syncBrokerAccountTypesFromHealth = async (list: BrokerAccount[]) => {
    const linked = list.filter(b => hasFxsocketBrokerSession(b))
    if (linked.length === 0) return

    const results = await Promise.all(
      linked.map(async b => {
        try {
          const { account, status } = await fxsocketBroker.checkStatus(b.id)
          return { account, status } as const
        } catch (err) {
          if (err instanceof BrokerHealthCheckUnsupportedError) {
            return 'unsupported' as const
          }
          return null
        }
      }),
    )

    if (results.some(r => r === 'unsupported')) return

    for (const row of results) {
      if (!row || row === 'unsupported') continue
      upsertBroker({
        ...row.account,
        ...brokerAccountHealthPatchFromMtStatus(row.status),
      })
    }
  }

  const loadData = async (uid: string) => {
    const cached = channelOptionsCache.get(uid)
    if (cached) {
      setChannelOptions(cached)
      setChannelsLoading(false)
    }
    const channelsRes = await supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,is_active,created_at')
      .eq('user_id', uid)
        .eq('is_active', true)
      .order('created_at', { ascending: false })
    const next = (channelsRes.data ?? []) as ChannelOption[]
    channelOptionsCache.set(uid, next)
    setChannelOptions(next)
    setChannelsLoading(false)
  }

  // ── Configure modal ────────────────────────────────────────────────────

  const openConfigureModal = async (broker: BrokerAccount) => {
    const fresh = brokers.find(b => b.id === broker.id) ?? broker
    const { rows, error: configLoadErr } = await fetchBrokerChannelTradingConfigRows(supabase, fresh.id)
    if (configLoadErr) {
      setError(configLoadErr)
      return
    }
    const merged = mergeBrokerWithChannelTradingConfigRows(fresh, rows)
    const channelIds = filterChannelIdsToActiveOptions(
      normalizeSignalChannelIds(merged),
      channelOptions,
    )
    setConfigAccount(merged)
    const limitStateMap: Record<string, CopyLimitState> = {}
    for (const row of rows) {
      limitStateMap[row.channel_id] = normalizeCopyLimitState(row.copy_limit_state)
    }
    setChannelCopyLimitState(limitStateMap)
    resetConfigSectionScroll('signal_examples')
    const draft = buildChannelConfigDraftFromBroker(merged, channelIds, keywordFiltersEnabled)
    const nextDraft = {
      ...draft,
      selectedChannelId: draft.selectedChannelId ?? channelOptions[0]?.id ?? null,
    }
    setConfigDraft(nextDraft)
    setConfigSavedSignature(
      accountConfigDraftPersistSignature(
        nextDraft,
        manualSettingsPlanCtx.plan,
        manualSettingsPlanCtx.status,
        keywordFiltersEnabled,
      ),
    )
    setChannelLinkEditMode(false)
    if (userId) void refreshTradingPresets(userId)
  }

  useEffect(() => {
    if (!pendingConfigureBrokerId || brokersLoading) return
    const broker = brokers.find(b => b.id === pendingConfigureBrokerId)
    if (!broker) return
    if (configAccount?.id === pendingConfigureBrokerId) {
      clearPendingConfigureBroker()
      return
    }
    if (channelsLoading && channelOptions.length === 0) return
    void openConfigureModal(broker)
    clearPendingConfigureBroker()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open configure once when broker connect success requests it
  }, [
    pendingConfigureBrokerId,
    brokers,
    brokersLoading,
    channelsLoading,
    channelOptions.length,
    configAccount?.id,
    clearPendingConfigureBroker,
  ])

  const selectConfigureChannel = (channelId: string) => {
    setConfigDraft(prev => ({ ...prev, selectedChannelId: channelId }))
    resetConfigSectionScroll('signal_examples')
  }

  const connectSelectedChannelToBroker = async () => {
    if (!configAccount || !user || !configDraft.selectedChannelId) return
    const channelId = configDraft.selectedChannelId
    if (configDraft.channelIds.includes(channelId)) return

    setChannelConnecting(true)
    setError('')
    try {
      const { broker: updated, error: connectErr } = await connectChannelToBroker(
        supabase,
        user.id,
        configAccount,
        channelId,
        { defaultChannelFilters: defaultChannelFiltersForPlan(keywordFiltersEnabled) },
      )
      if (connectErr) {
        setError(connectErr)
        return
      }
      if (!updated) return

      const { rows, error: configLoadErr } = await fetchBrokerChannelTradingConfigRows(supabase, updated.id)
      if (configLoadErr) {
        setError(configLoadErr)
        return
      }
      const merged = mergeBrokerWithChannelTradingConfigRows(updated, rows)
      replaceBroker(merged)
      setConfigAccount(merged)
      const linkedIds = filterChannelIdsToActiveOptions(
        normalizeSignalChannelIds(merged),
        channelOptions,
      )
      const rebuilt = buildChannelConfigDraftFromBroker(merged, linkedIds, keywordFiltersEnabled)
      const nextDraft = {
        ...rebuilt,
        selectedChannelId: channelId,
      }
      setConfigDraft(nextDraft)
      setConfigSavedSignature(
        accountConfigDraftPersistSignature(
          nextDraft,
          manualSettingsPlanCtx.plan,
          manualSettingsPlanCtx.status,
          keywordFiltersEnabled,
        ),
      )
      startBackgroundAiTraining(channelId)
    } finally {
      setChannelConnecting(false)
    }
  }

  useEffect(() => {
    const channelId = configDraft.selectedChannelId
    if (!channelId) return
    if (!trainingRunningByChannel[channelId] && !trainingSavingByChannel[channelId]) return
    const timer = setInterval(() => {
      setTrainingProgressByChannel(prev => {
        const current = prev[channelId] ?? 0
        if (trainingSavingByChannel[channelId]) {
          const next = Math.min(98, current + 2)
          return next === current ? prev : { ...prev, [channelId]: next }
        }
        const next = Math.min(92, current + 3)
        return next === current ? prev : { ...prev, [channelId]: next }
      })
    }, 450)
    return () => clearInterval(timer)
  }, [configDraft.selectedChannelId, trainingRunningByChannel, trainingSavingByChannel])

  const closeConfigureModal = (options?: { force?: boolean }) => {
    if (!options?.force && configAccount) {
      const draftForSignature = applyPendingConfigureDraftFields(
        configDraft,
        riskNumberDrafts,
        symbolsExcludeDraft,
        multiTradeMinLegPercent,
      )
      const currentSignature = accountConfigDraftPersistSignature(
        draftForSignature,
        manualSettingsPlanCtx.plan,
        manualSettingsPlanCtx.status,
        keywordFiltersEnabled,
      )
      const dirty = currentSignature !== configSavedSignature
      const selectedId = configDraft.selectedChannelId
      const needsPersistedSave = Boolean(
        selectedId
        && configDraft.channelIds.includes(selectedId)
        && !storedPerChannelConfigComplete(healChannelTradingConfigsMap(configAccount), selectedId),
      )
      if (dirty || needsPersistedSave) {
        if (!window.confirm(cm.closeUnsavedConfirm)) return
      }
    }
    setConfigAccount(null)
    setConfigSavedSignature('')
    setShowPresetNameModal(false)
    setShowManagePresetsModal(false)
    setShowExportPresetsModal(false)
    setPresetNameDraft('')
    setExportNameDraft('')
    setExportSelectedIds([])
    setPendingApplyPreset(null)
    setEditingPreset(null)
    setPendingDeletePreset(null)
    setChannelLinkEditMode(false)
    setError('')
  }

  const toggleDraftChannel = (channelId: string) => {
    setConfigDraft(prev => {
      const willEnable = !prev.channelIds.includes(channelId)
      const channelIds = willEnable
        ? [...prev.channelIds, channelId]
        : prev.channelIds.filter(id => id !== channelId)
      const channelConfigs = { ...prev.channelConfigs }
      if (willEnable && !channelConfigs[channelId]) {
        channelConfigs[channelId] = defaultChannelConfigDraft(keywordFiltersEnabled)
      }
      let selectedChannelId = prev.selectedChannelId
      if (willEnable && !selectedChannelId) selectedChannelId = channelId
      if (!willEnable && selectedChannelId === channelId) {
        selectedChannelId = channelIds[0] ?? null
      }
      return { ...prev, channelIds, channelConfigs, selectedChannelId }
    })
  }

  const setChannelFilter = (
    channelId: string,
    key: ChannelFilterKey,
    value: ChannelFilterDecision,
  ) => {
    setConfigDraft(prev => {
      const entry = prev.channelConfigs[channelId]
      if (!entry) return prev
      const current = entry.channelFilters ?? DEFAULT_CHANNEL_FILTERS
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [channelId]: {
            ...entry,
            channelFilters: { ...current, [key]: value },
          },
        },
      }
    })
  }

  const resetChannelFilters = (channelId: string) => {
    setConfigDraft(prev => {
      const entry = prev.channelConfigs[channelId]
      if (!entry) return prev
      return {
      ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [channelId]: { ...entry, channelFilters: defaultChannelFiltersForPlan(keywordFiltersEnabled) },
        },
      }
    })
  }

  const patchSelectedChannel = (
    patch: (current: ChannelConfigDraft) => ChannelConfigDraft,
  ) => {
    setConfigDraft(prev => {
      const id = prev.selectedChannelId
      if (!id || !prev.channelConfigs[id]) return prev
      return {
        ...prev,
        channelConfigs: {
          ...prev.channelConfigs,
          [id]: patch(prev.channelConfigs[id]),
        },
      }
    })
  }

  const confirmApplyPreset = async () => {
    if (!pendingApplyPreset || !configDraft.selectedChannelId) return
    const channelId = configDraft.selectedChannelId
    if (!configDraft.channelConfigs[channelId]) return

    const preset = pendingApplyPreset
    const payload = presetToChannelConfigDraft(preset)
    const committedDraft: AccountConfigDraft = {
      ...configDraft,
      channelConfigs: {
        ...configDraft.channelConfigs,
        [channelId]: {
          mode: payload.mode,
          manualSettings: payload.manualSettings,
          channelFilters: payload.channelFilters,
        },
      },
    }
    setConfigDraft(committedDraft)
    const ok = await persistConfigureDraft(committedDraft)
    if (ok) {
      setPendingApplyPreset(null)
    }
  }

  const openSavePresetModal = () => {
    if (!configDraft.selectedChannelId || !configDraft.channelConfigs[configDraft.selectedChannelId]) {
      setError(cm.presetSelectChannelFirst)
      return
    }
    setError('')
    setPresetNameDraft(selectedChannelOption?.display_name ?? '')
    setShowPresetNameModal(true)
  }

  const confirmSavePreset = async () => {
    if (!user?.id || !configDraft.selectedChannelId) return
    const entry = configDraft.channelConfigs[configDraft.selectedChannelId]
    if (!entry) return
    const name = presetNameDraft.trim()
    if (!name) return

    setPresetSaving(true)
    setError('')
    try {
      const saved = await upsertTradingPreset(user.id, name, {
        mode: entry.mode,
        manualSettings: entry.manualSettings,
        channelFilters: entry.channelFilters,
      })
      setTradingPresets(prev => {
        const next = prev.filter(p => p.id !== saved.id && p.name !== saved.name)
        return [...next, saved].sort((a, b) => a.name.localeCompare(b.name))
      })
      setShowPresetNameModal(false)
      setPresetNameDraft('')
      setPresetStatusMessage(cm.presetSaved)
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.saveAsPreset)
    } finally {
      setPresetSaving(false)
    }
  }

  const openEditPresetModal = (preset: ChannelTradingPreset) => {
    setError('')
    setEditingPreset(preset)
    setPresetNameDraft(preset.name)
  }

  const confirmEditPreset = async () => {
    if (!user?.id || !editingPreset) return
    const name = presetNameDraft.trim()
    if (!name) return

    setPresetSaving(true)
    setError('')
    try {
      const saved = await renameTradingPreset(user.id, editingPreset.id, name)
      setTradingPresets(prev =>
        prev
          .map(p => (p.id === saved.id ? saved : p))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      setEditingPreset(null)
      setPresetNameDraft('')
      setPresetStatusMessage(cm.presetSaved)
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.editPresetTitle)
    } finally {
      setPresetSaving(false)
    }
  }

  const confirmDeletePreset = async () => {
    if (!user?.id || !pendingDeletePreset) return

    setPresetSaving(true)
    setError('')
    try {
      await deleteTradingPreset(user.id, pendingDeletePreset.id)
      setTradingPresets(prev => prev.filter(p => p.id !== pendingDeletePreset.id))
      if (pendingApplyPreset?.id === pendingDeletePreset.id) setPendingApplyPreset(null)
      if (editingPreset?.id === pendingDeletePreset.id) {
        setEditingPreset(null)
        setPresetNameDraft('')
      }
      setPendingDeletePreset(null)
      setPresetStatusMessage(cm.presetDeleted)
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.deletePresetTitle)
    } finally {
      setPresetSaving(false)
    }
  }

  const openExportPresetsModal = () => {
    if (tradingPresets.length === 0) return
    setError('')
    const ids = tradingPresets.map(p => p.id)
    setExportSelectedIds(ids)
    setExportNameDraft(
      tradingPresets.length === 1 ? tradingPresets[0]!.name : 'tscopier-presets',
    )
    setShowExportPresetsModal(true)
  }

  const setExportSelection = (nextIds: string[]) => {
    setExportSelectedIds(nextIds)
    if (nextIds.length === 1) {
      const hit = tradingPresets.find(p => p.id === nextIds[0])
      if (hit) setExportNameDraft(hit.name)
      return
    }
    if (nextIds.length > 1) {
      setExportNameDraft(prev => {
        const singleNames = new Set(tradingPresets.map(p => p.name))
        if (!prev.trim() || singleNames.has(prev.trim())) return 'tscopier-presets'
        return prev
      })
    }
  }

  const toggleExportPreset = (presetId: string) => {
    setExportSelection(
      exportSelectedIds.includes(presetId)
        ? exportSelectedIds.filter(id => id !== presetId)
        : [...exportSelectedIds, presetId],
    )
  }

  const confirmExportPresets = () => {
    const selected = tradingPresets.filter(p => exportSelectedIds.includes(p.id))
    if (selected.length === 0) return
    const raw = exportNameDraft.trim() || (selected.length === 1 ? selected[0]!.name : 'tscopier-presets')
    const safe = raw
      .replace(/\.tscp$/i, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80)
      || 'tscopier-presets'
    try {
      downloadTradingPresetsFile(selected, `${safe}${TSCOPIER_PRESETS_EXTENSION}`)
      setShowExportPresetsModal(false)
      setExportNameDraft('')
      setExportSelectedIds([])
      setPresetStatusMessage(cm.presetsExported)
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.presetsImportFailed)
    }
  }

  const importTradingPresetsFromPicker = async (file: File | null) => {
    if (!user?.id || !file) return
    setPresetSaving(true)
    setError('')
    try {
      const raw = await file.text()
      const { imported, presets: saved } = await importTradingPresetsFromFile(user.id, raw)
      setTradingPresets(prev => {
        const byName = new Map(prev.map(p => [p.name.toLowerCase(), p]))
        for (const row of saved) byName.set(row.name.toLowerCase(), row)
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
      })
      setShowManagePresetsModal(true)
      setPresetStatusMessage(interpolate(cm.presetsImported, { count: String(imported) }))
    } catch (err) {
      setError(err instanceof Error ? err.message : cm.presetsImportFailed)
    } finally {
      setPresetSaving(false)
      if (presetImportInputRef.current) presetImportInputRef.current.value = ''
    }
  }

  const setManual = (patch: Partial<ManualSettings>) => {
    const nextPatch = patch.range_layering_type === 'pending_order'
      ? { ...patch, range_layering_type: 'auto' as const }
      : patch
    patchSelectedChannel(current => ({
      ...current,
      manualSettings: {
        ...current.manualSettings,
        ...nextPatch,
        layering_mode: 'legacy',
        layering_optimization_strategy: 'adjust_percent',
      },
    }))
  }

  const validateLayeringCapabilitiesForSave = (_draft: AccountConfigDraft, channelIds: string[]): string | null => {
    if (channelIds.length === 0) return null
    // Broker pending orders are Coming Soon — always validate virtual/auto.
    if (!layeringMechanismIsSelectable(layeringCapabilities, 'legacy', 'auto')) {
      return 'Virtual execution is not enabled for this layering mode on this account.'
    }
    return null
  }

  const updateTpLotRow = (idx: number, patch: Partial<ManualTpLot>) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      rows[idx] = { ...rows[idx], ...patch }
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: rows } }
    })
  }

  const setTpDistributionPercent = (idx: number, raw: string) => {
    const num = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(num)) return
    patchSelectedChannel(current => ({
      ...current,
      manualSettings: {
        ...current.manualSettings,
        tp_lots: applyTpPercentEdit(current.manualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS, idx, num),
      },
    }))
  }

  const setTpRowEnabled = (idx: number, enabled: boolean) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (!enabled) {
        const othersEnabled = rows.filter((r, i) => i !== idx && r.enabled)
        if (othersEnabled.length === 0) return current
        rows[idx] = { ...rows[idx]!, enabled: false, percent: 0 }
      } else {
        rows[idx] = { ...rows[idx]!, enabled: true }
      }
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const addTpLotRow = () => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (limits.maxTpRows != null && rows.length >= limits.maxTpRows) return current
      rows.push({ label: `TP${rows.length + 1}`, lot: 0.01, percent: 0, enabled: true })
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const removeTpLotRow = (idx: number) => {
    patchSelectedChannel(current => {
      const rows = cloneTpLots(current.manualSettings.tp_lots, DEFAULT_MANUAL_TP_LOTS)
      if (rows.length <= 1) return current
      rows.splice(idx, 1)
      return { ...current, manualSettings: { ...current.manualSettings, tp_lots: sanitizeTpLots(rows) } }
    })
  }

  const setPredefinedTpPipAt = (idx: number, raw: string) => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      if (idx < 0 || idx >= list.length) return current
      if (raw === '') {
        list[idx] = 0
      } else {
        const n = Number(raw)
        if (!Number.isFinite(n)) return current
        list[idx] = n
      }
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const addPredefinedTpPipRow = () => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      const last = list[list.length - 1] ?? 0
      const next = Number.isFinite(last) && last > 0 ? last + 20 : 20
      list.push(next)
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const removePredefinedTpPipRow = (idx: number) => {
    patchSelectedChannel(current => {
      const list = clonePredefinedTpPips(current.manualSettings.predefined_tp_pips)
      if (list.length <= 1) return current
      list.splice(idx, 1)
      return { ...current, manualSettings: { ...current.manualSettings, predefined_tp_pips: list } }
    })
  }

  const persistConfigureDraft = async (committedDraft: AccountConfigDraft): Promise<boolean> => {
    if (!configAccount || !user) return false
    setError('')
    const channelIds = filterChannelIdsToActiveOptions(committedDraft.channelIds, channelOptions)
    const previouslyLinkedChannelIds = normalizeSignalChannelIds(configAccount)
    const restrictChannels = channelIds.length > 0

    if (committedDraft.channelIds.length > 0 && channelIds.length === 0) {
      setError(
        channelOptions.length === 0 || channelsLoading
          ? bl.channelsSaveChannelListNotReady
          : bl.channelsSaveLinkedChannelsInvalid,
      )
      return false
    }

    if (channelIds.length === 0) {
      const proceed = window.confirm(bl.channelsEmptySaveWarning)
      if (!proceed) return false
    }

    for (const id of channelIds) {
      const ms = committedDraft.channelConfigs[id]?.manualSettings
      if (!channelManualSettingsComplete(ms)) {
        setError(cm.channelConfigSaveIncomplete)
        return false
      }
    }

    if (hasBlockedMultiTradeSplit(channelIds, committedDraft.channelConfigs, configAccountTotalBalance)) {
      setError(cm.risk.multiTradeSplitSaveBlocked)
      return false
    }

    const layeringCapabilityError = validateLayeringCapabilitiesForSave(committedDraft, channelIds)
    if (layeringCapabilityError) {
      setError(layeringCapabilityError)
      return false
    }

    await refreshSubscription()
    const savePlanCtx = await resolveLatestManualSettingsPlanContext({
      userId: user.id,
      isAdmin,
      fallback: manualSettingsPlanCtx,
    })
    const requestedMulti = hasRequestedMultiTradeStyle(channelIds, committedDraft.channelConfigs)
    if (shouldBlockMultiTradeSave({ requestedMulti, effectivePlan: savePlanCtx.effectivePlan })) {
      setError(`${cm.risk.basicPlanTradeStyleLimit} Subscription upgrade may still be syncing. Please wait a few seconds and save again.`)
      return false
    }

    setConfigSaving(true)
    const channelMessageFilters: ChannelMessageFiltersMap = {}
    for (const id of channelIds) {
      channelMessageFilters[id] = canUsePlanFeature('channel_keyword_filters')
        ? committedDraft.channelConfigs[id]?.channelFilters ?? { ...DEFAULT_CHANNEL_FILTERS }
        : { ...BASIC_PLAN_CHANNEL_FILTERS }
    }
    const channelTradingConfigs = buildChannelTradingConfigsFromDraft(
      channelIds,
      Object.fromEntries(
        channelIds.map(id => [
          id,
          {
            mode: committedDraft.channelConfigs[id]?.mode ?? 'manual',
            manualSettings: normalizeManualSettings(
              normalizeManualSettingsForPlan(
                savePlanCtx.plan,
                savePlanCtx.status,
                (committedDraft.channelConfigs[id]?.manualSettings ?? DEFAULT_MANUAL_SETTINGS) as Record<string, unknown>,
              ) as ManualSettings,
              { accountBalance: configAccountTotalBalance },
            ),
          },
        ]),
      ),
    )
    const existingConfigs = normalizeChannelTradingConfigsMap(configAccount.channel_trading_configs)
    for (const id of channelIds) {
      const key = normalizeChannelUuid(id)
      if (!key) continue
      if (!channelTradingConfigs[key] && resolveChannelConfigEntry(existingConfigs, id)) {
        channelTradingConfigs[key] = resolveChannelConfigEntry(existingConfigs, id)!
      }
    }
    const configsToPersist = restrictChannelTradingConfigsMap(channelTradingConfigs, channelIds)
    for (const channelId of channelIds) {
      const settings = configsToPersist[normalizeChannelUuid(channelId) ?? '']?.manual_settings
      if (!settings) continue
      const { error: layeringSaveError } = await updateLayeringSettings({
        broker_account_id: configAccount.id,
        channel_id: channelId,
        layering_mode: 'legacy',
        range_layering_type: 'auto',
        static_layer_count: Number(settings.static_layer_count ?? DEFAULT_MANUAL_SETTINGS.static_layer_count ?? 5),
        dynamic_step_pips: Number(settings.dynamic_step_pips ?? DEFAULT_MANUAL_SETTINGS.dynamic_step_pips ?? 3),
        dynamic_max_layers: Number(settings.dynamic_max_layers ?? DEFAULT_MANUAL_SETTINGS.dynamic_max_layers ?? 5),
        layering_optimization_strategy: 'adjust_percent',
      })
      if (layeringSaveError) {
        setConfigSaving(false)
        setError(layeringSaveError)
        return false
      }
    }
    const selectedId = committedDraft.selectedChannelId && channelIds.includes(committedDraft.selectedChannelId)
      ? committedDraft.selectedChannelId
      : null
    const fallbackManualChannelId = selectedId ?? channelIds[0] ?? null
    const fallbackManualConfig = fallbackManualChannelId
      ? committedDraft.channelConfigs[fallbackManualChannelId]
      : null
    const normalizedFallbackManual = fallbackManualConfig
      ? normalizeManualSettings(
          normalizeManualSettingsForPlan(
            savePlanCtx.plan,
            savePlanCtx.status,
            {
              ...fallbackManualConfig.manualSettings,
              allow_high_impact_news: fallbackManualConfig.manualSettings.news_trading_enabled === true,
            } as Record<string, unknown>,
          ) as ManualSettings,
          { accountBalance: configAccountTotalBalance },
        )
      : normalizeManualSettings(configAccount.manual_settings ?? {}, { accountBalance: configAccountTotalBalance })
    if (!channelIds.length && normalizedFallbackManual) {
      const { error: layeringSaveError } = await updateLayeringSettings({
        broker_account_id: configAccount.id,
        layering_mode: 'legacy',
        range_layering_type: 'auto',
        static_layer_count: Number(normalizedFallbackManual.static_layer_count ?? DEFAULT_MANUAL_SETTINGS.static_layer_count ?? 5),
        dynamic_step_pips: Number(normalizedFallbackManual.dynamic_step_pips ?? DEFAULT_MANUAL_SETTINGS.dynamic_step_pips ?? 3),
        dynamic_max_layers: Number(normalizedFallbackManual.dynamic_max_layers ?? DEFAULT_MANUAL_SETTINGS.dynamic_max_layers ?? 5),
        layering_optimization_strategy: 'adjust_percent',
      })
      if (layeringSaveError) {
        setConfigSaving(false)
        setError(layeringSaveError)
        return false
      }
    }
    const { error: tableErr } = await upsertBrokerChannelTradingConfigs(
      supabase,
      user.id,
      configAccount.id,
      configsToPersist,
    )
    if (tableErr) {
      setConfigSaving(false)
      setError(tableErr)
      return false
    }
    const { error: pruneErr } = await deleteBrokerChannelTradingConfigsExcept(
      supabase,
      configAccount.id,
      channelIds,
    )
    if (pruneErr) {
      setConfigSaving(false)
      setError(pruneErr)
      return false
    }
    const { data, error: upErr } = await supabase
      .from('broker_accounts')
      .update({
        copier_mode: AI_CONFIGURATION_ENABLED && fallbackManualConfig?.mode === 'ai' ? 'ai' : 'manual',
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: restrictChannels,
        channel_trading_configs: configsToPersist,
        manual_settings: normalizedFallbackManual,
        channel_message_filters: channelMessageFilters,
      })
      .eq('id', configAccount.id)
      .eq('user_id', user.id)
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .single()
    setConfigSaving(false)

    if (upErr) {
      setError(upErr.message)
      return false
    }

    for (const channelId of channelIds.filter(id => !previouslyLinkedChannelIds.includes(id))) {
      startBackgroundAiTraining(channelId)
    }

    let persistedDraft = committedDraft
    if (data) {
      const fresh = mergeBrokerWithChannelTradingConfigRows(
        data as unknown as BrokerAccount,
        (await fetchBrokerChannelTradingConfigRows(supabase, configAccount.id)).rows,
      )
      replaceBroker(fresh)
      setConfigAccount(fresh)
      const persistedChannelIds = filterChannelIdsToActiveOptions(
        normalizeSignalChannelIds(fresh),
        channelOptions,
      )
      const rebuilt = buildChannelConfigDraftFromBroker(fresh, persistedChannelIds, keywordFiltersEnabled)
      const selectedChannelId = choosePersistedSelectedChannelId({
        preferredSelectedId: committedDraft.selectedChannelId,
        persistedChannelIds,
        fallbackSelectedId: rebuilt.selectedChannelId ?? channelOptions[0]?.id ?? null,
      })
      setConfigDraft({
        ...rebuilt,
        selectedChannelId,
      })
      persistedDraft = {
        ...rebuilt,
        selectedChannelId,
      }
    }
    setConfigSavedSignature(
      accountConfigDraftPersistSignature(
        persistedDraft,
        savePlanCtx.plan,
        savePlanCtx.status,
        keywordFiltersEnabled,
      ),
    )
    setConfigSavedAt(Date.now())
    return true
  }

  const saveConfigureModal = async () => {
    if (!configAccount || !user) return
    const { hasInvalid } = riskDraftManualPatch(riskNumberDrafts, multiTradeMinLegPercent)
    if (hasInvalid || Object.keys(riskNumberDrafts).some(key => {
      const raw = riskNumberDrafts[key as RiskNumberDraftKey]
      if (raw === undefined) return false
      return parseDraftNumber(raw, riskNumberRules(key as RiskNumberDraftKey, multiTradeMinLegPercent)) == null
    })) {
      setError(cm.risk.fieldErrors.fixBeforeSave)
      return
    }
    const committedDraft = applyPendingConfigureDraftFields(
      configDraft,
      riskNumberDrafts,
      symbolsExcludeDraft,
      multiTradeMinLegPercent,
    )
    if (committedDraft !== configDraft) {
      setConfigDraft(committedDraft)
    }
    if (Object.keys(riskNumberDrafts).length > 0) {
      setRiskNumberDrafts({})
    }
    if (symbolsExcludeDraft !== null) {
      setSymbolsExcludeDraft(null)
    }
    await persistConfigureDraft(committedDraft)
  }

  // ── Channel summary helper for cards ───────────────────────────────────

  const getBrokerSignalChannelsLabel = (brokerId: string) => {
    if (channelOptions.length === 0) return bl.channelsNoneSelected
    const brokerRow = brokers.find(b => b.id === brokerId)
    const persistedIds = normalizeSignalChannelIds(brokerRow)
    if (persistedIds.length === 0) return bl.channelsNoneSelected
    const selected = channelOptions.filter(ch => persistedIds.includes(ch.id))
    if (selected.length === 0) return bl.channelsNoneSelected
    if (selected.length === channelOptions.length && channelOptions.length > 1) {
      return bl.channelsAll
    }
    const labels = selected.map(ch => ch.display_name).filter(Boolean)
    if (labels.length) return labels.join(', ')
    return bl.channelsNoneSelected
  }

  // ── Delete broker ──────────────────────────────────────────────────────

  const confirmDeleteBroker = async () => {
    if (!brokerPendingDelete || !user) return
    setDeleteInProgress(true)
    setError('')
    const id = brokerPendingDelete.id
    const removed = brokerPendingDelete

    removeBroker(id)
    setBrokerPendingDelete(null)
    if (configAccount?.id === id) closeConfigureModal({ force: true })

    try {
      await fxsocketBroker.delete(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : bl.deleteFailed

      const { error: directDelErr } = await supabase
        .from('broker_accounts')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)

      if (!directDelErr) {
        void fxsocketBroker.delete(id).catch(() => {})
        return
      }

      const { data: stillThere } = await supabase
        .from('broker_accounts')
        .select('id')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (stillThere) {
        setBrokers(prev => {
          if (prev.some(b => b.id === id)) return prev
          return sortBrokerAccountsNewestFirst([...prev, removed])
        })
        setError(/unauthorized/i.test(msg) ? bl.deleteSessionExpired : msg)
      }
    } finally {
      setDeleteInProgress(false)
    }
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    setTogglingBrokerId(id)
    const { error: upErr } = await toggleBrokerActiveInStore(id, is_active)
    setTogglingBrokerId(null)
    if (upErr) setError(upErr)
  }

  // ── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <PageShell maxWidth="lg" spacing="none" className="space-y-3">
        {[...Array(2)].map((_, i) => <div key={i} className="h-28 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-100 dark:border-neutral-800 animate-pulse" />)}
      </PageShell>
    )
  }

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.pages.accountConfiguration.title}
        subtitle={t.pages.accountConfiguration.description}
        actions={(
          <Button size="sm" onClick={openAddTradingAccount}>
            <Plus className="w-3.5 h-3.5" />
            {t.accountConfig.connectForm.addAccountButton}
          </Button>
        )}
      />

      {brokersLoadError ? (
        <Alert variant="error" className="mb-3">
          {brokersLoadError}
        </Alert>
      ) : null}

      {/* ── Broker Accounts ── */}
      <section>

        {brokersNeedingRelink.length > 0 && (
          <Alert variant="warning" className="mb-3">
            {brokersNeedingRelink.length === 1
              ? bl.relinkOne
              : interpolate(bl.relinkMany, { count: String(brokersNeedingRelink.length) })}
          </Alert>
        )}

        {false && brokersNeedingReconnect.length > 0 && (
          <Alert variant="warning" className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <span>{reconnectBannerText}</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0"
              loading={reconnectingBrokerIds.size > 0}
              onClick={async () => {
                for (const b of brokersNeedingReconnect) {
                  await reconnectBroker(b.id)
                }
              }}
            >
              <RefreshCw className="w-4 h-4" />
              {bl.reconnectAll}
            </Button>
          </Alert>
        )}

        <p className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-300 flex flex-wrap items-center gap-x-1.5">
          <span>{bl.connectedAccountsHeading}</span>
          <span className="text-neutral-400 font-normal" aria-hidden>
            –
          </span>
          <span className="tabular-nums inline-flex items-center gap-0.5 font-semibold">
            {connectedAccountCount}
            <span className="text-neutral-400 font-normal">/</span>
            {isAdmin ? (
              <InfinityIcon
                className="w-4 h-4 text-teal-600 dark:text-teal-400"
                aria-label={bl.connectedAccountsUnlimited}
              />
            ) : (
              connectedAccountLimit
            )}
          </span>
        </p>

        {brokers.length === 0 ? (
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-8 text-center">
            <Server className="w-8 h-8 mx-auto mb-2 text-neutral-300 dark:text-neutral-600" />
            <p className="text-sm text-neutral-400 dark:text-neutral-500">{t.accountConfig.brokersEmptyTitle}</p>
            <p className="text-xs text-neutral-300 dark:text-neutral-600 mt-0.5">{t.accountConfig.brokersEmptySubtitle}</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {bl.accountSearchLabel}
                  </label>
                  <div className="relative mt-1.5">
                    <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                    <input
                      type="search"
                      value={brokerSearchQuery}
                      onChange={e => setBrokerSearchQuery(e.target.value)}
                      placeholder={bl.accountSearchPlaceholder}
                      className="w-full rounded-lg border border-neutral-200 bg-white py-2 ps-9 pe-3 text-sm text-neutral-900 placeholder:text-neutral-400 hover:border-neutral-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50"
                    />
                  </div>
                </div>
                <div className="w-full sm:w-64">
                  <Select
                    label={bl.brokerFilterLabel}
                    value={brokerFilter}
                    onChange={e => setBrokerFilter(e.target.value)}
                    options={[
                      { value: 'all', label: bl.brokerFilterAll },
                      ...brokerFilterOptions.map(label => ({ value: label, label })),
                    ]}
                  />
                </div>
              </div>
            </div>

            {filteredBrokers.length === 0 ? (
              <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-8 text-center">
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {brokerSearchQuery.trim() ? bl.accountSearchNoMatch : bl.brokerFilterNoMatch}
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {paginatedBrokers.map(broker => {
              const statusVariant = brokerConnectionBadgeVariant(broker)
              const isReconnecting = isBrokerReconnecting(broker.id)
              const statusLabel = brokerConnectionStatusLabel(broker, bl)
              const healthVariant = brokerTerminalHealthBadgeVariant(broker)
              const healthLabel = brokerTerminalHealthLabel(broker, bl)
              const brokerLabel = broker.broker_name
                || inferBrokerLabelFromServer(broker.broker_server ?? null)
                || broker.broker_server
                || ''
              const channelsLabel = getBrokerSignalChannelsLabel(broker.id)
              const accountType = resolveLinkedAccountTypeForBroker(broker)
              return (
                <Card
                  key={broker.id}
                  padding="none"
                  role="button"
                  tabIndex={0}
                  aria-label={`${bl.configure} ${broker.label}`}
                  onClick={() => { void openConfigureModal(broker) }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void openConfigureModal(broker)
                    }
                  }}
                  className={clsx(
                    'group overflow-hidden cursor-pointer transition-all duration-150',
                    'hover:border-primary-300 hover:shadow-md dark:hover:border-primary-700',
                    'hover:bg-primary-50/40 dark:hover:bg-primary-950/25',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
                    'dark:focus-visible:ring-offset-neutral-950',
                  )}
                >
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-50 transition-colors group-hover:bg-primary-100 dark:bg-teal-950/60 dark:group-hover:bg-teal-950">
                      <PlatformIcon platform={broker.platform} />
                    </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{broker.label}</h3>
                        <Badge variant={statusVariant} size="sm">{statusLabel}</Badge>
                        {healthVariant && healthLabel ? (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              setStatusModalBroker(broker)
                            }}
                            className="inline-flex rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                            aria-label={bl.statusHealthView}
                          >
                            <Badge variant={healthVariant} size="sm">{healthLabel}</Badge>
                          </button>
                        ) : null}
                        <Badge variant="neutral" size="sm">{broker.platform}</Badge>
                        {brokerLabel && (
                          <Badge variant="neutral" size="sm">{brokerLabel}</Badge>
                        )}
                        <ChevronRight
                          className="h-4 w-4 shrink-0 text-primary-500 opacity-0 transition-opacity group-hover:opacity-100 dark:text-primary-400"
                          aria-hidden
                        />
                      </div>
                        {broker.broker_server && (
                          <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{broker.broker_server}</p>
                        )}
                        {broker.connection_error && brokerCanReconnect(broker) ? (
                          <p className="mt-1 text-xs text-error-600 dark:text-error-400 leading-relaxed">
                            {brokerConnectErrorText(
                              classifyBrokerConnectError(broker.connection_error),
                              broker.connection_error,
                              connectErrorLabels,
                            )}
                          </p>
                        ) : null}
                    </div>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-2"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2 pe-1 border-e border-neutral-200 dark:border-neutral-700 me-1">
                        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 hidden sm:inline">
                          {bl.copyTrades}
                        </span>
                        <Toggle
                          checked={broker.is_active}
                          onChange={is_active => { void toggleBrokerActive(broker.id, is_active) }}
                          disabled={togglingBrokerId === broker.id}
                        />
                      </div>
                      {brokerCanReconnect(broker) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          loading={isReconnecting}
                          onClick={() => void reconnectBroker(broker.id)}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          {bl.reconnect}
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => { void openConfigureModal(broker) }}
                        className={clsx(
                          'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                          'border-primary-200 bg-primary-50 text-primary-800',
                          'group-hover:border-primary-300 group-hover:bg-primary-100',
                          'dark:border-primary-800 dark:bg-primary-950/50 dark:text-primary-200',
                          'dark:group-hover:border-primary-700 dark:group-hover:bg-primary-950/80',
                        )}
                      >
                        {bl.configure}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setError(''); setBrokerPendingDelete(broker) }}
                        className="rounded-lg p-1.5 text-neutral-400 dark:text-neutral-500 hover:bg-error-50 dark:hover:bg-error-950/40 hover:text-error-600 dark:hover:text-error-400 transition-colors"
                        aria-label={interpolate(bl.removeAria, { label: broker.label })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 transition-colors group-hover:bg-primary-50/50 dark:bg-neutral-800/60 dark:group-hover:bg-primary-950/20 lg:grid-cols-6">
                    <AccountDetailCell label={bl.detailLogin} value={broker.account_login || '—'} />
                    <AccountDetailCell
                      label={bl.detailAccountType}
                      value={
                        <span className={linkedAccountTypeValueClass(accountType)}>
                          {formatLinkedAccountTypeLabel(accountType, accountTypeLabelsFromBrokerList(bl))}
                        </span>
                      }
                      className="border-s border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailServer}
                      value={broker.broker_server || '—'}
                      className="border-s border-neutral-100 dark:border-neutral-800 max-lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailSignalChannels}
                      value={channelsLabel}
                      className="col-span-2 border-t border-neutral-100 dark:border-neutral-800 lg:col-span-1 lg:border-t-0 lg:border-s"
                    />
                    <AccountDetailCell
                      label={bl.detailBalance}
                      value={formatBrokerMoney(resolveBrokerTotalBalance(broker), broker.last_currency)}
                      className="border-t border-s border-neutral-100 dark:border-neutral-800 lg:border-t-0"
                    />
                    <AccountDetailCell
                      label={bl.detailEquity}
                      value={formatBrokerMoney(broker.last_equity, broker.last_currency)}
                      className="border-t border-neutral-100 dark:border-neutral-800 lg:border-s lg:border-t-0"
                    />
                  </div>
                </Card>
              )
            })}
          </div>

                {filteredBrokers.length > 0 && (
                  <AccountBrokerPagination
                    page={safeBrokerPage}
                    totalPages={brokerTotalPages}
                    rangeStart={brokerRangeStart}
                    rangeEnd={brokerRangeEnd}
                    total={filteredBrokers.length}
                    onPageChange={setBrokerPage}
                    previousLabel={t.common.previous}
                    nextLabel={t.common.next}
                    showingRange={interpolate(t.common.showingRange, {
                      start: String(brokerRangeStart),
                      end: String(brokerRangeEnd),
                      total: String(filteredBrokers.length),
                    })}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>

      <RiskLotCalculatorModal
        open={riskCalcOpen && configAccount != null}
        onClose={() => setRiskCalcOpen(false)}
        onApply={patch => {
          setManual(patch)
          setRiskNumberDrafts({})
        }}
        manualSettings={channelManualSettings}
        initialBalance={configAccountTotalBalance}
        currency={configAccount?.last_currency}
        pipQuote={livePipQuote}
        symbol={resolvedSingleSymbol}
        copy={cm.risk.lotCalculator}
        fieldErrors={cm.risk.fieldErrors}
        cancelLabel={cm.cancel}
      />

      <BrokerStatusModal
        open={statusModalBroker != null}
        broker={statusModalBroker}
        copy={t.accountConfig.statusModal}
        onClose={() => setStatusModalBroker(null)}
        onAccountUpdate={upsertBroker}
      />

      {brokerPendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-neutral-950/55" aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-broker-title"
            className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-xl border border-neutral-200 dark:border-neutral-800"
          >
            <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
              <h3 id="delete-broker-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                {bl.deleteTitle}
              </h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                {interpolate(bl.deleteBody, { label: brokerPendingDelete.label })}
              </p>
            </div>
            {error && <PaywallErrorAlert message={error} className="mx-5 mt-3" />}
            <div className="px-5 py-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={deleteInProgress}
                onClick={() => { if (!deleteInProgress) { setBrokerPendingDelete(null); setError('') } }}
              >
                {t.common.cancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={deleteInProgress}
                onClick={() => void confirmDeleteBroker()}
              >
                {bl.deleteConfirm}
              </Button>
            </div>
          </div>
        </div>
      )}

      {configAccount && createPortal(
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 pb-[env(safe-area-inset-bottom)]">
          <div className="fixed inset-0 bg-neutral-950/55" aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="configure-trading-title"
            className="relative z-[1] w-full max-w-5xl h-[100dvh] sm:h-[88vh] max-h-[100dvh] sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-2xl bg-white dark:bg-neutral-900 shadow-xl border-0 sm:border border-neutral-200 dark:border-neutral-800 overflow-hidden"
          >
            <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-start justify-between gap-3 shrink-0">
              <div className="min-w-0 flex-1">
                <h3 id="configure-trading-title" className="text-base sm:text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
                  {cm.title}
                </h3>
                <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="font-medium text-neutral-700 dark:text-neutral-300">
                    {configAccount.label}
                  </span>
                  <span className="text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                  <span>
                    {bl.detailLogin}: {configAccount.account_login || '—'}
                  </span>
                  <span className="text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                  <span>
                    {bl.detailAccountType}:{' '}
                    <span className={linkedAccountTypeValueClass(configureAccountType)}>
                      {formatLinkedAccountTypeLabel(configureAccountType, accountTypeLabelsFromBrokerList(bl))}
                    </span>
                  </span>
                  <span className="text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                  <span>
                    {bl.detailBalance}: {formatBrokerMoney(resolveBrokerTotalBalance(configAccount), configAccount.last_currency)}
                  </span>
                  {selectedChannelOption ? (
                    <>
                      <span className="text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                      <span className="truncate">{selectedChannelOption.display_name}</span>
                    </>
                  ) : null}
                </p>
              </div>
              <button
                type="button"
                onClick={() => closeConfigureModal()}
                className="shrink-0 min-h-[44px] px-3 py-2 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {cm.close}
              </button>
            </div>

            <div className="flex flex-col sm:flex-row flex-1 min-h-0 min-w-0">
              {/* Channel sidebar */}
              <nav className="shrink-0 flex sm:flex-col w-full sm:w-56 border-b sm:border-b-0 sm:border-e border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-2 sm:p-3 gap-2 sm:gap-1 overflow-x-auto sm:overflow-y-auto overscroll-x-contain">
                <div className="flex items-center justify-between gap-2 px-2 shrink-0 sm:w-full">
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    {cm.channelsSidebar}
                  </p>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        closeConfigureModal()
                        navigate('/channels')
                      }}
                      className="shrink-0 rounded-md p-1.5 transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:text-neutral-300 dark:hover:bg-neutral-800"
                      aria-label={cm.addChannel}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    {channelOptions.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setChannelLinkEditMode(v => !v)}
                        className={clsx(
                          'shrink-0 rounded-md p-1.5 transition-colors min-h-[32px] min-w-[32px] flex items-center justify-center',
                          channelLinkEditMode
                            ? 'bg-primary-100 text-primary-700 dark:bg-teal-950/60 dark:text-teal-300'
                            : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        aria-label={channelLinkEditMode ? cm.doneEditingLinkedChannels : cm.editLinkedChannels}
                        aria-pressed={channelLinkEditMode}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>
                {channelOptions.length === 0 ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1">
                    {cm.channels.noneConnected}{' '}
                    <Link to="/channels" className="text-primary-600 underline">{cm.channels.connectLink}</Link>
                  </p>
                ) : (
                  <>
                    {channelOptions.map(channel => {
                      const linked = configDraft.channelIds.includes(channel.id)
                      const selected = configDraft.selectedChannelId === channel.id
                  return (
                        <div key={channel.id} className="flex items-center gap-1 shrink-0 sm:w-full">
                          {channelLinkEditMode ? (
                            <label className="flex items-center gap-2 px-2 py-1 shrink-0">
                              <input
                                type="checkbox"
                                checked={linked}
                                onChange={() => toggleDraftChannel(channel.id)}
                              />
                            </label>
                          ) : null}
                    <button
                            type="button"
                            onClick={() => selectConfigureChannel(channel.id)}
                      className={clsx(
                              'flex-1 min-w-0 flex items-center gap-2 text-start px-2 py-2 rounded-lg text-sm transition-colors min-h-[44px] sm:min-h-0',
                              selected
                                ? 'bg-white dark:bg-neutral-900 text-primary-700 shadow-sm border border-primary-100 dark:border-primary-900/50'
                                : linked
                                  ? 'text-neutral-700 dark:text-neutral-300 hover:bg-white dark:hover:bg-neutral-900 border border-transparent'
                                  : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:hover:bg-neutral-900 border border-dashed border-neutral-200 dark:border-neutral-700',
                            )}
                          >
                            <Radio className={clsx('w-4 h-4 shrink-0', selected ? 'text-primary-600' : linked ? 'text-neutral-400' : 'text-neutral-300')} />
                            <span className="truncate flex-1">{channel.display_name}</span>
                            {!channelLinkEditMode ? (
                              <Badge variant={linked ? 'primary' : 'neutral'}>
                                {linked ? cm.channelLinkedBadge : cm.channelNotLinkedBadge}
                              </Badge>
                            ) : null}
                    </button>
                          {linked && !channelLinkEditMode ? (
                            <button
                              type="button"
                              onClick={() => toggleDraftChannel(channel.id)}
                              className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                              aria-label={interpolate(cm.removeLinkedChannel, { channel: channel.display_name })}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          ) : null}
                        </div>
                      )
                    })}
                    {channelLinkEditMode ? (
                      <p className="hidden sm:block px-2 pt-2 text-xs text-neutral-500 dark:text-neutral-400">
                        {interpolate(cm.channels.selected, { count: String(configDraft.channelIds.length) })}
                      </p>
                    ) : null}
                  </>
                )}
              </nav>

              {/* Config body column */}
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {selectedChannelLinked ? (
                  <div className="shrink-0 px-4 sm:px-6 pt-3 sm:pt-4 bg-white dark:bg-neutral-900 border-b border-neutral-100 dark:border-neutral-800 overflow-x-auto overscroll-x-contain">
                    <div className="flex flex-nowrap items-center gap-1 min-w-max sm:min-w-0 sm:flex-wrap pb-px">
                      {manualSubTabs.map(sub => {
                        const SubIcon = sub.icon
                        const active = sub.id === activeManualSubTab
                        return (
                          <button
                            key={sub.id}
                            ref={el => setTabButtonRef(sub.id, el)}
                            type="button"
                            onClick={() => scrollToConfigSection(sub.id)}
                            className={clsx(
                                'shrink-0 flex items-center gap-1.5 px-3 py-2.5 sm:py-2 text-sm transition-colors border-b-2 -mb-px min-h-[44px] sm:min-h-0 whitespace-nowrap',
                              active
                                  ? 'border-primary-600 text-primary-700 dark:text-primary-400'
                                  : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100',
                            )}
                          >
                              <SubIcon className={clsx('w-3.5 h-3.5 shrink-0', active ? 'text-primary-600' : 'text-neutral-400')} />
                            {sub.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : null}

                <div
                  ref={configScrollRef}
                  className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-4 sm:py-5 min-h-0 overscroll-y-contain"
                >
                {error && <PaywallErrorAlert message={error} className="mb-4" />}

                {selectedChannelLinked && (selectedChannelNeedsPersistedSave || configureModalDirty) ? (
                  <Alert variant="warning" className="mb-4">
                    {selectedChannelNeedsPersistedSave
                      ? cm.channelConfigNotSaved
                      : cm.channelConfigUnsavedChanges}
                  </Alert>
                ) : null}
                {selectedChannelLinked && (activeChannelTrainingRunning || activeChannelTrainingSaving) ? (
                  <div className="mb-4 rounded-lg border border-primary-200 dark:border-primary-900 bg-primary-50 dark:bg-primary-950/30 p-3">
                    <p className="text-xs font-medium text-primary-800 dark:text-primary-200">
                      {interpolate(cm.aiTraining.autoTrainingInProgress, {
                        progress: String(activeChannelTrainingProgress),
                      })}
                    </p>
                    <div className="mt-2 h-2 rounded-full bg-primary-100 dark:bg-primary-900 overflow-hidden">
                      <div
                        className="h-full bg-primary-600 transition-[width] duration-500 ease-out"
                        style={{ width: `${activeChannelTrainingProgress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {!configDraft.selectedChannelId ? (
                  <div className="py-12 text-center">
                    <Radio className="w-10 h-10 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.selectChannelPrompt}</p>
                  </div>
                ) : !selectedChannelLinked ? (
                  <div className="py-12 text-center max-w-md mx-auto px-2">
                    <Link2 className="w-10 h-10 mx-auto mb-3 text-primary-400 dark:text-primary-500" />
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 inline-flex items-center justify-center gap-1.5 flex-wrap">
                      {interpolate(cm.connectChannelPrompt, {
                        channel: selectedChannelOption?.display_name ?? cm.channelFilters.unnamedChannel,
                        broker: configAccount ? getBrokerDisplayLabel(configAccount) : '—',
                      })}
                      <InfoTooltip text={cm.connectChannelHint} />
                    </p>
                    <Button
                      className="mt-6 min-h-[44px]"
                      loading={channelConnecting}
                      disabled={configSaving || presetSaving}
                      onClick={() => void connectSelectedChannelToBroker()}
                    >
                      {interpolate(cm.connectChannelButton, {
                        channel: selectedChannelOption?.display_name ?? cm.channelFilters.unnamedChannel,
                        broker: configAccount ? getBrokerDisplayLabel(configAccount) : '—',
                      })}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {/* <div>
                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-2">Configure mode</p>
                      <div className="inline-flex rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-1">
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'ai' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${channelMode === 'ai' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          AI Expert Mode
                        </button>
                        <button
                          onClick={() => setConfigDraft(prev => ({ ...prev, mode: 'manual' }))}
                          className={`px-4 py-2 text-sm rounded-md transition-colors ${channelMode === 'manual' ? 'bg-primary-600 text-white' : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'}`}
                        >
                          Manual
                        </button>
                      </div>
                    </div> */}

                    {AI_CONFIGURATION_ENABLED && channelMode === 'ai' ? (
                      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                        <ConfigTitle variant="semibold" info={cm.ai.intro}>{cm.ai.title}</ConfigTitle>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <FeatureBullet icon={DollarSign} title={cm.ai.moneyManagementTitle} body={cm.ai.moneyManagementBody} />
                          <FeatureBullet icon={Eye} title={cm.ai.signalTitle} body={cm.ai.signalBody} />
                          <FeatureBullet icon={Activity} title={cm.ai.tradeTitle} body={cm.ai.tradeBody} />
                          <FeatureBullet icon={GitBranch} title={cm.ai.modificationTitle} body={cm.ai.modificationBody} />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-8">
                        <section
                          id="config-section-signal_examples"
                          data-config-section="signal_examples"
                          ref={el => setSectionRef('signal_examples', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.aiTraining}
                          </h3>
                          
                          {
                          selectedChannelOption && configDraft.selectedChannelId && userId ? (
                            <ChannelSignalExamplesSection
                              channelId={configDraft.selectedChannelId}
                              userId={userId}
                              labels={cm.aiTraining}
                              trainingActive={activeChannelTrainingRunning || activeChannelTrainingSaving}
                              onRetrain={() => startBackgroundAiTraining(configDraft.selectedChannelId!, { force: true })}
                            />
                          ) : (
                            <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.channels.selectChannelFirst}</p>
                          )
                        }
                        </section>

                        <section
                          id="config-section-symbols"
                          data-config-section="symbols"
                          ref={el => setSectionRef('symbols', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.symbols}
                          </h3>
                          
                          {
                          selectedChannelOption && configDraft.selectedChannelId ? (
                            <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-4">
                              <ConfigTitle variant="semibold" info={cm.channelSymbols.intro}>
                                {cm.channelSymbols.title}
                              </ConfigTitle>
                              <ConfigureInput
                                label={cm.channelSymbols.tradeOnlyLabel}
                                hint={cm.channelSymbols.tradeOnlyHint}
                                placeholder={cm.channelSymbols.tradeOnlyPlaceholder}
                                value={symbolWhitelistToInput(channelManualSettings.symbol_to_trade)}
                                onChange={e => {
                                  const raw = e.target.value
                                  setManual({ symbol_to_trade: raw.trim() === '' ? null : raw })
                                }}
                                onBlur={e => setManual({
                                  symbol_to_trade: symbolWhitelistFromInput(e.target.value),
                                })}
                              />
                              <ConfigureInput
                                label={cm.channelSymbols.avoidLabel}
                                hint={cm.channelSymbols.avoidHint}
                                placeholder={cm.channelSymbols.avoidPlaceholder}
                                value={
                                  symbolsExcludeDraft
                                  ?? symbolsExcludeToInput(channelManualSettings.symbols_exclude)
                                }
                                onChange={e => setSymbolsExcludeDraft(e.target.value)}
                                onBlur={() => {
                                  if (symbolsExcludeDraft === null) return
                                  setManual({ symbols_exclude: symbolsExcludeFromInput(symbolsExcludeDraft) })
                                  setSymbolsExcludeDraft(null)
                                }}
                              />
                            </section>
                          ) : (
                            <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.channels.selectChannelFirst}</p>
                          )
                        }
                        </section>

                        <section
                          id="config-section-channel_instructions"
                          data-config-section="channel_instructions"
                          ref={el => setSectionRef('channel_instructions', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.channelInstructions}
                          </h3>
                          
                          {
                          selectedChannelOption && configDraft.selectedChannelId ? (
                            <div className="relative">
                              <section
                                className={clsx(
                                  'space-y-3',
                                  !keywordFiltersEnabled && 'pointer-events-none select-none opacity-60',
                                )}
                                aria-disabled={!keywordFiltersEnabled}
                              >
                                <div className="flex items-center justify-between">
                                  <ConfigTitle variant="semibold" info={`${cm.channels.filtersIntro}\n\n${cm.channelFilters.footer}`}>{cm.channels.keywordFilters}</ConfigTitle>
                                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                    {(() => {
                                      const f = normalizeChannelFilters(
                                        configDraft.channelConfigs[configDraft.selectedChannelId]?.channelFilters
                                          ?? defaultChannelFiltersForPlan(keywordFiltersEnabled),
                                      )
                                      const total = channelFilterCategories.reduce(
                                        (n, c) => n + (f[c.key] === 'ignore' ? 1 : 0), 0,
                                      )
                                      return total === 0
                                        ? cm.channels.allAllowed
                                        : interpolate(cm.channels.ignoredAcross, { total: String(total) })
                                    })()}
                                  </p>
                                </div>
                                
                                <ChannelFiltersCard
                                  filters={normalizeChannelFilters(
                                    configDraft.channelConfigs[configDraft.selectedChannelId]?.channelFilters
                                      ?? defaultChannelFiltersForPlan(keywordFiltersEnabled),
                                  )}
                                  categories={channelFilterCategories}
                                  labels={cm.channelFilters}
                                  disabled={!keywordFiltersEnabled}
                                  onChange={(key, value) => setChannelFilter(configDraft.selectedChannelId!, key, value)}
                                  onReset={() => resetChannelFilters(configDraft.selectedChannelId!)}
                                />
                                {showMinLotPartialCloseWarning ? (
                                  <Alert variant="warning">{cm.risk.minLotPartialCloseWarning}</Alert>
                                ) : null}
                              </section>
                              {!keywordFiltersEnabled ? (
                                <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
                                  <div className="pointer-events-auto w-full max-w-md">
                                    <UpgradePrompt reason={pw.advancedFeature} />
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <p className="text-sm text-neutral-500 dark:text-neutral-400">{cm.channels.selectChannelFirst}</p>
                          )
                        }
                        </section>

                        <section
                          id="config-section-risk"
                          data-config-section="risk"
                          ref={el => setSectionRef('risk', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.risk}
                          </h3>
                          <div className="space-y-4">
                            {channelManualSettings.risk_mode === 'fixed_lot' && (
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  className="text-sm text-teal-600 hover:text-teal-700 hover:underline dark:text-teal-400 dark:hover:text-teal-300"
                                  onClick={() => setRiskCalcOpen(true)}
                                >
                                  {cm.risk.openLotCalculator}
                                </button>
                              </div>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <ConfigureSelect
                                label={cm.risk.tradeStyle}
                                hint={cm.risk.tradeStyleHint}
                                value={channelManualSettings.trade_style ?? 'single'}
                                disabled={!multiTradeStyleEnabled}
                                onChange={e => {
                                  const v = e.target.value as ManualSettings['trade_style']
                                  if (v === 'multi' && !multiTradeStyleEnabled) {
                                    setError(cm.risk.basicPlanTradeStyleLimit)
                                    return
                                  }
                                  if (v === 'multi') {
                                    setManual({ trade_style: v, use_signal_entry_price: false })
                                  } else {
                                    setManual({ trade_style: v })
                                  }
                                }}
                                options={multiTradeStyleEnabled
                                  ? [
                                      { value: 'single', label: cm.risk.singleTrade },
                                      { value: 'multi', label: cm.risk.multiTrades },
                                    ]
                                  : [
                                      { value: 'single', label: cm.risk.singleTrade },
                                    ]}
                              />
                              <ConfigureSelect
                                label={cm.risk.riskMode}
                                value={channelManualSettings.risk_mode ?? 'fixed_lot'}
                                onChange={e => setManual({ risk_mode: e.target.value as ManualSettings['risk_mode'] })}
                                options={[
                                  { value: 'fixed_lot', label: cm.risk.fixedLot },
                                  { value: 'dynamic_balance_percent', label: cm.risk.dynamicBalance },
                                ]}
                              />
                              {channelManualSettings.risk_mode === 'dynamic_balance_percent' ? (
                                <>
                                  <ConfigureInput
                                    label={cm.risk.dynamicBalance}
                                    {...riskNumberFieldProps(
                                      'dynamic_balance_percent',
                                      channelManualSettings.dynamic_balance_percent,
                                      1,
                                    )}
                                  />
                                  <div>
                                    <ConfigTitle className="mb-1" info={dynamicBalanceLotPreview?.hint}>
                                      {cm.risk.dynamicBalanceLotSize}
                                    </ConfigTitle>
                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-50">
                                      {dynamicBalanceLotPreview?.lotLabel ?? '—'}
                                    </div>
                                    {dynamicBalanceLotPreview?.hint ? (
                                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                                        {dynamicBalanceLotPreview.hint}
                                      </p>
                                    ) : null}
                                  </div>
                                </>
                              ) : (
                                <ConfigureInput
                                  label={cm.risk.fixedLot}
                                  {...riskNumberFieldProps(
                                    'fixed_lot',
                                    channelManualSettings.fixed_lot,
                                    DEFAULT_MANUAL_SETTINGS.fixed_lot ?? 0.01,
                                  )}
                                />
                              )}
                            </div>

                            {showMinLotPartialCloseWarning ? (
                              <Alert variant="warning">{cm.risk.minLotPartialCloseWarning}</Alert>
                            ) : null}

                            {channelManualSettings.trade_style !== 'multi' && (
                              <div className="space-y-4">
                              <ConfigureSelect
                                label={cm.risk.singleTpTarget}
                                hint={cm.risk.singleTpTargetHint}
                                value={channelManualSettings.single_tp_target ?? 'farthest'}
                                onChange={e => {
                                  const v = e.target.value as ManualSettings['single_tp_target']
                                  setManual({ single_tp_target: v })
                                }}
                                options={[
                                  { value: 'farthest', label: cm.risk.singleTpTargetFarthest },
                                  ...(channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS)
                                    .map((row, i) => ({ row, origIdx: i }))
                                    .filter(({ row }) => row.enabled !== false)
                                    .map(({ row, origIdx }) => ({
                                      value: `tp${origIdx + 1}` as const,
                                      label: row.label?.trim() || `TP${origIdx + 1}`,
                                    })),
                                ]}
                              />
                              {singleTpLotBreakdownText ? (
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/60 px-3 py-2.5 space-y-1">
                                  <p className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                                    {cm.risk.singleTpLotBreakdownTitle}
                                  </p>
                                  <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                                    {singleTpLotBreakdownText}
                                  </p>
                                </div>
                              ) : null}
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <ConfigTitle info={cm.risk.signalEntryBody}>{cm.risk.signalEntryTitle}</ConfigTitle>
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <ConfigToggleLabel>{cm.risk.useSignalEntryPrice}</ConfigToggleLabel>
                                    <Toggle
                                      checked={channelManualSettings.use_signal_entry_price === true}
                                      onChange={v => setManual({ use_signal_entry_price: v })}
                                    />
                                  </div>
                                  {channelManualSettings.use_signal_entry_price && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-2">
                                      <ConfigureInput
                                        label={cm.risk.pipToleranceLegacy}
                                        hint={cm.risk.pipToleranceHint}
                                        {...riskNumberFieldProps(
                                          'signal_entry_pip_tolerance',
                                          channelManualSettings.signal_entry_pip_tolerance,
                                          10,
                                        )}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                              </div>
                            )}

                            {channelManualSettings.trade_style === 'multi' && (
                              <div className="relative">
                                <div
                                  className={clsx(
                                    'space-y-4',
                                    !multiTradeStyleEnabled && 'pointer-events-none select-none opacity-60',
                                  )}
                                  aria-disabled={!multiTradeStyleEnabled}
                                >
                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <ConfigTitle info={cm.risk.multiIntro}>{cm.risk.multiTrades}</ConfigTitle>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <ConfigureInput
                                    label={cm.risk.perLegSize}
                                    {...riskNumberFieldProps(
                                      'multi_trade_leg_percent',
                                      channelManualSettings.multi_trade_leg_percent,
                                      5,
                                    )}
                                  />
                                  <div>
                                    <ConfigTitle className="mb-1" info={multiTradePreviewTooltip}>{cm.risk.totalOpenTrades}</ConfigTitle>
                                    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-50">
                                      {multiTradeTotalOpenTradesLabel}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                  <ConfigToggleLabel info={cm.risk.useSignalRangeBody}>{cm.risk.useSignalRange}</ConfigToggleLabel>
                                  <Toggle
                                    checked={channelManualSettings.use_signal_entry_range === true}
                                    onChange={v => setManual({ use_signal_entry_range: v })}
                                  />
                                </div>
                                {channelManualSettings.use_signal_entry_range && (
                                  <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-2">
                                    <ConfigureInput
                                      label={cm.risk.useSignalRangePipTolerance}
                                      hint={cm.risk.useSignalRangePipToleranceHint}
                                      {...riskNumberFieldProps(
                                        'signal_entry_pip_tolerance',
                                        channelManualSettings.signal_entry_pip_tolerance,
                                        10,
                                      )}
                                    />
                                  </div>
                                )}
                              </div>

                              <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <ConfigToggleLabel info={cm.risk.rangeIntro}>{cm.risk.rangeLayering}</ConfigToggleLabel>
                                  <Toggle
                                    checked={channelManualSettings.range_trading === true}
                                    onChange={v => setManual({ range_trading: v })}
                                  />
                                </div>
                                {channelManualSettings.range_trading && (
                                  <>
                                    <div className="flex flex-col gap-1.5 max-w-md">
                                      <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Layering Mode</label>
                                      <select
                                        className="w-full px-3 py-2 text-base md:text-sm rounded-lg border bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-neutral-100"
                                        value={selectedLayeringMechanism === 'pending_order' ? 'auto' : selectedLayeringMechanism}
                                        onChange={e => {
                                          const next = e.target.value === 'pending_order' ? 'pending_order' : 'auto'
                                          // Broker pending orders are Coming Soon — keep option visible but not selectable.
                                          if (next === 'pending_order') return
                                          if (!layeringMechanismIsSelectable(layeringCapabilities, selectedLayeringMode, next)) {
                                            setError('Virtual execution is not enabled for this account and layering mode.')
                                            return
                                          }
                                          setError('')
                                          setManual({ range_layering_type: next })
                                        }}
                                      >
                                        <option value="auto" disabled={!selectedModeAutoSelectable}>Automatic / virtual execution</option>
                                        <option value="pending_order" disabled>
                                          Broker pending orders — {t.accountConfig.addAccount.comingSoonBadge}
                                        </option>
                                      </select>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <ConfigureInput
                                        label={cm.risk.reservedLot}
                                        placeholder="50"
                                        hint={cm.risk.reservedLotHint}
                                        {...riskNumberFieldProps(
                                          'range_percent',
                                          channelManualSettings.range_percent,
                                          50,
                                        )}
                                      />
                                      <ConfigureSelect
                                        label={cm.risk.stepPips}
                                        hint={cm.risk.stepPipsFallback}
                                        value={Number(channelManualSettings.range_step_pips) > 0 ? 'manual' : 'auto'}
                                        onChange={e => {
                                          const next = e.target.value === 'manual' ? 'manual' : 'auto'
                                          setRiskNumberDrafts(prev => {
                                            if (!Object.prototype.hasOwnProperty.call(prev, 'range_step_pips')) return prev
                                            const cleared = { ...prev }
                                            delete cleared.range_step_pips
                                            return cleared
                                          })
                                          if (next === 'auto') {
                                            setManual({ range_step_pips: 0 })
                                            return
                                          }
                                          const current = Number(channelManualSettings.range_step_pips)
                                          setManual({ range_step_pips: current > 0 ? current : 3 })
                                        }}
                                        options={[
                                          { value: 'auto', label: cm.risk.stepModeAuto },
                                          { value: 'manual', label: cm.risk.stepModeManual },
                                        ]}
                                      />
                                      {Number(channelManualSettings.range_step_pips) > 0 && (
                                        <ConfigureInput
                                          label={cm.risk.stepManualPips}
                                          placeholder="3"
                                          hint={
                                            formatPipHint(Number(channelManualSettings.range_step_pips))
                                            ?? cm.risk.stepManualPipsFallback
                                          }
                                          {...riskNumberFieldProps(
                                            'range_step_pips',
                                            channelManualSettings.range_step_pips,
                                            3,
                                          )}
                                        />
                                      )}
                                      <ConfigureInput
                                        label={cm.risk.rangeDistance}
                                        placeholder="100"
                                        disabled={channelManualSettings.use_signal_entry_range === true}
                                        hint={rangeDistanceFieldHint}
                                        {...riskNumberFieldProps(
                                          'range_distance_pips',
                                          channelManualSettings.range_distance_pips,
                                          DEFAULT_MANUAL_SETTINGS.range_distance_pips ?? 30,
                                        )}
                                      />
                                    </div>

                                    <div className="flex items-center justify-between">
                                      <ConfigToggleLabel info={cm.risk.layerTillCloseBody}>{cm.risk.layerTillClose}</ConfigToggleLabel>
                                      <Toggle
                                        checked={channelManualSettings.range_layer_till_close === true}
                                        onChange={v => setManual({ range_layer_till_close: v })}
                                      />
                                    </div>
                                  </>
                                )}
                              </div>
                                </div>
                                {!multiTradeStyleEnabled ? (
                                  <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
                                    <div className="pointer-events-auto w-full max-w-md">
                                      <UpgradePrompt reason={cm.risk.basicPlanTradeStyleLimit} />
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            )}

                          </div>
                        </section>

                        <section
                          id="config-section-stops"
                          data-config-section="stops"
                          ref={el => setSectionRef('stops', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.stops}
                          </h3>

                          {
                          (() => {
                          const ms = channelManualSettings
                          const predefSummary = describePredefinedStopsOverrideI18n(ms, cm.stops)
                          return (
                          <div className="space-y-6">
                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <ConfigTitle info={`${cm.stops.tpDistributionIntro}\n\n${cm.stops.multiTradeNote}\n\n${cm.stops.singleTradeNote}`}>{cm.stops.tpDistributionTitle}</ConfigTitle>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={addTpLotRow}
                                  disabled={
                                    limits.maxTpRows != null
                                    && (channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).length >= limits.maxTpRows
                                  }
                                >
                                  {cm.stops.addTp}
                                </Button>
                              </div>
                              {limits.maxTpRows != null
                                && (channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).length >= limits.maxTpRows ? (
                                  <UpgradePrompt variant="compact" reason={cm.stops.basicPlanMoreTpsLimit} />
                              ) : null}
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-neutral-600 dark:text-neutral-400">
                                  {cm.stops.enabledTotal}{' '}
                                  <strong className={clsx('font-semibold', tpLegPercentTotal === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                                    {tpLegPercentTotal}%
                                  </strong>{' '}
                                  / 100%
                                </span>
                                {tpLegPercentTotal !== 100 && (
                                  <span className="text-amber-600">
                                    {tpLegPercentTotal < 100
                                      ? interpolate(cm.stops.unallocated, { pct: String(100 - tpLegPercentTotal) })
                                      : cm.stops.overCap}
                                  </span>
                                )}
                              </div>
                              <div className="space-y-2">
                                {(channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS).map((row, idx) => {
                                  const tpRows = channelManualSettings.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
                                  const othersSum = tpRows.reduce(
                                    (s, r, i) => (i !== idx && r.enabled ? s + (Number(r.percent) || 0) : s),
                                    0,
                                  )
                                  const rowBudget = Math.max(0, 100 - othersSum)
                                  return (
                                    <div key={`${row.label}-${idx}`} className="grid grid-cols-12 gap-2 items-center">
                                      <input
                                        className="col-span-4 rounded-md border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-sm"
                                        value={row.label}
                                        onChange={e => updateTpLotRow(idx, { label: e.target.value })}
                                      />
                                      <input
                                        className="col-span-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-sm disabled:bg-neutral-100 dark:bg-neutral-800 disabled:text-neutral-400"
                                        type="number"
                                        min={0}
                                        max={rowBudget}
                                        step={1}
                                        disabled={!row.enabled}
                                        title={row.enabled ? interpolate(cm.stops.maxRowTitle, { budget: String(rowBudget) }) : cm.stops.enableRowTitle}
                                        value={String(row.percent ?? 0)}
                                        onChange={e => setTpDistributionPercent(idx, e.target.value)}
                                      />
                                      <span className="col-span-1 text-xs text-neutral-500 dark:text-neutral-400 text-center">%</span>
                                      <label className="col-span-2 text-xs text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          checked={row.enabled}
                                          onChange={e => setTpRowEnabled(idx, e.target.checked)}
                                        />
                                        {cm.stops.enabled}
                                      </label>
                                      <Button className="col-span-2" variant="ghost" size="sm" onClick={() => removeTpLotRow(idx)}>{cm.stops.remove}</Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </section>

                            <CopyLimitsTargetsSection
                              copyLimits={ms.copy_limits}
                              copyLimitState={
                                configDraft.selectedChannelId
                                  ? channelCopyLimitState[configDraft.selectedChannelId]
                                  : undefined
                              }
                              profileTimezone={profile.timezone || 'UTC'}
                              labels={cm.stops}
                              onChange={next => setManual({ copy_limits: next })}
                            />

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <ConfigTitle info={cm.stops.predefinedIntro}>{cm.stops.predefinedTitle}</ConfigTitle>
                              {predefSummary ? (
                                <div className="rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2.5 text-sm text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200">
                                  {predefSummary}
                            </div>
                              ) : null}
                              <div className="space-y-3">
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <ConfigToggleLabel>{cm.stops.overrideSl}</ConfigToggleLabel>
                                    <Toggle checked={ms.use_predefined_sl_pips === true} onChange={v => setManual({ use_predefined_sl_pips: v })} />
                                  </div>
                                  {ms.use_predefined_sl_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3">
                                      <ConfigureInput
                                        label={cm.stops.slPips}
                                        type="number"
                                        min={1}
                                        step={1}
                                        hint={cm.stops.slPipsHint}
                                        value={String(ms.predefined_sl_pips ?? 30)}
                                        onChange={e => setManual({ predefined_sl_pips: Math.max(1, Number(e.target.value) || 0) })}
                                      />
                          </div>
                        )}
                            </div>
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <ConfigToggleLabel info={cm.stops.tpRowsIntro}>{cm.stops.overrideTps}</ConfigToggleLabel>
                                    <Toggle
                                      checked={ms.use_predefined_tp_pips === true}
                                      onChange={v => {
                                        if (!v) { setManual({ use_predefined_tp_pips: false }); return }
                                        patchSelectedChannel(current => {
                                          let list = current.manualSettings.predefined_tp_pips
                                          if (!Array.isArray(list) || list.length === 0) {
                                            list = [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          } else {
                                            const filtered = list.map(n => Number(n)).filter(Number.isFinite)
                                            list = filtered.length > 0 ? filtered : [...(DEFAULT_MANUAL_SETTINGS.predefined_tp_pips ?? [20, 40, 60])]
                                          }
                                          return {
                                            ...current,
                                            manualSettings: {
                                              ...current.manualSettings,
                                              use_predefined_tp_pips: true,
                                              predefined_tp_pips: list,
                                            },
                                          }
                                        })
                                      }}
                                    />
                                  </div>
                                  {ms.use_predefined_tp_pips && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-3">
                                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                                        <Button variant="ghost" size="sm" className="shrink-0 self-start sm:self-auto" onClick={addPredefinedTpPipRow}>{cm.stops.addTp}</Button>
                                      </div>
                                      <div className="space-y-2">
                                        {clonePredefinedTpPips(ms.predefined_tp_pips).map((pips, idx) => (
                                          <div key={`predef-tp-${idx}`} className="grid grid-cols-12 gap-2 items-end">
                                            <div className="col-span-10">
                                              <ConfigureInput
                                                label={interpolate(cm.stops.tpPipsLabel, { index: String(idx + 1) })}
                                                type="number"
                                                min={1}
                                                step={1}
                                                hint={formatPipHint(Number(pips) || 0) ?? undefined}
                                                value={String(pips)}
                                                onChange={e => setPredefinedTpPipAt(idx, e.target.value)}
                                              />
                                            </div>
                                            <Button className="col-span-2" variant="ghost" size="sm" onClick={() => removePredefinedTpPipRow(idx)}>{cm.stops.remove}</Button>
                                          </div>
                                  ))}
                                </div>
                              </div>
                              )}
                            </div>
                          </div>
                            </section>

                          </div>
                          )
                        })()
                        }
                        </section>

                        <section
                          id="config-section-management"
                          data-config-section="management"
                          ref={el => setSectionRef('management', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.management}
                          </h3>

                          {
                          (() => {
                          const ms = channelManualSettings
                          const autoMgmtEnabled = isAutoManagementEnabled(ms)
                          const triggerMode = ms.move_sl_to_entry_after_mode ?? 'pips'
                          const beType = ms.move_sl_to_entry_type ?? 'sl_only'
                          const autoRuleSummary = describeAutoManagementRuleI18n(ms, cm.management)
                          const isSingleTrade = (ms.trade_style ?? 'single') !== 'multi'
                          const triggerModes = cm.management.triggerModes
                          const TRIGGER_MODES = [
                            { id: 'pips' as const, label: triggerModes.pips, hint: triggerModes.pipsHint },
                            { id: 'rr' as const, label: triggerModes.rr, hint: triggerModes.rrHint },
                            { id: 'money' as const, label: triggerModes.money, hint: triggerModes.moneyHint },
                            { id: 'tp_hit' as const, label: triggerModes.tpHit, hint: triggerModes.tpHitHint },
                          ]
                          const tpRows = ms.tp_lots ?? DEFAULT_MANUAL_TP_LOTS
                          const tpSelectOptions = tpRows
                            .map((row, i) => ({
                              value: String(i + 1),
                              label: row.label?.trim() || `TP${i + 1}`,
                            }))
                            .filter((_, i) => tpRows[i]?.enabled !== false)
                          const tpOptions = tpSelectOptions.length > 0
                            ? tpSelectOptions
                            : [{ value: '1', label: 'TP1' }, { value: '2', label: 'TP2' }, { value: '3', label: 'TP3' }]

                          return (
                          <div className="space-y-6">
                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                              <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-4 py-3">
                                <ConfigTitle
                                  info={
                                    !isSingleTrade
                                      ? `${cm.management.monitorIntroMulti}\n\n${cm.management.moveSlSubtitle}`
                                      : cm.management.moveSlSubtitle
                                  }
                                >
                                  {cm.management.moveSlTitle}
                                </ConfigTitle>
                                <Toggle
                                  checked={autoMgmtEnabled}
                                  onChange={v => {
                                    if (v) {
                                      const prev = ms.move_sl_to_entry_after_mode
                                      setManual({
                                        move_sl_to_entry_after_mode:
                                          prev && prev !== 'none' ? prev : 'pips',
                                      })
                                    } else {
                                      setManual({ move_sl_to_entry_after_mode: 'none' })
                                    }
                                  }}
                                />
                              </div>

                              {autoMgmtEnabled && (
                                <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-4 py-4 space-y-4">
                                  {autoRuleSummary ? (
                                    <div className="rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2.5 text-sm text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200">
                                      {autoRuleSummary}
                            </div>
                                  ) : null}

                                  <div className="space-y-3">
                                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.management.triggerTitle}</p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                      {TRIGGER_MODES.map((m) => (
                                        <button
                                          key={m.id}
                                          type="button"
                                          onClick={() => setManual({ move_sl_to_entry_after_mode: m.id })}
                                          className={clsx(
                                            'rounded-lg border px-2.5 py-2 text-start text-sm transition-colors',
                                            triggerMode === m.id
                                              ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                              : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300',
                                          )}
                                        >
                                          <span className="font-medium inline-flex items-center gap-1">
                                            {m.label}
                                            <InfoTooltip text={m.hint} />
                                          </span>
                                        </button>
                                      ))}
                                </div>

                                    {triggerMode === 'pips' && (
                                    <ConfigureInput
                                        label={cm.management.triggerPips}
                                      type="number"
                                      min={0}
                                      step={1}
                                        hint={cm.management.triggerPipsHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'rr' && (
                                      <ConfigureInput
                                        label={cm.management.triggerRrLabel}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        hint={cm.management.triggerRrHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 1)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'money' && (
                                      <ConfigureInput
                                        label={cm.management.triggerMoney}
                                        type="number"
                                        min={0}
                                        step={0.01}
                                        hint={cm.management.triggerMoneyHint}
                                        value={String(ms.move_sl_to_entry_after_value ?? 10)}
                                        onChange={e => setManual({
                                          move_sl_to_entry_after_value: Math.max(0, Number(e.target.value) || 0),
                                        })}
                                      />
                                    )}

                                    {triggerMode === 'tp_hit' && (
                                        <ConfigureSelect
                                          label={cm.management.takeProfit}
                                          hint={cm.management.tpHitHint}
                                          value={String(ms.move_sl_to_entry_tp_index ?? 1)}
                                          onChange={e => setManual({
                                            move_sl_to_entry_tp_index: Math.max(1, Number(e.target.value) || 1),
                                          })}
                                          options={tpOptions}
                                        />
                                    )}

                                    <ConfigureInput
                                      label={cm.management.breakevenOffset}
                                      type="number"
                                      min={0}
                                      step={1}
                                      hint={cm.management.breakevenOffsetHint}
                                      value={String(ms.breakeven_offset_pips ?? 3)}
                                      onChange={e => setManual({
                                        breakeven_offset_pips: Math.max(0, Number(e.target.value) || 0),
                                      })}
                                    />
                                </div>

                                  <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
                                    <div className="px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
                                      <ConfigTitle info={cm.management.breakevenTypeSubtitle}>{cm.management.breakevenTypeTitle}</ConfigTitle>
                                    </div>
                                    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setManual({ move_sl_to_entry_type: 'sl_only' })}
                                        className={clsx(
                                          'rounded-lg border px-3 py-2.5 text-start text-sm transition-colors',
                                          beType === 'sl_only'
                                            ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                            : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600',
                                        )}
                                      >
                                        <span className="font-medium inline-flex items-center gap-1">
                                          {cm.management.moveOnly}
                                          <InfoTooltip text={cm.management.moveOnlyHint} />
                                        </span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setManual({ move_sl_to_entry_type: 'sl_and_close_half' })}
                                        className={clsx(
                                          'rounded-lg border px-3 py-2.5 text-start text-sm transition-colors',
                                          beType === 'sl_and_close_half'
                                            ? 'border-primary-500 bg-primary-50 dark:bg-teal-950/50 text-primary-900 dark:text-teal-300'
                                            : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600',
                                        )}
                                      >
                                        <span className="font-medium inline-flex items-center gap-1">
                                          {cm.management.moveAndPartial}
                                          <InfoTooltip text={cm.management.moveAndPartialHint} />
                                        </span>
                                      </button>
                                    </div>
                                    {beType === 'sl_and_close_half' && (
                                      <ConfigureInput
                                        label={cm.management.partialClose}
                                        type="number"
                                        min={1}
                                        max={99}
                                        step={1}
                                        hint={cm.management.partialCloseHint}
                                        value={String(ms.half_close_percent ?? 50)}
                                        onChange={e =>
                                          setManual({
                                            half_close_percent: Math.min(99, Math.max(1, Number(e.target.value) || 50)),
                                          })
                                        }
                                      />
                                    )}
                                  </div>
                                </div>
                              )}
                            </section>

                            {isSingleTrade && (
                              <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-4 py-3">
                                  <ConfigTitle info={cm.management.trailingSubtitle}>{cm.management.trailingTitle}</ConfigTitle>
                                  <Toggle
                                    checked={ms.trailing_enabled === true}
                                    onChange={v => setManual({ trailing_enabled: v })}
                                  />
                                </div>
                                {ms.trailing_enabled && (
                                  <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-4 py-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                              <ConfigureInput
                                        label={cm.management.trailStart}
                                                type="number"
                                                min={0}
                                                step={1}
                                        hint={cm.management.trailStartHint}
                                        value={String(ms.trailing_start_pips ?? 20)}
                                        onChange={e => setManual({ trailing_start_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                      <ConfigureInput
                                        label={cm.management.trailStep}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.trailStepHint}
                                        value={String(ms.trailing_step_pips ?? 5)}
                                        onChange={e => setManual({ trailing_step_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                      <ConfigureInput
                                        label={cm.management.trailDistance}
                                        type="number"
                                        min={0}
                                        step={1}
                                        hint={cm.management.trailDistanceHint}
                                        value={String(ms.trailing_distance_pips ?? 10)}
                                        onChange={e => setManual({ trailing_distance_pips: Math.max(0, Number(e.target.value) || 0) })}
                                      />
                                      </div>
                                    </div>
                                  )}
                              </section>
                            )}

                            {!isSingleTrade && (
                              <p className="text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
                                {cm.management.trailingSingleOnly}
                              </p>
                            )}

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <ConfigTitle>{cm.strategy.signalBehavior}</ConfigTitle>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <ConfigureSelect
                                  label={cm.strategy.reverseSignal}
                                  hint={cm.strategy.reverseHint}
                                  value={ms.reverse_signal ? 'yes' : 'no'}
                                  onChange={e => {
                                    setManual({ reverse_signal: e.target.value === 'yes' })
                                  }}
                                  options={[{ value: 'no', label: cm.common.no }, { value: 'yes', label: cm.common.yes }]}
                                />
                                <ConfigureSelect
                                  label={cm.strategy.addToExisting}
                                  hint={cm.strategy.addExistingHint}
                                  value={ms.add_new_trades_to_existing ? 'yes' : 'no'}
                                  onChange={e => setManual({ add_new_trades_to_existing: e.target.value === 'yes' })}
                                  options={[{ value: 'yes', label: cm.common.yes }, { value: 'no', label: cm.common.no }]}
                                />
                                <ConfigureSelect
                                  label={cm.strategy.closeOpposite}
                                  hint={cm.strategy.closeOppositeHint}
                                  value={ms.close_on_opposite_signal ? 'yes' : 'no'}
                                  onChange={e => setManual({ close_on_opposite_signal: e.target.value === 'yes' })}
                                  options={[{ value: 'no', label: cm.common.no }, { value: 'yes', label: cm.common.yes }]}
                                />
                              </div>
                                </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <ConfigTitle info={cm.strategy.rrFallbacksIntro}>{cm.strategy.rrFallbacksTitle}</ConfigTitle>
                              <div className="space-y-3">
                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.enableRrSl}</span>
                                    <Toggle
                                      checked={ms.rr_for_sl_enabled === true}
                                      onChange={v => setManual({ rr_for_sl_enabled: v })}
                                    />
                                  </div>
                                  {ms.rr_for_sl_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <ConfigureInput
                                        label={cm.strategy.slRr}
                                        type="number"
                                        hint={cm.strategy.slRrHint}
                                        value={String(ms.rr_for_sl ?? 1)}
                                        onChange={e => setManual({ rr_for_sl: Number(e.target.value) })}
                                      />
                                    </div>
                                  )}
                                </div>

                                <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-3 py-2.5">
                                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{cm.strategy.enableRrTps}</span>
                                    <Toggle
                                      checked={ms.rr_for_tps_enabled === true}
                                      onChange={v => setManual({ rr_for_tps_enabled: v })}
                                    />
                                  </div>
                                  {ms.rr_for_tps_enabled && (
                                    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/80 px-3 py-3 space-y-1">
                                      <ConfigureInput
                                        label={cm.strategy.tpRrValues}
                                        hint={cm.strategy.tpRrHint}
                                        value={(ms.rr_for_tps ?? []).join(',')}
                                        onChange={e => setManual({ rr_for_tps: e.target.value.split(',').map(n => Number(n.trim())).filter(Number.isFinite) })}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
                              <ConfigTitle info={cm.strategy.pendingIntro}>{cm.strategy.pendingTitle}</ConfigTitle>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <ConfigureInput
                                  label={cm.strategy.pendingExpiry}
                                  type="number"
                                  min={1}
                                  max={24}
                                  step={1}
                                  hint={cm.strategy.pendingExpiryHint}
                                  value={String(ms.pending_expiry_hours ?? 1)}
                                  onChange={e => {
                                    const n = Number(e.target.value)
                                    const v = Number.isFinite(n) ? Math.max(1, Math.min(24, Math.floor(n))) : 1
                                    setManual({ pending_expiry_hours: v })
                                  }}
                                />
                              </div>
                            </div>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                              <div className="flex items-center justify-between gap-3 bg-white dark:bg-neutral-900 px-4 py-3">
                                <ConfigTitle info={cm.management.orderCommentsSubtitle}>
                                  {cm.management.orderCommentsTitle}
                                </ConfigTitle>
                                <Toggle
                                  checked={ms.order_comments_enabled !== false}
                                  onChange={v => setManual({ order_comments_enabled: v })}
                                />
                              </div>
                            </section>
                          </div>
                          )
                        })()
                        }
                        </section>

                        <section
                          id="config-section-filters"
                          data-config-section="filters"
                          ref={el => setSectionRef('filters', el)}
                          className="scroll-mt-3 space-y-4"
                        >
                          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {cm.manualSubTabs.filters}
                          </h3>
                          <div className="space-y-6">
                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <ConfigTitle info={cm.filters.timeSubtitle}>{cm.filters.timeTitle}</ConfigTitle>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <ConfigureSelect label={cm.filters.timeFilter} value={channelManualSettings.time_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ time_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: cm.filters.timeNo }, { value: 'yes', label: cm.filters.timeYes }]} />
                              {channelManualSettings.time_filter_enabled && (
                                <ConfigureInput label={cm.filters.startTime} type="time" value={channelManualSettings.trade_start_time ?? '00:00'} onChange={e => setManual({ trade_start_time: e.target.value })} />
                              )}
                              {channelManualSettings.time_filter_enabled && (
                                <ConfigureInput label={cm.filters.endTime} type="time" value={channelManualSettings.trade_end_time ?? '23:59'} onChange={e => setManual({ trade_end_time: e.target.value })} />
                              )}
                            </div>
                            </section>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <ConfigTitle info={cm.filters.daysSubtitle}>{cm.filters.daysTitle}</ConfigTitle>
                              <ConfigureSelect label={cm.filters.daysFilter} value={channelManualSettings.days_filter_enabled ? 'yes' : 'no'} onChange={e => setManual({ days_filter_enabled: e.target.value === 'yes' })} options={[{ value: 'no', label: cm.filters.daysNo }, { value: 'yes', label: cm.filters.daysYes }]} />
                            {channelManualSettings.days_filter_enabled && (
                              <div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">{cm.filters.tradingDays}</p>
                                <div className="flex flex-wrap gap-3">
                                  {([0, 1, 2, 3, 4, 5, 6] as const).map((value) => (
                                    <label key={value} className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={(channelManualSettings.trade_days ?? [1, 2, 3, 4, 5]).includes(value)}
                                        onChange={(e) => {
                                          const prev = channelManualSettings.trade_days ?? [1, 2, 3, 4, 5]
                                          const next = e.target.checked ? [...new Set([...prev, value])] : prev.filter((x) => x !== value)
                                          setManual({ trade_days: next })
                                        }}
                                      />
                                      {cm.filters.weekdays[String(value) as keyof typeof cm.filters.weekdays]}
                                    </label>
                                  ))}
                                </div>
                                {(channelManualSettings.trade_days ?? []).length === 0 ? (
                                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                                    {cm.filters.daysWarning}
                                  </p>
                                ) : null}
                              </div>
                            )}
                            </section>

                            <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
                              <ConfigTitle info={cm.filters.newsSubtitle}>{cm.filters.newsTitle}</ConfigTitle>
                                  <ConfigureSelect
                                label={cm.filters.newsTrading}
                                value={channelManualSettings.news_trading_enabled !== false ? 'yes' : 'no'}
                                onChange={e => {
                                  const enabled = e.target.value === 'yes'
                                  setManual({
                                    news_trading_enabled: enabled,
                                    allow_high_impact_news: enabled,
                                  })
                                }}
                                options={[
                                  { value: 'yes', label: cm.filters.newsYes },
                                  { value: 'no', label: cm.filters.newsNo },
                                ]}
                              />
                              {channelManualSettings.news_trading_enabled === false && (
                                <>
                                  <div>
                                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">{cm.filters.avoidImpact}</p>
                                    <div className="flex flex-wrap gap-4">
                                      {(
                                        [
                                          { id: 'high' as const, label: cm.filters.impactHigh },
                                          { id: 'medium' as const, label: cm.filters.impactMedium },
                                          { id: 'low' as const, label: cm.filters.impactLow },
                                        ] as const
                                      ).map((impact) => (
                                        <label key={impact.id} className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            checked={(channelManualSettings.news_avoid_impacts ?? ['high']).includes(impact.id)}
                                            onChange={(e) => {
                                              const prev = channelManualSettings.news_avoid_impacts ?? ['high']
                                              const next = e.target.checked
                                                ? [...new Set([...prev, impact.id])]
                                                : prev.filter((x) => x !== impact.id)
                                              setManual({ news_avoid_impacts: next })
                                            }}
                                          />
                                          {impact.label}
                                        </label>
                                      ))}
                                    </div>
                                    {(channelManualSettings.news_avoid_impacts ?? []).length === 0 ? (
                                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                                        {cm.filters.impactWarning}
                                      </p>
                                    ) : null}
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <ConfigureInput
                                      label={cm.filters.closeBeforeNews}
                                  type="number"
                                      min={0}
                                      value={String(channelManualSettings.close_before_news_minutes ?? 30)}
                                      onChange={e =>
                                        setManual({ close_before_news_minutes: Math.max(0, Number(e.target.value) || 0) })
                                      }
                                />
                                <ConfigureInput
                                      label={cm.filters.resumeAfterNews}
                                  type="number"
                                      min={0}
                                      value={String(channelManualSettings.resume_after_news_minutes ?? 15)}
                                      onChange={e =>
                                        setManual({ resume_after_news_minutes: Math.max(0, Number(e.target.value) || 0) })
                                      }
                                />
                              </div>
                                </>
                        )}
                            </section>
                      </div>
                        </section>


                  </div>
                )}

                          </div>
                )}

                                </div>
                          </div>
                    </div>

            <div className="shrink-0 px-4 sm:px-6 py-3 sm:py-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-row flex-wrap items-center justify-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4">
              <div className="flex flex-row items-center gap-1 sm:gap-3 text-center sm:text-start">
                {configSavedAt != null && (
                  <span className="text-xs text-success-600 transition-opacity">{cm.saved}</span>
                )}
                {presetStatusMessage != null && (
                  <span className="text-xs text-success-600 transition-opacity">{presetStatusMessage}</span>
                )}
                        </div>
              <Button variant="ghost" className="text-xs px-2.5 py-1.5 h-auto sm:w-auto sm:min-h-[44px] rounded-full whitespace-nowrap" onClick={() => closeConfigureModal()} disabled={configSaving || presetSaving}>{cm.cancel}</Button>
              {selectedChannelLinked && tradingPresets.length > 0 ? (
                <Button
                  variant="secondary"
                  className="text-xs px-2.5 py-1.5 h-auto sm:w-auto sm:min-h-[44px] rounded-full whitespace-nowrap"
                  disabled={configSaving || presetSaving || presetsLoading}
                  onClick={openExportPresetsModal}
                >
                  <FileUp className="w-3.5 h-3.5 me-1" />
                  {cm.exportPresets}
                </Button>
              ) : null}
              {selectedChannelLinked ? (
                <Button
                  variant="secondary"
                  className="text-xs px-2.5 py-1.5 h-auto sm:w-auto sm:min-h-[44px] rounded-full whitespace-nowrap"
                  disabled={configSaving || presetSaving || presetsLoading}
                  onClick={() => {
                    setError('')
                    setShowManagePresetsModal(true)
                  }}
                >
                  {presetsLoading ? '…' : cm.applyPreset}
                </Button>
              ) : null}
              {selectedChannelLinked && selectedChannelEditedFromDefault ? (
                <Button
                  variant="secondary"
                  className="text-xs px-2.5 py-1.5 h-auto sm:w-auto sm:min-h-[44px] rounded-full whitespace-nowrap"
                  loading={presetSaving}
                  disabled={configSaving || channelConnecting}
                  onClick={openSavePresetModal}
                >
                  <Bookmark className="w-3.5 h-3.5 me-1" />
                  {cm.saveAsPreset}
                </Button>
              ) : null}
              {selectedChannelLinked ? (
                <Button
                  className="text-xs px-2.5 py-1.5 h-auto sm:w-auto sm:min-h-[44px] rounded-full whitespace-nowrap"
                  loading={configSaving}
                  disabled={!canSaveConfigureModal || presetSaving || channelConnecting || multiTradeSplitSaveBlocked}
                  title={multiTradeSplitSaveBlocked ? cm.risk.multiTradeSplitSaveBlocked : undefined}
                  onClick={() => void saveConfigureModal()}
                >
                  {cm.save}
                </Button>
              ) : null}
            </div>

            <p className="shrink-0 text-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {cm.riskDisclaimer.warning}{' '}
              <a
                href={marketingUrl('/risk-disclaimer')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 hover:underline dark:text-teal-400"
              >
                {cm.riskDisclaimer.fullLink}
              </a>
            </p>

            {pendingApplyPreset ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="apply-preset-title"
                  aria-describedby="apply-preset-description"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl overflow-hidden"
                >
                  <div className="px-5 pt-5 pb-4">
                    <div className="flex gap-3">
                      <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/50">
                        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <h4 id="apply-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                          {cm.applyPresetTitle}
                        </h4>
                        <p id="apply-preset-description" className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                          {interpolate(cm.applyPresetConfirm, {
                            channel: selectedChannelOption?.display_name ?? '—',
                            name: pendingApplyPreset.name,
                          })}
                        </p>
                            </div>
                      </div>
                    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-neutral-500 dark:text-neutral-400">{cm.applyPresetChannelLabel}</span>
                        <span className="font-medium text-neutral-900 dark:text-neutral-50 truncate">
                          {selectedChannelOption?.display_name ?? '—'}
                        </span>
                  </div>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-neutral-500 dark:text-neutral-400">{cm.applyPresetPresetLabel}</span>
                        <span className="font-medium text-primary-700 dark:text-primary-400 truncate">
                          {pendingApplyPreset.name}
                        </span>
                </div>
              </div>
                    <p className="mt-4 text-xs text-amber-700 dark:text-amber-400 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
                      {cm.applyPresetWarning}
                    </p>
            </div>
                  <div className="px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      onClick={() => setPendingApplyPreset(null)}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      loading={configSaving}
                      disabled={configSaving || presetSaving}
                      onClick={() => void confirmApplyPreset()}
                    >
                      {cm.applyPresetAction}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {showManagePresetsModal ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="manage-presets-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl overflow-hidden"
                >
                  <div className="px-5 pt-5 pb-3">
                    <h4 id="manage-presets-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                      {cm.applyPreset}
                    </h4>
                    <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
                      {tradingPresets.length === 0 ? cm.noPresetsYet : cm.managePresetsHint}
                    </p>
                    {tradingPresets.length > 0 ? (
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {cm.managePresetsApplyHint}
                      </p>
                    ) : null}
                  </div>
                  <div className="max-h-[min(50vh,22rem)] overflow-y-auto border-y border-neutral-100 dark:border-neutral-800">
                    {presetsLoading ? (
                      <p className="px-5 py-8 text-sm text-center text-neutral-500">…</p>
                    ) : tradingPresets.length === 0 ? (
                      <p className="px-5 py-8 text-sm text-center text-neutral-500 dark:text-neutral-400">
                        {cm.noPresetsYet}
                      </p>
                    ) : (
                      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                        {tradingPresets.map(preset => (
                          <li key={preset.id} className="flex items-stretch gap-1 px-2 py-1.5">
                            <button
                              type="button"
                              className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-start text-sm font-medium text-neutral-900 dark:text-neutral-50 hover:bg-neutral-50 dark:hover:bg-neutral-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                              disabled={configSaving || presetSaving}
                              onClick={() => {
                                setShowManagePresetsModal(false)
                                setPendingApplyPreset(preset)
                              }}
                            >
                              <span className="block truncate">{preset.name}</span>
                            </button>
                            <button
                              type="button"
                              className="shrink-0 inline-flex items-center justify-center rounded-lg p-2.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
                              aria-label={cm.managePresetsEdit}
                              title={cm.managePresetsEdit}
                              disabled={configSaving || presetSaving}
                              onClick={() => openEditPresetModal(preset)}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="shrink-0 inline-flex items-center justify-center rounded-lg p-2.5 text-neutral-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                              aria-label={cm.managePresetsDelete}
                              title={cm.managePresetsDelete}
                              disabled={configSaving || presetSaving}
                              onClick={() => setPendingDeletePreset(preset)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="px-5 py-4 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
                    <input
                      ref={presetImportInputRef}
                      type="file"
                      accept=".tscp,application/json,.json"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0] ?? null
                        void importTradingPresetsFromPicker(file)
                      }}
                    />
                    <Button
                      variant="secondary"
                      className="w-full sm:w-auto"
                      disabled={configSaving || presetSaving}
                      loading={presetSaving}
                      onClick={() => presetImportInputRef.current?.click()}
                    >
                      <FileDown className="w-4 h-4 me-1.5" />
                      {cm.importPresets}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      onClick={() => setShowManagePresetsModal(false)}
                    >
                      {cm.close}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {editingPreset ? (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-preset-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 space-y-4"
                >
                  <h4 id="edit-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {cm.editPresetTitle}
                  </h4>
                  <ConfigureInput
                    label={cm.saveAsPresetNameLabel}
                    value={presetNameDraft}
                    placeholder={cm.saveAsPresetNamePlaceholder}
                    onChange={e => setPresetNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void confirmEditPreset()
                    }}
                  />
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      disabled={presetSaving}
                      onClick={() => {
                        setEditingPreset(null)
                        setPresetNameDraft('')
                      }}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      loading={presetSaving}
                      disabled={!presetNameDraft.trim()}
                      onClick={() => void confirmEditPreset()}
                    >
                      {cm.editPresetAction}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {pendingDeletePreset ? (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-preset-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl overflow-hidden"
                >
                  <div className="px-5 pt-5 pb-4">
                    <div className="flex gap-3">
                      <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/50">
                        <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <h4 id="delete-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                          {cm.deletePresetTitle}
                        </h4>
                        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                          {interpolate(cm.deletePresetConfirm, { name: pendingDeletePreset.name })}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      disabled={presetSaving}
                      onClick={() => setPendingDeletePreset(null)}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      variant="danger"
                      className="w-full sm:w-auto"
                      loading={presetSaving}
                      onClick={() => void confirmDeletePreset()}
                    >
                      {cm.deletePresetAction}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {showExportPresetsModal ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="export-presets-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl overflow-hidden"
                >
                  <div className="px-5 pt-5 pb-3 space-y-3">
                    <h4 id="export-presets-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                      {cm.exportPresetsTitle}
                    </h4>
                    <p className="text-sm text-neutral-600 dark:text-neutral-400">
                      {cm.exportPresetsSelectHint}
                    </p>
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        className="text-primary-700 hover:underline dark:text-primary-400"
                        onClick={() => setExportSelection(tradingPresets.map(p => p.id))}
                      >
                        {cm.exportPresetsSelectAll}
                      </button>
                      <span className="text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                      <button
                        type="button"
                        className="text-primary-700 hover:underline dark:text-primary-400"
                        onClick={() => setExportSelection([])}
                      >
                        {cm.exportPresetsSelectNone}
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[min(40vh,16rem)] overflow-y-auto border-y border-neutral-100 dark:border-neutral-800">
                    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {tradingPresets.map(preset => {
                        const checked = exportSelectedIds.includes(preset.id)
                        return (
                          <li key={preset.id}>
                            <label className="flex items-center gap-3 px-5 py-3 text-sm text-neutral-900 dark:text-neutral-50 hover:bg-neutral-50 dark:hover:bg-neutral-800/60 cursor-pointer">
                              <input
                                type="checkbox"
                                className="rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                                checked={checked}
                                onChange={() => toggleExportPreset(preset.id)}
                              />
                              <span className="truncate">{preset.name}</span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                  <div className="px-5 py-4 space-y-4">
                    <ConfigureInput
                      label={cm.exportPresetsNameLabel}
                      value={exportNameDraft}
                      placeholder={cm.exportPresetsNamePlaceholder}
                      onChange={e => setExportNameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') confirmExportPresets()
                      }}
                    />
                    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                      <Button
                        variant="ghost"
                        className="w-full sm:w-auto"
                        onClick={() => {
                          setShowExportPresetsModal(false)
                          setExportNameDraft('')
                          setExportSelectedIds([])
                        }}
                      >
                        {cm.cancel}
                      </Button>
                      <Button
                        className="w-full sm:w-auto"
                        disabled={exportSelectedIds.length === 0 || !exportNameDraft.trim()}
                        onClick={confirmExportPresets}
                      >
                        <FileUp className="w-4 h-4 me-1.5" />
                        {cm.exportPresetsAction}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {showPresetNameModal ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/55 p-4">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="save-preset-title"
                  className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 space-y-4"
                >
                  <h4 id="save-preset-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {cm.saveAsPresetTitle}
                  </h4>
                  <ConfigureInput
                    label={cm.saveAsPresetNameLabel}
                    value={presetNameDraft}
                    placeholder={cm.saveAsPresetNamePlaceholder}
                    onChange={e => setPresetNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void confirmSavePreset()
                    }}
                  />
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      disabled={presetSaving}
                      onClick={() => {
                        setShowPresetNameModal(false)
                        setPresetNameDraft('')
                      }}
                    >
                      {cm.cancel}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      loading={presetSaving}
                      disabled={!presetNameDraft.trim()}
                      onClick={() => void confirmSavePreset()}
                    >
                      {cm.saveAsPresetAction}
                    </Button>
            </div>
          </div>
        </div>
            ) : null}
    </div>
        </div>,
        document.body,
      )}
    </PageShell>
  )
}

// ── Tab subcomponents ────────────────────────────────────────────────────

function FeatureBullet({ icon: Icon, title, body }: { icon: typeof DollarSign; title: string; body: string }) {
  return (
    <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-800 p-3">
      <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-primary-600" />
        {title}
        <InfoTooltip text={body} />
      </p>
    </div>
  )
}

/** Allow / Ignore grid for channel instruction categories (selected channel is shown in the sidebar). */
function ChannelFiltersCard({
  filters,
  categories,
  labels,
  disabled = false,
  onChange,
  onReset,
}: {
  filters: ChannelFilters
  categories: ReturnType<typeof getChannelFilterCategories>
  labels: ConfigureModalTranslations['channelFilters']
  disabled?: boolean
  onChange: (key: ChannelFilterKey, value: ChannelFilterDecision) => void
  onReset: () => void
}) {
  const ignoredCount = categories.reduce(
    (n, c) => n + (filters[c.key] === 'ignore' ? 1 : 0),
    0,
  )
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {categories.map(cat => (
              <CategoryRow
                key={cat.key}
                label={cat.label}
                example={cat.example}
            allowLabel={labels.allow}
            ignoreLabel={labels.ignore}
                value={filters[cat.key] ?? 'allow'}
                disabled={disabled}
                onChange={v => onChange(cat.key, v)}
              />
            ))}
          </div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2">
            <button
              type="button"
          className="text-xs text-primary-600 hover:text-primary-700 hover:underline shrink-0 self-start sm:self-auto disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
              onClick={onReset}
              disabled={disabled || ignoredCount === 0}
            >
          {labels.resetDefaults}
            </button>
          </div>
    </div>
  )
}

function CategoryRow({
  label,
  example,
  allowLabel,
  ignoreLabel,
  value,
  disabled = false,
  onChange,
}: {
  label: string
  example: string
  allowLabel: string
  ignoreLabel: string
  value: ChannelFilterDecision
  disabled?: boolean
  onChange: (v: ChannelFilterDecision) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-neutral-800 dark:text-neutral-100 truncate inline-flex items-center gap-1">
          {label}
          <InfoTooltip text={example} />
        </p>
      </div>
      <div className="inline-flex items-center rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 p-0.5 shrink-0">
        <button
          type="button"
          disabled={disabled}
          className={clsx(
            'px-2.5 py-1 text-xs rounded disabled:cursor-not-allowed disabled:opacity-60',
            value === 'allow' ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300',
          )}
          onClick={() => onChange('allow')}
          aria-pressed={value === 'allow'}
        >
          {allowLabel}
        </button>
        <button
          type="button"
          disabled={disabled}
          className={clsx(
            'px-2.5 py-1 text-xs rounded disabled:cursor-not-allowed disabled:opacity-60',
            value === 'ignore' ? 'bg-amber-50 text-amber-700 shadow-sm' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:text-neutral-300',
          )}
          onClick={() => onChange('ignore')}
          aria-pressed={value === 'ignore'}
        >
          {ignoreLabel}
        </button>
      </div>
    </div>
  )
}

function AccountBrokerPagination({
  page,
  totalPages,
  onPageChange,
  previousLabel,
  nextLabel,
  showingRange,
}: {
  page: number
  totalPages: number
  rangeStart: number
  rangeEnd: number
  total: number
  onPageChange: (page: number) => void
  previousLabel: string
  nextLabel: string
  showingRange: string
}) {
  const pageNumbers = useMemo(() => {
    const maxButtons = 5
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    let start = Math.max(1, page - 2)
    let end = Math.min(totalPages, start + maxButtons - 1)
    start = Math.max(1, end - maxButtons + 1)
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }, [page, totalPages])

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 sm:px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
        {showingRange}
      </p>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-40 disabled:pointer-events-none"
            aria-label={previousLabel}
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">{previousLabel}</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <BrokerPageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-400 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <BrokerPageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-400 text-sm">…</span>
                )}
                <BrokerPageButton
                  n={totalPages}
                  active={page === totalPages}
                  onClick={() => onPageChange(totalPages)}
                />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-40 disabled:pointer-events-none"
            aria-label={nextLabel}
          >
            <span className="hidden sm:inline">{nextLabel}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

function BrokerPageButton({
  n,
  active,
  onClick,
}: {
  n: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'min-w-[2rem] px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors',
        active
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 border border-transparent hover:border-neutral-200 dark:hover:border-neutral-800',
      )}
    >
      {n}
    </button>
  )
}

