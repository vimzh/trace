import { Resvg } from '@resvg/resvg-js'
import {
  aggregateConfidence,
  allElements,
  auditFloorModel,
  elementPosition,
  normalizeFloorModel,
  PARSE_TARGET_CONFIDENCE,
  renderFloorModelSvg,
  type FloorModel,
} from '@bumps/floor-model'
import { computeInkCoverage, type CoverageReport } from '../lib/coverage'
import { cropPlanImage, downscalePlanImage } from '../lib/rasterize'
import type { MessagePart } from './llm'
import { runCritique, type Critique } from './critique'
import { applyOpeningsAudit, runOpeningsAudit } from './openings-audit'
import { readPlanSource } from './source-reader'
import { buildReviewViews } from './review-views'
import {
  loadPlanImageParts,
  parsePlanImage,
  refineParse,
} from './parser'

// Five primary reviews, with at most two extra to verify a geometry-changing
// opening audit. Minor-only findings still exit early through shouldStop.
export const MAX_ITERATIONS = 5
const MAX_POST_AUDIT_REVIEWS = 2

export type ParseStage = 'parsing' | 'critiquing' | 'refining'

export type IterationSummary = {
  iteration: number
  aggregateConfidence: number
  findingsCount: number
  majorCount: number
  verdict: Critique['verdict']
}

export type ParseProgress = {
  stage: ParseStage
  iteration: number
  maxIterations: number
  aggregateConfidence: number | null
  history: IterationSummary[]
}

function applyConfidenceAdjustments(
  model: FloorModel,
  critique: Critique,
): FloorModel {
  if (critique.confidenceAdjustments.length === 0) return model
  const byId = new Map(
    critique.confidenceAdjustments.map((a) => [a.elementId, a.confidence]),
  )
  const adjust = <T extends { id: string; confidence: number }>(items: T[]) =>
    items.map((item) =>
      byId.has(item.id) ? { ...item, confidence: byId.get(item.id)! } : item,
    )
  return {
    ...model,
    walls: adjust(model.walls),
    openings: adjust(model.openings),
    rooms: adjust(model.rooms),
    features: adjust(model.features),
    furniture: adjust(model.furniture ?? []),
    paths: adjust(model.paths ?? []),
    roads: adjust(model.roads ?? []),
  }
}

function renderModelPngBase64(model: FloorModel): string {
  const svg = renderFloorModelSvg(model)
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: model.plan.widthPx },
  })
    .render()
    .asPng()
  return Buffer.from(
    downscalePlanImage(png, 'image/png') ?? png,
  ).toString('base64')
}

// Accept-with-warnings gate at the iteration cap: a broadly confident
// model with a handful of residual majors flags them for the human; a
// low-confidence or major-riddled model (the fabrication signature seen on
// transit diagrams) still fails outright.
export const ACCEPT_WITH_WARNINGS_MIN_CONFIDENCE = 0.75
export const ACCEPT_WITH_WARNINGS_MAX_MAJORS = 6

/**
 * Caps the confidence of every element a remaining major finding points
 * at, so the wizard's review queue surfaces exactly those places.
 */
export function flagFindingsForReview(
  model: FloorModel,
  critique: Critique,
): FloorModel {
  const flagged = new Set(
    critique.findings
      .filter((f) => f.severity === 'major' && f.elementId)
      .map((f) => f.elementId!),
  )
  if (flagged.size === 0) return model
  const cap = <T extends { id: string; confidence: number }>(items: T[]) =>
    items.map((item) =>
      flagged.has(item.id)
        ? { ...item, confidence: Math.min(item.confidence, 0.55) }
        : item,
    )
  return {
    ...model,
    features: cap(model.features),
    furniture: cap(model.furniture ?? []),
    openings: cap(model.openings),
    paths: cap(model.paths ?? []),
    roads: cap(model.roads ?? []),
    rooms: cap(model.rooms),
    walls: cap(model.walls),
  }
}

/** A warning is safe only when the editor can surface every major finding. */
export function canSurfaceMajorFindings(
  model: FloorModel,
  critique: Critique,
): boolean {
  const validIds = new Set(allElements(model).map((element) => element.id))
  return critique.findings
    .filter((finding) => finding.severity === 'major')
    .every(
      (finding) =>
        finding.elementId !== null && validIds.has(finding.elementId),
    )
}

