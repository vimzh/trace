import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { TactileDesign } from '@bumps/floor-model'
import {
  buildLegendMeshes,
  buildMapMesh,
  buildPlateMeshes,
  meshInfo,
  meshToBinaryStl,
  unsupportedTextureError,
  type MeshInfo,
} from './geometry/mesh'
import { db } from './db'
import {
  exports as exportsTable,
  floorModels,
  projects,
  tactileDesigns,
} from './db/schema'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? 'data/uploads'

export const exportRoutes = new Hono()

export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`
}

async function exportableDesign(projectId: string) {
  const row = await db.query.tactileDesigns.findFirst({
    orderBy: [desc(tactileDesigns.createdAt), desc(tactileDesigns.id)],
    where: eq(tactileDesigns.projectId, projectId),
  })
  if (!row || row.status !== 'done') {
    return { error: 'No finished tactile design for this project', status: 404 as const }
  }
  const latestModel = await db.query.floorModels.findFirst({
    columns: { version: true },
    orderBy: desc(floorModels.version),
    where: eq(floorModels.projectId, projectId),
  })
  if (!latestModel || row.floorModelVersion !== latestModel.version) {
    return {
      error: 'Tactile design is stale — convert the latest floor model',
      status: 409 as const,
    }
  }
  if (!row.valid) {
    return {
      error: 'Design has standards violations — export is blocked',
      status: 409 as const,
      violations: row.violations,
    }
  }
  const textureError = unsupportedTextureError(row.design as TactileDesign)
  if (textureError) return { error: textureError, status: 409 as const }
  return { row }
}

// The export gate: only zero-violation designs become STLs.
exportRoutes.post('/:id/export', async (c) => {
  const projectId = c.req.param('id')
  const gate = await exportableDesign(projectId)
  if ('error' in gate) {
    const { status, ...body } = gate
    return c.json(body, status)
  }

  const design = gate.row.design as TactileDesign
  const grid = design.grid ?? { cols: 1, rows: 1 }
  // Each conversion gets an immutable, private batch directory. The database
  // rows become visible together only after every STL is fully written.
  const dir = path.join(UPLOADS_DIR, projectId, 'export', gate.row.id, Bun.randomUUIDv7())
  await mkdir(dir, { recursive: true })

  const files: { info: MeshInfo; kind: string; path: string }[] = []
  // 'map' is the assembled composite: the only file for a single plate,
  // and the seamless 3D preview for a multi-plate grid.
  const map = buildMapMesh(design)
  try {
    const mapPath = path.join(dir, 'map.stl')
    await Bun.write(mapPath, meshToBinaryStl(map.getMesh()))
    files.push({ info: meshInfo(map), kind: 'map', path: mapPath })

    // Multi-plate grids also get one print file per plate, sliced from the
    // same solid so assembled seams align exactly.
    const total = grid.rows * grid.cols
    const plates = buildPlateMeshes(design, map)
    try {
      for (const plate of plates) {
        const n = plate.row * grid.cols + plate.col + 1
        const kind = `plate-${n}of${total}`
        const platePath = path.join(dir, `${kind}.stl`)
        await Bun.write(platePath, meshToBinaryStl(plate.manifold.getMesh()))
        files.push({ info: meshInfo(plate.manifold), kind, path: platePath })
      }
    } finally {
      plates.forEach((plate) => plate.manifold.delete())
    }

    const legends = buildLegendMeshes(design)
    try {
      for (const [index, legend] of legends.entries()) {
        const kind = legends.length === 1 ? 'legend' : `legend-${index + 1}of${legends.length}`
        const legendPath = path.join(dir, `${kind}.stl`)
        await Bun.write(legendPath, meshToBinaryStl(legend.getMesh()))
        files.push({ info: meshInfo(legend), kind, path: legendPath })
      }
    } finally {
      legends.forEach((legend) => legend.delete())
    }
  } finally {
    map.delete()
  }

  // A model edit or reconversion during mesh generation leaves this private
  // batch archived but never makes it the current design's downloadable set.
  const current = await exportableDesign(projectId)
  if ('error' in current || current.row.id !== gate.row.id) {
    return c.json(
      { error: 'Tactile design changed during export — export the current design' },
      409,
    )
  }
  await db.transaction(async (tx) => {
    await tx.insert(exportsTable).values(files.map((file) => ({
      id: Bun.randomUUIDv7(),
      kind: file.kind,
      path: file.path,
      projectId,
    })))
  })
  return c.json(
    {
      files: files.map((file) => ({
        bbox: file.info.bbox,
        kind: file.kind,
        triangles: file.info.triangles,
      })),
      grid,
    },
    201,
  )
})

exportRoutes.get('/:id/export/:file', async (c) => {
  const projectId = c.req.param('id')
  const match = /^(map|legend(?:-\d{1,2}of\d{1,2})?|plate-\d{1,2}of\d{1,2})\.stl$/.exec(
    c.req.param('file'),
  )
  if (!match) {
    return c.json({ error: 'Unknown export file' }, 404)
  }
  const kind = match[1]!
  const gate = await exportableDesign(projectId)
  if ('error' in gate) {
    const { status, ...body } = gate
    return c.json(body, status)
  }

  const designDir = path.join(UPLOADS_DIR, projectId, 'export', gate.row.id)
  // Pick one completed batch for this exact tactile design, then require the
  // requested artifact to be part of that same batch. Old grid/legend files
  // stay recoverable on disk but cannot leak into the current download set.
  const batch = await db.query.exports.findFirst({
    orderBy: [desc(exportsTable.createdAt), desc(exportsTable.id)],
    where: and(
      eq(exportsTable.projectId, projectId),
      like(exportsTable.path, likePrefix(`${designDir}${path.sep}`)),
    ),
  })
  if (!batch) {
    return c.json({ error: 'No export yet' }, 404)
  }
  const exportPath = path.join(path.dirname(batch.path), `${kind}.stl`)
  const row = await db.query.exports.findFirst({
    where: and(
      eq(exportsTable.projectId, projectId),
      eq(exportsTable.kind, kind),
      eq(exportsTable.path, exportPath),
    ),
  })
  if (!row) return c.json({ error: 'No current export file' }, 404)
  const file = Bun.file(row.path)
  if (!(await file.exists())) {
    return c.json({ error: 'Export file missing' }, 404)
  }
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  const base = (project?.name ?? 'tactile-map').replace(/\.[^.]+$/, '')
  return new Response(file, {
    headers: {
      'content-disposition': `attachment; filename="${base}-${kind}.stl"`,
      'content-type': 'model/stl',
    },
  })
})
