import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useCopierStartBlocked } from '../../hooks/useCopierStartBlocked'

/**
 * Amber banner below the top navbar — tells the user which setup step is
 * missing and links them to the right page to fix it.
 */
export function AppCopierSetupBanner() {
  const t = useT()
  const cp = t.nav.copierPause
  const { copierStartBlocked, copierStartBlockedReason, missingBroker, missingTelegram, missingChannels, resolving } =
    useCopierStartBlocked()

  if (resolving || !copierStartBlocked || copierStartBlockedReason !== 'setup') return null

  const parts: string[] = []
  if (missingBroker) parts.push(cp.setupBroker ?? 'link a broker')
  if (missingTelegram) parts.push(cp.setupTelegram ?? 'connect Telegram')
  if (missingChannels) parts.push(cp.setupChannels ?? 'add a channel')

  if (parts.length === 0) return null

  const sep = cp.bannerLastSep ?? ' and '
  const list =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]}${sep}${parts[1]}`
        : `${parts[0]}, ${parts[1]}${sep}${parts[2]}`

  const href = missingBroker ? '/brokers' : '/channels'

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-center text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6"
    >
      <Settings2 className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">
        {(cp.bannerText ?? 'To start the copier, please {items}.').replace('{items}', list)}{' '}
        <Link
          to={href}
          className="underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-100"
        >
          {cp.bannerAction ?? 'Go to setup'}
        </Link>
      </p>
    </div>
  )
}
