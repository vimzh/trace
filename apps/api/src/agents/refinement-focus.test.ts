import { expect, test } from 'bun:test'
import { allElements, floorModelSchema, type FloorModel } from '@bumps/floor-model'
import type { Critique } from './critique'
import { planRefinementFocus, refinementElementBounds } from './refinement-focus'

const empty = floorModelSchema.parse({ schemaVersion: 1, plan: { widthPx: 1200, heightPx: 1000 },
  walls: [], openings: [], rooms: [], features: [] })
const finding = (x: number, y: number, elementId: string | null = null): Critique['findings'][number] => ({
  kind: elementId ? 'misplaced' : 'missing', at: { x, y }, elementId,
  bounds: { x0: x, y0: y, x1: x, y1: y },
  description: 'Source-visible boundary correction', severity: 'major',
})
const wall = (id: string, x0: number, y0: number, x1: number, y1: number) => ({
  id, kind: 'wall' as const, a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, thickness: 8, confidence: .9,
})
const feature = (id: string, x: number, y: number) => ({
  id, kind: 'stairs' as const, at: { x, y }, rotation: 0, confidence: .9,
})

test('a local junction retains crossing and enclosing geometry plus opening associations, not distant records', () => {
  const model: FloorModel = { ...empty,
    walls: [wall('crossing', 40, 200, 1100, 200), wall('return', 200, 190, 200, 225),
      wall('remote-host', 600, 700, 900, 700)],
    openings: [
      { id: 'visible-door', kind: 'door', at: { x: 200, y: 210 }, width: 20, wallId: 'remote-host', confidence: .9 },
      { id: 'dependent-door', kind: 'door', at: { x: 1000, y: 200 }, width: 20, wallId: 'crossing', confidence: .9 },
      { id: 'remote-dependent', kind: 'window', at: { x: 800, y: 700 }, width: 20, wallId: 'remote-host', confidence: .9 },
    ],
    rooms: [{ id: 'enclosing-room', kind: 'room', polygon: [{ x: 10, y: 10 }, { x: 1190, y: 10 },
      { x: 1190, y: 990 }, { x: 10, y: 990 }], label: 'Hall', confidence: .9 }],
    features: [feature('far', 1000, 900)],
  }
  const original = JSON.stringify(model)
  const [focus] = planRefinementFocus(model, [finding(200, 200)])
  expect(focus!.bounds).toEqual({ x0: 152, y0: 152, x1: 248, y1: 248 })
  expect(allElements(focus!.model).map(element => element.id)).toEqual([
    'crossing', 'return', 'remote-host', 'visible-door', 'dependent-door', 'remote-dependent', 'enclosing-room',
  ])
  expect(focus!.writableIds).toEqual(['return', 'visible-door'])
  expect(floorModelSchema.safeParse(focus!.model).success).toBe(true)
  expect(JSON.stringify(model)).toBe(original)
})

test('conservative bounds include widths and full implicated segments instead of selecting centroids', () => {
  const model: FloorModel = { ...empty,
    walls: [{ ...wall('thick', 140, 170, 140, 230), thickness: 30 }, wall('long', 100, 600, 1000, 600)],
    openings: [{ id: 'wide', kind: 'door', at: { x: 140, y: 200 }, width: 30, wallId: null, confidence: .9 }],
    roads: [{ id: 'road', kind: 'road', points: [{ x: 140, y: 150 }, { x: 140, y: 250 }],
      widthPx: 30, label: null, confidence: .9 }],
  }
  const [local] = planRefinementFocus(model, [finding(200, 200)])
  expect(allElements(local!.model).map(element => element.id)).toEqual(['thick', 'wide', 'road'])
  expect(local!.writableIds).toEqual([])
  expect(refinementElementBounds(model.roads[0]!)).toEqual({ x0: 125, y0: 135, x1: 155, y1: 265 })
  const [long] = planRefinementFocus(model, [finding(100, 600, 'long')])
  expect(long!.bounds).toEqual({ x0: 48, y0: 548, x1: 1052, y1: 652 })
  expect(long!.writableIds).toContain('long')
})

test('overlapping findings coalesce transitively without losing their order', () => {
  const findings = [finding(150, 400), finding(330, 400), finding(240, 400)]
  const [focus] = planRefinementFocus(empty, findings)
  expect(planRefinementFocus(empty, findings)).toHaveLength(1)
  expect(focus!.bounds).toEqual({ x0: 102, y0: 352, x1: 378, y1: 448 })
  expect(focus!.findings).toEqual(findings)
})

test('independent local tasks share read-only context but never writable IDs', () => {
  const model = { ...empty, walls: [wall('crossing', 10, 200, 1190, 200)],
    features: [feature('left', 200, 200), feature('right', 800, 200)] }
  const focuses = planRefinementFocus(model, [finding(200, 200, 'left'), finding(800, 200, 'right')])
  expect(focuses).toHaveLength(2)
  expect(focuses.map(focus => focus.writableIds)).toEqual([['left'], ['right']])
  expect(focuses.map(focus => focus.model.walls.map(element => element.id))).toEqual([['crossing'], ['crossing']])
  expect(new Set(focuses.map(focus => focus.newIdPrefix)).size).toBe(2)
})

