// Resumable 30-case real-map study: prepare licensed-at-source assets, then
// run upload -> parse -> tactile -> render -> optional STL export/comparison.
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { imageSize } from 'image-size'
import * as mupdf from 'mupdf'
import { modelConfiguration } from '../src/agents/llm'
import { downscalePlanImage, MAX_PLAN_PX, pdfPageToPng } from '../src/lib/rasterize'

type NormalizedCrop = { left: number; top: number; width: number; height: number }

type CorpusCase = {
  slug: string
  venue: string
  type: string
  planUrl?: string
  planPath?: string
  tactileImageUrl?: string
  tactileImagePath?: string
  evidenceUrl: string
  planPage: number
  planCrop?: NormalizedCrop
  scope: string
}

const ROOT = path.resolve(import.meta.dir, '../../..')
const { positionals, values: options } = parseArgs({
  args: import.meta.main ? process.argv.slice(2) : [],
  allowPositionals: true,
  options: {
    export: { type: 'boolean', default: false },
    manifest: { type: 'string' },
    'skip-compare': { type: 'boolean', default: false },
  },
})
const MANIFEST = options.manifest
  ? path.resolve(options.manifest)
  : path.join(ROOT, 'pipeline_tests/corpus-v2.json')
const CACHE = path.join(ROOT, 'pipeline_tests/corpus-cache')
const PREPARATION_VERSION = 4
const API = process.env.API_URL ?? 'http://localhost:3003'
const [command = 'validate', selectedSlug] = positionals

const manifest = (await Bun.file(MANIFEST).json()) as {
  version: number
  cases: CorpusCase[]
}

function validateManifest() {
  if (manifest.version !== 2) throw new Error('Expected corpus version 2')
  if (manifest.cases.length === 0) throw new Error('Expected at least one corpus case')
  if (!options.manifest && manifest.cases.length !== 30) {
    throw new Error(`Expected 30 corpus cases, found ${manifest.cases.length}`)
  }
  const slugs = new Set<string>()
  for (const item of manifest.cases) {
    if (slugs.has(item.slug)) throw new Error(`Duplicate slug: ${item.slug}`)
    slugs.add(item.slug)
    if (!(item.planUrl || item.planPath)) throw new Error(`${item.slug}: plan missing`)
    if (!(item.tactileImageUrl || item.tactileImagePath)) {
      throw new Error(`${item.slug}: real tactile-map image missing`)
    }
    if (item.planPage === 0 || item.planPage < -1) {
      throw new Error(`${item.slug}: invalid planPage ${item.planPage}`)
    }
    if (
      item.planCrop &&
      (item.planCrop.left < 0 ||
        item.planCrop.top < 0 ||
        item.planCrop.width <= 0 ||
        item.planCrop.height <= 0 ||
        item.planCrop.left + item.planCrop.width > 1 ||
        item.planCrop.top + item.planCrop.height > 1)
    ) {
      throw new Error(`${item.slug}: invalid normalized planCrop`)
    }
  }
}

validateManifest()
const cases = selectedSlug
  ? manifest.cases.filter((item) => item.slug === selectedSlug)
  : manifest.cases
if (selectedSlug && cases.length === 0) throw new Error(`Unknown case: ${selectedSlug}`)

function imageType(bytes: Uint8Array) {
  const type = imageSize(bytes).type
  if (type === 'jpg' || type === 'jpeg') return { extension: 'jpg', mime: 'image/jpeg' }
  if (type === 'png' || type === 'webp') return { extension: type, mime: `image/${type}` }
  throw new Error(`Unsupported image type: ${type ?? 'unknown'}`)
}

function isPdf(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
}

