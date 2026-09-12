import { describe, expect, test } from 'bun:test'
import {
  fitRectInPolygon,
  floorModelSchema,
  resolveMechanicalViolations,
  assignKeys,
  buildValidationContext,
  validateTactileDesign,
  BRAILLE_MM,
  convertToTactile,
  paginateBrailleRows,
  planToPlateTransform,
  PLATE,
  sampleFloorModel,
  tactileDesignSchema,
  textBrailleSize,
  textDotCenters,
  textToBrailleCells,
} from '../src'

test('explicit plate grids retain source data and use matching validation coordinates', () => {
  const before = JSON.stringify(sampleFloorModel)
  const grid = { rows: 3, cols: 2 }
  const { design } = convertToTactile(sampleFloorModel, grid)
  expect(design.grid).toEqual(grid)
  expect(design.mmPerPx).toBe(planToPlateTransform(sampleFloorModel, grid).mmPerPx)
  expect(() => buildValidationContext(sampleFloorModel, design)).not.toThrow()
  expect(JSON.stringify(sampleFloorModel)).toBe(before)
  for (const value of [0, 5, 1.5, NaN]) {
    expect(() => convertToTactile(sampleFloorModel, { rows: value, cols: 2 })).toThrow('Plate grid')
    expect(() => convertToTactile(sampleFloorModel, { rows: 2, cols: value })).toThrow('Plate grid')
  }
})

describe('braille', () => {
  test('letters, digits, and spaces translate to Grade 1 cells', () => {
    expect(textToBrailleCells('ab')).toEqual([[1], [1, 2]])
    // Digits get one number sign per run: "r2" = r, #, b
    expect(textToBrailleCells('r2')).toEqual([
      [1, 2, 3, 5],
      [3, 4, 5, 6],
      [1, 2],
    ])
    expect(textToBrailleCells('a b')).toEqual([[1], [], [1, 2]])
  })

  test('dot geometry follows ADA spacing', () => {
    const dots = textDotCenters('c', { x: 0, y: 0 })
    // c = dots 1,4: two dots one column apart
    expect(dots).toEqual([
      { x: BRAILLE_MM.dotDiameter / 2, y: BRAILLE_MM.dotDiameter / 2 },
      { x: BRAILLE_MM.dotPitchX + BRAILLE_MM.dotDiameter / 2, y: BRAILLE_MM.dotDiameter / 2 },
    ])
    const two = textDotCenters('aa', { x: 0, y: 0 })
    expect(two[1]!.x).toBe(BRAILLE_MM.cellPitch + BRAILLE_MM.dotDiameter / 2)
    expect(textBrailleSize('ab').widthMm).toBeCloseTo(
      BRAILLE_MM.cellPitch + BRAILLE_MM.dotPitchX + BRAILLE_MM.dotDiameter,
    )
  })

  test('legend rows paginate before braille crosses the plate margin', () => {
    const rows = Array.from({ length: 22 }, (_, index) => `row ${index + 1}`)
    const pages = paginateBrailleRows(rows, PLATE)
    expect(pages.map((page) => page.length)).toEqual([18, 4])
    expect(pages.flat()).toEqual(rows)
  })
})

describe('key assignment', () => {
  test('keys are unique 1-2 letter codes', () => {
    const keys = assignKeys(['Studio', 'Stairs', 'Storage', 'Corridor'])
    const values = [...keys.values()]
    expect(new Set(values).size).toBe(4)
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(2)
      expect(value.length).toBeGreaterThan(0)
    }
    expect(keys.get('Corridor')).toBe('co')
  })

  test('dense and numeric room names keep compact keys without losing full names', () => {
    const labels = Array.from({ length: 100 }, (_, index) => `Room ${index + 100}`)
    const keys = assignKeys([...labels, labels[0]!])
    expect([...keys.keys()]).toEqual(labels)
    expect(new Set(keys.values()).size).toBe(labels.length)
    for (const key of keys.values()) {
      expect(key).toMatch(/^[a-z]{1,2}$/)
      expect(textToBrailleCells(key)).toHaveLength(key.length)
    }
    expect(assignKeys(labels)).toEqual(keys)
    const numeric = assignKeys(Array.from({ length: 703 }, (_, index) => String(index)))
    expect(new Set(numeric.values()).size).toBe(703)
    expect(numeric.get('701')).toBe('zz')
    expect(numeric.get('702')).toBe('aaa')
  })
})