export function shouldStop(
  critique: Critique,
  aggregate: number,
  iteration: number,
): boolean {
  const hasMajor = critique.findings.some((f) => f.severity === 'major')
  if (hasMajor) return false
  if (critique.verdict === 'pass') return true
  if (aggregate >= PARSE_TARGET_CONFIDENCE) return true
  // Credit guard: once two reviewed iterations leave only minor findings,
  // another parse+critique round buys cosmetics the editor handles better.
  return iteration >= 2
}

/**
 * Deterministic mechanical cleanup of a fresh parse; a normalization bug
 * must degrade to the raw model, never fail the parse.
 */
function normalizeSafely(model: FloorModel): { model: FloorModel; notes: string[] } {
  try {
    return normalizeFloorModel(model)
  } catch (error) {
    console.error('[parse] model normalization failed; using raw parse', error)
    return { model, notes: [] }
  }
}

/**
 * Reuse bounded source crops for independently located details and review
 * findings, with full-plan coordinates rather than geometry inferred from text.
 */
function sourceZoomParts(
  planBytes: Uint8Array,
  mimeType: string,
  dimensions: { widthPx: number; heightPx: number },
  findings: { at: { x: number; y: number } | null; description: string; severity?: 'minor' | 'major' }[],
  label: string,
): MessagePart[] {
  const { heightPx, widthPx } = dimensions
  const ordered = [...findings].sort(
    (a, b) => Number(b.severity === 'major') - Number(a.severity === 'major'),
  )
  const parts: MessagePart[] = []
  const used: { x: number; y: number }[] = []
  for (const finding of ordered) {
    const at = finding.at
    if (!at) continue
    if (used.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < 150)) continue
    const half = 190
    const x0 = Math.max(0, Math.round(at.x - half))
    const y0 = Math.max(0, Math.round(at.y - half))
    const x1 = Math.min(widthPx, Math.round(at.x + half))
    const y1 = Math.min(heightPx, Math.round(at.y + half))
    if (x1 - x0 < 40 || y1 - y0 < 40) continue
    let crop: Uint8Array
    try {
      crop = cropPlanImage(
        planBytes,
        mimeType,
        {
          height: (y1 - y0) / heightPx,
          left: x0 / widthPx,
          top: y0 / heightPx,
          width: (x1 - x0) / widthPx,
        },
        800,
      )
    } catch {
      continue
    }
    used.push(at)
    parts.push(
      {
        text: `${label} — full-plan pixel bounds x=${x0}..${x1}, y=${y0}..${y1}; observation: ${finding.description}`,
      },
      { inlineData: { data: Buffer.from(crop).toString('base64'), mimeType: 'image/png' } },
    )
    if (used.length >= 4) break
  }
  return parts.length > 0
    ? [
        {
          text: 'ZOOMED SOURCE VIEWS — observations are unverified attention hints, not established errors or geometry. Inspect the pixels and report coordinates in FULL PLAN space:',
        },
        ...parts,
      ]
    : []
}

function openingGeometry(model: FloorModel): string {
  return JSON.stringify([
    model.openings.map(({ confidence: _confidence, ...opening }) => opening),
    model.features.filter(feature => feature.kind === 'entrance' || feature.kind === 'exit')
      .map(({ confidence: _confidence, ...feature }) => feature),
  ])
}

/** Opening edits are proposals too: changed geometry must return to source review. */
async function auditAcceptedOpenings(
  model: FloorModel,
  planBytes: Uint8Array,
  mimeType: string,
) {
  const ops = await runOpeningsAudit({ mimeType, model, planBytes })
  const applied = applyOpeningsAudit(model, ops)
  if (applied.notes.length > 0) {
    console.log(`[parse] openings audit: ${applied.notes.join('; ')}`)
  }
  const changed =
    JSON.stringify(applied.model.openings) !== JSON.stringify(model.openings)
  const audited = changed ? normalizeSafely(applied.model).model : model
  const attention = ops.filter(op => op.op !== 'keep').flatMap(op => {
    const at = op.at ?? model.openings.find(opening => opening.id === op.id)?.at
    return at ? [{ at, description: `Opening audit ${op.op} ${op.id ?? 'new gate'}: ${op.reason}. Verify the resulting wall/opening geometry against the source; deleting a record alone does not fill a false physical wall gap.` }] : []
  })
  return { changed, model: audited, attention,
    geometryChanged: openingGeometry(model) !== openingGeometry(audited) }
}

/**
 * Code-computed attention hints for the critique and refine agents:
 * geometric audit findings, bidirectional ink hints, and normalization notes.
 * Located pixel discrepancies also steer the existing bounded review crops.
 */
