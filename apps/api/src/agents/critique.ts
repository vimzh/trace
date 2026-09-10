import { z } from 'zod'
import {
  STRUCTURED_OUTPUT_INSTRUCTION,
  llmPointSchema,
  MODEL_CRITICAL,
  normalizeLlmPoint,
  parseAgentOutput,
  runAgentTurn,
  type MessagePart,
} from './llm'
import { withModelRetry } from './retry'
import type { ReviewRegion } from './review-views'

const findingSchema = z.object({
  kind: z.enum(['missing', 'extra', 'misplaced', 'mislabeled']),
  // Id of the affected element in the current model, when it exists.
  elementId: z.string().nullable(),
  // Approximate full-plan pixel location of the problem; lets the refiner
  // receive a zoomed crop of exactly this spot.
  at: llmPointSchema.nullable(),
  // A point cannot describe a long missing run or the extent of an extension.
  // Historical/unbounded findings deliberately retain whole-plan refinement.
  bounds: z.object({ x0: z.number().min(0), y0: z.number().min(0),
    x1: z.number().min(0), y1: z.number().min(0) }).strict().nullable(),
  description: z.string(),
  severity: z.enum(['minor', 'major']),
}).strict()

const adjustmentsSchema = z.array(
  z.object({
    elementId: z.string(),
    confidence: z.number().min(0).max(1),
  }).strict(),
)

export const critiqueOutputSchema = z.object({
  verdict: z.enum(['pass', 'needs_refinement']),
  findings: z.array(findingSchema).max(2_000),
  confidenceAdjustments: adjustmentsSchema.max(2_000),
  regionChecks: z.array(z.object({
    region: z.string(),
    status: z.enum(['clear', 'finding']),
    evidence: z.string().min(1).max(700),
  }).strict()).min(1).max(4),
}).strict()

// Historical critiques predate region checks; live output must satisfy the
// required schema and all requested regions before reaching this transform.
export const critiqueSchema = critiqueOutputSchema.extend({
  findings: z.array(findingSchema.partial({ bounds: true })).max(2_000),
}).partial({ regionChecks: true }).transform((raw) => {
  const findings = raw.findings.map((finding) => ({
    at: finding.at ? normalizeLlmPoint(finding.at) : null,
    ...(finding.bounds !== undefined ? { bounds: finding.bounds } : {}),
    description: finding.description,
    elementId: finding.elementId,
    kind: finding.kind,
    severity:
      ['missing', 'extra', 'misplaced'].includes(finding.kind) &&
      /\b(?:door|opening|wall|window|glazing|partition|entrance|exit)\b/i.test(
        finding.description,
      )
        ? ('major' as const)
        : finding.severity,
  }))
  const verdict =
    raw.verdict === 'pass' &&
    !findings.some((finding) => finding.severity === 'major')
      ? ('pass' as const)
      : ('needs_refinement' as const)
  return {
    confidenceAdjustments: raw.confidenceAdjustments,
    findings,
    ...(raw.regionChecks ? { regionChecks: raw.regionChecks } : {}),
    verdict,
  }
})

export type Critique = z.infer<typeof critiqueSchema>

