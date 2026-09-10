import { expect, test } from 'bun:test'
import Module from 'manifold-3d'
import { tactileDesignSchema, textBrailleSize, textDotCenters, type TactileDesign } from '@bumps/floor-model'
import { buildLegendMeshes, buildMapMesh, buildPlateMeshes, meshInfo, meshToBinaryStl } from './mesh'

function expectClosedStl(manifold: ReturnType<typeof buildMapMesh>) {
  const bytes = meshToBinaryStl(manifold.getMesh())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triangles = view.getUint32(80, true)
  const edges = new Map<string, { count: number; orientation: number }>()
  let degenerate = 0
  for (let t = 0; t < triangles; t++) {
    const points = [0, 1, 2].map((vertex) =>
      [0, 1, 2].map((axis) => view.getFloat32(84 + t * 50 + 12 + vertex * 12 + axis * 4, true)),
    )
    const [a, b, c] = points as [number[], number[], number[]]
    const u = b.map((value, axis) => value - a[axis]!)
    const v = c.map((value, axis) => value - a[axis]!)
    const area = Math.hypot(
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    )
    if (!(area > 0)) degenerate++
    for (let i = 0; i < 3; i++) {
      const from = points[i]!.join(',')
      const to = points[(i + 1) % 3]!.join(',')
      const key = [from, to].sort().join('|')
      const edge = edges.get(key) ?? { count: 0, orientation: 0 }
      edge.count++
      edge.orientation += from < to ? 1 : -1
      edges.set(key, edge)
    }
  }
  expect(triangles).toBeGreaterThan(0)
  expect(bytes.byteLength).toBe(84 + 50 * triangles)
  expect(degenerate).toBe(0)
  expect([...edges.values()].filter((edge) => edge.count !== 2 || edge.orientation !== 0)).toHaveLength(0)
  expect(manifold.status()).toBe('NoError')
  const components = manifold.decompose()
  expect(components).toHaveLength(1)
  components.forEach((component) => component.delete())
}

function expectClosedMapAndPlates(design: TactileDesign) {
  const map = buildMapMesh(design)
  expectClosedStl(map)
  const plates = buildPlateMeshes(design, map)
  expect(plates).toHaveLength(2)
  for (const plate of plates) expectClosedStl(plate.manifold)
  expect(plates.reduce((sum, plate) => sum + plate.manifold.volume(), 0)).toBeCloseTo(map.volume(), 5)
  plates.forEach((plate) => plate.manifold.delete())
  return map
}

test('unimplemented area patterns fail instead of silently printing solid relief', () => {
  for (const texture of ['dots', 'lines']) {
    const design = tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
      elements: [{ id: 'pattern', kind: 'area', texture,
        polygon: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }] }] })
    expect(() => buildMapMesh(design)).toThrow(`unsupported ${texture} texture`)
  }
})

test('map and legend domes occupy their top-left text footprints', () => {
  const at = { x: 10, y: 20 }
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [{ key: 'qx', text: 'qx' }],
    elements: [{ id: 'key', kind: 'braille', key: 'qx', at }],
  })
  const map = buildMapMesh(design)
  const legends = buildLegendMeshes(design)
  try {
    expect(legends).toHaveLength(1)
    for (const [solid, text, origin] of [
      [map, 'qx', at],
      [legends[0]!, 'qx  qx', { x: design.plate.marginMm, y: design.plate.marginMm }],
    ] as const) {
      expectClosedStl(solid)
      const { widthMm, heightMm } = textBrailleSize(text)
      const mesh = solid.getMesh()
      let raised = 0
      for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
        if (mesh.vertProperties[i + 2]! <= design.plate.baseMm) continue
        raised++
        const x = mesh.vertProperties[i]!
        const y = design.plate.heightMm - mesh.vertProperties[i + 1]!
        // Float32 mesh positions can round a footprint edge by a few ULPs.
        expect(x).toBeGreaterThanOrEqual(origin.x - 1e-5)
        expect(x).toBeLessThanOrEqual(origin.x + widthMm + 1e-5)
        expect(y).toBeGreaterThanOrEqual(origin.y - 1e-5)
        expect(y).toBeLessThanOrEqual(origin.y + heightMm + 1e-5)
      }
      expect(raised).toBeGreaterThan(0)
      // Independent expected apex catches matching mistakes in two shared callers.
      const x = origin.x + 0.75, y = design.plate.heightMm - origin.y - 0.75
      expect(solid.rayCast([x, y, 10], [x, y, 0])[0]?.position[2]).toBeCloseTo(3.7, 6)
    }
  } finally {
    map.delete()
    legends.forEach(legend => legend.delete())
  }
})

