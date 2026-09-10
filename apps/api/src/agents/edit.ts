import { z } from 'zod'
import {
  featureKinds,
  type EditOperation,
  type FloorModel,
} from '@bumps/floor-model'
import {
  STRUCTURED_OUTPUT_INSTRUCTION,
  llmPointSchema,
  MODEL_FAST,
  normalizeLlmPoint,
  parseAgentOutput,
  runAgentTurn,
} from './llm'
import { withModelRetry } from './retry'

// Flat operation shape for the LLM: tool schemas cannot express the domain's
// conditional union safely, so the agent emits this and code converts
// it into real EditOperations (rejecting anything malformed wholesale).
const llmPoint = llmPointSchema

const llmEditOp = z.object({
  op: z.enum(['add', 'move', 'reshape', 'delete', 'relabel', 'merge', 'confirm']),
  id: z.string().nullable(),
  ids: z.array(z.string()).max(2).nullable(),
  dx: z.number().nullable(),
  dy: z.number().nullable(),
  points: z.array(llmPoint).max(2_000).nullable(),
  label: z.string().nullable(),
  elementKind: z
    .enum(['wall', 'door', 'window', 'room', 'furniture', ...featureKinds])
    .nullable(),
  at: llmPoint.nullable(),
  a: llmPoint.nullable(),
  b: llmPoint.nullable(),
  polygon: z.array(llmPoint).max(2_000).nullable(),
  width: z.number().nullable(),
})

export const editAgentOutputSchema = z.object({
  action: z.enum(['apply', 'clarify']),
  operations: z.array(llmEditOp).max(2_000),
  // Past-tense plain-words account of what was done (action=apply).
  summary: z.string().min(1).max(500),
  // Exactly one clarifying question (action=clarify).
  question: z.string().trim().min(1).max(500).nullable(),
}).superRefine((output, ctx) => {
  // Reject contradictions inside the tool so Strands can return corrective
  // feedback to the agent before the result reaches the editor.
  if (output.action === 'clarify') {
    if (output.question === null) {
      ctx.addIssue({ code: 'custom', path: ['question'], message: 'Clarify requires a question' })
    }
    if (output.operations.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Clarify must not apply operations' })
    }
  } else {
    if (output.operations.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Apply requires at least one operation' })
    }
    if (output.question !== null) {
      ctx.addIssue({ code: 'custom', path: ['question'], message: 'Apply must not ask a question' })
    }
  }
})

export type EditAgentResult =
  | { action: 'apply'; operations: EditOperation[]; summary: string }
  | { action: 'clarify'; question: string }

export class EditConversionError extends Error {}

type LlmEditOp = z.infer<typeof llmEditOp>

function require<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new EditConversionError(message)
  }
  return value
}

function newId(kind: string): string {
  return `a-${kind}-${crypto.randomUUID().slice(0, 4)}`
}

function convertOne(flat: LlmEditOp, model: FloorModel): EditOperation {
  switch (flat.op) {
    case 'move':
      return {
        op: 'move',
        id: require(flat.id, 'move needs id'),
        dx: require(flat.dx, 'move needs dx'),
        dy: require(flat.dy, 'move needs dy'),
      }
    case 'reshape':
      return {
        op: 'reshape',
        id: require(flat.id, 'reshape needs id'),
        points: require(flat.points, 'reshape needs points').map(
          normalizeLlmPoint,
        ),
      }
    case 'delete':
      return { op: 'delete', id: require(flat.id, 'delete needs id') }
    case 'confirm':
      return { op: 'confirm', id: require(flat.id, 'confirm needs id') }
    case 'relabel':
      return {
        op: 'relabel',
        id: require(flat.id, 'relabel needs id'),
        label: flat.label,
      }
    case 'merge': {
      const ids = require(flat.ids, 'merge needs ids')
      if (ids.length !== 2) {
        throw new EditConversionError('merge needs exactly 2 ids')
      }
      return { op: 'merge', ids, label: flat.label }
    }
    case 'add': {
      const kind = require(flat.elementKind, 'add needs elementKind')
      const defaultWidth = Math.max(24, Math.round(model.plan.widthPx * 0.04))
      if (kind === 'door' || kind === 'window') {
        return {
          op: 'add',
          element: {
            at: normalizeLlmPoint(require(flat.at, `add ${kind} needs at`)),
            confidence: 1,
            id: newId(kind),
            kind,
            wallId: null,
            width: flat.width ?? defaultWidth,
          },
        }
      }
      if (kind === 'wall') {
        return {
          op: 'add',
          element: {
            a: normalizeLlmPoint(require(flat.a, 'add wall needs a')),
            b: normalizeLlmPoint(require(flat.b, 'add wall needs b')),
            confidence: 1,
            id: newId(kind),
            kind,
            thickness: Math.max(6, Math.round(model.plan.widthPx * 0.008)),
          },
        }
      }
      if (kind === 'room') {
        const polygon = require(flat.polygon, 'add room needs polygon').map(
          normalizeLlmPoint,
        )
        if (polygon.length < 3) {
          throw new EditConversionError('add room polygon needs 3+ points')
        }
        return {
          op: 'add',
          element: {
            confidence: 1,
            id: newId(kind),
            kind,
            label: flat.label,
            polygon,
          },
        }
      }
      if (kind === 'furniture') {
        const polygon = require(
          flat.polygon,
          'add furniture needs polygon',
        ).map(normalizeLlmPoint)
        if (polygon.length < 3) {
          throw new EditConversionError('add furniture polygon needs 3+ points')
        }
        return {
          op: 'add',
          element: {
            confidence: 1,
            id: newId(kind),
            kind,
            label: flat.label ?? 'furniture',
            polygon,
          },
        }
      }
      return {
        op: 'add',
        element: {
          at: normalizeLlmPoint(require(flat.at, `add ${kind} needs at`)),
          confidence: 1,
          id: newId(kind),
          kind,
          label: flat.label,
          rotation: 0,
        },
      }
    }
  }
}