export function critiqueSchemaForRegions(regions: ReviewRegion[]) {
  return critiqueOutputSchema.superRefine((review, context) => {
    const names = review.regionChecks.map((check) => check.region)
    if (names.length !== regions.length || new Set(names).size !== names.length
      || regions.some(({ region }) => !names.includes(region))) {
      context.addIssue({ code: 'custom', message: `Review every requested region exactly once: ${regions.map(r => r.region).join(', ')}` })
    }
    for (const check of review.regionChecks) {
      if (check.status !== 'finding') continue
      const region = regions.find(r => r.region === check.region)
      if (region && !review.findings.some(finding => finding.severity === 'major' && finding.at
        && finding.at.x >= region.x0 && finding.at.x <= region.x1
        && finding.at.y >= region.y0 && finding.at.y <= region.y1)) {
        context.addIssue({ code: 'custom', message: `${check.region} reports a boundary discrepancy but has no located major finding; include its source-evidenced correction` })
      }
    }
    if (review.verdict === 'pass' && review.regionChecks.some(check => check.status !== 'clear')) {
      context.addIssue({ code: 'custom', message: 'A pass requires all region checks clear; preserve unresolved boundary findings and request refinement' })
    }
    for (const finding of review.findings) {
      if (finding.bounds) {
        const { x0, y0, x1, y1 } = finding.bounds
        if (x1 < x0 || y1 < y0 || (finding.at && (finding.at.x < x0 || finding.at.x > x1
          || finding.at.y < y0 || finding.at.y > y1))) {
          context.addIssue({ code: 'custom', message: 'Finding bounds must be ordered full-plan coordinates enclosing its location and complete repair extent' })
        }
      }
      if (!finding.at) {
        context.addIssue({ code: 'custom', message: 'Every live finding requires a full-plan location inside your assigned review region' })
      } else if (!regions.some(region => finding.at!.x >= region.x0 && finding.at!.x <= region.x1
        && finding.at!.y >= region.y0 && finding.at!.y <= region.y1)) {
        context.addIssue({ code: 'custom', message: 'A finding lies outside the requested review regions; report only your assigned area in full-plan coordinates' })
      }
    }
  })
}

