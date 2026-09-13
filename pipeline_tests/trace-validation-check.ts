// Offline equivalence/performance comparison of the archived validator and current validator.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const PROFILE = JSON.parse(await Bun.file(path.join(ROOT, 'pipeline_tests/gallery-audit-20260913-detail/mechanical-repair-profile.json')).text())
const OUT = path.join(ROOT, 'pipeline_tests/trace-readiness-20260913/validation')
await mkdir(OUT, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), 'bumps-validate-baseline-'))
const untar = Bun.spawn(['tar', '-xzf', path.join(ROOT, 'pipeline_tests/trace-readiness-20260913/source/pipeline-source.tar.gz'), '-C', temp])
assert.equal(await untar.exited, 0, 'Could not extract baseline source')
await symlink(path.join(ROOT, 'packages/floor-model/node_modules'), path.join(temp, 'node_modules'))

const current = await import(path.join(ROOT, 'packages/floor-model/src/index.ts'))
const baseline = await import(path.join(temp, 'packages/floor-model/src/index.ts'))
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const canonical = (value: unknown) => JSON.stringify(value)
const unwrap = (value: any) => value.model ?? value
const modelPaths = PROFILE.cachedAcceptedModels.map((item: any) => item.sourceModelPath as string)
const skylinePath = path.join(ROOT, PROFILE.school.modelPath)
const report: any = { baselineTemp: temp, inputs: [], randomized: [], status: 'running' }

function build(api: any, raw: any) {
  const model = api.floorModelSchema.parse(raw)
  const { design } = api.convertToTactile(model)
  return { context: api.buildValidationContext(model, design), design }
}
function compare(apiA: any, apiB: any, raw: any) {
  const a = build(apiA, raw)
  const va = apiA.validateTactileDesign(a.design, a.context)
  const vb = apiB.validateTactileDesign(a.design, a.context)
  return { equal: canonical(va) === canonical(vb), violations: va }
}
function compareDesign(apiA: any, apiB: any, design: any, context: any) {
  const va = apiA.validateTactileDesign(structuredClone(design), structuredClone(context))
  const vb = apiB.validateTactileDesign(structuredClone(design), structuredClone(context))
  return { equal: canonical(va) === canonical(vb), violations: va }
}
function timings(api: any, raw: any) {
  const input = build(baseline, raw); const samples: number[] = []
  for (let i = 0; i < 7; i++) { const start = performance.now(); api.validateTactileDesign(input.design, input.context); samples.push(performance.now() - start) }
  return { medianMs: median(samples), samplesMs: samples }
}

try {
  for (const item of modelPaths) {
    const raw = unwrap(JSON.parse(await Bun.file(item).text()))
    const equality = compare(baseline, current, raw)
    report.inputs.push({ path: item, ...equality, baseline: timings(baseline, raw), current: timings(current, raw) })
  }
  const seed = unwrap(JSON.parse(await Bun.file(modelPaths[0]).text()))
  const seedInput = build(current, seed)
  for (let i = 0; i < 20; i++) {
    const random = structuredClone(seedInput.design)
    for (const element of random.elements) {
      const delta = ((i * 17 + element.id.length * 7) % 9 - 4) / 10
      if ('at' in element) { element.at.x += delta; element.at.y -= delta }
      if ('points' in element) for (const point of element.points) { point.x += delta; point.y -= delta }
      if (element.kind === 'line') element.widthMm = Math.max(.1, element.widthMm + delta / 10)
    }
    report.randomized.push({ index: i, ...compareDesign(baseline, current, random, seedInput.context) })
  }
  const skyline = unwrap(JSON.parse(await Bun.file(skylinePath).text()))
  const skylineEquality = compare(baseline, current, skyline)
  report.skyline = { ...skylineEquality, baseline: timings(baseline, skyline), current: timings(current, skyline) }
  const repairCode = `import { buildValidationContext, convertToTactile, floorModelSchema, resolveMechanicalViolations, validateTactileDesign } from ${JSON.stringify(path.join(ROOT, 'packages/floor-model/src/index.ts'))}; const raw=JSON.parse(await Bun.file(${JSON.stringify(skylinePath)}).text()).model; const model=floorModelSchema.parse(raw); const {design}=convertToTactile(model); const context=buildValidationContext(model,design); const before=validateTactileDesign(design,context).length; const start=performance.now(); const result=resolveMechanicalViolations(design,context); const durationMs=performance.now()-start; const after=validateTactileDesign(result,context).length; console.log(JSON.stringify({after,before,durationMs}));`
  const repair = Bun.spawn([process.execPath, '-e', repairCode], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe' })
  const repairResult = await new Promise<any>((resolve) => {
    let timedOut = false
    const completed = Promise.all([repair.exited, new Response(repair.stdout).text(), new Response(repair.stderr).text()])
    const timer = setTimeout(async () => {
      timedOut = true
      repair.kill()
      const [exitCode, stdout, stderr] = await completed
      resolve({ exitCode, stderr, stdout, timedOut: true })
    }, 35_000)
    void completed.then(([exitCode, stdout, stderr]) => {
      clearTimeout(timer); resolve({ exitCode, stderr, stdout, timedOut })
    })
  })
  report.skyline.repair = { watchdogMs: 35_000, ...repairResult }
  report.equal = report.inputs.every((x: any) => x.equal) && report.randomized.every((x: any) => x.equal) && report.skyline.equal
  report.status = 'completed'
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error) }
report.finishedAt = new Date().toISOString()
await Bun.write(path.join(OUT, 'validation-equivalence-v4.json'), JSON.stringify(report, null, 2) + '\n')
if (report.status !== 'completed' || !report.equal) process.exit(1)
