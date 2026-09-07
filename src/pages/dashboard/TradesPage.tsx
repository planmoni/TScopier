import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowUpRight, ArrowDownRight, ChevronLeft, ChevronRight, ChevronRight as ChevronRightIcon, Minus, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useHumanReview } from '../../context/HumanReviewContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useTradesData } from '../../hooks/useTradesData'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Alert } from '../../components/ui/Alert'
import { TradeDetailModal } from '../../components/trades/TradeDetailModal'
import { AwaitingApprovalSection } from '../../components/trades/AwaitingApprovalSection'
import { SignalReviewDetailModal } from '../../components/trades/SignalReviewDetailModal'
import { lossTextClass } from '../../lib/pnlDisplay'
import type { MtTrade } from '../../lib/fxsocketBroker'
import type { Signal } from '../../types/database'
import {
  formatTradeLots,
  formatTradePrice,
  getTradeDisplayMeta,
} from '../../lib/tradeDisplay'
import { supabase } from '../../lib/supabase'
import {
  emptyManualBrokerOverrideWarningMaps,
  fetchManualBrokerOverrideWarningsForTrades,
  getManualBrokerOverrideWarningForTrade,
  type ManualBrokerOverrideWarning,
  type ManualBrokerOverrideWarningMaps,
} from '../../lib/manualBrokerOverrideWarnings'
import { ManualBrokerOverrideWarningBadge } from '../../components/trades/ManualBrokerOverrideWarning'

type Filter = 'all' | 'open' | 'closed'

const PAGE_SIZE_OPTIONS = [10, 50, 100] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

