// Candidate-scoped checks must equal full validation without changing repair decisions.
import { expect, spyOn, test } from 'bun:test'
import {
  buildValidationContext,
  convertToTactile,
  resolveMechanicalViolations,
  sampleFloorModel,
  tactileDesignSchema,
  type TactileDesign,
  type ValidationViolation,
} from '../src'
import * as validation from '../src/validate'

const context: validation.ValidationContext = {
  symbolAnchorsMm: [{ id: 'lift-source', at: { x: 70, y: 70 }, roomIds: [] }],
  roomsMm: [{ id: 'room', polygonMm: [
    { x: 20, y: 20 }, { x: 70, y: 20 }, { x: 70, y: 100 }, { x: 20, y: 100 },
  ] }],
  doorOpeningsMm: [],
  scaleFeaturesMm: [{ id: 'narrow-door', label: 'Door', requiredMm: 5, widthMm: 4 }],
}

const design = tactileDesignSchema.parse({
  schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { rows: 2, cols: 2 }, legend: [],
  elements: [
    { id: 'wall', kind: 'line', points: [{ x: 80, y: 10 }, { x: 80, y: 140 }] },
    { id: 'diagonal', kind: 'line', points: [{ x: 100, y: 100 }, { x: 150, y: 150 }] },
    { id: 'block', kind: 'area', sourceId: 'block-source', polygon: [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ] },
    { id: 'lift', kind: 'symbol', symbol: 'elevator', sourceId: 'lift-source', at: { x: 70, y: 70 } },
    { id: 'stairs', kind: 'symbol', symbol: 'stairs', at: { x: 75, y: 72 } },
    { id: 'small', kind: 'symbol', symbol: 'north', at: { x: 350, y: 350 }, sizeMm: 3 },
    { id: 'exit', kind: 'symbol', symbol: 'exit', at: { x: 9, y: 30 } },
    { id: 'seam-symbol', kind: 'symbol', symbol: 'entrance', at: { x: 200, y: 220 } },
    { id: 'lift-key', kind: 'braille', key: 'el', sourceId: 'lift-source', at: { x: 95, y: 70 } },
    { id: 'room-key', kind: 'braille', key: 'rm', sourceId: 'room', at: { x: 31, y: 31 } },
    { id: 'block-key', kind: 'braille', key: 'bl', sourceId: 'block-source', at: { x: 5, y: 5 } },
    { id: 'seam-key', kind: 'braille', key: 'sk', at: { x: 195, y: 190 } },
    { id: 't-title', kind: 'braille', key: 'title', at: { x: 10, y: 1 } },
  ],
})

function move(initial: TactileDesign, id: string, dx: number, dy: number): TactileDesign {
  return { ...initial, elements: initial.elements.map(element =>
    element.id === id && (element.kind === 'symbol' || element.kind === 'braille')
      ? { ...element, at: { x: element.at.x + dx, y: element.at.y + dy } }
      : element,
  ) }
}

const canonical = (violations: ValidationViolation[]) => violations.map(v => JSON.stringify(v)).sort()

test('candidate validation preserves unaffected rules and exactly rechecks moved-element constraints', () => {
  const initialViolations = validation.validateTactileDesign(design, context)
  for (const element of design.elements) {
    if (element.kind !== 'symbol' && element.kind !== 'braille') continue
    for (const [dx, dy] of [[0, 0], [0.049, -0.051], [3.25, 0], [-12, 5], [210, -180]]) {
      const candidate = move(design, element.id, dx!, dy!)
      const scoped = validation.validateTactileMove(design, candidate, context, initialViolations)
      expect(canonical(scoped)).toEqual(canonical(validation.validateTactileDesign(candidate, context)))
      expect(scoped.some(v => v.rule === 'scale')).toBe(true)
      expect(scoped.some(v => v.rule === 'margin' && v.elementIds.includes('block'))).toBe(true)
    }
  }
})

test('moving a source symbol updates its unchanged key association and source-anchor findings', () => {
  const before = validation.validateTactileDesign(design, context)
  expect(before.some(v => v.rule === 'label-fit' && v.elementIds.includes('lift-key'))).toBe(true)
  const candidate = move(design, 'lift', 12, 0)
  const after = validation.validateTactileMove(design, candidate, context, before)
  expect(after.some(v => v.rule === 'label-fit' && v.elementIds.includes('lift-key'))).toBe(false)
  expect(after.some(v => v.rule === 'source-anchor' && v.elementIds.includes('lift'))).toBe(true)
  expect(canonical(after)).toEqual(canonical(validation.validateTactileDesign(candidate, context)))
  const restored = move(candidate, 'lift', -12, 0)
  expect(canonical(validation.validateTactileMove(candidate, restored, context, after))).toEqual(canonical(before))
})

test('mechanical candidate validation rejects changes outside its movement contract', () => {
  const before = validation.validateTactileDesign(design, context)
  const changedWall = { ...design, elements: design.elements.map(element =>
    element.id === 'wall' && element.kind === 'line' ? { ...element, widthMm: 4 } : element,
  ) }
  expect(() => validation.validateTactileMove(design, changedWall, context, before)).toThrow(
    'Mechanical validation requires one moved braille label or symbol',
  )
})

test('scoped candidate evaluation preserves full-validation repair decisions and final rule order', () => {
  const { design: initial } = convertToTactile(sampleFloorModel)
  const context = buildValidationContext(sampleFloorModel, initial)
  const before = structuredClone(initial)
  const scoped = resolveMechanicalViolations(initial, context)
  const evaluator = spyOn(validation, 'validateTactileMove').mockImplementation(
    (_previous, candidate, context) => validation.validateTactileDesign(candidate, context),
  )
  try {
    const full = resolveMechanicalViolations(initial, context)
    expect(evaluator).toHaveBeenCalled()
    expect(scoped).toEqual(full)
    expect(validation.validateTactileDesign(scoped, context)).toEqual(validation.validateTactileDesign(full, context))
    expect(initial).toEqual(before)
  } finally {
    evaluator.mockRestore()
  }
})