function buildStructuralAudit(
  model: FloorModel,
  planBytes: Uint8Array | null,
  mimeType: string | null,
  notes: string[],
): { text: string | null; locations: { at: { x: number; y: number }; description: string }[] } {
  const lines: string[] = []
  const locations: { at: { x: number; y: number }; description: string }[] = []
  try {
    for (const finding of auditFloorModel(model)) {
      lines.push(`- [${finding.kind}] ${finding.message}`)
    }
  } catch (error) {
    console.error('[parse] structural audit failed', error)
  }

  let coverage: CoverageReport | null = null
  if (planBytes && mimeType) {
    try {
      coverage = computeInkCoverage(planBytes, mimeType, model)
    } catch (error) {
      console.error('[parse] coverage audit failed', error)
    }
  }
  if (coverage) {
    for (const connection of coverage.missingConnections) {
      const description = `A short endpoint gap between ${connection.wallIds.join(' and ')} has continuous dark source ink through its middle. Generous coverage padding can hide a missing wall return here. Inspect the actual source junction; do not join it unless a physical boundary is visible.`
      lines.push(`- [short-connection] At (${connection.at.x}, ${connection.at.y}): ${description}`)
      locations.push({ at: connection.at, description })
    }
    for (const wall of coverage.unsupportedWalls) {
      const description = `${wall.elementId} has weak or centrally interrupted dark source ink (${Math.round(wall.supportRatio * 100)}% of sampled interior supported). Check the middle of the segment as well as its endpoints: junction ink can hide an invented connection across open floor. Verify against the source; do not remove it from the measurement alone.`
      lines.push(`- [wall-support] At (${wall.at.x}, ${wall.at.y}): ${description}`)
      locations.push({ at: wall.at, description })
    }
    const percent = Math.round(coverage.coveredInkRatio * 100)
    if (coverage.regions.length > 0) {
      const boxes = coverage.regions
        .map((r) => `x ${r.x0}-${r.x1}, y ${r.y0}-${r.y1}`)
        .join('; ')
      lines.push(
        `- [coverage] Extracted geometry accounts for ~${percent}% of the source's dark linework. Densest uncovered linework (full-plan pixels): ${boxes}. Each region may be a missed wall, room, or symbol — or just text, dimensioning, or hatching; judge from the image.`,
      )
      const uncoveredLocations = coverage.regions.map((region) => ({
        at: { x: (region.x0 + region.x1) / 2, y: (region.y0 + region.y1) / 2 },
        description: `Uncovered source linework in x=${region.x0}..${region.x1}, y=${region.y0}..${region.y1}. Verify missing structure versus text, symbols or decoration; the inventory may be wrong.`,
      }))
      // Interleave the two error directions so false-positive wall hints cannot
      // consume every focused crop while missing source boundaries stay text-only.
      const wallLocations = locations.splice(0)
      for (let i = 0; i < Math.max(wallLocations.length, uncoveredLocations.length); i++) {
        if (wallLocations[i]) locations.push(wallLocations[i]!)
        if (uncoveredLocations[i]) locations.push(uncoveredLocations[i]!)
      }
    } else if (coverage.coveredInkRatio < 0.5) {
      lines.push(
        `- [coverage] Extracted geometry accounts for only ~${percent}% of the source's dark linework, spread diffusely. Check whether whole element classes were under-extracted.`,
      )
    }
  }

  for (const note of notes) {
    lines.push(`- [normalization] Code already ${note}.`)
  }
  return { locations, text: lines.length === 0 ? null : `DETERMINISTIC STRUCTURAL AUDIT — computed by code from the extracted geometry and a pixel-coverage comparison. These are attention directives, NOT confirmed errors: verify each against the source image and dismiss any the image does not support.\n${lines.join('\n')}` }
}

