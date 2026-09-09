import { useEffect, useState } from 'react'
import { AppAnnouncementBar } from './AppAnnouncementBar'
import { AppSubscriptionBanner } from './AppSubscriptionBanner'
import { AppWarningBanner } from './AppWarningBanner'

/**
 * Stacked top bars above the app header: announcement, warning, then subscription.
 * Publishes combined height as `--app-banner-h` for fixed header offset.
 */
export function AppTopBanners() {
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = document.documentElement
    if (!el) {
      root.style.setProperty('--app-banner-h', '0px')
      return
    }
    const update = () => root.style.setProperty('--app-banner-h', `${el.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.setProperty('--app-banner-h', '0px')
    }
  }, [el])

  return (
    <div
      ref={setEl}
      className="relative z-50 shrink-0 pt-[env(safe-area-inset-top,0px)]"
    >
      <AppAnnouncementBar />
      <AppWarningBanner />
      <AppSubscriptionBanner />
    </div>
  )
}
