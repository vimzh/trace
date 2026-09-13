// Replays saved parses through current tactile code without allowing model-provider calls.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { mock } from 'bun:test'
import { buildValidationContext, convertToTactile, floorModelSchema, validateTactileDesign } from '../packages/floor-model/src/index'
import { buildMapMesh, buildPlateMeshes, buildLegendMeshes, meshToBinaryStl } from '../apps/api/src/geometry/mesh'
import { inspectMesh } from './audit-gallery-baseline'

const ROOT = path.resolve(import.meta.dir, '..')
const OUTPUT = path.resolve(process.env.OUTPUT_DIR ?? path.join(ROOT, 'pipeline_tests/trace-readiness-20260913/offline-replay'))
await mkdir(OUTPUT)
mock.module('../apps/api/src/agents/llm', () => ({
  MODEL_LAYOUT: 'paid-calls-disabled',
  STRUCTURED_OUTPUT_INSTRUCTION: '',
  parseAgentOutput: () => { throw new Error('Paid calls disabled') },
  runAgentTurn: async () => { throw new Error('Paid calls disabled') },
}))
mock.module('../apps/api/src/agents/retry', () => ({ withModelRetry: async (fn: () => Promise<unknown>) => fn() }))
const { runTactileLayout } = await import('../apps/api/src/agents/tactile-layout')
const files = [
  ...await Array.fromAsync(new Bun.Glob('trace-readiness-20260913/regional-pilot/**/model.json').scan(path.join(ROOT, 'pipeline_tests'))),
  ...await Array.fromAsync(new Bun.Glob('trace-readiness-20260913/final-gallery/**/model.json').scan(path.join(ROOT, 'pipeline_tests'))),
]
if (files.length === 0) throw new Error('No saved parses found for offline replay')
const records: any[] = []
for (const relative of files) {
  const file = path.join(ROOT, 'pipeline_tests', relative)
  const saved = JSON.parse(await Bun.file(file).text())
  const model = floorModelSchema.parse(saved.model ?? saved)
  const { design } = convertToTactile(model)
  const context = buildValidationContext(model, design)
  const start = performance.now()
  try {
    const result = await runTactileLayout(design, context, model)
    const legendPreserved = design.legend.every(x => result.design.legend.some(y => y.text === x.text))
    const verified = validateTactileDesign(result.design, buildValidationContext(model, result.design))
    if (!result.valid || verified.length || !legendPreserved) throw new Error('Current layout failed independent validation or lost legend names')
    const directory = path.join(OUTPUT, path.basename(path.dirname(path.dirname(file))), path.basename(path.dirname(file)))
    await mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, 'design.json'), JSON.stringify(result.design, null, 2))
    const map = buildMapMesh(result.design)
    const meshes = [{ kind: 'map', manifold: map }]
    const exports: any[] = []
    try {
      meshes.push(...buildPlateMeshes(result.design, map).map(p => ({ kind: `plate-${p.row + 1}-${p.col + 1}`, manifold: p.manifold })))
      meshes.push(...buildLegendMeshes(result.design).map((manifold, index) => ({ kind: `legend-${index + 1}`, manifold })))
      for (const { kind, manifold } of meshes) {
        const bytes = meshToBinaryStl(manifold.getMesh())
        const metrics = inspectMesh(bytes).metrics
        await Bun.write(path.join(directory, `${kind}.stl`), bytes)
        exports.push({ kind, ...metrics })
        if (metrics.issues.length) throw new Error(`${kind}: ${metrics.issues.join('; ')}`)
      }
    } finally {
      meshes.forEach(item => item.manifold.delete())
      await Bun.write(path.join(directory, 'exports.json'), JSON.stringify(exports, null, 2))
    }
    records.push({ file: relative, durationMs: performance.now() - start, initialViolations: validateTactileDesign(design, context).length, finalViolations: verified.length, grid: result.design.grid, legendPreserved, status: 'valid', iterations: result.iterations, exports })
  } catch (error) {
    records.push({ file: relative, durationMs: performance.now() - start, status: 'requires-agent/failed', error: error instanceof Error ? error.message : String(error) })
  }
}
const report = { recordedAt: new Date().toISOString(), paidCalls: 'disabled', records }
await Bun.write(path.join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (records.some(record => record.status !== 'valid')) process.exitCode = 1
