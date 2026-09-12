import { BRAILLE_MM, textBrailleSize } from './braille'
import { fitPositionsInPolygon, pointInPolygon, segmentsCross } from './fit'
import type { FloorModel, Point } from './schema'
import { planToPlateTransform, scaleRequirements } from './tactile-convert'
import {
  compositeSize,
  MAX_SYMBOL_SHIFT_MM,
  SEAM_CLEARANCE_MM,
  type BrailleLabel,
  type TactileArea,
  type TactileDesign,
  type TactileLine,
  type TactileSymbol,
  type ValidationViolation,
} from './tactile'

// Deterministic standards validator (Phase 8). Every rule from the standards
// table in docs/idea.md, measured in plate millimeters. Violations are hard
// fails: the design must reach zero before export.

export const CLEARANCE_MM = 3
export const SIMILAR_SYMBOL_CLEARANCE_MM = 6
export const MIN_SYMBOL_MM = 5
export const MIN_DOOR_OPENING_MM = 5

// Rules layout iteration can fix by moving braille/symbols; 'scale' cannot.
export const MOVABLE_RULES = [
  'clearance',
  'label-fit',
  'margin',
  'seam-clearance',
  'source-anchor',
] as const
export { SEAM_CLEARANCE_MM } from './tactile'
// Float tolerance for all mm comparisons, and the adjacency budget for
// keys labeling features too small to hold them.
const MEASURE_EPS_MM = 0.05
export const ADJACENT_LABEL_MM = 10

export type ValidationContext = {
  // Immutable source landmarks, independent of any proposed layout moves.
  symbolAnchorsMm: { id: string; at: Point; roomIds: string[] }[]
  // Scaled room polygons (mm), for the label-fit rule.
  roomsMm: { id: string; polygonMm: Point[] }[]
  // Scaled door opening widths (mm), for the legibility gate.
  doorOpeningsMm: { id: string; widthMm: number }[]
  scaleFeaturesMm: {
    id: string
    label: string
    requiredMm: number
    widthMm: number
  }[]
}

export function buildValidationContext(model: FloorModel, design?: TactileDesign): ValidationContext {
  const { mmPerPx, toMm, symbolClearances } = planToPlateTransform(model, design ? design.grid ?? { rows: 1, cols: 1 } : undefined)
  if (design && Math.abs(design.mmPerPx - mmPerPx) > 1e-8) {
    throw new Error('Tactile design scale does not match this floor model and plate grid; regenerate the design')
  }
  return {
    symbolAnchorsMm: model.features.map(feature => ({
      id: feature.id,
      at: toMm(feature.at),
      roomIds: model.rooms.filter(room => pointInPolygon(feature.at, room.polygon)).map(room => room.id),
    })),
    doorOpeningsMm: model.openings
      .filter((o) => o.kind === 'door')
      .map((o) => ({ id: o.id, widthMm: o.width * mmPerPx })),
    scaleFeaturesMm: [...symbolClearances, ...scaleRequirements(model).map((feature) => ({
      id: feature.id,
      label: feature.label,
      requiredMm: feature.requiredMm,
      widthMm: feature.widthPx * mmPerPx,
    }))],
    roomsMm: model.rooms.map((room) => ({
      id: room.id,
      polygonMm: room.polygon.map(toMm),
    })),
  }
}

type Rect = { maxX: number; maxY: number; minX: number; minY: number }

function brailleRect(label: BrailleLabel): Rect {
  const size = textBrailleSize(label.key)
  return {
    maxX: label.at.x + size.widthMm,
    maxY: label.at.y + size.heightMm,
    minX: label.at.x,
    minY: label.at.y,
  }
}


function distPointSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSq = abx * abx + aby * aby
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq),
        )
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
}

function distPointRect(p: Point, r: Rect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX)
  const dy = Math.max(r.minY - p.y, 0, p.y - r.maxY)
  return Math.hypot(dx, dy)
}

function rectCorners(r: Rect): Point[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ]
}

function rectRectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(a.minX - b.maxX, 0, b.minX - a.maxX)
  const dy = Math.max(a.minY - b.maxY, 0, b.minY - a.maxY)
  return Math.hypot(dx, dy)
}

// Corner/endpoint distances suffice only when the segment does not cross the rectangle.
function rectSegmentDistance(r: Rect, a: Point, b: Point): number {
  const corners = rectCorners(r)
  if (corners.some((corner, i) => segmentsCross(corner, corners[(i + 1) % 4]!, a, b))) return 0
  const cornerToSeg = Math.min(
    ...corners.map((c) => distPointSegment(c, a, b)),
  )
  const endToRect = Math.min(distPointRect(a, r), distPointRect(b, r))
  return Math.min(cornerToSeg, endToRect)
}