test('clockwise design rotations preserve north, entrance, and stair orientation in y-up meshes', () => {
  for (const symbol of ['north', 'entrance', 'stairs'] as const) {
    for (const rotation of [0, 22.5, 90, 180, 270]) {
      const design = tactileDesignSchema.parse({
        schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 1, rows: 2 }, legend: [],
        elements: [{
          id: symbol, kind: 'symbol', symbol, at: { x: 60, y: 80 },
          sizeMm: 8, heightMm: 1.5, rotation,
        }],
      })
      const map = buildMapMesh(design)
      const mesh = map.getMesh()
      // Arrow tip, or outer rung corner, in the unrotated y-up glyph.
      const [x, y] = symbol === 'stairs' ? [4, 2.4] : [0, 4]
      const angle = rotation * Math.PI / 180
      const expectedX = 60 + x! * Math.cos(angle) + y! * Math.sin(angle)
      const expectedY = 320 - x! * Math.sin(angle) + y! * Math.cos(angle)
      let nearest = Infinity
      for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
        if (Math.abs(mesh.vertProperties[i + 2]! - 4.5) > 1e-5) continue
        nearest = Math.min(nearest, Math.hypot(
          mesh.vertProperties[i]! - expectedX, mesh.vertProperties[i + 1]! - expectedY,
        ))
      }
      expect(nearest).toBeLessThan(1e-4)
      expectClosedStl(map)
      map.delete()
    }
  }
})

test('near-collinear wall junctions export without collapsed triangles or extra components', () => {
  // Eight walls reduced from a failing live plan; removing any wall hides the defect.
  const segments = [
    [160.17021276595742, 141.93617021276594, 217.04255319148936, 141.93617021276594],
    [138.62191489361703, 87.17021276595744, 194.54255319148933, 87.17021276595744],
    [194.54255319148933, 87.17021276595744, 217.54808510638298, 87.17021276595744],
    [194.54255319148933, 51.93617021276596, 194.54255319148933, 109.76595744680851],
    [182.22595744680848, 87.17021276595744, 182.28723404255317, 109.76595744680851],
    [182.28723404255317, 109.76595744680851, 182.28723404255317, 141.93617021276594],
    [194.54255319148933, 109.76595744680851, 194.54255319148933, 117.90425531914893],
    [182.28723404255317, 109.76595744680851, 194.54255319148933, 109.76595744680851],
  ]
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 2, rows: 1 }, legend: [],
    elements: segments.map(([x1, y1, x2, y2], index) => ({
      id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
      points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
    })),
  })
  const map = expectClosedMapAndPlates(design)
  expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [400, 200, 4] })
  expect(map.volume()).toBeCloseTo(240525.5772557636, 5)
  map.delete()
})

test('collinear relief faces and rotated stair tile cuts do not retain zero-area facets', () => {
  // Reduced independently from Buffalo: walls fail in extrusion, stairs only after slicing.
  const segments = [
    [190, 23.075170842824605, 190, 363.59908883826876],
    [170.72892938496582, 212.09567198177675, 170.72892938496582, 363.59908883826876],
    [170.72892938496582, 245.71753986332573, 190, 245.71753986332573],
    [170.72892938496582, 273.3940774487471, 190, 273.3940774487471],
    [170.72892938496582, 344.53302961275625, 190, 344.53302961275625],
  ]
  const cases = [
    {
      elements: segments.map(([x1, y1, x2, y2], index) => ({
        id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
        points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      })),
      volume: 241087.68109339476,
    },
    {
      elements: [
        [130.54669703872435, 44.88097949886105],
        [158.86731207289293, 291.6400911161731],
      ].map(([x, y], index) => ({
        id: `stairs-${index}`, kind: 'symbol', symbol: 'stairs', rotation: 45,
        sizeMm: 6, heightMm: 1.5, at: { x, y },
      })),
      volume: 240064.8,
    },
  ]
  for (const { elements, volume } of cases) {
    const design = tactileDesignSchema.parse({
      schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 1, rows: 2 }, legend: [], elements,
    })
    const map = expectClosedMapAndPlates(design)
    expect(map.volume()).toBeCloseTo(volume, 5)
    map.delete()
  }
})

