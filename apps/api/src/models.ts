import { desc, eq, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  applyOperations,
  EditOperationError,
  editOperationSchema,
  floorModelSchema,
  renderFloorModelSvg,
  type FloorModel,
} from '@bumps/floor-model'
import { EditConversionError, runEditAgent } from './agents/edit'
import { db } from './db'
import { floorModels, projects } from './db/schema'
import {
  parseExpectedModelVersion,
  parseModelVersionQuery,
} from './lib/request-version'

// Floor model versions are append-only: every save is a new version,
// which gives the editor undo and the critique loop its iteration trail.

async function latestModelRow(projectId: string) {
  return db.query.floorModels.findFirst({
    orderBy: desc(floorModels.version),
    where: eq(floorModels.projectId, projectId),
  })
}

export class StaleModelVersionError extends Error {
  constructor() {
    super('The floor model changed while this update was in progress')
  }
}

export async function saveModelVersion(options: {
  critique?: unknown
  expectedVersion: number
  iteration?: number
  model: FloorModel
  projectId: string
}): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${options.projectId}))`,
    )
    const latest = await tx.query.floorModels.findFirst({
      orderBy: desc(floorModels.version),
      where: eq(floorModels.projectId, options.projectId),
    })
    if ((latest?.version ?? 0) !== options.expectedVersion) {
      throw new StaleModelVersionError()
    }

    const version = options.expectedVersion + 1
    await tx.insert(floorModels).values({
      critique: options.critique,
      id: Bun.randomUUIDv7(),
      iteration: options.iteration,
      model: options.model,
      projectId: options.projectId,
      version,
    })
    return version
  })
}

// Stored models predate schema additions (e.g. furniture); re-parsing
// applies defaults so every model leaving the API is current-shape.
function normalizeModel(raw: unknown): FloorModel {
  return floorModelSchema.parse(raw)
}

async function projectExists(projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  return project !== undefined
}

async function readJson(c: Context): Promise<
  | { ok: true; value: unknown }
  | { ok: false }
> {
  try {
    return { ok: true, value: await c.req.json() }
  } catch {
    return { ok: false }
  }
}

function requestedModelVersion(c: Context):
  | { ok: true; value: number }
  | { error: string; ok: false; status: 400 | 428 } {
  const parsed = parseExpectedModelVersion(c.req.header('if-match'))
  if (parsed === undefined) {
    return {
      error: 'If-Match model version is required',
      ok: false,
      status: 428,
    }
  }
  if (parsed === null) {
    return { error: 'If-Match must be an integer model version', ok: false, status: 400 }
  }
  return { ok: true, value: parsed }
}

export const modelRoutes = new Hono()

modelRoutes.post('/:id/model', async (c) => {
  const projectId = c.req.param('id')
  if (!(await projectExists(projectId))) {
    return c.json({ error: 'Project not found' }, 404)
  }
  const requested = requestedModelVersion(c)
  if (!requested.ok) return c.json({ error: requested.error }, requested.status)
  const body = await readJson(c)
  if (!body.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = floorModelSchema.safeParse(body.value)
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid floor model', issues: parsed.error.issues },
      422,
    )
  }
  const latest = await latestModelRow(projectId)
  if ((latest?.version ?? 0) !== requested.value) {
    return c.json({ error: new StaleModelVersionError().message }, 409)
  }
  let version: number
  try {
    version = await saveModelVersion({
      expectedVersion: requested.value,
      model: parsed.data,
      projectId,
    })
  } catch (error) {
    if (error instanceof StaleModelVersionError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
  return c.json({ version }, 201)
})

modelRoutes.get('/:id/model', async (c) => {
  const projectId = c.req.param('id')
  const requested = parseModelVersionQuery(c.req.query('version'))
  if (requested === null) {
    return c.json({ error: 'version must be a positive integer' }, 400)
  }
  const row = requested !== undefined
    ? await db.query.floorModels.findFirst({
        orderBy: desc(floorModels.version),
        where: (table, { and }) =>
          and(eq(table.projectId, projectId), eq(table.version, requested)),
      })
    : await latestModelRow(projectId)
  if (!row) {
    return c.json({ error: 'No floor model for this project' }, 404)
  }
  return c.json({
    critique: row.critique,
    iteration: row.iteration,
    model: normalizeModel(row.model),
    version: row.version,
  })
})

modelRoutes.get('/:id/model/versions', async (c) => {
  const rows = await db.query.floorModels.findMany({
    columns: { createdAt: true, version: true },
    orderBy: desc(floorModels.version),
    where: eq(floorModels.projectId, c.req.param('id')),
  })
  return c.json({ versions: rows })
})

const operationsBodySchema = z.object({
  operations: z.array(editOperationSchema).min(1).max(2_000),
})

// Applies a batch of edit operations to the latest version and saves the
// result as a new version. The only write path besides a full model save.
modelRoutes.post('/:id/model/operations', async (c) => {
  const projectId = c.req.param('id')
  const requested = requestedModelVersion(c)
  if (!requested.ok) return c.json({ error: requested.error }, requested.status)
  const latest = await latestModelRow(projectId)
  if (!latest) {
    return c.json({ error: 'No floor model for this project' }, 404)
  }
  if (latest.version !== requested.value) {
    return c.json({ error: new StaleModelVersionError().message }, 409)
  }
  const body = await readJson(c)
  if (!body.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = operationsBodySchema.safeParse(body.value)
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid operations', issues: parsed.error.issues },
      422,
    )
  }
  let next: FloorModel
  try {
    next = floorModelSchema.parse(
      applyOperations(normalizeModel(latest.model), parsed.data.operations),
    )
  } catch (error) {
    if (error instanceof EditOperationError) {
      return c.json({ error: error.message }, 422)
    }
    return c.json({ error: 'Operations produced an invalid model' }, 422)
  }
  let version: number
  try {
    version = await saveModelVersion({
      expectedVersion: requested.value,
      model: next,
      projectId,
    })
  } catch (error) {
    if (error instanceof StaleModelVersionError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
  return c.json({ version }, 201)
})

const editBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  selectedId: z.string().min(1).max(80).nullable().optional(),
})

// Natural-language editing: the EditAgent proposes operations, code validates
// and applies them; anything referencing unknown ids is rejected wholesale.
modelRoutes.post('/:id/model/edit', async (c) => {
  const projectId = c.req.param('id')
  const requested = requestedModelVersion(c)
  if (!requested.ok) return c.json({ error: requested.error }, requested.status)
  const latest = await latestModelRow(projectId)
  if (!latest) {
    return c.json({ error: 'No floor model for this project' }, 404)
  }
  if (latest.version !== requested.value) {
    return c.json({ error: new StaleModelVersionError().message }, 409)
  }
  const requestBody = await readJson(c)
  if (!requestBody.ok) return c.json({ error: 'Invalid JSON body' }, 400)
  const body = editBodySchema.safeParse(requestBody.value)
  if (!body.success) {
    return c.json({ error: 'Invalid request', issues: body.error.issues }, 422)
  }

  let result
  try {
    result = await runEditAgent({
      model: normalizeModel(latest.model),
      prompt: body.data.prompt,
      selectedId: body.data.selectedId ?? null,
    })
  } catch (error) {
    if (error instanceof EditConversionError) {
      return c.json({ error: error.message }, 422)
    }
    const message = error instanceof Error ? error.message : 'Edit failed'
    return c.json({ error: message.slice(0, 300) }, 502)
  }

  if (result.action === 'clarify') {
    return c.json({ action: 'clarify', question: result.question })
  }

  let next: FloorModel
  try {
    next = floorModelSchema.parse(
      applyOperations(normalizeModel(latest.model), result.operations),
    )
  } catch (error) {
    if (error instanceof EditOperationError) {
      return c.json({ error: error.message }, 422)
    }
    return c.json({ error: 'Edit produced an invalid model' }, 422)
  }

  let version: number
  try {
    version = await saveModelVersion({
      expectedVersion: requested.value,
      model: next,
      projectId,
    })
  } catch (error) {
    if (error instanceof StaleModelVersionError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
  return c.json({
    action: 'applied',
    model: next,
    operationCount: result.operations.length,
    summary: result.summary,
    version,
  })
})

modelRoutes.get('/:id/model/svg', async (c) => {
  const row = await latestModelRow(c.req.param('id'))
  if (!row) {
    return c.json({ error: 'No floor model for this project' }, 404)
  }
  const svg = renderFloorModelSvg(normalizeModel(row.model))
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' })
})