export async function runParseLoop(params: {
  planPath: string
  dimensions: { widthPx: number; heightPx: number }
  onProgress: (progress: ParseProgress) => Promise<void>
  saveIteration: (
    model: FloorModel,
    iteration: number,
    critique: Critique | null,
  ) => Promise<void>
}): Promise<void> {
  const { dimensions, onProgress, planPath, saveIteration } = params
  const history: IterationSummary[] = []
  let reviewLimit = MAX_ITERATIONS
  const progress = async (
    stage: ParseStage,
    iteration: number,
    aggregate: number | null,
  ) =>
    onProgress({
      aggregateConfidence: aggregate,
      history,
      iteration,
      maxIterations: reviewLimit,
      stage,
    })

  await progress('parsing', 1, null)
  const planParts = await loadPlanImageParts(planPath)
  const source = planParts.find(
    (part): part is Extract<MessagePart, { inlineData: unknown }> =>
      'inlineData' in part,
  )?.inlineData
  if (!source) throw new Error('Parser did not load the source plan image')
  // One source frame keeps the semantic reader from mixing enlarged-crop
  // coordinates into its inventory. Tracing and review still use all details.
  const inventory = await readPlanSource([{ inlineData: source }], dimensions)
  const sourceInventory = JSON.stringify(inventory)
  const planBytes = Buffer.from(source.data, 'base64')
  const sourceDetails = inventory.structuralDetails.map(({ at, evidence }) => ({ at, description: evidence }))
  const sourceDetailParts = sourceZoomParts(planBytes, source.mimeType, dimensions,
    sourceDetails,
    'SOURCE DETAIL TO VERIFY')
  const parsed = normalizeSafely(await parsePlanImage(planPath, dimensions, sourceInventory, sourceDetailParts))
  let model = parsed.model
  let normalizationNotes = parsed.notes
  let auditedGeometry: string | null = null
  let auditAttention: { at: { x: number; y: number }; description: string }[] = []

  // The last model a critique actually reviewed, for salvage when a later
  // model call dies mid-loop (credit exhaustion, provider outage): reviewed
  // work is never thrown away if it meets the accept-with-warnings bar.
  let lastReviewed: { critique: Critique; model: FloorModel } | null = null
  const salvageLastReviewed = async (cause: string): Promise<boolean> => {
    if (!lastReviewed) return false
    const aggregate = aggregateConfidence(lastReviewed.model)
    const majors = lastReviewed.critique.findings.filter(
      (f) => f.severity === 'major',
    ).length
    if (
      aggregate < ACCEPT_WITH_WARNINGS_MIN_CONFIDENCE ||
      majors > ACCEPT_WITH_WARNINGS_MAX_MAJORS ||
      !canSurfaceMajorFindings(lastReviewed.model, lastReviewed.critique)
    ) {
      return false
    }
    const flagged = flagFindingsForReview(lastReviewed.model, lastReviewed.critique)
    const audited = openingGeometry(flagged) === auditedGeometry
      ? { geometryChanged: false, model: flagged }
      : await auditAcceptedOpenings(flagged, planBytes, source.mimeType)
    // A provider failure cannot turn a new, unreviewed audit edit into success.
    if (audited.geometryChanged) return false
    console.warn(
      `[parse] ${cause}; salvaging last reviewed model with ${majors} major finding${majors === 1 ? '' : 's'} flagged`,
    )
    await saveIteration(audited.model, MAX_ITERATIONS + 1, null)
    return true
  }

  for (let iteration = 1; iteration <= reviewLimit; iteration++) {
    await progress('critiquing', iteration, aggregateConfidence(model))
    const structuralAudit = buildStructuralAudit(
      model,
      planBytes,
      source.mimeType,
      normalizationNotes,
    )
    if (auditAttention.length) {
      structuralAudit.text = [structuralAudit.text,
        `OPENINGS AUDIT OBSERVATIONS — verify, not ground truth:\n${auditAttention.map(item => item.description).join('\n')}`,
      ].filter(Boolean).join('\n\n')
    }
    let critique: Critique
    try {
      // Verify the previous corrections at the same magnification before using
      // remaining crop slots for new audit hints or static inventory details.
      const reviewDetails = sourceZoomParts(planBytes, source.mimeType, dimensions,
        [...(lastReviewed?.critique.findings ?? []), ...auditAttention, ...structuralAudit.locations, ...sourceDetails], 'SOURCE DETAIL TO VERIFY')
      const reviewViews = buildReviewViews(model, source)
      const regional = iteration === 1 && Math.max(dimensions.widthPx, dimensions.heightPx) >= 1200
      critique = await runCritique({
        modelJson: JSON.stringify(model),
        overlayParts: reviewViews.parts,
        planParts: reviewDetails,
        reviewRegions: reviewViews.regions,
        // Large plans get independent first-pass coverage; later reviews reconcile the whole model.
        regionalParts: regional ? reviewViews.regionalParts : undefined,
        // Each specialist receives its own source-reader details, including
        // locations beyond the first four in the whole-plan inventory.
        regionalPlanParts: regional ? reviewViews.regions.map(region =>
          sourceZoomParts(planBytes, source.mimeType, dimensions,
            [...sourceDetails, ...structuralAudit.locations].filter(({ at }) =>
              at.x >= region.x0 && at.x <= region.x1 && at.y >= region.y0 && at.y <= region.y1),
            'REGIONAL SOURCE DETAIL TO VERIFY')) : undefined,
        renderPngBase64: renderModelPngBase64(model),
        structuralAudit: structuralAudit.text,
        sourceInventory,
        previousFindings: lastReviewed?.critique.findings,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (await salvageLastReviewed(`critique failed (${message.slice(0, 120)})`)) {
        return
      }
      throw new Error(`Critique unavailable; parse was not accepted: ${message}`)
    }
    // Drop adjustments pointing at ids that don't exist.
    const validIds = new Set(allElements(model).map((e) => e.id))
    critique.confidenceAdjustments = critique.confidenceAdjustments.filter(
      (a) => validIds.has(a.elementId),
    )
    model = applyConfidenceAdjustments(model, critique)
    lastReviewed = { critique, model }
    const aggregate = aggregateConfidence(model)
    history.push({
      aggregateConfidence: aggregate,
      findingsCount: critique.findings.length,
      iteration,
      majorCount: critique.findings.filter((f) => f.severity === 'major').length,
      verdict: critique.verdict,
    })
    await saveIteration(model, iteration, critique)

    const majorCount = critique.findings.filter(
      (finding) => finding.severity === 'major',
    ).length
    const accepted =
      shouldStop(critique, aggregate, iteration) ||
      (iteration === reviewLimit && majorCount === 0)
    // At the iteration cap a broadly-sound model with residual majors is
    // still far more useful flagged for human review than a hard failure —
    // the editor exists exactly for this. Persistent low confidence or a
    // pile of majors still fails: that is the fabrication signature.
    const acceptedWithWarnings =
      !accepted &&
      iteration === reviewLimit &&
      aggregate >= ACCEPT_WITH_WARNINGS_MIN_CONFIDENCE &&
      majorCount <= ACCEPT_WITH_WARNINGS_MAX_MAJORS &&
      canSurfaceMajorFindings(model, critique)
    if (accepted || acceptedWithWarnings) {
      if (acceptedWithWarnings) {
        model = flagFindingsForReview(model, critique)
        console.warn(
          `[parse] accepted with warnings: ${majorCount} major finding${majorCount === 1 ? '' : 's'} flagged for review`,
        )
      }
      const audited = openingGeometry(model) === auditedGeometry
        ? { changed: false, geometryChanged: false, model, attention: [] }
        : await auditAcceptedOpenings(model, planBytes, source.mimeType)
      auditedGeometry = openingGeometry(audited.model)
      if (audited.geometryChanged) {
        model = audited.model
        auditAttention = audited.attention
        lastReviewed = null
        // At most two extra reviews let the existing loop verify/fix the audit's
        // consequences; another late change fails rather than extending forever.
        reviewLimit = Math.max(reviewLimit, Math.min(MAX_ITERATIONS + MAX_POST_AUDIT_REVIEWS, iteration + MAX_POST_AUDIT_REVIEWS))
        if (iteration >= reviewLimit) throw new Error('Opening audit changed geometry at the review limit; source verification is incomplete')
        continue
      }
      if (audited.changed || acceptedWithWarnings) {
        await saveIteration(audited.model, iteration + 1, null)
      }
      return
    }
    if (iteration === reviewLimit) {
      throw new Error(
        `Parse did not pass review after ${reviewLimit} iterations: ${majorCount} major finding${majorCount === 1 ? ' remains' : 's remain'}`,
      )
    }
    await progress('refining', iteration + 1, aggregate)
    try {
      const refined = normalizeSafely(
        await refineParse(
          planPath,
          dimensions,
          model,
          JSON.stringify(critique.findings),
          structuralAudit.text,
          [...sourceDetailParts, ...sourceZoomParts(planBytes, source.mimeType, model.plan,
            critique.findings.map((finding) => ({ ...finding,
              at: finding.at ?? (finding.elementId ? elementPosition(model, finding.elementId) : null),
            })), 'REVIEW FINDING TO VERIFY')],
          sourceInventory,
        ),
      )
      model = refined.model
      normalizationNotes = refined.notes
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (await salvageLastReviewed(`refinement failed (${message.slice(0, 120)})`)) {
        return
      }
      throw new Error(`Refinement failed; reviewed parse was saved: ${message}`)
    }
  }
}
