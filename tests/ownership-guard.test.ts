import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

/**
 * Garde-fou demandé par la revue de sécurité, après le retrait de FORCE ROW
 * LEVEL SECURITY : le cloisonnement de tout le projet repose entièrement
 * sur le fait qu'ifecarm_app n'est propriétaire d'AUCUNE table. Si une
 * migration future tourne un jour avec le mauvais rôle (ifecarm_app au lieu
 * de ifecarm_migrate) et se retrouve propriétaire d'un objet qu'elle crée,
 * le RLS cesserait silencieusement de s'appliquer à ce rôle sur cette table
 * — ce test échoue explicitement dans ce cas, plutôt que de laisser passer
 * une régression invisible.
 */
describe('Garde-fou structurel : ifecarm_app ne possède aucune table', () => {
  it("aucune table (relkind 'r' ou partitionnée 'p') n'appartient au rôle applicatif", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
    await client.connect()
    const { rows } = await client.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'ifecarm_app'
        AND c.relkind IN ('r', 'p')
    `)
    await client.end()
    expect(rows).toEqual([])
  })
})