describe('convertToTactile', () => {
  const { design, notes } = convertToTactile(sampleFloorModel)

  test('produces a schema-valid design that fits the plate', () => {
    tactileDesignSchema.parse(design)
    expect(design.plate.widthMm).toBe(PLATE.widthMm)
    for (const element of design.elements) {
      const points =
        element.kind === 'line'
          ? element.points
          : element.kind === 'area'
            ? element.polygon
            : [element.at]
      for (const p of points) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(PLATE.widthMm)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(PLATE.heightMm)
      }
    }
  })

  test('walls become 2mm/1mm lines split at doorways; windows drop with a note', () => {
    const lines = design.elements.filter(
      (e) => e.kind === 'line' && e.style === 'solid',
    )
    // 8 walls; two corridor walls carry 2 doors each (3 segments), the
    // bottom wall 1 door (2 segments): 5 + 3 + 3 + 2 = 13 segments.
    expect(lines).toHaveLength(13)
    for (const line of lines) {
      expect(line.kind === 'line' && line.widthMm).toBe(2)
      expect(line.kind === 'line' && line.heightMm).toBe(1)
    }
    expect(notes.some((n) => n.kind === 'dropped-window')).toBe(true)
    const symbols = design.elements.filter((e) => e.kind === 'symbol')
    // Four plan features plus the north arrow; doors are gaps, not symbols.
    expect(symbols).toHaveLength(5)
    expect(symbols.every((s) => s.symbol !== 'door')).toBe(true)
    expect(symbols.every((s) => s.heightMm === 1.5)).toBe(true)
  })

  test('labels become unique braille keys with legend entries', () => {
    const braille = design.elements.filter(
      (e) => e.kind === 'braille' && e.sourceId !== null,
    )
    // 5 labeled rooms + 2 furniture blocks + 1 labeled road.
    // (The plate title is a separate source-less braille run.)
    expect(braille).toHaveLength(8)
    const keys = design.legend.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(design.separateLegendPlate).toBe(design.legend.length > 0)
  })

  test('even a one-entry legend prints separately', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, title: null, walls: [], openings: [],
      rooms: [], furniture: [], roads: [], paths: [],
      features: [{ ...sampleFloorModel.features[0], label: 'North stairwell' }] })
    const { design } = convertToTactile(model)
    expect(design.legend).toHaveLength(1)
    expect(design.separateLegendPlate).toBe(true)
    model.features = []
    expect(convertToTactile(model).design.separateLegendPlate).toBe(false)
  })

  test('room area measurements do not become navigation labels', () => {
    const model = structuredClone(sampleFloorModel)
    model.rooms[0]!.label = '139 SF'
    const result = convertToTactile(model)
    expect(result.design.elements.some((element) => element.id === 't-label-r-nw')).toBe(
      false,
    )
    expect(result.design.legend.some((entry) => entry.text === '139 sf')).toBe(false)
  })

  test('furniture becomes low-relief labeled blocks', () => {
    const areas = design.elements.filter(
      (e) => e.kind === 'area' && e.sourceId?.startsWith('fur-'),
    )
    expect(areas).toHaveLength(2)
    for (const area of areas) {
      if (area.kind !== 'area') throw new Error('Expected tactile area')
      expect(area.heightMm).toBe(0.5)
      expect(area.texture).toBe('solid')
    }
    const texts = design.legend.map((entry) => entry.text)
    expect(texts).toContain('chairs')
    expect(texts).toContain('sofa')
    // Keys sit on their blocks
    const chairKey = design.elements.find((e) => e.id === 't-label-fur-chairs')
    expect(chairKey?.kind).toBe('braille')
  })

  test('sub-fingertip furniture is omitted with a note', () => {
    const model = structuredClone(sampleFloorModel)
    model.furniture = [
      {
        confidence: 0.9,
        id: 'fur-tiny',
        kind: 'furniture',
        label: 'tiny counter',
        polygon: [
          { x: 10, y: 10 },
          { x: 11, y: 10 },
          { x: 11, y: 11 },
          { x: 10, y: 11 },
        ],
      },
    ]
    const result = convertToTactile(model)
    expect(result.design.elements.some((element) => element.sourceId === 'fur-tiny')).toBe(
      false,
    )
    expect(
      result.notes.some(
        (note) => note.kind === 'dropped-furniture' && note.elementId === 'fur-tiny',
      ),
    ).toBe(true)
  })

  test('furniture too narrow for braille keeps its block and an adjacent key', () => {
    const model = structuredClone(sampleFloorModel)
    model.furniture = [
      {
        confidence: 0.9,
        id: 'fur-narrow',
        kind: 'furniture',
        label: 'counter',
        polygon: [
          { x: 120, y: 250 },
          { x: 220, y: 250 },
          { x: 220, y: 280 },
          { x: 120, y: 280 },
        ],
      },
    ]
    const result = convertToTactile(model)
    expect(result.design.elements.some((element) => element.id === 't-fur-narrow')).toBe(true)
    const label = result.design.elements.find((element) => element.id === 't-label-fur-narrow')
    expect(label?.kind).toBe('braille')
    if (!label || label.kind !== 'braille') throw new Error('Expected counter key')
    expect(label.at.y).toBeCloseTo(planToPlateTransform(model).toMm({ x: 120, y: 280 }).y + 4.5)
    expect(result.design.legend.some((entry) => entry.key === label.key && entry.text === 'counter')).toBe(true)
    expect(validateTactileDesign(result.design, buildValidationContext(model)).filter(
      (violation) => violation.rule === 'label-fit' && violation.elementIds.includes(label.id),
    )).toHaveLength(0)
  })

  test('a U-shaped service desk retains its exact name beside its source block', () => {
    const model = structuredClone(sampleFloorModel)
    model.furniture = [{
      confidence: 1, id: 'service-desk', kind: 'furniture', label: 'Visitor Services Desk',
      polygon: [
        { x: 120, y: 200 }, { x: 220, y: 200 }, { x: 220, y: 250 },
        { x: 210, y: 250 }, { x: 210, y: 210 }, { x: 130, y: 210 },
        { x: 130, y: 250 }, { x: 120, y: 250 },
      ],
    }]
    const { design } = convertToTactile(model)
    const block = design.elements.find((element) => element.id === 't-service-desk')
    const label = design.elements.find((element) => element.id === 't-label-service-desk')
    if (block?.kind !== 'area' || label?.kind !== 'braille') throw new Error('Expected desk block and key')
    const size = textBrailleSize(label.key)
    expect(fitRectInPolygon(size.widthMm, size.heightMm, block.polygon, block.polygon[0]!)).toBeNull()
    expect(block.polygon).toEqual(model.furniture[0]!.polygon.map(planToPlateTransform(model).toMm))
    expect(label.at.y).toBeCloseTo(Math.max(...block.polygon.map((point) => point.y)) + 4.5)
    expect(design.legend).toContainEqual({ key: label.key, text: 'visitor services desk' })
    expect(validateTactileDesign(design, buildValidationContext(model)).filter(
      (violation) => violation.rule === 'label-fit' && violation.elementIds.includes(label.id),
    )).toHaveLength(0)
  })

  test('qualified features and named exits retain legend text without moving their source symbols', () => {
    const model = floorModelSchema.parse({
      ...sampleFloorModel, title: null,
      plan: { ...sampleFloorModel.plan, north: null },
      walls: [], openings: [], furniture: [], roads: [], paths: [],
      rooms: [{
        id: 'outline', kind: 'room', label: null, confidence: 1,
        polygon: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 }],
      }],
      features: [
        { id: 'accessible-wc', kind: 'restroom', label: 'Accessible Unisex Restroom', at: { x: 250, y: 200 }, rotation: 0, confidence: 1 },
        { id: 'east-exit', kind: 'exit', label: 'East Exit', at: { x: 700, y: 600 }, rotation: 90, confidence: 1 },
        { id: 'stairs', kind: 'stairs', at: { x: 500, y: 400 }, rotation: 0, confidence: 1 },
      ],
    })
    const { design } = convertToTactile(model)
    const context = buildValidationContext(model, design)
    expect(validateTactileDesign(design, context)).toHaveLength(0)
    const repaired = resolveMechanicalViolations(design, context)
    tactileDesignSchema.parse(JSON.parse(JSON.stringify(repaired)))
    for (const feature of model.features.slice(0, 2)) {
      const symbol = repaired.elements.find((element) => element.id === `t-${feature.id}`)
      const label = repaired.elements.find((element) => element.id === `t-label-${feature.id}`)
      if (symbol?.kind !== 'symbol' || label?.kind !== 'braille') throw new Error('Expected feature symbol and key')
      expect(symbol.symbol).toBe(feature.kind)
      expect(symbol.at).toEqual(planToPlateTransform(model).toMm(feature.at))
      expect(symbol.rotation).toBe(feature.rotation)
      expect(repaired.legend).toContainEqual({ key: label.key, text: feature.label!.toLowerCase() })
    }
    expect(repaired.elements.some((element) => element.id === 't-label-stairs')).toBe(false)
  })

  test('generic feature names and exact colocated room names do not duplicate braille keys', () => {
    const model = floorModelSchema.parse({
      ...sampleFloorModel, walls: [], openings: [], furniture: [], roads: [], paths: [],
      rooms: [
        { id: 'lift-room', kind: 'room', label: 'Elevator', confidence: 1,
          polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] },
        { id: 'exit-room', kind: 'room', label: 'East Exit', confidence: 1,
          polygon: [{ x: 200, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 }, { x: 200, y: 100 }] },
        { id: 'distant-room', kind: 'room', label: 'East Exit', confidence: 1,
          polygon: [{ x: 400, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 100 }, { x: 400, y: 100 }] },
      ],
      features: [
        { id: 'lift', kind: 'elevator', label: 'Elevator', at: { x: 50, y: 50 }, confidence: 1 },
        { id: 'exit', kind: 'exit', label: 'East Exit', at: { x: 250, y: 50 }, confidence: 1 },
        { id: 'seating', kind: 'seating', label: 'wheelchair seating', at: { x: 150, y: 50 }, confidence: 1 },
        { id: 'qualified-lift', kind: 'elevator', label: 'Accessible Elevator', at: { x: 350, y: 50 }, confidence: 1 },
      ],
    })
    const before = JSON.stringify(model)
    const { design } = convertToTactile(model)
    expect(JSON.stringify(model)).toBe(before)
    expect(design.elements.filter((element) => element.kind === 'symbol' && element.sourceId)).toHaveLength(4)
    for (const id of ['t-label-lift', 't-label-lift-room', 't-label-exit-room']) {
      expect(design.elements.some((element) => element.id === id)).toBe(false)
    }
    for (const id of ['t-label-exit', 't-label-distant-room', 't-label-seating', 't-label-qualified-lift']) {
      expect(design.elements.some((element) => element.id === id)).toBe(true)
    }
    // A site map must keep every building footprint even when its key is redundant.
    expect(design.elements.filter((element) => element.kind === 'area')).toHaveLength(3)
    for (const text of ['east exit', 'wheelchair seating', 'accessible elevator']) {
      expect(design.legend.some((entry) => entry.text === text)).toBe(true)
    }
  })

  test('round landmarks retain their polygon instead of becoming boxes', () => {
    const model = structuredClone(sampleFloorModel)
    model.furniture = [
      {
        confidence: 0.95,
        id: 'fur-fountain',
        kind: 'furniture',
        label: 'fountain',
        polygon: Array.from({ length: 16 }, (_, index) => {
          const angle = (index / 16) * Math.PI * 2
          return { x: 500 + Math.cos(angle) * 90, y: 400 + Math.sin(angle) * 90 }
        }),
      },
    ]
    const { design } = convertToTactile(model)
    const fountain = design.elements.find(
      (element) => element.kind === 'area' && element.sourceId === 'fur-fountain',
    )

    expect(fountain?.kind).toBe('area')
    if (!fountain || fountain.kind !== 'area') return
    expect(fountain.polygon).toHaveLength(16)
  })

  test('roads become low-relief bands with keyed labels', () => {
    const roadAreas = design.elements.filter(
      (e) => e.kind === 'area' && e.sourceId === 'road-1',
    )
    expect(roadAreas).toHaveLength(1)
    expect(roadAreas[0]!.kind).toBe('area')
    if (roadAreas[0]!.kind !== 'area') throw new Error('Expected road area')
    expect(roadAreas[0]!.heightMm).toBe(0.5)
    expect(design.legend.some((entry) => entry.text === 'main st')).toBe(true)
    expect(design.elements.some((e) => e.id === 't-label-road-1')).toBe(true)
  })

  test('roads and paths participate in the plate bounds', () => {
    const model = structuredClone(sampleFloorModel)
    model.roads[0]!.points = [
      { x: -200, y: 790 },
      { x: 1200, y: 790 },
    ]
    model.roads[0]!.widthPx = 100
    model.paths[0]!.points.push({ x: 1300, y: 400 })
    const { bounds } = planToPlateTransform(model)
    expect(bounds.minX).toBe(-200)
    expect(bounds.maxX).toBe(1300)
  })

  test('road bounds follow butt-ended bands and only emitted interior joint patches', () => {
    const diagonalOffset = 100 / Math.sqrt(2)
    const cases = [
      { points: [{ x: 200, y: 100 }, { x: 200, y: 300 }],
        bounds: { minX: 100, maxX: 300, minY: 100, maxY: 300 } },
      { points: [{ x: 100, y: 200 }, { x: 300, y: 200 }],
        bounds: { minX: 100, maxX: 300, minY: 100, maxY: 300 } },
      { points: [{ x: 100, y: 100 }, { x: 300, y: 300 }],
        bounds: { minX: 100 - diagonalOffset, maxX: 300 + diagonalOffset,
          minY: 100 - diagonalOffset, maxY: 300 + diagonalOffset } },
      { points: [{ x: 200, y: 100 }, { x: 200, y: 101 }, { x: 200, y: 300 }],
        bounds: { minX: 100, maxX: 300, minY: 1, maxY: 300 } },
      { points: [{ x: 100, y: 100 }, { x: 101, y: 101 }, { x: 300, y: 300 }],
        bounds: { minX: 1, maxX: 300 + diagonalOffset, minY: 1, maxY: 300 + diagonalOffset } },
      { points: [{ x: 200, y: 100 }, { x: 200, y: 300 }, { x: 200, y: 300 }],
        bounds: { minX: 100, maxX: 300, minY: 100, maxY: 300 } },
    ]
    for (const item of cases) {
      const model = floorModelSchema.parse({
        ...sampleFloorModel, title: null, plan: { ...sampleFloorModel.plan, north: null },
        walls: [], rooms: [], openings: [], features: [], furniture: [], paths: [],
        roads: [{ id: 'road', kind: 'road', points: item.points, widthPx: 200, confidence: 1 }],
      })
      const before = JSON.stringify(model)
      const layout = planToPlateTransform(model)
      expect(layout.rows).toBe(1)
      expect(layout.cols).toBe(1)
      for (const key of ['minX', 'maxX', 'minY', 'maxY'] as const) {
        expect(layout.bounds[key]).toBeCloseTo(item.bounds[key], 10)
      }
      expect(layout.mmPerPx).toBeCloseTo(180 / Math.max(
        item.bounds.maxX - item.bounds.minX, item.bounds.maxY - item.bounds.minY,
      ), 10)
      const { design } = convertToTactile(model)
      const polygon = design.elements.flatMap(element => element.kind === 'area' ? element.polygon : [])
      const lower = layout.toMm({ x: item.bounds.minX, y: item.bounds.minY })
      const upper = layout.toMm({ x: item.bounds.maxX, y: item.bounds.maxY })
      expect(Math.min(...polygon.map(point => point.x))).toBeCloseTo(lower.x, 10)
      expect(Math.max(...polygon.map(point => point.x))).toBeCloseTo(upper.x, 10)
      expect(Math.min(...polygon.map(point => point.y))).toBeCloseTo(lower.y, 10)
      expect(Math.max(...polygon.map(point => point.y))).toBeCloseTo(upper.y, 10)
      expect(JSON.stringify(model)).toBe(before)
    }
  })

  test('a multi-segment road label validates against the whole road', () => {
    const model = structuredClone(sampleFloorModel)
    model.roads[0]!.points = [
      { x: 40, y: 760 },
      { x: 800, y: 760 },
      { x: 800, y: 700 },
      { x: 900, y: 700 },
    ]
    const { design } = convertToTactile(model)
    const violations = validateTactileDesign(
      design,
      buildValidationContext(model),
    )
    expect(
      violations.filter(
        (violation) =>
          violation.rule === 'label-fit' &&
          violation.elementIds.includes('t-label-road-1'),
      ),
    ).toHaveLength(0)
  })

  test('doorways leave fingertip-findable gaps in their wall', () => {
    // d-nw sits at x=250 on the corridor's north wall (y=380). No wall
    // segment from that wall may cover the door's position.
    const { mmPerPx, toMm } = planToPlateTransform(sampleFloorModel)
    const doorAt = toMm({ x: 250, y: 380 })
    const segments = design.elements.filter(
      (e) => e.kind === 'line' && e.sourceId === 'w-corridor-n',
    )
    expect(segments.length).toBe(3)
    for (const segment of segments) {
      if (segment.kind !== 'line') continue
      const xs = segment.points.map((p) => p.x)
      const covers =
        Math.min(...xs) <= doorAt.x && doorAt.x <= Math.max(...xs)
      expect(covers).toBe(false)
    }
    // The gap is at least the printed door width (>= the 6mm minimum).
    expect(45 * mmPerPx).toBeGreaterThan(0)
  })

  test('does not widen an existing wall gap for an unattached opening', () => {
    const model = structuredClone(sampleFloorModel)
    model.walls = [
      { ...model.walls[0]!, id: 'w-left', a: { x: 100, y: 100 }, b: { x: 450, y: 100 } },
      { ...model.walls[0]!, id: 'w-right', a: { x: 550, y: 100 }, b: { x: 900, y: 100 } },
    ]
    model.openings = [
      {
        at: { x: 500, y: 100 },
        confidence: 1,
        id: 'door-in-existing-gap',
        kind: 'door',
        wallId: null,
        width: 100,
      },
    ]
    model.rooms = []
    model.features = []
    model.furniture = []
    model.paths = []
    model.roads = []

    const { design } = convertToTactile(model)
    const { toMm } = planToPlateTransform(model)
    const left = design.elements.find((element) => element.sourceId === 'w-left')
    expect(left?.kind).toBe('line')
    if (!left || left.kind !== 'line') return
    expect(Math.max(...left.points.map((point) => point.x))).toBeCloseTo(
      toMm({ x: 450, y: 100 }).x,
    )
  })

  test('short wall legs survive when they form L, U, or T junctions', () => {
    const model = structuredClone(sampleFloorModel)
    model.openings = []
    model.walls.push(
      {
        a: { x: 250, y: 40 },
        b: { x: 250, y: 50 },
        confidence: 1,
        id: 'w-short-junction',
        kind: 'wall',
        thickness: 8,
      },
      {
        a: { x: 300, y: 300 },
        b: { x: 300, y: 310 },
        confidence: 1,
        id: 'w-short-isolated',
        kind: 'wall',
        thickness: 8,
      },
    )
    const { design, notes } = convertToTactile(model)
    expect(design.elements.some((element) => element.id === 't-w-short-junction')).toBe(
      true,
    )
    expect(design.elements.some((element) => element.id === 't-w-short-isolated')).toBe(
      false,
    )
    expect(
      notes.some(
        (note) =>
          note.kind === 'dropped-wall' && note.elementId === 'w-short-isolated',
      ),
    ).toBe(true)
  })

  test('door gaps never emit zero-length wall fragments', () => {
    const model = structuredClone(sampleFloorModel)
    model.openings.push({
      at: model.walls[0]!.a,
      confidence: 1,
      id: 'door-at-endpoint',
      kind: 'door',
      wallId: model.walls[0]!.id,
      width: 40,
    })
    const { design } = convertToTactile(model)
    const lines = design.elements.filter((element) => element.kind === 'line')

    expect(
      lines.every((line) =>
        line.points.slice(1).every((point, index) => {
          const previous = line.points[index]!
          return Math.hypot(point.x - previous.x, point.y - previous.y) > 0.01
        }),
      ),
    ).toBe(true)
  })

  test('you-are-here marker gets a braille key and legend text', () => {
    const withMarker = structuredClone(sampleFloorModel)
    withMarker.features.push({
      at: { x: 500, y: 700 },
      confidence: 1,
      id: 'f-yah',
      kind: 'you-are-here',
      rotation: 0,
    })
    const result = convertToTactile(withMarker)
    expect(
      result.design.legend.some((entry) => entry.text === 'you are here'),
    ).toBe(true)
    expect(
      result.design.elements.some((e) => e.id === 't-label-f-yah'),
    ).toBe(true)
  })
})

