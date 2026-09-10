# Running Trace

Trace turns one top-down floor or site plan into a reviewed, 3D-printable tactile map.

## Prerequisites

- Bun 1.3+
- PostgreSQL 17
- An OpenAI API key with inference access

## Setup

```bash
bun install --frozen-lockfile
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cd apps/api && bun run db:migrate && cd ../..
```

Set `DATABASE_URL` and `OPENAI_API_KEY` in `apps/api/.env`. The example uses
`MODEL_PROVIDER=openai`. Amazon Bedrock remains an explicit optional provider;
it requires AWS credentials and Bedrock model IDs for every role.

## Run

```bash
bun run dev
```

- Web: http://localhost:3000
- API: http://localhost:3003
- Health/configuration: `curl http://localhost:3003/`

## Workflow

1. Upload a PDF, PNG, JPG, or WebP plan up to 10 MB.
2. Strands agents parse, visually critique, refine, and audit openings.
3. Review low-confidence elements and edit directly or with a prompt.
4. Convert to tactile geometry; the deterministic validator and layout agent must reach zero violations.
5. Preview and download the map and braille-legend STLs.

## Verify

```bash
bun run typecheck
bun run lint
bun test packages/floor-model apps/api/src apps/web/src
bun run build
```

With a configured API running, execute the live evaluation corpus:

```bash
bun run eval:live
```

## Environment reference

| Variable | Purpose |
|---|---|
| `MODEL_PROVIDER` | `openai` for local use; `bedrock` when explicitly configured |
| `OPENAI_API_KEY` | OpenAI credential used by the current local provider |
| `MODEL_CRITICAL` | Parser, critic, and openings model |
| `MODEL_FAST` | Natural-language edit model |
| `MODEL_LAYOUT` | Tactile layout model |
| `MODEL_COMPARE` | Offline evaluation model |
| `MODEL_MAX_OUTPUT_TOKENS` | Per-turn structured-output cap |
| `MODEL_TIMEOUT_MS` | Per-agent cancellation deadline |
| `AWS_REGION` | Optional Bedrock region |
| `AWS_PROFILE` | Optional local Bedrock credential profile |
| `DATABASE_URL` | PostgreSQL connection string |
| `UPLOADS_DIR` | Uploaded/generated artifact directory |
| `NEXT_PUBLIC_API_URL` | Browser-facing API origin |
