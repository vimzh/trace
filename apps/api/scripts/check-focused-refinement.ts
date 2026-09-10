// Run in its own process: stub only the paid LLM turn, preserving real refinement and validation.
import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { Resvg } from '@resvg/resvg-js'
import { allElements, sampleFloorModel } from '@bumps/floor-model'
import type { Critique } from '../src/agents/critique'

const llm = await import('../src/agents/llm')
type Turn = Parameters<typeof llm.runAgentTurn>[0]
let handler: (turn: Turn) => Promise<unknown> = async () => { throw new Error('Unexpected LLM call') }
let active = 0
let maxActive = 0
let calls = 0
mock.module('../src/agents/llm', () => ({
  ...llm,
  runAgentTurn: async (turn: Turn) => {
    calls++
    active++
    maxActive = Math.max(maxActive, active)
    try { return await handler(turn) } finally { active-- }
  },
}))
const { refineParse, refinementOutputSchema, PARSER_INSTRUCTION } = await import('../src/agents/parser')
const originalFetch = globalThis.fetch
const noNetwork = () => { throw new Error('Network disabled for refinement contract check') }
globalThis.fetch = Object.assign(async () => noNetwork(), { preconnect: noNetwork })

let assertions = 0
function check(condition: unknown, message: string) {
  assertions++
  assert(condition, message)
}
const emptyPatch = () => refinementOutputSchema.parse({
  walls: [], openings: [], rooms: [], features: [], furniture: [], removeIds: [],
})
const ids = ['f-stairs', 'f-restroom', 'f-entrance']
const findings: Critique['findings'] = ids.map(elementId => {
  const at = sampleFloorModel.features.find(feature => feature.id === elementId)!.at
  return { kind: 'mislabeled', at, bounds: { x0: at.x, y0: at.y, x1: at.x, y1: at.y }, elementId,
    description: 'Preserve the source-evidenced facility qualifier.', severity: 'major' }
})
function reportedId(turn: Turn) {
  const context = turn.parts.find(part => 'text' in part && part.text.startsWith('FOCUS BOUNDS:'))
  assert(context && 'text' in context, 'Expected a focused task handoff')
  const line = context.text.split('\n').find(line => line.startsWith('REPORTED DEFECTS TO VERIFY: '))!
  return (JSON.parse(line.slice('REPORTED DEFECTS TO VERIFY: '.length)) as Critique['findings'])[0]!.elementId!
}
function corrected(id: string) {
  return { ...emptyPatch(), features: [{ ...sampleFloorModel.features.find(feature => feature.id === id)!,
    label: `Verified ${id}` }] }
}
function reset() {
  check(active === 0, 'Every previous task must finish before the next scenario')
  calls = 0
  maxActive = 0
}

const directory = await mkdtemp(join(tmpdir(), 'trace-focused-refinement-'))
const sourcePath = join(directory, 'source.png')
const source = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><path d="M 40 40 H 960 V 760 H 40 Z M 40 380 H 960 M 40 480 H 960" fill="none" stroke="black" stroke-width="8"/></svg>')
  .render().asPng()
await Bun.write(sourcePath, source)
const original = JSON.stringify(sampleFloorModel)
const run = (review = findings) => refineParse(sourcePath, sampleFloorModel.plan, sampleFloorModel, JSON.stringify(review))

