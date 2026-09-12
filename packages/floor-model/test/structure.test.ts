import { describe, expect, test } from 'bun:test'
import {
  auditFloorModel,
  normalizeFloorModel,
  orthogonalizeNearRectangle,
  sampleFloorModel,
} from '../src'
import type { FloorModel, Furniture, Opening, Wall } from '../src'

function wall(id: string, ax: number, ay: number, bx: number, by: number, thickness = 8): Wall {
  return {
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    confidence: 0.9,
    id,
    kind: 'wall',
    thickness,
  }
}

function door(id: string, x: number, y: number, width = 40, wallId: string | null = null): Opening {
  return { at: { x, y }, confidence: 0.9, id, kind: 'door', wallId, width }
}

function block(id: string, label: string, x0: number, y0: number, x1: number, y1: number): Furniture {
  return {
    confidence: 0.8,
    id,
    kind: 'furniture',
    label,
    polygon: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  }
}

function makeModel(overrides: Partial<FloorModel>): FloorModel {
  return {
    features: [],
    furniture: [],
    openings: [],
    paths: [],
    plan: { heightPx: 800, north: null, pixelsPerMeter: null, widthPx: 1000 },
    roads: [],
    rooms: [],
    schemaVersion: 1,
    title: null,
    walls: [],
    ...overrides,
  }
}