describe('sliver-room labels', () => {
  test('fitRectInPolygon rejects thin diagonal slivers despite a large bbox', () => {
    // Modeled on CCH's diagonal halls: a near-collinear parallelogram
    // whose bbox is 1400×1000 but whose band is ~12 units wide.
    const sliver = [
      { x: 2400, y: 2500 },
      { x: 2800, y: 2200 },
      { x: 3800, y: 1500 },
      { x: 3500, y: 1500 },
    ]
    expect(fitRectInPolygon(160, 130, sliver, { x: 3100, y: 1925 })).toBeNull()
    const square = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
      { x: 0, y: 300 },
    ]
    expect(fitRectInPolygon(160, 130, square, { x: 150, y: 150 })).not.toBeNull()
  })

  test('a sliver room gets an adjacent label and no label-fit violation', () => {
    const model = floorModelSchema.parse({
      ...sampleFloorModel,
      furniture: [],
      rooms: [
        {
          confidence: 1,
          id: 'r-sliver',
          kind: 'room',
          label: 'Hall D',
          polygon: [
            { x: 100, y: 500 },
            { x: 180, y: 440 },
            { x: 380, y: 300 },
            { x: 320, y: 300 },
          ],
        },
      ],
    })
    const { design } = convertToTactile(model)
    const label = design.elements.find(
      (e) => e.kind === 'braille' && e.sourceId === 'r-sliver',
    )
    expect(label).toBeDefined()
    const violations = validateTactileDesign(
      design,
      buildValidationContext(model),
    )
    expect(violations.filter((v) => v.rule === 'label-fit')).toHaveLength(0)
  })

  test('a room split by a plate seam may use an adjacent label', () => {
    const seamDesign = tactileDesignSchema.parse({
      elements: [
        {
          at: { x: 175, y: 80 },
          id: 't-label-seam-room',
          key: 'ma',
          kind: 'braille',
          sourceId: 'seam-room',
        },
      ],
      grid: { cols: 2, rows: 1 },
      legend: [{ key: 'ma', text: 'main hall' }],
      mmPerPx: 1,
      plate: PLATE,
      schemaVersion: 1,
      separateLegendPlate: false,
      title: null,
    })
    const violations = validateTactileDesign(seamDesign, {
      symbolAnchorsMm: [],
      doorOpeningsMm: [],
      roomsMm: [
        {
          id: 'seam-room',
          polygonMm: [
            { x: 190, y: 60 },
            { x: 210, y: 60 },
            { x: 210, y: 100 },
            { x: 190, y: 100 },
          ],
        },
      ],
      scaleFeaturesMm: [],
    })
    expect(violations.filter((violation) => violation.rule === 'label-fit')).toHaveLength(
      0,
    )
  })

})

