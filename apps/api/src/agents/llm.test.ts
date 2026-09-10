import { describe, expect, test } from 'bun:test'
import {
  Agent,
  ConstantBackoff,
  Model,
  ModelThrottledError,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk'
import { z } from 'zod'
import { APIConnectionTimeoutError } from 'openai'
import { editAgentOutputSchema } from './edit'
import {
  BedrockRetryStrategy,
  isTransientBedrockError,
  makeBedrockModel,
  makeOpenAIModel,
  MODEL_PROVIDER,
  modelConfiguration,
  nonEmptySetting,
  parseAgentOutput,
  positiveIntegerSetting,
  runAgentTurn,
  toStrandsContent,
} from './llm'

const STRUCTURED_OUTPUT_TOOL = 'strands_structured_output'

type ModelCall = {
  messages: Message[]
  options?: StreamOptions
}

type ModelResponse = ModelStreamEvent[] | Error

class ScriptedModel extends Model<BaseModelConfig> {
  readonly calls: ModelCall[] = []
  private config: BaseModelConfig = {
    contextWindowLimit: 200_000,
    modelId: 'scripted-test-model',
  }

  constructor(private readonly responses: ModelResponse[]) {
    super()
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config }
  }

  async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.calls.push({ messages: messages.map((message) => message.clone()), options })
    const response = this.responses.shift()
    if (!response) throw new Error('Scripted model ran out of responses')
    if (response instanceof Error) throw response
    for (const event of response) yield event
  }
}

class HangingModel extends Model<BaseModelConfig> {
  getConfig(): BaseModelConfig {
    return { contextWindowLimit: 200_000, modelId: 'hanging-test-model' }
  }

  updateConfig(): void {}

