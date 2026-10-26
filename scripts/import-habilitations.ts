/**
 * Import de la liste de départ du catalogue d'habilitations (src/habilitations/catalogue-depart.json) dans
 * `type_habilitation` (entreprise_id NULL = catalogue IFECARM GROUP). Rejouable : ne CRÉE que les types dont le code
 * est absent ; ne touche JAMAIS à un type existant (intitulé, référentiel, validité et activation restent ceux que
 * l'administrateur a décidés). Ne supprime rien. Les durées de validité du fichier sont indicatives, à confirmer.
 * Connecte avec ifecarm_migrate (propriétaire), comme import:catalogue.
 * Usage : npm run import:habilitations [-- --dry-run]
 */
import 'dotenv/config'
import { Client } from 'pg'
import depart from '../src/habilitations/catalogue-depart.json'

async function main() {
  const essai = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_MIGRATE
  if (!connectionString) throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN')
    let crees = 0
    let existants = 0
    for (const t of depart) {
      const { rows } = await client.query('SELECT 1 FROM type_habilitation WHERE entreprise_id IS NULL AND lower(code) = lower($1)', [t.code])
      if (rows.length) { existants++; continue }
      await client.query(
        'INSERT INTO type_habilitation (entreprise_id, code, intitule, domaine, referentiel, validite_mois) VALUES (NULL, $1, $2, $3, $4, $5)',
        [t.code, t.intitule, t.domaine, t.referentiel, t.validite_mois],
      )
      crees++
      console.log(`  + ${t.code} — ${t.intitule}`)
    }
    await client.query(essai ? 'ROLLBACK' : 'COMMIT')
    console.log(`${essai ? '[essai, rien écrit] ' : ''}${crees} type(s) créé(s), ${existants} déjà présent(s).`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
