// Partition located corrections without losing neighboring geometry or wall/opening context.
import { allElements, type FloorElement, type FloorModel } from '@bumps/floor-model'
import type { Critique } from './critique'

type Bounds = { x0: number; y0: number; x1: number; y1: number }
export const FOCUSED_VIEW_MAX_PX = 1200
export type RefinementFocus = {
  bounds: Bounds
  findings: Critique['findings']
  model: FloorModel
  writableIds: string[]
  newIdPrefix: string
}

export function refinementElementBounds(element: FloorElement): Bounds {
  const points = 'a' in element ? [element.a, element.b]
    : 'at' in element ? [element.at]
    : 'polygon' in element ? element.polygon : element.points
  const radius = 'thickness' in element ? element.thickness / 2
    : 'width' in element ? element.width / 2
    : 'widthPx' in element ? element.widthPx / 2 : 0
  return {
    x0: Math.min(...points.map(point => point.x)) - radius,
    y0: Math.min(...points.map(point => point.y)) - radius,
    x1: Math.max(...points.map(point => point.x)) + radius,
    y1: Math.max(...points.map(point => point.y)) + radius,
  }
}

function intersects(a: Bounds, b: Bounds) {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0
}

function contains(a: Bounds, b: Bounds) {
  return a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1
}

function union(a: Bounds, b: Bounds): Bounds {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

export function planRefinementFocus(model: FloorModel, findings: Critique['findings']): RefinementFocus[] {
  if (!findings.length) return []
  const full = { x0: 0, y0: 0, x1: model.plan.widthPx, y1: model.plan.heightPx }
  const elements = allElements(model)
  const boundsById = new Map(elements.map(element => [element.id, refinementElementBounds(element)]))
  const halo = Math.max(48, Math.max(full.x1, full.y1) * .04)
  let nextPrefix = 1
  function prefix() {
    let value: string
    do { value = `refine-${nextPrefix++}-` } while (elements.some(element => element.id.startsWith(value)))
    return value
  }
  function fullPlan(): RefinementFocus[] {
    return [{ bounds: full, findings: [...findings], model,
      writableIds: elements.map(element => element.id), newIdPrefix: prefix() }]
  }
  // Missing coordinates or non-geometry targets cannot safely authorize a local edit.
  if (findings.some(({ at, bounds, elementId }) => !at || !Number.isFinite(at.x) || !Number.isFinite(at.y)
    || !contains(full, { x0: at.x, y0: at.y, x1: at.x, y1: at.y })
    || !bounds || Object.values(bounds).some(value => !Number.isFinite(value))
    || bounds.x0 > bounds.x1 || bounds.y0 > bounds.y1 || !contains(full, bounds)
    || !contains(bounds, { x0: at.x, y0: at.y, x1: at.x, y1: at.y })
    || (elementId !== null && !boundsById.has(elementId)))) return fullPlan()

  type Group = { bounds: Bounds; indices: number[]; writable: Set<string> }
  function group(bounds: Bounds, indices: number[]): Group {
    const explicit = new Set(indices.map(index => findings[index]!.elementId))
    return { bounds, indices, writable: new Set(elements.filter(element =>
      explicit.has(element.id) || contains(bounds, boundsById.get(element.id)!),
    ).map(element => element.id)) }
  }
  const groups: Group[] = []
  // ponytail: quadratic coalescing over the bounded critique; add an index only if profiling warrants it.
  findings.forEach((finding, index) => {
    const target = finding.elementId ? boundsById.get(finding.elementId)! : null
    const defect = finding.bounds!
    let seed = target ? union(defect, target) : defect
    const opening = model.openings.find(element => element.id === finding.elementId)
    const host = opening?.wallId ? boundsById.get(opening.wallId) : null
    // Removing a false door can require repairing its supporting wall too.
    if (host && finding.kind === 'extra') seed = union(seed, host)
    let current = group({ x0: Math.max(0, seed.x0 - halo), y0: Math.max(0, seed.y0 - halo),
      x1: Math.min(full.x1, seed.x1 + halo), y1: Math.min(full.y1, seed.y1 + halo) }, [index])
    for (;;) {
      const overlap = groups.findIndex(other => intersects(current.bounds, other.bounds)
        || [...current.writable].some(id => other.writable.has(id)))
      if (overlap < 0) break
      const other = groups.splice(overlap, 1)[0]!
      current = group(union(current.bounds, other.bounds), [...current.indices, ...other.indices])
    }
    groups.push(current)
  })
  // Broad mode is explicit; neither clustering nor the image budget may discard
  // a finding or downscale a large repair below its source-pixel resolution.
  if (groups.length > 4 || groups.some(({ bounds }) =>
    Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) > FOCUSED_VIEW_MAX_PX)) return fullPlan()
  return groups.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices)).map(current => {
    const visible = new Set(elements.filter(element => intersects(current.bounds, boundsById.get(element.id)!))
      .map(element => element.id))
    for (const opening of model.openings) {
      if (visible.has(opening.id) && opening.wallId) visible.add(opening.wallId)
    }
    for (const opening of model.openings) {
      if (opening.wallId && visible.has(opening.wallId)) visible.add(opening.id)
    }
    const subset: FloorModel = { ...model,
      walls: model.walls.filter(element => visible.has(element.id)),
      openings: model.openings.filter(element => visible.has(element.id)),
      rooms: model.rooms.filter(element => visible.has(element.id)),
      features: model.features.filter(element => visible.has(element.id)),
      furniture: model.furniture.filter(element => visible.has(element.id)),
      paths: model.paths.filter(element => visible.has(element.id)),
      roads: model.roads.filter(element => visible.has(element.id)),
    }
    return { bounds: current.bounds,
      findings: current.indices.sort((a, b) => a - b).map(index => findings[index]!),
      model: subset, writableIds: [...current.writable], newIdPrefix: prefix() }
  })
}