describe('map fabric: paths, title, north', () => {
  const { design } = convertToTactile(sampleFloorModel)

  test('guide paths become dashed 1.5mm lines', () => {
    const dashed = design.elements.filter(
      (e) => e.kind === 'line' && e.style === 'dashed',
    )
    expect(dashed).toHaveLength(1)
    expect(dashed[0]!.kind === 'line' && dashed[0]!.widthMm).toBe(1.5)
  })

  test('the plate carries a braille title when it fits', () => {
    const title = design.elements.find((e) => e.id === 't-title')
    expect(title).toBeDefined()
    expect(title!.kind === 'braille' && title!.key).toBe('sample office floor')
  })

  test('a title has reserved clearance above the floor instead of requiring a layout move', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, title: 'fourth storey plan',
      features: [], furniture: [], rooms: [], paths: [], roads: [], openings: [],
      walls: [{ id: 'top', kind: 'wall', a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, thickness: 8, confidence: 1 },
        { id: 'left', kind: 'wall', a: { x: 0, y: 0 }, b: { x: 0, y: 400 }, thickness: 8, confidence: 1 }],
    })
    const titled = convertToTactile(model).design
    expect(validateTactileDesign(titled, buildValidationContext(model, titled))).toHaveLength(0)
    expect(titled.elements.find(e => e.id === 't-title')).toMatchObject({ at: { x: 10, y: 1.75 } })
    const plain = { ...model, title: null }
    expect(planToPlateTransform(plain).offsetY).toBe(PLATE.marginMm)
    expect(planToPlateTransform(model).offsetY).toBe(PLATE.marginMm + textBrailleSize('a').heightMm)
    // An unbreakable title that cannot print must not reduce source scale.
    const omitted = { ...model, title: 'a'.repeat(40) }
    expect(convertToTactile(omitted).design.elements.some(e => e.id === 't-title')).toBe(false)
    expect(planToPlateTransform(omitted).mmPerPx).toBe(planToPlateTransform(plain).mmPerPx)
    expect(planToPlateTransform(omitted).offsetY).toBe(PLATE.marginMm)
  })

  test('a known north renders as a rotated arrow symbol', () => {
    const north = design.elements.find((e) => e.id === 't-north')
    expect(north).toBeDefined()
    expect(north!.kind === 'symbol' && north!.symbol).toBe('north')
  })
})

