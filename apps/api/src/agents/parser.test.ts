import { describe, expect, test } from 'bun:test'
import { sampleFloorModel } from '@bumps/floor-model'
import { applyRefinement, refinementOutputSchema } from './parser'

describe('localized source refinement', () => {
  const empty = () => refinementOutputSchema.parse({
    walls: [], openings: [], rooms: [], features: [], furniture: [], removeIds: [],
  })

  test('preserves unaffected geometry, names, opening associations and scale', () => {
    const previous = structuredClone(sampleFloorModel)
    previous.plan.pixelsPerMeter = 120
    const snapshot = structuredClone(previous)
    expect(applyRefinement(previous, empty())).toEqual(previous)
    const patch = empty()
    const wall = previous.walls[0]!
    patch.walls = [{ ...wall, b: { x: wall.b.x + 5, y: wall.b.y } }]
    const result = applyRefinement(previous, patch)
    expect(result.walls[0]!.b.x).toBe(wall.b.x + 5)
    expect(result.walls.slice(1)).toEqual(previous.walls.slice(1))
    for (const key of ['openings', 'rooms', 'furniture', 'features', 'paths', 'roads', 'plan', 'title'] as const) {
      expect(result[key]).toEqual(previous[key])
    }
    expect(previous).toEqual(snapshot)
    const partialWall = empty()
    partialWall.walls = [{ id: wall.id, a: wall.a, b: wall.b, confidence: 0.8 }]
    expect(applyRefinement(previous, partialWall).walls[0]!.thickness).toBe(wall.thickness)
    const metadata = applyRefinement(previous, { ...empty(), title: null, north: 270 })
    expect(metadata.title).toBeNull()
    expect(metadata.plan).toEqual({ ...previous.plan, north: 270 })
  })

  test('explicit deletion clears only associations to the deleted wall', () => {
    const patch = empty()
    const opening = sampleFloorModel.openings.find((item) => item.wallId)!
    patch.removeIds = [opening.wallId!]
    const result = applyRefinement(sampleFloorModel, patch)
    expect(result.walls.some((wall) => wall.id === opening.wallId)).toBe(false)
    expect(result.openings.find((item) => item.id === opening.id)!.wallId).toBeNull()
    expect(result.openings.filter((item) => item.id !== opening.id).map((item) => item.id))
      .toEqual(sampleFloorModel.openings.filter((item) => item.id !== opening.id).map((item) => item.id))
  })

  test('road width corrections use the canonical field rather than a shadowed alias', () => {
    const road = { id: 'road', kind: 'road' as const, points: [{ x: 10, y: 20 }, { x: 200, y: 20 }], widthPx: 12, label: 'Main Street', confidence: 1 }
    const previous = { ...sampleFloorModel, roads: [road] }
    expect(applyRefinement(previous, { ...empty(), roads: [{ ...road, widthPx: 24 }] }).roads[0]!.widthPx).toBe(24)
    expect(refinementOutputSchema.safeParse({ ...empty(), roads: [{ ...road, width: 24 }] }).success).toBe(false)
  })

  test('rejects unknown removals, duplicate changes, class changes and invalid references atomically', () => {
    const wall = sampleFloorModel.walls[0]!
    const cases = [
      { ...empty(), removeIds: ['unknown'] },
      { ...empty(), removeIds: [wall.id, wall.id] },
      { ...empty(), walls: [wall], removeIds: [wall.id] },
      { ...empty(), walls: [wall, wall] },
      { ...empty(), rooms: [{ ...sampleFloorModel.rooms[0]!, id: wall.id }] },
      { ...empty(), openings: [{ ...sampleFloorModel.openings[0]!, wallId: 'unknown' }] },
    ]
    const before = structuredClone(sampleFloorModel)
    for (const patch of cases) expect(() => applyRefinement(sampleFloorModel, patch)).toThrow()
    expect(sampleFloorModel).toEqual(before)
  })
})

