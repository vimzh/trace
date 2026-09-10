import path from 'node:path'
import { z } from 'zod'
import { imageSize } from 'image-size'
import { allElements, featureKinds, floorModelSchema, type FloorModel } from '@bumps/floor-model'
import { cropPlanImage, type NormalizedCrop } from '../lib/rasterize'
import {
  STRUCTURED_OUTPUT_INSTRUCTION,
  llmPointSchema,
  MODEL_CRITICAL,
  normalizeLlmPoint,
  parseAgentOutput,
  runAgentTurn,
  type LlmPoint,
  type MessagePart,
} from './llm'
import { withModelRetry } from './retry'
import { critiqueSchema } from './critique'
import { sourceInventorySchema } from './source-reader'
import { planRefinementFocus } from './refinement-focus'
import {
  assertFocusedChanges, focusedRefinementParts, FOCUSED_REFINEMENT_INSTRUCTION,
  isFullPlanFocus, prepareRefinementImages,
} from './refinement-context'

export { MODEL_CRITICAL, MODEL_FAST } from './llm'

// What the model emits: the floor model minus fields we own (schemaVersion)
// and minus plan dimensions (we know them from the image we sent).
// Provider-facing wire schema. Semantic geometry rules are enforced by the
// strict package schema after the model response is normalized.
const llmPoint = llmPointSchema
const llmConfidence = z.number().min(0).max(1)

// Keep array-implied kinds and derived fields optional to minimize the wire
// schema; the stricter domain schema fills and validates them after inference.
export const parsedOutputSchema = z.object({
  drawingType: z.enum(['floor-plan', 'site-plan', 'not-a-plan']),
  suitability: z.enum(['good', 'usable', 'poor']),
  suitabilityIssues: z.array(z.string()).max(2_000),
  title: z.string().max(200).nullable().optional(),
  walls: z.array(
    z.object({
      id: z.string(),
      kind: z.literal('wall').optional(),
      a: llmPoint,
      b: llmPoint,
      thickness: z.number().optional(),
      confidence: llmConfidence,
    }).strict(),
  ).max(2_000),
  openings: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['door', 'window']),
      at: llmPoint,
      width: z.number().min(1),
      wallId: z.string().nullable().optional(),
      confidence: llmConfidence,
    }).strict(),
  ).max(2_000),
  rooms: z.array(
    z.object({
      id: z.string(),
      kind: z.literal('room').optional(),
      polygon: z.array(llmPoint).min(3).max(2_000),
      label: z.string().max(200).nullable().optional(),
      confidence: llmConfidence,
    }).strict(),
  ).max(2_000),
  features: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(featureKinds),
      at: llmPoint,
      label: z.string().max(200).nullable().optional(),
      rotation: z.number().optional(),
      confidence: llmConfidence,
    }).strict(),
  ).max(2_000),
  furniture: z.array(
    z.object({
      id: z.string(),
      kind: z.literal('furniture').optional(),
      polygon: z.array(llmPoint).min(3).max(2_000),
      label: z.string().min(1).max(200),
      confidence: llmConfidence,
    }).strict(),
  ).max(2_000),
  paths: z
    .array(
      z.object({
        id: z.string(),
        kind: z.literal('path').optional(),
        points: z.array(llmPoint).min(2).max(2_000),
        confidence: llmConfidence,
      }).strict(),
    ).max(2_000)
    .optional(),
  roads: z
    .array(
      z.object({
        id: z.string(),
        kind: z.literal('road').optional(),
        points: z.array(llmPoint).min(2).max(2_000),
        widthPx: z.coerce.number().min(1).optional(),
        width: z.coerce.number().min(1).optional(),
        label: z.string().max(200).nullable().optional(),
        confidence: llmConfidence,
      }).strict(),
    ).max(2_000)
    .optional(),
  north: z.number().nullable().optional(),
}).strict()

const elementCollections = ['walls', 'openings', 'rooms', 'features', 'furniture', 'paths', 'roads'] as const

// Refinement returns changed records only. Omitted records survive byte-for-byte
// instead of depending on a model to re-transcribe hundreds of correct points.
export const refinementOutputSchema = parsedOutputSchema.pick({
  walls: true, openings: true, rooms: true, features: true, furniture: true,
  paths: true, roads: true, title: true, north: true,
}).extend({
  // Updates use the canonical field so a legacy width alias cannot be shadowed
  // by the existing record's widthPx during a localized merge.
  roads: z.array(parsedOutputSchema.shape.roads.unwrap().element.omit({ width: true })).max(2_000).optional(),
  removeIds: z.array(z.string()).max(2_000),
}).strict()

