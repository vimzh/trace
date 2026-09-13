// Evaluates gallery or local-manifest sources in isolated run directories; never publishes or changes input assets.
// OUTPUT_DIR=<new directory> CONCURRENCY=3 bun pipeline_tests/regenerate-gallery.ts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { galleryContent, type GalleryItem } from '../apps/web/src/data/gallery'
import { renderFloorModelSvg } from '../packages/floor-model/src/render'
import { floorModelSchema } from '../packages/floor-model/src/schema'
import { inspectMesh } from './audit-gallery-baseline'

const ROOT = path.resolve(import.meta.dir, '..')
const PUBLIC = path.join(ROOT, 'apps/web/public')
const API = (process.env.API_URL ?? 'http://localhost:3003').replace(/\/$/, '')
type Json = Record<string, any>
type EvalCase = Pick<GalleryItem, 'slug' | 'title' | 'source'> & { stl?: string, local?: true }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const save = (file: string, value: unknown) => Bun.write(file, JSON.stringify(value, null, 2) + '\n')

function selectCases(only?: string, projectId?: string, inventory: readonly EvalCase[] = galleryContent.entries) {
  const requested = only?.split(',').map((slug) => slug.trim())
  assert.equal(new Set(inventory.map((item) => item.slug)).size, inventory.length, 'Case slugs must be unique')
  if (requested) {
    assert.equal(new Set(requested).size, requested.length, 'ONLY slugs must be unique')
    for (const slug of requested) assert(inventory.some((item) => item.slug === slug), `Unknown case slug: ${slug}`)
  }
  const cases = inventory.filter((item) => !requested || requested.includes(item.slug))
  assert(cases.length > 0, 'No evaluation cases selected')
  assert(!projectId || (only && cases.length === 1), 'PROJECT_ID requires exactly one ONLY case slug')
  return cases
}

function concurrency(value = '1', maximum = galleryContent.entries.length) {
  const number = Number(value)
  assert(Number.isInteger(number) && number >= 1 && number <= maximum,
    `CONCURRENCY must be an integer from 1 to ${maximum}`)
  return number
}

function assetPath(url: string, local = false) {
  if (local) {
    assert(!path.isAbsolute(url) && !url.split(/[\\/]/).includes('..'), `Expected repository-relative asset: ${url}`)
    const resolved = path.resolve(ROOT, url)
    assert(resolved.startsWith(`${ROOT}${path.sep}`), `Asset must be inside repository: ${url}`)
    return resolved
  }
  assert(/^\/gallery\/[^/]+$/.test(url) && !url.includes('..'), `Unexpected gallery asset: ${url}`)
  return path.join(PUBLIC, url)
}

async function localPath(value: string) {
  const resolved = await realpath(assetPath(value, true))
  const root = await realpath(ROOT)
  assert(resolved.startsWith(`${root}${path.sep}`), `Asset resolves outside repository: ${value}`)
  return resolved
}

async function loadInventory(manifestPath?: string): Promise<{ items: readonly EvalCase[], manifest: Json | null }> {
  if (!manifestPath) return { items: galleryContent.entries, manifest: null }
  const bytes = await Bun.file(await localPath(manifestPath)).bytes()
  const values: unknown = JSON.parse(new TextDecoder().decode(bytes))
  assert(Array.isArray(values) && values.length > 0, 'CASES_FILE must contain a nonempty JSON array')
  const items: EvalCase[] = []
  for (const value of values) {
    assert(value && typeof value === 'object', 'Case must be an object')
    assert(typeof value.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug), 'Invalid case slug')
    assert(typeof value.title === 'string' && value.title.trim(), `Missing title: ${value.slug}`)
    assert(typeof value.source === 'string', `Missing source: ${value.slug}`)
    await localPath(value.source)
    if (value.stl !== undefined) {
      assert(typeof value.stl === 'string', `Invalid archived STL: ${value.slug}`)
      await localPath(value.stl)
    }
    items.push({ slug: value.slug, title: value.title, source: value.source, stl: value.stl, local: true })
  }
  selectCases(undefined, undefined, items)
  return { items, manifest: { path: manifestPath, sha256: sha256(bytes) } }
}

