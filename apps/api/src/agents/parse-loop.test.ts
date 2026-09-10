import { beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import { sampleFloorModel, type FloorModel } from '@bumps/floor-model'
import type { Critique } from './critique'
import type { OpeningsAuditOp } from './openings-audit'

const parser = await import('./parser')
const critique = await import('./critique')
const openingsAudit = await import('./openings-audit')
const sourceReader = await import('./source-reader')

setDefaultTimeout(15_000)

const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

type MockFinding = {
  at: { x: number; y: number } | null
  description: string
  elementId: string | null
  kind: 'missing' | 'extra' | 'misplaced' | 'mislabeled'
  severity: 'major' | 'minor'
}

// Mutable so each test can steer what the mocked critic keeps reporting.
type CritiqueParams = Parameters<typeof critique.runCritique>[0]
type CapturedPart = { text?: string; inlineData?: { data: string; mimeType: string } }
const mockState: {
  findings: MockFinding[]; openingsError: Error | null; sequence: boolean
  initialModel: FloorModel
  review: ((params: CritiqueParams, call: number) => Critique) | null
  refine: ((previous: FloorModel, findings: string) => FloorModel) | null
  audit: ((model: FloorModel) => OpeningsAuditOp[]) | null
} = {
  findings: [],
  openingsError: null,
  sequence: false,
  initialModel: sampleFloorModel,
  review: null,
  refine: null,
  audit: null,
}
const inventory = { landmarks: [], openConnections: [], structuralDetails: [
  { at: { x: 400, y: 400 }, evidence: 'A short partition to verify, not an asserted wall.' },
], notation: ['source-only evidence'], omit: [] }
const inventoryHandoffs: string[] = []
const sourceReaderViews: unknown[][] = []
const priorReviewHandoffs: (MockFinding[] | undefined)[] = []
const detailHandoffs: CapturedPart[][] = []
const critiqueDetailHandoffs: CapturedPart[][] = []
const regionalDetailHandoffs: (CapturedPart[][] | undefined)[] = []
const reviewHandoffs: CritiqueParams[] = []
const refineHandoffs: { model: FloorModel; findings: string; audit: unknown; parts: { text?: string }[] }[] = []
const auditHandoffs: FloorModel[] = []
beforeEach(() => {
  Object.assign(mockState, {
    findings: [], openingsError: null, sequence: false,
    initialModel: sampleFloorModel, review: null, refine: null, audit: null,
  })
  reviewHandoffs.length = 0
  refineHandoffs.length = 0
  auditHandoffs.length = 0
})
mock.module('./source-reader', () => ({
  ...sourceReader,
  readPlanSource: async (parts: unknown[]) => {
    sourceReaderViews.push(parts)
    return inventory
  },
}))

mock.module('./parser', () => ({
  ...parser,
  loadPlanImageParts: async () => [
    { inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' } },
    { text: 'report coordinates in the FULL PLAN space' },
    ...Array.from({ length: 4 }, () => ({
      inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' },
    })),
  ],
  parsePlanImage: async (_path: string, _dimensions: unknown, sourceInventory: string, details: { text?: string }[]) => {
    inventoryHandoffs.push(sourceInventory)
    detailHandoffs.push(details)
    return mockState.initialModel
  },
  refineParse: async (_path: string, _dimensions: unknown, previous: FloorModel, findings: string, audit: unknown, parts: { text?: string }[], sourceInventory: string) => {
    inventoryHandoffs.push(sourceInventory)
    detailHandoffs.push(parts)
    refineHandoffs.push({ model: structuredClone(previous), findings, audit, parts })
    return mockState.refine ? mockState.refine(previous, findings) : mockState.initialModel
  },
}))

mock.module('./critique', () => ({
  ...critique,
  runCritique: async (params: CritiqueParams) => {
    inventoryHandoffs.push(params.sourceInventory ?? '')
    priorReviewHandoffs.push(params.previousFindings)
    detailHandoffs.push(params.planParts)
    critiqueDetailHandoffs.push(params.planParts)
    regionalDetailHandoffs.push(params.regionalPlanParts)
    reviewHandoffs.push(params)
    if (mockState.review) return mockState.review(params, reviewHandoffs.length)
    return ({
    confidenceAdjustments: [],
    findings: mockState.sequence
      ? mockState.findings.map((finding) => ({ ...finding, description: `Source claim ${priorReviewHandoffs.length}` }))
      : mockState.findings,
    verdict: 'needs_refinement',
    })
  },
}))

mock.module('./openings-audit', () => ({
  ...openingsAudit,
  runOpeningsAudit: async ({ model }: { model: FloorModel }) => {
    auditHandoffs.push(structuredClone(model))
    if (mockState.openingsError) throw mockState.openingsError
    return mockState.audit?.(model) ?? []
  },
}))

function majorFinding(elementId: string | null): MockFinding {
  return {
    at: null,
    description: 'A navigation-changing element is still wrong.',
    elementId,
    kind: 'missing',
    severity: 'major',
  }
}

// The opening object and the actual wall gap are separate: deleting one does
// not fill the other. This is the final-audit regression, not a rendering mock.
const auditGapModel: FloorModel = {
  ...sampleFloorModel, title: null, plan: { ...sampleFloorModel.plan, north: null },
  rooms: [], furniture: [], features: [], roads: [], paths: [],
  walls: [
    { id: 'left-wall', kind: 'wall', a: { x: 100, y: 400 }, b: { x: 400, y: 400 }, thickness: 4, confidence: 0.95 },
    { id: 'right-wall', kind: 'wall', a: { x: 460, y: 400 }, b: { x: 900, y: 400 }, thickness: 4, confidence: 0.95 },
  ],
  openings: [{ id: 'false-door', kind: 'door', at: { x: 430, y: 400 }, width: 60, wallId: null, confidence: 0.95 }],
}
const auditReason = 'Source wall is continuous across x=400..460 at y=400; the reported door is not drawn.'
const deleteFalseDoor: OpeningsAuditOp[] = [{ op: 'delete', id: 'false-door', reason: auditReason }]
const gapFinding: MockFinding = {
  ...majorFinding(null), at: { x: 430, y: 400 }, description: 'Missing continuous wall across the deleted door location.',
}
const reviewResult = (findings: MockFinding[] = []): Critique => ({
  findings, confidenceAdjustments: [], verdict: findings.length ? 'needs_refinement' : 'pass',
})
const gapFilled = (model: FloorModel) => model.walls.some(wall =>
  wall.a.y === 400 && wall.b.y === 400 &&
  Math.min(wall.a.x, wall.b.x) <= 400 && Math.max(wall.a.x, wall.b.x) >= 460,
)

describe('parse review gate', () => {
  test('re-reviews audit-deleted openings with located source evidence before refining the physical gap', async () => {
    mockState.initialModel = auditGapModel
    mockState.audit = () => deleteFalseDoor
    mockState.review = (params, call) => {
      const model = JSON.parse(params.modelJson) as FloorModel
      return call === 1 || gapFilled(model) ? reviewResult() : reviewResult([gapFinding])
    }
    mockState.refine = previous => ({ ...previous, walls: [...previous.walls, {
      id: 'repaired-wall', kind: 'wall', a: { x: 400, y: 400 }, b: { x: 460, y: 400 }, thickness: 4, confidence: 0.95,
    }] })
    const saved: { model: FloorModel; critique: Critique | null }[] = []
    const { runParseLoop } = await import('./parse-loop')
    await runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (model, _iteration, critique) => { saved.push({ model, critique }) },
    })
    expect(reviewHandoffs).toHaveLength(3)
    const auditedReview = reviewHandoffs[1]!
    const auditedModel = JSON.parse(auditedReview.modelJson) as FloorModel
    expect(auditedModel.openings).toHaveLength(0)
    expect(gapFilled(auditedModel)).toBe(false)
    expect(auditedReview.structuralAudit).toContain(auditReason)
    const cropIndex = auditedReview.planParts.findIndex(part => 'text' in part && part.text.includes(auditReason))
    expect(cropIndex).toBeGreaterThanOrEqual(0)
    expect(auditedReview.planParts[cropIndex]).toMatchObject({ text: expect.stringContaining('x=240..620, y=210..590') })
    expect(auditedReview.planParts[cropIndex + 1]).toHaveProperty('inlineData')
    expect(refineHandoffs).toHaveLength(1)
    expect(refineHandoffs[0]!.model.openings).toHaveLength(0)
    expect(refineHandoffs[0]!.findings).toContain(gapFinding.description)
    expect(gapFilled(saved.at(-1)!.model)).toBe(true)
    expect(saved.at(-1)!.model.openings).toHaveLength(0)
    expect(saved.at(-1)!.critique?.verdict).toBe('pass')
    // Wall repair does not change the already audited opening/gate geometry.
    expect(auditHandoffs).toHaveLength(1)
  })

  test('a confidence-only opening audit saves the update without an extra review', async () => {
    mockState.initialModel = auditGapModel
    mockState.review = () => reviewResult()
    mockState.audit = () => [{ op: 'keep', id: 'false-door', confidence: 0.5, reason: 'Ambiguous source; keep for human review.' }]
    const saved: FloorModel[] = []
    const { runParseLoop } = await import('./parse-loop')
    await runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async model => { saved.push(model) },
    })
    expect(reviewHandoffs).toHaveLength(1)
    expect(auditHandoffs).toHaveLength(1)
    expect(refineHandoffs).toHaveLength(0)
    expect(saved.at(-1)!.openings[0]!.confidence).toBe(0.5)
  })

  test('allows only two extra reviews after a fifth-pass audit and rejects an unresolved missing wall', async () => {
    const { MAX_ITERATIONS, runParseLoop } = await import('./parse-loop')
    mockState.initialModel = auditGapModel
    mockState.audit = () => deleteFalseDoor
    mockState.refine = previous => previous
    mockState.review = (_params, call) => reviewResult([
      call <= MAX_ITERATIONS ? majorFinding('left-wall') : gapFinding,
    ])
    const saved: (Critique | null)[] = []
    await expect(runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (_model, _iteration, critique) => { saved.push(critique) },
    })).rejects.toThrow(/review|audit|major/i)
    expect(reviewHandoffs).toHaveLength(MAX_ITERATIONS + 2)
    expect(auditHandoffs).toHaveLength(1)
    // Only reviewed iterations are persisted; rejection must not append a
    // pending audit proposal or an accepted salvage save.
    expect(saved.filter(critique => critique !== null)).toHaveLength(MAX_ITERATIONS + 2)
    expect(saved).toHaveLength(MAX_ITERATIONS + 2)
    expect(saved.at(-1)?.findings).toContainEqual(gapFinding)
    expect(JSON.parse(reviewHandoffs.at(-1)!.modelJson).openings).toHaveLength(0)
  })

  test('cannot salvage geometry changed by an audit after a refinement failure', async () => {
    mockState.initialModel = auditGapModel
    mockState.review = () => reviewResult([majorFinding('left-wall')])
    mockState.refine = () => { throw new Error('Provider unavailable during refinement') }
    mockState.audit = () => deleteFalseDoor
    const saved: (Critique | null)[] = []
    const { runParseLoop } = await import('./parse-loop')
    await expect(runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (_model, _iteration, critique) => { saved.push(critique) },
    })).rejects.toThrow(/refinement|audit|review/i)
    expect(reviewHandoffs).toHaveLength(1)
    expect(auditHandoffs).toHaveLength(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toBeNull()
  })

  test('fails when another geometry-changing audit reaches the absolute review cap', async () => {
    const { MAX_ITERATIONS, runParseLoop } = await import('./parse-loop')
    mockState.initialModel = auditGapModel
    mockState.review = (_params, call) => call < MAX_ITERATIONS + 2
      ? reviewResult([majorFinding('left-wall')]) : reviewResult()
    mockState.refine = previous => reviewHandoffs.length <= MAX_ITERATIONS ? previous : ({
      ...previous, openings: previous.openings.map(opening => ({ ...opening, width: opening.width + 5 })),
    })
    mockState.audit = model => model.openings.map(opening => ({
      op: 'move', id: opening.id, at: opening.at, width: opening.width + 10,
      reason: 'Source threshold is wider than the reviewed opening.',
    }))
    const saved: { model: FloorModel; critique: Critique | null }[] = []
    await expect(runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (model, _iteration, critique) => { saved.push({ model, critique }) },
    })).rejects.toThrow('Opening audit changed geometry at the review limit')
    expect(reviewHandoffs).toHaveLength(MAX_ITERATIONS + 2)
    expect(auditHandoffs).toHaveLength(2)
    expect(saved).toHaveLength(MAX_ITERATIONS + 2)
    expect(saved.every(entry => entry.critique !== null)).toBe(true)
    expect(saved.at(-1)!.model.openings[0]!.width).toBe(auditHandoffs.at(-1)!.openings[0]!.width)
  })

  test('cannot salvage an old model when its post-audit review is unavailable', async () => {
    mockState.initialModel = auditGapModel
    mockState.review = (_params, call) => {
      if (call > 1) throw new Error('Provider unavailable during post-audit review')
      return reviewResult()
    }
    mockState.audit = () => deleteFalseDoor
    const saved: (Critique | null)[] = []
    const { runParseLoop } = await import('./parse-loop')
    await expect(runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (_model, _iteration, critique) => { saved.push(critique) },
    })).rejects.toThrow(/critique|audit|review/i)
    expect(reviewHandoffs).toHaveLength(2)
    // The proposal was never reviewed: persist only the original reviewed model.
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toBeNull()
  })

  test('salvages a reviewed audited model without repeating an unchanged openings audit', async () => {
    mockState.initialModel = auditGapModel
    mockState.review = (_params, call) => call === 1 ? reviewResult() : reviewResult([majorFinding('left-wall')])
    mockState.audit = () => {
      if (auditHandoffs.length > 1) throw new Error('Unchanged reviewed openings must not be audited again')
      return deleteFalseDoor
    }
    mockState.refine = () => { throw new Error('Provider unavailable after post-audit review') }
    const saved: { model: FloorModel; critique: Critique | null }[] = []
    const { runParseLoop } = await import('./parse-loop')
    await runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async (model, _iteration, critique) => { saved.push({ model, critique }) },
    })
    expect(reviewHandoffs).toHaveLength(2)
    expect(refineHandoffs).toHaveLength(1)
    expect(auditHandoffs).toHaveLength(1)
    expect(JSON.parse(reviewHandoffs[1]!.modelJson).openings).toHaveLength(0)
    expect(saved).toHaveLength(3)
    expect(saved[0]!.critique).not.toBeNull()
    expect(saved[1]!.critique).not.toBeNull()
    expect(saved[2]!.critique).toBeNull()
    expect(saved[2]!.model.openings).toHaveLength(0)
    expect(saved[2]!.model.walls.find(wall => wall.id === 'left-wall')!.confidence).toBeLessThanOrEqual(0.55)
  })

  test('routes source detail crops to their regional reviewers rather than dropping them', async () => {
    regionalDetailHandoffs.length = 0
    mockState.findings = []
    mockState.openingsError = null
    const { runParseLoop } = await import('./parse-loop')
    await runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1600, heightPx: 1200 },
      onProgress: async () => {}, saveIteration: async () => {},
    })
    const regional = regionalDetailHandoffs[0]!
    expect(regional).toHaveLength(4)
    const inventoryDetail = (parts: { text?: string }[]) => parts.some(part => part.text?.includes(inventory.structuralDetails[0]!.evidence))
    // The sample model's (400,400) detail lies in both overlapping left views, not the right views.
    expect(regional.map(inventoryDetail)).toEqual([true, false, true, false])
  })

  test('passes the independent source inventory through extraction, review and refinement', async () => {
    inventoryHandoffs.length = 0
    sourceReaderViews.length = 0
    priorReviewHandoffs.length = 0
    critiqueDetailHandoffs.length = 0
    detailHandoffs.length = 0
    mockState.openingsError = null
    mockState.sequence = true
    mockState.findings = [{ ...majorFinding('w-div-bottom'), at: { x: 100, y: 100 } }]
    const { runParseLoop } = await import('./parse-loop')
    await runParseLoop({ planPath: '/tmp/plan.png', dimensions: { widthPx: 1000, heightPx: 800 },
      onProgress: async () => {}, saveIteration: async () => {},
    })
    expect(sourceReaderViews).toEqual([[{ inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' } }]])
    expect(inventoryHandoffs).toHaveLength(10)
    expect(inventoryHandoffs.every((value) => value === JSON.stringify(inventory))).toBe(true)
    expect(priorReviewHandoffs).toHaveLength(5)
    expect(priorReviewHandoffs[0]).toBeUndefined()
    for (let i = 1; i < priorReviewHandoffs.length; i++) {
      expect(priorReviewHandoffs[i]![0]!.description).toBe(`Source claim ${i}`)
      expect(critiqueDetailHandoffs[i]!.some(part => part.text?.includes(`Source claim ${i}`))).toBe(true)
    }
    expect(detailHandoffs).toHaveLength(10)
    expect(detailHandoffs.every((parts) => parts.some((part) => part.text?.includes('SOURCE DETAIL TO VERIFY')))).toBe(true)
    mockState.sequence = false
  })

  test('caps parsing at five review passes', async () => {
    const { MAX_ITERATIONS } = await import('./parse-loop')
    expect(MAX_ITERATIONS).toBe(5)
  })

  test('accepts with warnings at the iteration limit, flagging the majors for review', async () => {
    mockState.openingsError = null
    const { MAX_ITERATIONS, runParseLoop } = await import('./parse-loop')
    mockState.findings = [majorFinding('w-div-bottom')]
    const saved: FloorModel[] = []

    await runParseLoop({
      dimensions: { heightPx: 800, widthPx: 1000 },
      onProgress: async () => {},
      planPath: '/tmp/plan.png',
      saveIteration: async (model) => {
        saved.push(model)
      },
    })
    // MAX reviewed iterations plus the flagged final save.
    expect(saved).toHaveLength(MAX_ITERATIONS + 1)
    const flagged = saved
      .at(-1)!
      .walls.find((wall) => wall.id === 'w-div-bottom')!
    expect(flagged.confidence).toBeLessThanOrEqual(0.55)
  })

  test('salvages the last reviewed model when a later model call dies', async () => {
    mockState.openingsError = null
    const { MAX_ITERATIONS, runParseLoop } = await import('./parse-loop')
    mockState.findings = [majorFinding('w-div-bottom')]
    // First critique succeeds; the refine that follows dies (credits gone).
    const originalRefine = (await import('./parser')).refineParse
    mock.module('./parser', () => ({
      ...parser,
      loadPlanImageParts: async () => [
        { inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' } },
        { text: 'report coordinates in the FULL PLAN space' },
      ],
      parsePlanImage: async () => sampleFloorModel,
      refineParse: async () => {
        throw new Error('Bedrock ThrottlingException: rate exceeded')
      },
    }))
    try {
      const saved: FloorModel[] = []
      await runParseLoop({
        dimensions: { heightPx: 800, widthPx: 1000 },
        onProgress: async () => {},
        planPath: '/tmp/plan.png',
        saveIteration: async (model) => {
          saved.push(model)
        },
      })
      // One reviewed iteration plus the salvaged flagged save.
      expect(saved).toHaveLength(2)
      const flagged = saved.at(-1)!.walls.find((w) => w.id === 'w-div-bottom')!
      expect(flagged.confidence).toBeLessThanOrEqual(0.55)
      expect(MAX_ITERATIONS).toBeGreaterThan(1)
    } finally {
      mock.module('./parser', () => ({
        ...parser,
          loadPlanImageParts: async () => [
          { inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' } },
          { text: 'report coordinates in the FULL PLAN space' },
          ...Array.from({ length: 4 }, () => ({
            inlineData: { data: VALID_PNG_BASE64, mimeType: 'image/png' },
          })),
        ],
        parsePlanImage: async () => sampleFloorModel,
        refineParse: originalRefine,
      }))
    }
  })

  test('still fails at the limit when majors pile up (fabrication signature)', async () => {
    mockState.openingsError = null
    const { ACCEPT_WITH_WARNINGS_MAX_MAJORS, runParseLoop } = await import(
      './parse-loop'
    )
    mockState.findings = Array.from(
      { length: ACCEPT_WITH_WARNINGS_MAX_MAJORS + 1 },
      (_, i) => majorFinding(`fake-${i}`),
    )
    await expect(
      runParseLoop({
        dimensions: { heightPx: 800, widthPx: 1000 },
        onProgress: async () => {},
        planPath: '/tmp/plan.png',
        saveIteration: async () => {},
      }),
    ).rejects.toThrow('major findings remain')
  })

  test('does not accept a major omission that the review UI cannot surface', async () => {
    mockState.openingsError = null
    const { runParseLoop } = await import('./parse-loop')
    mockState.findings = [majorFinding(null)]

    await expect(
      runParseLoop({
        dimensions: { heightPx: 800, widthPx: 1000 },
        onProgress: async () => {},
        planPath: '/tmp/plan.png',
        saveIteration: async () => {},
      }),
    ).rejects.toThrow('major finding remains')
  })

  test('keeps refining majors but stops paying for minor-only rounds after two reviews', async () => {
    mockState.openingsError = null
    const { shouldStop } = await import('./parse-loop')
    const minorOnly = {
      confidenceAdjustments: [],
      findings: [
        {
          at: null,
          description: 'Furniture block slightly oversized',
          elementId: 'fur-1',
          kind: 'misplaced' as const,
          severity: 'minor' as const,
        },
      ],
      verdict: 'needs_refinement' as const,
    }
    expect(shouldStop(minorOnly, 0.6, 1)).toBe(false)
    expect(shouldStop(minorOnly, 0.6, 2)).toBe(true)
    expect(
      shouldStop(
        {
          ...minorOnly,
          findings: [{ ...minorOnly.findings[0]!, severity: 'major' as const }],
        },
        0.95,
        4,
      ),
    ).toBe(false)
  })

  test('does not mark a parse accepted when the final openings audit fails', async () => {
    const { runParseLoop } = await import('./parse-loop')
    mockState.findings = []
    mockState.openingsError = new Error('Openings verifier unavailable')
    try {
      await expect(
        runParseLoop({
          dimensions: { heightPx: 800, widthPx: 1000 },
          onProgress: async () => {},
          planPath: '/tmp/plan.png',
          saveIteration: async () => {},
        }),
      ).rejects.toThrow('Openings verifier unavailable')
    } finally {
      mockState.openingsError = null
    }
  })
})
