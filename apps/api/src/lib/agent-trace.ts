// Optional local evaluation traces and a conservative, single-process spend guard.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type AgentContext = { projectId: string; requestId: string; operation: string }
type Usage = {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

const context = new AsyncLocalStorage<AgentContext>()
export function runWithAgentContext<T>(value: AgentContext, run: () => T): T {
  return context.run(value, run)
}

export class EvaluationBudgetError extends Error {
  override name = 'EvaluationBudgetError'
}

function positiveAmount(name: string, value: string | number): number {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${name} must be positive`)
  return amount
}

/** Full task text is retained; image payloads are identified without saving base64. */
export function safeTraceValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') }
  }
  if (Array.isArray(value)) return value.map(safeTraceValue)
  if (value && typeof value === 'object') {
    if ('inlineData' in value) {
      const data = value.inlineData as { data: string; mimeType: string }
      return { image: { mimeType: data.mimeType, ...safeTraceValue(Buffer.from(data.data, 'base64')) as object } }
    }
    if ('image' in value && value.image && typeof value.image === 'object') {
      const image = value.image as { format: string; source: { bytes?: string | Uint8Array } }
      if (image.source?.bytes !== undefined) {
        const bytes = typeof image.source.bytes === 'string' ? Buffer.from(image.source.bytes, 'base64') : image.source.bytes
        return { image: { mimeType: `image/${image.format}`, ...safeTraceValue(bytes) as object } }
      }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeTraceValue(item)]))
  }
  return value
}

function safeError(error: unknown) {
  if (error === undefined) return undefined
  const message = error instanceof Error ? error.message : String(error)
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'),
  }
}

/** Evaluation rates supplied for this study; cached input receives no discount. */
export function estimateEvaluationCost(model: string, usage: Usage): number | null {
  const fast = model === 'gpt-5.6-luna'
  if (!fast && model !== 'gpt-5.6-sol') return null
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens ?? 0, usage.cacheWriteInputTokens ?? 0]
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Evaluation usage must contain non-negative finite token counts')
  }
  // OpenAI inputTokens includes cached reads; SDK does not expose cache-write
  // details here. Charge all input at 1.25x, plus any explicit cache writes.
  const input = usage.inputTokens + (usage.cacheWriteInputTokens ?? 0)
  const longContext = !fast && input > 272_000
  return (input * (fast ? 0.2 : 4) * 1.25 * (longContext ? 2 : 1)
    + usage.outputTokens * (fast ? 1.2 : 20) * (longContext ? 1.5 : 1)) / 1_000_000
}

type Start = { agentName: string; model: string; instruction: string; parts: unknown[] }
type Finish = { output?: unknown; usage?: Usage; error?: unknown; stopReason?: string }

export function createAgentTraceRecorder(options: { dir: string; budgetUsd?: number; reserveUsd?: number }) {
  const budget = options.budgetUsd === undefined ? undefined : positiveAmount('EVAL_BUDGET_USD', options.budgetUsd)
  const reserve = positiveAmount('EVAL_CALL_RESERVE_USD', options.reserveUsd ?? 3)
  mkdirSync(options.dir, { recursive: true })
  const ledgerPath = join(options.dir, 'usage-ledger.json')
  let ledger = { version: 1, estimatedCostUsd: 0, completedCalls: 0, recoveredReservationUsd: 0, inFlight: {} as Record<string, number> }

  function writeJson(path: string, value: unknown) {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  }
  if (existsSync(ledgerPath)) {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as typeof ledger
    if (ledger.version !== 1 || !Number.isFinite(ledger.estimatedCostUsd) || ledger.estimatedCostUsd < 0
      || !ledger.inFlight || typeof ledger.inFlight !== 'object'
      || Object.values(ledger.inFlight).some((amount) => !Number.isFinite(amount) || amount < 0)) {
      throw new Error('Invalid evaluation usage ledger; reconcile it before restarting')
    }
    const recovered = Object.values(ledger.inFlight).reduce((sum, amount) => sum + amount, 0)
    ledger.estimatedCostUsd += recovered
    ledger.recoveredReservationUsd += recovered
    ledger.inFlight = {}
  }
  // ponytail: one API process owns this ledger; use a transactional shared
  // store before running multiple API processes against the same trace directory.
  function saveLedger() {
    writeJson(ledgerPath, {
      ...ledger, budgetUsd: budget ?? null, callReserveUsd: reserve,
      limitation: 'Conservative estimate, not a billing hard cap. Reservations are per agent invocation, including internal retries; unknown or failed usage retains at least the reservation.',
    })
  }
  saveLedger()

  return {
    start(input: Start) {
      if (budget !== undefined && estimateEvaluationCost(input.model, { inputTokens: 0, outputTokens: 0 }) === null) {
        throw new EvaluationBudgetError(`No evaluation cost rate for model ${input.model}; no call started`)
      }
      const id = randomUUID()
      const startedAt = new Date().toISOString()
      const started = performance.now()
      const record = {
        id, ...context.getStore(), agentName: input.agentName, model: input.model,
        startedAt, status: 'running', instruction: input.instruction,
        parts: safeTraceValue(input.parts), modelCalls: [] as unknown[],
      }
      const path = join(options.dir, `${id}.json`)
      const reserved = Object.values(ledger.inFlight).reduce((sum, amount) => sum + amount, 0)
      if (budget !== undefined && ledger.estimatedCostUsd + reserved + reserve > budget) {
        const error = new EvaluationBudgetError(`Evaluation budget exhausted: $${ledger.estimatedCostUsd.toFixed(4)} estimated + $${reserved.toFixed(2)} reserved; next $${reserve.toFixed(2)} exceeds $${budget.toFixed(2)}. No call started.`)
        writeJson(path, { ...record, status: 'blocked', error: safeError(error), finishedAt: new Date().toISOString() })
        throw error
      }
      writeJson(path, record)
      ledger.inFlight[id] = reserve
      saveLedger()
      let finished = false
      let modelCallIndex = 0
      let failedModelAttempt = false
      return {
        id,
        projectId: context.getStore()?.projectId,
        modelCall(event: { phase: 'start' | 'end'; messages?: unknown; output?: unknown; error?: unknown; attemptCount?: number; accumulatedUsage?: Usage }) {
          if (event.phase === 'start') modelCallIndex += 1
          if (event.error !== undefined) failedModelAttempt = true
          record.modelCalls.push({
            ...event, callId: `${id}/${modelCallIndex}`,
            accumulatedUsage: event.accumulatedUsage ? { ...event.accumulatedUsage } : undefined,
            messages: safeTraceValue(event.messages), output: safeTraceValue(event.output),
            error: safeError(event.error), at: new Date().toISOString(),
          })
          if (!finished) writeJson(path, record)
        },
        finish(result: Finish) {
          if (finished) return
          finished = true
          const estimate = result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)
            ? estimateEvaluationCost(input.model, result.usage) : null
          // Failed requests may have partial/missing usage even after billing.
          const accounted = result.error !== undefined || failedModelAttempt || estimate === null ? Math.max(estimate ?? 0, reserve) : estimate
          ledger.estimatedCostUsd += accounted
          ledger.completedCalls += 1
          delete ledger.inFlight[id]
          saveLedger()
          writeJson(path, {
            ...record, status: result.error === undefined ? 'completed' : 'failed',
            finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
            output: safeTraceValue(result.output), usage: result.usage ?? null,
            stopReason: result.stopReason, error: safeError(result.error),
            estimatedCostUsd: estimate, accountedCostUsd: accounted, failedModelAttempt,
          })
        },
      }
    },
  }
}

let recorder: ReturnType<typeof createAgentTraceRecorder> | undefined
export function startAgentTrace(input: Start) {
  const dir = process.env.EVAL_TRACE_DIR
  if (!dir) {
    if (process.env.EVAL_BUDGET_USD !== undefined) throw new Error('EVAL_BUDGET_USD requires EVAL_TRACE_DIR for its persistent ledger')
    return undefined
  }
  recorder ??= createAgentTraceRecorder({
    dir,
    budgetUsd: process.env.EVAL_BUDGET_USD === undefined ? undefined : positiveAmount('EVAL_BUDGET_USD', process.env.EVAL_BUDGET_USD),
    reserveUsd: process.env.EVAL_CALL_RESERVE_USD === undefined ? undefined : positiveAmount('EVAL_CALL_RESERVE_USD', process.env.EVAL_CALL_RESERVE_USD),
  })
  return recorder.start(input)
}
