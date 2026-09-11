import { Resvg } from '@resvg/resvg-js'
import * as mupdf from 'mupdf'
import { isBlockPlan, type FloorModel } from '@bumps/floor-model'

// Pixel-level completeness check, no model calls: rasterize the source
// plan's dark linework and subtract everything the extracted model
// accounts for (with generous dilation). Dense leftover regions are where
// the parser most likely missed structure. The result is advisory — text,
// dimension strings, and hatching also leave ink — so regions are handed
// to the critique agent as attention hints, never applied directly.

const ANALYSIS_WIDTH = 512
const SOURCE_INK_LUMINANCE = 118
const MODEL_INK_LUMINANCE = 128
const CELL_PX = 16
// A cell is suspicious when uncovered ink fills enough of it and most of
// that cell's ink is unaccounted for.
const CELL_UNCOVERED_SHARE = 0.05
const CELL_UNCOVERED_OF_INK = 0.5
const MAX_REGIONS = 5
// Plan-space dilation around extracted strokes: drawn symbols (door arcs,
// stair rungs) hug their element without being traced by it.
const PAD_PX = 12
const WALL_SAMPLES = 32
const MIN_UNSUPPORTED_MIDDLE_RUN = WALL_SAMPLES / 2

export type CoverageRegion = {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type CoverageReport = {
  /** Share of the source's dark linework covered by extracted geometry. */
  coveredInkRatio: number
  regions: CoverageRegion[]
  /** Low dark-ink support is an attention hint, not proof that a wall is fake. */
  unsupportedWalls: { elementId: string; at: { x: number; y: number }; supportRatio: number }[]
  /** Short source-ink connections hidden by the generous coverage dilation. */
  missingConnections: { at: { x: number; y: number }; wallIds: string[] }[]
}

type Mask = { data: Uint8Array; height: number; width: number }

function sourceInkMask(bytes: Uint8Array, mimeType: string): Mask {
  const doc = mupdf.Document.openDocument(bytes, mimeType)
  try {
    const page = doc.loadPage(0)
    const [x0, , x1] = page.getBounds()
    const zoom = ANALYSIS_WIDTH / Math.max(1, x1 - x0)
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(zoom, zoom),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    try {
      const pixels = pixmap.getPixels()
      const width = pixmap.getWidth()
      const height = pixmap.getHeight()
      const components = Math.max(1, Math.round(pixels.length / (width * height)))
      const data = new Uint8Array(width * height)
      for (let i = 0; i < width * height; i++) {
        const offset = i * components
        const luminance =
          components >= 3
            ? 0.299 * pixels[offset]! +
              0.587 * pixels[offset + 1]! +
              0.114 * pixels[offset + 2]!
            : pixels[offset]!
        data[i] = luminance < SOURCE_INK_LUMINANCE ? 1 : 0
      }
      return { data, height, width }
    } finally {
      pixmap.destroy()
      page.destroy()
    }
  } finally {
    doc.destroy()
  }
}

/** Everything the model accounts for, drawn fat so nearby symbol ink counts. */
function coverageSvg(model: FloorModel): string {
  const { heightPx, widthPx } = model.plan
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}">`,
    `<rect width="${widthPx}" height="${heightPx}" fill="white"/>`,
  ]
  const points = (list: { x: number; y: number }[]) =>
    list.map((p) => `${p.x},${p.y}`).join(' ')
  for (const road of model.roads ?? []) {
    parts.push(
      `<polyline points="${points(road.points)}" fill="none" stroke="black" stroke-width="${road.widthPx + PAD_PX}" stroke-linecap="butt" stroke-linejoin="round"/>`,
    )
  }
  // Rooms cover source ink only on block-plans, where footprints become
  // raised blocks. On walled floor plans the room boundary must be covered
  // by extracted walls — a room outline standing in for a missed wall
  // would hide exactly the loss this check exists to catch.
  if (isBlockPlan(model)) {
    for (const room of model.rooms) {
      parts.push(
        `<polygon points="${points(room.polygon)}" fill="black" stroke="black" stroke-width="${PAD_PX}"/>`,
      )
    }
  }
  for (const item of model.furniture ?? []) {
    parts.push(
      `<polygon points="${points(item.polygon)}" fill="black" stroke="black" stroke-width="${PAD_PX}"/>`,
    )
  }
  for (const path of model.paths ?? []) {
    parts.push(
      `<polyline points="${points(path.points)}" fill="none" stroke="black" stroke-width="${PAD_PX + 4}" stroke-linecap="round"/>`,
    )
  }
  for (const wall of model.walls) {
    parts.push(
      `<line x1="${wall.a.x}" y1="${wall.a.y}" x2="${wall.b.x}" y2="${wall.b.y}" stroke="black" stroke-width="${wall.thickness + PAD_PX}" stroke-linecap="round"/>`,
    )
  }
  for (const opening of model.openings) {
    // Door leaves and swing arcs are drawn up to a door-width away from
    // the wall gap they belong to.
    parts.push(
      `<circle cx="${opening.at.x}" cy="${opening.at.y}" r="${opening.width + PAD_PX}" fill="black"/>`,
    )
  }
  for (const feature of model.features) {
    parts.push(
      `<rect x="${feature.at.x - 24}" y="${feature.at.y - 24}" width="48" height="48" fill="black"/>`,
    )
  }
  parts.push('</svg>')
  return parts.join('\n')
}

