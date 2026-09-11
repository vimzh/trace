import { describe, expect, test } from 'bun:test'
import { Resvg } from '@resvg/resvg-js'
import type { FloorModel } from '@bumps/floor-model'
import { computeInkCoverage } from './coverage'

// Synthetic source: a white 500x400 plan with two thick black wall lines.
const sourcePng = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400" width="500" height="400">
    <rect width="500" height="400" fill="white"/>
    <line x1="50" y1="100" x2="450" y2="100" stroke="black" stroke-width="18"/>
    <line x1="100" y1="50" x2="100" y2="350" stroke="black" stroke-width="18"/>
  </svg>`,
).render().asPng()

function modelWithWalls(walls: { ax: number; ay: number; bx: number; by: number }[]): FloorModel {
  return {
    features: [],
    furniture: [],
    openings: [],
    paths: [],
    plan: { heightPx: 400, north: null, pixelsPerMeter: null, widthPx: 500 },
    roads: [],
    rooms: [],
    schemaVersion: 1,
    title: null,
    walls: walls.map((w, i) => ({
      a: { x: w.ax, y: w.ay },
      b: { x: w.bx, y: w.by },
      confidence: 0.9,
      id: `w-${i}`,
      kind: 'wall',
      thickness: 18,
    })),
  }
}

describe('computeInkCoverage', () => {
  test('wide road masks do not hide missing flat-ended source spans', () => {
    const source = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">
      <rect width="500" height="400" fill="white"/>
      <rect x="150" y="100" width="200" height="200" fill="black"/>
    </svg>`).render().asPng()
    const model = modelWithWalls([])
    model.roads = [{ id: 'road', kind: 'road', confidence: 1, label: null,
      points: [{ x: 250, y: 120 }, { x: 250, y: 280 }], widthPx: 200 }]
    const missing = computeInkCoverage(source, 'image/png', model)
    expect(missing.coveredInkRatio).toBeLessThan(0.9)
    expect(missing.regions.length).toBeGreaterThan(0)
    model.roads[0]!.points = [{ x: 250, y: 100 }, { x: 250, y: 300 }]
    const complete = computeInkCoverage(source, 'image/png', model)
    expect(complete.coveredInkRatio).toBeGreaterThan(0.99)
    expect(complete.regions).toHaveLength(0)
  })

  test('flags the region of a drawn wall missing from the model', () => {
    const report = computeInkCoverage(
      sourcePng,
      'image/png',
      modelWithWalls([{ ax: 50, ay: 100, bx: 450, by: 100 }]),
    )
    expect(report.coveredInkRatio).toBeLessThan(0.8)
    expect(report.regions.length).toBeGreaterThan(0)
    // The uncovered vertical wall runs along x=100, y=50..350.
    const hit = report.regions.some(
      (r) => r.x0 <= 110 && r.x1 >= 90 && r.y1 - r.y0 > 100,
    )
    expect(hit).toBe(true)
  })

  test('reports high coverage and no regions when the model traces everything', () => {
    const report = computeInkCoverage(
      sourcePng,
      'image/png',
      modelWithWalls([
        { ax: 50, ay: 100, bx: 450, by: 100 },
        { ax: 100, ay: 50, bx: 100, by: 350 },
      ]),
    )
    expect(report.coveredInkRatio).toBeGreaterThan(0.9)
    expect(report.regions).toHaveLength(0)
    expect(report.unsupportedWalls).toHaveLength(0)
  })

  test('distinguishes a blank cropped approach from adjacent real edge walls', () => {
    const source = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">
      <rect width="500" height="400" fill="white"/>
      <path d="M0 395H180 M320 395H500V240" fill="none" stroke="black" stroke-width="10"/>
    </svg>`).render().asPng()
    const model = modelWithWalls([
      { ax: 0, ay: 395, bx: 180, by: 395 },
      { ax: 180, ay: 395, bx: 320, by: 395 },
      { ax: 320, ay: 395, bx: 500, by: 395 },
      { ax: 498, ay: 240, bx: 498, by: 395 },
    ])
    const report = computeInkCoverage(source, 'image/png', model)
    expect(report.unsupportedWalls).toEqual([
      { elementId: 'w-1', at: { x: 250, y: 395 }, supportRatio: 0.0625 },
    ])
    model.walls.pop()
    expect(computeInkCoverage(source, 'image/png', model).regions.some(region => region.x1 === 500 && region.y0 < 300)).toBe(true)
  })

  test('flags a blank middle span despite ink at both wall junctions', () => {
    const source = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">
      <rect width="500" height="400" fill="white"/>
      <path d="M190 150H310 M190 240H310" fill="none" stroke="black" stroke-width="18"/>
    </svg>`).render().asPng()
    const falseWall = modelWithWalls([{ ax: 250, ay: 150, bx: 250, by: 240 }])
    const realWall = modelWithWalls([{ ax: 250, ay: 150, bx: 250, by: 240 }])
    const continuousSource = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">
      <rect width="500" height="400" fill="white"/>
      <path d="M190 150H310 M190 240H310 M250 150V240" fill="none" stroke="black" stroke-width="18"/>
    </svg>`).render().asPng()

    const falseReport = computeInkCoverage(source, 'image/png', falseWall)
    expect(falseReport.unsupportedWalls).toEqual([
      { elementId: 'w-0', at: { x: 250, y: 195 }, supportRatio: 0.4375 },
    ])
    expect(computeInkCoverage(continuousSource, 'image/png', realWall).unsupportedWalls).toHaveLength(0)
  })

  test('ink sampling work does not grow with inferred wall thickness', () => {
    const blank = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect width="500" height="400" fill="white"/></svg>').render().asPng()
    const model = modelWithWalls([{ ax: 50, ay: 200, bx: 450, by: 200 }])
    model.walls = Array.from({ length: 2_000 }, (_, index) => ({ ...model.walls[0]!, id: `w-${index}`, thickness: 1_000_000 }))
    const report = computeInkCoverage(blank, 'image/png', model)
    expect(report.unsupportedWalls).toHaveLength(5)
    expect(report.unsupportedWalls.every(wall => wall.supportRatio === 0)).toBe(true)
  })

  test('locates an ink-supported short return without closing a blank passage', () => {
    const image = (joined: boolean) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">
      <rect width="500" height="400" fill="white"/>
      <path d="M250 50V200H400 M230 200V350 ${joined ? 'M230 200H250' : ''}" fill="none" stroke="black" stroke-width="10"/>
    </svg>`).render().asPng()
    const model = modelWithWalls([
      { ax: 250, ay: 50, bx: 250, by: 200 },
      { ax: 250, ay: 200, bx: 400, by: 200 },
      { ax: 230, ay: 200, bx: 230, by: 350 },
    ])
    model.walls.forEach(wall => { wall.thickness = 10 })
    const report = computeInkCoverage(image(true), 'image/png', model)
    expect(report.regions).toHaveLength(0) // Padding hides this short missing run.
    expect(report.missingConnections).toEqual([{ at: { x: 240, y: 200 }, wallIds: ['w-0', 'w-2'] }])
    expect(computeInkCoverage(image(false), 'image/png', model).missingConnections).toHaveLength(0)
    model.walls.push({ ...model.walls[0]!, id: 'return', a: { x: 230, y: 200 }, b: { x: 250, y: 200 } })
    expect(computeInkCoverage(image(true), 'image/png', model).missingConnections).toHaveLength(0)
  }, 15_000)

  test('bounds short-connection work on a dense maximum-size model', () => {
    const blank = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect width="500" height="400" fill="white"/></svg>').render().asPng()
    const model = modelWithWalls([{ ax: 100, ay: 100, bx: 100, by: 350 }])
    computeInkCoverage(blank, 'image/png', model) // Exclude one-time renderer initialization.
    model.walls = Array.from({ length: 2_000 }, (_, i) => ({ ...model.walls[0]!, id: `w-${i}`,
      a: { x: 100 + (i % 2) * 20, y: 100 }, b: { x: 300 + (i % 2) * 20, y: 350 }, thickness: 10 }))
    const start = performance.now()
    expect(computeInkCoverage(blank, 'image/png', model).missingConnections).toHaveLength(0)
    expect(performance.now() - start).toBeLessThan(2_000)
  })
})