test('overlapping relief preserves volume, distinct heights, and braille lifted onto an area', () => {
  const braille = { id: 'label', kind: 'braille', key: 'a', at: { x: 23, y: 15 } }
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 2, rows: 1 }, legend: [],
    elements: [
      { id: 'horizontal', kind: 'line', points: [{ x: 10, y: 20 }, { x: 35, y: 20 }], heightMm: 1 },
      { id: 'vertical', kind: 'line', points: [{ x: 20, y: 10 }, { x: 20, y: 30 }], heightMm: 1 },
      { id: 'area', kind: 'area', texture: 'solid', polygon: [{ x: 15, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 30 }, { x: 15, y: 30 }], heightMm: 0.5 },
      { id: 'symbol', kind: 'symbol', symbol: 'door', at: { x: 60, y: 20 }, sizeMm: 4, heightMm: 1.5 },
      braille,
    ],
  })
  const map = expectClosedMapAndPlates(design)
  const dotOnly = buildMapMesh(tactileDesignSchema.parse({ ...design, elements: [braille] }))
  // Walls: 50 + 40 - 4 mm³; exposed area: (200 - 56) * 0.5; symbol: 4 * 2 * 1.5.
  expect(map.volume()).toBeCloseTo(dotOnly.volume() + 170, 5)
  expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [400, 200, 4.5] })
  for (const [x, y, height] of [[12, 20, 4], [22, 12, 3.5], [23.75, 15.75, 4.2], [60, 20, 4.5]]) {
    expect(map.rayCast([x!, 200 - y!, 10], [x!, 200 - y!, 0])[0]?.position[2]).toBeCloseTo(height!, 6)
  }
  dotOnly.delete()
  map.delete()
})

test('flat-cap junction slits cannot collapse into invalid float32 STL edges', () => {
  // Yonkers: a ~7e-6 mm-wide notch survives native simplification, but its
  // opposing vertices become identical when getMesh converts them to float32.
  const points = [
    { x: 179.1219846936063, y: 175.5117927871251 },
    { x: 183.86436781609194, y: 173.90114942528737 },
    { x: 184.62124576073458, y: 173.6440987459892 },
  ]
  for (const offset of [0, 200, 400]) {
    const design = tactileDesignSchema.parse({
      schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 4, rows: 4 }, legend: [],
      elements: [0, 1].map(index => ({
        id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
        points: points.slice(index, index + 2).map(p => ({ x: p.x + offset, y: p.y + offset })),
      })),
    })
    const before = structuredClone(design)
    const map = buildMapMesh(design)
    expectClosedStl(map)
    expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [800, 800, 4] })
    expect(map.volume() - 800 * 800 * 3).toBeCloseTo(11.61553, 4)
    const plates = buildPlateMeshes(design, map)
    expect(plates).toHaveLength(16)
    for (const plate of plates) {
      expectClosedStl(plate.manifold)
      plate.manifold.delete()
    }
    expect(design).toEqual(before)
    map.delete()
  }
})

test('sub-float32 outline cleanup preserves a fingertip-width doorway', () => {
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 2, rows: 1 }, legend: [],
    elements: [[10, 47], [53, 90]].map(([from, to], index) => ({
      id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
      points: [{ x: from, y: 50 }, { x: to, y: 50 }],
    })),
  })
  const map = expectClosedMapAndPlates(design)
  expect(map.volume()).toBeCloseTo(400 * 200 * 3 + 74 * 2, 5)
  for (const [x, height] of [[46.99, 4], [47.01, 3], [50, 3], [52.99, 3], [53.01, 4]]) {
    expect(map.rayCast([x!, 150, 10], [x!, 150, 0])[0]?.position[2]).toBeCloseTo(height!, 6)
  }
  map.delete()
})