export function TradesPage() {
  const t = useT()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const { pending } = useHumanReview()
  const { trades, loading, refreshing, error, lastSyncedAt, refresh } = useTradesData(user?.id)
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(10)
  const [selectedTrade, setSelectedTrade] = useState<MtTrade | null>(null)
  const [selectedReviewSignal, setSelectedReviewSignal] = useState<Signal | null>(null)
  const [manualOverrideWarningMaps, setManualOverrideWarningMaps] = useState<ManualBrokerOverrideWarningMaps>(() => emptyManualBrokerOverrideWarningMaps())
  const deepLinkConsumedRef = useState(() => ({ current: false }))[0]

  useEffect(() => {
    const reviewId = searchParams.get('review')
    if (!reviewId || deepLinkConsumedRef.current || selectedReviewSignal) return
    const match = pending.find(item => item.signal.id === reviewId)
    if (match) {
      deepLinkConsumedRef.current = true
      requestAnimationFrame(() => {
        setSelectedReviewSignal(match.signal)
        setSearchParams({}, { replace: true })
      })
    }
  })

  const filters: { value: Filter; label: string; count: number }[] = useMemo(
    () => [
      { value: 'all', label: t.trades.filterAll, count: trades.length },
      { value: 'open', label: t.trades.filterOpen, count: trades.filter(tr => tr.status === 'open').length },
      { value: 'closed', label: t.trades.filterClosed, count: trades.filter(tr => tr.status === 'closed').length },
    ],
    [t, trades],
  )

  const visibleTrades = useMemo(
    () => (filter === 'all' ? trades : trades.filter(tr => tr.status === filter)),
    [trades, filter],
  )

  const totalPages = Math.max(1, Math.ceil(visibleTrades.length / pageSize))

  useEffect(() => {
    setPage(1)
  }, [filter, pageSize])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paginatedTrades = useMemo(() => {
    const start = (page - 1) * pageSize
    return visibleTrades.slice(start, start + pageSize)
  }, [visibleTrades, page, pageSize])

  const rangeStart = visibleTrades.length === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, visibleTrades.length)

  const showInitialSkeleton = loading && trades.length === 0

  const refreshManualOverrideWarnings = async () => {
    if (!user?.id) {
      setManualOverrideWarningMaps(emptyManualBrokerOverrideWarningMaps())
      return
    }
    try {
      setManualOverrideWarningMaps(await fetchManualBrokerOverrideWarningsForTrades(supabase, user.id))
    } catch (err) {
      console.warn(`[trades] manual broker override warnings failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  useEffect(() => {
    void refreshManualOverrideWarnings()
  }, [user?.id])

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.trades.title}
        subtitle={(
          <>
            {t.trades.subtitle}
            {lastSyncedAt && (
              <span className="text-neutral-400">
                {' '}
                · {interpolate(t.common.synced, { time: formatRelative(lastSyncedAt) })}
              </span>
            )}
          </>
        )}
        actions={(
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={() => { void refresh(); void refreshManualOverrideWarnings() }}
            disabled={refreshing || showInitialSkeleton}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-md font-medium border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-50 w-full sm:w-auto"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t.trades.refresh}
          </button>
          <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto w-full sm:w-auto">
            <div className="inline-flex bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5 gap-0.5">
              {filters.map(f => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={`shrink-0 px-3 py-2 text-sm rounded-md font-medium transition-colors whitespace-nowrap ${
                    filter === f.value
                      ? 'bg-teal-600 text-white'
                      : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'
                  }`}
                >
                {f.label}
                <span className={`ml-1.5 text-xs ${filter === f.value ? 'text-teal-100' : 'text-neutral-400'}`}>{f.count}</span>
              </button>
              ))}
            </div>
          </div>
          </div>
        )}
      />

      {error && !showInitialSkeleton && <Alert className="mb-4 px-4 py-2.5">{error}</Alert>}

      <AwaitingApprovalSection onOpenSignal={setSelectedReviewSignal} />

      <Card padding="none">
        {showInitialSkeleton ? (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-4 space-y-3">
                  <div className="flex justify-between gap-3">
                    <div className="h-5 w-24 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                    <div className="h-5 w-16 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[...Array(4)].map((__, j) => (
                      <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-6 py-4 flex gap-4">
                  {[...Array(9)].map((__, j) => (
                    <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse flex-1" />
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : visibleTrades.length === 0 ? (
          <div className="px-4 sm:px-6 py-12 sm:py-16 text-center">
            <ArrowUpRight className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
            <p className="text-sm text-neutral-400 font-medium">{t.trades.emptyTitle}</p>
            <p className="text-xs text-neutral-300 mt-1">
              {filter === 'open'
                ? t.trades.emptySubtitleOpen
                : filter === 'closed'
                  ? t.trades.emptySubtitleClosed
                  : interpolate(t.trades.emptySubtitleConnect, {
                      page: t.pages.accountConfiguration.title,
                    })}
            </p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-neutral-100 dark:divide-neutral-800">
              {paginatedTrades.map(trade => (
                <TradeCard
                  key={trade.id}
                  trade={trade}
                  warning={getManualBrokerOverrideWarningForTrade(manualOverrideWarningMaps, trade)}
                  onSelect={() => setSelectedTrade(trade)}
                />
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-[52rem]">
                <thead>
                  <tr className="border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                    <th className="px-4 py-3 text-center">Symbol</th>
                    <th className="px-2 py-3 text-center">Direction</th>
                    <th className="px-2 py-3 text-center">Broker</th>
                    <th className="px-2 py-3 text-center">Entry</th>
                    <th className="px-2 py-3 text-center">SL</th>
                    <th className="px-2 py-3 text-center">TP</th>
                    <th className="px-2 py-3 text-center">Lots</th>
                    <th className="px-2 py-3 text-center">PnL</th>
                    <th className="px-2 py-3 text-center">{t.trades.colTime}</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {paginatedTrades.map(trade => (
                    <TradeRow
                      key={trade.id}
                      trade={trade}
                      warning={getManualBrokerOverrideWarningForTrade(manualOverrideWarningMaps, trade)}
                      onSelect={() => setSelectedTrade(trade)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {visibleTrades.length > 0 && (
              <TradesPagination
                page={page}
                pageSize={pageSize}
                totalPages={totalPages}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                total={visibleTrades.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            )}
          </>
        )}
      </Card>

      <TradeDetailModal
        trade={selectedTrade}
        userId={user?.id}
        manualOverrideWarningMaps={manualOverrideWarningMaps}
        onClose={() => setSelectedTrade(null)}
      />

      <SignalReviewDetailModal
        signal={selectedReviewSignal}
        onClose={() => setSelectedReviewSignal(null)}
      />
    </PageShell>
  )
}
function TradesPagination({
  page,
  pageSize,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: PageSizeOption
  totalPages: number
  rangeStart: number
  rangeEnd: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: PageSizeOption) => void
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
    <div className="flex flex-col gap-3 px-3 sm:px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Show</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value) as PageSizeOption)}
            className="h-8 min-w-[4.5rem] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2 text-sm text-neutral-900 dark:text-neutral-50 tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
            aria-label="Results per page"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>results</span>
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
          Showing <span className="font-medium text-neutral-700 dark:text-neutral-300">{rangeStart}–{rangeEnd}</span> of{' '}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{total}</span>
        </p>
      </div>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Previous</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <PageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-400 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <PageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-400 text-sm">…</span>
                )}
                <PageButton n={totalPages} active={page === totalPages} onClick={() => onPageChange(totalPages)} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}


function PageButton({ n, active, onClick }: { n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`min-w-[2rem] px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors ${
        active
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:bg-neutral-900 border border-transparent hover:border-neutral-200 dark:border-neutral-800'
      }`}
    >
      {n}
    </button>
  )
}

function TradeCard({ trade, warning, onSelect }: { trade: MtTrade; warning: ManualBrokerOverrideWarning | null; onSelect: () => void }) {
  const t = useT()
  const tr = t.trades
  const { isBuy, isSell, profit, status, broker, directionLabel, timeLabel } = getTradeDisplayMeta(trade)
  const statusLabel =
    trade.status === 'open' ? tr.statusOpen : trade.status === 'closed' ? tr.statusClosed : status.label

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50 truncate">
            {trade.symbol || '—'}
          </p>
          <p className="text-[11px] text-neutral-400 tabular-nums mt-0.5">#{trade.ticket}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Badge variant={status.variant} size="sm">{statusLabel}</Badge>
          <span className={`text-sm font-semibold tabular-nums ${
            profit === null ? 'text-neutral-400' :
            profit > 0 ? 'text-success-600' :
            profit < 0 ? lossTextClass : 'text-neutral-500 dark:text-neutral-400'
          }`}>
            {profit === null ? '—' : `${profit > 0 ? '+' : ''}${profit.toFixed(2)}`}
          </span>
        </div>
      </div>

      <div className={`inline-flex items-center gap-1 text-sm font-medium mb-3 ${
        isBuy ? 'text-success-600' : isSell ? 'text-error-600' : 'text-neutral-500 dark:text-neutral-400'
      }`}>
        {isBuy ? <ArrowUpRight className="w-3.5 h-3.5" /> : isSell ? <ArrowDownRight className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
        {directionLabel}
      </div>

      {warning ? (
        <div className="mb-3"><ManualBrokerOverrideWarningBadge /></div>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colBroker}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 truncate mt-0.5" title={broker}>{broker}</dd>
        </div>
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colLots}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">
            {formatTradeLots(trade.lot_size)}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colEntry}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">{formatTradePrice(trade.entry_price)}</dd>
        </div>
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colTime}</dt>
          <dd className="text-neutral-600 dark:text-neutral-400 mt-0.5">{timeLabel}</dd>
        </div>
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colSl}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">{formatTradePrice(trade.sl)}</dd>
        </div>
        <div>
          <dt className="text-neutral-400 uppercase tracking-wide">{tr.colTp}</dt>
          <dd className="text-neutral-700 dark:text-neutral-300 tabular-nums mt-0.5">{formatTradePrice(trade.tp)}</dd>
        </div>
      </dl>
      <p className="mt-3 flex items-center justify-end gap-1 text-xs font-medium text-teal-600 dark:text-teal-400 opacity-0 group-hover:opacity-100 transition-opacity">
        {tr.viewDetails}
        <ChevronRightIcon className="w-3.5 h-3.5" />
      </p>
    </button>
  )
}

function TradeRow({ trade, warning, onSelect }: { trade: MtTrade; warning: ManualBrokerOverrideWarning | null; onSelect: () => void }) {
  const t = useT()
  const tr = t.trades
  const { isBuy, isSell, profit, status, broker, directionLabel, timeLabel } = getTradeDisplayMeta(trade)
  const statusLabel =
    trade.status === 'open' ? tr.statusOpen : trade.status === 'closed' ? tr.statusClosed : status.label

  return (
    <tr
      className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors cursor-pointer group"
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${tr.viewDetails}: ${trade.symbol ?? 'trade'} #${trade.ticket}`}
    >
      <td className="px-4 py-3.5 text-sm font-semibold text-neutral-900 dark:text-neutral-50 text-center">
        <div>{trade.symbol || '—'}</div>
        <div className="text-[10px] text-neutral-400 font-normal tabular-nums mt-0.5">#{trade.ticket}</div>
      </td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center ${
        isBuy ? 'text-success-600' : isSell ? 'text-error-600' : 'text-neutral-500 dark:text-neutral-400'
      }`}>
        <span className="inline-flex items-center justify-center gap-1 w-full">
          {isBuy ? <ArrowUpRight className="w-3.5 h-3.5" /> : isSell ? <ArrowDownRight className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          {directionLabel}
        </span>
      </td>
      <td className="px-2 py-3.5 text-xs text-neutral-600 dark:text-neutral-400 text-center truncate" title={broker}>{broker}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatTradePrice(trade.entry_price)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatTradePrice(trade.sl)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatTradePrice(trade.tp)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatTradeLots(trade.lot_size)}</td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center tabular-nums ${
        profit === null ? 'text-neutral-400' :
        profit > 0 ? 'text-success-600' :
        profit < 0 ? lossTextClass : 'text-neutral-500 dark:text-neutral-400'
      }`}>
        {profit === null ? '—' : (
          <span className="inline-flex items-center justify-center gap-1 w-full">
            {profit > 0 ? <TrendingUp className="w-3 h-3" /> : profit < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
            {profit > 0 ? '+' : ''}{profit.toFixed(2)}
          </span>
        )}
      </td>
      <td className="px-2 py-3.5 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap text-center">
        {timeLabel}
      </td>
      <td className="px-4 py-3.5 text-center">
        <span className="inline-flex justify-center items-center gap-1 w-full">
          <span className="flex flex-col items-center gap-1">
            <Badge variant={status.variant} size="sm">{statusLabel}</Badge>
            {warning ? <ManualBrokerOverrideWarningBadge /> : null}
          </span>
          <ChevronRightIcon className="w-3.5 h-3.5 text-neutral-300 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden />
        </span>
      </td>
    </tr>
  )
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ago`
}
