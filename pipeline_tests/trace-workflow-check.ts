// Exercises one isolated live project through parse, edits, tactile conversion, and export freshness.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const API = (process.env.API_URL ?? 'http://localhost:3003').replace(/\/$/, '')
const OUTPUT = path.resolve(ROOT, process.env.OUTPUT_DIR ?? 'pipeline_tests/trace-readiness-20260913/workflow')
const SOURCE = path.resolve(ROOT, process.env.SOURCE_PATH ?? 'apps/web/public/gallery/test-public-restrooms-source.png')
type Json = Record<string, any>

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const save = (name: string, value: unknown) => Bun.write(path.join(OUTPUT, name), JSON.stringify(value, null, 2) + '\n')

async function json(url: string, name: string, init?: RequestInit, expected = true): Promise<{ body: Json; response: Response }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  let body: Json
  try { body = JSON.parse(text) } catch { throw new Error(`${response.status} ${url}: expected JSON, got ${text.slice(0, 200)}`) }
  await save(name, { body, status: response.status, url })
  if (expected && !response.ok) throw new Error(`${response.status} ${url}: ${text}`)
  return { body, response }
}

async function poll(url: string, name: string, terminal: string[], minutes: number) {
  const deadline = Date.now() + minutes * 60_000
  let last = ''
  while (Date.now() < deadline) {
    const value = await json(url, name)
    const state = JSON.stringify({ status: value.body.status, progress: value.body.parseProgress, iterations: value.body.iterations })
    if (state !== last) { console.log(state); last = state }
    if (terminal.includes(value.body.status)) return value.body
    await Bun.sleep(8_000)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function labelTarget(model: Json) {
  for (const key of ['rooms', 'furniture', 'roads', 'features'] as const) {
    const item = model[key]?.find((entry: Json) => typeof entry.label === 'string' && entry.label.trim())
    if (item) return { id: item.id as string, label: item.label as string }
  }
  throw new Error('Parsed model has no relabelable named element')
}

function geometry(model: Json) {
  const copy = structuredClone(model)
  for (const key of ['rooms', 'furniture', 'roads', 'features']) {
    for (const item of copy[key] ?? []) delete item.label
  }
  return copy
}

function artifactName(kind: unknown) {
  assert(typeof kind === 'string' && /^(map|legend(?:-\d{1,2}of\d{1,2})?|plate-\d{1,2}of\d{1,2})$/.test(kind))
  return `${kind}.stl`
}

async function downloadArtifacts(projectId: string, exported: Json, prefix: string) {
  const records: Json[] = []
  for (const entry of exported.files) {
    const name = artifactName(entry.kind)
    const response = await fetch(`${API}/projects/${projectId}/export/${name}`, { signal: AbortSignal.timeout(120_000) })
    const bytes = new Uint8Array(await response.arrayBuffer())
    await Bun.write(path.join(OUTPUT, `${prefix}-${name}`), bytes)
    records.push({ bytes: bytes.length, kind: entry.kind, sha256: hash(bytes), status: response.status })
    assert.equal(response.status, 200, `${name} download failed`)
  }
  await save(`${prefix}-downloads.json`, records)
}

async function main() {
  const resumedProjectId = process.env.PROJECT_ID
  await mkdir(path.dirname(OUTPUT), { recursive: true })
  await mkdir(OUTPUT) // Even resumed projects get new evidence; never overwrite a prior run.
  const source = await Bun.file(SOURCE).bytes()
  await Bun.write(path.join(OUTPUT, 'source.png'), source)
  const report: Json = { api: API, source: { path: path.relative(ROOT, SOURCE), sha256: hash(source) }, startedAt: new Date().toISOString(), status: 'running' }
  await save('run.json', report)
  try {
    let projectId = resumedProjectId
    if (!projectId) {
      const form = new FormData()
      form.set('file', new File([source], path.basename(SOURCE), { type: 'image/png' }))
      const created = await json(`${API}/projects`, 'upload.json', { body: form, method: 'POST' })
      projectId = created.body.id as string
    }
    assert(projectId)
    report.projectId = projectId
    await Bun.write(path.join(OUTPUT, 'project-id.txt'), `${projectId}\n`)
    const beforeParse = (await json(`${API}/projects/${projectId}`, 'project-before-parse.json')).body
    if (beforeParse.status !== 'parsed') await json(`${API}/projects/${projectId}/parse`, 'parse-start.json', { method: 'POST' })
    const project = beforeParse.status === 'parsed'
      ? beforeParse
      : await poll(`${API}/projects/${projectId}`, 'project.json', ['parsed', 'failed'], 35)
    assert.equal(project.status, 'parsed', project.parseError)
    const initial = (await json(`${API}/projects/${projectId}/model`, 'model-v1.json')).body
    const target = labelTarget(initial.model)
    const promptLabel = 'workflow label one'
    const edited = await json(`${API}/projects/${projectId}/model/edit`, 'prompt-edit.json', {
      body: JSON.stringify({ prompt: `Rename only the selected label to "${promptLabel}". Do not move, add, delete, resize, or reshape anything.`, selectedId: target.id }),
      headers: { 'content-type': 'application/json', 'if-match': String(initial.version) }, method: 'POST',
    })
    assert.equal(edited.body.action, 'applied')
    assert.deepEqual(geometry(initial.model), geometry(edited.body.model), 'prompt edit changed geometry')
    const editedTarget = [
      ...edited.body.model.rooms, ...edited.body.model.furniture,
      ...(edited.body.model.roads ?? []), ...edited.body.model.features,
    ].find((item: Json) => item.id === target.id)
    assert.equal(editedTarget?.label, promptLabel)
    const historical = await json(`${API}/projects/${projectId}/model?version=${initial.version}`, 'historical-model.json')
    assert.deepEqual(historical.body.model, initial.model)
    const stale = await json(`${API}/projects/${projectId}/model/operations`, 'stale-if-match.json', {
      body: JSON.stringify({ operations: [{ op: 'relabel', id: target.id, label: 'should not apply' }] }),
      headers: { 'content-type': 'application/json', 'if-match': String(initial.version) }, method: 'POST',
    }, false)
    assert.equal(stale.response.status, 409)
    await json(`${API}/projects/${projectId}/tactile`, 'tactile-start.json', { method: 'POST' })
    const tactile = await poll(`${API}/projects/${projectId}/tactile`, 'tactile.json', ['done', 'failed'], 20)
    assert.equal(tactile.status, 'done', tactile.error); assert.equal(tactile.valid, true, JSON.stringify(tactile.violations))
    const firstExport = (await json(`${API}/projects/${projectId}/export`, 'export-v1.json', { method: 'POST' })).body
    await downloadArtifacts(projectId, firstExport, 'v1')
    const operationLabel = 'workflow label two'
    const operation = await json(`${API}/projects/${projectId}/model/operations`, 'operations-edit.json', {
      body: JSON.stringify({ operations: [{ op: 'relabel', id: target.id, label: operationLabel }] }),
      headers: { 'content-type': 'application/json', 'if-match': String(edited.body.version) }, method: 'POST',
    })
    const staleGet = await json(`${API}/projects/${projectId}/export/map.stl`, 'stale-export-get.json', undefined, false)
    assert.equal(staleGet.response.status, 409)
    const stalePost = await json(`${API}/projects/${projectId}/export`, 'stale-export-post.json', { method: 'POST' }, false)
    assert.equal(stalePost.response.status, 409)
    await json(`${API}/projects/${projectId}/tactile`, 'tactile-v2-start.json', { method: 'POST' })
    const tactile2 = await poll(`${API}/projects/${projectId}/tactile`, 'tactile-v2.json', ['done', 'failed'], 20)
    assert.equal(tactile2.status, 'done', tactile2.error); assert.equal(tactile2.valid, true, JSON.stringify(tactile2.violations))
    const secondExport = (await json(`${API}/projects/${projectId}/export`, 'export-v2.json', { method: 'POST' })).body
    await downloadArtifacts(projectId, secondExport, 'v2')
    report.result = { initialVersion: initial.version, promptEditVersion: edited.body.version, operationsVersion: operation.body.version, staleExportGet: staleGet.response.status, staleExportPost: stalePost.response.status }
    report.status = 'completed'
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); report.status = 'failed' }
  report.finishedAt = new Date().toISOString()
  await save('run.json', report)
  if (report.status !== 'completed') throw new Error(report.error)
}

await main()