export function applyRefinement(
  previous: FloorModel,
  patch: z.infer<typeof refinementOutputSchema>,
): FloorModel {
  const existing = new Map(allElements(previous).map((element) => [element.id, element]))
  const removed = new Set(patch.removeIds)
  if (removed.size !== patch.removeIds.length) throw new Error('Duplicate refinement removal id')
  for (const id of removed) {
    if (!existing.has(id)) throw new Error(`Cannot remove unknown element: ${id}`)
  }
  const changed = new Set<string>()
  for (const collection of elementCollections) {
    for (const item of patch[collection] ?? []) {
      if (changed.has(item.id) || removed.has(item.id)) {
        throw new Error(`Conflicting refinement changes for: ${item.id}`)
      }
      if (existing.has(item.id) && !previous[collection].some((old) => old.id === item.id)) {
        throw new Error(`Refinement cannot change element class: ${item.id}`)
      }
      changed.add(item.id)
    }
  }
  const merged = Object.fromEntries(elementCollections.map((collection) => {
    const updates = new Map((patch[collection] ?? []).map((item) => [item.id, item]))
    const items = previous[collection]
      .filter((item) => !removed.has(item.id))
      .map((item) => updates.has(item.id) ? { ...item, ...updates.get(item.id) } : item)
    return [collection, [...items, ...(patch[collection] ?? []).filter((item) => !existing.has(item.id))]]
  }))
  // Deleting a wall clears its openings' association, just like editor deletes.
  // Replacing that wall keeps associations; explicit new associations are validated.
  merged.openings = (merged.openings as FloorModel['openings']).map((opening) =>
    opening.wallId && removed.has(opening.wallId)
      ? { ...opening, wallId: null } : opening,
  )
  const normalized = parsedToFloorModel(parsedOutputSchema.parse({
    ...merged, drawingType: 'floor-plan', suitability: 'good', suitabilityIssues: [],
    title: patch.title === undefined ? previous.title : patch.title,
    north: patch.north === undefined ? previous.plan.north : patch.north,
  }), previous.plan, previous.title)
  return { ...normalized, title: patch.title === undefined ? previous.title : patch.title,
    plan: { ...previous.plan, north: normalized.plan.north } }
}

function furniturePolygon(item: {
  polygon: LlmPoint[]
}): { x: number; y: number }[] {
  return item.polygon.map(normalizeLlmPoint)
}