describe('plan input quality gate', () => {
  test('accepts traceable plans and rejects perspective or unusable inputs', async () => {
    const { assertUsablePlanInput } = await import('./parser')
    expect(() =>
      assertUsablePlanInput({
        drawingType: 'floor-plan',
        suitability: 'usable',
        suitabilityIssues: ['low resolution'],
      }),
    ).not.toThrow()
    expect(() =>
      assertUsablePlanInput({
        drawingType: 'not-a-plan',
        suitability: 'poor',
        suitabilityIssues: ['isometric perspective'],
      }),
    ).toThrow('isometric perspective')
  })

  test('uses zoomed structure views without encouraging inferred doors', async () => {
    const { loadPlanImageParts, PARSER_INSTRUCTION } = await import('./parser')
    const { CRITIQUE_INSTRUCTION } = await import('./critique')

    expect(PARSER_INSTRUCTION).toContain('A door requires DIRECT VISIBLE EVIDENCE')
    expect(PARSER_INSTRUCTION).toContain('L-, U-, and T-shaped walls')
    expect(PARSER_INSTRUCTION).toContain(
      'A round fountain, circular desk, round planter, or curved counter',
    )
    expect(PARSER_INSTRUCTION).not.toContain(
      'Almost every enclosed room has at least one door',
    )
    // Evidence tiers: gap-evidenced doors are emitted at review-flag
    // confidence instead of being either invented or dropped.
    expect(PARSER_INSTRUCTION).toContain('confidence 0.5-0.7')
    expect(PARSER_INSTRUCTION).toContain('SIGNIFICANCE FILTER')
    expect(PARSER_INSTRUCTION).toContain('not an arbitrary count limit')
    expect(PARSER_INSTRUCTION).not.toContain('roughly 12 blocks')
    expect(CRITIQUE_INSTRUCTION).toContain('fills a visible walkable aisle as MAJOR')
    expect(PARSER_INSTRUCTION).toContain('Notation dialects')
    expect(PARSER_INSTRUCTION).toContain('Sweep order')
    expect(PARSER_INSTRUCTION).toContain('fill-color changes and white separator bands')
    expect(PARSER_INSTRUCTION).toContain('Require independent structural wall evidence')
    expect(PARSER_INSTRUCTION).toContain('combine the exact printed names')
    expect(PARSER_INSTRUCTION).toContain('Rectangular furniture must use four corner points in polygon')
    expect(PARSER_INSTRUCTION).not.toContain('Rectangular furniture may use bounds')
    expect(CRITIQUE_INSTRUCTION).toContain('a room polygon does not require enclosing walls or doors')
    expect(CRITIQUE_INSTRUCTION).toContain('A missing name or replacement with a generic summary')
    expect(PARSER_INSTRUCTION).toContain('"toilet room"')
    expect(PARSER_INSTRUCTION).toContain('"restroom circulation"')
    expect(CRITIQUE_INSTRUCTION).toContain('missing functional information')
    expect(CRITIQUE_INSTRUCTION).toContain('Combined exact printed names')
    expect(CRITIQUE_INSTRUCTION).toContain('DETERMINISTIC STRUCTURAL AUDIT')
    expect(CRITIQUE_INSTRUCTION).toContain(
      'Never copy an audit line into findings without image evidence',
    )
    // Door-precision, gate, and stair-tread rules from the Harris study.
    expect(PARSER_INSTRUCTION).toContain('POSITION PRECISION')
    expect(PARSER_INSTRUCTION).toContain('NEVER trace stair treads as walls')
    expect(PARSER_INSTRUCTION).toContain('ordinary interior, exterior, or porch door remains an opening')
    expect(PARSER_INSTRUCTION).toContain('explicit entrance/exit symbol, label, or arrow in the SOURCE image')
    expect(CRITIQUE_INSTRUCTION).toContain('Audit EVERY entrance/exit feature against the SOURCE image')
    expect(CRITIQUE_INSTRUCTION).toContain('kind "extra", severity "major"')
    expect(CRITIQUE_INSTRUCTION).toContain('preserving any source-evidenced door opening')
    expect(CRITIQUE_INSTRUCTION).toContain('arrows at the building perimeter mark gates')
    expect(CRITIQUE_INSTRUCTION).toContain('set "at" to the approximate {x, y}')
    expect(CRITIQUE_INSTRUCTION).toContain('opening.kind="door" also represents an archway or plain open passage')
    expect(CRITIQUE_INSTRUCTION).toContain('explain that reversal in the finding description')
    expect(PARSER_INSTRUCTION).toContain('A wheelchair icon qualifying a room or facility is NOT evidence of seating')
    expect(CRITIQUE_INSTRUCTION).toContain('A wheelchair icon qualifying a room or facility is NOT evidence of seating')
    expect(PARSER_INSTRUCTION).toContain('Do not coerce an unsupported device or operational marker')
    expect(CRITIQUE_INSTRUCTION).toContain('Do not demand self-checkout/charging icons as reception points')
    const { SOURCE_READER_INSTRUCTION } = await import('./source-reader')
    for (const prompt of [PARSER_INSTRUCTION, CRITIQUE_INSTRUCTION, SOURCE_READER_INSTRUCTION]) {
      expect(prompt).toMatch(/crop[- ]edge/)
      expect(prompt).toContain('last image pixels')
      expect(prompt).toContain('symbol-only copier, printer, charger or terminal')
      expect(prompt).toContain('transverse aisle')
    }
    expect(CRITIQUE_INSTRUCTION).toContain(
      'A sealed room is not evidence of a missing door',
    )
    expect(CRITIQUE_INSTRUCTION).toContain(
      'A round fountain, circular planter, circular desk, or curved counter',
    )

    const parts = await loadPlanImageParts('pipeline_tests/outputs/psu-input.png')
    expect(parts.filter((part) => 'inlineData' in part)).toHaveLength(5)
    expect(parts.filter((part) => 'text' in part).map((part) => part.text).join(' ')).toContain(
      'report coordinates in the FULL PLAN space',
    )
  })

  test('treats missing structural geometry as major', async () => {
    const { critiqueSchema } = await import('./critique')
    const critique = critiqueSchema.parse({
      verdict: 'pass',
      confidenceAdjustments: [],
      findings: [
        {
          at: null,
          description: 'Missing door between the ballroom and hall',
          elementId: null,
          kind: 'missing',
          severity: 'minor',
        },
      ],
    })

    expect(critique.findings[0]?.severity).toBe('major')
    expect(critique.verdict).toBe('needs_refinement')
  })
})
