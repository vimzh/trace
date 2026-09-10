// Source-only semantic inventory, kept separate from coordinate-heavy tracing and its render.
import { z } from 'zod'
import { featureKinds } from '@bumps/floor-model'
import { llmPointSchema, MODEL_CRITICAL, parseAgentOutput, runAgentTurn, STRUCTURED_OUTPUT_INSTRUCTION, type MessagePart } from './llm'
import { withModelRetry } from './retry'

const sourceDetailSchema = z.object({
  at: llmPointSchema,
  evidence: z.string().min(1).max(500),
}).strict()

export const sourceInventorySchema = z.object({
  landmarks: z.array(z.object({
    category: z.enum(['space', 'feature', 'fixed-landmark']),
    label: z.string().max(200).nullable(),
    featureKind: z.enum(featureKinds).nullable(),
    at: llmPointSchema,
    evidence: z.string().min(1).max(500),
  }).strict()).max(2_000),
  openConnections: z.array(sourceDetailSchema).max(2_000),
  structuralDetails: z.array(sourceDetailSchema).max(2_000),
  notation: z.array(z.string().max(500)).max(100),
  omit: z.array(z.string().max(500)).max(100),
}).strict()

export type SourceInventory = z.infer<typeof sourceInventorySchema>

export const SOURCE_READER_INSTRUCTION = `Read this source plan for a blind visitor before any geometry is traced. Your job is meaning and navigation, not drawing walls or fitting a plate. Inspect the SOURCE only; do not guess a venue from its filename.

Return a compact, source-grounded inventory:
- landmarks: every legible destination name, explicit navigation/accessibility feature, and distinct significant fixed landmark. Give its approximate location in FULL PLAN pixels and a short description of visible evidence. Keep exact printed names; no square-footage figures, dimensions, page titles or explanatory paragraphs as destinations. category=space for rooms/open departments, feature for point facilities, fixed-landmark for a counter/stage/fountain/stack. featureKind is null unless a supported point feature is evidenced. label is null when no name/qualifier is evidenced, not an invented proper name. Repeated anonymous furniture need not be individually inventoried: describe its grouping in notation, preserving aisles for the tracer.
- Interpret architectural symbols in context. A toilet bowl attached to a cistern, repeated inside stalls beside washbasins/urinals, establishes a restroom, not a set of tables or offices. Record one restroom facility per distinct restroom zone, not a feature per fixture; do not infer gender from pink/blue fill. A wheelchair symbol qualifies its associated room or facility: use enclosing space, nearby text, callouts and the source legend to identify the association, then preserve the accessibility qualifier in that room/facility label. Use featureKind=seating only for an evidenced wheelchair seating position or seating area; a wheelchair symbol at a restroom or other facility does not establish a seat. If its association is unclear, record that uncertainty without inventing a seating feature or a new feature kind. An unlabeled crossed square does not by itself establish a lift.
- For an unnamed but unambiguous fixture-defined restroom, use the conservative generic functional label "restroom" and state in evidence that it is inferred from fixtures. This preserves function without inventing a printed name, gender, or storage use.
- Follow entrance/exit callout leaders to their targets and preserve destination qualifiers. A directional route such as "down to [exit]" labels the drawn stairs, not an additional exit on this floor; inventory the physical feature at the leader target with the complete route label. Separate drawn stair flights need separate locations even when they share a caption. Decode the source legend, but do not inventory its sample icons. A printed icon's bounding box is not proof of a solid obstacle footprint.
- Visitor schematics may identify facilities through conventional badges instead of drawing plumbing fixtures. Paired W/M amenity badges in restroom/service-core context can establish restroom facilities; do not require fixture drawings as additional proof. A lone unexplained letter remains ambiguous. Preserve the printed abbreviation and any evidenced accessibility qualifier in the facility label.
- An ordinary door swing or a doorway to outdoors is an opening, not an entrance/exit FEATURE. Do not put such doors in landmarks as entrance/exit unless explicit source text, an entrance/exit symbol or a callout marks them. You may describe their evidenced connections in openConnections instead.
- info-point/reception require staffed service. Do not classify unsupported device icons such as self-checkout terminals or phone chargers as staffed facilities; put incidental operational markers in omit instead. A named technology room or copy-service desk remains a visitor destination, and a large visibly drawn equipment bank may remain a fixed landmark. Do not infer a physical bank from an icon alone.
- Apply that filter before adding ANY landmark category: a symbol-only copier, printer, charger or terminal belongs in omit, not fixed-landmark. A legend decoding an icon identifies the device, not a physical footprint or a new visitor destination. Preserve a separately named service area and significant independently drawn equipment footprint; do not promote its icon box into an obstacle.
- openConnections: notable open approaches and circulation links that the source clearly shows must remain traversable, especially unbounded/cropped entries, aisles between fixed banks, and passages between named open zones. Give location plus the two source spaces or visible bounds. Do not invent doors just to connect a sealed room. Inspect the actual crop-edge ink: a thick stroke joined to the physical perimeter remains a wall even at the image edge, not an open approach or decorative frame. Locate ambiguous edge strokes in structuralDetails; colored floor fill does not erase their physical boundary.
- A thick boundary stroke occupying the last image pixels and joined to another structural wall is not ambiguous merely because its outer side is clipped; record the visible run and its joins in structuralDetails.
- Inspect repeated seating/shelving in both directions: distinguish ordinary row spacing from a wider transverse aisle separating front/rear blocks, including gaps beside wheelchair positions. Locate each such cross-aisle in openConnections with its visible bank edges; do not inventory only the central and perimeter aisles. A symbol covering part of a gap is not furniture filling the gap.
- structuralDetails: locate easily missed details that change navigation: short restroom privacy/stall partitions, short wall returns, curved boundaries, and specific ambiguous boundary-versus-decoration segments. For each, give an approximate FULL PLAN pixel location and evidence identifying the nearby named space or visible fixtures, the segment's shape/endpoints/junctions, and any adjacent passage that must remain open. Distinguish decorative frame segments from structural portions using visible wall joins, doorways and line conventions; do not discard a physical return along with ornament. Explicitly state uncertainty when the source cannot resolve it. These are focused locations for closer inspection, not generic reminders or an inventory of every wall. Do not infer walls from room polygon edges, colored zone boundaries or assumed room closure, and do not close an evidenced open connection to complete an outline.
- notation: the drawing's actual wall/door/curve conventions and any important ambiguity. Preserve any printed plan title and compass direction here for metadata, not as destinations. Identify drawn external street bands as roads, not rooms, even on an indoor-focused plan. Distinguish a physical wall from a room-color change, furniture edge, door swing or decorative frame. Put specific navigation-changing curves/short partitions in structuralDetails with their locations.
- Locate pale gray or glazed spans bridging solid wall ends in structuralDetails too: record their endpoints and put "at" at the span's center for a focused crop. They can be physical boundaries even when dark-ink checks miss them; distinguish them from isolated decorative frames using wall continuity and source notation.
- Structural-detail locations drive magnified crops. Center each location on the actual curved/missed span rather than a nearby caption or one remote endpoint. For a long curve with distant returns, record the distinct center/return details separately with their endpoints so no single end crop is expected to show the whole boundary.
- For a drawn street band, describe both visible edges in FULL PLAN coordinates and its approximate perpendicular width; distinguish a boundary line from the band's centerline. If an edge is clipped or hidden, record that uncertainty instead of inventing a symmetric width around the one visible edge.
- omit: visible non-navigation content the tracer should ignore, such as dimensioning, floor-area measurements, page frames, legend samples, individual movable chairs, small toilet/sink fixtures, rugs, trees used as decoration, or technology/electrical symbols. Do not omit structural privacy partitions or a named visitor destination along with its small fixtures.

Use one inventory entry per source location. Separate distant named zones rather than concatenating the whole floor into one label. This is evidence for another agent to verify, not permission to invent geometry. Unreadable or ambiguous details should remain explicitly uncertain in evidence.` + STRUCTURED_OUTPUT_INSTRUCTION

