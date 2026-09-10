import { describe, expect, test } from 'bun:test'
import { sampleFloorModel } from '@bumps/floor-model'

const { applyOpeningsAudit, buildAuditTargets, openingsAuditSchemaForModel } = await import('./openings-audit')

test('the final auditor must explicitly cover every opening exactly once', () => {
  const schema = openingsAuditSchemaForModel(sampleFloorModel)
  const ops = sampleFloorModel.openings.map(({ id }) => ({ id, op: 'keep', reason: 'visible gap' }))
  expect(schema.safeParse({ ops }).success).toBe(true)
  expect(schema.safeParse({ ops: [] }).success).toBe(false)
  expect(schema.safeParse({ ops: ops.slice(1) }).success).toBe(false)
  expect(schema.safeParse({ ops: [...ops, ops[0]] }).success).toBe(false)
  expect(schema.safeParse({ ops: [...ops, { id: 'invented', op: 'keep', reason: 'gap' }] }).success).toBe(false)
  expect(openingsAuditSchemaForModel({ ...sampleFloorModel, openings: [] }).safeParse({ ops: [] }).success).toBe(true)
})

describe('applyOpeningsAudit', () => {
  test('moves, deletes, and keeps openings per the audit, with notes', () => {
    const { model, notes } = applyOpeningsAudit(sampleFloorModel, [
      { confidence: 0.95, id: 'd-nw', op: 'keep', reason: 'clear gap' },
      {
        at: { x: 300, y: 480 },
        confidence: 0.85,
        id: 'd-sw',
        op: 'move',
        reason: 'gap center is left of reported point',
        width: 50,
      },
      { id: 'd-se', op: 'delete', reason: 'wall continuous, no gap' },
    ])
    expect(model.openings.find((o) => o.id === 'd-nw')!.confidence).toBe(0.95)
    const moved = model.openings.find((o) => o.id === 'd-sw')!
    expect(moved.at.x).toBe(300)
    expect(moved.width).toBe(50)
    expect(model.openings.some((o) => o.id === 'd-se')).toBe(false)
    expect(notes.join(' ')).toContain('removed d-se')
  })

  test('ignores implausible moves and adds away from entrances', () => {
    const { model, notes } = applyOpeningsAudit(sampleFloorModel, [
      {
        at: { x: 950, y: 40 },
        id: 'd-sw',
        op: 'move',
        reason: 'teleport',
      },
      {
        at: { x: 60, y: 60 },
        kind: 'door',
        op: 'add',
        reason: 'no entrance feature anywhere near',
      },
    ])
    expect(model.openings.find((o) => o.id === 'd-sw')!.at.x).toBe(250)
    expect(model.openings).toHaveLength(sampleFloorModel.openings.length)
    expect(notes.join(' ')).toContain('implausible')
  })

  test('adds a gate at an entrance feature, deduped against existing doors', () => {
    // f-entrance sits at (500, 720); d-entry already covers (500, 760).
    const noAdd = applyOpeningsAudit(sampleFloorModel, [
      { at: { x: 505, y: 755 }, kind: 'door', op: 'add', reason: 'gate drawn' },
    ])
    expect(noAdd.model.openings).toHaveLength(sampleFloorModel.openings.length)

    const without = {
      ...sampleFloorModel,
      openings: sampleFloorModel.openings.filter((o) => o.id !== 'd-entry'),
    }
    const added = applyOpeningsAudit(without, [
      { at: { x: 505, y: 755 }, confidence: 0.8, kind: 'door', op: 'add', reason: 'gate drawn' },
    ])
    expect(added.model.openings.some((o) => o.id.startsWith('gate-'))).toBe(true)
  })

  test('rejects the whole audit when it mass-deletes', () => {
    const ops = sampleFloorModel.openings.map((o) => ({
      id: o.id,
      op: 'delete' as const,
      reason: 'suspicious',
    }))
    const { model, notes } = applyOpeningsAudit(sampleFloorModel, ops)
    expect(model.openings).toHaveLength(sampleFloorModel.openings.length)
    expect(notes.join(' ')).toContain('rejected')
  })
})

describe('buildAuditTargets', () => {
  test('covers every opening and entrance, merging overlapping boxes', () => {
    const boxes = buildAuditTargets(sampleFloorModel)
    const labels = boxes.flatMap((b) => b.labels).join(' ')
    for (const opening of sampleFloorModel.openings) {
      expect(labels).toContain(opening.id)
    }
    expect(labels).toContain('f-entrance')
    expect(boxes.length).toBeLessThanOrEqual(12)
  })

  test('audits an entrance even when the parser found no openings', () => {
    const boxes = buildAuditTargets({ ...sampleFloorModel, openings: [] })
    expect(boxes.flatMap((box) => box.labels).join(' ')).toContain('f-entrance')
  })

  test('keeps every opening represented when a dense plan needs grouped crops', () => {
    const openings = Array.from({ length: 20 }, (_, index) => ({
      at: { x: 50 + (index % 5) * 200, y: 50 + Math.floor(index / 5) * 180 },
      confidence: 0.8,
      id: `dense-${index}`,
      kind: 'door' as const,
      wallId: null,
      width: 30,
    }))
    const boxes = buildAuditTargets({
      ...sampleFloorModel,
      features: [],
      openings,
    })
    const labels = boxes.flatMap((box) => box.labels).join(' ')

    expect(boxes.length).toBeLessThanOrEqual(12)
    for (const opening of openings) expect(labels).toContain(opening.id)
  })
})
