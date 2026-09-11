import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  buildValidationContext,
  convertToTactile,
  floorModelSchema,
  type FloorModel,
  type TactileDesign,
} from '@bumps/floor-model'
import { runTactileLayout } from './agents/tactile-layout'
import { db } from './db'
import { floorModels, projects, tactileDesigns } from './db/schema'
import { isRunningTactileJobConflict } from './lib/postgres-errors'

export const tactileRoutes = new Hono()

async function runConversion(rowId: string, model: FloorModel) {
  try {
    const { design: initial, notes } = convertToTactile(model)
    const context = buildValidationContext(model, initial)
    const layout = await runTactileLayout(initial, context, model)
    await db
      .update(tactileDesigns)
      .set({
        design: layout.design,
        iterations: layout.iterations,
        notes: layout.design.mmPerPx === initial.mmPerPx
          ? notes : convertToTactile(model, layout.design.grid).notes,
        status: 'done',
        valid: layout.valid,
        violations: layout.violations,
      })
      .where(eq(tactileDesigns.id, rowId))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Layout failed'
    await db
      .update(tactileDesigns)
      .set({ error: message.slice(0, 400), status: 'failed' })
      .where(eq(tactileDesigns.id, rowId))
  }
}

// Convert the latest floor model, validate against the standards, and run
// the agent layout loop until zero violations or the iteration cap — in the
// background; the client polls GET. The stored `valid` flag is the export
// gate: false designs never print.
tactileRoutes.post('/:id/tactile', async (c) => {
  const projectId = c.req.param('id')
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  if (!project) {
    return c.json({ error: 'Project not found' }, 404)
  }
  if (project.status !== 'parsed') {
    return c.json({ error: 'Project must finish parsing before tactile conversion' }, 409)
  }
  const latest = await db.query.floorModels.findFirst({
    orderBy: desc(floorModels.version),
    where: eq(floorModels.projectId, projectId),
  })
  if (!latest) {
    return c.json({ error: 'No floor model for this project' }, 404)
  }
  const running = await db.query.tactileDesigns.findFirst({
    where: and(
      eq(tactileDesigns.projectId, projectId),
      eq(tactileDesigns.status, 'running'),
    ),
  })
  if (running?.status === 'running') {
    return c.json({ status: 'running' }, 202)
  }
  const rowId = Bun.randomUUIDv7()
  const model = floorModelSchema.parse(latest.model)
  const { design, notes } = convertToTactile(model)
  try {
    await db.insert(tactileDesigns).values({
      design,
      floorModelVersion: latest.version,
      id: rowId,
      notes,
      projectId,
      status: 'running',
    })
  } catch (error) {
    if (isRunningTactileJobConflict(error)) {
      return c.json({ status: 'running' }, 202)
    }
    throw error
  }
  setTimeout(() => { void runConversion(rowId, model) }, 0)
  return c.json({ status: 'running' }, 202)
})

tactileRoutes.get('/:id/tactile', async (c) => {
  const row = await db.query.tactileDesigns.findFirst({
    orderBy: [desc(tactileDesigns.createdAt), desc(tactileDesigns.id)],
    where: eq(tactileDesigns.projectId, c.req.param('id')),
  })
  if (!row) {
    return c.json({ error: 'No tactile design for this project' }, 404)
  }
  const design = row.design as TactileDesign
  return c.json({
    // Older saved designs used an overflow threshold despite always exporting a legend.
    design: { ...design, separateLegendPlate: design.legend.length > 0 },
    error: row.error,
    floorModelVersion: row.floorModelVersion,
    iterations: row.iterations,
    notes: row.notes,
    status: row.status,
    valid: row.valid,
    violations: row.violations,
  })
})
