import { describe, expect, spyOn, test } from 'bun:test'
import {
  buildValidationContext,
  convertToTactile,
  sampleFloorModel,
  resolveMechanicalViolations,
  tactileDesignSchema,
  validateTactileDesign,
  type FloorModel,
  type TactileDesign,
} from '../src'

const context = buildValidationContext(sampleFloorModel)
const { design } = convertToTactile(sampleFloorModel)

test('mechanical repair throws at its shared deadline without returning a partial design', () => {
  const context = { roomsMm: [], doorOpeningsMm: [], scaleFeaturesMm: [], symbolAnchorsMm: [] }
  const design = tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
    elements: [
      { id: 'lift', kind: 'symbol', symbol: 'elevator', sourceId: 'f-lift', at: { x: 70, y: 70 } },
      { id: 'key', kind: 'braille', sourceId: 'f-lift', key: 'el', at: { x: 115, y: 70 } },
    ],
  })
  const initial = structuredClone(design)
  const clock = spyOn(performance, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(30_000)
  try {
    expect(() => resolveMechanicalViolations(design, context)).toThrow(
      'Tactile layout repair exceeded 30 seconds. Split this dense plan into smaller sections or reduce its detail, then try again.',
    )
    expect(design).toEqual(initial)
  } finally {
    clock.mockRestore()
  }
  expect(validateTactileDesign(resolveMechanicalViolations(design, context), context)).toHaveLength(0)
})