function exportName(kind: unknown) {
  assert(typeof kind === 'string' && /^(map|legend(?:-\d{1,2}of\d{1,2})?|plate-\d{1,2}of\d{1,2})$/.test(kind),
    `Invalid export kind: ${kind}`)
  return `${kind}.stl`
}

async function bounded<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]!) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  return results
}

async function requestJson(url: string, snapshot: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
  const body = await response.text()
  if (!response.ok) {
    await save(`${snapshot}.http-error.json`, { url, status: response.status, body })
    throw new Error(`${response.status} ${url}: ${body}`)
  }
  await Bun.write(snapshot, body)
  try {
    return JSON.parse(body) as Json
  } catch {
    throw new Error(`${response.status} ${url}: Invalid JSON (raw response saved in ${snapshot})`)
  }
}

async function download(url: string, destination: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    const body = await response.text()
    await save(`${destination}.http-error.json`, { url, status: response.status, body })
    throw new Error(`Artifact download failed: ${response.status} ${url}: ${body}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  await Bun.write(destination, bytes)
  return bytes
}

async function poll(url: string, snapshot: string, slug: string, timeoutMinutes: number) {
  const deadline = Date.now() + timeoutMinutes * 60_000
  let previous = ''
  while (Date.now() < deadline) {
    const body = await requestJson(url, snapshot)
    const summary = JSON.stringify({ status: body.status, progress: body.parseProgress, iterations: body.iterations })
    if (summary !== previous) {
      await appendFile(`${snapshot}.progress.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...body }) + '\n')
      console.log(`${slug}: ${body.status}${body.parseProgress ? ` ${body.parseProgress.stage} ${body.parseProgress.iteration}/${body.parseProgress.maxIterations}` : ''}`)
      previous = summary
    }
    // Persist failed and invalid responses before the caller decides whether to proceed.
    if (['parsed', 'done', 'failed'].includes(body.status)) return body
    await Bun.sleep(8_000)
  }
  throw new Error(`Timed out after ${timeoutMinutes} minutes: ${url}; the server job may still be running`)
}

async function codeFingerprint() {
  const files = ['apps/api/package.json', 'packages/floor-model/package.json', 'bun.lock',
    'apps/web/src/data/gallery.ts', 'pipeline_tests/regenerate-gallery.ts', 'pipeline_tests/audit-gallery-baseline.ts']
  for (const directory of ['apps/api/src', 'apps/api/scripts', 'packages/floor-model/src']) {
    for await (const file of new Bun.Glob('**/*.ts').scan(path.join(ROOT, directory))) {
      files.push(path.join(directory, file))
    }
  }
  const hashes = []
  for (const file of files.sort()) hashes.push({ file, sha256: sha256(await Bun.file(path.join(ROOT, file)).bytes()) })
  return { sha256: sha256(JSON.stringify(hashes)), files: hashes }
}

