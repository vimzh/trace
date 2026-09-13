// Isolated live layout evaluation of the saved dense-school parse; uses its own spend ledger.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { buildValidationContext, convertToTactile, floorModelSchema, validateTactileDesign } from '../packages/floor-model/src'
import { runTactileLayout } from '../apps/api/src/agents/tactile-layout'
import { MODEL_LAYOUT } from '../apps/api/src/agents/llm'

const root = path.resolve(import.meta.dir, '..')
const output = path.resolve(process.env.OUTPUT_DIR ?? path.join(root, 'pipeline_tests/trace-readiness-20260913/skyline-layout'))
await mkdir(output)
const input = path.join(root, 'pipeline_tests/gallery-audit-20260913-detail/decision-context-candidate/school-skyline-high/model.json')
const bytes = await Bun.file(input).bytes()
const model = floorModelSchema.parse(JSON.parse(new TextDecoder().decode(bytes)).model)
const { design } = convertToTactile(model)
const context = buildValidationContext(model, design)
const initialViolations = validateTactileDesign(design, context)
const start = performance.now()
try {
  const result = await runTactileLayout(design, context, model)
  const finalViolations = validateTactileDesign(result.design, buildValidationContext(model, result.design))
  const report = { input, inputSha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), model: MODEL_LAYOUT,
    durationMs: performance.now() - start, initialViolations: initialViolations.length,
    legendPreserved: design.legend.every(entry => result.design.legend.some(after => after.text === entry.text)),
    ...result, violations: finalViolations }
  await Bun.write(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ valid: result.valid, remaining: finalViolations.length, durationMs: report.durationMs,
    legendPreserved: report.legendPreserved, iterations: result.iterations }))
  if (!result.valid || finalViolations.length > 0 || !report.legendPreserved) process.exitCode = 1
} catch (error) {
  await Bun.write(path.join(output, 'failure.json'), JSON.stringify({ input, model: MODEL_LAYOUT,
    durationMs: performance.now() - start, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n')
  throw error
}