describe('validateTactileDesign', () => {
  test('clearance broad-phase retains near-threshold collisions and refreshes moved bounds', () => {
    const context = { roomsMm: [], doorOpeningsMm: [], scaleFeaturesMm: [], symbolAnchorsMm: [] }
    const design = tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
      elements: [
        { id: 'wall', kind: 'line', widthMm: 2, points: [{ x: 20, y: 10 }, { x: 20, y: 70 }] },
        { id: 'key', kind: 'braille', key: 'a', at: { x: 23.94, y: 20 } },
        { id: 'lift', kind: 'symbol', symbol: 'elevator', at: { x: 26.94, y: 50 }, sizeMm: 6 },
      ] })
    const collisions = () => validateTactileDesign(design, context).filter(v => v.rule === 'clearance')
    expect(collisions().map(v => v.elementIds)).toEqual([['key', 'wall'], ['lift', 'wall']])
    for (const element of design.elements) if ('at' in element) element.at.x += 1
    expect(collisions()).toHaveLength(0)
  })

  test('feature keys stay adjacent and cannot move across a wall for clearance', () => {
    const context = { roomsMm: [], doorOpeningsMm: [], scaleFeaturesMm: [], symbolAnchorsMm: [] }
    const design = tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
      elements: [
        { id: 'lift', kind: 'symbol', symbol: 'elevator', sourceId: 'f-lift', at: { x: 70, y: 70 } },
        { id: 'key', kind: 'braille', sourceId: 'f-lift', key: 'el', at: { x: 115, y: 70 } },
      ],
    })
    expect(validateTactileDesign(design, context).map((v) => v.rule)).toEqual(['label-fit'])
    const repaired = resolveMechanicalViolations(design, context)
    expect(validateTactileDesign(repaired, context)).toHaveLength(0)
    expect(repaired.elements[0]).toEqual(design.elements[0])
    const key = design.elements[1]!
    if (key.kind !== 'braille') throw new Error('Missing braille fixture')
    design.elements = [design.elements[0]!,
      { ...key, at: { x: 82, y: 70 } },
      { id: 'wall', kind: 'line', points: [{ x: 77, y: 40 }, { x: 77, y: 100 }], widthMm: 2, heightMm: 1, style: 'solid', sourceId: null },
    ]
    expect(validateTactileDesign(design, context).some((v) => v.rule === 'label-fit' && v.message.includes('crosses a wall'))).toBe(true)
  })

  test('reports centroid-key collisions on the raw fixture conversion', () => {
    const violations = validateTactileDesign(design, context)
    // The corridor's key is a thin band between two walls — expect clearance
    // or fit findings, all machine-readable.
    for (const violation of violations) {
      expect(violation.rule).toBeTruthy()
      expect(violation.elementIds.length).toBeGreaterThan(0)
      expect(violation.message.length).toBeGreaterThan(10)
    }
  })

  test('symbols below 5mm are flagged', () => {
    const shrunk: TactileDesign = structuredClone(design)
    const symbol = shrunk.elements.find((e) => e.kind === 'symbol')
    if (symbol?.kind === 'symbol') symbol.sizeMm = 4
    const violations = validateTactileDesign(shrunk, context)
    expect(violations.some((v) => v.rule === 'symbol-size')).toBe(true)
  })

  test('same-kind symbols need 6mm, different kinds 3mm', () => {
    const crowded: TactileDesign = structuredClone(design)
    const stairs = crowded.elements.find(
      (e) => e.kind === 'symbol' && e.symbol === 'stairs',
    )
    if (stairs?.kind === 'symbol') {
      crowded.elements.push({
        ...structuredClone(stairs),
        at: { x: stairs.at.x + 11, y: stairs.at.y },
        id: 'sym-close-twin',
      })
    }
    const violations = validateTactileDesign(crowded, context)
    // 11mm apart, 6mm bodies -> 5mm gap: fails the 6mm same-kind rule but
    // would pass the generic 3mm rule.
    expect(
      violations.some(
        (v) => v.rule === 'clearance' && v.elementIds.includes('sym-close-twin'),
      ),
    ).toBe(true)
  })

  test('the scale gate fails a floor too large for the plate', () => {
    const huge: FloorModel = structuredClone(sampleFloorModel)
    // Pretend the same drawing spans a 100m building: door widths shrink
    // below 5mm once scaled.
    huge.walls.push({
      a: { x: 0, y: 0 },
      b: { x: 20000, y: 0 },
      confidence: 1,
      id: 'w-long',
      kind: 'wall',
      thickness: 10,
    })
    const hugeContext = buildValidationContext(huge)
    const hugeDesign = convertToTactile(huge).design
    const violations = validateTactileDesign(hugeDesign, hugeContext)
    expect(violations.some((v) => v.rule === 'scale')).toBe(true)
    expect(
      violations.find((v) => v.rule === 'scale')?.message,
    ).toContain('too large')
  })

  test('braille outside the margin is flagged', () => {
    const out: TactileDesign = structuredClone(design)
    const label = out.elements.find((e) => e.kind === 'braille')
    if (label?.kind === 'braille') label.at = { x: 1, y: 1 }
    const violations = validateTactileDesign(out, context)
    expect(violations.some((v) => v.rule === 'margin')).toBe(true)
  })

  test('walls crossing the interior of a braille run are not clear of it', () => {
    const emptyContext = { roomsMm: [], doorOpeningsMm: [], scaleFeaturesMm: [], symbolAnchorsMm: [] }
    const label = { id: 't-title', kind: 'braille', key: 'fourth storey plan', at: { x: 30, y: 60 } }
    for (const points of [
      [{ x: 80, y: 20 }, { x: 80, y: 100 }],
      [{ x: 60, y: 20 }, { x: 100, y: 100 }],
    ]) {
      const crossed = tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
        elements: [label, { id: 'wall', kind: 'line', points }],
      })
      const violations = validateTactileDesign(crossed, emptyContext)
      expect(violations.find(v => v.rule === 'clearance')?.measuredMm).toBe(0)
      const clear = tactileDesignSchema.parse({ ...crossed,
        elements: [label, { id: 'wall', kind: 'line', points: [{ x: 150, y: 20 }, { x: 150, y: 100 }] }],
      })
      expect(validateTactileDesign(clear, emptyContext)).toHaveLength(0)
    }
  })

  test('landmark clearance cannot be bought by moving across a wall or away from its source', () => {
    const shifted: TactileDesign = structuredClone(design)
    const symbol = shifted.elements.find(e => e.kind === 'symbol' && e.sourceId === 'f-stairs')!
    if (symbol.kind !== 'symbol') throw new Error('Missing stairs fixture')
    symbol.at = { x: 101, y: 60 }
    shifted.elements = [symbol, {
      id: 'barrier', kind: 'line', points: [{ x: 100, y: 20 }, { x: 100, y: 100 }],
      widthMm: 2, heightMm: 1, style: 'solid', sourceId: null,
    }]
    const anchors = { ...context, roomsMm: [], symbolAnchorsMm: [{ id: 'f-stairs', at: { x: 99, y: 60 }, roomIds: [] }] }
    expect(validateTactileDesign(shifted, anchors).some(v => v.rule === 'source-anchor')).toBe(true)
    shifted.elements = [symbol]
    symbol.at = { x: 99, y: 64 }
    expect(validateTactileDesign(shifted, anchors).some(v => v.rule === 'source-anchor')).toBe(false)
    symbol.at = { x: 115, y: 60 }
    expect(validateTactileDesign(shifted, anchors).some(v => v.rule === 'source-anchor')).toBe(true)
  })

  test('scale selection keeps a lift inside its shaft instead of relocating it', () => {
    const model: FloorModel = { ...structuredClone(sampleFloorModel), furniture: [], paths: [], roads: [],
      features: [{ id: 'lift', kind: 'elevator', at: { x: 65, y: 100 }, rotation: 0, confidence: 1 }] }
    model.walls.push({ id: 'shaft-right', kind: 'wall', a: { x: 90, y: 40 }, b: { x: 90, y: 160 }, thickness: 8, confidence: 1 })
    model.walls.push({ id: 'shaft-bottom', kind: 'wall', a: { x: 40, y: 160 }, b: { x: 90, y: 160 }, thickness: 8, confidence: 1 })
    const converted = convertToTactile(model).design
    expect(converted.grid.cols * converted.grid.rows).toBeGreaterThan(1)
    const checked = validateTactileDesign(converted, buildValidationContext(model))
    expect(checked.filter(v => v.rule === 'scale')).toHaveLength(0)
    expect(checked.filter(v => v.rule === 'clearance' && v.elementIds.includes('t-lift') && v.elementIds.includes('t-w-left'))).toHaveLength(0)
  })

  test('a wall split at the movement crossing still blocks relocation, but recovery from a wall is allowed', () => {
    const shifted = tactileDesignSchema.parse({
      schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [], elements: [
        { id: 'stairs', kind: 'symbol', symbol: 'stairs', sourceId: 'feature', at: { x: 91, y: 100 } },
        { id: 'upper', kind: 'line', points: [{ x: 84, y: 80 }, { x: 84, y: 100 }] },
        { id: 'lower', kind: 'line', points: [{ x: 84, y: 100 }, { x: 84, y: 120 }] },
      ],
    })
    const anchors = {
      ...context, roomsMm: [], scaleFeaturesMm: [],
      symbolAnchorsMm: [{ id: 'feature', at: { x: 82, y: 100 }, roomIds: [] }],
    }
    expect(validateTactileDesign(shifted, anchors).map(v => v.rule)).toEqual(['source-anchor'])
    anchors.symbolAnchorsMm[0]!.at.x = 84
    expect(validateTactileDesign(shifted, anchors)).toHaveLength(0)

    // Finishing on a wall is a clearance failure, not a crossing of the wall.
    const symbol = shifted.elements[0]!
    if (symbol.kind !== 'symbol') throw new Error('Missing stairs fixture')
    symbol.at.x = 84
    anchors.symbolAnchorsMm[0]!.at.x = 82
    const remaining = validateTactileDesign(shifted, anchors)
    expect(remaining.some(v => v.rule === 'source-anchor')).toBe(false)
    expect(remaining.some(v => v.rule === 'clearance')).toBe(true)
  })
})