async function runCase(item: EvalCase, directory: string, report: Json, update: () => Promise<unknown>) {
  const started = Date.now()
  const errors: string[] = []
  let projectId = process.env.PROJECT_ID
  let capturedModels = false
  let tactile: Json | undefined
  const file = (name: string) => path.join(directory, name)
  const persist = async () => { await save(file('run.json'), report); await update() }
  const stage = async (name: string) => { report.stage = name; await persist() }
  async function capture(label: string, action: () => Promise<unknown>) {
    try { await action() } catch (error) {
      errors.push(`${label}: ${message(error)}`)
      console.error(`${item.slug}: ${errors.at(-1)}`)
    }
  }
  async function captureModels() {
    const index = await requestJson(`${API}/projects/${projectId}/model/versions`, file('model-versions.json'))
    assert(Array.isArray(index.versions), 'API did not return model versions')
    const history: Json[] = []
    for (const entry of index.versions as Json[]) {
      await capture(`model version ${entry.version}`, async () => {
        assert(Number.isInteger(entry.version) && entry.version > 0, 'Invalid model version')
        const model = await requestJson(`${API}/projects/${projectId}/model?version=${entry.version}`, file(`model-v${entry.version}.json`))
        history.push(model)
        await save(file('model-history.json'), history)
        await Bun.write(file(`model-v${entry.version}.svg`), renderFloorModelSvg(floorModelSchema.parse(model.model)))
      })
    }
    await save(file('model-history.json'), history)
    report.modelVersions = history.map((model) => model.version)
    if (index.versions.length) {
      await capture('final model', async () => {
        const final = await requestJson(`${API}/projects/${projectId}/model`, file('model.json'))
        const model = floorModelSchema.parse(final.model)
        await Bun.write(file('design.svg'), renderFloorModelSvg(model))
        Object.assign(report, { finalModelVersion: final.version, rooms: model.rooms.length,
          walls: model.walls.length, openings: model.openings.length,
          features: model.features.length, furniture: model.furniture.length })
      })
    }
    capturedModels = true
  }

  await mkdir(directory)
  Object.assign(report, { status: 'running', startedAt: new Date(started).toISOString(), projectId, errors })
  await stage('source')
  console.log(`START ${item.slug}`)
  try {
    const source = Bun.file(item.local ? await localPath(item.source) : assetPath(item.source))
    const bytes = await source.bytes()
    report.source = { path: item.source, bytes: bytes.length, sha256: sha256(bytes) }
    report.archivedStl = item.stl
      ? { path: item.stl, sha256: sha256(await Bun.file(item.local ? await localPath(item.stl) : assetPath(item.stl)).bytes()) }
      : { status: 'not-provided', reason: 'Source-only control; no archived STL comparison' }
    await Bun.write(file(`source${path.extname(item.source)}`), bytes)
    await stage('upload')
    if (!projectId) {
      const form = new FormData()
      form.set('file', new File([bytes], path.basename(item.source), { type: source.type }))
      const created = await requestJson(`${API}/projects`, file('upload.json'), { body: form, method: 'POST' })
      assert(typeof created.id === 'string' && created.id.length > 0, 'Upload did not return a project ID')
      projectId = created.id
    }
    report.projectId = projectId
    await Bun.write(file('project-id.txt'), `${projectId}\n`)
    await persist()
    await download(`${API}/projects/${projectId}/plan`, file('source-image'))
    let project = await requestJson(`${API}/projects/${projectId}`, file('project.json'))
    if (process.env.PROJECT_ID) {
      assert.equal(project.status, 'parsed', `Existing project is ${project.status}; PROJECT_ID only reuses parsed projects`)
    } else {
      await stage('parse')
      await requestJson(`${API}/projects/${projectId}/parse`, file('parse-start.json'), { method: 'POST' })
      project = await poll(`${API}/projects/${projectId}`, file('project.json'), item.slug, 35)
    }
    await captureModels()
    assert.equal(project.status, 'parsed', project.parseError ?? 'Parse failed')
    assert(report.finalModelVersion, 'No captured final floor model')

    await stage('tactile')
    await requestJson(`${API}/projects/${projectId}/tactile`, file('tactile-start.json'), { method: 'POST' })
    tactile = await poll(`${API}/projects/${projectId}/tactile`, file('tactile.json'), item.slug, 20)
    report.tactileValid = tactile.valid === true
    report.layoutPasses = tactile.iterations?.length ?? 0
    await save(file('tactile-iterations.json'), tactile.iterations ?? null)
    if (tactile.status === 'done') {
      await capture('tactile render', async () => {
        const renderer = Bun.spawn([process.execPath, 'scripts/render-design.ts', projectId!, file('board.png')], {
          cwd: path.join(ROOT, 'apps/api'), env: { ...process.env, API_URL: API }, stdout: 'pipe', stderr: 'pipe',
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          renderer.exited, new Response(renderer.stdout).text(), new Response(renderer.stderr).text(),
        ])
        await save(file('render.json'), { exitCode, stdout, stderr })
        assert.equal(exitCode, 0, `Board preview render failed: ${stderr}`)
      })
    }
    assert.equal(tactile.status, 'done', tactile.error ?? 'Tactile conversion failed')
    if (tactile.valid !== true) {
      await save(file('export-blocked.json'), { reason: 'Tactile output is invalid', violations: tactile.violations })
      throw new Error(`Tactile output is invalid: ${JSON.stringify(tactile.violations)}`)
    }

    await stage('export')
    const exported = await requestJson(`${API}/projects/${projectId}/export`, file('export.json'), { method: 'POST' })
    assert(Array.isArray(exported.files) && exported.files.some((entry: Json) => entry.kind === 'map'), 'Export did not return a map file')
    assert.equal(new Set(exported.files.map((entry: Json) => entry.kind)).size, exported.files.length, 'Duplicate export file kinds')
    report.grid = exported.grid
    const meshes: Json[] = []
    for (const metadata of exported.files as Json[]) {
      await capture(`export ${metadata.kind}`, async () => {
        const name = exportName(metadata.kind)
        const bytes = await download(`${API}/projects/${projectId}/export/${name}`, file(name))
        const inspected = inspectMesh(bytes)
        const result = { ...metadata, bytes: bytes.length, sha256: sha256(bytes), mesh: inspected.metrics }
        meshes.push(result)
        await save(file(`${metadata.kind}-mesh.json`), result)
        if (inspected.previewSvg) {
          await Bun.write(file(`${metadata.kind}-raised.svg`), inspected.previewSvg.replace('Archived STL raised faces', 'Generated STL raised faces'))
        }
        assert.equal(inspected.metrics.triangles, metadata.triangles, 'Downloaded triangle count differs from export metadata')
        assert.equal(inspected.metrics.issues.length, 0, inspected.metrics.issues.join('; '))
      })
    }
    report.exports = meshes
    report.meshIssues = meshes.flatMap((entry) => entry.mesh.issues.map((issue: string) => `${entry.kind}: ${issue}`))
  } catch (error) {
    errors.push(`${report.stage}: ${message(error)}`)
  } finally {
    if (projectId) {
      await capture('project snapshot', () => requestJson(`${API}/projects/${projectId}`, file('project.json')))
      if (!capturedModels) await capture('model snapshots', captureModels)
      if (!tactile && ['tactile', 'export'].includes(report.stage)) {
        await capture('tactile snapshot', async () => {
          tactile = await requestJson(`${API}/projects/${projectId}/tactile`, file('tactile.json'))
          await save(file('tactile-iterations.json'), tactile.iterations ?? null)
        })
      }
    }
    await capture('source preservation', async () => {
      assert.equal(sha256(await Bun.file(item.local ? await localPath(item.source) : assetPath(item.source)).bytes()), report.source?.sha256, 'Source changed during run')
      report.sourceUnchanged = true
      if (item.stl) {
        assert.equal(sha256(await Bun.file(item.local ? await localPath(item.stl) : assetPath(item.stl)).bytes()), report.archivedStl?.sha256, 'Archived STL changed during run')
        report.archivedAssetsUnchanged = true
      } else report.archivedAssetsUnchanged = null
    })
    Object.assign(report, { status: errors.length ? 'failed' : 'completed', finishedAt: new Date().toISOString(), durationSeconds: (Date.now() - started) / 1000 })
    await persist()
    console.log(`${report.status.toUpperCase()} ${item.slug}: ${report.durationSeconds}s${errors.length ? `; ${errors.join(' | ')}` : ''}`)
  }
}

