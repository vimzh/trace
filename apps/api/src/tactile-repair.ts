// Run CPU-heavy deterministic repair off the request thread, with a parent-owned deadline.
import { Worker } from 'node:worker_threads'
import type { TactileDesign, ValidationContext } from '@bumps/floor-model'

// ponytail: two active repairs per API process; reject overload rather than grow an unbounded queue.
let activeRepairs = 0

export async function repairOffThread(design: TactileDesign, context: ValidationContext, budgetMs = 30_000): Promise<TactileDesign> {
  const timeoutError = () => new Error('Tactile layout repair exceeded its time budget. Split this dense plan into smaller sections, then try again.')
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw timeoutError()
  if (activeRepairs >= 2) throw new Error('Tactile repair is busy. Wait for current conversions to finish, then try again.')
  // The API build emits this sibling alongside index.js; development runs TypeScript directly.
  const entry = import.meta.url.endsWith('.ts') ? './tactile-repair-worker.ts' : './tactile-repair-worker.js'
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  activeRepairs++
  try {
    worker = new Worker(new URL(entry, import.meta.url), { workerData: { design, context, budgetMs } })
    return await new Promise<TactileDesign>((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError()), budgetMs)
      worker!.once('message', (result: { design?: TactileDesign; error?: string }) => {
        if (result.error) reject(new Error(result.error))
        else if (result.design) resolve(result.design)
        else reject(new Error('Tactile repair worker returned no design'))
      })
      worker!.once('error', reject)
      worker!.once('exit', code => reject(new Error(`Tactile repair worker exited without a result (code ${code})`)))
    })
  } finally {
    clearTimeout(timer)
    try { await worker?.terminate() } finally { activeRepairs-- }
  }
}
