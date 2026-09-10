import { expect, test } from 'bun:test'
import { StructuredOutputError } from '@strands-agents/sdk'
import { isTransientModelError, withModelRetry } from './retry'

test('only semantic output failures trigger a fresh agent invocation', () => {
  expect(isTransientModelError('Critique returned schema-invalid output')).toBe(true)
  expect(isTransientModelError('Layout agent returned no structured output')).toBe(true)
  expect(isTransientModelError('Bedrock ThrottlingException: rate exceeded')).toBe(false)
  expect(isTransientModelError('Request timed out')).toBe(false)
  expect(isTransientModelError('AccessDeniedException: model access is not enabled')).toBe(false)
})

test('Strands structured-output failures receive one fresh agent invocation', async () => {
  let calls = 0

  await expect(
    withModelRetry(async () => {
      calls += 1
      if (calls === 1) {
        throw new StructuredOutputError('The model did not call the forced tool')
      }
      return 'valid output'
    }),
  ).resolves.toBe('valid output')

  expect(calls).toBe(2)
})
