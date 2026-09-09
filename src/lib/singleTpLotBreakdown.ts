/**
 * Preview how a Single Entry fixed lot splits across TPs (partial closes + broker terminal).
 * Mirrors worker/src/manualPlanning/partialTpSchedule.ts planSinglePartialTps sizing rules.
 */

export type SingleTpTarget = `tp${number}` | 'farthest'

export type SingleTpLotSlice = {
  tpLabel: string
  /** 1-based TP index (TP1 → 1). */
  tpIdx: number
  lots: number
}

export type SingleTpLotBreakdownArgs = {
  manualLot: number
  singleTpTarget?: SingleTpTarget | string | null
  /** TP distribution rows; only enabled rows with a usable percent participate. */
  tpLots: Array<{ label?: string; percent?: number; enabled?: boolean }>
  minLot?: number
  lotStep?: number
}

function normalizeSingleTpTarget(raw: unknown): SingleTpTarget {
  const v = String(raw ?? 'farthest').toLowerCase()
  const m = v.match(/^tp(\d+)$/)
  return m ? (`tp${m[1]}` as SingleTpTarget) : 'farthest'
}

function resolveSingleTpTargetIndex(args: {
  finalTps: number[]
  singleTpTarget?: SingleTpTarget
}): number {
  const { finalTps } = args
  if (!Array.isArray(finalTps) || finalTps.length === 0) return -1
  const target = normalizeSingleTpTarget(args.singleTpTarget)
  const tpMatch = target.match(/^tp(\d+)$/)
  if (tpMatch) {
    const idx = Number(tpMatch[1]) - 1
    return Math.min(Math.max(0, idx), finalTps.length - 1)
  }
  // Preview has no buy/sell — same as worker when isBuy is undefined.
  return finalTps.length - 1
}

function formatLot(lots: number): number {
  return Number(lots.toFixed(8))
}

function defaultLabel(idx: number, label?: string): string {
  const trimmed = String(label ?? '').trim()
  if (trimmed) return trimmed
  return `TP${idx + 1}`
}

/**
 * Build ordered lot slices for the Single TP target preview.
 * Partials use floor(manualLot × percent/100 / lotStep) × lotStep; terminal gets the remainder.
 */
export function computeSingleTpLotBreakdown(args: SingleTpLotBreakdownArgs): SingleTpLotSlice[] {
  const minLot = args.minLot ?? 0.01
  const lotStep = args.lotStep ?? 0.01
  const manualLot = Number(args.manualLot)
  if (!Number.isFinite(manualLot) || manualLot <= 0) return []

  const enabled = (args.tpLots ?? []).filter(r => r?.enabled !== false)
  if (!enabled.length) {
    return [{ tpLabel: 'TP1', tpIdx: 1, lots: formatLot(manualLot) }]
  }

  // Synthetic ascending prices — only indices matter for the preview.
  const finalTps = enabled.map((_, i) => i + 1)
  const bucketRows = enabled.map(r => ({
    percent: Number(r.percent),
  }))
  const labels = enabled.map((r, i) => defaultLabel(i, r.label))

  const targetIndex = resolveSingleTpTargetIndex({
    finalTps,
    singleTpTarget: normalizeSingleTpTarget(args.singleTpTarget),
  })
  if (targetIndex < 0) {
    return [{ tpLabel: labels[0] ?? 'TP1', tpIdx: 1, lots: formatLot(manualLot) }]
  }

  if (finalTps.length < 2 || !bucketRows.length) {
    return [{
      tpLabel: labels[targetIndex] ?? labels[0] ?? 'TP1',
      tpIdx: targetIndex + 1,
      lots: formatLot(manualLot),
    }]
  }

  const terminalIdx = Math.max(0, Math.min(targetIndex, finalTps.length - 1))
  const bucketCount = Math.min(bucketRows.length, finalTps.length, terminalIdx + 1)
  if (bucketCount < 2) {
    return [{
      tpLabel: labels[terminalIdx] ?? 'TP1',
      tpIdx: terminalIdx + 1,
      lots: formatLot(manualLot),
    }]
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

  const slices: SingleTpLotSlice[] = []
  let partialLotsSum = 0

  for (let i = 0; i < bucketCount - 1; i++) {
    const pctRaw = Number(bucketRows[i]?.percent)
    const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.min(100, pctRaw) : 0
    if (pct <= 0) continue
    let units = toUnits(manualLot * (pct / 100))
    if (units < minUnits) continue
    if (units > remainingUnits) {
      units = remainingUnits
      if (units < minUnits) continue
    }
    remainingUnits -= units
    const lots = unitsToLot(units)
    partialLotsSum += lots
    slices.push({
      tpLabel: labels[i] ?? `TP${i + 1}`,
      tpIdx: i + 1,
      lots,
    })
    if (remainingUnits < minUnits) break
  }

  const remainder = formatLot(Math.max(0, manualLot - partialLotsSum))
  if (remainder > 0 || slices.length === 0) {
    slices.push({
      tpLabel: labels[terminalIdx] ?? `TP${terminalIdx + 1}`,
      tpIdx: terminalIdx + 1,
      lots: remainder > 0 ? remainder : formatLot(manualLot),
    })
  }

  return slices
}