describe('wall-less block plans', () => {
  test('labeled rooms render as raised blocks when the plan has no walls', () => {
    const model = floorModelSchema.parse({
      ...sampleFloorModel,
      furniture: [],
      openings: [],
      walls: [],
    })
    const { design, notes } = convertToTactile(model)
    const blocks = design.elements.filter(
      (e) => e.kind === 'area' && e.id.startsWith('t-room-'),
    )
    expect(blocks.length).toBeGreaterThan(0)
    expect(notes.some((n) => n.kind === 'room-block')).toBe(true)
  })
})

describe('mechanical seam fixes', () => {
  test('a point symbol outside the plate margin is clamped inside', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const symbolIndex = design.elements.findIndex((element) => element.kind === 'symbol')
    const outside = {
      ...design,
      elements: design.elements.map((element, index) =>
        index === symbolIndex && element.kind === 'symbol'
          ? { ...element, at: { x: 0, y: 0 } }
          : element,
      ),
    }
    const context = buildValidationContext(model)
    expect(validateTactileDesign(outside, context).some((v) => v.rule === 'margin')).toBe(
      true,
    )
    expect(
      validateTactileDesign(resolveMechanicalViolations(outside, context), context).some(
        (v) => v.rule === 'margin',
      ),
    ).toBe(false)
  })

  test('a room label outside the margin relocates without leaving its room', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const label = design.elements.find(
      (element) => element.kind === 'braille' && element.sourceId === 'r-nw',
    )
    expect(label?.kind).toBe('braille')
    if (!label || label.kind !== 'braille') return
    const outside = {
      ...design,
      elements: design.elements.map((element) =>
        element.id === label.id && element.kind === 'braille'
          ? { ...element, at: { x: 0, y: 0 } }
          : element,
      ),
    }
    const context = buildValidationContext(model)
    const fixed = resolveMechanicalViolations(outside, context)
    const remaining = validateTactileDesign(fixed, context)

    expect(
      remaining.some(
        (violation) =>
          violation.elementIds.includes(label.id) &&
          (violation.rule === 'margin' || violation.rule === 'label-fit'),
      ),
    ).toBe(false)
  })

  test('a symbol embedded in a wall moves far enough to clear its own radius', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const wall = design.elements.find(
      (element) => element.kind === 'line' && element.id === 't-w-left',
    )
    const symbol = design.elements.find(
      (element) => element.kind === 'symbol' && element.sourceId === 'f-elevator',
    )
    expect(wall?.kind).toBe('line')
    expect(symbol?.kind).toBe('symbol')
    if (!wall || wall.kind !== 'line' || !symbol || symbol.kind !== 'symbol') return
    const embedded = {
      ...design,
      elements: design.elements.map((element) =>
        element.id === symbol.id && element.kind === 'symbol'
          ? { ...element, at: { x: wall.points[0]!.x + 2, y: 150 } }
          : element,
      ),
    }
    const context = buildValidationContext(model)
    const target = (violation: { elementIds: string[]; rule: string }) =>
      violation.rule === 'clearance' &&
      violation.elementIds.includes(symbol.id) &&
      violation.elementIds.includes(wall.id)
    expect(validateTactileDesign(embedded, context).some(target)).toBe(true)
    expect(
      validateTactileDesign(
        resolveMechanicalViolations(embedded, context),
        context,
      ).some(target),
    ).toBe(false)
  })

  test('an unanchored symbol trapped between parallel walls can move diagonally clear', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const symbol = design.elements.find((element) => element.kind === 'symbol')
    expect(symbol?.kind).toBe('symbol')
    if (!symbol || symbol.kind !== 'symbol') return
    const barriers = Array.from({ length: 17 }, (_, index) => ({
      heightMm: 1,
      id: `barrier-${index}`,
      kind: 'line' as const,
      points: [
        { x: 90, y: 36 + index * 8 },
        { x: 110, y: 36 + index * 8 },
      ],
      sourceId: null,
      style: 'solid' as const,
      widthMm: 2,
    }))
    const trapped = {
      ...design,
      elements: [{ ...symbol, sourceId: null, at: { x: 100, y: 100 } }, ...barriers],
    }
    const context = buildValidationContext(model)
    expect(validateTactileDesign(trapped, context)).toHaveLength(1)
    expect(
      validateTactileDesign(resolveMechanicalViolations(trapped, context), context),
    ).toHaveLength(0)
  })

  test('a braille label straddling a seam is nudged clear deterministically', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const wide = {
      ...design,
      grid: { cols: 2, rows: 1 },
      elements: design.elements.map((e) =>
        e.kind === 'braille'
          ? { ...e, at: { x: design.plate.widthMm - 2, y: e.at.y } }
          : e,
      ),
    }
    const context = buildValidationContext(model)
    const before = validateTactileDesign(wide, context)
    expect(before.some((v) => v.rule === 'seam-clearance')).toBe(true)
    const fixed = resolveMechanicalViolations(wide, context)
    const after = validateTactileDesign(fixed, context)
    expect(after.filter((v) => v.rule === 'seam-clearance').length).toBeLessThan(
      before.filter((v) => v.rule === 'seam-clearance').length,
    )
    expect(after.length).toBeLessThanOrEqual(before.length)
  })

  test('a room label outside its room is relocated inside', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const label = design.elements.find(
      (element) => element.kind === 'braille' && element.sourceId === 'r-nw',
    )
    expect(label?.kind).toBe('braille')
    if (!label || label.kind !== 'braille') return
    const misplaced = {
      ...design,
      elements: design.elements.map((element) =>
        element.id === label.id && element.kind === 'braille'
          ? { ...element, at: { x: 170, y: 170 } }
          : element,
      ),
    }
    const context = buildValidationContext(model)
    const target = (violation: { elementIds: string[]; rule: string }) =>
      violation.rule === 'label-fit' && violation.elementIds.includes(label.id)
    expect(validateTactileDesign(misplaced, context).some(target)).toBe(true)
    expect(
      validateTactileDesign(
        resolveMechanicalViolations(misplaced, context),
        context,
      ).some(target),
    ).toBe(false)
  })

  test('repairs more than twelve independent seam conflicts', () => {
    const model = floorModelSchema.parse({ ...sampleFloorModel, furniture: [] })
    const { design } = convertToTactile(model)
    const label = design.elements.find((element) => element.kind === 'braille')
    expect(label?.kind).toBe('braille')
    if (!label || label.kind !== 'braille') return
    const crowded = {
      ...design,
      grid: { cols: 2, rows: 1 },
      elements: Array.from({ length: 13 }, (_, index) => ({
        ...label,
        at: { x: design.plate.widthMm - 2, y: 15 + index * 12 },
        id: `seam-label-${index}`,
        sourceId: null,
      })),
    }
    const context = buildValidationContext(model)
    const before = validateTactileDesign(crowded, context)
    expect(before.filter((violation) => violation.rule === 'seam-clearance')).toHaveLength(
      13,
    )
    const after = validateTactileDesign(
      resolveMechanicalViolations(crowded, context),
      context,
    )
    expect(after.some((violation) => violation.rule === 'seam-clearance')).toBe(false)
  })
})

