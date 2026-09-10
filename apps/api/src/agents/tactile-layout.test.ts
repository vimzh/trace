import { describe, expect, spyOn, test } from 'bun:test'
import { filterMovesForViolations, layoutMessage, runTactileLayout } from './tactile-layout'
import { buildValidationContext, convertToTactile, floorModelSchema, sampleFloorModel, tactileDesignSchema, validateTactileDesign, type ValidationContext } from '@bumps/floor-model'
import * as llm from './llm'
import * as floorModel from '@bumps/floor-model'

function narrowRestroomModel() {
  const box = [{ x: 500, y: 1000 }, { x: 580, y: 1000 }, { x: 580, y: 1116 }, { x: 500, y: 1116 }]
  const outer = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 2000 }, { x: 0, y: 2000 }]
  return floorModelSchema.parse({
    schemaVersion: 1, title: null, plan: { widthPx: 1000, heightPx: 2000, pixelsPerMeter: null, north: null },
    walls: [outer, box].flatMap((points, group) => points.map((a, index) => ({
      id: `w-${group}-${index}`, kind: 'wall', a, b: points[(index + 1) % 4], thickness: 8, confidence: 1,
    }))),
    rooms: [{ id: 'wc', kind: 'room', polygon: box, label: null, confidence: 1 }],
    features: [{ id: 'wc-symbol', kind: 'restroom', at: { x: 540, y: 1058 }, label: 'Named restroom', confidence: 1 }],
    openings: [], furniture: [], paths: [], roads: [],
  })
}