export const CRITIQUE_INSTRUCTION = `You review machine extractions of architectural floor plans.

You receive a full original floor plan, optional overlapping zoomed detail views whose annotations map them to full-plan coordinates, an aligned topology overlay, and then a rendering of the extracted model. The render legend is: light gray filled polygons = rooms/buildings (label text at center), darker gray blocks with labels = furniture blocks, black lines = walls, wide translucent gray bands = roads/streets (name above), orange dashed lines = walkway paths, colored circles = doors/windows, small squares with letters = features (S stairs, E elevator, WC restroom, arrow entrance, X exit, R ramp).

The aligned topology overlay places the extracted geometry directly over the source plan: RED lines and endpoint dots are extracted walls, CYAN circles are extracted doors, BLUE circles are extracted windows, GREEN outlines are extracted rooms/building footprints, VIOLET dashed outlines are furniture blocks, MAGENTA squares are features, ORANGE dashed lines are guide paths, and AMBER translucent bands are roads. A visible source wall without red coverage is missing. Red geometry with no source wall beneath it is extra. A cyan door circle without direct door/opening evidence beneath it is a fake door. A drawn room with no green outline (or a green outline that cuts through drawn space) is a missing or misplaced room. Inspect endpoint dots closely: separated endpoints at an L, U, or T junction mean the wall network is disconnected.

You also receive the extracted model as JSON (ids included). A source-supported door record cuts its width out of its host wall and collinear connected wall records during tactile conversion; raw red centerlines need not already be split at a cyan door. Check the door's location, width and association before claiming that an entrance is blocked. Classify each uncovered connected stroke independently: fixture outlines in the same crop do not excuse a thick straight privacy or boundary segment, and omitting a small fixture must not remove an adjacent physical partition.

Complete PHYSICAL-BOUNDARY REVIEW before destination labels and furniture. The requested review regions partition the plan with overlap. For each region, compare its unoverlaid source and immediately following matched overlay: follow every visible enclosure side and frontage, including unnamed service rooms, short returns and glazed/gray window panels. Check both missing physical runs and unsupported connections across blank circulation. A green room polygon does NOT account for a physical wall, and a blue window marker does not supply a missing wall span. Glazing connected into a drawn boundary is impassable structure; a pale isolated interior decorative frame is not. Window spans need supporting walls, not passage gaps. Do not create a wall along an open-zone boundary merely to complete this review.

Return one regionChecks entry for EACH requested region, even when it has no problem: status=clear with concise observed boundary/negative-space evidence, or status=finding with evidence and a corresponding located finding. Report the complete set of source-evidenced boundary defects on the FIRST review; do not defer an enclosure's other sides to later rounds or stop after a few conspicuous mistakes. Then check the remaining semantic/furniture rules. On refinement reviews recheck repaired boundaries AND the remaining regions. This checklist records inspection coverage, not certainty: do not mark a region clear without inspecting its paired views.

For each finding provide bounds {x0,y0,x1,y1} in FULL PLAN pixels enclosing the COMPLETE source-evidenced repair extent, not just its midpoint: both ends of a missing wall, the new endpoint of a road extension, the entire affected furniture contour, or the full set of related partition runs. Include at inside these bounds. The refiner uses this to inspect a magnified local view, adds neighboring context automatically, and also retains the implicated existing element in full. Use null bounds if the extent cannot be located confidently or the correction genuinely requires whole-plan context. Do not guess a small box around at; incomplete bounds can prevent a valid repair.

You may also receive a DETERMINISTIC STRUCTURAL AUDIT: attention hints computed by code from the extracted geometry and a pixel-coverage comparison (doorway-width wall gaps, sealed rooms, orphan openings, uncovered-linework regions, normalization notes). These are directives for WHERE to look, not confirmed errors. Verify each hint against the source image: confirmed → report it as a finding with the correct kind and severity; unsupported (the uncovered ink is text, dimensioning, or hatching; the gap is a drawn junction) → dismiss it silently. Never copy an audit line into findings without image evidence.

Report structural discrepancies between the images:
- missing: present in the plan, absent from the model
- extra: in the model but not in the plan
- misplaced: exists but noticeably wrong position, size, or shape
- mislabeled: wrong or missing room label that is legible in the plan

Rules:
- Only report real structural issues. Ignore rendering style, colors, line weights, dimensions, and hatching.
- Check selection before completeness: an intentionally excluded incidental device is not a missing landmark. Apply this to ALL arrays, including furniture, and to the source inventory itself. A symbol-only copier, printer, charger or terminal must not become a solid obstacle shaped like its icon box. Report that geometry as extra; never request it as missing. A separately named service area or significant independently drawn equipment bank remains eligible. Explaining an icon through the legend is not independent footprint evidence.
- The source legend explains symbols; its samples and frame do not belong in extracted geometry. Source names should retain room numbers and meaningful qualifiers, not appended floor-area measurements or schedules. Flag such clutter as minor, never as a missing destination.
- Use the source-only inventory as an independent checklist, verifying each entry against pixels rather than assuming it is correct. Check both retained meaning and open connections. Toilet bowls with cisterns repeated in stalls are restroom fixtures, not tables/workstations; do not demand individually raised fixtures. Retain the restroom function and structural privacy partitions instead.
- Review in BOTH directions. First inspect the unoverlaid source region by region and account for its destinations, accessibility symbols, fixed landmarks and open connections in the JSON. Then inspect emitted geometry against the source for inventions. The extracted render is not evidence for what exists in the source.
- Interpret the drawing's dialect: conventional paired W/M amenity badges in restroom/service-core context establish restroom facilities on a visitor schematic even without plumbing drawings. Do not strip facility meaning merely because fixtures are absent. A lone unexplained letter remains ambiguous. Preserve source abbreviations and accessibility qualifiers on the restroom features; room geometry remains, without duplicate names.
- When fixtures unambiguously establish unnamed restroom spaces, require conservative functional room labels: "toilet room" for enclosed toilet stalls and "restroom circulation" for the surrounding zone. Treat their absence as missing functional information, but never request inferred gender or storage labels.
- Previous reviewed claims, when supplied, are hypotheses, not authority. Re-check them against the current model and source. Before reversing a prior conclusion at the same location, identify the contrary visual evidence and explain that reversal in the finding description. For a misplaced wall, cite the source-visible endpoints/turns and the specific mismatch; a group midpoint plus "retrace the partitions" is not an actionable correction. Do not request a shift when the existing segment already follows the visible stroke. Check the rest of the source too; prior findings are not an exhaustive checklist.
- Check negative space explicitly: follow the source's visible open approaches, corridors and aisles through the overlay. A red segment that closes one is an extra MAJOR finding even if it follows a green room boundary. Inspect both endpoints of each long wall for an unsupported extension. Do not accept a straight chord across a curved wall or close an open/cropped perimeter just to complete a room.
- Conversely, visible source wall strokes remain physical boundaries even when clipped by the image edge. Check the whole perimeter run by run for missing ink coverage; leaving one white cropped approach open must not erase adjacent black perimeter walls.
- A thick boundary stroke occupying the last image pixels is visible wall evidence when it joins another structural wall. Do not describe that joined run as an unresolved crop edge simply because its outer side is clipped.
- On colored visitor maps, distinguish physical walls from fill-color changes and white separator bands between open zones. An extracted wall following only a graphic zone boundary, without independent structural wall evidence in the source, is an extra MAJOR finding. Preserve the named room regions while removing invented walls; a room polygon does not require enclosing walls or doors.
- Audit every legible printed destination name against room, feature and furniture labels, including named departments, open galleries and service desks. A missing name or replacement with a generic summary is a missing or mislabeled MAJOR finding. Combined exact printed names are acceptable only for adjacent labels in the same unpartitioned region; destinations located far apart need separately anchored regions, not a floor-wide catch-all label. Never request invented walls to separate names. A named freestanding desk belongs in furniture, not in a new walled enclosure. Printed icons and their boxes are not evidence of a physical obstacle footprint.
- On campus/site plans: missing drawn streets or the main walkway network are MAJOR findings — they are how the map connects. A building footprint collapsed to a triangle or sliver when the drawing shows a full building is a misplaced MAJOR finding.
- Furniture is expected as coarse clubbed blocks (a row of chairs = one "chairs" block), not per-item outlines, and deliberately filtered for significance: reception/service counters, seating banks, shelving, stages, large tables, landmark fountains/planters, and freestanding columns belong in the model; individual chairs, plants, rugs, small side tables, restroom fixtures, and decor are intentionally skipped and must NOT be reported as missing. Report a missing fixed navigation landmark, an invented obstacle, or a group that fills a visible walkable aisle as MAJOR. Small contour offsets and noncritical furniture omissions are minor. There is no fixed block-count quota: preserve distinct navigation-relevant groups and the circulation gaps between them.
- Fixed navigation landmarks retain their source outline. A round fountain, circular planter, circular desk, or curved counter rendered as a square/rectangle is a misplaced MAJOR finding; compare the landmark polygon against the source curve.
- Check transverse aisles as well as longitudinal/side aisles through seating or shelving banks. Follow the actual outermost row edges at each wider front/rear gap, including beside wheelchair icons. Separate furniture polygons can STILL block this gap through protruding corners or a bounding-hull chord; compare the entire gap against the overlay and report encroachment as misplaced MAJOR, not a cosmetic contour offset.
- Follow each bank's SIDE outline at front, middle and rear too. An oversized convex envelope can preserve a cross-aisle while occupying the tapering side aisle. Compare the outermost drawn rows along the whole contour, not just bank count, endpoint positions or the gap between blocks; no padding allowance overrides a visible walkable aisle.
- The tactile-oriented model must omit operational and technology markers that do not help blind navigation. Report Wi-Fi hotspots, CCTV, fire equipment, vending machines, and electrical fixtures as extra when they were emitted as features. Both info-point and reception require a staffed service, not an unsupported device mapped to the nearest available kind. Do not demand self-checkout/charging icons as reception points. A significant visibly drawn equipment bank may remain furniture, but an icon alone is not a physical footprint. Preserve named visitor destinations such as a technology room or copy-service desk; do not confuse their names with incidental device markers.
- Audit every emitted door for direct visible evidence: a leaf and rooted swing arc, sliding panels at a wall gap, or an unmistakable open passage. A door inferred only because a room seems sealed is an extra MAJOR finding because it cuts a false gap into the tactile wall.
- When rejecting an opening, inspect the underlying wall geometry too. If the source shows a continuous physical wall but the model has two separated wall ends, removing the opening alone leaves the false passage. Explicitly request restoration of the source-visible wall span, with its endpoints, in the same finding or a located missing-wall finding. Never fill a genuine source gap.
- In this schema, opening.kind="door" also represents an archway or plain open passage: it is a tactile gap, not a claim of a hinged leaf. Never remove a source-visible wall-ended passage solely because it has no swing arc. A room polygon may annotate an open named zone without representing an enclosure.
- Audit EVERY entrance/exit feature against the SOURCE image for an explicit entrance/exit symbol, label, or arrow. Ordinary interior, exterior, and porch doors do not establish entrance/exit landmarks; model-render arrows are not source evidence. For each unsupported feature, report its elementId as kind "extra", severity "major", and request removal of the feature while preserving any source-evidenced door opening.
- Also audit SOURCE feature occurrences for omissions: trace explicit entrance/exit callout leaders to their targets, and check every restroom, lift, stair and wheelchair seating-space symbol against the feature array. Source-evidenced accessibility qualifiers and named exit destinations must survive in feature.label. A generic seating feature loses the meaning of a wheelchair seating space unless its label retains that qualifier. A wheelchair icon qualifying a room or facility is NOT evidence of seating: retain "accessible" in that room/facility's label instead, and do not demand an unsupported point-feature kind. Do not classify an unlabeled crossed square as a lift without supporting notation or a source legend.
- Audit door POSITIONS, not just existence: a door must sit at the center of its drawn gap or swing. A door emitted at a wall corner or junction while the drawn gap is elsewhere on that wall is a misplaced finding (major — a blind reader would walk to the wrong spot). Two emitted doors within about a door-width of each other on the same small room usually means one drawn opening was reported twice: verify each against the source and report the extra.
- Audit source openings in every detail view as well as emitted doors. Two aligned wall strokes that visibly terminate around a plausible doorway-width gap are direct evidence of an open passage even without a swing arc. Report that opening as missing when the model has no door there. Do not promote an arbitrary missing boundary or large unbounded area to a door.
- Entrance/exit arrows at the building perimeter mark gates: where the drawing shows the perimeter open or gapped at an arrow, the model needs an opening there. An entrance feature with a solid extracted wall through its gate, when the source shows a gap, is a missing opening (major).
- Every drawn stair flight gets exactly one stairs feature at that flight, not a point averaged between separate flights with a shared caption. Tread lines (the short parallel rungs) must never be traced as walls; a cluster of short parallel walls over a drawn flight is an extra finding.
- A directional callout such as "down to [exit]" pointing to stairs requires that stairs feature with the complete route label, not an extra exit at the same point. An exit feature requires evidence of the actual exit on the depicted level. Check the physical target and level, not just the word "exit" in text.
- A drawn external street band is a road, not a room, even on an indoor-focused plan. Preserve its name and drawn footprint without inventing a street from text alone.
- Compare BOTH edges of each rendered road band with the source. Its points are a centerline midway between the edges, and widthPx is perpendicular edge separation, not distance from the image origin. Flag a boundary used as centerline or a band spilling into neighboring space. Respect curved/tapering bands and explicitly unresolved clipped edges.
- A sealed room is not evidence of a missing door. Report a missing door only when the source visibly shows the opening.
- For EVERY finding, set "at" to the approximate {x, y} full-plan pixel location of the problem (the missing element's position, or the misplaced element's correct position). The refiner receives a zoomed crop centered there, so accurate coordinates directly improve the fix.
- Trace L-, U-, and T-shaped wall networks junction by junction. Check every short leg and stub; missing or disconnected segments are MAJOR when they change how a person would navigate.
- Trace exterior strokes between their endpoints and corner joins, including strokes directly against the image/crop edge. A visible thick perimeter run is not an open approach merely because the drawing is cropped or the adjacent floor has colored fill. Conversely, never close a genuinely blank crop edge. Compare source ink at the claimed opening, not an assumed complete or incomplete building outline.
- Check every curved wall and curved room boundary. A curve omitted or flattened to a single chord is a "misplaced" finding (or "missing" when absent) and severity "major" when it changes the navigable shape.
- severity "major" = would mislead a blind reader navigating (missing room, wall, door, or feature; badly wrong geometry). "minor" = cosmetic or small offsets.
- Use element ids from the JSON for extra/misplaced/mislabeled findings; elementId null for missing ones.
- confidenceAdjustments: for elements you verified match the plan well, raise confidence; for dubious ones, lower it. Only include elements you actually assessed.
- verdict "pass" when the model faithfully captures the plan's structure with no major findings.` + STRUCTURED_OUTPUT_INSTRUCTION