describe('multi-plate deciding step', () => {
  // Streches the building; door widths stay fixed (as in reality: rooms
  // multiply, doors stay ~0.9 m) — which is exactly what forces multi-plate.
  function stretched(factor: number) {
    const model = structuredClone(sampleFloorModel)
    const scale = (p: { x: number; y: number }) => ({ x: p.x * factor, y: p.y })
    model.walls = model.walls.map((w) => ({ ...w, a: scale(w.a), b: scale(w.b) }))
    model.rooms = model.rooms.map((r) => ({ ...r, polygon: r.polygon.map(scale) }))
    model.openings = model.openings.map((o) => ({ ...o, at: scale(o.at) }))
    model.features = model.features.map((f) => ({ ...f, at: scale(f.at) }))
    model.furniture = model.furniture.map((f) => ({ ...f, polygon: f.polygon.map(scale) }))
    model.plan.widthPx *= factor
    return model
  }

  test('small floors stay on one plate', () => {
    const { design } = convertToTactile(sampleFloorModel)
    expect(design.grid).toEqual({ cols: 1, rows: 1 })
  })

  test('a wide floor grows beyond doorway-only scale to keep corridor symbols in place', () => {
    const model = stretched(3)
    const { design, notes } = convertToTactile(model)
    // Two columns fit the doors but leave <3mm clearance around the lift.
    expect(design.grid.cols).toBe(3)
    expect(design.grid.rows).toBe(1)
    expect(notes.some((n) => n.kind === 'multi-plate')).toBe(true)
  })

  test('a very wide floor uses four columns when its corridor glyph needs that scale', () => {
    const model = stretched(5)
    model.roads = []
    const { design } = convertToTactile(model)
    expect(design.grid).toEqual({ cols: 4, rows: 1 })
  })

  test('a wall-less site map uses more plates when footprints become unreadable', () => {
    const model = stretched(10)
    model.openings = []
    model.walls = []
    const { design } = convertToTactile(model)
    expect(design.grid.cols * design.grid.rows).toBeGreaterThan(1)
  })

  test('a sparse-wall site map uses the same footprint scale gate', () => {
    const model = stretched(10)
    model.openings = []
    model.rooms = Array.from({ length: 8 }, (_, index) => ({
      ...model.rooms[index % model.rooms.length]!,
      id: `building-${index}`,
      label: `building ${index}`,
    }))
    model.walls = model.walls.slice(0, 1)
    const { design } = convertToTactile(model)
    expect(design.grid.cols * design.grid.rows).toBeGreaterThan(1)
  })

  test('an enormous floor maxes at 4x4 and the scale gate fires', () => {
    const model = stretched(40)
    const { design } = convertToTactile(model)
    expect(design.grid).toEqual({ cols: 4, rows: 4 })
    const violations = validateTactileDesign(
      design,
      buildValidationContext(model),
    )
    expect(violations.some((v) => v.rule === 'scale')).toBe(true)
  })

  test('braille and symbols near a seam are flagged as movable violations', () => {
    const model = stretched(3)
    const { design } = convertToTactile(model)
    const label = design.elements.find((e) => e.kind === 'braille')
    if (label?.kind === 'braille') {
      label.at = { x: design.plate.widthMm - 4, y: 100 }
    }
    const violations = validateTactileDesign(
      design,
      buildValidationContext(model),
    )
    expect(violations.some((v) => v.rule === 'seam-clearance')).toBe(true)
  })
})

