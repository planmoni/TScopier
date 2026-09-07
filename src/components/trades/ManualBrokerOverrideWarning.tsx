import { TriangleAlert } from 'lucide-react'
import type { ManualBrokerOverrideWarning as ManualBrokerOverrideWarningModel } from '../../lib/manualBrokerOverrideWarnings'

export function ManualBrokerOverrideWarningBadge() {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
      <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">Manual broker changes were reverted</span>
    </span>
  )
}

export function ManualBrokerOverrideWarningNotice({
  warning,
  onManageSignal,
}: {
  warning: ManualBrokerOverrideWarningModel
  onManageSignal: () => void
}) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 space-y-2.5 dark:border-amber-900/60 dark:bg-amber-950/25">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
          {warning.title}
        </p>
      </div>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">{warning.body}</p>
      <button
        type="button"
        onClick={onManageSignal}
        className="inline-flex items-center justify-center rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-800 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
      >
        {warning.actionLabel}
      </button>
    </section>
  )
}
