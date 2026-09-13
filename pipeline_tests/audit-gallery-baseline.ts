// Audits the archived gallery source/STL pairs offline; never regenerates or modifies them.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { galleryContent } from '../apps/web/src/data/gallery'

const ROOT = path.resolve(import.meta.dir, '..')
const PUBLIC = path.join(ROOT, 'apps/web/public')
const OUTPUT = path.join(import.meta.dir, 'gallery-audit-20260912/baseline')
const BASE_MM = 3
// Resolve the existing dependency from the workspace that declares it.
const { imageSize } = createRequire(path.join(ROOT, 'apps/api/package.json'))('image-size')

type Point = [number, number, number]
type Edge = { count: number; orientation: number; triangle: number; collapsed: boolean }
type Asset = { path: string; bytes: number; sha256: string; unchangedAfterAudit?: boolean }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function binaryTriangleCount(bytes: Uint8Array) {
  // Kept local: run-corpus.ts's equivalent helper imports the inference configuration.
  if (bytes.byteLength < 84) throw new Error('STL is shorter than its binary header')
  const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
  if (triangles === 0) throw new Error('STL contains no triangles')
  if (bytes.byteLength !== 84 + 50 * triangles) {
    throw new Error(`STL byte length does not match ${triangles} triangles`)
  }
  return triangles
}