test('relief overlapping the base avoids coplanar sheets without changing braille support', () => {
  // Nine elements reduced from CAA: all five dots lie inside their counter,
  // but merely touching the slab leaves numerical zero-volume sheets at z=3.
  const label = { id: 'label', kind: 'braille', key: 'co', at: { x: 464.67676056338024, y: 176.1788438967136 } }
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 3, rows: 3 }, legend: [],
    elements: [
      ...[
        [434.1195715962441, 155.49970657276995, 434.1195715962441, 183.77083333333331],
        [434.1195715962441, 183.77083333333331, 504.7973884976526, 201.94512910798122],
        [505.13394953051636, 155.1631455399061, 504.7973884976526, 201.94512910798122],
        [458.5202464788732, 170.6449530516432, 505.0225478286385, 170.6449530516432],
      ].map(([ax, ay, bx, by], index) => ({
        id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
        points: [{ x: ax, y: ay }, { x: bx, y: by }],
      })),
      { id: 'lift', kind: 'symbol', symbol: 'elevator', at: { x: 502.7780223004695, y: 13.961854460093896 }, heightMm: 1.5, sizeMm: 6 },
      { id: 'wc', kind: 'symbol', symbol: 'restroom', at: { x: 239.92385563380282, y: 175.02024647887325 }, heightMm: 1.5, sizeMm: 6 },
      ...[
        [[301.1779636150235, 150.4512910798122], [341.56528755868544, 150.4512910798122], [341.56528755868544, 177.71273474178403], [303.5338908450704, 177.71273474178403], [303.5338908450704, 205.98386150234742], [301.1779636150235, 205.98386150234742]],
        [[434.1195715962441, 155.49970657276995], [505.13394953051636, 155.49970657276995], [505.13394953051636, 201.94512910798122], [434.1195715962441, 183.77083333333331]],
      ].map((polygon, index) => ({ id: `counter-${index}`, kind: 'area', texture: 'solid', heightMm: 0.5, polygon: polygon.map(([x, y]) => ({ x, y })) })),
      label,
    ],
  })
  const before = structuredClone(design)
  const map = buildMapMesh(design)
  expectClosedStl(map)
  expect(map.volume()).toBeCloseTo(1082240.4333472773, 5)
  expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [600, 600, 4.5] })
  for (const dot of textDotCenters(label.key, label.at)) {
    expect(map.rayCast([dot.x, 600 - dot.y, 10], [dot.x, 600 - dot.y, 0])[0]?.position[2]).toBeCloseTo(4.2, 6)
  }
  for (const [x, y, height] of [[400, 300, 3], [450, 172, 3.5], [434.1195715962441, 168, 4], [502.7780223004695, 13.961854460093896, 4.5]]) {
    expect(map.rayCast([x!, 600 - y!, 10], [x!, 600 - y!, 0])[0]?.position[2]).toBeCloseTo(height!, 6)
  }
  const plates = buildPlateMeshes(design, map)
  expect(plates).toHaveLength(9)
  expect(plates.reduce((sum, plate) => sum + plate.manifold.volume(), 0)).toBeCloseTo(map.volume(), 5)
  for (const plate of plates) {
    expectClosedStl(plate.manifold)
    plate.manifold.delete()
  }
  expect(design).toEqual(before)
  map.delete()
})

test('mixed-height wall and counter corners simplify across source-face boundaries before STL rounding', () => {
  // Three elements reduced from Theatre V7. Native source-face constraints kept
  // duplicate corner vertices that collapse in float32 despite the existing tolerance.
  const design = tactileDesignSchema.parse({
    schemaVersion: 1, mmPerPx: 1, plate: {}, grid: { cols: 3, rows: 4 }, legend: [],
    elements: [
      ...[
        [487.83413296778616, 287.7667923235092, 541.898560657985, 300.0903015764222],
        [541.898560657985, 300.0903015764222, 541.898560657985, 244.0382111034955],
      ].map(([ax, ay, bx, by], index) => ({
        id: `wall-${index}`, kind: 'line', heightMm: 1, widthMm: 2,
        points: [{ x: ax, y: ay }, { x: bx, y: by }],
      })),
      {
        id: 'counter', kind: 'area', texture: 'solid', heightMm: 0.5,
        polygon: [
          [458.4167237834133, 244.4357436600411], [541.898560657985, 244.4357436600411],
          [541.898560657985, 300.0903015764222], [526.7923235092529, 296.91004112405756],
          [510.89102124742976, 292.93471555860174], [493.0020562028787, 288.959389993146],
          [475.1130911583276, 283.3939342015079], [458.4167237834133, 278.22601096641534],
        ].map(([x, y]) => ({ x, y })),
      },
    ],
  })
  const before = structuredClone(design)
  const map = buildMapMesh(design)
  expectClosedStl(map)
  expect(map.volume()).toBeCloseTo(1442068.7572286294, 5)
  expect(map.tolerance()).toBe(800 * 2 ** -22)
  expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [600, 800, 4] })
  for (const [x, y, height] of [[500, 270, 3.5], [541.898560657985, 270, 4], [550, 270, 3]]) {
    expect(map.rayCast([x!, 800 - y!, 10], [x!, 800 - y!, 0])[0]?.position[2]).toBeCloseTo(height!, 6)
  }
  const plates = buildPlateMeshes(design, map)
  expect(plates).toHaveLength(12)
  expect(plates.reduce((sum, plate) => sum + plate.manifold.volume(), 0)).toBeCloseTo(map.volume(), 5)
  for (const plate of plates) {
    expectClosedStl(plate.manifold)
    plate.manifold.delete()
  }
  expect(design).toEqual(before)
  map.delete()
})

