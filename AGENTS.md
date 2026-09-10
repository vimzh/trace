# Repository conventions

- This repository contains the Trace tactile-map product. Keep changes aligned with its documented local workflow and accessibility goals.
- Preserve `@bumps/floor-model` and existing database, environment, storage, and repository identifiers for compatibility; Trace is the product brand.
- Use the existing PostgreSQL and Drizzle persistence layer for product state.
- Run `bun run setup` when initializing a fresh checkout.
- Preserve the human review and deterministic export gates; automated checks are not accessibility certification.
