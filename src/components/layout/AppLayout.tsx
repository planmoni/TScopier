import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Menu, Sparkles, X, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import { getAppRouteIcon } from '../../lib/appNavIcons'
import { TscopierLogo } from '../ui/TscopierLogo'
import { DirectionalIcon } from '../ui/DirectionalIcon'
import { AppSearchDesktop, AppSearchMobileTrigger, AppSearchProvider } from './AppSearch'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { HelpSidebarNav } from './HelpSidebarNav'
import { NotificationBell } from './NotificationBell'
import { CopierPauseToggle } from './CopierPauseToggle'
import { AppCopierSetupBanner } from './AppCopierSetupBanner'
import { UserMenuDropdown } from './UserMenuDropdown'
import { UserAvatar } from './UserAvatar'
import { DashboardKeepAlive } from './DashboardKeepAlive'
import { useUserProfile } from '../../context/UserProfileContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useHasOpenTrades } from '../../hooks/useHasOpenTrades'
import { useHasHighImpactNewsToday } from '../../hooks/useHasHighImpactNewsToday'
import { useNeedsWelcome } from '../../hooks/useNeedsWelcome'

type NavItem = {
  to: string
  label: string
  showOpenTradesIndicator?: boolean
  showHighImpactNewsIndicator?: boolean
}

type AppLayoutProps = {
  onAssistantTrigger?: () => void
}

