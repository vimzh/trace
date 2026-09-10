# Trace API

The Bun and Hono service handles uploads, Strands agent orchestration,
PostgreSQL model versions, tactile conversion, validation, and STL exports.

Run the complete product from the repository root:

```sh
bun run dev
```

The API listens on <http://localhost:3003>. Configure it with `apps/api/.env`,
then migrate the database before first use:

```sh
cd apps/api
bun run db:migrate
```

API checks can be run from this directory with `bun run typecheck` and
`bun run build`.
