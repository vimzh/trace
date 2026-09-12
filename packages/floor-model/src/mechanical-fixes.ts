import { BRAILLE_MM, textBrailleSize } from './braille'
import { fitPositionsInPolygon } from './fit'
import type { Point } from './schema'
import { MAX_SYMBOL_SHIFT_MM, type TactileDesign, type ValidationViolation } from './tactile'
import {
  SEAM_CLEARANCE_MM,
  introducesAnchorViolation,
  validateTactileDesign,
  validateTactileMove,
  type ValidationContext,
} from './validate'

// Deterministic repairs for violations that never need judgment — the
// layout agent (LLM) is reserved for trade-offs. Margins, seam clearance,
// label fit, and pairwise clearance are pure arithmetic: shift the movable element the
// measured shortfall along the obvious axis and keep whichever candidate
// validates best.

const EXTRA_CLEAR_MM = 0.25

type Movable = {
  apply: (dx: number, dy: number) => TactileDesign
  center: Point
  x: { max: number; min: number }
  y: { max: number; min: number }
}

function movableOf(design: TactileDesign, id: string): Movable | null {
  const element = design.elements.find((e) => e.id === id)
  if (!element || (element.kind !== 'braille' && element.kind !== 'symbol')) {
    return null
  }
  const apply = (dx: number, dy: number): TactileDesign => ({
    ...design,
    elements: design.elements.map((e) =>
      e.id === id && (e.kind === 'braille' || e.kind === 'symbol')
        ? { ...e, at: { x: e.at.x + dx, y: e.at.y + dy } }
        : e,
    ),
  })
  if (element.kind === 'braille') {
    const size = textBrailleSize(element.key)
    return {
      apply,
      center: {
        x: element.at.x + size.widthMm / 2,
        y: element.at.y + size.heightMm / 2,
      },
      x: { max: element.at.x + size.widthMm, min: element.at.x },
      y: { max: element.at.y + size.heightMm, min: element.at.y },
    }
  }
  const half = element.sizeMm / 2
  return {
    apply,
    center: element.at,
    x: { max: element.at.x + half, min: element.at.x - half },
    y: { max: element.at.y + half, min: element.at.y - half },
  }
}

function closestSegmentPerpendiculars(
  design: TactileDesign,
  lineId: string,
  from: Point,
): Point[] {
  const line = design.elements.find((e) => e.id === lineId)
  if (!line || line.kind !== 'line') return []
  let best: { a: Point; b: Point } | null = null
  let bestDist = Infinity
  for (let i = 0; i < line.points.length - 1; i++) {
    const a = line.points[i]!
    const b = line.points[i + 1]!
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lengthSq = abx * abx + aby * aby
    const t =
      lengthSq === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((from.x - a.x) * abx + (from.y - a.y) * aby) / lengthSq),
          )
    const d = Math.hypot(from.x - (a.x + t * abx), from.y - (a.y + t * aby))
    if (d < bestDist) {
      bestDist = d
      best = { a, b }
    }
  }
  if (!best) return []
  const dx = best.b.x - best.a.x
  const dy = best.b.y - best.a.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return []
  return [
    { x: -dy / length, y: dx / length },
    { x: dy / length, y: -dx / length },
  ]
}

function directionsAwayFrom(other: Point, center: Point): Point[] {
  const dx = center.x - other.x
  const dy = center.y - other.y
  const length = Math.hypot(dx, dy)
  if (length < 0.01) {
    return [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]
  }
  return [
    { x: dx / length, y: dy / length },
    { x: -dx / length, y: -dy / length },
  ]
}

