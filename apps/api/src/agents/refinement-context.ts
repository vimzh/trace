// Focused visual evidence and write boundaries for source-grounded repair proposals.
import { isDeepStrictEqual } from 'node:util'
import { Resvg } from '@resvg/resvg-js'
import { allElements, renderFloorTopologyOverlaySvg, type FloorModel } from '@bumps/floor-model'
import { cropPlanImage } from '../lib/rasterize'
import type { MessagePart } from './llm'
import type { SourceInventory } from './source-reader'
import { FOCUSED_VIEW_MAX_PX, refinementElementBounds, type RefinementFocus } from './refinement-focus'

export const FOCUSED_REFINEMENT_INSTRUCTION = `Repair the reported defects in ONE part of a tactile-map extraction. This is not a new extraction or a whole-plan search. Use the full overview only for orientation and drawing conventions; inspect the paired magnified SOURCE and current TOPOLOGY OVERLAY for the actual correction. Coordinates always remain FULL PLAN pixels, never enlarged-crop coordinates.

The overlay uses red walls, cyan doors, blue windows, green room outlines and violet furniture outlines. Overlay geometry and review claims are hypotheses, not source evidence.

For each reported defect, identify the source stroke's endpoints/turns, adjacent opening and negative space before deciding what to change. When an existing segment already follows the source, keep it. Do not shift a wall merely to act on a vague complaint. If the source is ambiguous, do not invent a repair; retain uncertainty for the subsequent whole-plan reviewer.

Keep physical wall joins and short L/U/T returns continuous. Follow a drawn curve with connected short segments, never a chord. Glazed spans are physical boundaries and need supporting wall geometry, not an open passage. A room-color change, fixture icon, swing arc or decorative frame is not a wall. A real passage requires visible wall-ended gap/door evidence, not an assumption that every room needs access.

When removing a false opening, restore any source-visible wall span too: deleting the opening record alone does not fill separated wall ends. If an adjacent wall is read-only, add a separate local connector along the missing source stroke instead of rewriting that anchor. Join its endpoints exactly; do not overlap or extend into a real passage. Conversely, preserve genuine passages and their precise centers/widths. Retain visible perimeter strokes at image edges without closing blank cropped approaches.

Preserve named destinations, accessibility qualifiers, source-evidenced facilities and distinct navigation landmarks. Trace furniture banks tightly around their visible outline while retaining transverse and side aisles; skip incidental device icons, individual toilet/sink fixtures and decoration. Keep structural privacy partitions beside those fixtures.

Return only a PATCH: complete changed/new records in their arrays, empty arrays for unaffected classes, and removeIds for explicit deletions. Keep existing IDs. Only the listed writable IDs may change; other supplied records are read-only connection/context anchors. New IDs must use the supplied unique prefix and new geometry must stay inside the focus bounds. Do not alter title or north. Do not redraw a whole neighboring room to repair a local boundary. If a finding would require changing a read-only anchor outside these bounds, leave it unresolved rather than guessing or silently widening your authority. A later whole-plan review must verify the merged result.`

export function isFullPlanFocus(focus: RefinementFocus): boolean {
  return focus.bounds.x0 === 0 && focus.bounds.y0 === 0
    && focus.bounds.x1 === focus.model.plan.widthPx && focus.bounds.y1 === focus.model.plan.heightPx
}

export function prepareRefinementImages(model: FloorModel, source: { data: string; mimeType: string }) {
  const bytes = Buffer.from(source.data, 'base64')
  const overview = cropPlanImage(bytes, source.mimeType, { left: 0, top: 0, width: 1, height: 1 }, 800)
  const overlay = new Resvg(renderFloorTopologyOverlaySvg(model, `data:${source.mimeType};base64,${source.data}`))
    .render().asPng()
  return { bytes, mimeType: source.mimeType, overview, overlay }
}

