# Trace web app

The Next.js interface provides the upload wizard, floor-model editor, tactile validation review, 3D preview, and STL downloads.

Run the full product from the repository root so the API and web app start together:

```bash
bun run dev
```

Open <http://localhost:3000>. The browser-facing API origin is configured by `NEXT_PUBLIC_API_URL` in `apps/web/.env.local`.

Web-only checks can be run from this directory:

```bash
bun run typecheck
bun run lint
bun run build
```
