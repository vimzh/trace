import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Model, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk'
import { z } from 'zod'
import { isTransientBedrockError, runAgentTurn } from '../agents/llm'
import { createAgentTraceRecorder, estimateEvaluationCost, EvaluationBudgetError, runWithAgentContext, safeTraceValue } from './agent-trace'

test('background project traces isolate concurrent calls, reserve spend, and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumps-agent-trace-'))
  try {
    const recorder = createAgentTraceRecorder({ dir, budgetUsd: 6, reserveUsd: 3 })
    const app = new Hono()
    const jobs: Promise<void>[] = []
    const calls: ReturnType<typeof recorder.start>[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const options = {
      agentName: 'Parser', model: 'gpt-5.6-sol', instruction: 'Preserve the source.',
      parts: [{ text: 'full source text' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
    }
    app.use('/projects/:id/*', (c, next) => runWithAgentContext({
      projectId: c.req.param('id')!, requestId: crypto.randomUUID(), operation: c.req.path,
    }, next))
    app.post('/projects/:id/parse', (c) => {
      jobs.push((async () => {
        await gate
        const call = recorder.start(options)
        calls.push(call)
        call.modelCall({ phase: 'start', messages: [{ role: 'user', content: options.parts }] })
      })())
      return c.json({ status: 'parsing' }, 202)
    })
    const responses = await Promise.all([
      app.request('/projects/first/parse', { method: 'POST' }),
      app.request('/projects/second/parse', { method: 'POST' }),
    ])
    expect(responses.map((response) => response.status)).toEqual([202, 202])
    release()
    await Promise.all(jobs)
    expect(calls.map((call) => call.projectId).sort()).toEqual(['first', 'second'])
    expect(() => recorder.start(options)).toThrow(EvaluationBudgetError)
    const first = calls[0]!
    first.finish({ output: { room: 'Hall' }, usage: { inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 200 } })
    const serialized = readFileSync(join(dir, `${first.id}.json`), 'utf8')
    expect(serialized).not.toContain('aW1hZ2U=')
    const trace = JSON.parse(serialized)
    expect(trace).toMatchObject({
      id: first.id, projectId: first.projectId, status: 'completed',
      output: { room: 'Hall' }, usage: { cacheReadInputTokens: 200 },
      accountedCostUsd: 0.007,
    })
    expect(trace.parts[1].image).toMatchObject({ mimeType: 'image/png', bytes: 5 })
    expect(trace.parts[1].image.sha256).toHaveLength(64)
    expect(trace.modelCalls[0].messages[0].content[0]).toEqual({ text: 'full source text' })
    // Simulate process loss with the second call unresolved: its reserve is spent.
    const restarted = createAgentTraceRecorder({ dir, budgetUsd: 6, reserveUsd: 3 })
    expect(() => restarted.start(options)).toThrow('Evaluation budget exhausted')
    const ledger = JSON.parse(readFileSync(join(dir, 'usage-ledger.json'), 'utf8'))
    expect(ledger).toMatchObject({ estimatedCostUsd: 3.007, recoveredReservationUsd: 3, inFlight: {} })
    expect(() => restarted.start({ ...options, model: 'unknown-provider-model' })).toThrow('No evaluation cost rate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed calls preserve usage, redact credentials, and charge a conservative reserve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumps-agent-trace-'))
  try {
    const recorder = createAgentTraceRecorder({ dir, budgetUsd: 6 })
    const call = recorder.start({ agentName: 'Critique', model: 'gpt-5.6-sol', instruction: 'Check.', parts: [{ text: 'plan' }] })
    call.finish({ error: new Error('failure sk-secret-value Bearer secret-token'), output: { malformed: true }, usage: { inputTokens: 1_000, outputTokens: 100, cacheWriteInputTokens: 100 } })
    const raw = readFileSync(join(dir, `${call.id}.json`), 'utf8')
    expect(raw).not.toContain('secret-value')
    expect(raw).not.toContain('secret-token')
    expect(JSON.parse(raw)).toMatchObject({ status: 'failed', accountedCostUsd: 3, output: { malformed: true }, usage: { cacheWriteInputTokens: 100 } })
    expect(estimateEvaluationCost('gpt-5.6-sol', { inputTokens: 300_000, outputTokens: 1_000 })).toBeCloseTo(3.03)
    expect(estimateEvaluationCost('gpt-5.6-luna', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1.45)
    expect(() => estimateEvaluationCost('gpt-5.6-sol', { inputTokens: NaN, outputTokens: 0 })).toThrow('finite token counts')
    expect(safeTraceValue({ image: { format: 'png', source: { bytes: 'aW1hZ2U=' } } })).toMatchObject({ image: { mimeType: 'image/png', bytes: 5 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

class TraceTestModel extends Model<BaseModelConfig> {
  getConfig() { return { modelId: 'gpt-5.6-sol' } }
  updateConfig() {}
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'strands_structured_output', toolUseId: 'test-output' } }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"room":"Hall"}' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100, cacheReadInputTokens: 200 } }
  }
}

test('native Strands hooks capture safe model input/output and usage without external calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bumps-agent-trace-'))
  const previous = process.env.EVAL_TRACE_DIR
  process.env.EVAL_TRACE_DIR = dir
  try {
    await expect(runWithAgentContext({ projectId: 'native-project', requestId: 'native-request', operation: '/projects/native-project/parse' }, () => runAgentTurn({
      agentName: 'Trace test', model: new TraceTestModel(), instruction: 'Return the room.',
      description: 'Checks native hook traces.', outputSchema: z.object({ room: z.string() }),
      parts: [{ text: 'Inspect image.' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }],
    }))).resolves.toEqual({ room: 'Hall' })
    const file = readdirSync(dir).find((name) => name.endsWith('.json') && name !== 'usage-ledger.json')!
    const raw = readFileSync(join(dir, file), 'utf8')
    expect(raw).not.toContain('aW1hZ2U=')
    const trace = JSON.parse(raw)
    expect(trace).toMatchObject({ projectId: 'native-project', status: 'completed', output: { room: 'Hall' }, accountedCostUsd: 0.007 })
    expect(trace.modelCalls).toHaveLength(2)
    expect(trace.modelCalls[0].callId).toBe(trace.modelCalls[1].callId)
    expect(trace.modelCalls[0].messages[0].content[1].image).toMatchObject({ mimeType: 'image/png', bytes: 5 })
    expect(trace.modelCalls[1].accumulatedUsage).toMatchObject({ inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 200 })
    expect(isTransientBedrockError(new EvaluationBudgetError('budget exhausted'))).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.EVAL_TRACE_DIR
    else process.env.EVAL_TRACE_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
