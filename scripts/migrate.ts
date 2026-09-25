/**
 * Runner de migrations minimal : les fichiers migrations/*.sql sont la seule
 * référence (cf. socle-schema.sql fourni), rejoués dans l'ordre alphabétique,
 * chacun dans sa propre transaction, trackés dans schema_migrations.
 *
 * Pas de "down" : à ce stade du projet (schéma encore mouvant), une
 * migration qui doit être défaite s'annule par une nouvelle migration qui
 * corrige, pas par un rollback — plus sûr une fois des données réelles
 * présentes. Connecte toujours avec ifecarm_migrate (propriétaire), jamais
 * ifecarm_app.
 */
import 'dotenv/config'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

async function main() {
  const connectionString = process.env.DATABASE_URL_MIGRATE
  if (!connectionString) {
    throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')
  }

  const client = new Client({ connectionString })
  await client.connect()

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_le  timestamptz NOT NULL DEFAULT now()
    )
  `)

  const { rows: appliedRows } = await client.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  )
  const applied = new Set(appliedRows.map((r) => r.filename))

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let appliedCount = 0
  for (const file of files) {
    if (applied.has(file)) continue

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    console.log(`→ ${file}`)

    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      appliedCount++
    } catch (error) {
      await client.query('ROLLBACK')
      console.error(`✗ Échec sur ${file}`)
      await client.end()
      throw error
    }
  }

  await client.end()
  console.log(appliedCount > 0 ? `${appliedCount} migration(s) appliquée(s).` : 'Déjà à jour.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
