import { z } from 'zod'
import {
  buildValidationContext,
  convertToTactile,
  plateGridCandidates,
  introducesAnchorViolation,
  textBrailleSize,
  validateTactileDesign,
  type TactileDesign,
  type FloorModel,
  type ValidationContext,
  type ValidationViolation,
} from '@bumps/floor-model'
import {
  STRUCTURED_OUTPUT_INSTRUCTION,
  MODEL_LAYOUT,
  parseAgentOutput,
  runAgentTurn,
} from './llm'
import { withModelRetry } from './retry'
import { repairOffThread } from '../tactile-repair'

export const MAX_LAYOUT_ITERATIONS = 4

// The agent may ONLY nudge braille labels and point symbols. It never touches
// lines, sizes, or heights — the validator (deterministic code) is the only
// authority on compliance.
export const layoutAgentOutputSchema = z.object({
  moves: z.array(
    z.object({
      elementId: z.string(),
      dxMm: z.number(),
      dyMm: z.number(),
    }),
  ).max(2_000),
})

type LayoutMove = z.infer<typeof layoutAgentOutputSchema>['moves'][number]

export function filterMovesForViolations(
  moves: LayoutMove[],
  violations: Pick<ValidationViolation, 'elementIds'>[],
): LayoutMove[] {
  const allowed = new Set(
    violations.flatMap((violation) => violation.elementIds),
  )
  return moves.filter((move) => allowed.has(move.elementId))
}

const INSTRUCTION = `You fix layout violations on a tactile map plate for blind readers.

You receive the plate design as JSON (elements with positions in millimeters), the scaled room polygons, and a list of violations from a deterministic standards validator.

Propose moves — {elementId, dxMm, dyMm} — for braille labels (kind "braille") and point symbols (kind "symbol") ONLY. You cannot move lines, resize anything, or remove anything.

Guidance:
- Braille labels read left-to-right from their "at" (top-left corner); use the exact supplied footprint dimensions. Keep each room's label INSIDE its room polygon.
- A label linked to a point symbol by sourceId must stay within 10 mm of that symbol without crossing a wall. A narrow room or furniture block that cannot contain its key may use an adjacent key within 10 mm, as directed by label-fit feedback. Preserve the legend-to-landmark association while clearing collisions.
- Exact footprint dimensions and immutable source landmark anchors are provided. A symbol must remain within 10 mm of its source, in its source room, and cannot cross a wall. Move a conflicting braille label instead when moving the landmark would misrepresent its location.
- Keep >= 3 mm clear space between any two elements (>= 6 mm between same-kind symbols), and >= 3 mm from walls (lines).
- Door symbols may stay on their wall; do not move them off it unless a violation names them.
- Prefer the smallest moves that clear ALL listed violations. Move only elements involved in violations.
- Everything must stay inside the plate margin.` + STRUCTURED_OUTPUT_INSTRUCTION

type LayoutAttempt = { moves: LayoutMove[]; accepted: boolean; remaining: ValidationViolation[] }

export function layoutMessage(design: TactileDesign, context: ValidationContext, violations: ValidationViolation[], attempts: LayoutAttempt[]): string {
  return [
    `Plate design JSON:\n${JSON.stringify(design)}`,
    `Room polygons (mm):\n${JSON.stringify(context.roomsMm)}`,
    `Immutable source landmark anchors (mm):\n${JSON.stringify(context.symbolAnchorsMm)}`,
    `Exact braille footprints (at = top left):\n${JSON.stringify(design.elements.filter(e => e.kind === 'braille').map(e => ({ id: e.id, ...textBrailleSize(e.key) })))}`,
    `Violations:\n${JSON.stringify(violations)}`,
    `Previous attempts and their actual validation results; do not repeat rejected moves:\n${JSON.stringify(attempts)}`,
  ].join('\n\n')
}

async function proposeMoves(
  design: TactileDesign,
  context: ValidationContext,
  violations: ValidationViolation[],
  attempts: LayoutAttempt[],
): Promise<LayoutMove[]> {
  return withModelRetry(async () => {
    const message = layoutMessage(design, context, violations, attempts)
    const structuredOutput = await runAgentTurn({
      agentName: 'Layout agent',
      description: 'Nudges braille labels and symbols to clear violations',
      instruction: INSTRUCTION,
      model: MODEL_LAYOUT,
      outputSchema: layoutAgentOutputSchema,
      parts: [{ text: message }],
    })
    return filterMovesForViolations(
      parseAgentOutput(layoutAgentOutputSchema, structuredOutput, 'Layout agent').moves,
      violations,
    )
  })
}

function applyMoves(
  design: TactileDesign,
  moves: { dxMm: number; dyMm: number; elementId: string }[],
): TactileDesign {
  const byId = new Map(moves.map((m) => [m.elementId, m]))
  return {
    ...design,
    elements: design.elements.map((element) => {
      const move = byId.get(element.id)
      if (!move) return element
      // Only braille and symbols are movable; ignore anything else.
      if (element.kind === 'braille' || element.kind === 'symbol') {
        return {
          ...element,
          at: { x: element.at.x + move.dxMm, y: element.at.y + move.dyMm },
        }
      }
      return element
    }),
  }
}