async function sourceBytes(localPath: string | undefined, url: string | undefined) {
  if (localPath) return Bun.file(path.join(ROOT, localPath)).bytes()
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url!, {
      headers: {
        accept: 'image/jpeg,image/png,application/pdf',
        'user-agent': 'TacticleMapEvaluation/1.0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`${response.status} ${url}`)
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Math.min(
      30_000,
      Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 2_000,
    )
    console.warn(`rate limited; retrying ${url} in ${waitMs / 1_000}s`)
    await Bun.sleep(waitMs)
  }
  throw new Error(`Could not fetch ${url}`)
}

function cropImage(bytes: Uint8Array, mime: string, crop: NormalizedCrop) {
  const doc = mupdf.Document.openDocument(bytes, mime)
  try {
    const page = doc.loadPage(0)
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(1, 1),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    try {
      const left = Math.round(pixmap.getWidth() * crop.left)
      const top = Math.round(pixmap.getHeight() * crop.top)
      const width = Math.round(pixmap.getWidth() * crop.width)
      const height = Math.round(pixmap.getHeight() * crop.height)
      const cropped = pixmap.warp(
        [
          [left, top],
          [left + width, top],
          [left + width, top + height],
          [left, top + height],
        ],
        width,
        height,
      )
      try {
        return cropped.asPNG()
      } finally {
        cropped.destroy()
      }
    } finally {
      pixmap.destroy()
      page.destroy()
    }
  } finally {
    doc.destroy()
  }
}

async function preparedImage(
  bytes: Uint8Array,
  stem: string,
  crop?: NormalizedCrop,
) {
  const type = imageType(bytes)
  const cropped = crop ? cropImage(bytes, type.mime, crop) : bytes
  const preparedType = crop ? { extension: 'png', mime: 'image/png' } : type
  const capped = downscalePlanImage(cropped, preparedType.mime)
  const prepared = capped ?? cropped
  const output = `${stem}.${capped || crop ? 'png' : type.extension}`
  await Bun.write(output, prepared)
  return output
}

async function prepareCase(item: CorpusCase) {
  const directory = path.join(CACHE, item.slug)
  const metadataPath = path.join(directory, 'case.json')
  if (await Bun.file(metadataPath).exists()) {
    const previous = (await Bun.file(metadataPath).json()) as CorpusCase & {
      preparationVersion?: number
    }
    const inputs = [
      'slug',
      'venue',
      'type',
      'planUrl',
      'planPath',
      'tactileImageUrl',
      'tactileImagePath',
      'evidenceUrl',
      'planPage',
      'planCrop',
      'scope',
    ] as const
    if (
      previous.preparationVersion === PREPARATION_VERSION &&
      inputs.every(
        (key) => JSON.stringify(previous[key]) === JSON.stringify(item[key]),
      )
    ) {
      console.log(`resume ${item.slug}: assets already prepared`)
      return
    }
  }
  await mkdir(directory, { recursive: true })
  const planBytes = await sourceBytes(item.planPath, item.planUrl)
  const planIsPdf = isPdf(planBytes)
  const planFile = await preparedImage(
    planIsPdf
      ? pdfPageToPng(planBytes, item.planPage, item.planCrop)
      : planBytes,
    path.join(directory, 'plan'),
    planIsPdf ? undefined : item.planCrop,
  )
  const realBytes = await sourceBytes(item.tactileImagePath, item.tactileImageUrl)
  const realFile = await preparedImage(realBytes, path.join(directory, 'real'))
  await Bun.write(
    metadataPath,
    JSON.stringify({ ...item, planFile, realFile, preparationVersion: PREPARATION_VERSION }, null, 2),
  )
  console.log(`prepared ${item.slug}`)
}

async function checkedJson(response: Response) {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || !body) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`)
  }
  return body
}

export function inspectBinaryStl(bytes: Uint8Array) {
  if (bytes.byteLength < 84) throw new Error('STL is shorter than its binary header')
  const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(80, true)
  if (triangles === 0) throw new Error('STL contains no triangles')
  if (bytes.byteLength !== 84 + 50 * triangles) {
    throw new Error(`STL byte length does not match ${triangles} triangles`)
  }
  return { bytes: bytes.byteLength, triangles }
}

async function verifyExport(projectId: string, directory: string) {
  const generated = await fetch(`${API}/projects/${projectId}/export`, { method: 'POST' })
  const metadata = await checkedJson(generated)
  if (generated.status !== 201) throw new Error(`Export returned ${generated.status}, expected 201`)
  await Bun.write(path.join(directory, 'export.json'), JSON.stringify(metadata, null, 2))
  const downloaded = await fetch(`${API}/projects/${projectId}/export/map.stl`)
  if (downloaded.status !== 200) {
    throw new Error(`STL download returned ${downloaded.status}: ${await downloaded.text()}`)
  }
  const bytes = new Uint8Array(await downloaded.arrayBuffer())
  const checked = inspectBinaryStl(bytes)
  const files = metadata.files as { kind: string; triangles: number }[] | undefined
  if (files?.find((file) => file.kind === 'map')?.triangles !== checked.triangles) {
    throw new Error('STL triangle count does not match export metadata')
  }
  const file = path.join(directory, 'map.stl')
  await Bun.write(file, bytes)
  return { ...checked, file, exportStatus: generated.status, downloadStatus: downloaded.status }
}

async function pollProject(id: string) {
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    const project = await checkedJson(await fetch(`${API}/projects/${id}`))
    if (project.status === 'parsed') return project
    if (project.status === 'failed') throw new Error(String(project.parseError ?? 'parse failed'))
    await Bun.sleep(5_000)
  }
  throw new Error('parse timed out after 20 minutes')
}

async function pollTactile(id: string) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const result = await checkedJson(await fetch(`${API}/projects/${id}/tactile`))
    if (result.status === 'done') return result
    if (result.status === 'failed') throw new Error(String(result.error ?? 'tactile failed'))
    await Bun.sleep(3_000)
  }
  throw new Error('tactile conversion timed out after 10 minutes')
}

async function runProcess(args: string[], cwd: string) {
  const process = Bun.spawn(args, {
    cwd,
    env: { ...Bun.env, API_URL: API },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`${args.join(' ')} exited ${exitCode}`)
}

type ModelConfiguration = {
  compare: string
  critique: string
  layout: string
  parse: string
  providerByStage: Record<'compare' | 'critique' | 'layout' | 'parse' | 'refine', string>
  refine: string
}

async function runFingerprint(
  prepared: CorpusCase & { planFile: string; realFile: string },
  models: ModelConfiguration,
) {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(JSON.stringify(models))
  hasher.update(JSON.stringify(prepared))
  hasher.update(await Bun.file(prepared.planFile).bytes())
  hasher.update(await Bun.file(prepared.realFile).bytes())
  const files: string[] = []
  for (const directory of [
    'apps/api/src',
    'apps/api/scripts',
    'packages/floor-model/src',
  ]) {
    const glob = new Bun.Glob('**/*.ts')
    for await (const file of glob.scan(path.join(ROOT, directory))) {
      files.push(path.join(directory, file))
    }
  }
  files.push('apps/api/package.json', 'packages/floor-model/package.json', 'bun.lock')
  for (const file of files.sort()) {
    hasher.update(file)
    hasher.update(await Bun.file(path.join(ROOT, file)).bytes())
  }
  return hasher.digest('hex')
}

async function pipelineModelConfiguration(): Promise<ModelConfiguration> {
  const response = await checkedJson(await fetch(API))
  const server = response.models as ReturnType<typeof modelConfiguration> | undefined
  if (!server) throw new Error('API did not report its model configuration')
  const local = modelConfiguration()
  return {
    compare: local.compare,
    critique: server.critical,
    layout: server.layout,
    parse: server.critical,
    providerByStage: {
      compare: local.provider,
      critique: server.provider,
      layout: server.provider,
      parse: server.provider,
      refine: server.provider,
    },
    refine: server.critical,
  }
}

async function runCase(item: CorpusCase) {
  const directory = path.join(CACHE, item.slug)
  const resultPath = path.join(directory, 'result.json')
  const prepared = (await Bun.file(path.join(directory, 'case.json')).json()) as CorpusCase & {
    planFile: string
    realFile: string
  }
  const models = await pipelineModelConfiguration()
  const fingerprint = await runFingerprint(prepared, models)
  if (await Bun.file(resultPath).exists()) {
    const previous = (await Bun.file(resultPath).json()) as {
      comparison?: unknown
      comparisonStatus?: string
      error?: string
      export?: unknown
      fingerprint?: string
    }
    if (
      !previous.error &&
      (previous.comparison || (options['skip-compare'] && previous.comparisonStatus === 'skipped')) &&
      previous.fingerprint === fingerprint &&
      (!options.export || previous.export)
    ) {
      console.log(`resume ${item.slug}: completed result already exists`)
      return true
    }
  }
  await Promise.all(
    [
      'comparison.json',
      'export.json',
      'map.stl',
      'model-history.json',
      'ours.png',
      'project.json',
      'result.json',
      'source-image',
      'tactile.json',
    ].map((file) => rm(path.join(directory, file), { force: true })),
  )
  let projectId: string | undefined
  let exported: Awaited<ReturnType<typeof verifyExport>> | undefined
  try {
    const planBytes = await Bun.file(prepared.planFile).bytes()
    const plan = imageType(planBytes)
    const form = new FormData()
    form.set(
      'file',
      new File([planBytes], path.basename(prepared.planFile), { type: plan.mime }),
    )
    const created = await checkedJson(
      await fetch(`${API}/projects`, { body: form, method: 'POST' }),
    )
    projectId = String(created.id)
    await checkedJson(
      await fetch(`${API}/projects/${projectId}/parse`, { method: 'POST' }),
    )
    const project = await pollProject(projectId)
    await Bun.write(
      path.join(directory, 'project.json'),
      JSON.stringify(project, null, 2),
    )
    const versionIndex = await checkedJson(
      await fetch(`${API}/projects/${projectId}/model/versions`),
    )
    const versions = Array.isArray(versionIndex.versions) ? versionIndex.versions : []
    const modelHistory = []
    for (const entry of versions) {
      const version = Number((entry as { version?: unknown }).version)
      if (Number.isInteger(version)) {
        modelHistory.push(
          await checkedJson(
            await fetch(`${API}/projects/${projectId}/model?version=${version}`),
          ),
        )
      }
    }
    await Bun.write(
      path.join(directory, 'model-history.json'),
      JSON.stringify(modelHistory, null, 2),
    )
    await Bun.write(
      path.join(directory, 'source-image'),
      await (await fetch(`${API}/projects/${projectId}/plan`)).arrayBuffer(),
    )
    await checkedJson(
      await fetch(`${API}/projects/${projectId}/tactile`, { method: 'POST' }),
    )
    let tactile: Record<string, unknown>
    try {
      tactile = await pollTactile(projectId)
    } catch (error) {
      const snapshot = await fetch(`${API}/projects/${projectId}/tactile`)
      if (snapshot.ok) {
        await Bun.write(path.join(directory, 'tactile.json'), await snapshot.text())
      }
      throw error
    }
    await Bun.write(
      path.join(directory, 'tactile.json'),
      JSON.stringify(tactile, null, 2),
    )
    const oursFile = path.join(directory, 'ours.png')
    await runProcess(
      [process.execPath, 'scripts/render-design.ts', projectId, oursFile],
      path.join(ROOT, 'apps/api'),
    )
    if (options.export) {
      if (tactile.valid !== true) throw new Error('Tactile design is invalid; STL export is blocked')
      exported = await verifyExport(projectId, directory)
    }
    let comparison: unknown = null
    if (!options['skip-compare']) {
      const comparisonFile = path.join(directory, 'comparison.json')
      await runProcess(
        [
          process.execPath,
          'scripts/compare-maps.ts',
          path.join(directory, 'source-image'),
          oursFile,
          prepared.realFile,
          prepared.venue,
          comparisonFile,
        ],
        path.join(ROOT, 'apps/api'),
      )
      comparison = await Bun.file(comparisonFile).json()
    }
    await Bun.write(
      resultPath,
      JSON.stringify(
        {
          comparison,
          comparisonStatus: options['skip-compare'] ? 'skipped' : 'complete',
          export: exported,
          fingerprint,
          models,
          projectId,
          tactileValid: tactile.valid,
        },
        null,
        2,
      ),
    )
    console.log(`complete ${item.slug}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (projectId) {
      try {
        const project = await checkedJson(await fetch(`${API}/projects/${projectId}`))
        await Bun.write(path.join(directory, 'project.json'), JSON.stringify(project, null, 2))
        const versions = await checkedJson(await fetch(`${API}/projects/${projectId}/model/versions`))
        const history = []
        for (const entry of (versions.versions ?? []) as { version: number }[]) {
          history.push(await checkedJson(await fetch(`${API}/projects/${projectId}/model?version=${entry.version}`)))
        }
        await Bun.write(path.join(directory, 'model-history.json'), JSON.stringify(history, null, 2))
      } catch (snapshotError) {
        console.error(`failed to capture ${item.slug} diagnostics:`, snapshotError)
      }
    }
    await Bun.write(
      resultPath,
      JSON.stringify(
        {
          comparisonStatus: options['skip-compare'] ? 'skipped' : 'incomplete',
          error: message, export: exported, fingerprint, models, projectId,
        },
        null,
        2,
      ),
    )
    console.error(`failed ${item.slug}: ${message}`)
    return false
  }
}