export function inspectMesh(bytes: Uint8Array) {
  const triangles = binaryTriangleCount(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const edges = new Map<string, Edge>()
  const parents = new Int32Array(triangles).fill(-1)
  const volumes = new Float64Array(triangles)
  const min: Point = [Infinity, Infinity, Infinity]
  const max: Point = [-Infinity, -Infinity, -Infinity]
  const zeroAreaSample: number[] = []
  const nonFiniteSample: number[] = []
  const silhouettes: string[] = []
  let zeroAreaTriangles = 0
  let nonFiniteTriangles = 0
  let nonFiniteCoordinates = 0
  let nonFiniteNormalValues = 0
  let signedVolumeMm3 = 0
  let raisedTopFaceTriangles = 0

  function root(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!
      index = parents[index]!
    }
    return index
  }

  for (let t = 0; t < triangles; t++) {
    const offset = 84 + t * 50
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(view.getFloat32(offset + axis * 4, true))) nonFiniteNormalValues++
    }
    const points = [0, 1, 2].map((vertex) => [0, 1, 2].map((axis) =>
      view.getFloat32(offset + 12 + vertex * 12 + axis * 4, true),
    ) as Point) as [Point, Point, Point]
    const invalid = points.flat().filter((value) => !Number.isFinite(value)).length
    if (invalid) {
      nonFiniteCoordinates += invalid
      nonFiniteTriangles++
      if (nonFiniteSample.length < 5) nonFiniteSample.push(t)
      continue
    }
    parents[t] = t
    for (const point of points) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, point[axis]!)
        max[axis] = Math.max(max[axis]!, point[axis]!)
      }
    }
    const [a, b, c] = points
    const u = b.map((value, axis) => value - a[axis]!)
    const v = c.map((value, axis) => value - a[axis]!)
    const cross: Point = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ]
    if (Math.hypot(...cross) === 0) {
      zeroAreaTriangles++
      if (zeroAreaSample.length < 5) zeroAreaSample.push(t)
    }
    const volume = (a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]) / 6
    volumes[t] = volume
    signedVolumeMm3 += volume

    // Exact float32 vertices, matching the existing export regression check.
    const keys = points.map((point) => point.join(','))
    for (let i = 0; i < 3; i++) {
      const from = keys[i]!
      const to = keys[(i + 1) % 3]!
      const key = from < to ? `${from}|${to}` : `${to}|${from}`
      const edge = edges.get(key)
      if (edge) {
        edge.count++
        edge.orientation += from < to ? 1 : from > to ? -1 : 0
        // A shared vertex alone, including a collapsed edge, does not join shells.
        if (!edge.collapsed) parents[root(t)] = root(edge.triangle)
      } else {
        edges.set(key, {
          count: 1, orientation: from < to ? 1 : from > to ? -1 : 0,
          triangle: t, collapsed: from === to,
        })
      }
    }
    if (cross[2] > 0 && points.every((point) => point[2] >= BASE_MM)
      && points.some((point) => point[2] > BASE_MM)) {
      raisedTopFaceTriangles++
      silhouettes.push(`M${a[0]},${a[1]}L${b[0]},${b[1]}L${c[0]},${c[1]}Z`)
    }
  }

  let boundaryEdges = 0
  let overIncidentEdges = 0
  let sameDirectionPairedEdges = 0
  let orientedPairedEdges = 0
  let collapsedEdges = 0
  const badEdgeSample: { vertices: string; incidence: number; orientationSum: number }[] = []
  for (const [key, edge] of edges) {
    if (edge.count === 1) boundaryEdges++
    if (edge.count > 2) overIncidentEdges++
    if (edge.count === 2 && edge.orientation !== 0) sameDirectionPairedEdges++
    if (edge.collapsed) collapsedEdges++
    if (edge.count === 2 && edge.orientation === 0 && !edge.collapsed) orientedPairedEdges++
    else if (badEdgeSample.length < 5) {
      badEdgeSample.push({ vertices: key, incidence: edge.count, orientationSum: edge.orientation })
    }
  }
  const components = new Map<number, { triangles: number; signedVolumeMm3: number }>()
  for (let t = 0; t < triangles; t++) {
    if (parents[t] === -1) continue
    const id = root(t)
    const component = components.get(id) ?? { triangles: 0, signedVolumeMm3: 0 }
    component.triangles++
    component.signedVolumeMm3 += volumes[t]!
    components.set(id, component)
  }
  const issues: string[] = []
  if (nonFiniteTriangles) issues.push(`${nonFiniteTriangles} triangles contain non-finite coordinates`)
  if (nonFiniteNormalValues) issues.push(`${nonFiniteNormalValues} non-finite stored normal values`)
  if (zeroAreaTriangles) issues.push(`${zeroAreaTriangles} zero-area triangles`)
  const unpairedEdges = edges.size - orientedPairedEdges
  if (unpairedEdges) issues.push(`${unpairedEdges} edges are not noncollapsed, oppositely oriented pairs`)
  if (components.size !== 1) issues.push(`${components.size} components connected by shared nonzero edges`)
  if (!(signedVolumeMm3 > 0)) issues.push('Signed volume is not positive')
  const bounds = nonFiniteTriangles === triangles ? null : {
    min, max, size: max.map((value, axis) => value - min[axis]!),
  }
  const previewSvg = bounds && nonFiniteTriangles === 0
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${min[0]} ${min[1]} ${max[0] - min[0]} ${max[1] - min[1]}"><title>Archived STL raised faces above ${BASE_MM} mm; black silhouette, not a tactile quality score</title><rect x="${min[0]}" y="${min[1]}" width="${max[0] - min[0]}" height="${max[1] - min[1]}" fill="white"/><path transform="translate(0 ${min[1] + max[1]}) scale(1 -1)" fill="#111" d="${silhouettes.join('')}"/></svg>\n`
    : null
  return {
    metrics: {
      triangles, expectedBytes: 84 + 50 * triangles, lengthValid: true,
      finiteCoordinates: nonFiniteTriangles === 0, nonFiniteCoordinates,
      nonFiniteTriangles, nonFiniteTriangleSample: nonFiniteSample, nonFiniteNormalValues,
      boundsMm: bounds, zeroAreaTriangles, zeroAreaTriangleSample: zeroAreaSample,
      edgeIncidence: {
        uniqueEdges: edges.size, orientedPairedEdges, unpairedEdges, boundaryEdges,
        overIncidentEdges, sameDirectionPairedEdges, collapsedEdges, badEdgeSample,
      },
      connectedComponents: components.size,
      components: [...components.values()].sort((a, b) => b.triangles - a.triangles),
      signedVolumeMm3: nonFiniteTriangles ? null : signedVolumeMm3,
      raisedTopFaceTriangles, issues,
    },
    previewSvg,
  }
}