function lineSegments(line: TactileLine): [Point, Point][] {
  const segments: [Point, Point][] = []
  for (let i = 0; i < line.points.length - 1; i++) {
    segments.push([line.points[i]!, line.points[i + 1]!])
  }
  return segments
}

function symbolLineDistance(symbol: TactileSymbol, line: TactileLine): number {
  const min = Math.min(
    ...lineSegments(line).map(([a, b]) => distPointSegment(symbol.at, a, b)),
  )
  return min - symbol.sizeMm / 2 - line.widthMm / 2
}

/** Clearance improvements must never introduce new source-location failures. */
export function introducesAnchorViolation(before: ValidationViolation[], after: ValidationViolation[]): boolean {
  const existing = new Set(before.filter(v => v.rule === 'source-anchor').flatMap(v => v.elementIds))
  return after.some(v => v.rule === 'source-anchor' && v.elementIds.some(id => !existing.has(id)))
}

function brailleLineDistance(rect: Rect, line: TactileLine): number {
  const min = Math.min(
    ...lineSegments(line).map(([a, b]) => rectSegmentDistance(rect, a, b)),
  )
  return min - line.widthMm / 2
}

export function validateTactileDesign(
  design: TactileDesign,
  context: ValidationContext,
): ValidationViolation[] {
  return validateRules(design, context)
}

/** Internal candidateMoves contract: one moved label/symbol, shared static geometry and context.
 * Candidate order is irrelevant to scoring; accepted states get full validation in rule order. */
export function validateTactileMove(
  previous: TactileDesign,
  candidate: TactileDesign,
  context: ValidationContext,
  previousViolations: ValidationViolation[],
): ValidationViolation[] {
  const changed = candidate.elements.filter((element, index) => element !== previous.elements[index])
  const moved = changed[0]
  if (changed.length !== 1 || !moved || (moved.kind !== 'braille' && moved.kind !== 'symbol')) {
    throw new Error('Mechanical validation requires one moved braille label or symbol')
  }
  const affected = new Set([moved.id])
  // A key's label-fit finding names only the key, but depends on its symbol's position.
  if (moved.kind === 'symbol' && moved.sourceId) {
    for (const element of candidate.elements) {
      if (element.kind === 'braille' && element.sourceId === moved.sourceId) affected.add(element.id)
    }
  }
  return [
    ...previousViolations.filter(violation => !violation.elementIds.some(id => affected.has(id))),
    ...validateRules(candidate, context, affected),
  ]
}