type CritiqueParams = {
  planParts: MessagePart[]
  overlayParts: MessagePart[]
  renderPngBase64: string
  modelJson: string
  structuralAudit?: string | null
  sourceInventory?: string
  previousFindings?: Critique['findings']
  reviewRegions?: ReviewRegion[]
  regionalParts?: MessagePart[][]
  regionalPlanParts?: MessagePart[][]
}

export function combineRegionalCritiques(reviews: Critique[]): Critique {
  const confidence = new Map<string, number>()
  for (const review of reviews) for (const adjustment of review.confidenceAdjustments) {
    confidence.set(adjustment.elementId, Math.min(confidence.get(adjustment.elementId) ?? 1, adjustment.confidence))
  }
  return critiqueSchema.parse({
    verdict: reviews.every(review => review.verdict === 'pass') ? 'pass' : 'needs_refinement',
    findings: [...new Map(reviews.flatMap(review => review.findings).map(finding => [JSON.stringify(finding), finding])).values()],
    confidenceAdjustments: [...confidence].map(([elementId, confidence]) => ({ elementId, confidence })),
    regionChecks: reviews.flatMap(review => review.regionChecks ?? []),
  })
}

export async function runCritique(params: CritiqueParams): Promise<Critique> {
  if (params.regionalParts) {
    if (params.regionalParts.length !== params.reviewRegions?.length || params.regionalPlanParts?.length !== params.regionalParts.length) throw new Error('Regional review views and source details do not match their coordinate bounds')
    const results = await Promise.allSettled(params.regionalParts.map((overlayParts, index) =>
      withModelRetry(() => runCritiqueOnce({ ...params, overlayParts, planParts: params.regionalPlanParts![index]!,
        reviewRegions: [params.reviewRegions![index]!], regionalParts: undefined }))))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return combineRegionalCritiques(results.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    }))
  }
  return withModelRetry(() => runCritiqueOnce(params))
}