async function audit() {
  const entries = galleryContent.entries
  assert.equal(entries.length, 11, 'Expected the complete 11-entry gallery inventory')
  assert.equal(new Set(entries.map((item) => item.slug)).size, 11, 'Gallery slugs must be unique')
  await mkdir(OUTPUT, { recursive: true })
  const cases = []
  for (const item of entries) {
    const errors: string[] = []
    const assets: Asset[] = []
    async function readAsset(url: string) {
      assert(url.startsWith('/gallery/') && !url.includes('..'), `Unexpected gallery asset path: ${url}`)
      const absolute = path.join(PUBLIC, url)
      const bytes = await Bun.file(absolute).bytes()
      const metadata = { path: path.relative(ROOT, absolute), bytes: bytes.length, sha256: sha256(bytes) }
      assets.push(metadata)
      return { bytes, metadata }
    }
    let source = null
    let modelSvg = null
    let stl = null
    let mesh = null
    let raisedPreview = null
    try {
      const asset = await readAsset(item.source)
      source = { ...asset.metadata, dimensions: null as { width: number; height: number; type: string } | null }
      const { width, height, type } = imageSize(asset.bytes)
      assert(width > 0 && height > 0, 'Source image dimensions must be positive')
      source.dimensions = { width, height, type }
    } catch (error) {
      errors.push(`source: ${message(error)}`)
    }
    try {
      const url = item.stl.endsWith('-map.stl')
        ? item.stl.replace(/-map\.stl$/, '-design.svg')
        : item.stl.replace(/\.stl$/, '-design.svg')
      modelSvg = (await readAsset(url)).metadata
    } catch (error) {
      errors.push(`modelSvg: ${message(error)}`)
    }
    try {
      const asset = await readAsset(item.stl)
      const declaredTriangles = asset.bytes.length >= 84
        ? new DataView(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength).getUint32(80, true)
        : null
      stl = {
        ...asset.metadata, declaredTriangles,
        lengthValid: declaredTriangles !== null && asset.bytes.length === 84 + 50 * declaredTriangles,
      }
      const inspected = inspectMesh(asset.bytes)
      mesh = inspected.metrics
      if (inspected.previewSvg) {
        raisedPreview = `${item.slug}-raised.svg`
        await Bun.write(path.join(OUTPUT, raisedPreview), inspected.previewSvg)
      }
    } catch (error) {
      errors.push(`stl: ${message(error)}`)
    }
    // Re-read every successfully opened original after inspection to verify preservation.
    for (const asset of assets) {
      try {
        asset.unchangedAfterAudit = sha256(await Bun.file(path.join(ROOT, asset.path)).bytes()) === asset.sha256
        if (!asset.unchangedAfterAudit) errors.push(`Original asset changed during audit: ${asset.path}`)
      } catch (error) {
        asset.unchangedAfterAudit = false
        errors.push(`preservation: ${asset.path}: ${message(error)}`)
      }
    }
    const result = { ...item, source, modelSvg, stl, mesh, raisedPreview, assetPreservation: assets, errors }
    cases.push(result)
    await Bun.write(path.join(OUTPUT, `${item.slug}.json`), JSON.stringify(result, null, 2) + '\n')
    console.log(`${item.slug}: ${mesh?.triangles ?? 'unreadable'} triangles; ${mesh?.zeroAreaTriangles ?? '?'} zero-area; ${mesh?.edgeIncidence.unpairedEdges ?? '?'} unpaired edges; ${mesh?.connectedComponents ?? '?'} components; ${errors.length} read/audit errors`)
  }
  const report = {
    createdAt: new Date().toISOString(), inventory: 'apps/web/src/data/gallery.ts#galleryContent.entries',
    offline: true, expectedCases: 11, auditedCases: cases.length,
    method: {
      vertexMatching: 'Exact stored float32 coordinates; no welding or tolerance rounding',
      zeroArea: 'Cross-product norm equals zero; stored STL normals are not trusted',
      components: 'Triangles joined only by identical nonzero shared edges; non-finite triangles excluded',
      volume: 'Signed tetrahedron sum in mm^3, not a physical volume guarantee for defective meshes',
      preview: 'Upward-facing triangle silhouettes entirely at/above 3 mm with at least one vertex above 3 mm; world Y flipped for source-plan orientation',
      limitations: 'No self-intersection test, independent slicer import, semantic/source fidelity score, or physical tactile assessment; passing these checks does not establish print safety',
    },
    summary: {
      inputErrorCases: cases.filter((item) => item.errors.length).length,
      meshIssueCases: cases.filter((item) => item.mesh?.issues.length).length,
      structurallyCleanCases: cases.filter((item) => !item.errors.length && item.mesh?.issues.length === 0).length,
      preservedAssets: cases.flatMap((item) => item.assetPreservation).filter((item) => item.unchangedAfterAudit).length,
    },
    cases,
  }
  await Bun.write(path.join(OUTPUT, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary))
  if (report.summary.inputErrorCases || report.summary.meshIssueCases) process.exitCode = 1
}

if (import.meta.main) {
  if (process.argv[2] === '--self-check') {
    const bytes = new Uint8Array(134)
    new DataView(bytes.buffer).setUint32(80, 1, true)
    assert.equal(binaryTriangleCount(bytes), 1)
    assert.throws(() => binaryTriangleCount(bytes.subarray(0, 83)), /binary header/)
    assert.throws(() => binaryTriangleCount(bytes.subarray(0, 133)), /byte length/)
    assert.throws(() => binaryTriangleCount(new Uint8Array(84)), /no triangles/)
    assert.equal(inspectMesh(bytes).metrics.zeroAreaTriangles, 1)
    assert.equal(inspectMesh(bytes).metrics.edgeIncidence.collapsedEdges, 1)
    console.log('Gallery STL malformed/truncated/degenerate self-check passed')
  } else {
    assert.equal(process.argv.length, 2, 'Usage: bun pipeline_tests/audit-gallery-baseline.ts [--self-check]')
    await audit()
  }
}
