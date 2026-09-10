// Verifies real PostgreSQL locking and uniqueness guarantees.
import { strict as assert } from 'node:assert'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { sampleFloorModel } from '@bumps/floor-model'
import { db } from '../src/db'
import { floorModels, projects, tactileDesigns } from '../src/db/schema'
import {
  modelRoutes,
  saveModelVersion,
  StaleModelVersionError,
} from '../src/models'
import { parseRoutes } from '../src/parse'
import { exportRoutes } from '../src/export'
import { isRunningTactileJobConflict } from '../src/lib/postgres-errors'
import { projectRoutes } from '../src/projects'

const projectId = `audit-${Bun.randomUUIDv7()}`
const uploadedProjectIds: string[] = []
await db.insert(projects).values({
  id: projectId,
  name: 'audit.png',
  planPath: '/tmp/bumps-audit-missing.png',
  sourcePath: '/tmp/bumps-audit-missing.png',
})

try {
  const malformedMultipart = await projectRoutes.request('http://local/', {
    body: 'not-a-multipart-body',
    headers: { 'content-type': 'multipart/form-data; boundary=missing' },
    method: 'POST',
  })
  assert.equal(malformedMultipart.status, 400)

  const corruptUpload = new FormData()
  corruptUpload.set(
    'file',
    new File(['not an image'], 'spoof.png', { type: 'image/png' }),
  )
  const corruptResponse = await projectRoutes.request('http://local/', {
    body: corruptUpload,
    method: 'POST',
  })
  assert.equal(corruptResponse.status, 422)

  for (const fixture of [
    {
      file: 'floor-plans/house-bolduc.png',
      name: 'plan.png',
      type: 'image/png',
    },
    {
      file: 'floor-plans/house-hills-decaro-1st-1906.jpg',
      name: 'mislabeled.jpg',
      type: 'image/png',
    },
    {
      file: 'floor-plans/house-gottlieb-ground.pdf',
      name: 'plan.pdf',
      type: 'application/pdf',
    },
  ]) {
    const bytes = await Bun.file(
      path.resolve(import.meta.dir, '../../../test-assets', fixture.file),
    ).bytes()
    const form = new FormData()
    form.set('file', new File([bytes], fixture.name, { type: fixture.type }))
    const response = await projectRoutes.request('http://local/', {
      body: form,
      method: 'POST',
    })
    assert.equal(response.status, 201)
    const { id } = (await response.json()) as { id: string }
    uploadedProjectIds.push(id)
    const plan = await projectRoutes.request(`http://local/${id}/plan`)
    assert.equal(plan.status, 200)
    assert((await plan.arrayBuffer()).byteLength > 0)
  }

  const saves = await Promise.allSettled([
    saveModelVersion({
      expectedVersion: 0,
      model: sampleFloorModel,
      projectId,
    }),
    saveModelVersion({
      expectedVersion: 0,
      model: sampleFloorModel,
      projectId,
    }),
  ])
  assert.equal(saves.filter((result) => result.status === 'fulfilled').length, 1)
  const rejectedSave = saves.find((result) => result.status === 'rejected')
  assert(
    rejectedSave?.status === 'rejected' &&
      rejectedSave.reason instanceof StaleModelVersionError,
  )

  const storedModels = await db.query.floorModels.findMany({
    where: eq(floorModels.projectId, projectId),
  })
  assert.deepEqual(storedModels.map(({ version }) => version), [1])

  const malformed = await modelRoutes.request(
    `http://local/${projectId}/model/operations`,
    { headers: { 'if-match': '1' }, method: 'POST' },
  )
  assert.equal(malformed.status, 400)

  const missingPrecondition = await modelRoutes.request(
    `http://local/${projectId}/model/operations`,
    { method: 'POST' },
  )
  assert.equal(missingPrecondition.status, 428)

  const stalePrecondition = await modelRoutes.request(
    `http://local/${projectId}/model/operations`,
    {
      body: JSON.stringify({ operations: [{ id: 'w-top', op: 'confirm' }] }),
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      method: 'POST',
    },
  )
  assert.equal(stalePrecondition.status, 409)

  const malformedVersion = await modelRoutes.request(
    `http://local/${projectId}/model?version=not-a-number`,
  )
  assert.equal(malformedVersion.status, 400)

  await db.insert(tactileDesigns).values({
    design: {},
    floorModelVersion: 0,
    id: Bun.randomUUIDv7(),
    notes: [],
    projectId,
    status: 'done',
    valid: true,
  })
  const staleExport = await exportRoutes.request(
    `http://local/${projectId}/export`,
    { method: 'POST' },
  )
  assert.equal(staleExport.status, 409)

  const parseResponses = await Promise.all([
    parseRoutes.request(`http://local/${projectId}/parse`, { method: 'POST' }),
    parseRoutes.request(`http://local/${projectId}/parse`, { method: 'POST' }),
  ])
  assert.deepEqual(
    parseResponses.map(({ status }) => status).sort(),
    [202, 409],
  )

  const jobs = await Promise.allSettled([
    db.insert(tactileDesigns).values({
      design: {},
      floorModelVersion: 1,
      id: Bun.randomUUIDv7(),
      notes: [],
      projectId,
      status: 'running',
    }),
    db.insert(tactileDesigns).values({
      design: {},
      floorModelVersion: 1,
      id: Bun.randomUUIDv7(),
      notes: [],
      projectId,
      status: 'running',
    }),
  ])
  assert.equal(jobs.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(jobs.filter((result) => result.status === 'rejected').length, 1)
  const rejectedJob = jobs.find((result) => result.status === 'rejected')
  assert.equal(rejectedJob?.status, 'rejected')
  if (rejectedJob?.status === 'rejected') {
    assert.equal(
      rejectedJob.reason.cause?.constraint,
      'tactile_designs_one_running_per_project',
    )
    assert.equal(isRunningTactileJobConflict(rejectedJob.reason), true)
  }

  await Bun.sleep(100)
  console.log('PostgreSQL concurrency audit passed')
} finally {
  for (const id of uploadedProjectIds) {
    const uploaded = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })
    await db.delete(projects).where(eq(projects.id, id))
    if (uploaded) {
      await rm(path.dirname(uploaded.sourcePath), {
        force: true,
        recursive: true,
      })
    }
  }
  await db.delete(tactileDesigns).where(eq(tactileDesigns.projectId, projectId))
  await db.delete(floorModels).where(eq(floorModels.projectId, projectId))
  await db.delete(projects).where(eq(projects.id, projectId))
  await db.$client.close()
}
