// Live Bolduc regression: source has doors but no explicit entrance landmarks.
// Reviews/refines a saved extraction without overwriting the project's model.
import assert from 'node:assert/strict'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { z } from 'zod'
import { floorModelSchema, renderFloorModelSvg, renderFloorTopologyOverlaySvg } from '@bumps/floor-model'
import { runCritique } from '../src/agents/critique'
import { loadPlanImageParts, refineParse } from '../src/agents/parser'

const [projectId, outputDirectory] = process.argv.slice(2)
assert(projectId && outputDirectory, 'usage: bun scripts/verify-entrance-evidence.ts <Bolduc project id> <output directory>')
const directory = path.resolve(outputDirectory)
const api = `${process.env.API_URL ?? 'http://localhost:3003'}/projects/${projectId}`
const response = await fetch(`${api}/model`)
assert.equal(response.status, 200)
const saved = z.object({ model: floorModelSchema, version: z.number().int().positive() }).parse(await response.json())
const model = saved.model
const entrances = model.features.filter((feature) => feature.kind === 'entrance')
assert(entrances.length > 0, 'Expected the pre-fix entrance regression in this Bolduc extraction')
const sourceResponse = await fetch(`${api}/plan`)
assert.equal(sourceResponse.status, 200)
const source = new Uint8Array(await sourceResponse.arrayBuffer())
const sourcePath = path.join(directory, 'source.png')
await Bun.write(sourcePath, source)
await Bun.write(path.join(directory, 'before.json'), JSON.stringify(saved, null, 2))
const png = (svg: string) => new Resvg(svg, { fitTo: { mode: 'width', value: model.plan.widthPx } }).render().asPng()
const critique = await runCritique({
  planParts: await loadPlanImageParts(sourcePath),
  overlayParts: [{ inlineData: {
    data: Buffer.from(png(renderFloorTopologyOverlaySvg(model, `data:image/png;base64,${Buffer.from(source).toString('base64')}`))).toString('base64'),
    mimeType: 'image/png',
  } }],
  renderPngBase64: Buffer.from(png(renderFloorModelSvg(model))).toString('base64'),
  modelJson: JSON.stringify(model),
})
await Bun.write(path.join(directory, 'critique.json'), JSON.stringify(critique, null, 2))
for (const feature of entrances) {
  assert(critique.findings.some((finding) => finding.elementId === feature.id && finding.kind === 'extra' && finding.severity === 'major'), `Critic missed unsupported entrance ${feature.id}`)
}
const corrected = await refineParse(sourcePath, model.plan, model, JSON.stringify(critique.findings))
await Bun.write(path.join(directory, 'corrected.json'), JSON.stringify(corrected, null, 2))
assert.equal(corrected.features.filter((feature) => feature.kind === 'entrance').length, 0, 'Unsupported entrance landmarks survived refinement')
for (const opening of model.openings) {
  assert(corrected.openings.some((candidate) => candidate.id === opening.id), `Refinement lost source opening ${opening.id}`)
}
await Bun.write(path.join(directory, 'corrected.png'), png(renderFloorModelSvg(corrected)))
console.log(JSON.stringify({ projectId, baseVersion: saved.version, unsupportedEntrancesFound: entrances.length, unsupportedEntrancesRemaining: 0, originalOpeningsPreserved: model.openings.length }))