// A braille label tied to a room/block may relocate anywhere its key fits
// inside that polygon — same search the converter uses for placement.
function relocationCandidates(
  design: TactileDesign,
  context: ValidationContext,
  id: string,
): TactileDesign[] {
  const element = design.elements.find((e) => e.id === id)
  if (!element) return []
  const movable = movableOf(design, id)
  if (!movable) return []
  if (element.kind === 'symbol') {
    const anchor = context.symbolAnchorsMm.find(point => point.id === element.sourceId)
    const directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
      [1, 0.5], [1, -0.5], [-1, 0.5], [-1, -0.5],
      [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1],
    ]
    const candidates = (anchor ? [2.5, 5, 7.5, MAX_SYMBOL_SHIFT_MM] : [8, 16, 24, 32]).flatMap((distance) =>
      directions.map(([x, y]) => {
        const length = Math.hypot(x!, y!)
        return movable.apply((x! / length) * distance, (y! / length) * distance)
      }),
    )
    return anchor ? [movable.apply(anchor.at.x - element.at.x, anchor.at.y - element.at.y), ...candidates] : candidates
  }
  if (element.kind !== 'braille' || !element.sourceId) return []
  const area = design.elements.find(
    (e) => e.kind === 'area' && e.sourceId === element.sourceId,
  )
  const symbol = design.elements.find(
    (e) => e.kind === 'symbol' && e.sourceId === element.sourceId,
  )
  const symbolBounds = symbol?.kind === 'symbol'
    ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
        x: symbol.at.x + x! * symbol.sizeMm / 2,
        y: symbol.at.y + y! * symbol.sizeMm / 2,
      }))
    : undefined
  const polygon =
    area?.kind === 'area'
      ? area.polygon
      : context.roomsMm.find((room) => room.id === element.sourceId)?.polygonMm ?? symbolBounds
  if (!polygon) return []
  const size = textBrailleSize(element.key)
  const current = {
    x: element.at.x + size.widthMm / 2,
    y: element.at.y + size.heightMm / 2,
  }
  const xs = polygon.map((p) => p.x)
  const ys = polygon.map((p) => p.y)
  // Clear of any wall line running along the polygon edge.
  const adjacent: Point[] = [4.5, 8, 12].flatMap((gap) => [
    { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(...ys) + gap + size.heightMm / 2 },
    { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...ys) - gap - size.heightMm / 2 },
    { x: Math.max(...xs) + gap + size.widthMm / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
    { x: Math.min(...xs) - gap - size.widthMm / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
  ])
  for (
    let x = Math.min(...xs) - size.widthMm;
    x <= Math.max(...xs) + size.widthMm;
    x += size.widthMm / 4
  ) {
    for (const gap of [4.5, 8, 12]) {
      adjacent.push(
        { x: x + size.widthMm / 2, y: Math.min(...ys) - gap - size.heightMm / 2 },
        { x: x + size.widthMm / 2, y: Math.max(...ys) + gap + size.heightMm / 2 },
      )
    }
  }
  return [
    ...fitPositionsInPolygon(size.widthMm, size.heightMm, polygon, current, 24),
    ...adjacent,
  ].map((center) => movable.apply(center.x - current.x, center.y - current.y))
}

function candidateMoves(
  design: TactileDesign,
  context: ValidationContext,
  violation: ValidationViolation,
): TactileDesign[] {
  const candidates: TactileDesign[] = []

  if (violation.rule === 'margin') {
    const id = violation.elementIds[0]
    const movable = id ? movableOf(design, id) : null
    if (!id || !movable) return []
    const grid = design.grid ?? { cols: 1, rows: 1 }
    const width = design.plate.widthMm * grid.cols
    const height = design.plate.heightMm * grid.rows
    const margin = id === 't-title' ? BRAILLE_MM.dotDiameter / 2 : design.plate.marginMm
    const dx =
      movable.x.min < margin
        ? margin - movable.x.min
        : movable.x.max > width - margin
          ? width - margin - movable.x.max
          : 0
    const dy =
      movable.y.min < margin
        ? margin - movable.y.min
        : movable.y.max > height - margin
          ? height - margin - movable.y.max
          : 0
    return [movable.apply(dx, dy), ...relocationCandidates(design, context, id)]
  }

  if (violation.rule === 'seam-clearance') {
    const grid = design.grid ?? { cols: 1, rows: 1 }
    const id = violation.elementIds[0]
    const movable = id ? movableOf(design, id) : null
    if (!movable) return []
    const clear = SEAM_CLEARANCE_MM + EXTRA_CLEAR_MM
    for (let i = 1; i < grid.cols; i++) {
      const seam = design.plate.widthMm * i
      if (movable.x.min < seam + SEAM_CLEARANCE_MM && movable.x.max > seam - SEAM_CLEARANCE_MM) {
        candidates.push(movable.apply(seam - clear - movable.x.max, 0))
        candidates.push(movable.apply(seam + clear - movable.x.min, 0))
      }
    }
    for (let i = 1; i < grid.rows; i++) {
      const seam = design.plate.heightMm * i
      if (movable.y.min < seam + SEAM_CLEARANCE_MM && movable.y.max > seam - SEAM_CLEARANCE_MM) {
        candidates.push(movable.apply(0, seam - clear - movable.y.max))
        candidates.push(movable.apply(0, seam + clear - movable.y.min))
      }
    }
    return candidates
  }

  if (violation.rule === 'clearance') {
    const shortfall =
      (violation.requiredMm ?? 3) - (violation.measuredMm ?? 0) + EXTRA_CLEAR_MM
    // Several magnitudes per direction: the exact shortfall can land in a
    // fresh conflict (a parallel wall, another label) that a slightly
    // longer hop clears. Overlapping same-spot labels measure 0 mm apart
    // yet need a full element-extent hop to actually separate, so include
    // one magnitude sized to the largest involved element.
    const largestExtent = Math.max(
      ...violation.elementIds.map((id) => {
        const movable = movableOf(design, id)
        return movable
          ? Math.max(movable.x.max - movable.x.min, movable.y.max - movable.y.min)
          : 0
      }),
      0,
    )
    const magnitudes = [
      shortfall,
      shortfall + 2,
      shortfall + 5,
      shortfall + 10,
      shortfall + largestExtent,
    ]
    for (const id of violation.elementIds) {
      const movable = movableOf(design, id)
      if (!movable) continue
      const otherId = violation.elementIds.find((eid) => eid !== id)
      const other = design.elements.find((e) => e.id === otherId)
      const directions =
        other?.kind === 'line'
          ? closestSegmentPerpendiculars(design, other.id, movable.center)
          : other && (other.kind === 'braille' || other.kind === 'symbol')
            ? directionsAwayFrom(
                movableOf(design, other.id)?.center ?? movable.center,
                movable.center,
              )
            : []
      for (const direction of directions) {
        for (const magnitude of magnitudes) {
          candidates.push(
            movable.apply(direction.x * magnitude, direction.y * magnitude),
          )
        }
      }
      candidates.push(...relocationCandidates(design, context, id))
    }
    return candidates
  }

  if (violation.rule === 'label-fit' || violation.rule === 'source-anchor') {
    const id = violation.elementIds[0]
    return id ? relocationCandidates(design, context, id) : []
  }

  return []
}