  async *stream(
    _messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const signal = options?.cancelSignal
    await new Promise<void>((resolve) => {
      if (!signal || signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw signal?.reason ?? new Error('cancelled')
  }
}

class UncancellableModel extends Model<BaseModelConfig> {
  getConfig(): BaseModelConfig {
    return { contextWindowLimit: 200_000, modelId: 'uncancellable-test-model' }
  }

  updateConfig(): void {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    await new Promise(() => {})
  }
}

function textResponse(text: string): ModelStreamEvent[] {
  return [
    { type: 'modelMessageStartEvent', role: 'assistant' },
    { type: 'modelContentBlockStartEvent' },
    { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
    { type: 'modelContentBlockStopEvent' },
    { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
  ]
}

function toolResponse(input: unknown): ModelStreamEvent[] {
  return [
    { type: 'modelMessageStartEvent', role: 'assistant' },
    {
      type: 'modelContentBlockStartEvent',
      start: {
        type: 'toolUseStart',
        name: STRUCTURED_OUTPUT_TOOL,
        toolUseId: crypto.randomUUID(),
      },
    },
    {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
    },
    { type: 'modelContentBlockStopEvent' },
    { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
  ]
}

function multipleToolResponse(inputs: unknown[]): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [
    { type: 'modelMessageStartEvent', role: 'assistant' },
  ]
  for (const input of inputs) {
    events.push(
      {
        type: 'modelContentBlockStartEvent',
        start: {
          type: 'toolUseStart',
          name: STRUCTURED_OUTPUT_TOOL,
          toolUseId: crypto.randomUUID(),
        },
      },
      {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
      },
      { type: 'modelContentBlockStopEvent' },
    )
  }
  events.push({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
  return events
}

const resultSchema = z.object({ id: z.string(), score: z.number().min(0).max(1) })

function invokeScripted(model: Model, text = 'Inspect this plan.') {
  return runAgentTurn({
    agentName: 'Contract test',
    description: 'Exercises the Strands invocation contract.',
    instruction: 'Return a structured result.',
    model,
    outputSchema: resultSchema,
    parts: [{ text }],
  })
}

describe('Strands Bedrock adapter', () => {
  test('repairs a missing clarification question inside the native agent turn', async () => {
    const incomplete = {
      action: 'clarify', operations: [], question: null, summary: 'Need a target.',
    }
    const corrected = { ...incomplete, question: 'Which room should I rename?' }
    const model = new ScriptedModel([toolResponse(incomplete), toolResponse(corrected)])
    await expect(runAgentTurn({
      agentName: 'Edit contract test',
      description: 'Requires an actionable clarification.',
      instruction: 'Ask which room to rename.',
      model,
      outputSchema: editAgentOutputSchema,
      parts: [{ text: 'Rename the room.' }],
    })).resolves.toEqual(corrected)
    expect(model.calls).toHaveLength(2)
    expect(model.calls[1]?.messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    )).toBe(true)
  })

  test('preserves interleaved text and image bytes', () => {
    const content = toStrandsContent([
      { text: 'Inspect this.' },
      { inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } },
    ])

    expect(content[0]).toEqual({ text: 'Inspect this.' })
    expect(content[1]).toEqual({
      image: {
        format: 'png',
        source: { bytes: Buffer.from('image') },
      },
    })
  })

  test('fails before inference for an unsupported image type', () => {
    expect(() =>
      toStrandsContent([
        { inlineData: { data: '', mimeType: 'image/svg+xml' } },
      ]),
    ).toThrow('Unsupported Bedrock image type')
  })

  test('rejects empty and malformed image payloads before inference', () => {
    expect(() =>
      toStrandsContent([
        { inlineData: { data: '', mimeType: 'image/png' } },
      ]),
    ).toThrow('non-empty base64')
    expect(() =>
      toStrandsContent([
        { inlineData: { data: 'not base64', mimeType: 'image/png' } },
      ]),
    ).toThrow('non-empty base64')
  })

  test('reports Strands and Bedrock in the health configuration', () => {
    expect(modelConfiguration()).toMatchObject({
      provider: `strands-${MODEL_PROVIDER}`,
      sdk: '@strands-agents/sdk',
    })
  })

  test('preserves Sonnet reasoning and Haiku sampling settings', () => {
    const critical = makeBedrockModel('global.anthropic.claude-sonnet-4-6').getConfig()
    const fast = makeBedrockModel(
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    ).getConfig()

    expect(critical.additionalRequestFields).toEqual({
      thinking: { type: 'adaptive' },
    })
    expect(critical.temperature).toBeUndefined()
    expect(fast.additionalRequestFields).toBeUndefined()
    expect(fast.temperature).toBe(0.1)
  })

  test.each([
    'anthropic.claude-opus-5',
    'global.anthropic.claude-opus-5',
    'us.anthropic.claude-opus-5',
  ])('preserves default Opus 5 thinking without unsupported sampling: %s', (modelId) => {
    const config = makeBedrockModel(modelId).getConfig()

    expect(config.modelId).toBe(modelId)
    expect(config.temperature).toBeUndefined()
    expect(config.additionalRequestFields).toBeUndefined()
    expect(config.stream).toBe(true)
  })

  test('rejects invalid numeric model configuration', () => {
    expect(positiveIntegerSetting('LIMIT', undefined, 3)).toBe(3)
    expect(positiveIntegerSetting('LIMIT', '12', 3)).toBe(12)
    expect(() => positiveIntegerSetting('LIMIT', 'NaN', 3)).toThrow(
      'LIMIT must be a positive integer',
    )
    expect(() => positiveIntegerSetting('LIMIT', '-1', 3)).toThrow(
      'LIMIT must be a positive integer',
    )
  })

  test('uses stateless OpenAI Responses with reasoning and one structured tool call', () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-only-not-a-real-key'
    try {
      const model = makeOpenAIModel('gpt-5.6-sol')
      expect(model.api).toBe('responses')
      expect(model.stateful).toBe(false)
      expect(model.getConfig()).toMatchObject({
        modelId: 'gpt-5.6-sol',
        params: { reasoning: { effort: 'medium' }, parallel_tool_calls: false, service_tier: 'default' },
      })
      expect(model.getConfig().temperature).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test('fails quota exhaustion without retrying a wrapped OpenAI 429', async () => {
    const failure = new ModelThrottledError('spend limit reached', {
      cause: Object.assign(new Error('quota'), {
        status: 429, code: 'organization_spend_limit_exceeded', type: 'insufficient_quota',
      }),
    })
    expect(isTransientBedrockError(failure)).toBe(false)
    expect(isTransientBedrockError({ status: 503 })).toBe(true)
    expect(isTransientBedrockError({ status: 401 })).toBe(false)
    const model = new ScriptedModel([failure])
    await expect(invokeScripted(model)).rejects.toThrow('spend limit reached')
    expect(model.calls).toHaveLength(1)
  })

  test('rejects empty region and model configuration', () => {
    expect(nonEmptySetting('MODEL', undefined, 'fallback')).toBe('fallback')
    expect(nonEmptySetting('MODEL', 'model-id', 'fallback')).toBe('model-id')
    expect(() => nonEmptySetting('MODEL', '  ', 'fallback')).toThrow(
      'MODEL must not be empty',
    )
  })

  test('validates native structured output without prose parsing', () => {
    expect(parseAgentOutput(resultSchema, { id: 'wall-1', score: 0.8 }, 'Test')).toEqual({
      id: 'wall-1',
      score: 0.8,
    })
    expect(() =>
      parseAgentOutput(resultSchema, { id: 'wall-1', score: 2 }, 'Test'),
    ).toThrow('schema-invalid output')
  })

  test('executes the native Strands structured-output tool', async () => {
    const model = new ScriptedModel([toolResponse({ id: 'wall-1', score: 0.8 })])

    await expect(invokeScripted(model)).resolves.toEqual({
      id: 'wall-1',
      score: 0.8,
    })
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.options?.toolSpecs?.map((tool) => tool.name)).toContain(
      STRUCTURED_OUTPUT_TOOL,
    )
  })

  test('forces structured output after prose while preserving the user context', async () => {
    const longInput = `plan:${'x'.repeat(20_000)}`
    const model = new ScriptedModel([
      textResponse('I will describe it instead.'),
      toolResponse({ id: 'room-1', score: 0.7 }),
    ])

    await expect(invokeScripted(model, longInput)).resolves.toEqual({
      id: 'room-1',
      score: 0.7,
    })
    expect(model.calls).toHaveLength(2)
    expect(model.calls[1]?.options?.toolChoice).toEqual({
      tool: { name: STRUCTURED_OUTPUT_TOOL },
    })
    expect(model.calls[1]?.messages[0]?.content[0]?.toJSON()).toEqual({
      text: longInput,
    })
  })

  test('keeps concurrent agent invocations isolated', async () => {
    const first = new ScriptedModel([
      toolResponse({ id: 'first-room', score: 0.8 }),
    ])
    const second = new ScriptedModel([
      toolResponse({ id: 'second-room', score: 0.9 }),
    ])

    const [firstResult, secondResult] = await Promise.all([
      invokeScripted(first, 'first plan'),
      invokeScripted(second, 'second plan'),
    ])

    expect(firstResult).toEqual({ id: 'first-room', score: 0.8 })
    expect(secondResult).toEqual({ id: 'second-room', score: 0.9 })
    expect(first.calls[0]?.messages[0]?.content[0]?.toJSON()).toEqual({
      text: 'first plan',
    })
    expect(second.calls[0]?.messages[0]?.content[0]?.toJSON()).toEqual({
      text: 'second plan',
    })
  })

  test('recovers from one schema-invalid tool call using the tool result context', async () => {
    const model = new ScriptedModel([
      toolResponse({ id: 42, score: 2 }),
      toolResponse({ id: 'door-1', score: 0.6 }),
    ])

    await expect(invokeScripted(model)).resolves.toEqual({
      id: 'door-1',
      score: 0.6,
    })
    expect(model.calls).toHaveLength(2)
    expect(model.calls[1]?.messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    )).toBe(true)
  })

  test('rejects ambiguous multiple structured outputs in one model turn', async () => {
    const model = new ScriptedModel([
      multipleToolResponse([
        { id: 'door-1', score: 0.8 },
        { id: 'door-2', score: 0.9 },
      ]),
    ])

    await expect(invokeScripted(model)).rejects.toThrow(
      'multiple structured outputs',
    )
    expect(model.calls).toHaveLength(1)
  })

  test('propagates model failures and rejects empty invocations', async () => {
    const failure = new Error('AccessDeniedException')
    await expect(invokeScripted(new ScriptedModel([failure]))).rejects.toThrow(
      'AccessDeniedException',
    )
    await expect(
      runAgentTurn({
        agentName: 'Empty test',
        description: 'Rejects empty inputs.',
        instruction: 'Return a structured result.',
        model: new ScriptedModel([]),
        outputSchema: resultSchema,
        parts: [],
      }),
    ).rejects.toThrow('requires non-empty message content')
    await expect(
      invokeScripted(new ScriptedModel([]), '   '),
    ).rejects.toThrow('requires non-empty message content')
  })

  test('classifies bounded Bedrock retry cases without retrying client errors', () => {
    expect(isTransientBedrockError(new APIConnectionTimeoutError())).toBe(true)
    expect(isTransientBedrockError(new ModelThrottledError('slow down'))).toBe(true)
    expect(
      isTransientBedrockError(
        Object.assign(new Error('stream failed'), {
          name: 'ModelStreamErrorException',
        }),
      ),
    ).toBe(true)
    expect(
      isTransientBedrockError({
        $metadata: { httpStatusCode: 503 },
        name: 'UnknownServiceError',
      }),
    ).toBe(true)
    expect(
      isTransientBedrockError(
        new Error('wrapper', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true)
    expect(
      isTransientBedrockError({
        $metadata: { httpStatusCode: 400 },
        name: 'ValidationException',
      }),
    ).toBe(false)
    expect(
      isTransientBedrockError({
        $metadata: { httpStatusCode: 403 },
        name: 'AccessDeniedException',
      }),
    ).toBe(false)
  })

  test('retries a transient model failure inside the Strands agent loop', async () => {
    const transient = Object.assign(new Error('service unavailable'), {
      $metadata: { httpStatusCode: 503 },
      name: 'ServiceUnavailableException',
    })
    const model = new ScriptedModel([
      transient,
      toolResponse({ id: 'stair-1', score: 0.9 }),
    ])
    const agent = new Agent({
      contextManager: false,
      model,
      printer: false,
      retryStrategy: new BedrockRetryStrategy({
        backoff: new ConstantBackoff({ delayMs: 0 }),
        maxAttempts: 2,
      }),
      structuredOutputSchema: resultSchema,
      systemPrompt: 'Return a structured result.',
    })

    const result = await agent.invoke('Inspect this plan.', {
      limits: { turns: 3 },
    })

    expect(result.structuredOutput).toEqual({ id: 'stair-1', score: 0.9 })
    expect(model.calls).toHaveLength(2)
  })

  test('cancels a model call at the configured timeout with a stable error', async () => {
    await expect(
      runAgentTurn({
        agentName: 'Timeout test',
        description: 'Exercises cancellation.',
        instruction: 'Return a structured result.',
        model: new HangingModel(),
        outputSchema: resultSchema,
        parts: [{ text: 'Wait forever.' }],
        timeoutMs: 5,
      }),
    ).rejects.toThrow('Timeout test timed out')
  })

  test('enforces the timeout even when the model ignores cancellation', async () => {
    await expect(
      runAgentTurn({
        agentName: 'Hard timeout test',
        description: 'Ignores cancellation.',
        instruction: 'Return a structured result.',
        model: new UncancellableModel(),
        outputSchema: resultSchema,
        parts: [{ text: 'wait forever' }],
        timeoutMs: 5,
      }),
    ).rejects.toThrow('Hard timeout test timed out')
  })
})