export const PARSER_INSTRUCTION = `Extract a source-faithful floor or site model for a tactile map. Success means a blind visitor can identify the same destinations, obstacles and open connections shown in the source. Useful detail is not the largest element count: preserve navigation and printed meaning, omit decoration and unsupported guesses.

You receive the full-plan image and, for larger plans, overlapping zoomed DETAIL views labeled with their full-plan pixel bounds. Use the detail views to catch what the full view blurs — small doors, thin partition walls, short stubs, symbol marks — but ALWAYS report coordinates in the FULL PLAN pixel coordinate system.

## Notation dialects (plans differ; recognize all of these)
- Walls: structural wall notation may use two parallel lines (hollow, solid-black poché, gray, or hatched between), or a single thick stroke; thickness = the full drawn wall band.
- On colored visitor maps, fill-color changes and white separator bands may mark open galleries or departments, not physical walls. Require independent structural wall evidence before tracing those boundaries as walls. Preserve the named open zones as rooms without adding walls or doors along their graphic boundaries.
- Doors: a quarter-circle swing arc with a straight leaf line rooted at a wall gap (the gap is where the opening belongs, not the arc's far end); double doors = two mirrored arcs; sliding doors = overlapping parallel panels along the wall line; pocket doors = a leaf vanishing into a wall cavity; folding doors = a zigzag; an archway/open passage = a clean framed gap, sometimes with thin threshold lines across it.
- Windows: one to three thin parallel lines bridging a break in the wall band, flush with the wall.
- Stairs: a run of parallel rungs, often with a direction arrow and "UP"/"DN" text. Keep separate drawn flights at their own locations, not one averaged point between them even when they share a caption.
- Restrooms: repeated toilet bowls/cisterns within stalls beside washbasins or urinals identify restroom zones even without printed WC icons. Emit one restroom feature per zone, not per fixture. These bowls are not tables; omit their small fixture geometry, but preserve the stall walls and privacy partitions.
- Visitor schematics can establish restrooms through conventional facility badges without drawn plumbing fixtures. Paired W/M badges plus restroom/service-core context suffice; a lone unexplained letter does not. Preserve the printed abbreviation and evidenced accessibility qualifier on the restroom feature, retaining room geometry without duplicating the same label.
Treat marks you cannot classify conservatively: geometry you cannot identify is better omitted than guessed into the wrong class.

## Sweep order (work systematically; completeness is graded)
1. Building perimeter first: trace only the visible shell segments, following each physical stroke between its endpoints and junctions. A thick wall can lie directly against an image/crop edge: retain that visible stroke and its corner joins. "Cropped" does not mean "open". Do not close a genuinely blank cropped approach or break merely to complete a polygon; colored floor fill neither establishes nor erases a wall.
2. Interior walls: sweep room by room, left to right, top to bottom. Trace each physical enclosure's complete boundary, including unnamed service rooms and gray/windowed frontages. Room polygons alone do not preserve those physical obstacles. Do not leave the other sides of a curved enclosure for the reviewer to discover.
3. Openings pass: revisit EVERY room boundary and record its doors; corridors connect rooms, so check both sides of every corridor wall.
4. Features, then significant furniture, then paths/roads.
5. Self-check before answering: for every enclosed room you emitted with zero openings, re-examine its boundary in the detail views once for a door notation drawn small; if you still find none, keep the room sealed and lower its confidence. Named open zones need no enclosing walls or doors. Sanity-check your wall count against the drawing — a plan with thirty drawn wall segments must not yield twelve.

## First, classify the drawing
- floor-plan: a clear orthographic 2D building plan with traceable room boundaries, walls, and openings.
- site-plan: a clear orthographic 2D site/campus map with traceable building footprints and connecting roads or walkways.
- not-a-plan: perspective/isometric marketing render, ordinary photograph, elevation, transit diagram, illustration, or any image whose geometry cannot be traced as an overhead plan. An isometric architectural view is still not a floor plan.

Set suitability to good when geometry and labels are clear, usable when the overhead geometry remains traceable despite low resolution or moderate clutter, and poor when perspective, occlusion, illegibility, or missing boundaries make faithful extraction impossible. List concrete suitabilityIssues. For not-a-plan or poor input, return empty geometry arrays; the application will reject it and ask for a real floor/site plan.

For a BUILDING FLOOR PLAN: extract walls/openings/rooms/features/furniture. Roads/paths only if grounds are also drawn.
For a CAMPUS or SITE PLAN: each building footprint is a "room" with its name as label; extract roads, walkway paths, and entrances. Walls only where an individual building's interior is actually drawn.

## What to extract

walls — load-bearing and partition walls as straight segments (a, b endpoints).
- Split bent walls into straight segments at each corner.
- L-, U-, and T-shaped walls are connected segment networks, not decoration. Trace every leg, including a short leg. At an L/U corner the segment endpoints must meet; at a T junction the stem endpoint must land on the crossbar segment.
- CURVED WALLS ARE REQUIRED: approximate every visible curve with a connected chain of 6-16 short wall segments whose endpoints touch and visibly follow the arc. Never omit a curve or replace it with one straight chord.
- thickness = drawn wall thickness in pixels.
- A glazed/window span is still an impassable boundary: trace its supporting wall run and encode the window on it. Gray panels that bridge a physical wall band are not an open passage. Isolated pale decorative frames inside rooms remain omitted; physical continuity and the source notation distinguish them.
- Include SHORT stubs and partial partitions — even segments barely a door-width long shape navigation; never merge them away.
- NEVER trace stair treads as walls: the short parallel rungs of a drawn stair flight are one stairs feature, not geometry. Extract the flight's enclosing walls only.
- Follow the drawn geometry precisely: endpoints ON the wall centerlines, not approximations.
- A room polygon is annotation, not wall evidence. Never copy its edges into walls, extend a wall through open floor to reach a room corner, or use a straight chord to join curved wall ends. At each segment's two endpoints, verify that the source stroke actually continues that far. Text, door arcs and furniture outlines are not structural walls.
- At an image edge, distinguish missing source ink from a visibly drawn boundary: preserve real wall strokes even when clipped by the image border, but never invent a stroke across a white cropped approach. Review each perimeter run separately rather than opening or closing the entire bottom/right edge.
- A thick boundary stroke occupying the last image pixels is still visible wall evidence when it joins another structural wall; do not call that joined run an unresolved crop edge or omit it merely because its outer side is clipped.
- Preserve negative space: check that every source-visible corridor, aisle and open approach remains open in your wall network. A service desk or freestanding counter is furniture, not a walled room, even when its printed label resembles a room name.

openings — doors and windows in walls.
- kind MUST be exactly "door" or "window". Encode an archway or open passage through a wall as "door" because it becomes the same tactile wall gap.
- "at" = center of the opening; width = its size along the wall in pixels; wallId = id of the interrupted wall (or null).
- POSITION PRECISION: place "at" at the CENTER of the drawn gap or swing root — never at the wall's corner or junction. A door reported at the wrong spot on the right wall still sends a blind reader to the wrong place.
- One drawn opening = ONE emitted opening. Do not report the same gap twice from two overlapping views.
- Entrance/exit arrows at the building perimeter mark gates: emit the entrance feature AND look for the gap in the perimeter wall at that arrow — where the drawing shows the perimeter open there, emit that opening too.
- A door requires DIRECT VISIBLE EVIDENCE: a door leaf plus swing arc rooted at a wall gap, parallel sliding-door panels at a wall gap, or an unmistakable open passage interrupting a wall. A quarter-circle curve by itself, curved furniture, dimension marks, or nearby text is not a door.
- A plain open passage is directly evidenced when two aligned wall strokes visibly terminate on opposite sides of a plausible doorway-width gap between navigable spaces. Trace these gaps even when the drawing omits a swing arc. Do not treat an arbitrary missing boundary or large unbounded area as a passage.
- Grade the evidence and set confidence to match:
  - Explicit door symbol (leaf + swing arc, sliding panels, labeled door): confidence 0.85-1.0.
  - Clean framed doorway-width gap between two aligned wall ends, no symbol: confidence 0.5-0.7. Emit these — a human reviews everything below 0.7 — but the gap itself must be visible in the image.
  - Anything weaker (a smudge, a break in a single stroke, an unclear junction): emit NO opening.
- Never infer or invent a door because a room would otherwise be sealed. If no doorway is visibly traceable, emit no opening there and lower the room confidence.
- Assign wallId whenever the interrupted wall is identifiable. If you cannot locate the opening on a specific visible wall, omit it rather than guessing.

rooms — enclosed spaces, named open zones, or building footprints on campus plans as simple polygons.
- TRACE THE TRUE OUTLINE: an L- or T-shaped space gets its actual 6-8 corner polygon. NEVER collapse a drawn footprint to a triangle, and never emit a thin sliver when the drawing shows a full building.
- For a curved room boundary, put 6-16 ordered vertices along the curve so the polygon follows it; never flatten the curve to a single edge.
- label = the printed destination name if legible (else null). Keep room numbers and name qualifiers, but exclude square-footage measurements, dimensions, schedules and explanatory paragraphs. Corridors are rooms too.
- When standard fixtures unambiguously establish an otherwise unnamed functional space, use a conservative generic label so the tactile map retains that function: "toilet room" for each enclosed toilet stall and "restroom circulation" for the surrounding restroom zone. These are functional descriptions, not source transcriptions; never infer gender or storage from color or layout.
- Preserve every legible printed destination name, including named departments and open galleries; do not replace them with generic summaries. Trace a named open zone's visible extent as a room polygon without implying an enclosing wall. Keep separately located names anchored in their own source regions. Only combine the exact printed names when adjacent labels refer to the same unpartitioned region; never concatenate destinations from across the floor into one label. Each label must fit 200 characters. Do not invent enclosing walls to separate names.
- Polygons must not self-intersect; vertices in drawing order.

features — stairs, elevator, entrance, exit, restroom, ramp — when their symbol or label is present.
- Directional callouts identify a route, not necessarily a feature on this level: "down to [exit]" pointing to stairs means a stairs feature with the full route label, not a second exit at the same point. Add an exit only when the source separately shows it on this floor.
- An ordinary interior, exterior, or porch door remains an opening unless an explicit entrance/exit symbol, label, or arrow in the SOURCE image marks it as such. A door swing, perimeter location, or access to outdoors alone does not justify an entrance/exit feature.
- "at" = symbol center; rotation = degrees clockwise (stairs/ramp: ascending direction; entrance: direction of entry).
- When a restroom is identified by its fixture constellation rather than a printed facility icon, place its feature in the clear circulation of that restroom zone, not on a bowl, sink bank or partition.
- Extract EVERY occurrence, not one representative.
- A facility's printed name need only be represented once at its source location: prefer its feature label rather than duplicating the same name on an enclosing room polygon. Keep the room geometry, with a null label when it has no independent room name. For one entrance explicitly qualified as ramp-accessible, retain an entrance feature with that qualifier rather than adding a second co-located ramp landmark; a separately drawn ramp remains its own feature.
- label = the printed feature name or a qualifier explicitly evidenced by its symbol (such as "wheelchair seating" or "accessible restroom"); otherwise null. Preserve a named exit's destination and a facility's accessibility qualifier. A wheelchair seating-space symbol is a seating feature labeled "wheelchair seating", not an ordinary furniture seat. A wheelchair icon qualifying a room or facility is NOT evidence of seating: retain "accessible" in that room/facility's label instead; do not invent a seat or unsupported feature kind. Read the source legend to disambiguate symbols; a crossed square alone is not evidence of a lift.
- Explicit entrance/exit callouts can point some distance from their text: follow the leader to the marked location and retain the name. Do not omit them because the arrow is outside the building outline.
- Never invent a you-are-here feature.
- Keep only features that help a blind visitor orient, navigate, find accessibility facilities, or avoid hazards. Ignore operational and technology markers such as Wi-Fi hotspots, fire equipment, CCTV, vending machines, and electrical fixtures.
- "info-point" and "reception" mean staffed visitor information/reception points. Do not coerce an unsupported device or operational marker (such as a self-checkout terminal or phone charger) into a staffed-service kind. A Wi-Fi hotspot is never an info-point. A significant source-drawn physical equipment bank may remain furniture; a symbol alone does not establish its footprint. Preserve named visitor destinations such as a technology room or copy-service desk, not every incidental machine icon.
- The same filter applies to furniture and source-reader/reviewer requests: a symbol-only copier, printer, charger or terminal is deliberately omitted, not traced as an icon-box obstacle. A legend's decoding does not establish a physical footprint. Keep separately named service areas and independently drawn significant equipment banks.

furniture — furniture and fixed interior landmarks generalized into tactile areas, never per-item outlines.
- SIGNIFICANCE FILTER — extract only what a blind visitor would navigate by or collide with:
  - Significant (extract): reception/service counters, fixed seating banks and waiting-area rows, shelving stacks, stages, kitchen islands, large tables, beds, fountains and large planters that act as landmarks, freestanding structural columns in open space (label "column").
  - Insignificant (skip): individual chairs, potted plants, rugs and floor patterns, small side tables, wastebaskets, sink/toilet fixtures inside small restrooms (the restroom feature already marks the room), appliances, decor.
- On a dense plan, simplify individual items into navigation-relevant groups, not an arbitrary count limit. Preserve distinct fixed landmarks and shelving rows separated by walkable aisles; do not fill a circulation gap to reduce the number of blocks.
- For seating/shelving banks, follow the OUTERMOST drawn row edges on each side of a wider transverse aisle, not the full bank's bounding hull. Split front/rear groups there and retain the full source gap even beside a wheelchair icon. Merely returning separate polygons is insufficient if their corners still project into the cross-aisle.
- CLUB adjacent same-kind items: a row of chairs is ONE block "chairs"; a desk group is one "desks" block.
- Blocks TIGHTLY follow the drawn items. Grouping may bridge ordinary spacing between rows, but must not add padding into a visible aisle. For a curved or tapering bank, check its outer edge at front, middle and rear; preserve changes in width/concavity instead of joining distant corners with a hull that occupies walkable floor. Prefer two tight blocks over one inflated one.
- PRESERVE SHAPE for navigation landmarks. A round fountain, circular desk, round planter, or curved counter must use a 12-24 point polygon following its visible outline — never a square or rectangular bounds box. Rectangular furniture must use four corner points in polygon; do not emit a bounds property.
- label: preserve the exact printed destination name for a named landmark (for example a named service desk or copy area). Use a short generic lowercase noun only when no name is printed ("fountain", "sofa", "chairs", "desks", "table", "counter", "bookshelves", "column"). Name what the item IS: a shelving row is "bookshelves", never "table". Do not model a printed icon or text bounding box as a physical obstacle; only trace a visible physical footprint.
- Skip tiny isolated items; do not miss chair clusters.

paths — pedestrian walkways, guide routes, marked trails — ONLY when actually drawn.
- Polyline of 2+ points along the centerline. Campus walkway networks matter: they connect the buildings; without them the map is disconnected blocks. Trace the main network, splitting at junctions into separate paths.
- Never invent paths that are not drawn.

roads — streets, drives, parking access — drawn as bands with real width.
- A drawn external street band remains a road on an indoor-focused plan; do not turn it into a room merely because its name is printed beside the building.
- Polyline along the centerline + widthPx = the drawn band width in pixels.
- Verify BOTH road edges: the centerline bisects the visible band and widthPx is their perpendicular separation, not a coordinate from the image origin. Do not use a road boundary as its centerline. Check curved/tapering bands at several locations; use separate segments where necessary. A clipped or hidden edge is uncertainty, not permission to invent a symmetric band around the visible edge.
- label = the street name if printed ("Main St").
- On campus/site plans the street network is required content when drawn — it is how a blind reader anchors the campus to the city.

north — if a north arrow / compass is drawn: degrees clockwise from image-up to north (0 = up, 90 = north points right). Else null.

title — the plan's printed title if present.

## Coordinate discipline
- Coordinates are PIXELS in the exact image given, origin top-left, x right, y down. The prompt states the image dimensions; never exceed them.
- Trace what is drawn where it is drawn. Do not snap, straighten, or "improve" the drawing.
- Ignore dimension lines, hatching, title blocks, and decorative texture (the compass feeds ONLY "north"; a scale bar feeds nothing).
- Read legends as decoding keys only: their sample symbols, text boxes and frames are not map features, furniture, rooms or walls. Do not trace the page border or a legend frame as a building perimeter.
- Emit nothing outside the plan's drawn area.

## Honesty
- ids: short, unique, type-prefixed: w-1, d-1, win-1, r-1, f-1, fur-1, p-1, rd-1.
- confidence per element: your honest certainty 0-1. Blurry, inferred, or occluded means lower. Do not default everything to one value.
- Confidence rubric: 0.90-1.00 = directly visible and unambiguous; 0.70-0.89 = visible but partly obscured or approximate; 0.50-0.69 = plausible and requires human review; below 0.50 = highly uncertain. Omit a highly uncertain safety-critical opening rather than emitting it.
- It is better to omit an uncertain opening than to cut a fake gap into a tactile wall. It is better to extract 40 real elements than 8 vague ones. Completeness AND fidelity are both graded by a reviewer comparing your output against the image.

Use the supplied output schema; coordinates are {x, y} objects.` + STRUCTURED_OUTPUT_INSTRUCTION

