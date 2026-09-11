// Verify worker isolation, exact repair output, and cancellation without any model calls.
import { expect, test } from 'bun:test'
import { buildValidationContext, convertToTactile, resolveMechanicalViolations, sampleFloorModel } from '@bumps/floor-model'
import { repairOffThread } from './tactile-repair'

test('off-thread repair preserves deterministic output and leaves the request loop responsive', async () => {
  const { design } = convertToTactile(sampleFloorModel)
  const context = buildValidationContext(sampleFloorModel, design)
  const expected = resolveMechanicalViolations(design, context)
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 1)
  try {
    expect(await repairOffThread(design, context)).toEqual(expected)
    expect(ticks).toBeGreaterThan(0)
  } finally { clearInterval(timer) }
  await expect(repairOffThread(design, context, 0)).rejects.toThrow('time budget')
  await expect(repairOffThread(design, context, 1)).rejects.toThrow('time budget')
  // A timed-out worker cannot poison the next job.
  expect(await repairOffThread(design, context)).toEqual(expected)
  const burst = await Promise.allSettled(Array.from({ length: 3 }, () => repairOffThread(design, context)))
  expect(burst.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
  expect((burst[2] as PromiseRejectedResult).reason.message).toContain('busy')
  expect(await repairOffThread(design, context)).toEqual(expected)
})