export function sourceInventorySchemaForDimensions(
  dimensions: { widthPx: number; heightPx: number },
) {
  return sourceInventorySchema.superRefine((inventory, context) => {
    for (const item of [...inventory.landmarks, ...inventory.openConnections, ...inventory.structuralDetails]) {
      if (item.at.x < 0 || item.at.y < 0 || item.at.x > dimensions.widthPx || item.at.y > dimensions.heightPx) {
        context.addIssue({ code: 'custom', message: 'Inventory locations must be within the full-plan pixel dimensions' })
      }
    }
  })
}

export async function readPlanSource(
  planParts: MessagePart[],
  dimensions: { widthPx: number; heightPx: number },
): Promise<SourceInventory> {
  const outputSchema = sourceInventorySchemaForDimensions(dimensions)
  return withModelRetry(async () => parseAgentOutput(outputSchema, await runAgentTurn({
    agentName: 'Source reader',
    description: 'Identifies source destinations, facility meanings, open connections and easily missed structural details independently of traced geometry',
    instruction: SOURCE_READER_INSTRUCTION,
    model: MODEL_CRITICAL,
    outputSchema,
    parts: [{ text: `Source dimensions: ${dimensions.widthPx}x${dimensions.heightPx}.` }, ...planParts],
  }), 'Source reader'))
}
