import { StructuredOutputError } from '@strands-agents/sdk'

const SEMANTIC_REASK_PATTERNS = [
  'schema-invalid output',
  'returned no structured output',
]

/** Re-asks once only when native structured output fails application validation. */
export async function withModelRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !(error instanceof StructuredOutputError) &&
      !isTransientModelError(message)
    ) {
      throw error
    }
    console.warn(
      `[llm] structured-output re-ask after semantic failure: ${message.slice(0, 160)}`,
    )
    return fn()
  }
}

export function isTransientModelError(message: string): boolean {
  const normalized = message.toLowerCase()
  return SEMANTIC_REASK_PATTERNS.some((pattern) => normalized.includes(pattern))
}
