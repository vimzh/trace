// Export-only verification of saved study projects; never starts parsing, layout, or inference.
// SOURCE_RUN=<finished run> OUTPUT_DIR=<new directory> bun pipeline_tests/reexport-gallery.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { galleryContent } from '../apps/web/src/data/gallery'
import { inspectMesh } from './audit-gallery-baseline'

type Json = Record<string, any>
const ROOT = path.resolve(import.meta.dir, '..'), PUBLIC = path.join(ROOT, 'apps/web/public')
const API = (process.env.API_URL ?? 'http://localhost:3003').replace(/\/$/, '')
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const save = (file: string, value: unknown) => Bun.write(file, JSON.stringify(value, null, 2) + '\n')
const kindValid = (kind: unknown): kind is string => typeof kind === 'string' && /^(map|legend(?:-\d{1,2}of\d{1,2})?|plate-\d{1,2}of\d{1,2})$/.test(kind)
function verifyDesign(saved: Json | null, live: Json, version: number) {
  assert(saved?.design && live.design, 'Missing saved/live design; refusing export')
  assert.equal(saved.floorModelVersion, version, 'Saved design/model version mismatch')
  assert.equal(live.floorModelVersion, version, 'Live design/model version mismatch')
  for (const key of ['design', 'status', 'valid']) assert.deepEqual(live[key], saved[key], `Tactile ${key} mismatch; refusing export`)
}
async function request(endpoint: string, destination: string, method = 'GET') {
  assert(method === 'GET' || (method === 'POST' && /^\/projects\/[a-f0-9-]+\/export$/.test(endpoint)), 'Only export POST is permitted')
  const response = await fetch(API + endpoint, { method, signal: AbortSignal.timeout(120_000) })
  const body = await response.text(); await Bun.write(destination, body)
  return { status: response.status, body: JSON.parse(body) as Json }
}
async function main() {
  assert(process.env.SOURCE_RUN && process.env.OUTPUT_DIR, 'SOURCE_RUN and fresh OUTPUT_DIR are required')
  const source = await realpath(path.resolve(process.env.SOURCE_RUN)), output = path.resolve(process.env.OUTPUT_DIR)
  const reportBytes = await Bun.file(path.join(source, 'report.json')).bytes(), runBytes = await Bun.file(path.join(source, 'run.json')).bytes()
  const original: Json[] = JSON.parse(new TextDecoder().decode(reportBytes))
  const entries = galleryContent.entries.filter(item => original.some(row => row.slug === item.slug))
  assert(entries.length > 0, 'Source report must contain gallery cases')
  assert.deepEqual(original.map(row => row.slug).sort(), entries.map(item => item.slug).sort(), 'Source report must contain known gallery slugs exactly once')
  assert(original.every(row => ['completed', 'failed'].includes(row.status)), 'Source run is unfinished')
  assert.equal((await Bun.file(path.join(source, 'summary.json')).json()).total, entries.length, 'Missing complete source summary')
  assert.equal(new Set(original.map(row => row.projectId)).size, original.length, 'Projects must be unique')
  for (const forbidden of [PUBLIC, source]) assert(output !== forbidden && !output.startsWith(forbidden + path.sep), 'Output must be outside public assets and source run')
  await mkdir(path.dirname(output), { recursive: true })
  const parent = await realpath(path.dirname(output))
  for (const forbidden of [PUBLIC, source]) assert(parent !== forbidden && !parent.startsWith(forbidden + path.sep), 'Output must be outside public assets and source run')
  await mkdir(output)
  const started = Date.now(), reports: Json[] = []
  const manifest = { source, api: API, startedAt: new Date(started).toISOString(), modelCalls: 0,
    sourceRunSha256: hash(JSON.stringify([hash(runBytes), hash(reportBytes)])), sourceReportSha256: hash(reportBytes),
    meshSha256: hash(await Bun.file(path.join(ROOT, 'apps/api/src/geometry/mesh.ts')).bytes()), runnerSha256: hash(await Bun.file(import.meta.path).bytes()) }
  await save(path.join(output, 'run.json'), manifest)
  assert.equal((await request('/', path.join(output, 'health.json'))).body.ok, true, 'API is not healthy')
  for (const item of entries) {
    const row = original.find(row => row.slug === item.slug)!, prior = path.join(source, item.slug), dir = path.join(output, item.slug)
    const result: Json = { slug: item.slug, projectId: row.projectId, status: 'failed', errors: [], exports: [] }, began = Date.now()
    await mkdir(dir); reports.push(result); await save(path.join(dir, 'run.json'), result)
    try {
      assert(/^[a-f0-9-]{36}$/.test(row.projectId), 'Invalid saved project id')
      assert.equal((await Bun.file(path.join(prior, 'project-id.txt')).text()).trim(), row.projectId)
      assert.deepEqual(await Bun.file(path.join(prior, 'run.json')).json(), row, 'Per-case report mismatch')
      assert.equal(row.source.path, item.source, 'Gallery/source mapping mismatch')
      const sourceHash = hash(await Bun.file(path.join(PUBLIC, item.source)).bytes())
      assert.equal(row.source.sha256, sourceHash, 'Gallery source changed')
      assert.equal(hash(await Bun.file(path.join(prior, 'source-image')).bytes()), sourceHash, 'Saved project source mismatch')
      const endpoint = `/projects/${row.projectId}`, plan = await fetch(API + endpoint + '/plan', { signal: AbortSignal.timeout(120_000) })
      assert(plan.ok, `Project source HTTP ${plan.status}`); assert.equal(hash(new Uint8Array(await plan.arrayBuffer())), sourceHash, 'Live project source mismatch')
      const current = await request(endpoint + '/model', path.join(dir, 'model.json'))
      if (row.finalModelVersion) {
        assert.equal(current.status, 200); const saved = await Bun.file(path.join(prior, 'model.json')).json()
        assert.equal(current.body.version, row.finalModelVersion); assert.deepEqual(current.body.model, saved.model)
        assert.equal(saved.version, row.finalModelVersion)
      } else assert.equal(current.status, 404, 'Unexpected live model without saved version')
      const live = await request(endpoint + '/tactile', path.join(dir, 'tactile.json')), savedFile = Bun.file(path.join(prior, 'tactile.json'))
      const saved = await savedFile.exists() ? await savedFile.json() : null
      if (live.status === 200) verifyDesign(saved, live.body, row.finalModelVersion)
      else { assert.equal(live.status, 404); assert(!saved?.design, 'Saved design disappeared') }
      Object.assign(result, { sourceSha256: sourceHash, modelVersion: row.finalModelVersion ?? null, designSha256: saved?.design ? hash(JSON.stringify(saved.design)) : null })
      const available = live.status === 200 && live.body.status === 'done' && live.body.valid === true
      const exported = await request(endpoint + '/export', path.join(dir, 'export.json'), 'POST')
      if (!available) {
        assert.equal(exported.status, live.status === 404 || live.body.status !== 'done' ? 404 : 409, 'Unavailable design was not blocked')
        Object.assign(result, { status: 'not-available', blockedStatus: exported.status, reason: exported.body.error }); continue
      }
      assert.equal(exported.status, 201); assert(Array.isArray(exported.body.files) && exported.body.files.some((file: Json) => file.kind === 'map'))
      assert.equal(new Set(exported.body.files.map((file: Json) => file.kind)).size, exported.body.files.length, 'Duplicate export kinds')
      for (const metadata of exported.body.files as Json[]) try {
        assert(kindValid(metadata.kind), `Invalid export kind: ${metadata.kind}`)
        const name = `${metadata.kind}.stl`, response = await fetch(API + endpoint + '/export/' + name, { signal: AbortSignal.timeout(120_000) })
        const bytes = new Uint8Array(await response.arrayBuffer()); await Bun.write(path.join(dir, name), bytes)
        assert(response.ok, `Download HTTP ${response.status}`)
        const { metrics, previewSvg } = inspectMesh(bytes), oldFile = Bun.file(path.join(prior, name))
        const record: Json = { ...metadata, sha256: hash(bytes), bytes: bytes.length, mesh: metrics, originalSha256: null, comparison: null }
        result.exports.push(record); await save(path.join(dir, `${metadata.kind}-mesh.json`), record)
        if (previewSvg) await Bun.write(path.join(dir, `${metadata.kind}-raised.svg`), previewSvg)
        const oldBytes = await oldFile.exists() ? await oldFile.bytes() : null, old = oldBytes ? inspectMesh(oldBytes).metrics : null
        if (oldBytes) assert.equal(hash(oldBytes), row.exports?.find((file: Json) => file.kind === metadata.kind)?.sha256, 'Original STL hash mismatch')
        Object.assign(record, { originalSha256: oldBytes ? hash(oldBytes) : null,
          comparison: old ? { originalVolumeMm3: old.signedVolumeMm3, volumeDeltaMm3: metrics.signedVolumeMm3! - old.signedVolumeMm3!, originalBoundsMm: old.boundsMm, boundsUnchanged: JSON.stringify(old.boundsMm) === JSON.stringify(metrics.boundsMm) } : null })
        await save(path.join(dir, `${metadata.kind}-mesh.json`), record)
        assert.equal(metrics.triangles, metadata.triangles); assert.equal(metrics.issues.length, 0, metrics.issues.join('; '))
      } catch (error) { result.errors.push(`${metadata.kind}: ${String(error)}`) }
      const after = await request(endpoint + '/tactile', path.join(dir, 'tactile-after.json'))
      assert.equal(after.status, 200); verifyDesign(saved, after.body, row.finalModelVersion)
      const afterModel = await request(endpoint + '/model', path.join(dir, 'model-after.json'))
      assert.deepEqual(afterModel, current, 'Model changed during export')
      result.status = result.errors.length ? 'failed' : 'completed'
    } catch (error) { result.errors.push(String(error)) }
    finally {
      result.durationSeconds = (Date.now() - began) / 1000
      await save(path.join(dir, 'run.json'), result); await save(path.join(output, 'report.json'), reports)
      console.log(`${item.slug}: ${result.status} (${result.durationSeconds}s)`)
    }
  }
  const summary = { ...manifest, completed: reports.filter(row => row.status === 'completed').length, failed: reports.filter(row => row.status === 'failed').length,
    notAvailable: reports.filter(row => row.status === 'not-available').length, total: reports.length, durationSeconds: (Date.now() - started) / 1000 }
  await save(path.join(output, 'summary.json'), summary); console.log(JSON.stringify(summary)); if (summary.failed) process.exitCode = 1
}
if (import.meta.main) {
  if (process.argv[2] === '--self-check') {
    const design = { floorModelVersion: 1, design: { elements: [] }, status: 'done', valid: true }
    verifyDesign(design, structuredClone(design), 1)
    assert.throws(() => verifyDesign(null, design, 1), /Missing/)
    assert.throws(() => verifyDesign(design, { ...design, design: {} }, 1), /mismatch/)
    assert.throws(() => verifyDesign(design, design, 2), /version mismatch/)
    assert(kindValid('plate-2of4')); assert(!kindValid('../map'))
    console.log('Export-only design/version/path self-check passed; zero API/model calls')
  } else { assert.equal(process.argv.length, 2, 'Use SOURCE_RUN=... OUTPUT_DIR=... bun pipeline_tests/reexport-gallery.ts'); await main() }
}