const MIME_BY_EXT: Record<string, string> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export const DETAIL_CROPS: { crop: NormalizedCrop; label: string }[] = [
  { crop: { height: 0.58, left: 0, top: 0, width: 0.58 }, label: 'top-left' },
  { crop: { height: 0.58, left: 0.42, top: 0, width: 0.58 }, label: 'top-right' },
  { crop: { height: 0.58, left: 0, top: 0.42, width: 0.58 }, label: 'bottom-left' },
  {
    crop: { height: 0.58, left: 0.42, top: 0.42, width: 0.58 },
    label: 'bottom-right',
  },
]

export async function loadPlanImageParts(planPath: string, includeDetails = true): Promise<MessagePart[]> {
  const bytes = await Bun.file(planPath).bytes()
  const mimeType = MIME_BY_EXT[path.extname(planPath).toLowerCase()]
  if (!mimeType) throw new Error(`Unsupported plan image type: ${planPath}`)
  const { height, width } = imageSize(bytes)
  if (!width || !height) throw new Error(`Could not read plan image: ${planPath}`)
  const parts: MessagePart[] = [
    { text: `FULL PLAN — coordinate space x=0..${width}, y=0..${height}:` },
    { inlineData: { data: Buffer.from(bytes).toString('base64'), mimeType } },
  ]
  if (!includeDetails || Math.max(width, height) < 1200) return parts
  for (const { crop, label } of DETAIL_CROPS) {
    const x0 = Math.round(crop.left * width)
    const y0 = Math.round(crop.top * height)
    const x1 = Math.round((crop.left + crop.width) * width)
    const y1 = Math.round((crop.top + crop.height) * height)
    const tile = cropPlanImage(bytes, mimeType, crop)
    parts.push(
      {
        text: `DETAIL ${label} — full-plan pixel bounds x=${x0}..${x1}, y=${y0}..${y1}; report coordinates in the FULL PLAN space:`,
      },
      { inlineData: { data: Buffer.from(tile).toString('base64'), mimeType: 'image/png' } },
    )
  }
  return parts
}

