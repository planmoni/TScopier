import type { PlannerPartialTp } from './types'

export interface PlanSinglePartialTpsArgs {
  /** Already-rounded total volume of the parent single order. */
  manualLot: number
  minLot: number
  lotStep: number
  /** All TPs in the signal, signed (already converted from pip-distance to absolute price). */
  finalTps: number[]
  /** Targets % rows aligned to finalTps[0..] (from resolveTpBucketRows). */
  bucketRows: Array<{ percent?: number }>
  /** Preferred broker TP in Single mode. */
  singleTpTarget?: `tp${number}` | 'farthest'
  /** Optional direction hint so "farthest" can use price extremes. */
  isBuy?: boolean
}

export interface PlanSinglePartialTpsResult {
  /** TP price the broker order should ride to (= last enabled-bucket TP). Null when there
   *  isn't enough info to derive partials — in that case the caller falls back to TP1. */
  brokerTp: number | null
  /** Per-bucket partials, excluding the last bucket (that's the broker TP). Empty when
   *  the schedule degenerates to "use TP1 with no partials". */
  partials: PlannerPartialTp[]
  /** Non-fatal note describing why partials were dropped / capped, suitable for logging. */
  fallbackReason?: string
}

export function normalizeSingleTpTarget(
  raw: unknown,
): `tp${number}` | 'farthest' {
  const v = String(raw ?? 'farthest').toLowerCase()
  const m = v.match(/^tp(\d+)$/)
  return m ? (`tp${m[1]}` as `tp${number}`) : 'farthest'
}

export function resolveSingleTpTargetIndex(args: {
  finalTps: number[]
  singleTpTarget?: `tp${number}` | 'farthest'
  isBuy?: boolean
}): number {
  const { finalTps, isBuy } = args
  if (!Array.isArray(finalTps) || finalTps.length === 0) return -1
  const target = normalizeSingleTpTarget(args.singleTpTarget)
  const tpMatch = target.match(/^tp(\d+)$/)
  if (tpMatch) {
    const idx = Number(tpMatch[1]) - 1
    return Math.min(Math.max(0, idx), finalTps.length - 1)
  }

  if (isBuy === true) {
    let idx = 0
    for (let i = 1; i < finalTps.length; i++) {
      if ((finalTps[i] ?? 0) > (finalTps[idx] ?? 0)) idx = i
    }
    return idx
  }
  if (isBuy === false) {
    let idx = 0
    for (let i = 1; i < finalTps.length; i++) {
      if ((finalTps[i] ?? 0) < (finalTps[idx] ?? 0)) idx = i
    }
    return idx
  }
  return finalTps.length - 1
}

/**
 * Build the per-TP partial close schedule for a `trade_style === 'single'`
 * trade.
 *
 * Rules:
 *   - When `finalTps.length >= 2` AND there are enabled bucket rows, the
 *     broker TP becomes the LAST bucket-paired TP (so the trade rides
 *     to its deepest target) and the EARLIER buckets emit partials.
 *   - When `finalTps.length < 2` OR no enabled bucket rows, partials don't
 *     apply. With **two or more** TPs and no buckets, the broker TP is the
 *     **last** TP (deepest target). With a single TP, broker TP is that TP.
 *   - `closeLots` is `floor(manualLot × percent / 100 / lotStep) × lotStep`
 *     and is dropped when the result is below `minLot`. We never close
 *     more than `manualLot - minLot` across all partials so the last
 *     slice that rides to broker TP is always >= `minLot` (otherwise the
 *     final lot would round to 0 and the broker TP becomes a no-op).
 */
export function planSinglePartialTps(args: PlanSinglePartialTpsArgs): PlanSinglePartialTpsResult {
  const { manualLot, minLot, lotStep, finalTps, bucketRows, isBuy } = args

  if (!Number.isFinite(manualLot) || manualLot <= 0) {
    return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' }
  }
  if (!Array.isArray(finalTps) || finalTps.length === 0) {
    return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' }
  }
  const targetIndex = resolveSingleTpTargetIndex({
    finalTps,
    singleTpTarget: args.singleTpTarget,
    isBuy,
  })
  const selectedTp = targetIndex >= 0 ? (finalTps[targetIndex] ?? null) : null

  if (finalTps.length < 2) {
    return { brokerTp: selectedTp ?? finalTps[0] ?? null, partials: [] }
  }
  if (!bucketRows.length) {
    const brokerTp = selectedTp ?? finalTps[finalTps.length - 1] ?? null
    return { brokerTp, partials: [] }
  }

  const terminalIdxRaw = targetIndex >= 0 ? targetIndex : finalTps.length - 1
  const terminalIdx = Math.max(0, Math.min(terminalIdxRaw, finalTps.length - 1))
  const bucketCount = Math.min(bucketRows.length, finalTps.length, terminalIdx + 1)
  const pairedTps = finalTps.slice(0, bucketCount)
  const pairedBuckets = bucketRows.slice(0, bucketCount)
  const brokerTp = selectedTp ?? pairedTps[pairedTps.length - 1] ?? null
  if (bucketCount < 2 || brokerTp == null) {
    return { brokerTp, partials: [] }
  }

  const FP_EPS = 1e-9
  const toUnits = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.max(0, Math.floor(v / lotStep + FP_EPS))
  }
  const unitsToLot = (u: number): number => Number((u * lotStep).toFixed(8))

  const manualUnits = toUnits(manualLot)
  const minUnits = Math.max(1, Math.round(minLot / lotStep))
  const usableUnits = Math.max(0, manualUnits - minUnits)
  let remainingUnits = usableUnits

  const partials: PlannerPartialTp[] = []
  let fallbackReason: string | undefined

  for (let i = 0; i < bucketCount - 1; i++) {
    const tp = pairedTps[i]
    if (tp == null || !Number.isFinite(tp) || tp <= 0) continue
    const pctRaw = Number(pairedBuckets[i]?.percent)
    const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.min(100, pctRaw) : 0
    if (pct <= 0) continue
    let units = toUnits(manualLot * (pct / 100))
    if (units < minUnits) {
      fallbackReason = fallbackReason ?? 'partial_tp_below_min_lot'
      continue
    }
    if (units > remainingUnits) {
      units = remainingUnits
      fallbackReason = fallbackReason ?? 'partial_tp_capped_remainder'
      if (units < minUnits) continue
    }
    remainingUnits -= units
    partials.push({
      tpIdx: i + 1,
      triggerPrice: tp,
      closeLots: unitsToLot(units),
      percent: pct,
    })
    if (remainingUnits < minUnits) {
      break
    }
  }

  return { brokerTp, partials, fallbackReason }
}
