import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const databaseSocket = process.env.DATABASE_SOCKET

export const db = databaseSocket
  ? drizzle({ connection: { url: databaseUrl, path: databaseSocket }, schema })
  : drizzle(databaseUrl, { schema })