async function verify() {
  // Three isolated repairs: the first two overlap, and the third starts only when a slot frees.
  const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  const release = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  handler = async turn => {
    const index = ids.indexOf(reportedId(turn))
    check(index >= 0, 'Each focused task must retain its finding target')
    check(turn.parts.filter(part => 'inlineData' in part).length === 3, 'Focused task receives exactly three evidence images')
    started[index]!.resolve()
    await release[index]!.promise
    const proposal = corrected(ids[index]!)
    check(turn.outputSchema.safeParse(proposal).success, 'Valid local patch satisfies the actual supplied tool schema')
    return proposal
  }
  const pending = run()
  await Promise.all([started[0]!.promise, started[1]!.promise])
  check(active === 2 && calls === 2, 'Two independent repairs must run concurrently; the third remains queued')
  release[0]!.resolve()
  await started[2]!.promise
  check(active === 2 && maxActive === 2, 'A freed slot admits the third repair without exceeding two active calls')
  release[1]!.resolve()
  release[2]!.resolve()
  const result = await pending
  check(calls === 3 && active === 0, 'All three tasks finish exactly once')
  check(ids.every(id => result.features.find(feature => feature.id === id)?.label === `Verified ${id}`), 'All independent repairs are merged')
  check(JSON.stringify(allElements(result).filter(element => !ids.includes(element.id)))
    === JSON.stringify(allElements(sampleFloorModel).filter(element => !ids.includes(element.id))), 'Unrelated records survive the actual merge unchanged')
  check(JSON.stringify(sampleFloorModel) === original, 'Successful refinement does not mutate its input')

  // A failed task must not expose its sibling's patch or leave that sibling running.
  reset()
  const bothStarted = Promise.withResolvers<void>()
  const fail = Promise.withResolvers<void>()
  const finishSibling = Promise.withResolvers<void>()
  let siblingFinished = false
  handler = async turn => {
    const id = reportedId(turn)
    if (calls === 2) bothStarted.resolve()
    if (id === ids[0]) { await fail.promise; throw new Error('Synthetic unrecoverable failure') }
    await finishSibling.promise
    siblingFinished = true
    return corrected(id)
  }
  let settled = false
  const failedRun = run().then(value => { settled = true; return { value, error: null } },
    error => { settled = true; return { value: null, error } })
  await bothStarted.promise
  fail.resolve()
  await Bun.sleep(0)
  check(active === 1 && !settled, 'Failure waits for the already active sibling instead of returning early')
  check(calls === 2, 'Failure does not start a queued third task')
  finishSibling.resolve()
  const failure = await failedRun
  check(failure.value === null && failure.error?.message === 'Synthetic unrecoverable failure', 'The entire repair rejects; no partial model is returned')
  check(siblingFinished && active === 0 && calls === 2, 'The sibling is awaited and the queued task remains unstarted')
  check(JSON.stringify(sampleFloorModel) === original, 'Failed refinement leaves the input untouched')

  // Invalid tool output is rejected by both the supplied schema and the actual caller.
  for (const [proposal, expected] of [
    [{ ...emptyPatch(), walls: [{ id: 'refine-1-degenerate', kind: 'wall', a: { x: 90, y: 100 },
      b: { x: 90, y: 100 }, thickness: 8, confidence: .9 }] }, 'Wall endpoints must be distinct'],
    [corrected('f-restroom'), 'read-only element: f-restroom'],
  ] as const) {
    reset()
    handler = async turn => {
      check(!turn.outputSchema.safeParse(proposal).success, 'Tool schema rejects domain/scope violations')
      return proposal
    }
    const outcome = await run([findings[0]!]).then(value => ({ value, error: null }), error => ({ value: null, error }))
    check(outcome.value === null && String(outcome.error).includes(expected), 'Actual refineParse rejects invalid output even when the stub bypasses tool validation')
    check(calls === 1 && active === 0, 'A deterministic invalid patch does not launch unrelated work')
    check(JSON.stringify(sampleFloorModel) === original, 'Invalid output never mutates the prior model')
  }

  // Explicit broad mode retains the existing metadata and full-context contract.
  reset()
  const broad: Critique['findings'] = [{ ...findings[0]!, at: null, bounds: null, elementId: null }]
  handler = async turn => {
    check(turn.instruction === PARSER_INSTRUCTION, 'Broad mode uses the existing full-parser instruction')
    const text = turn.parts.flatMap(part => 'text' in part ? [part.text] : []).join('\n')
    check(text.includes(JSON.stringify(sampleFloorModel)), 'Broad mode retains the full model')
    check(text.includes('WHOLE PLAN AUDIT') && text.includes('LEGACY FINDING DETAIL'), 'Broad mode retains the audit and legacy finding evidence')
    const proposal = { ...corrected('f-restroom'), title: 'Source-verified title', north: 270 }
    check(turn.outputSchema.safeParse(proposal).success, 'Broad mode still permits source-grounded metadata corrections')
    return proposal
  }
  const broadResult = await refineParse(sourcePath, sampleFloorModel.plan, sampleFloorModel,
    JSON.stringify(broad), 'WHOLE PLAN AUDIT', [{ text: 'LEGACY FINDING DETAIL' }])
  check(calls === 1 && active === 0, 'Broad mode remains one complete repair')
  check(broadResult.title === 'Source-verified title' && broadResult.plan.north === 270, 'Broad metadata corrections reach the returned model')
  check(broadResult.features.find(feature => feature.id === 'f-restroom')!.label === 'Verified f-restroom', 'Broad geometry-record correction is retained')
  check(JSON.stringify(broadResult.walls) === JSON.stringify(sampleFloorModel.walls), 'Broad mode preserves unmentioned geometry')
  reset()
  check(await run([]) === sampleFloorModel && calls === 0, 'An empty finding list does not spend a model call')
}

let timeout: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([verify(), new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Focused-refinement contract check timed out')), 60_000)
  })])
  console.log(`Focused refinement contract: ${assertions} assertions passed; no API calls.`)
} finally {
  clearTimeout(timeout)
  globalThis.fetch = originalFetch
  await unlink(sourcePath)
  await rmdir(directory)
}