const INSTRUCTION = `You edit extracted floor plan models for a tactile-map product. You never touch geometry directly — you emit edit operations that code applies.

You receive the current model as JSON (every element has an id), the plan's pixel dimensions, optionally the id of the element the user has selected, and the user's request.

Operations (set unused fields to null):
- move: id, dx, dy (pixels)
- reshape: id, points (walls: [a,b]; rooms: full polygon; point elements: [at])
- delete: id
- relabel: id, label (rooms, roads, furniture, and features; null clears an optional label; furniture labels must stay non-empty)
- merge: ids (two room ids, or two furniture ids to club blocks together), optional label
- confirm: id (marks an element as verified correct)
- add: elementKind plus geometry — door/window: at (+ optional width); wall: a, b; room: polygon (+ optional label); furniture: polygon + label ("sofa", "chairs"); features: at (+ optional label, preserving source names and qualifiers such as "Accessible restroom" or "East exit")

Rules:
- Reference ONLY ids present in the model JSON. Never invent ids.
- Coordinates are pixels in the plan's coordinate space, origin top-left. Place additions sensibly relative to the rooms the user names.
- Prefer the fewest operations that satisfy the request.
- "this", "it", "the selected one" refer to the selected element id when provided.
- If the request is ambiguous (several plausible targets, unclear intent) or asks for something outside these operations, set action="clarify" and ask ONE short question. Do not guess.
- action="apply": operations non-empty, summary = one past-tense sentence in plain words (e.g. "Renamed Lobby to Entrance Hall and deleted 2 windows."). action="clarify": operations empty, question set.` + STRUCTURED_OUTPUT_INSTRUCTION

export async function runEditAgent(params: {
  model: FloorModel
  prompt: string
  selectedId: string | null
}): Promise<EditAgentResult> {
  return withModelRetry(() => runEditAgentOnce(params))
}

async function runEditAgentOnce(params: {
  model: FloorModel
  prompt: string
  selectedId: string | null
}): Promise<EditAgentResult> {
  const context = [
    `Model JSON:\n${JSON.stringify(params.model)}`,
    `Plan dimensions: ${params.model.plan.widthPx}x${params.model.plan.heightPx} pixels.`,
    params.selectedId ? `Selected element id: ${params.selectedId}` : 'No element is selected.',
    `User request: ${params.prompt}`,
  ].join('\n\n')

  const structuredOutput = await runAgentTurn({
    agentName: 'Edit agent',
    description: 'Turns natural-language edit requests into floor model operations',
    instruction: INSTRUCTION,
    model: MODEL_FAST,
    outputSchema: editAgentOutputSchema,
    parts: [{ text: context }],
  })

  const output = parseAgentOutput(editAgentOutputSchema, structuredOutput, 'Edit agent')
  if (output.action === 'clarify') {
    return {
      action: 'clarify',
      question: require(output.question, 'Clarify requires a question'),
    }
  }
  if (output.operations.length === 0) {
    throw new EditConversionError('Edit agent applied nothing')
  }
  return {
    action: 'apply',
    operations: output.operations.map((op) => convertOne(op, params.model)),
    summary: output.summary,
  }
}