async function runParser(
  parts: MessagePart[],
  dimensions: { widthPx: number; heightPx: number },
  title: string | null | undefined,
): Promise<FloorModel> {
  return withModelRetry(() => runParserOnce(parts, dimensions, title))
}

async function runParserOnce(
  parts: MessagePart[],
  dimensions: { widthPx: number; heightPx: number },
  title: string | null | undefined,
): Promise<FloorModel> {
  const outputSchema = parsedOutputSchema.superRefine((parsed, context) => {
    if (parsed.drawingType === 'not-a-plan' || parsed.suitability === 'poor') return
    try {
      parsedToFloorModel(parsed, dimensions, title)
    } catch (error) {
      context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
    }
  })
  const structuredOutput = await runAgentTurn({
    agentName: 'Parser',
    description: 'Extracts a structured floor model from a floor plan image',
    instruction: PARSER_INSTRUCTION,
    model: MODEL_CRITICAL,
    outputSchema,
    parts,
  })

  const parsed = parseAgentOutput(parsedOutputSchema, structuredOutput, 'Parser')
  assertUsablePlanInput(parsed)
  return parsedToFloorModel(parsed, dimensions, title)
}

function parsedToFloorModel(
  parsed: z.infer<typeof parsedOutputSchema>,
  dimensions: { widthPx: number; heightPx: number },
  title: string | null | undefined,
): FloorModel {
  return floorModelSchema.parse({
    schemaVersion: 1,
    title: parsed.title ?? title ?? null,
    plan: {
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      pixelsPerMeter: null,
      north: parsed.north ?? null,
    },
    walls: parsed.walls.map((wall) => {
      const seg = {
        a: normalizeLlmPoint(wall.a),
        b: normalizeLlmPoint(wall.b),
      }
      return {
        confidence: wall.confidence,
        id: wall.id,
        kind: 'wall' as const,
        thickness: wall.thickness ?? 8,
        ...seg,
      }
    }),
    openings: parsed.openings.map((opening) => ({
      ...opening,
      at: normalizeLlmPoint(opening.at),
      wallId: opening.wallId ?? null,
    })),
    rooms: parsed.rooms.map((room) => ({
      ...room,
      kind: 'room' as const,
      label: room.label ?? null,
      polygon: room.polygon.map(normalizeLlmPoint),
    })),
    features: parsed.features.map((feature) => ({
      ...feature,
      at: normalizeLlmPoint(feature.at),
      rotation: feature.rotation ?? 0,
    })),
    furniture: parsed.furniture.map((item) => ({
      confidence: item.confidence,
      id: item.id,
      kind: 'furniture' as const,
      label: item.label,
      polygon: furniturePolygon(item),
    })),
    paths: (parsed.paths ?? []).map((path) => ({
      ...path,
      kind: 'path' as const,
      points: path.points.map(normalizeLlmPoint),
    })),
    roads: (parsed.roads ?? []).map((road) => ({
      confidence: road.confidence,
      id: road.id,
      kind: 'road' as const,
      label: road.label ?? null,
      points: road.points.map(normalizeLlmPoint),
      widthPx: road.widthPx ?? road.width ?? 12,
    })),
  })
}

