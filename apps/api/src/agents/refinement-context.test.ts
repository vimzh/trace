import { expect, test } from 'bun:test'
import { Resvg } from '@resvg/resvg-js'
import { imageSize } from 'image-size'
import { allElements, sampleFloorModel, type FloorModel } from '@bumps/floor-model'
import { applyRefinement, refinementOutputSchema } from './parser'
import { planRefinementFocus } from './refinement-focus'
import { assertFocusedChanges, focusedRefinementParts, isFullPlanFocus, prepareRefinementImages } from './refinement-context'
import type { Critique } from './critique'
import type { SourceInventory } from './source-reader'

const finding = (x: number, y: number, elementId: string | null = null): Critique['findings'][number] => ({
  kind: elementId ? 'misplaced' : 'missing', at: { x, y }, elementId,
  bounds: { x0: x, y0: y, x1: x, y1: y },
  description: 'Verify this physical wall junction against the source.', severity: 'major',
})
const patch = () => refinementOutputSchema.parse({
  walls: [], openings: [], rooms: [], features: [], furniture: [], removeIds: [],
})
const localWall = { id: 'local-stub', kind: 'wall' as const,
  a: { x: 240, y: 360 }, b: { x: 240, y: 395 }, thickness: 8, confidence: .9 }
const model: FloorModel = { ...sampleFloorModel, walls: [...sampleFloorModel.walls, localWall] }
const focus = planRefinementFocus(model, [finding(250, 380)])[0]!

test('focused evidence contains an overview and exactly matched source/overlay crops in full-plan coordinates', () => {
  const source = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><path d="M 200 380 H 300" stroke="black" stroke-width="8"/></svg>')
    .render().asPng()
  const images = prepareRefinementImages(model, { data: source.toString('base64'), mimeType: 'image/png' })
  const parts = focusedRefinementParts(focus, images)
  const pictures = parts.flatMap(part => 'inlineData' in part ? [part.inlineData] : [])
  const captions = parts.flatMap(part => 'text' in part ? [part.text] : [])
  expect(pictures).toHaveLength(3)
  expect(pictures.map(picture => picture.mimeType)).toEqual(['image/png', 'image/png', 'image/png'])
  expect(imageSize(Buffer.from(pictures[0]!.data, 'base64'))).toMatchObject({ width: 800, height: 640 })
  for (const picture of pictures.slice(1)) {
    expect(imageSize(Buffer.from(picture.data, 'base64'))).toMatchObject({ width: 1200, height: 1200 })
  }
  expect(pictures[1]!.data).not.toBe(pictures[2]!.data)
  expect(captions[0]).toContain('FULL PLAN OVERVIEW — coordinates x=0..1000, y=0..800')
  expect(captions[1]).toContain('SOURCE — FULL PLAN bounds x=202..298, y=332..428')
  expect(captions[2]).toContain('MATCHING TOPOLOGY OVERLAY — FULL PLAN bounds x=202..298, y=332..428')
  expect(captions[3]).toContain(`WRITABLE EXISTING IDS: ${JSON.stringify(focus.writableIds)}`)
  expect(captions[3]).toContain(`NEW ID PREFIX: ${focus.newIdPrefix}`)
  expect(captions[3]).not.toContain('f-restroom')

  const inventory: SourceInventory = {
    landmarks: [
      { category: 'space', label: 'Local', featureKind: null, at: { x: 250, y: 380 }, evidence: 'Local printed label' },
      { category: 'space', label: 'Far', featureKind: null, at: { x: 900, y: 100 }, evidence: 'Distant printed label' },
    ],
    openConnections: [{ at: { x: 202, y: 332 }, evidence: 'Passage at inclusive boundary' },
      { at: { x: 800, y: 480 }, evidence: 'Distant passage' }],
    structuralDetails: [{ at: { x: 250, y: 390 }, evidence: 'Short return' },
      { at: { x: 500, y: 700 }, evidence: 'Distant curve' }],
    notation: ['Gray bands can be glazing; verify wall joins.'], omit: ['Do not trace fixture icons.'],
  }
  const original = structuredClone(inventory)
  const inventoryPart = focusedRefinementParts(focus, images, inventory)
    .find(part => 'text' in part && part.text.startsWith('LOCAL SOURCE INVENTORY'))!
  const local = JSON.parse(('text' in inventoryPart ? inventoryPart.text : '').split('\n')[1]!)
  expect(local).toEqual({ ...inventory, landmarks: [inventory.landmarks[0]],
    openConnections: [inventory.openConnections[0]], structuralDetails: [inventory.structuralDetails[0]] })
  expect(inventory).toEqual(original)
})