if (import.meta.main && command === 'validate') {
  let prepared = 0
  for (const item of manifest.cases) {
    const metadata = Bun.file(path.join(CACHE, item.slug, 'case.json'))
    if (!(await metadata.exists())) continue
    const { planFile, preparationVersion, realFile } = (await metadata.json()) as {
      planFile: string
      preparationVersion?: number
      realFile: string
    }
    if (preparationVersion !== PREPARATION_VERSION) {
      throw new Error(`${item.slug}: prepared assets are stale; run prepare`)
    }
    for (const file of [planFile, realFile]) {
      const { height, width } = imageSize(await Bun.file(file).bytes())
      if (!height || !width || Math.max(height, width) > MAX_PLAN_PX) {
        throw new Error(`${item.slug}: invalid prepared image ${file}`)
      }
    }
    prepared++
  }
  console.log(
    `corpus v${manifest.version}: ${manifest.cases.length} unique pairs; ${prepared}/${manifest.cases.length} prepared`,
  )
} else if (import.meta.main && command === 'prepare') {
  for (const item of cases) await prepareCase(item)
} else if (import.meta.main && command === 'run') {
  let failures = 0
  for (const item of cases) {
    await prepareCase(item)
    if (!(await runCase(item))) failures += 1
  }
  if (failures > 0) {
    throw new Error(`${failures}/${cases.length} corpus cases failed`)
  }
} else if (import.meta.main) {
  throw new Error('usage: bun scripts/run-corpus.ts validate|prepare|run [slug] [--manifest path] [--export] [--skip-compare]')
}