export function assertUsablePlanInput(assessment: {
  drawingType: 'floor-plan' | 'site-plan' | 'not-a-plan'
  suitability: 'good' | 'usable' | 'poor'
  suitabilityIssues: string[]
}): void {
  if (assessment.drawingType !== 'not-a-plan' && assessment.suitability !== 'poor') {
    return
  }
  const reason = assessment.suitabilityIssues.join('; ') || assessment.drawingType
  throw new Error(`Input is not a usable floor or site plan: ${reason.slice(0, 400)}`)
}

export async function parsePlanImage(
  planPath: string,
  dimensions: { widthPx: number; heightPx: number },
  sourceInventory?: string,
  detailParts: MessagePart[] = [],
): Promise<FloorModel> {
  // Full plan plus zoomed detail views: small doors, thin partitions, and
  // symbol marks routinely vanish at whole-plan resolution.
  const planParts = await loadPlanImageParts(planPath)
  return runParser(
    [
      {
        text: `Parse this floor plan. The full image is ${dimensions.widthPx}x${dimensions.heightPx} pixels.`,
      },
      ...planParts,
      ...detailParts,
      ...(sourceInventory ? [{ text: `SOURCE-ONLY INVENTORY — verify against the image; retain evidenced destinations and open connections, not unsupported interpretations:\n${sourceInventory}` }] : []),
    ],
    dimensions,
    null,
  )
}