export type LayoutResult = {
  design: TactileDesign
  iterations: { moves: number; violations: number; accepted?: boolean; reason?: string }[]
  valid: boolean
  violations: ValidationViolation[]
}

export async function runTactileLayout(
  initial: TactileDesign,
  context: ValidationContext,
  sourceModel?: FloorModel,
): Promise<LayoutResult> {
  let design = initial
  let violations = validateTactileDesign(design, context)
  const iterations: LayoutResult['iterations'] = [
    { moves: 0, violations: violations.length },
  ]

  // The scale gate cannot be fixed by moving things — fail immediately.
  if (violations.some((v) => v.rule === 'scale')) {
    return { design, iterations, valid: false, violations }
  }

  // Geometry disposes first: seam-clearance is pure arithmetic, so it is
  // repaired deterministically; the agent only sees what needs judgment.
  const mechanicalPass = async () => {
    const fixed = await repairOffThread(design, context)
    if (fixed !== design) {
      const fixedViolations = validateTactileDesign(fixed, context)
      if (fixedViolations.length <= violations.length && !introducesAnchorViolation(violations, fixedViolations)) {
        design = fixed
        violations = fixedViolations
      }
    }
  }
  await mechanicalPass()
  if (violations.length !== iterations[0]!.violations) {
    // Record the deterministic repair as its own pass so the UI shows
    // e.g. 5 -> 0 even when the agent never runs.
    iterations.push({ moves: 0, violations: violations.length })
  }

  // Retained keys or crowded glyphs can need more room. Try larger scales
  // with the same exact validator before spending model calls on nudges.
  if (sourceModel && violations.some(violation => violation.rule === 'label-fit' || violation.rule === 'clearance')) {
    const deadline = performance.now() + 30_000
    const checkDeadline = () => {
      if (performance.now() >= deadline) {
        throw new Error('Tactile grid search exceeded 30 seconds. Split this dense plan into smaller sections, then try again.')
      }
    }
    const names = new Set(design.legend.map(entry => entry.text))
    const baseCount = design.grid.cols * design.grid.rows
    for (const [rows, cols] of plateGridCandidates(sourceModel)) {
      checkDeadline()
      if (rows * cols < baseCount) continue
      const candidate = convertToTactile(sourceModel, { rows, cols }).design
      if (candidate.mmPerPx <= design.mmPerPx + 1e-8) continue
      const candidateContext = buildValidationContext(sourceModel, candidate)
      const candidateViolations = validateTactileDesign(candidate, candidateContext)
      checkDeadline()
      if (candidateViolations.some(violation => violation.rule === 'scale')) continue
      const fixed = await repairOffThread(candidate, candidateContext, deadline - performance.now())
      const remaining = validateTactileDesign(fixed, candidateContext)
      checkDeadline()
      const candidateNames = new Set(fixed.legend.map(entry => entry.text))
      const accepted = remaining.length === 0 && [...names].every(name => candidateNames.has(name))
      iterations.push({ moves: 0, violations: remaining.length, accepted,
        reason: `${accepted ? 'Expanded' : 'Rejected expansion'} to ${cols}×${rows} plates; preserve all existing legend names and pass every constraint` })
      if (accepted) {
        design = fixed
        context = candidateContext
        violations = remaining
        break
      }
    }
    checkDeadline()
  }

  const attempts: LayoutAttempt[] = []
  let stalled = 0
  for (
    let iteration = 0;
    violations.length > 0 && iteration < MAX_LAYOUT_ITERATIONS;
    iteration++
  ) {
    const previousCount = violations.length
    const previousElements = JSON.stringify(design.elements)
    const moves = await proposeMoves(design, context, violations, attempts)
    const candidate = applyMoves(design, moves)
    const candidateViolations = validateTactileDesign(candidate, context)
    // Never accept a step that makes things worse.
    const accepted = candidateViolations.length <= violations.length
      && !introducesAnchorViolation(violations, candidateViolations)
    attempts.push({ moves, accepted, remaining: candidateViolations })
    if (accepted) {
      design = candidate
      violations = candidateViolations
    }
    await mechanicalPass()
    stalled = violations.length < previousCount ? 0 : stalled + 1
    const repeated = JSON.stringify(design.elements) === previousElements && attempts.length > 1
      && JSON.stringify(moves) === JSON.stringify(attempts.at(-2)!.moves)
    const stop = stalled >= 2 || repeated
    iterations.push({ moves: moves.length, violations: violations.length, accepted,
      ...(stop ? { reason: 'Stopped after repeated or non-improving layout attempts' } : {}) })
    if (stop) break
  }

  return { design, iterations, valid: violations.length === 0, violations }
}