export function AppLayout({ onAssistantTrigger }: AppLayoutProps) {
  const t = useT()
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const onDashboardRoute = location.pathname === '/dashboard'
    || location.pathname.startsWith('/dashboard/broker/')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const userMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { profile } = useUserProfile()
  const { planName, hasActiveSubscription, checkoutSyncPending, effectivePlan, openUpgrade, isPastDue, hasTrialExpired } =
    useSubscription()
  const subscribeCta = getSubscribeCtaLabel(t, {
    isPastDue,
    effectivePlan,
    hasTrialExpired,
  })
  const { deferAppBootstrap } = useNeedsWelcome()
  const [calendarCheckEnabled, setCalendarCheckEnabled] = useState(false)
  useEffect(() => {
    if (deferAppBootstrap) return
    const enable = () => setCalendarCheckEnabled(true)
    if (typeof requestIdleCallback !== 'undefined') {
      const idleId = requestIdleCallback(enable, { timeout: 5000 })
      return () => cancelIdleCallback(idleId)
    }
    const timer = window.setTimeout(enable, 3000)
    return () => window.clearTimeout(timer)
  }, [deferAppBootstrap])
  const hasOpenTrades = useHasOpenTrades(deferAppBootstrap ? undefined : user?.id)
  const hasHighImpactNewsToday = useHasHighImpactNewsToday(
    deferAppBootstrap ? false : calendarCheckEnabled,
  )

  const openUserMenu = () => {
    if (userMenuCloseTimerRef.current) {
      clearTimeout(userMenuCloseTimerRef.current)
      userMenuCloseTimerRef.current = null
    }
    setUserMenuOpen(true)
  }

  const scheduleCloseUserMenu = () => {
    if (userMenuCloseTimerRef.current) clearTimeout(userMenuCloseTimerRef.current)
    userMenuCloseTimerRef.current = setTimeout(() => {
      setUserMenuOpen(false)
      userMenuCloseTimerRef.current = null
    }, 150)
  }

  useEffect(() => {
    return () => {
      if (userMenuCloseTimerRef.current) clearTimeout(userMenuCloseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!userMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [userMenuOpen])

  const navSections = useMemo(
    (): Array<{ label: string; items: NavItem[] }> => [
      {
        label: t.nav.sections.general,
        items: [
          { to: '/dashboard', label: t.nav.items.dashboard },
          { to: '/brokers', label: t.nav.items.brokers },
          { to: '/account-trades', label: t.nav.items.trades, showOpenTradesIndicator: true },
        ],
      },
      {
        label: t.nav.sections.signals,
        items: [
          { to: '/channels', label: t.nav.items.channels },
          { to: '/backtest', label: t.nav.items.backtest },
          { to: '/activities', label: t.nav.items.management },
          { to: '/copier-logs', label: t.nav.items.copierLogs },
          { to: '/manage-signals', label: t.nav.items.signalHistory },
          { to: '/performance', label: t.nav.items.performance },
        ],
      },
      // Popular channels disabled for now.
      // {
      //   label: t.nav.sections.discover,
      //   items: [
      //     { to: '/popular-channels', label: t.nav.items.popularChannels },
      //   ],
      // },
      {
        label: t.nav.sections.tradingTools,
        items: [
          { to: '/market-news', label: t.nav.items.marketNews },
          { to: '/economic-calendar', label: t.nav.items.economicCalendar, showHighImpactNewsIndicator: true },
        ],
      },
      {
        label: t.nav.sections.membership,
        items: [
          { to: '/billing', label: t.nav.userMenu.subscriptionBilling },
          { to: '/affiliate-program', label: t.nav.userMenu.affiliateProgram },
        ],
      },
    ],
    [t],
  )

  useEffect(() => {
    queueMicrotask(() => {
      setMobileNavOpen(false)
      setNotificationsOpen(false)
    })
  }, [location.pathname])

  // Subscription reminder modal on dashboard handles the nudge — no forced redirect.

  // After Stripe success, paywall may have raced to /pricing before webhook sync — send back.
  useEffect(() => {
    if (!checkoutSyncPending) return
    if (location.pathname !== '/pricing') return
    navigate('/dashboard', { replace: true })
  }, [checkoutSyncPending, location.pathname, navigate])

  useEffect(() => {
    document.documentElement.classList.add('app-viewport-lock')
    return () => document.documentElement.classList.remove('app-viewport-lock')
  }, [])

  useEffect(() => {
    if (!mobileNavOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mobileNavOpen])

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  const handleAssistantTrigger = () => {
    onAssistantTrigger?.()
  }

  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    profile.display_name?.trim() ||
    user?.email?.split('@')[0] ||
    'User'

  const sidebarExpanded = !isSidebarCollapsed

  const navLinkClass = (isCollapsed: boolean, disabled = false) =>
    ({ isActive }: { isActive: boolean }) =>
      clsx(
        'flex items-center px-3 py-2.5 rounded-xl text-sm transition-colors min-h-[20px]',
        isCollapsed ? 'justify-center' : 'gap-2',
        disabled
          ? 'cursor-pointer font-medium text-neutral-400 opacity-45 hover:bg-neutral-50 hover:text-neutral-600 hover:opacity-80 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
          : isActive
            ? 'bg-teal-50 text-teal-800 font-semibold dark:bg-teal-950/60 dark:text-teal-400'
            : 'text-neutral-800 font-medium hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
      )

  const renderNavItemContent = (
    opts: { collapsed: boolean },
    {
      icon: Icon,
      label,
      isActive,
      showOpenTradesIndicator,
      showHighImpactNewsIndicator,
    }: {
      icon: LucideIcon
      label: string
      isActive: boolean
      showOpenTradesIndicator?: boolean
      showHighImpactNewsIndicator?: boolean
    },
  ) => {
    const showOpenIndicator = Boolean(showOpenTradesIndicator && hasOpenTrades)
    const showFireIndicator = Boolean(showHighImpactNewsIndicator && hasHighImpactNewsToday)
    return (
      <>
        <span className="relative inline-flex shrink-0">
          <Icon
            className={clsx(
              'w-4 h-4',
              isActive ? 'text-teal-600 dark:text-teal-400' : '',
            )}
          />
          {showOpenIndicator && opts.collapsed ? (
            <span
              className="absolute -end-0.5 -top-0.5 h-2 w-2 rounded-full bg-teal-500 ring-2 ring-white dark:ring-neutral-900"
              aria-hidden
            />
          ) : null}
          {showFireIndicator && opts.collapsed && !showOpenIndicator ? (
            <span
              className="absolute -end-1 -top-1 text-[10px] leading-none"
              aria-hidden
            >
              🔥
            </span>
          ) : null}
        </span>
        <span className={clsx(opts.collapsed && 'lg:hidden')}>{label}</span>
        {showOpenIndicator && !opts.collapsed ? (
          <span
            className="ms-auto h-2 w-2 shrink-0 rounded-full bg-teal-500"
            aria-hidden
          />
        ) : null}
        {showFireIndicator && !opts.collapsed && !showOpenIndicator ? (
          <span className="ms-auto shrink-0 text-sm leading-none" aria-hidden>
            🔥
          </span>
        ) : null}
      </>
    )
  }

  const renderNav = (opts: { collapsed: boolean; onNavigate?: () => void }) => (
    <>
      {navSections.map(section => {
        const sectionItems = section.items.map(item => ({
          ...item,
          disabled: false,
        }))

        return (
        <div key={section.label}>
          <p
            className={clsx(
              'px-3 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 tracking-widest mb-1.5',
              opts.collapsed && 'hidden',
            )}
          >
            {section.label}
          </p>
          <div className="space-y-0.5">
            {sectionItems.map(({ to, label, showOpenTradesIndicator, showHighImpactNewsIndicator, disabled }) => {
              const Icon = getAppRouteIcon(to)
              const ariaExtra = showOpenTradesIndicator && hasOpenTrades
                ? t.nav.openTradesActive
                : showHighImpactNewsIndicator && hasHighImpactNewsToday
                  ? t.nav.highImpactNewsToday
                  : null

              if (disabled) {
                return (
                  <button
                    type="button"
                    key={to}
                    title={label}
                    aria-label={ariaExtra ? `${label} — ${ariaExtra}` : label}
                    onClick={() => {
                      openUpgrade('advanced')
                      opts.onNavigate?.()
                    }}
                    className={clsx(navLinkClass(opts.collapsed, true)({ isActive: false }), 'w-full text-start')}
                  >
                    {renderNavItemContent(opts, {
                      icon: Icon,
                      label,
                      isActive: false,
                      showOpenTradesIndicator,
                      showHighImpactNewsIndicator,
                    })}
                  </button>
                )
              }

              return (
                <NavLink
                  key={to}
                  to={to}
                  title={label}
                  aria-label={ariaExtra ? `${label} — ${ariaExtra}` : label}
                  onClick={opts.onNavigate}
                  className={navLinkClass(opts.collapsed)}
                >
                  {({ isActive }) => (
                    renderNavItemContent(opts, {
                      icon: Icon,
                      label,
                      isActive,
                      showOpenTradesIndicator,
                      showHighImpactNewsIndicator,
                    })
                  )}
                </NavLink>
              )
            })}
          </div>
        </div>
        )
      })}
    </>
  )

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden overscroll-none bg-neutral-50 dark:bg-neutral-950">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label={t.nav.closeMenu}
          className="fixed inset-0 z-40 bg-neutral-900/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex h-full min-h-0 flex-col overflow-hidden border-e border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 transition-transform duration-200 ease-out rtl:left-auto rtl:right-0',
          'w-64 max-w-[85vw]',
          mobileNavOpen ? 'translate-x-0' : 'max-lg:-translate-x-full max-lg:rtl:translate-x-full',
          'lg:sticky lg:top-0 lg:z-30 lg:max-w-none lg:translate-x-0',
          isSidebarCollapsed ? 'lg:w-20' : 'lg:w-64',
        )}
      >
        <div
          className={clsx(
            'flex h-16 shrink-0 items-center border-b border-neutral-100 dark:border-neutral-800',
            sidebarExpanded ? 'justify-between px-4' : 'justify-center px-2',
          )}
        >
          <Link
            to="/dashboard"
            className="flex shrink-0 items-center lg:hidden"
            aria-label={t.nav.items.dashboard}
            onClick={() => setMobileNavOpen(false)}
          >
            <TscopierLogo className="h-6 w-auto" />
          </Link>
          <div
            className={clsx(
              'hidden lg:block transition-all duration-200',
              !sidebarExpanded && 'mx-auto',
            )}
          >
            <Link
              to="/dashboard"
              className="flex items-center"
              aria-label={t.nav.items.dashboard}
            >
              <TscopierLogo
                collapsed={!sidebarExpanded}
                className={sidebarExpanded ? 'h-6 w-auto' : undefined}
              />
            </Link>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 lg:hidden"
            aria-label={t.nav.closeMenu}
            onClick={() => setMobileNavOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-4">
          {renderNav({
            collapsed: !sidebarExpanded,
            onNavigate: () => setMobileNavOpen(false),
          })}
          <HelpSidebarNav
            collapsed={!sidebarExpanded}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </nav>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-none">
        <AppSearchProvider headerEl={headerEl}>
        <header
          ref={setHeaderEl}
          className={clsx(
            'z-30 flex shrink-0 touch-none items-center gap-2 border-b border-neutral-100 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-900 sm:gap-4 sm:px-6',
            'fixed inset-x-0 top-[var(--app-banner-h,0px)] h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] sm:h-[calc(4rem+env(safe-area-inset-top,0px))]',
            'lg:static lg:z-20 lg:h-16 lg:min-h-0 lg:pt-0 lg:touch-auto',
          )}
        >
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="p-2 rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 transition-colors lg:hidden"
            aria-label={t.nav.openMenu}
          >
            <Menu className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title={isSidebarCollapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
            className="hidden lg:block p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {isSidebarCollapsed ? <DirectionalIcon icon={PanelLeftOpen} className="w-5 h-5" /> : <DirectionalIcon icon={PanelLeftClose} className="w-5 h-5" />}
          </button>

          <AppSearchDesktop className="flex-1 max-w-md min-w-0" />

          <div className="flex-1 min-w-0 lg:hidden" />

          <div className="relative z-40 flex shrink-0 items-center gap-1 sm:gap-2 lg:ms-auto">
            {hasActiveSubscription && effectivePlan === 'basic' ? (
              <button
                type="button"
                onClick={() => openUpgrade('advanced')}
                className="hidden sm:inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-700 transition-colors hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-950/60"
              >
                {subscribeCta}
              </button>
            ) : null}
            <CopierPauseToggle />
            <button
              type="button"
              onClick={handleAssistantTrigger}
              aria-label={t.nav.assistant.ariaLabel}
              title={t.nav.assistant.title}
              className={clsx(
                'inline-flex h-10 w-10 items-center justify-center rounded-lg text-teal-700 transition-colors',
                'hover:bg-teal-50 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-white',
                'dark:text-teal-300 dark:hover:bg-teal-950/50 dark:focus:ring-offset-neutral-900',
              )}
            >
              <Sparkles className="h-5 w-5" aria-hidden />
            </button>
            <AppSearchMobileTrigger />
            <LanguageSwitcher />
            <ThemeToggle />
            <NotificationBell
              open={notificationsOpen}
              onOpen={() => {
                setUserMenuOpen(false)
                setNotificationsOpen(true)
              }}
              onClose={() => setNotificationsOpen(false)}
            />

            <div
              ref={userMenuRef}
              className="relative"
              onMouseEnter={openUserMenu}
              onMouseLeave={scheduleCloseUserMenu}
            >
              <button
                type="button"
                onClick={() => {
                  if (!window.matchMedia('(hover: hover)').matches) {
                    setNotificationsOpen(false)
                    setUserMenuOpen(open => !open)
                  }
                }}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label={t.nav.userMenu.menuLabel}
                className={clsx(
                  'flex items-center gap-2 rounded-lg ps-1 pe-2 min-h-[44px] transition-colors',
                  userMenuOpen
                    ? 'bg-neutral-100 dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                )}
              >
              <UserAvatar user={user} profile={profile} email={user?.email} size="sm" />
              <div className="hidden md:block text-start">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 leading-tight truncate max-w-[8rem]">
                  {displayName}
                </p>
                <p className="text-xs text-neutral-400 leading-tight">{planName || t.nav.planFree}</p>
              </div>
                <ChevronDown
                  className={clsx(
                    'hidden md:block w-3.5 h-3.5 text-neutral-400 shrink-0 transition-transform',
                    userMenuOpen && 'rotate-180',
                  )}
                />
              </button>
              <UserMenuDropdown
                open={userMenuOpen}
                onClose={() => setUserMenuOpen(false)}
                onSignOut={handleSignOut}
              />
            </div>
          </div>
        </header>
        </AppSearchProvider>

        <main
          className={clsx(
            'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-neutral-50 dark:bg-neutral-950',
            'pt-[calc(3.5rem+env(safe-area-inset-top,0px))] sm:pt-[calc(4rem+env(safe-area-inset-top,0px))]',
            'lg:pt-0',
          )}
        >
          {!deferAppBootstrap && <AppCopierSetupBanner />}
          <DashboardKeepAlive />
          {!deferAppBootstrap && !onDashboardRoute && <Outlet />}
        </main>
      </div>
    </div>
  )
}