test('local wall addition and deletion preserve all distant records and metadata', () => {
  const proposed = { ...patch(), walls: [{ ...localWall, id: `${focus.newIdPrefix}joined`, b: { x: 240, y: 400 } }],
    removeIds: ['local-stub'] }
  const result = applyRefinement(model, proposed)
  expect(() => assertFocusedChanges(model, result, focus)).not.toThrow()
  expect(result.walls.some(wall => wall.id === 'local-stub')).toBe(false)
  expect(result.walls.some(wall => wall.id === `${focus.newIdPrefix}joined`)).toBe(true)
  expect(allElements(result).filter(element => !element.id.startsWith(focus.newIdPrefix)))
    .toEqual(allElements(model).filter(element => element.id !== 'local-stub'))
  expect(result.plan).toEqual(model.plan)
  expect(result.title).toBe(model.title)
  expect(() => assertFocusedChanges(model, structuredClone(model), focus)).not.toThrow()
})

test('read-only neighboring and entirely omitted records cannot be changed or removed', () => {
  const neighbor = model.walls.find(wall => wall.id === 'w-corridor-n')!
  expect(focus.model.walls).toContainEqual(neighbor)
  expect(focus.writableIds).not.toContain(neighbor.id)
  const moved = applyRefinement(model, { ...patch(), walls: [{ ...neighbor, confidence: .5 }] })
  expect(() => assertFocusedChanges(model, moved, focus)).toThrow('read-only element: w-corridor-n')
  expect(focus.model.features.some(feature => feature.id === 'f-restroom')).toBe(false)
  const removed = applyRefinement(model, { ...patch(), removeIds: ['f-restroom'] })
  expect(() => assertFocusedChanges(model, removed, focus)).toThrow('read-only element: f-restroom')
})

test('new IDs and all changed geometry stay inside the authorized focus, including physical widths', () => {
  const cases = [
    { proposed: { ...patch(), walls: [{ ...localWall, id: 'unreserved-new-id' }] }, error: 'must use prefix' },
    { proposed: { ...patch(), walls: [{ ...localWall, id: `${focus.newIdPrefix}outside`, a: { x: 200, y: 360 } }] }, error: 'beyond its evidence bounds' },
    { proposed: { ...patch(), walls: [{ ...localWall, b: { x: 240, y: 450 } }] }, error: 'beyond its evidence bounds' },
    { proposed: { ...patch(), openings: [{ id: `${focus.newIdPrefix}wide`, kind: 'door' as const,
      at: { x: 230, y: 380 }, width: 80, wallId: null, confidence: .9 }] }, error: 'beyond its evidence bounds' },
  ]
  for (const { proposed, error } of cases) {
    expect(() => assertFocusedChanges(model, applyRefinement(model, proposed), focus)).toThrow(error)
  }
})

test('removing a writable wall cannot implicitly clear a read-only dependent opening association', () => {
  const previous: FloorModel = { ...model, openings: [...model.openings, {
    id: 'remote-associated-door', kind: 'door', at: { x: 730, y: 600 }, width: 30,
    wallId: 'w-corridor-n', confidence: .5,
  }] }
  const wallFocus = planRefinementFocus(previous, [finding(500, 380, 'w-corridor-n')])[0]!
  expect(wallFocus.writableIds).toContain('w-corridor-n')
  expect(wallFocus.writableIds).not.toContain('remote-associated-door')
  const result = applyRefinement(previous, { ...patch(), removeIds: ['w-corridor-n'] })
  expect(result.openings.find(opening => opening.id === 'remote-associated-door')!.wallId).toBeNull()
  expect(() => assertFocusedChanges(previous, result, wallFocus)).toThrow('read-only element: remote-associated-door')
})

test('focused repairs cannot change metadata while explicit full-plan mode retains that authority', () => {
  for (const proposed of [{ ...patch(), title: 'Changed title' }, { ...patch(), north: 270 }]) {
    expect(() => assertFocusedChanges(model, applyRefinement(model, proposed), focus)).toThrow('cannot change plan metadata')
  }
  expect(() => assertFocusedChanges(model, { ...model, plan: { ...model.plan, widthPx: 1200 } }, focus))
    .toThrow('cannot change plan metadata')
  const broad = planRefinementFocus(model, [{ ...finding(0, 0), at: null }])[0]!
  expect(isFullPlanFocus(focus)).toBe(false)
  expect(isFullPlanFocus(broad)).toBe(true)
  expect(() => assertFocusedChanges(model, applyRefinement(model, { ...patch(), title: 'Source title' }), broad)).not.toThrow()
})

test('edge-wall stroke overhang is allowed but off-image control points are not', () => {
  const edgeFocus = planRefinementFocus(model, [finding(0, 0)])[0]!
  const edgeWall = { ...localWall, id: `${edgeFocus.newIdPrefix}edge`, a: { x: 0, y: 10 }, b: { x: 0, y: 40 } }
  expect(() => assertFocusedChanges(model, applyRefinement(model, { ...patch(), walls: [edgeWall] }), edgeFocus)).not.toThrow()
  const outside = { ...edgeWall, a: { x: -2, y: 10 }, b: { x: -2, y: 40 } }
  expect(() => assertFocusedChanges(model, applyRefinement(model, { ...patch(), walls: [outside] }), edgeFocus))
    .toThrow('control point outside its evidence bounds')
})