test('a legacy braille dome on a block edge remains closed after float32 serialization', async () => {
  // Final-gallery Yonkers: the last dot of "wf" alone reproduces a rounded
  // sphere/block junction with two collapsed facets, despite a valid native solid.
  // Construct the original dot center explicitly: text origins now correctly
  // mean footprint corners, which would move this historical numerical fixture.
  const at = { x: 266.87094219792596, y: 206.3252673044457 }
  const wasm = await Module()
  wasm.setup()
  const { CrossSection, Manifold } = wasm
  const tolerance = 600 * 2 ** -22
  const radius = (0.75 ** 2 + 0.7 ** 2) / (2 * 0.7)
  const owned: { delete(): void }[] = []
  const keep = <T extends { delete(): void }>(value: T): T => { owned.push(value); return value }
  try {
    const base = keep(Manifold.cube([600, 600, 3]))
    const outline = keep(CrossSection.ofPolygons([[
      [256.7529544175577, 206.3252673044457], [268.50309510410807, 206.3252673044457],
      [268.50309510410807, 216.44344400675297], [262.9544175576815, 216.44344400675297],
      [256.7529544175577, 211.54755205402367],
    ].map(([x, y]) => [x!, 600 - y!] as [number, number]).reverse()]))
    const expanded = keep(outline.offset(tolerance, 'Miter'))
    const closed = keep(expanded.offset(-tolerance, 'Miter'))
    const printable = keep(closed.simplify(tolerance))
    const extrusion = keep(Manifold.extrude(printable, 0.5 + tolerance))
    const block = keep(extrusion.translate([0, 0, 3 - tolerance]))
    const sphere = keep(Manifold.sphere(radius, 24))
    const dot = keep(sphere.translate([at.x, 600 - at.y, 4.2 - radius]))
    const union = keep(Manifold.union([base, dot, block]))
    const original = keep(union.asOriginal())
    const map = keep(original.setTolerance(tolerance))
    expectClosedStl(map)
    expect(map.volume()).toBeCloseTo(1080053.0048804688, 5)
    expect(map.tolerance()).toBe(600 * 2 ** -22)
    expect(map.boundingBox()).toEqual({ min: [0, 0, 0], max: [600, 600, 4.2] })
    for (const [x, y, height] of [[at.x, at.y, 4.2], [260, 210, 3.5], [275, 210, 3]]) {
      expect(map.rayCast([x!, 600 - y!, 10], [x!, 600 - y!, 0])[0]?.position[2]).toBeCloseTo(height!, 6)
    }
    const mesh = map.getMesh()
    const vertices = mesh.vertProperties.slice()
    const triangles = mesh.triVerts.slice()
    let collapsed = 0
    for (let i = 0; i < triangles.length; i += 3) {
      const points = Array.from(triangles.slice(i, i + 3), vertex =>
        Array.from(vertices.slice(vertex * mesh.numProp, vertex * mesh.numProp + 3)).join(','),
      )
      if (new Set(points).size < 3) collapsed++
    }
    expect(collapsed).toBe(2)
    const bytes = meshToBinaryStl(mesh)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(meshInfo(map).triangles).toBe(view.getUint32(80, true))
    expect(mesh.vertProperties).toEqual(vertices)
    expect(mesh.triVerts).toEqual(triangles)
    const originalVertices = new Set(Array.from({ length: vertices.length / mesh.numProp }, (_, i) =>
      Array.from(vertices.slice(i * mesh.numProp, i * mesh.numProp + 3)).join(','),
    ))
    for (let t = 0; t < view.getUint32(80, true); t++) {
      for (let v = 0; v < 3; v++) {
        const point = [0, 1, 2].map(axis => view.getFloat32(84 + t * 50 + 12 + v * 12 + axis * 4, true))
        expect(originalVertices.has(point.join(','))).toBe(true)
      }
    }
  } finally {
    owned.reverse().forEach(value => value.delete())
  }
})

test('STL serialization rejects an open mesh instead of emitting a degraded file', () => {
  const map = buildMapMesh(tactileDesignSchema.parse({ schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [], elements: [] }))
  try {
    const mesh = map.getMesh()
    // Remove one triangle and its metadata, leaving a real boundary in the slab.
    mesh.triVerts = mesh.triVerts.slice(3)
    mesh.faceID = mesh.faceID.slice(1)
    mesh.runIndex[mesh.runIndex.length - 1] = mesh.triVerts.length
    expect(() => meshToBinaryStl(mesh)).toThrow('Not manifold')
  } finally {
    map.delete()
  }
})