function modelInkMask(model: FloorModel, width: number): Mask {
  const rendered = new Resvg(coverageSvg(model), {
    fitTo: { mode: 'width', value: width },
  }).render()
  const pixels = rendered.pixels
  const data = new Uint8Array(rendered.width * rendered.height)
  for (let i = 0; i < data.length; i++) {
    const offset = i * 4
    const luminance =
      0.299 * pixels[offset]! + 0.587 * pixels[offset + 1]! + 0.114 * pixels[offset + 2]!
    data[i] = luminance < MODEL_INK_LUMINANCE ? 1 : 0
  }
  return { data, height: rendered.height, width: rendered.width }
}

// Sample wall interiors in the opposite direction: an invented line through
// blank floor cannot be detected by subtracting model coverage from source ink.
function unsupportedWalls(source: Mask, model: FloorModel): CoverageReport['unsupportedWalls'] {
  const scaleX = source.width / model.plan.widthPx
  const scaleY = source.height / model.plan.heightPx
  // Rectangle sums keep each sample constant-time even if inference supplies
  // an enormous wall thickness; never scan its entire neighborhood per wall.
  const stride = source.width + 1
  const ink = new Uint32Array(stride * (source.height + 1))
  for (let y = 0; y < source.height; y++) {
    let row = 0
    for (let x = 0; x < source.width; x++) {
      row += source.data[y * source.width + x]!
      ink[(y + 1) * stride + x + 1] = ink[y * stride + x + 1]! + row
    }
  }
  const findings: CoverageReport['unsupportedWalls'] = []
  for (const wall of model.walls) {
    if (Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) < 24) continue
    const radiusX = Math.max(1, Math.ceil((wall.thickness / 2 + 6) * scaleX))
    const radiusY = Math.max(1, Math.ceil((wall.thickness / 2 + 6) * scaleY))
    let supported = 0
    let unsupportedRun = 0
    let hasUnsupportedMiddleRun = false
    for (let i = 0; i < WALL_SAMPLES; i++) {
      const t = 0.1 + 0.8 * i / (WALL_SAMPLES - 1)
      const x = Math.round((wall.a.x + (wall.b.x - wall.a.x) * t) * scaleX)
      const y = Math.round((wall.a.y + (wall.b.y - wall.a.y) * t) * scaleY)
      const x0 = Math.max(0, Math.min(source.width, x - radiusX))
      const x1 = Math.max(0, Math.min(source.width, x + radiusX + 1))
      const y0 = Math.max(0, Math.min(source.height, y - radiusY))
      const y1 = Math.max(0, Math.min(source.height, y + radiusY + 1))
      if (ink[y1 * stride + x1]! - ink[y0 * stride + x1]!
        - ink[y1 * stride + x0]! + ink[y0 * stride + x0]! > 0) {
        supported++
        unsupportedRun = 0
      } else {
        unsupportedRun++
        const runStart = i - unsupportedRun + 1
        hasUnsupportedMiddleRun ||= (
          unsupportedRun >= MIN_UNSUPPORTED_MIDDLE_RUN &&
          runStart < WALL_SAMPLES / 2 &&
          i >= WALL_SAMPLES / 2
        )
      }
    }
    const supportRatio = supported / WALL_SAMPLES
    // A short invented wall can borrow ink from valid junctions at both ends,
    // clearing the aggregate threshold while its middle remains blank. Require
    // a half-wall uninterrupted gap before flagging this separate advisory.
    if (supportRatio < 0.2 || hasUnsupportedMiddleRun) findings.push({
      elementId: wall.id,
      at: { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 },
      supportRatio,
    })
  }
  return findings.sort((a, b) => a.supportRatio - b.supportRatio).slice(0, MAX_REGIONS)
}

