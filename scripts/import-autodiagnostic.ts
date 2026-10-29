/**
 * Import des référentiels d'autodiagnostic du site vitrine (src/autodiagnostic/referentiels/*.json, copie de
 * ifecarm/server/assets/autodiagnostics, plus mini-audit-qhse.json propre à la plateforme, « public » : mini-audit gratuit) dans `referentiel_autodiagnostic`. Rejouable : ne CRÉE que les codes absents ;
 * ne touche JAMAIS à un référentiel existant (l'administrateur peut l'avoir modifié) ni aux évaluations. Ne supprime rien.
 * Le contenu est validé par la base (definition_autodiagnostic_valide) : un fichier invalide fait échouer l'import.
 * Connecte avec ifecarm_migrate (propriétaire), comme import:habilitations.
 * Usage : npm run import:autodiagnostic [-- --dry-run]
 */
import 'dotenv/config'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

interface Fichier {
  referentiel: string
  titre: string
  description: string
  dureeEstimeeMinutes: number
  avertissement: string
  echelleReponses: unknown
  niveaux: unknown
  themes: unknown
  /** Proposé sur la page publique du mini-audit (migration 0052). */
  public?: boolean
}

async function main() {
  const essai = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_MIGRATE
  if (!connectionString) throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')
  const dossier = path.join(process.cwd(), 'src', 'autodiagnostic', 'referentiels')
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN')
    let crees = 0
    let existants = 0
    for (const nom of readdirSync(dossier).filter((n) => n.endsWith('.json')).sort()) {
      const r = JSON.parse(readFileSync(path.join(dossier, nom), 'utf8')) as Fichier
      const { rows } = await client.query('SELECT 1 FROM referentiel_autodiagnostic WHERE code = $1', [r.referentiel])
      if (rows.length) { existants++; continue }
      const questions = (r.themes as { questions: unknown[] }[]).reduce((n, t) => n + t.questions.length, 0)
      await client.query(
        'INSERT INTO referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition, public) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [r.referentiel, r.titre, r.description, r.dureeEstimeeMinutes, r.avertissement, JSON.stringify({ echelleReponses: r.echelleReponses, niveaux: r.niveaux, themes: r.themes }), r.public === true],
      )
      crees++
      console.log(`  + ${r.referentiel} — ${r.titre} (${(r.themes as unknown[]).length} thèmes, ${questions} questions)`)
    }
    await client.query(essai ? 'ROLLBACK' : 'COMMIT')
    console.log(`${essai ? '[essai, rien écrit] ' : ''}${crees} référentiel(s) créé(s), ${existants} déjà présent(s).`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