export async function refineParse(
  planPath: string,
  dimensions: { widthPx: number; heightPx: number },
  previousModel: FloorModel,
  critiqueJson: string,
  structuralAudit?: string | null,
  findingParts: MessagePart[] = [],
  sourceInventory?: string,
): Promise<FloorModel> {
  const findings = critiqueSchema.parse({ findings: JSON.parse(critiqueJson),
    verdict: 'needs_refinement', confidenceAdjustments: [] }).findings
  const focuses = planRefinementFocus(previousModel, findings)
  if (!focuses.length) return previousModel
  const broad = focuses.length === 1 && isFullPlanFocus(focuses[0]!)
  const planParts = await loadPlanImageParts(planPath, broad)
  const source = planParts.find((part): part is Extract<MessagePart, { inlineData: unknown }> => 'inlineData' in part)?.inlineData
  if (!source) throw new Error('Refiner did not load the source plan image')
  const images = broad ? null : prepareRefinementImages(previousModel, source)
  const inventory = sourceInventory ? sourceInventorySchema.parse(JSON.parse(sourceInventory)) : undefined
  const broadParts: MessagePart[] = broad ? [
      {
        text: `Correct the supplied extraction using the source image. The full image is ${dimensions.widthPx}x${dimensions.heightPx} pixels.`,
      },
      ...planParts,
      ...findingParts,
      ...(sourceInventory ? [{ text: `SOURCE-ONLY INVENTORY — re-check meaning against the source before accepting reviewer suggestions:\n${sourceInventory}` }] : []),
      {
        text:
          `Your previous extraction:\n${JSON.stringify(previousModel)}\n\nA reviewer compared it against the plan and found:\n${critiqueJson}\n\n` +
          (structuralAudit
            ? `${structuralAudit}\n\n`
            : '') +
          `Return a PATCH, not a complete model. In each geometry array include only new or changed records, with all fields for each changed record; return empty arrays for unaffected classes. removeIds lists existing elements to delete. Preserve ids when changing an element. Unmentioned records are kept exactly by code. Omit title and north unless correcting them from source evidence; null explicitly clears one. Verify each proposed finding against the image before changing anything: the reviewer can be wrong. Fix the evidenced problem locally, not by redrawing the room or extending adjacent walls. When a wall already follows the visible stroke, preserve it; do not shorten or shift it merely to act on an underspecified review. Locate the actual source endpoints before changing geometry. Never add an opening merely to satisfy a sealed-room finding. Check that your patch does not remove another destination, close an open route, or replace a curve with a chord.`,
      },
    ] : []
  console.log(`[parse] refinement: ${broad ? 'whole-plan' : `${focuses.length} focused task(s), at most two concurrent`}`)
  const runFocus = async (focus: typeof focuses[number]) => {
    const parts = broad ? broadParts : focusedRefinementParts(focus, images!, inventory)
    return withModelRetry(async () => {
      const outputSchema = refinementOutputSchema.superRefine((patch, context) => {
        try {
          assertFocusedChanges(previousModel, applyRefinement(previousModel, patch), focus)
        } catch (error) {
          context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
        }
      })
      const output = await runAgentTurn({
        agentName: 'Refiner',
        description: 'Corrects source-evidenced discrepancies without re-transcribing unaffected geometry',
        instruction: broad ? PARSER_INSTRUCTION : FOCUSED_REFINEMENT_INSTRUCTION + STRUCTURED_OUTPUT_INSTRUCTION,
        model: MODEL_CRITICAL,
        outputSchema,
        parts,
      })
      const patch = parseAgentOutput(refinementOutputSchema, output, 'Refiner')
      assertFocusedChanges(previousModel, applyRefinement(previousModel, patch), focus)
      return patch
    })
  }
  const patches: z.infer<typeof refinementOutputSchema>[] = new Array(focuses.length)
  let next = 0
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, focuses.length) }, async () => {
    while (!failed && next < focuses.length) {
      const index = next++
      const focus = focuses[index]!
      try {
        patches[index] = await runFocus(focus)
      } catch (error) { failed = true; throw error }
    }
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  // Merge only after every task succeeds. Existing conflict/schema checks make
  // this atomic; no successful partial batch is exposed as a repaired model.
  const merged = refinementOutputSchema.parse({
    ...Object.fromEntries(elementCollections.map(collection => [collection, patches.flatMap<unknown>(patch => patch[collection] ?? [])])),
    removeIds: patches.flatMap(patch => patch.removeIds),
    ...(broad && patches[0]!.title !== undefined ? { title: patches[0]!.title } : {}),
    ...(broad && patches[0]!.north !== undefined ? { north: patches[0]!.north } : {}),
  })
  return applyRefinement(previousModel, merged)
}