describe('normalizeFloorModel', () => {
  test('welds near-miss L corners and snaps T junctions onto the crossbar', () => {
    const { model, notes } = normalizeFloorModel(
      makeModel({
        walls: [
          // L corner missing its meeting point by 6px.
          wall('w-1', 100, 100, 500, 100),
          wall('w-2', 504, 104, 500, 400),
          // T stem stopping 7px short of the crossbar w-1.
          wall('w-3', 300, 107, 300, 300),
        ],
      }),
    )
    const w1 = model.walls.find((w) => w.id === 'w-1')!
    const w2 = model.walls.find((w) => w.id === 'w-2')!
    const w3 = model.walls.find((w) => w.id === 'w-3')!
    expect(Math.hypot(w1.b.x - w2.a.x, w1.b.y - w2.a.y)).toBeLessThan(0.01)
    // The stem endpoint must land ON the (welded) crossbar segment.
    const t =
      ((w3.a.x - w1.a.x) * (w1.b.x - w1.a.x) + (w3.a.y - w1.a.y) * (w1.b.y - w1.a.y)) /
      ((w1.b.x - w1.a.x) ** 2 + (w1.b.y - w1.a.y) ** 2)
    const onCrossbar = {
      x: w1.a.x + t * (w1.b.x - w1.a.x),
      y: w1.a.y + t * (w1.b.y - w1.a.y),
    }
    expect(Math.hypot(w3.a.x - onCrossbar.x, w3.a.y - onCrossbar.y)).toBeLessThan(0.01)
    expect(notes.join(' ')).toContain('junction')
  })

  test('does not weld across a short curve segment', () => {
    // Three short chained segments approximating a curve: endpoints must
    // stay a chain, not collapse into one point.
    const { model } = normalizeFloorModel(
      makeModel({
        walls: [
          wall('c-1', 100, 100, 130, 108, 4),
          wall('c-2', 130, 108, 158, 124, 4),
          wall('c-3', 158, 124, 180, 148, 4),
        ],
      }),
    )
    const c2 = model.walls.find((w) => w.id === 'c-2')!
    expect(Math.hypot(c2.a.x - c2.b.x, c2.a.y - c2.b.y)).toBeGreaterThan(20)
  })

  test('nearby parallel walls and shallow curves are not flattened into T junctions', () => {
    const points = [[200, 129], [250, 119], [300, 113], [350, 110], [400, 109],
      [450, 110], [500, 113], [550, 119], [600, 129]]
    const curve = points.slice(1).map((point, index) =>
      wall(`curve-${index}`, points[index]![0]!, points[index]![1]!, point[0]!, point[1]!, 3),
    )
    for (const nearby of [curve, [wall('parallel', 250, 112, 550, 112, 3)]]) {
      const original = makeModel({ walls: [wall('top', 100, 100, 700, 100, 14), ...nearby] })
      let model = original
      for (let pass = 0; pass < 3; pass++) {
        model = normalizeFloorModel(model).model
        expect(model.walls).toEqual(original.walls)
      }
    }
  })

  test('angled T stems extend along their own axis, in either endpoint order', () => {
    for (const angle of [0, Math.PI / 4]) {
      const rotate = (x: number, y: number) => ({
        x: 100 + (x - 100) * Math.cos(angle) - (y - 100) * Math.sin(angle),
        y: 100 + (x - 100) * Math.sin(angle) + (y - 100) * Math.cos(angle),
      })
      for (const end of ['a', 'b'] as const) {
        const otherEnd = end === 'a' ? 'b' : 'a'
        const stem = { ...wall('stem', 0, 0, 1, 1),
          [end]: rotate(306, 106), [otherEnd]: rotate(400, 200) }
        let model = makeModel({ walls: [
          { ...wall('crossbar', 0, 0, 1, 1), a: rotate(100, 100), b: rotate(500, 100) },
          stem,
        ] })
        for (let pass = 0; pass < 3; pass++) {
          model = normalizeFloorModel(model).model
          const joined = model.walls.find((item) => item.id === 'stem')!
          expect(joined[end].x).toBeCloseTo(rotate(300, 100).x, 8)
          expect(joined[end].y).toBeCloseTo(rotate(300, 100).y, 8)
          expect(joined[otherEnd]).toEqual(stem[otherEnd])
        }
      }
    }
  })

  test('drops duplicate walls, keeping the higher confidence trace', () => {
    const duplicate = { ...wall('w-dup', 101, 99, 499, 101), confidence: 0.95 }
    const { model, notes } = normalizeFloorModel(
      makeModel({ walls: [wall('w-1', 100, 100, 500, 100), duplicate] }),
    )
    expect(model.walls).toHaveLength(1)
    expect(model.walls[0]!.confidence).toBe(0.95)
    expect(notes.join(' ')).toContain('duplicate wall')
  })

  test('attaches unassigned openings to the nearest wall and snaps them onto it', () => {
    const { model, notes } = normalizeFloorModel(
      makeModel({
        openings: [door('d-1', 300, 106)],
        walls: [wall('w-1', 100, 100, 500, 100)],
      }),
    )
    expect(model.openings[0]!.wallId).toBe('w-1')
    expect(model.openings[0]!.at.y).toBeCloseTo(100, 5)
    expect(notes.join(' ')).toContain('attached 1 opening')
  })

  test('wall-ended gaps keep their source centers through repeated normalization', () => {
    for (const angle of [0, Math.PI / 4]) {
      const point = (along: number) => ({
        x: 100 + along * Math.cos(angle), y: 100 + along * Math.sin(angle),
      })
      const left = { ...wall('left', 0, 0, 1, 1), a: point(0), b: point(100) }
      const right = { ...wall('right', 0, 0, 1, 1), a: point(126), b: point(250) }
      const at = point(113)
      for (const wallId of [null, 'left', 'right']) {
        const original = makeModel({
          openings: [{ ...door('gap', at.x, at.y, 26, wallId) }],
          walls: [left, right],
        })
        let model = original
        for (let pass = 0; pass < 3; pass++) {
          model = normalizeFloorModel(model).model
          expect(model.openings[0]!.at).toEqual(at)
          expect(model.openings[0]!.width).toBe(26)
          expect(model.openings[0]!.wallId).toBeNull()
        }
        expect(original.openings[0]!.at).toEqual(at)
        expect(original.openings[0]!.wallId).toBe(wallId)
      }
    }
  })

  test('valid stated walls snap perpendicularly; unsupported associations use only a nearby legal wall', () => {
    const original = makeModel({
      walls: [wall('near', 100, 100, 500, 100), wall('far', 100, 400, 500, 400)],
      openings: [
        door('stated', 200, 106, 30, 'near'),
        door('wrong-host', 400, 108, 30, 'far'),
        door('beyond-end', 513, 100, 26, 'near'),
        door('orphan', 800, 700, 30, 'far'),
      ],
    })
    const { model } = normalizeFloorModel(original)
    expect(model.openings.find((opening) => opening.id === 'stated')).toMatchObject({ at: { x: 200, y: 100 }, wallId: 'near' })
    expect(model.openings.find((opening) => opening.id === 'wrong-host')).toMatchObject({ at: { x: 400, y: 100 }, wallId: 'near' })
    expect(model.openings.find((opening) => opening.id === 'beyond-end')).toMatchObject({ at: { x: 513, y: 100 }, wallId: null })
    expect(model.openings.find((opening) => opening.id === 'orphan')).toMatchObject({ at: { x: 800, y: 700 }, wallId: null })
  })

  test('an opening between opposed returns is not snapped sideways to their endpoints', () => {
    // Theatre live repair: both returns are within the 21px attachment radius.
    for (const wallId of [null, 'left', 'right']) {
      const original = makeModel({
        walls: [wall('left', 490, 665, 490, 618, 14), wall('right', 530, 665, 530, 618, 14)],
        openings: [door('gap', 510, 665, 40, wallId)],
      })
      let model = original
      for (let pass = 0; pass < 3; pass++) {
        model = normalizeFloorModel(model).model
        expect(model.openings[0]).toEqual({ ...original.openings[0]!, wallId: null })
        expect(model.walls).toEqual(original.walls)
      }
    }
    // Already coincident endpoint records do not move or lose their association.
    const exact = makeModel({ walls: [wall('host', 100, 100, 500, 100)],
      openings: [door('end', 500, 100, 40, 'host')] })
    expect(normalizeFloorModel(exact).model.openings).toEqual(exact.openings)
  })

  test('merges double-reported doors on the same wall', () => {
    const { model } = normalizeFloorModel(
      makeModel({
        openings: [door('d-1', 300, 100, 40), door('d-2', 310, 100, 40)],
        walls: [wall('w-1', 100, 100, 500, 100)],
      }),
    )
    expect(model.openings).toHaveLength(1)
  })

  test('clubs overlapping same-label furniture without culling more than fourteen named landmarks', () => {
    const namedLandmarks = Array.from({ length: 18 }, (_, i) =>
      block(`fur-${i}`, `Exhibit ${i + 1}`, 10 + i * 45, 700, 30 + i * 45, 720),
    )
    const curvedLandmark = {
      ...block('fur-landmark', 'Memory Circle', 0, 0, 1, 1),
      polygon: Array.from({ length: 16 }, (_, i) => ({
        x: 700 + 60 * Math.cos(i * Math.PI / 8),
        y: 350 + 60 * Math.sin(i * Math.PI / 8),
      })),
    }
    const { model, notes } = normalizeFloorModel(
      makeModel({
        furniture: [
          block('fur-a', 'chairs', 100, 100, 200, 160),
          block('fur-b', 'chairs', 140, 100, 240, 160),
          block('fur-desk', 'reception desk', 400, 400, 600, 460),
          ...namedLandmarks,
          curvedLandmark,
        ],
      }),
    )
    const chairs = model.furniture.filter((f) => f.label === 'chairs')
    expect(chairs).toHaveLength(1)
    expect(chairs[0]!.polygon).toEqual(block('merged', 'chairs', 100, 100, 240, 160).polygon)
    expect(model.furniture).toHaveLength(namedLandmarks.length + 3)
    expect(model.furniture.filter((item) => item.label.startsWith('Exhibit '))).toEqual(namedLandmarks)
    expect(model.furniture.find((item) => item.id === curvedLandmark.id)).toEqual(curvedLandmark)
    expect(model.furniture.some((f) => f.label === 'reception desk')).toBe(true)
    expect(notes.join(' ')).toContain('clubbed 1')
    expect(notes.join(' ')).not.toContain('dropped')
  })

  test('preserves seating aisles and non-rectangular unions despite overlapping bounds', () => {
    // Two source seating sections, translated from the theatre regression.
    const seating = [
      { ...block('upper', 'chairs', 0, 0, 1, 1), polygon: [
        { x: 23, y: 71 }, { x: 334, y: 20 }, { x: 448, y: 54 }, { x: 448, y: 578 },
        { x: 305, y: 597 }, { x: 305, y: 629 }, { x: 120, y: 661 }, { x: 22, y: 322 },
      ] },
      { ...block('lower', 'chairs', 0, 0, 1, 1), polygon: [
        { x: 301, y: 601 }, { x: 448, y: 601 }, { x: 448, y: 743 },
        { x: 370, y: 737 }, { x: 301, y: 718 },
      ] },
    ]
    const offsetRectangles = [
      block('left', 'chairs', 100, 100, 200, 200),
      block('right', 'chairs', 130, 130, 230, 230),
    ]
    for (const furniture of [seating, offsetRectangles]) {
      const { model, notes } = normalizeFloorModel(makeModel({ furniture }))
      expect(model.furniture).toEqual(furniture)
      expect(notes).toHaveLength(0)
    }
  })

  test('straightens slightly skewed rectangles without changing deliberate polygons', () => {
    const desk = block('fur-desk', 'desk', 100, 100, 300, 220)
    desk.polygon[2] = { x: 295, y: 224 }
    const hexagon = Array.from({ length: 6 }, (_, index) => {
      const angle = (index / 6) * Math.PI * 2
      return { x: 500 + Math.cos(angle) * 80, y: 400 + Math.sin(angle) * 80 }
    })
    const { model, notes } = normalizeFloorModel(
      makeModel({
        furniture: [
          desk,
          { ...block('fur-fountain', 'fountain', 0, 0, 1, 1), polygon: hexagon },
        ],
      }),
    )

    expect(model.furniture.find((item) => item.id === 'fur-desk')!.polygon).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 224 },
      { x: 100, y: 224 },
    ])
    expect(orthogonalizeNearRectangle(hexagon)).toBe(hexagon)
    expect(notes.join(' ')).toContain('straightened 1')
  })

  test('keeps a clean model untouched', () => {
    const { model, notes } = normalizeFloorModel(sampleFloorModel)
    expect(model.walls).toHaveLength(sampleFloorModel.walls.length)
    expect(model.openings).toHaveLength(sampleFloorModel.openings.length)
    expect(notes).toHaveLength(0)
  })
})