describe('source-aware plate scale', () => {
  const boundary = [
    { x: 0, y: 0 }, { x: 180, y: 0 },
    { x: 180, y: 180 }, { x: 0, y: 180 },
  ]
  const frame = floorModelSchema.parse({
    schemaVersion: 1,
    plan: { widthPx: 180, heightPx: 180 },
    walls: boundary.map((a, index) => ({
      id: `outer-${index}`, kind: 'wall', a, b: boundary[(index + 1) % 4],
      thickness: 2, confidence: 1,
    })),
    openings: [],
    rooms: [{ id: 'room', kind: 'room', polygon: boundary, label: null, confidence: 1 }],
    features: [{ id: 'stairs', kind: 'stairs', at: { x: 90, y: 90 }, confidence: 1 }],
  })

  test('rejects a grid whose seam leaves no legal position inside an elevator shaft', () => {
    const model = structuredClone(frame)
    const shaft = [
      { x: 85, y: 60 }, { x: 95, y: 60 },
      { x: 95, y: 100 }, { x: 85, y: 100 },
    ]
    model.rooms = [{ id: 'shaft', kind: 'room', polygon: shaft, label: null, confidence: 1 }]
    model.walls.push(...shaft.map((a, index) => ({
      id: `shaft-${index}`, kind: 'wall' as const, a, b: shaft[(index + 1) % 4]!,
      thickness: 2, confidence: 1,
    })))
    model.features = [{ id: 'lift', kind: 'elevator', at: { x: 90, y: 80 }, rotation: 0, confidence: 1 }]
    model.openings = [{ id: 'door', kind: 'door', at: { x: 30, y: 0 }, width: 4, wallId: 'outer-0', confidence: 1 }]
    // At 2x2 the shaft is wide enough, but its only wall-clear centers are
    // within 3.6 mm of x=200; glyph + seam clearance requires at least 6 mm.
    const blocked = planToPlateTransform(model, { rows: 2, cols: 2 })
    expect(blocked.symbolClearances[0]!.widthMm).toBeLessThan(3)
    const { design } = convertToTactile(model)
    expect(design.grid).toEqual({ rows: 2, cols: 3 })
    const context = buildValidationContext(model, design)
    const repaired = resolveMechanicalViolations(design, context)
    expect(validateTactileDesign(repaired, context)).toHaveLength(0)
  })

  test('a symbol fitting a printed door passage does not require extra tiles', () => {
    const model = structuredClone(frame)
    model.walls.push({
      id: 'middle', kind: 'wall', a: { x: 90, y: 0 }, b: { x: 90, y: 180 },
      thickness: 2, confidence: 1,
    })
    model.openings = [{
      id: 'door', kind: 'door', at: { x: 90, y: 90 }, width: 20,
      wallId: 'middle', confidence: 1,
    }]
    model.rooms[0]!.polygon = [
      { x: 85, y: 40 }, { x: 95, y: 40 },
      { x: 95, y: 140 }, { x: 85, y: 140 },
    ]

    const { design, notes } = convertToTactile(model)
    expect(design.grid).toEqual({ cols: 1, rows: 1 })
    expect(design.mmPerPx).toBe(1)
    expect(notes.some(note => note.kind === 'multi-plate')).toBe(false)
    const walls = design.elements.filter(element => element.kind === 'line' && element.sourceId === 'middle')
    expect(walls.map(wall => wall.kind === 'line' && wall.points)).toEqual([
      [{ x: 100, y: 10 }, { x: 100, y: 90 }],
      [{ x: 100, y: 110 }, { x: 100, y: 190 }],
    ])
    const symbol = design.elements.find(element => element.id === 't-stairs')
    expect(symbol?.kind === 'symbol' && symbol.at).toEqual({ x: 100, y: 100 })
    expect(validateTactileDesign(design, buildValidationContext(model, design))).toHaveLength(0)
  })

  test('a legal nudge along a rotated narrow corridor keeps a one-tile grid', () => {
    const angle = Math.PI / 8
    const at = (along: number, across: number) => ({
      x: 40 + along * Math.cos(angle) - across * Math.sin(angle),
      y: 40 + along * Math.sin(angle) + across * Math.cos(angle),
    })
    const shaft = [at(0, -7.05), at(100, -7.05), at(100, 7.05), at(0, 7.05)]
    const model = structuredClone(frame)
    model.rooms = [{ id: 'shaft', kind: 'room', polygon: shaft, label: null, confidence: 1 }]
    model.walls.push(...shaft.map((a, index) => ({
      id: `shaft-${index}`, kind: 'wall' as const, a, b: shaft[(index + 1) % 4]!,
      thickness: 2, confidence: 1,
    })))
    model.features[0]!.at = at(2, 0)
    model.features[0]!.rotation = 22.5

    const { design } = convertToTactile(model)
    expect(design.grid).toEqual({ cols: 1, rows: 1 })
    expect(design.mmPerPx).toBe(1)
    const context = buildValidationContext(model, design)
    expect(context.scaleFeaturesMm.find(feature => feature.id === 'stairs')!.widthMm).toBeGreaterThanOrEqual(3)
    expect(validateTactileDesign(design, context).some(violation => violation.rule === 'clearance')).toBe(true)

    // Independent legal placement proves that enlargement is unnecessary.
    const symbol = design.elements.find(element => element.id === 't-stairs')
    if (!symbol || symbol.kind !== 'symbol') throw new Error('Missing stairs fixture')
    const origin = { ...symbol.at }
    symbol.at = planToPlateTransform(model, { cols: 1, rows: 1 }).toMm(at(7.1, 0))
    expect(Math.hypot(symbol.at.x - origin.x, symbol.at.y - origin.y)).toBeCloseTo(5.1)
    expect(validateTactileDesign(design, context)).toHaveLength(0)
  })

  test('saved one-tile validation uses its fixed grid rather than a newer automatic choice', () => {
    const model = structuredClone(frame)
    // The current gate chooses a larger grid for this four-pixel doorway.
    model.openings = [{
      id: 'door', kind: 'door', at: { x: 90, y: 0 }, width: 4,
      wallId: 'outer-0', confidence: 1,
    }]
    const automatic = planToPlateTransform(model)
    expect({ cols: automatic.cols, rows: automatic.rows }).toEqual({ cols: 2, rows: 2 })
    const fixed = planToPlateTransform(model, { cols: 1, rows: 1 })
    expect(fixed.mmPerPx).toBe(1)
    const saved = tactileDesignSchema.parse({
      schemaVersion: 1, plate: PLATE, grid: { cols: 1, rows: 1 },
      mmPerPx: fixed.mmPerPx, legend: [], elements: [{
        id: 't-stairs', kind: 'symbol', symbol: 'stairs', sourceId: 'stairs',
        at: fixed.toMm(model.features[0]!.at),
      }],
    })
    const context = buildValidationContext(model, saved)
    expect(context.symbolAnchorsMm).toEqual([{ id: 'stairs', at: { x: 100, y: 100 }, roomIds: ['room'] }])
    expect(context.roomsMm[0]!.polygonMm).toEqual(boundary.map(fixed.toMm))
    expect(context.doorOpeningsMm).toEqual([{ id: 'door', widthMm: 4 }])
    expect(context.scaleFeaturesMm.find(feature => feature.id === 'door')!.widthMm).toBe(4)
    const violations = validateTactileDesign(saved, context)
    expect(violations.some(violation => violation.rule === 'source-anchor')).toBe(false)
    expect(violations.some(violation => violation.rule === 'scale' && violation.elementIds.includes('door'))).toBe(true)
    expect(() => buildValidationContext(model, { ...saved, mmPerPx: automatic.mmPerPx })).toThrow('scale does not match')
  })
})