async function runCritiqueOnce(params: CritiqueParams): Promise<Critique> {
  const plan = JSON.parse(params.modelJson).plan as { widthPx: number; heightPx: number }
  const regions = params.reviewRegions ?? [{ region: 'full-plan', x0: 0, y0: 0, x1: plan.widthPx, y1: plan.heightPx }]
  const outputSchema = critiqueSchemaForRegions(regions)
  const structuredOutput = await runAgentTurn({
    agentName: 'Critique',
    description: 'Compares a floor plan against its extracted model',
    instruction: CRITIQUE_INSTRUCTION,
    model: MODEL_CRITICAL,
    outputSchema,
    parts: [
      { text: 'FOCUSED SOURCE ATTENTION VIEWS — verify these hints in the complete paired review below:' },
      ...params.planParts,
      ...(params.sourceInventory ? [{ text: `SOURCE-ONLY INVENTORY — independent observations to verify, not ground truth:\n${params.sourceInventory}` }] : []),
      ...(params.previousFindings?.length ? [{ text: `PREVIOUS REVIEWED CLAIMS — verify the changes; explain contrary source evidence before reversing a claim:\n${JSON.stringify(params.previousFindings)}` }] : []),
      { text: `PAIRED SOURCE / TOPOLOGY REVIEW — required regionChecks: ${JSON.stringify(regions)}. Report defects ONLY inside these bounds. Full-plan views and the complete JSON preserve context; neighboring regions are reviewed separately when not requested here.` },
      ...params.overlayParts,
      { text: 'EXTRACTED MODEL RENDER:' },
      { inlineData: { data: params.renderPngBase64, mimeType: 'image/png' } },
      ...(params.structuralAudit
        ? [{ text: params.structuralAudit }]
        : []),
      { text: `Extracted model JSON:\n${params.modelJson}` },
    ],
  })
  return critiqueSchema.parse(parseAgentOutput(outputSchema, structuredOutput, 'Critique'))
}