// Dilation can cover a missing short return entirely. Inspect narrow endpoint
// gaps against undilated source pixels; this is a review hint, never an auto-join.
function missingConnections(source: Mask, model: FloorModel): CoverageReport['missingConnections'] {
  const ends = model.walls.flatMap(wall => [wall.a, wall.b].map(at => ({ at, wall })))
  const findings: CoverageReport['missingConnections'] = []
  // ponytail: inspect at most 256 nearby pairs; use spatial indexing if dense
  // plans need exhaustive hints. Full visual review is never replaced by these.
  let examined = 0
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const a = ends[i]!, b = ends[j]!
    if (a.wall.id === b.wall.id) continue
    const distance = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y)
    const thickness = Math.max(a.wall.thickness, b.wall.thickness)
    if (distance <= thickness + 2 || distance > Math.min(3 * thickness, 40)) continue
    if (++examined > 256) return findings
    const at = { x: (a.at.x + b.at.x) / 2, y: (a.at.y + b.at.y) / 2 }
    if (findings.some(f => Math.hypot(f.at.x - at.x, f.at.y - at.y) < thickness)) continue
    let supported = 0
    for (let k = 0; k < 12; k++) {
      const t = 0.2 + 0.6 * k / 11
      const x = Math.floor((a.at.x + (b.at.x - a.at.x) * t) * source.width / model.plan.widthPx)
      const y = Math.floor((a.at.y + (b.at.y - a.at.y) * t) * source.height / model.plan.heightPx)
      if (x >= 0 && x < source.width && y >= 0 && y < source.height && source.data[y * source.width + x]) supported++
    }
    if (supported < 11) continue
    if (model.openings.some(o => Math.hypot(o.at.x - at.x, o.at.y - at.y) <= o.width / 2)) continue
    // An existing segment connecting these endpoints already accounts for ink.
    if (model.walls.some(w =>
      ((Math.hypot(w.a.x - a.at.x, w.a.y - a.at.y) < 2 && Math.hypot(w.b.x - b.at.x, w.b.y - b.at.y) < 2) ||
       (Math.hypot(w.b.x - a.at.x, w.b.y - a.at.y) < 2 && Math.hypot(w.a.x - b.at.x, w.a.y - b.at.y) < 2)))) continue
    findings.push({ at, wallIds: [a.wall.id, b.wall.id] })
    if (findings.length >= MAX_REGIONS) return findings
  }
  return findings
}

/**
 * Compares the source plan's dark linework against the extracted model
 * and returns the densest uncovered regions (plan pixel space) plus the
 * overall covered-ink ratio.
 */
export function computeInkCoverage(
  planBytes: Uint8Array,
  mimeType: string,
  model: FloorModel,
): CoverageReport {
  const source = sourceInkMask(planBytes, mimeType)
  const covered = modelInkMask(model, source.width)
  const width = Math.min(source.width, covered.width)
  const height = Math.min(source.height, covered.height)

  const cols = Math.ceil(width / CELL_PX)
  const rows = Math.ceil(height / CELL_PX)
  const cellInk = new Float64Array(cols * rows)
  const cellUncovered = new Float64Array(cols * rows)
  let inkTotal = 0
  let coveredTotal = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!source.data[y * source.width + x]) continue
      inkTotal += 1
      const cell = Math.floor(y / CELL_PX) * cols + Math.floor(x / CELL_PX)
      cellInk[cell] += 1
      if (covered.data[y * covered.width + x]) coveredTotal += 1
      else cellUncovered[cell] += 1
    }
  }
  const coveredInkRatio = inkTotal === 0 ? 1 : coveredTotal / inkTotal

  const flagged = new Set<number>()
  for (let cell = 0; cell < cols * rows; cell++) {
    const uncovered = cellUncovered[cell]!
    if (
      uncovered / (CELL_PX * CELL_PX) >= CELL_UNCOVERED_SHARE &&
      uncovered >= CELL_UNCOVERED_OF_INK * cellInk[cell]!
    ) {
      flagged.add(cell)
    }
  }

  // Cluster flagged cells (4-neighborhood) into bounding regions.
  const scale = model.plan.widthPx / width
  const clusters: { mass: number; region: CoverageRegion }[] = []
  const seen = new Set<number>()
  for (const start of flagged) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    let mass = 0
    let cx0 = cols
    let cy0 = rows
    let cx1 = -1
    let cy1 = -1
    while (queue.length > 0) {
      const cell = queue.pop()!
      const col = cell % cols
      const row = Math.floor(cell / cols)
      mass += cellUncovered[cell]!
      cx0 = Math.min(cx0, col)
      cy0 = Math.min(cy0, row)
      cx1 = Math.max(cx1, col)
      cy1 = Math.max(cy1, row)
      for (const next of [cell - 1, cell + 1, cell - cols, cell + cols]) {
        if (seen.has(next) || !flagged.has(next)) continue
        const nextCol = next % cols
        if (Math.abs(nextCol - col) > 1) continue // row wrap
        seen.add(next)
        queue.push(next)
      }
    }
    clusters.push({
      mass,
      region: {
        x0: Math.round(cx0 * CELL_PX * scale),
        x1: Math.round(Math.min((cx1 + 1) * CELL_PX, width) * scale),
        y0: Math.round(cy0 * CELL_PX * scale),
        y1: Math.round(Math.min((cy1 + 1) * CELL_PX, height) * scale),
      },
    })
  }
  clusters.sort((a, b) => b.mass - a.mass)
  return {
    coveredInkRatio,
    regions: clusters.slice(0, MAX_REGIONS).map((c) => c.region),
    unsupportedWalls: unsupportedWalls(source, model),
    missingConnections: missingConnections(source, model),
  }
}
