import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { modelConfiguration } from './agents/llm'
import { db } from './db'
import { projects, tactileDesigns } from './db/schema'
import { exportRoutes } from './export'
import { runWithAgentContext } from './lib/agent-trace'
import { modelRoutes } from './models'
import { parseRoutes } from './parse'
import { projectRoutes } from './projects'
import { tactileRoutes } from './tactile'

// Background jobs die with the process; on boot, fail anything a previous
// process left mid-flight so it can be retried instead of blocking forever.
await db
  .update(tactileDesigns)
  .set({ error: 'Interrupted by a server restart — run again', status: 'failed' })
  .where(eq(tactileDesigns.status, 'running'))
await db
  .update(projects)
  .set({
    parseError: 'Interrupted by a server restart — try again',
    parseProgress: null,
    status: 'failed',
  })
  .where(eq(projects.status, 'parsing'))

const app = new Hono()

app.use('*', cors())
// AsyncLocalStorage also follows parse/tactile promises after HTTP 202 returns.
app.use('/projects/:id/*', (c, next) => runWithAgentContext({
  operation: c.req.path,
  projectId: c.req.param('id')!,
  requestId: crypto.randomUUID(),
}, next))

app.get('/', (c) => {
  return c.json({ models: modelConfiguration(), ok: true })
})

app.route('/projects', projectRoutes)
app.route('/projects', modelRoutes)
app.route('/projects', parseRoutes)
app.route('/projects', tactileRoutes)
app.route('/projects', exportRoutes)

// Container hosts provide PORT; local dev overrides it in the dev script.
export default {
  fetch: app.fetch,
  idleTimeout: 30,
  port: Number(process.env.PORT ?? 3003),
}