test('unknown targets, invalid locations and null locations use one observable full-plan task', () => {
  const model = { ...empty, features: [feature('stairs', 800, 200)] }
  const broadFindings = [
    { ...finding(200, 200), at: null }, finding(200, 200, 'title'),
    finding(-1, 200), finding(Number.NaN, 200),
    { ...finding(200, 200), bounds: undefined }, { ...finding(200, 200), bounds: null },
    { ...finding(200, 200), bounds: { x0: 300, y0: 200, x1: 200, y1: 200 } },
    { ...finding(200, 200), bounds: { x0: 0, y0: 0, x1: 1500, y1: 1000 } },
    { ...finding(200, 200), bounds: { x0: 0, y0: 0, x1: 100, y1: 100 } },
  ]
  for (const broad of broadFindings) {
    const findings = [finding(100, 100), broad]
    const focuses = planRefinementFocus(model, findings)
    expect(focuses).toHaveLength(1)
    expect(focuses[0]!.bounds).toEqual({ x0: 0, y0: 0, x1: 1200, y1: 1000 })
    expect(focuses[0]!.model).toBe(model)
    expect(focuses[0]!.writableIds).toEqual(['stairs'])
    expect(focuses[0]!.findings).toEqual(findings)
  }
  expect(planRefinementFocus(model, [])).toEqual([])
})

test('more than four separated defects retain every finding in broad mode', () => {
  const findings = [finding(100, 100), finding(400, 100), finding(700, 100), finding(100, 700), finding(700, 700)]
  const focuses = planRefinementFocus(empty, findings)
  expect(focuses).toHaveLength(1)
  expect(focuses[0]!.findings).toEqual(findings)
  expect(focuses[0]!.bounds).toEqual({ x0: 0, y0: 0, x1: 1200, y1: 1000 })
})

test('prefixes are deterministic and unused by every existing element ID', () => {
  const model = { ...empty, features: [feature('refine-1-old', 600, 600), feature('refine-2-old', 650, 600)] }
  const findings = [finding(10, 10), finding(1000, 800)]
  const focuses = planRefinementFocus(model, findings)
  expect(focuses.map(focus => focus.newIdPrefix)).toEqual(['refine-3-', 'refine-4-'])
  expect(focuses[0]!.bounds.x0).toBe(0)
  expect(focuses[0]!.bounds.y0).toBe(0)
  expect(planRefinementFocus(model, findings)).toEqual(focuses)
})

test('declared repair extents retain an entire missing run and proposed extension, not only their midpoint', () => {
  const missing = { ...finding(800, 500), bounds: { x0: 800, y0: 200, x1: 800, y1: 800 } }
  const [focus] = planRefinementFocus(empty, [missing])
  expect(focus!.bounds).toEqual({ x0: 752, y0: 152, x1: 848, y1: 848 })
  const model = { ...empty, walls: [wall('extend', 100, 500, 100, 800)] }
  const [extension] = planRefinementFocus(model, [{ ...finding(100, 400, 'extend'),
    bounds: { x0: 100, y0: 200, x1: 100, y1: 500 } }])
  expect(extension!.bounds.y0).toBe(152)
  expect(extension!.bounds.y1).toBe(852)
  const withDoor = { ...model, openings: [{ id: 'door', kind: 'door' as const,
    at: { x: 100, y: 790 }, width: 20, wallId: 'extend', confidence: .9 }] }
  const [doorRepair] = planRefinementFocus(withDoor, [{ ...finding(100, 790, 'door'), kind: 'extra' }])
  expect(doorRepair!.bounds.y0).toBe(448)
  expect(doorRepair!.writableIds).toContain('extend')
  expect(doorRepair!.writableIds).toContain('door')
  const [doorShift] = planRefinementFocus(withDoor, [finding(100, 790, 'door')])
  expect(doorShift!.bounds.y0).toBe(732)
  expect(doorShift!.writableIds).not.toContain('extend')
  expect(doorShift!.model.walls).toContainEqual(model.walls[0]!)
})

test('large repairs retain multi-detail whole-plan evidence instead of downscaling a wide focus', () => {
  const large = { ...empty, plan: { ...empty.plan, widthPx: 2000, heightPx: 2000 } }
  const finding = { kind: 'missing' as const, elementId: null, severity: 'major' as const,
    at: { x: 800, y: 900 }, bounds: { x0: 800, y0: 200, x1: 800, y1: 1600 }, description: 'Long physical boundary' }
  const [focus] = planRefinementFocus(large, [finding])
  expect(focus!.model).toBe(large)
  expect(focus!.bounds).toEqual({ x0: 0, y0: 0, x1: 2000, y1: 2000 })
  expect(focus!.findings).toEqual([finding])
})