describe('door cuts across overlapping wall records', () => {
  test('an unassigned opening between opposed returns does not notch either return', () => {
    const model = floorModelSchema.parse({ schemaVersion: 1, plan: { widthPx: 1000, heightPx: 800 },
      rooms: [], features: [],
      walls: [490, 530].map(x => ({ id: `return-${x}`, kind: 'wall', thickness: 14, confidence: 1,
        a: { x, y: 665 }, b: { x, y: 618 } })),
      openings: [{ id: 'gap', kind: 'door', at: { x: 510, y: 665 }, width: 40, wallId: null, confidence: 1 }] })
    const { design } = convertToTactile(model)
    const { toMm } = planToPlateTransform(model)
    for (const wall of model.walls) {
      const lines = design.elements.filter(element => element.kind === 'line' && element.sourceId === wall.id)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ points: [toMm(wall.a), toMm(wall.b)] })
    }
  })

  test('a door centered on a shared wall endpoint cuts both collinear halves', () => {
    for (const reverse of [false, true]) {
      const model = floorModelSchema.parse({ schemaVersion: 1, plan: { widthPx: 180, heightPx: 180 },
        rooms: [], features: [],
        walls: [[20, 90], [90, 160]].map(([a, b], i) => ({ id: `wall-${i}`, kind: 'wall', thickness: 2, confidence: 1,
          a: { x: 90, y: reverse ? b : a }, b: { x: 90, y: reverse ? a : b } })),
        openings: [{ id: 'door', kind: 'door', at: { x: 90, y: 90 }, width: 40, wallId: 'wall-0', confidence: 1 }] })
      const { design } = convertToTactile(model)
      const { toMm } = planToPlateTransform(model)
      const lines = design.elements.filter(e => e.kind === 'line')
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        for (const point of line.points) expect(Math.abs(point.y - toMm({ x: 90, y: 90 }).y)).toBeGreaterThanOrEqual(20 * design.mmPerPx - 0.01)
      }
    }
  })

  test('Yonkers diagonal doors stay open through rounded, reversed overlapping segments', () => {
    const model = floorModelSchema.parse({
      schemaVersion: 1,
      plan: { widthPx: 2000, heightPx: 2000 },
      rooms: [],
      features: [],
      walls: [
        { id: 'w-16', a: { x: 375.49, y: 965.57 }, b: { x: 533.31, y: 911.97 } },
        { id: 'w-17', a: { x: 533.31, y: 911.97 }, b: { x: 598, y: 890 } },
        { id: 'w-56', a: { x: 280, y: 998 }, b: { x: 598, y: 890 } },
      ].map(wall => ({ ...wall, kind: 'wall', thickness: 7, confidence: 1 })),
      openings: [
        { id: 'd-3', at: { x: 551.28, y: 905.87 }, width: 31, wallId: 'w-17' },
        { id: 'd-4', at: { x: 583.32, y: 894.99 }, width: 31, wallId: 'w-17' },
        { id: 'd-14', at: { x: 489.01, y: 927.02 }, width: 50, wallId: 'w-56' },
      ].map(door => ({ ...door, kind: 'door', confidence: 1 })),
    })
    for (const reverse of [false, true]) {
      const input = structuredClone(model)
      if (reverse) {
        for (const wall of input.walls) [wall.a, wall.b] = [wall.b, wall.a]
      }
      const before = structuredClone(input)
      const { design } = convertToTactile(input)
      const { toMm } = planToPlateTransform(input)
      const lines = design.elements.filter(element => element.kind === 'line')
      expect(lines.length).toBeGreaterThan(0)
      for (const door of input.openings) {
        const p = toMm(door.at)
        for (const line of lines) {
          const [a, b] = line.points
          const dx = b!.x - a!.x
          const dy = b!.y - a!.y
          const t = Math.max(0, Math.min(1, ((p.x - a!.x) * dx + (p.y - a!.y) * dy) / (dx * dx + dy * dy)))
          const gap = Math.hypot(p.x - a!.x - t * dx, p.y - a!.y - t * dy)
          expect(gap).toBeGreaterThanOrEqual(Math.max(door.width * design.mmPerPx, 6) / 2 - 0.01)
        }
      }
      expect(input).toEqual(before)
    }
  })

  test('nearby, crossing, and disjoint walls stay intact; an unhosted door cuts nothing', () => {
    const model = floorModelSchema.parse({
      schemaVersion: 1,
      plan: { widthPx: 180, heightPx: 180 },
      rooms: [],
      features: [],
      walls: [
        { id: 'host', a: { x: 20, y: 90 }, b: { x: 80, y: 90 } },
        { id: 'overlap', a: { x: 50, y: 90 }, b: { x: 120, y: 90 } },
        { id: 'nearby', a: { x: 20, y: 91 }, b: { x: 120, y: 91 } },
        { id: 'crossing', a: { x: 75, y: 40 }, b: { x: 75, y: 140 } },
        { id: 'disjoint', a: { x: 85, y: 90 }, b: { x: 130, y: 90 } },
        { id: 'outer-left', a: { x: 0, y: 0 }, b: { x: 0, y: 180 } },
        { id: 'outer-right', a: { x: 180, y: 0 }, b: { x: 180, y: 180 } },
      ].map(wall => ({ ...wall, kind: 'wall', thickness: 2, confidence: 1 })),
      openings: [
        { id: 'door', at: { x: 75, y: 90 }, width: 40, wallId: 'host' },
        { id: 'orphan', at: { x: 20, y: 160 }, width: 160, wallId: null },
      ].map(door => ({ ...door, kind: 'door', confidence: 1 })),
    })
    const { design } = convertToTactile(model)
    const { toMm } = planToPlateTransform(model)
    for (const wall of model.walls.filter(wall => !['host', 'overlap'].includes(wall.id))) {
      const lines = design.elements.filter(element => element.kind === 'line' && element.sourceId === wall.id)
      expect(lines).toHaveLength(1)
      expect(lines[0]!.kind === 'line' && lines[0]!.points).toEqual([toMm(wall.a), toMm(wall.b)])
    }
    const overlap = design.elements.filter(element => element.kind === 'line' && element.sourceId === 'overlap')
    expect(overlap.map(line => line.kind === 'line' && line.points)).toEqual([
      [toMm({ x: 50, y: 90 }), toMm({ x: 55, y: 90 })],
      [toMm({ x: 95, y: 90 }), toMm({ x: 120, y: 90 })],
    ])
  })
})

test('mechanical repair finishes a still-improving glyph/key layout before requiring an agent', () => {
  // Five elements reduced from the raw Yonkers conversion; three sweeps
  // stop with a clearance failure even though the next sweep resolves it.
  const at = { x: 61.49, y: 60.57 }
  const polygonMm = [
    { x: 46.32, y: 48.39 }, { x: 67.7, y: 48.39 },
    { x: 67.7, y: 72.76 }, { x: 46.32, y: 72.76 },
  ]
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, plate: {}, mmPerPx: 1, legend: [],
    elements: [
      ...[
        [46.32, 60.34, 46.32, 86.9], [46.32, 48.39, 67.7, 48.39],
        [46.32, 72.76, 67.7, 72.76],
      ].map(([x, y, bx, by], index) => ({
        id: `wall-${index}`, kind: 'line', points: [{ x, y }, { x: bx, y: by }], heightMm: 1,
      })),
      { id: 'glyph', kind: 'symbol', symbol: 'restroom', sourceId: 'feature', at },
      { id: 'label', kind: 'braille', sourceId: 'room', key: 'br', at: { x: 52.06, y: 57.32 } },
    ],
  })
  const context = {
    symbolAnchorsMm: [{ id: 'feature', at, roomIds: ['room'] }],
    roomsMm: [{ id: 'room', polygonMm }], scaleFeaturesMm: [], doorOpeningsMm: [],
  }
  expect(validateTactileDesign(design, context).length).toBeGreaterThan(0)
  expect(validateTactileDesign(resolveMechanicalViolations(design, context), context)).toHaveLength(0)
})

test('a header title may use the margin band but never leave the physical plate', () => {
  const context = { symbolAnchorsMm: [], roomsMm: [], scaleFeaturesMm: [], doorOpeningsMm: [] }
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, plate: {}, mmPerPx: 1, legend: [],
    elements: [{ id: 't-title', kind: 'braille', key: 'fourth storey plan', at: { x: 10, y: 1.75 } }],
  })
  expect(validateTactileDesign(design, context)).toHaveLength(0)
  for (const at of [{ x: -100, y: 1.75 }, { x: 199, y: 1.75 }, { x: 10, y: 199 }, { x: 10, y: -1 }]) {
    const invalid = structuredClone(design)
    const title = invalid.elements[0]!
    if (title.kind !== 'braille') throw new Error('Missing test title')
    title.at = at
    expect(validateTactileDesign(invalid, context).some(v => v.rule === 'margin')).toBe(true)
    const fixed = resolveMechanicalViolations(invalid, context)
    expect(validateTactileDesign(fixed, context)).toHaveLength(0)
    const repairedTitle = fixed.elements[0]!
    expect(repairedTitle.kind === 'braille' && repairedTitle.at.y).toBeGreaterThanOrEqual(BRAILLE_MM.dotDiameter / 2)
  }
})

test('a title conflicting with reading-pod walls relocates within the header, not off the plate', () => {
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, plate: {}, grid: { rows: 2, cols: 2 }, mmPerPx: 1, legend: [],
    elements: [
      { id: 't-title', kind: 'braille', key: 'fourth storey plan', at: { x: 10, y: 1.75 } },
      ...[
        [61.6093, 36.1581, 61.6093, 10], [61.6093, 10, 77.1628, 10],
        [77.1628, 10, 77.1628, 36.1581],
      ].map(([x, y, bx, by], index) => ({
        id: `pod-${index}`, kind: 'line', points: [{ x, y }, { x: bx, y: by }], heightMm: 1,
      })),
    ],
  })
  const context = { symbolAnchorsMm: [], roomsMm: [], scaleFeaturesMm: [], doorOpeningsMm: [] }
  expect(validateTactileDesign(design, context)).toHaveLength(3)
  const repaired = resolveMechanicalViolations(design, context)
  expect(validateTactileDesign(repaired, context)).toHaveLength(0)
  const title = repaired.elements.find(e => e.id === 't-title')!
  expect(title.kind === 'braille' && title.at.x).toBeGreaterThanOrEqual(0.75)
  expect(title.kind === 'braille' && title.at.y + textBrailleSize(title.key).heightMm).toBeLessThanOrEqual(10)
})
