# Evaluation corpus status

The repository contains a versioned 30-pair corpus of source plans and tactile-map references. The deterministic preparation and contract checks are reusable across inference providers.

The configured live runtime has not yet been executed against the full corpus
in this environment. Do not interpret archived output artifacts as current
provider evidence.

Run the live corpus after configuring the API:

```bash
bun run eval:live
```

Record exact model IDs, input fingerprints, iteration counts, schema failures, hallucinated or missed structures, validation history, tokens, latency, and comparison rubric scores. See [../docs/evaluation.md](../docs/evaluation.md) for the required scenario matrix and evidence policy.
