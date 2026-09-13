// Reports source-to-tactile landmark drift from saved runs, without model calls.
import assert from 'node:assert/strict'
import path from 'node:path'
import { floorModelSchema, tactileDesignSchema } from '../packages/floor-model/src'
import { layoutForGrid } from '../packages/floor-model/src/tactile-convert'
import { pointInPolygon, segmentsCross as crosses } from '../packages/floor-model/src/fit'

async function audit(directory: string) {
  const model = floorModelSchema.parse((await Bun.file(path.join(directory, 'model.json')).json()).model)
  const tactile = await Bun.file(path.join(directory, 'tactile.json')).json()
  const design = tactileDesignSchema.parse(tactile.design)
  // Saved runs retain their original grid; today's automatic choice may differ.
  const { toMm, mmPerPx } = layoutForGrid(model, design.grid?.rows ?? 1, design.grid?.cols ?? 1)
  assert(Math.abs(mmPerPx - design.mmPerPx) < 1e-8, 'Saved design scale differs from the source model/grid')
  const rooms = model.rooms.map(room => ({ id: room.id, label: room.label, polygon: room.polygon.map(toMm) }))
  const sourceFeatures = new Map(model.features.map(feature => [feature.id, feature]))
  const symbols = design.elements.filter(element => element.kind === 'symbol').flatMap(symbol => {
    const source = symbol.sourceId && sourceFeatures.get(symbol.sourceId)
    if (!source) return []
    const origin = toMm(source.at)
    const before = rooms.filter(room => pointInPolygon(origin, room.polygon))
    const after = rooms.filter(room => pointInPolygon(symbol.at, room.polygon))
    const crossedWalls = design.elements.filter(line => line.kind === 'line' && line.style === 'solid'
      && line.points.slice(1).some((point, index) => crosses(origin, symbol.at, line.points[index]!, point)))
    return [{ id: symbol.id, sourceId: source.id, kind: symbol.symbol, sourceConfidence: source.confidence,
      origin, final: symbol.at, displacementMm: Math.hypot(symbol.at.x - origin.x, symbol.at.y - origin.y),
      sourceRooms: before.map(({ id, label }) => ({ id, label })),
      finalRooms: after.map(({ id, label }) => ({ id, label })),
      lostSourceRooms: before.filter(room => !after.some(other => other.id === room.id)).map(room => room.id),
      crossedWallIds: crossedWalls.map(wall => wall.id) }]
  })
  const result = { status: tactile.status, tactileValid: tactile.valid,
    limitation: 'Review hints, not ground truth. Tests straight-line displacement across final solid wall segments, including split-wall endpoints; ignores movement starting/ending on or following a wall and does not prove physical accessibility. Source room polygons can be wrong or overlapping.',
    symbols, reviewRequired: symbols.filter(symbol => symbol.crossedWallIds.length || symbol.lostSourceRooms.length) }
  await Bun.write(path.join(directory, 'placement-audit.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ directory, symbols: symbols.length, reviewRequired: result.reviewRequired.length }))
}

if (process.argv[2] === '--self-check') {
  assert(crosses({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }))
  assert(!crosses({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: -1 }, { x: 3, y: 1 }))
  assert(!crosses({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: -1 }, { x: 3, y: 1 }))
  assert(crosses({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 3, y: -1 }, { x: 3, y: 0 }))
  console.log('Placement crossing self-check passed; no model calls')
} else {
  assert(process.argv.length > 2, 'Usage: bun pipeline_tests/audit-gallery-placement.ts <case-directory> [...]')
  for (const directory of process.argv.slice(2)) await audit(path.resolve(directory))
}