function validateRules(
  design: TactileDesign,
  context: ValidationContext,
  affected?: ReadonlySet<string>,
): ValidationViolation[] {
  const active = (element: { id: string }) => !affected || affected.has(element.id)
  const violations: ValidationViolation[] = []
  const { marginMm } = design.plate
  const { heightMm, widthMm } = compositeSize(design)
  const grid = design.grid ?? { cols: 1, rows: 1 }
  const symbols = design.elements.filter(
    (e): e is TactileSymbol => e.kind === 'symbol',
  )
  const labels = design.elements.filter(
    (e): e is BrailleLabel => e.kind === 'braille',
  )
  const lines = design.elements.filter(
    (e): e is TactileLine => e.kind === 'line',
  )
  const areas = design.elements.filter(
    (e): e is TactileArea => e.kind === 'area',
  )
  // Reuse bounds within this validation only: repair candidates move labels.
  // Bounding boxes are conservative; nearby pairs still get exact geometry.
  const labelRects = new Map(labels.map(label => [label, brailleRect(label)]))
  const lineRects = new Map(lines.map(line => {
    const xs = line.points.map(p => p.x), ys = line.points.map(p => p.y)
    const half = line.widthMm / 2
    return [line, { minX: Math.min(...xs) - half, maxX: Math.max(...xs) + half,
      minY: Math.min(...ys) - half, maxY: Math.max(...ys) + half }]
  }))

  for (const symbol of symbols) {
    if (!active(symbol)) continue
    const anchor = context.symbolAnchorsMm.find(point => point.id === symbol.sourceId)
    if (!anchor) continue // North and symbols without a floor-model feature have no source anchor.
    const distance = Math.hypot(symbol.at.x - anchor.at.x, symbol.at.y - anchor.at.y)
    const boundaryMarker = ['door', 'entrance', 'exit', 'ramp'].includes(symbol.symbol)
    const crossed = !boundaryMarker && lines.some(line => line.style === 'solid'
      && lineSegments(line).some(([a, b]) => segmentsCross(anchor.at, symbol.at, a, b)))
    const leftRoom = !boundaryMarker && anchor.roomIds.some(id => {
      const room = context.roomsMm.find(room => room.id === id)
      return room && !pointInPolygon(symbol.at, room.polygonMm)
    })
    if (distance > MAX_SYMBOL_SHIFT_MM + MEASURE_EPS_MM || crossed || leftRoom) {
      violations.push({
        rule: 'source-anchor', elementIds: [symbol.id], measuredMm: distance,
        requiredMm: MAX_SYMBOL_SHIFT_MM,
        message: `${symbol.id} left its source location: ${distance.toFixed(1)} mm displacement${crossed ? ', crosses a wall' : ''}${leftRoom ? ', leaves its source room' : ''}; keep within ${MAX_SYMBOL_SHIFT_MM} mm and on the same side of walls`,
      })
    }
  }

  // Legibility gate: unfixable by layout — the floor is too big for the plate.
  for (const feature of affected ? [] : context.scaleFeaturesMm) {
    if (feature.widthMm < feature.requiredMm) {
      violations.push({
        elementIds: [feature.id],
        measuredMm: feature.widthMm,
        message: `${feature.label} ${feature.id} prints at ${feature.widthMm.toFixed(1)} mm — map too large even for the selected grid; split it or simplify`,
        requiredMm: feature.requiredMm,
        rule: 'scale',
      })
    }
  }

  // Plate margins.
  const inMargin = (r: Rect, insetMm = marginMm) =>
    r.minX >= insetMm &&
    r.minY >= insetMm &&
    r.maxX <= widthMm - insetMm &&
    r.maxY <= heightMm - insetMm
  for (const symbol of symbols) {
    if (!active(symbol)) continue
    const half = symbol.sizeMm / 2
    if (
      !inMargin({
        maxX: symbol.at.x + half,
        maxY: symbol.at.y + half,
        minX: symbol.at.x - half,
        minY: symbol.at.y - half,
      })
    ) {
      violations.push({
        elementIds: [symbol.id],
        measuredMm: null,
        message: `Symbol ${symbol.id} lies outside the plate margin`,
        requiredMm: marginMm,
        rule: 'margin',
      })
    }
  }
  for (const label of labels) {
    if (!active(label)) continue
    // Titles may use the header margin, never space outside the base slab.
    const insetMm = label.id === 't-title' ? BRAILLE_MM.dotDiameter / 2 : marginMm
    if (!inMargin(labelRects.get(label)!, insetMm)) {
      violations.push({
        elementIds: [label.id],
        measuredMm: null,
        message: `Braille ${label.id} lies outside the plate margin`,
        requiredMm: insetMm,
        rule: 'margin',
      })
    }
  }
  for (const area of affected ? [] : areas) {
    const xs = area.polygon.map((p) => p.x)
    const ys = area.polygon.map((p) => p.y)
    if (
      !inMargin({
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        minX: Math.min(...xs),
        minY: Math.min(...ys),
      })
    ) {
      violations.push({
        elementIds: [area.id],
        measuredMm: null,
        message: `Block ${area.id} lies outside the plate margin`,
        requiredMm: marginMm,
        rule: 'margin',
      })
    }
  }

  // Minimum symbol size.
  for (const symbol of symbols) {
    if (!active(symbol)) continue
    if (symbol.sizeMm < MIN_SYMBOL_MM) {
      violations.push({
        elementIds: [symbol.id],
        measuredMm: symbol.sizeMm,
        message: `Symbol ${symbol.id} is ${symbol.sizeMm.toFixed(1)} mm — below the ${MIN_SYMBOL_MM} mm minimum`,
        requiredMm: MIN_SYMBOL_MM,
        rule: 'symbol-size',
      })
    }
  }

  // Pairwise clearance.
  const pushClearance = (
    aId: string,
    bId: string,
    measured: number,
    required: number,
  ) => {
    // Float tolerance: 2.9999 of scaled geometry is a met 3 mm rule.
    if (measured < required - MEASURE_EPS_MM) {
      violations.push({
        elementIds: [aId, bId],
        measuredMm: Math.max(0, measured),
        message: `${aId} and ${bId} are ${Math.max(0, measured).toFixed(1)} mm apart — minimum is ${required} mm`,
        requiredMm: required,
        rule: 'clearance',
      })
    }
  }
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i]!
      const b = symbols[j]!
      if (!active(a) && !active(b)) continue
      const gap =
        Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) -
        a.sizeMm / 2 -
        b.sizeMm / 2
      const required =
        a.symbol === b.symbol ? SIMILAR_SYMBOL_CLEARANCE_MM : CLEARANCE_MM
      pushClearance(a.id, b.id, gap, required)
    }
  }
  for (const symbol of symbols) {
    for (const label of labels) {
      if (!active(symbol) && !active(label)) continue
      const gap =
        distPointRect(symbol.at, labelRects.get(label)!) - symbol.sizeMm / 2
      pushClearance(symbol.id, label.id, gap, CLEARANCE_MM)
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (!active(labels[i]!) && !active(labels[j]!)) continue
      const gap = rectRectDistance(
        labelRects.get(labels[i]!)!,
        labelRects.get(labels[j]!)!,
      )
      pushClearance(labels[i]!.id, labels[j]!.id, gap, CLEARANCE_MM)
    }
  }
  for (const label of labels) {
    if (!active(label)) continue
    const rect = labelRects.get(label)!
    for (const line of lines) {
      if (rectRectDistance(rect, lineRects.get(line)!) >= CLEARANCE_MM - MEASURE_EPS_MM) continue
      pushClearance(
        label.id,
        line.id,
        brailleLineDistance(rect, line),
        CLEARANCE_MM,
      )
    }
  }
  for (const symbol of symbols) {
    if (!active(symbol)) continue
    // Door thresholds sit on their wall by definition; entrance/exit
    // arrows and entrance ramps mark boundary crossings, and real maps
    // (Muckenthaler, QMH) draw them touching the boundary line.
    if (
      symbol.symbol === 'door' ||
      symbol.symbol === 'entrance' ||
      symbol.symbol === 'exit' ||
      symbol.symbol === 'ramp'
    ) {
      continue
    }
    for (const line of lines) {
      if (distPointRect(symbol.at, lineRects.get(line)!) - symbol.sizeMm / 2 >= CLEARANCE_MM - MEASURE_EPS_MM) continue
      pushClearance(
        symbol.id,
        line.id,
        symbolLineDistance(symbol, line),
        CLEARANCE_MM,
      )
    }
  }

  // Seam clearance: braille and point symbols must never straddle (or
  // crowd) the joints between plates — a split braille cell is gibberish.
  // Walls and areas may cross seams; they slice cleanly.
  const seamsX = Array.from({ length: grid.cols - 1 }, (_, i) => design.plate.widthMm * (i + 1))
  const seamsY = Array.from({ length: grid.rows - 1 }, (_, i) => design.plate.heightMm * (i + 1))
  const seamViolation = (id: string, measured: number) => {
    violations.push({
      elementIds: [id],
      measuredMm: Math.max(0, measured),
      message: `${id} is ${Math.max(0, measured).toFixed(1)} mm from a plate seam — keep braille and symbols at least ${SEAM_CLEARANCE_MM} mm clear`,
      requiredMm: SEAM_CLEARANCE_MM,
      rule: 'seam-clearance',
    })
  }
  for (const label of labels) {
    if (!active(label)) continue
    const rect = labelRects.get(label)!
    for (const sx of seamsX) {
      const d = rect.minX < sx && rect.maxX > sx ? 0 : Math.min(Math.abs(rect.minX - sx), Math.abs(rect.maxX - sx))
      if (d < SEAM_CLEARANCE_MM - MEASURE_EPS_MM) seamViolation(label.id, d)
    }
    for (const sy of seamsY) {
      const d = rect.minY < sy && rect.maxY > sy ? 0 : Math.min(Math.abs(rect.minY - sy), Math.abs(rect.maxY - sy))
      if (d < SEAM_CLEARANCE_MM - MEASURE_EPS_MM) seamViolation(label.id, d)
    }
  }
  for (const symbol of symbols) {
    if (!active(symbol)) continue
    for (const sx of seamsX) {
      const d = Math.abs(symbol.at.x - sx) - symbol.sizeMm / 2
      if (d < SEAM_CLEARANCE_MM - MEASURE_EPS_MM) seamViolation(symbol.id, d)
    }
    for (const sy of seamsY) {
      const d = Math.abs(symbol.at.y - sy) - symbol.sizeMm / 2
      if (d < SEAM_CLEARANCE_MM - MEASURE_EPS_MM) seamViolation(symbol.id, d)
    }
  }

  // Label-fit: a room's braille key must sit inside that room, and a
  // block's key inside its block. (Note: braille on a block is exempt from
  // block clearance by construction — height differentiation separates them.)
  const roomById = new Map(context.roomsMm.map((room) => [room.id, room]))
  const areasBySource = new Map<string, TactileArea[]>()
  for (const area of areas) {
    if (!area.sourceId) continue
    const sourceAreas = areasBySource.get(area.sourceId) ?? []
    sourceAreas.push(area)
    areasBySource.set(area.sourceId, sourceAreas)
  }
  for (const label of labels) {
    if (!active(label)) continue
    if (!label.sourceId) continue
    const rect = labelRects.get(label)!
    const sourceSymbol = symbols.find((symbol) => symbol.sourceId === label.sourceId)
    if (sourceSymbol) {
      const gap = Math.max(0, distPointRect(sourceSymbol.at, rect) - sourceSymbol.sizeMm / 2)
      const center = { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 }
      const crossed = lines.some((line) => line.style === 'solid'
        && lineSegments(line).some(([a, b]) => segmentsCross(sourceSymbol.at, center, a, b)))
      if (gap > ADJACENT_LABEL_MM + MEASURE_EPS_MM || crossed) {
        violations.push({
          elementIds: [label.id], measuredMm: gap, requiredMm: ADJACENT_LABEL_MM, rule: 'label-fit',
          message: `Braille key for ${label.sourceId} must remain within ${ADJACENT_LABEL_MM} mm of its symbol and on the same side of walls${crossed ? ' (crosses a wall)' : ''}`,
        })
      }
      continue
    }
    const room = roomById.get(label.sourceId)
    const sourceAreas = areasBySource.get(label.sourceId) ?? []
    const polygons =
      sourceAreas.length > 0
        ? sourceAreas.map((area) => area.polygon)
        : room
          ? [room.polygonMm]
          : []
    if (polygons.length === 0) continue
    const fits = polygons.some((polygon) =>
      rectCorners(rect).every((corner) => pointInPolygon(corner, polygon)),
    )
    if (fits) continue
    // A feature that can never hold its key (too small, or a thin
    // diagonal sliver whose bbox is deceptively large) takes an adjacent
    // label instead — the convention on real tactile maps.
    const keyW = rect.maxX - rect.minX
    const keyH = rect.maxY - rect.minY
    const bounds = polygons.map((polygon) => {
      const xs = polygon.map((p) => p.x)
      const ys = polygon.map((p) => p.y)
      return {
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        minX: Math.min(...xs),
        minY: Math.min(...ys),
      }
    })
    const canEverFit = polygons.some((polygon, index) =>
      fitPositionsInPolygon(
        keyW + 1,
        keyH + 1,
        polygon,
        {
          x: (bounds[index]!.minX + bounds[index]!.maxX) / 2,
          y: (bounds[index]!.minY + bounds[index]!.maxY) / 2,
        },
        40,
      ).some((center) => {
        const candidate: Rect = {
          maxX: center.x + keyW / 2,
          maxY: center.y + keyH / 2,
          minX: center.x - keyW / 2,
          minY: center.y - keyH / 2,
        }
        const clearsSeams =
          seamsX.every(
            (seam) =>
              candidate.maxX <= seam - SEAM_CLEARANCE_MM ||
              candidate.minX >= seam + SEAM_CLEARANCE_MM,
          ) &&
          seamsY.every(
            (seam) =>
              candidate.maxY <= seam - SEAM_CLEARANCE_MM ||
              candidate.minY >= seam + SEAM_CLEARANCE_MM,
          )
        return inMargin(candidate) && clearsSeams && lines.every(
          (line) =>
            Math.min(
              ...lineSegments(line).map(([a, b]) =>
                rectSegmentDistance(candidate, a, b),
              ),
            ) -
              line.widthMm / 2 >=
            CLEARANCE_MM - MEASURE_EPS_MM,
        )
      }),
    )
    if (!canEverFit) {
      const gap = Math.min(...bounds.map((areaBounds) => rectRectDistance(rect, areaBounds)))
      if (gap <= ADJACENT_LABEL_MM + MEASURE_EPS_MM) continue
      violations.push({
        elementIds: [label.id],
        measuredMm: gap,
        message: `Braille key for ${label.sourceId} is ${gap.toFixed(1)} mm away — it is too small to label inside, so keep the key within ${ADJACENT_LABEL_MM} mm of it`,
        requiredMm: ADJACENT_LABEL_MM,
        rule: 'label-fit',
      })
      continue
    }
    violations.push({
      elementIds: [label.id],
      measuredMm: null,
      message: sourceAreas.length > 0
        ? `Braille key for block ${label.sourceId} does not fit inside the block`
        : `Braille key for room ${label.sourceId} does not fit inside the room`,
      requiredMm: null,
      rule: 'label-fit',
    })
  }

  return violations
}