describe('auditFloorModel', () => {
  test('reports a doorway-width gap between aligned walls as a candidate', () => {
    const model = makeModel({
      // Aligned horizontal walls with a 42px gap; three existing openings
      // calibrate the plausible door width.
      openings: [
        door('d-1', 150, 100, 40, 'w-1'),
        door('d-2', 800, 100, 40, 'w-2'),
        door('d-3', 850, 100, 40, 'w-2'),
      ],
      walls: [wall('w-1', 100, 100, 400, 100), wall('w-2', 442, 100, 900, 100)],
    })
    const findings = auditFloorModel(model)
    const gap = findings.find((f) => f.kind === 'gap-candidate')
    expect(gap).toBeDefined()
    expect(gap!.message).toContain('w-1')
    expect(gap!.message).toContain('w-2')
    expect(Math.round(gap!.at.x)).toBe(421)
  })

  test('does not report a gap already covered by an opening or a junction', () => {
    const covered = makeModel({
      openings: [
        door('d-1', 421, 100, 44, 'w-1'),
        door('d-2', 800, 100, 40, 'w-2'),
        door('d-3', 850, 100, 40, 'w-2'),
      ],
      walls: [wall('w-1', 100, 100, 400, 100), wall('w-2', 442, 100, 900, 100)],
    })
    expect(auditFloorModel(covered).filter((f) => f.kind === 'gap-candidate')).toHaveLength(0)

    const junction = makeModel({
      openings: [
        door('d-1', 150, 100, 40, 'w-1'),
        door('d-2', 800, 100, 40, 'w-2'),
        door('d-3', 850, 100, 40, 'w-2'),
      ],
      walls: [
        wall('w-1', 100, 100, 400, 100),
        wall('w-2', 442, 100, 900, 100),
        // A crossing wall through the gap: junction, not doorway.
        wall('w-3', 421, 60, 421, 400),
      ],
    })
    expect(auditFloorModel(junction).filter((f) => f.kind === 'gap-candidate')).toHaveLength(0)
  })

  test('reports sealed walled rooms but not campus block plans', () => {
    const sealed = makeModel({
      rooms: [
        {
          confidence: 0.9,
          id: 'r-1',
          kind: 'room',
          label: 'Store',
          polygon: [
            { x: 100, y: 100 },
            { x: 300, y: 100 },
            { x: 300, y: 300 },
            { x: 100, y: 300 },
          ],
        },
      ],
      walls: [
        wall('w-1', 100, 100, 300, 100),
        wall('w-2', 300, 100, 300, 300),
        wall('w-3', 300, 300, 100, 300),
        wall('w-4', 100, 300, 100, 100),
      ],
    })
    expect(auditFloorModel(sealed).some((f) => f.kind === 'sealed-room')).toBe(true)

    const campus = makeModel({
      rooms: Array.from({ length: 10 }, (_, i) => ({
        confidence: 0.9,
        id: `b-${i}`,
        kind: 'room' as const,
        label: `Building ${i}`,
        polygon: [
          { x: 50 + i * 90, y: 50 },
          { x: 120 + i * 90, y: 50 },
          { x: 120 + i * 90, y: 120 },
          { x: 50 + i * 90, y: 120 },
        ],
      })),
    })
    expect(auditFloorModel(campus).some((f) => f.kind === 'sealed-room')).toBe(false)
  })

  test('flags perimeter entrances that have no gate opening', () => {
    const model = makeModel({
      features: [
        { at: { x: 100, y: 300 }, confidence: 0.9, id: 'f-1', kind: 'entrance', rotation: 90 },
      ],
      openings: [door('d-1', 500, 100, 40, 'w-1')],
      walls: [wall('w-1', 100, 100, 900, 100), wall('w-2', 100, 100, 100, 700)],
    })
    const findings = auditFloorModel(model)
    expect(findings.some((f) => f.kind === 'entrance-without-gate')).toBe(true)

    const gated = makeModel({
      ...model,
      openings: [...model.openings, door('d-2', 100, 330, 50, 'w-2')],
    })
    expect(
      auditFloorModel(gated).some((f) => f.kind === 'entrance-without-gate'),
    ).toBe(false)
  })

  test('flags door pairs close enough to be one drawn opening', () => {
    const model = makeModel({
      openings: [
        door('d-1', 400, 300, 70, 'w-1'),
        door('d-2', 405, 395, 80, 'w-2'),
      ],
      walls: [wall('w-1', 100, 300, 900, 300), wall('w-2', 100, 395, 900, 395)],
    })
    const findings = auditFloorModel(model)
    expect(findings.some((f) => f.kind === 'door-pair')).toBe(true)
  })

  test('flags clusters of short parallel walls as likely stair treads', () => {
    const treads = Array.from({ length: 6 }, (_, i) =>
      wall(`t-${i}`, 300, 400 + i * 14, 345, 400 + i * 14, 3),
    )
    const model = makeModel({
      walls: [wall('w-long', 100, 100, 900, 100), ...treads],
    })
    const findings = auditFloorModel(model)
    const tread = findings.find((f) => f.kind === 'stair-treads')
    expect(tread).toBeDefined()
    expect(tread!.message).toContain('t-0')
  })

  test('reports openings that lie on no wall', () => {
    const model = makeModel({
      openings: [door('d-1', 700, 500)],
      walls: [wall('w-1', 100, 100, 500, 100)],
    })
    const findings = auditFloorModel(model)
    expect(findings.some((f) => f.kind === 'orphan-opening')).toBe(true)
  })

  test('finds nothing to flag on the clean sample model', () => {
    const { model } = normalizeFloorModel(sampleFloorModel)
    expect(auditFloorModel(model)).toHaveLength(0)
  })
})
