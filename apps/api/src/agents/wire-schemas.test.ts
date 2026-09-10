import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { rawComparisonSchema } from './compare'
import { critiqueOutputSchema } from './critique'
import { editAgentOutputSchema } from './edit'
import { openingsAuditSchema } from './openings-audit'
import { parsedOutputSchema, refinementOutputSchema } from './parser'
import { layoutAgentOutputSchema } from './tactile-layout'
import { sourceInventorySchema } from './source-reader'

describe('Strands structured-output schemas', () => {
  test('all role schemas convert to JSON Schema without transforms', () => {
    for (const schema of [
      parsedOutputSchema,
      refinementOutputSchema,
      sourceInventorySchema,
      critiqueOutputSchema,
      openingsAuditSchema,
      editAgentOutputSchema,
      layoutAgentOutputSchema,
      rawComparisonSchema,
    ]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow()
    }
  })

  test('normalizes unexpected fields but rejects missing required nullable fields', () => {
    const payload = {
      action: 'clarify',
      operations: [],
      question: 'Which room should change?',
      summary: 'Asked for clarification.',
      unexpectedProviderField: 'ignored',
    }
    const parsed = editAgentOutputSchema.parse(payload)

    expect(parsed).toEqual({
      action: 'clarify',
      operations: [],
      question: 'Which room should change?',
      summary: 'Asked for clarification.',
    })
    const { question: _question, ...partial } = payload
    expect(editAgentOutputSchema.safeParse(partial).success).toBe(false)
  })

  test('rejects contradictory edits and oversized output at the structured-tool boundary', () => {
    const operation = {
      a: null,
      at: null,
      b: null,
      dx: null,
      dy: null,
      elementKind: null,
      id: 'wall-1',
      ids: null,
      label: null,
      op: 'confirm',
      points: null,
      polygon: null,
      width: null,
    }
    for (const payload of [
      { action: 'clarify', operations: [], question: null },
      { action: 'clarify', operations: [], question: '   ' },
      { action: 'clarify', operations: [operation], question: 'Which wall?' },
      { action: 'apply', operations: [], question: null },
      { action: 'apply', operations: [operation], question: 'Which wall?' },
    ]) {
      expect(editAgentOutputSchema.safeParse({ ...payload, summary: 'Review walls.' }).success).toBe(false)
    }
    expect(
      editAgentOutputSchema.safeParse({
        action: 'apply',
        operations: Array.from({ length: 2_001 }, () => operation),
        question: null,
        summary: 'Confirmed walls.',
      }).success,
    ).toBe(false)
  })
})
