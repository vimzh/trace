// One deterministic repair job; no model, database, or evaluation-ledger access.
import { parentPort, workerData } from 'node:worker_threads'
import { resolveMechanicalViolations, type TactileDesign, type ValidationContext } from '@bumps/floor-model'

if (!parentPort) throw new Error('Tactile repair must run in a worker')
const { design, context, budgetMs } = workerData as { design: TactileDesign; context: ValidationContext; budgetMs: number }
try {
  parentPort.postMessage({ design: resolveMechanicalViolations(design, context, performance.now() + budgetMs) })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : 'Tactile repair failed' })
}
parentPort.close()
