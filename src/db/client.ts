import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { DB } from './types.generated'

/**
 * Instance Kysely UNIQUE de l'application, connectée avec ifecarm_app —
 * jamais ifecarm_migrate (propriétaire, exempté du RLS). N'importer ce
 * module que depuis tenant.ts : le reste du code obtient un handle de
 * requête exclusivement via withTenant/withAuthenticatedUser/
 * withPlatformAdmin (tenant.ts), jamais directement depuis appDb.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} non définie (voir .env.example).`)
  return value
}

const pool = new Pool({ connectionString: requireEnv('DATABASE_URL_APP') })

export const appDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