async function main() {
  assert(process.env.OUTPUT_DIR, 'OUTPUT_DIR is required and must name a new run directory')
  const output = path.resolve(process.env.OUTPUT_DIR)
  const inventory = await loadInventory(process.env.CASES_FILE)
  const selected = selectCases(process.env.ONLY, process.env.PROJECT_ID, inventory.items)
  const limit = concurrency(process.env.CONCURRENCY, inventory.items.length)
  assert(output !== PUBLIC && !output.startsWith(`${PUBLIC}${path.sep}`), 'OUTPUT_DIR must be outside public assets')
  // Refuse all existing run directories, even with PROJECT_ID; explicit reuse still gets fresh evidence.
  await mkdir(path.dirname(output), { recursive: true })
  const parent = await realpath(path.dirname(output))
  assert(parent !== PUBLIC && !parent.startsWith(`${PUBLIC}${path.sep}`), 'OUTPUT_DIR must be outside public assets')
  await mkdir(output)
  const started = Date.now()
  const health = await requestJson(API, path.join(output, 'health.json'))
  assert(health.ok === true && health.models, 'API did not report a healthy model configuration')
  const code = await codeFingerprint()
  await save(path.join(output, 'run.json'), { startedAt: new Date(started).toISOString(), api: API,
    concurrency: limit, models: health.models, code, inventory: inventory.manifest?.path ?? 'apps/web/src/data/gallery.ts#galleryContent.entries',
    manifest: inventory.manifest,
    selected: selected.map((item) => item.slug), reusedProjectId: process.env.PROJECT_ID ?? null })
  const reports: Json[] = selected.map((item) => ({ slug: item.slug, title: item.title, status: 'queued' }))
  let writing = Promise.resolve<unknown>(undefined)
  function update() {
    const snapshot = JSON.stringify(reports, null, 2) + '\n'
    writing = writing.then(() => Bun.write(path.join(output, 'report.json'), snapshot))
    return writing
  }
  await update()
  const results = await bounded(selected, limit, (item) => runCase(item, path.join(output, item.slug), reports.find((row) => row.slug === item.slug)!, update))
  results.forEach((result, index) => {
    if (result.status === 'rejected') Object.assign(reports[index]!, { status: 'failed', errors: [message(result.reason)] })
  })
  await update()
  const summary = { completed: reports.filter((row) => row.status === 'completed').length,
    failed: reports.filter((row) => row.status === 'failed').length, total: reports.length,
    durationSeconds: (Date.now() - started) / 1000, output, finishedAt: new Date().toISOString() }
  await save(path.join(output, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed) process.exitCode = 1
}

if (import.meta.main) {
  if (process.argv[2] === '--self-check') {
    assert.equal(selectCases().length, 11)
    assert.throws(() => selectCases('missing'), /Unknown case slug/)
    assert.equal(selectCases('office-plan,test-public-restrooms').length, 2)
    assert.throws(() => selectCases('office-plan,missing'), /Unknown case slug/)
    assert.throws(() => selectCases('office-plan,office-plan'), /must be unique/)
    assert.throws(() => selectCases('office-plan,'), /Unknown case slug/)
    assert.throws(() => selectCases('office-plan,test-public-restrooms', 'project'), /requires exactly one/)
    assert.throws(() => selectCases(undefined, 'project'), /requires exactly one/)
    assert.equal(selectCases('office-plan', 'project').length, 1)
    for (const invalid of ['0', '1.5', 'NaN', '12']) assert.throws(() => concurrency(invalid), /CONCURRENCY/)
    assert.equal(concurrency(), 1)
    assert.throws(() => assetPath('/gallery/../secret'), /Unexpected gallery/)
    for (const invalid of ['../secret', '/tmp/source', 'test-assets/../source']) {
      assert.throws(() => assetPath(invalid, true), /repository-relative/)
    }
    const local = await loadInventory('pipeline_tests/detail-quality-cases.json')
    assert.equal(local.items.length, 6)
    assert.equal(local.manifest?.sha256.length, 64)
    assert.equal(selectCases('office-dime-building-1st,school-skyline-high', undefined, local.items).length, 2)
    assert.equal(local.items.filter((item) => !item.stl).length, 2)
    assert.throws(() => exportName('../map'), /Invalid export kind/)
    assert.equal(exportName('plate-2of4'), 'plate-2of4.stl')
    let active = 0
    let maximum = 0
    const results = await bounded([0, 1, 2, 3], 2, async (index) => {
      active++; maximum = Math.max(maximum, active)
      await Bun.sleep(1)
      active--
      if (index === 0) throw new Error('Expected case failure')
      return index
    })
    assert.equal(maximum, 2)
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
    const degenerate = new Uint8Array(134)
    new DataView(degenerate.buffer).setUint32(80, 1, true)
    assert(inspectMesh(degenerate).metrics.issues.length > 0, 'Export success must not hide invalid geometry')
    for (const item of selectCases()) {
      assert(await Bun.file(assetPath(item.source)).exists(), `Missing source: ${item.source}`)
      assert(item.stl && await Bun.file(assetPath(item.stl)).exists(), `Missing archived STL: ${item.stl}`)
    }
    console.log('Gallery/local manifests, selection, paths, bounded failure isolation, and mesh rejection self-check passed; no API calls made')
  } else {
    assert.equal(process.argv.length, 2, 'Usage: OUTPUT_DIR=<new directory> [CASES_FILE=<repo-relative manifest>] [CONCURRENCY=3] [ONLY=<slug,slug>] [PROJECT_ID=<parsed project>] bun pipeline_tests/regenerate-gallery.ts [--self-check]')
    await main()
  }
}