/**
 * Greedily repairs margin, seam-clearance, label-fit, and pairwise-clearance violations with
 * exact arithmetic nudges, keeping only steps that lower the total
 * violation count. A violation gets one attempt per sweep, but a sweep
 * that improved anything earns the survivors a fresh sweep: an accepted
 * side-effect improvement must not permanently consume a violation's only
 * chance at its own fix. Anything still standing after the sweeps is left
 * for the layout agent.
 */
export function resolveMechanicalViolations(
  initial: TactileDesign,
  context: ValidationContext,
  deadline = performance.now() + 30_000,
): TactileDesign {
  // ponytail: synchronous work is bounded between candidates; use a worker for preemptive CPU isolation.
  const checkDeadline = () => {
    if (performance.now() >= deadline) {
      throw new Error('Tactile layout repair exceeded 30 seconds. Split this dense plan into smaller sections or reduce its detail, then try again.')
    }
  }
  let design = initial
  // Keep a finite cap for oscillating equal-count repairs, but allow a
  // still-improving coupled glyph/key placement to finish without an LLM.
  for (let sweep = 0; sweep < 6; sweep++) {
    const result = runRepairSweep(design, context, checkDeadline)
    design = result.design
    if (!result.improved) break
  }
  checkDeadline()
  return design
}

function runRepairSweep(
  initial: TactileDesign,
  context: ValidationContext,
  checkDeadline: () => void,
): { design: TactileDesign; improved: boolean } {
  checkDeadline()
  let design = initial
  let improved = false
  let violations = validateTactileDesign(design, context)
  const attempted = new Set<string>()
  for (let step = 0; step < initial.elements.length; step++) {
    const target = violations.find(v => v.rule === 'source-anchor' && !attempted.has(v.elementIds.join('|') + v.rule)) ?? violations.find(
      (v) =>
        (v.rule === 'margin' ||
          v.rule === 'seam-clearance' ||
          v.rule === 'clearance' ||
          v.rule === 'label-fit') &&
        !attempted.has(v.elementIds.join('|') + v.rule),
    )
    if (!target) break
    attempted.add(target.elementIds.join('|') + target.rule)

    let best: {
      design: TactileDesign
      targetResolved: boolean
      violations: ValidationViolation[]
    } | null = null
    for (const candidate of candidateMoves(design, context, target)) {
      checkDeadline()
      const candidateViolations = validateTactileMove(design, candidate, context, violations)
      if (introducesAnchorViolation(violations, candidateViolations)) continue
      const targetResolved = !candidateViolations.some(
        (violation) =>
          violation.rule === target.rule &&
          violation.elementIds.join('|') === target.elementIds.join('|'),
      )
      if (
        !best ||
        candidateViolations.length < best.violations.length ||
        (candidateViolations.length === best.violations.length &&
          targetResolved &&
          !best.targetResolved)
      ) {
        best = { design: candidate, targetResolved, violations: candidateViolations }
      }
    }
    if (
      best &&
      (best.violations.length < violations.length ||
        (best.violations.length === violations.length && best.targetResolved))
    ) {
      design = best.design
      // Restore complete rule order before selecting the next target; candidate scoring is unordered.
      violations = validateTactileDesign(design, context)
      improved = true
    }
  }
  return { design, improved }
}