export function focusedRefinementParts(
  focus: RefinementFocus,
  images: ReturnType<typeof prepareRefinementImages>,
  inventory?: SourceInventory,
): MessagePart[] {
  const { x0, y0, x1, y1 } = focus.bounds
  const { widthPx, heightPx } = focus.model.plan
  const inside = ({ x, y }: { x: number; y: number }) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  const localInventory = inventory && { ...inventory,
    landmarks: inventory.landmarks.filter(item => inside(item.at)),
    openConnections: inventory.openConnections.filter(item => inside(item.at)),
    structuralDetails: inventory.structuralDetails.filter(item => inside(item.at)),
  }
  const parts: MessagePart[] = [
    { text: `FULL PLAN OVERVIEW — coordinates x=0..${widthPx}, y=0..${heightPx}. Use the magnified pair below for precise evidence.` },
    { inlineData: { data: Buffer.from(images.overview).toString('base64'), mimeType: 'image/png' } },
  ]
  const crop = { left: x0 / widthPx, top: y0 / heightPx, width: (x1 - x0) / widthPx, height: (y1 - y0) / heightPx }
  for (const [label, bytes, mimeType] of [['SOURCE', images.bytes, images.mimeType], ['MATCHING TOPOLOGY OVERLAY', images.overlay, 'image/png']] as const) {
    parts.push({ text: `${label} — FULL PLAN bounds x=${x0}..${x1}, y=${y0}..${y1}; report coordinates in FULL PLAN space:` },
      { inlineData: { data: Buffer.from(cropPlanImage(bytes, mimeType, crop, FOCUSED_VIEW_MAX_PX)).toString('base64'), mimeType: 'image/png' } })
  }
  if (localInventory) parts.push({ text: `LOCAL SOURCE INVENTORY (unverified); whole-drawing notation and omission rules retained:\n${JSON.stringify(localInventory)}` })
  parts.push({ text: `FOCUS BOUNDS: ${JSON.stringify(focus.bounds)}\nWRITABLE EXISTING IDS: ${JSON.stringify(focus.writableIds)}\nNEW ID PREFIX: ${focus.newIdPrefix}\nREPORTED DEFECTS TO VERIFY: ${JSON.stringify(focus.findings)}\nLOCAL MODEL + READ-ONLY NEIGHBORS: ${JSON.stringify(focus.model)}` })
  return parts
}

/** Validate the merged domain model, including implicit changes to opening associations. */
export function assertFocusedChanges(before: FloorModel, after: FloorModel, focus: RefinementFocus): void {
  if (isFullPlanFocus(focus)) return
  if (before.title !== after.title || !isDeepStrictEqual(before.plan, after.plan)) throw new Error('A focused repair cannot change plan metadata')
  const writable = new Set(focus.writableIds)
  const previous = new Map(allElements(before).map(element => [element.id, element]))
  const current = new Map(allElements(after).map(element => [element.id, element]))
  for (const [id, element] of previous) {
    if (!writable.has(id) && !isDeepStrictEqual(element, current.get(id))) throw new Error(`Focused repair changed read-only element: ${id}`)
  }
  for (const [id, element] of current) {
    const old = previous.get(id)
    if (isDeepStrictEqual(old, element)) continue
    if (!old && !id.startsWith(focus.newIdPrefix)) throw new Error(`New focused element must use prefix ${focus.newIdPrefix}: ${id}`)
    const bounds = refinementElementBounds(element)
    const { x0, y0, x1, y1 } = focus.bounds
    // Physical stroke widths may overhang the source edge; control points may not.
    if (Math.max(0, bounds.x0) < x0 || Math.max(0, bounds.y0) < y0
      || Math.min(before.plan.widthPx, bounds.x1) > x1 || Math.min(before.plan.heightPx, bounds.y1) > y1) {
      throw new Error(`Focused repair extends geometry beyond its evidence bounds: ${id}`)
    }
    const points = 'a' in element ? [element.a, element.b] : 'at' in element ? [element.at]
      : 'polygon' in element ? element.polygon : element.points
    if (points.some(point => point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1)) {
      throw new Error(`Focused repair moved a control point outside its evidence bounds: ${id}`)
    }
  }
}