describe('layout agent authorization', () => {
  test('expands residual glyph clearance even when no label-fit violation exists', async () => {
    const model = narrowRestroomModel()
    model.walls = model.walls.slice(0, 4)
    model.rooms[0]!.polygon = [{ x: 500, y: 1000 }, { x: 560, y: 1000 }, { x: 560, y: 1060 }, { x: 500, y: 1060 }]
    model.features = [
      { id: 'lift', kind: 'elevator', at: { x: 525, y: 1030 }, rotation: 0, label: null, confidence: 1 },
      { id: 'stairs', kind: 'stairs', at: { x: 535, y: 1030 }, rotation: 0, label: null, confidence: 1 },
    ]
    const initial = convertToTactile(model).design
    const context = buildValidationContext(model, initial)
    const remaining = validateTactileDesign(floorModel.resolveMechanicalViolations(initial, context), context)
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every(violation => violation.rule === 'clearance')).toBe(true)
    const invoke = spyOn(llm, 'runAgentTurn').mockRejectedValue(new Error('No paid calls for a larger valid layout'))
    try {
      const result = await runTactileLayout(initial, context, model)
      expect(result.valid).toBe(true)
      expect(result.design.mmPerPx).toBeGreaterThan(initial.mmPerPx)
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      invoke.mockRestore()
    }
  })

  test.each(['scale rejection', 'final validation'])('rejects grid-search timeouts during %s without paid calls', async phase => {
    const model = narrowRestroomModel()
    const initial = convertToTactile(model).design
    const context = buildValidationContext(model, initial)
    let now = 0
    let largerGridChecks = 0
    let repairing = false
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    const originalRepair = floorModel.resolveMechanicalViolations
    const repair = spyOn(floorModel, 'resolveMechanicalViolations').mockImplementation((...args) => {
      repairing = true
      try { return originalRepair(...args) } finally { repairing = false }
    })
    const originalValidate = floorModel.validateTactileDesign
    const validator = spyOn(floorModel, 'validateTactileDesign').mockImplementation((design, validationContext) => {
      const violations = originalValidate(design, validationContext)
      if (!repairing && design.grid.cols === 2 && design.grid.rows === 3) {
        largerGridChecks++
        if (phase === 'scale rejection' || largerGridChecks === 2) {
          now = 30_001
          if (phase === 'scale rejection') return [...violations, {
            rule: 'scale' as const, elementIds: [], message: 'Scale rejection at the deadline', measuredMm: 1, requiredMm: 2,
          }]
        }
      }
      return violations
    })
    const invoke = spyOn(llm, 'runAgentTurn').mockRejectedValue(new Error('No paid calls after a timeout'))
    try {
      await expect(runTactileLayout(initial, context, model)).rejects.toThrow('Tactile grid search exceeded 30 seconds')
      expect(invoke).not.toHaveBeenCalled()
      expect(largerGridChecks).toBe(phase === 'scale rejection' ? 1 : 2)
    } finally {
      invoke.mockRestore()
      validator.mockRestore()
      repair.mockRestore()
      clock.mockRestore()
    }
  })

  test('expands blocked keys to the first fully valid larger grid without model calls or lost names', async () => {
    const model = narrowRestroomModel()
    const before = JSON.stringify(model)
    const initial = convertToTactile(model).design
    expect(initial.grid).toEqual({ cols: 1, rows: 2 })
    const invoke = spyOn(llm, 'runAgentTurn').mockRejectedValue(new Error('No paid calls in this regression'))
    try {
      const result = await runTactileLayout(initial, buildValidationContext(model, initial), model)
      expect(invoke).not.toHaveBeenCalled()
      expect(result.valid).toBe(true)
      expect(result.design.grid).toEqual({ cols: 2, rows: 3 })
      expect(result.design.legend).toEqual(initial.legend)
      expect(result.iterations.some(step => step.reason?.startsWith('Rejected expansion to 2×2'))).toBe(true)
      expect(result.iterations.at(-1)?.reason).toStartWith('Expanded to 2×3')
      expect(validateTactileDesign(result.design, buildValidationContext(model, result.design))).toEqual([])
      expect(JSON.stringify(model)).toBe(before)

      const again = await runTactileLayout(result.design, buildValidationContext(model, result.design), model)
      expect(again.design).toEqual(result.design)
      expect(again.iterations).toHaveLength(1)
    } finally {
      invoke.mockRestore()
    }
  })

  test('does not accept a larger grid that would silently lose an existing legend name', async () => {
    const model = narrowRestroomModel()
    const initial = convertToTactile(model).design
    initial.legend.push({ key: 'z', text: 'Retain this review annotation' })
    const invoke = spyOn(llm, 'runAgentTurn').mockResolvedValue({ moves: [] })
    try {
      const result = await runTactileLayout(initial, buildValidationContext(model, initial), model)
      expect(result.valid).toBe(false)
      expect(result.design.grid).toEqual(initial.grid)
      expect(result.design.legend).toEqual(initial.legend)
      expect(result.iterations.filter(step => step.reason?.includes('expansion')).every(step => step.accepted === false)).toBe(true)
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      invoke.mockRestore()
    }
  })

  test('keeps moves only for elements named by current violations', () => {
    const moves = [
      { elementId: 'braille-collision', dxMm: 2, dyMm: 0 },
      { elementId: 'unrelated-symbol', dxMm: 20, dyMm: 20 },
    ]
    const allowed = filterMovesForViolations(moves, [
      { elementIds: ['braille-collision', 'wall-1'] },
    ])

    expect(allowed).toEqual([moves[0]])
  })

  test('the next layout request sees exact footprints and rejected-move feedback', () => {
    const design = convertToTactile(sampleFloorModel).design
    const context = buildValidationContext(sampleFloorModel)
    const attempts = [{ accepted: false, moves: [{ elementId: 't-f-stairs', dxMm: 16, dyMm: 0 }],
      remaining: [{ rule: 'source-anchor', elementIds: ['t-f-stairs'], message: 'crosses a wall', measuredMm: 16, requiredMm: 10 }] }]
    const message = layoutMessage(design, context, attempts[0]!.remaining, attempts)
    expect(message).toContain(JSON.stringify(context.symbolAnchorsMm))
    expect(message).toContain(JSON.stringify(attempts))
    expect(message).toContain('widthMm')
    expect(message).toContain('heightMm')
  })

  test('stops after two non-improving proposals and feeds back the rejected candidate violations', async () => {
    // Moving cannot repair an undersized symbol; moving it outside the plate
    // adds a real violation that must reach the next proposal as feedback.
    const design = tactileDesignSchema.parse({
      schemaVersion: 1, plate: {}, mmPerPx: 1, legend: [],
      elements: [{ id: 'small-stairs', kind: 'symbol', symbol: 'stairs', at: { x: 50, y: 50 }, sizeMm: 4 }],
    })
    const context: ValidationContext = { roomsMm: [], doorOpeningsMm: [], scaleFeaturesMm: [], symbolAnchorsMm: [] }
    const initialViolations = validateTactileDesign(design, context)
    const proposals = [200, 201].map(dxMm => [{ elementId: 'small-stairs', dxMm, dyMm: 0 }])
    const candidate = {
      ...design,
      elements: design.elements.map(element => element.kind === 'symbol'
        ? { ...element, at: { x: element.at.x + 200, y: element.at.y } }
        : element),
    }
    const rejectedViolations = validateTactileDesign(candidate, context)
    expect(rejectedViolations.length).toBeGreaterThan(initialViolations.length)
    expect(rejectedViolations.some(violation => violation.rule === 'margin')).toBe(true)

    const requests: string[] = []
    const original = llm.runAgentTurn
    const invoke = spyOn(llm, 'runAgentTurn').mockImplementation(async options => {
      const moves = proposals[requests.length]
      if (!moves) throw new Error('Unexpected third layout proposal')
      requests.push(options.parts.map(part => 'text' in part ? part.text : '').join('\n'))
      return { moves }
    })
    try {
      const result = await runTactileLayout(design, context)
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(result.valid).toBe(false)
      expect(result.design).toEqual(design)
      expect(result.violations).toEqual(initialViolations)
      expect(result.iterations).toHaveLength(3)
      expect(result.iterations.slice(1).every(iteration => iteration.accepted === false)).toBe(true)
      expect(result.iterations.at(-1)?.reason).toBe('Stopped after repeated or non-improving layout attempts')
      const feedback = JSON.parse(requests[1]!.split('Previous attempts and their actual validation results; do not repeat rejected moves:\n')[1]!)
      expect(feedback).toEqual([{ moves: proposals[0], accepted: false, remaining: rejectedViolations }])
    } finally {
      invoke.mockRestore()
    }
    expect(llm.runAgentTurn).toBe(original)
  })
})
