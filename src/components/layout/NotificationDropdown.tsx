import { useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowUpRight, Check, CircleCheck, Layers, Loader2, Pencil, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useNotifications } from '../../context/NotificationsContext'
import { useLocale, useT } from '../../context/LocaleContext'
import { formatRelative } from '../../lib/formatRelative'
import { groupNotificationsByDay } from '../../lib/notificationDayGroups'
import type { TradeNotificationHeadline } from '../../lib/tradeNotifications'

interface NotificationDropdownProps {
  open: boolean
  onClose: () => void
}

const HEADLINE_ICON_CLASS = 'text-neutral-700 bg-neutral-100 dark:text-neutral-300 dark:bg-neutral-800'
const REVIEW_ICON_CLASS = 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-950/60'

function headlineMeta(headline: TradeNotificationHeadline): {
  icon: typeof CircleCheck
  className: string
} {
  switch (headline) {
    case 'execution_completed':
      return { icon: ArrowUpRight, className: HEADLINE_ICON_CLASS }
    case 'modification_completed':
      return { icon: Pencil, className: HEADLINE_ICON_CLASS }
    case 'layering_completed':
      return { icon: Layers, className: HEADLINE_ICON_CLASS }
    case 'trades_closed':
      return { icon: Check, className: HEADLINE_ICON_CLASS }
    case 'review_required':
      return { icon: TriangleAlert, className: REVIEW_ICON_CLASS }
    case 'manual_override_reverted':
      return { icon: RotateCcw, className: REVIEW_ICON_CLASS }
  }
}

const LOCALE_BCP: Record<string, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
}

export function NotificationDropdown({ open, onClose }: NotificationDropdownProps) {
  const t = useT()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const nn = t.nav.notifications
  const { items, loading, markAllRead } = useNotifications()
  const panelRef = useRef<HTMLDivElement>(null)

  const dayGroups = useMemo(
    () =>
      groupNotificationsByDay(items, {
        today: nn.dayToday,
        yesterday: nn.dayYesterday,
        locale: LOCALE_BCP[locale] ?? locale,
      }),
    [items, nn.dayToday, nn.dayYesterday, locale],
  )

  useEffect(() => {
    if (!open) return
    markAllRead()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, markAllRead])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={nn.title}
      className={clsx(
        'absolute end-0 top-full z-50 mt-1 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-neutral-200 bg-white shadow-lg',
        'before:absolute before:-top-1 before:inset-x-0 before:h-1 before:content-[""]',
        'dark:border-neutral-700 dark:bg-neutral-900',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{nn.title}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label={nn.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto overscroll-y-contain">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            {nn.loading}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <CircleCheck className="mx-auto h-8 w-8 text-neutral-300 dark:text-neutral-600" />
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{nn.empty}</p>
          </div>
        ) : (
          <div>
            {dayGroups.map(group => (
              <section key={group.dayKey} aria-label={group.label}>
                <p className="sticky top-0 z-10 border-b border-neutral-100 bg-neutral-50/95 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-400">
                  {group.label}
                </p>
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {group.items.map(item => {
                    const meta = headlineMeta(item.headline)
                    const Icon = meta.icon
                    const isReview = item.headline === 'review_required'
                    const actionUrl = isReview ? '/account-trades' : item.actionUrl
                    const handleNotificationClick = () => {
                      if (!actionUrl) return
                      onClose()
                      navigate(actionUrl)
                    }
                    const inner = (
                      <div className="flex gap-3 px-4 py-3">
                        <span
                          className={clsx(
                            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                            meta.className,
                          )}
                        >
                          <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-200">
                              {item.title}
                              {item.symbol ? (
                                <span className="ms-1.5 font-mono normal-case tracking-normal text-neutral-500 dark:text-neutral-400">
                                  {item.symbol}
                                </span>
                              ) : null}
                            </p>
                            <time
                              className="shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500"
                              dateTime={item.createdAt}
                            >
                              {formatRelative(Date.parse(item.createdAt))}
                            </time>
                          </div>
                          <p className="mt-1 text-sm leading-snug text-neutral-600 dark:text-neutral-300">
                            {item.body}
                          </p>
                          {item.actionUrl && item.actionLabel ? (
                            <span className="mt-2 inline-flex text-xs font-semibold text-teal-700 dark:text-teal-300">
                              {item.actionLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )
                    return (
                      <li key={item.id} role="none">
                        {actionUrl ? (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={handleNotificationClick}
                            className="w-full text-left transition-colors hover:bg-amber-50 dark:hover:bg-amber-950/30"
                          >
                            {inner}
                          </button>
                        ) : (
                          <div role="menuitem">{inner}</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => {
            markAllRead()
          }}
          className="text-xs font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
        >
          {nn.markAllRead}
        </button>
        <Link
          to="/account-trades"
          onClick={onClose}
          className="text-xs font-medium text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          {nn.viewTrades}
        </Link>
      </div>
    </div>
  )
}
