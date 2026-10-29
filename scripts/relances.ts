/**
 * Tâche quotidienne, à lancer une fois par jour (Planificateur de tâches Windows en local, cron en production) :
 *   1. relances des actions correctives en retard (B3, migration 0041) ;
 *   2. alertes de renouvellement des habilitations (B4, migration 0043) ;
 *   3. alertes de recyclage des attestations de formation (B2, migration 0044) ;
 *   4. le lundi, résumé des opportunités de vente à relancer pour chaque membre de l'équipe IFECARM (migration 0053) ;
 *   5. envoi des e-mails mis en file par les fonctions ci-dessus (si SMTP_HOST est renseigné).
 * Idempotent : relancer le script le même jour ne renvoie rien de plus (une alerte par élément et par jalon ; un
 * e-mail envoyé n'est jamais renvoyé).
 * Les trois fonctions SQL passent par ifecarm_app (withoutTenant : SECURITY DEFINER, aucun droit de plus requis).
 * L'envoi lit la file de TOUTES les entreprises : il utilise ifecarm_migrate (DATABASE_URL_MIGRATE), jamais le rôle web.
 * Usage : npm run relances
 */
import 'dotenv/config'
import { sql } from 'kysely'
import { Client } from 'pg'
import { withoutTenant } from '../src/db/tenant'
import { emailConfigure } from '../src/notifications/email'
import { envoyerFileEmail } from '../src/notifications/file'

async function main() {
  const compter = async (fonction: 'relancer_actions_en_retard' | 'alerter_habilitations' | 'alerter_recyclages') =>
    (await withoutTenant((trx) => sql<{ n: number }>`select ${sql.raw(fonction)}() as n`.execute(trx))).rows[0]?.n ?? 0
  const actions = await compter('relancer_actions_en_retard')
  const habilitations = await compter('alerter_habilitations')
  const recyclages = await compter('alerter_recyclages')
  console.log(`${new Date().toISOString()} — ${actions} relance(s) d'action, ${habilitations} alerte(s) d'habilitation, ${recyclages} alerte(s) de recyclage créée(s).`)
  // Lundi (heure UTC du serveur) : une fois par semaine et par personne, la base l'assure.
  if (new Date().getUTCDay() === 1) {
    const url = (process.env.APP_URL ?? '').replace(/\/+$/, '')
    const resumes = (await withoutTenant((trx) => sql<{ n: number }>`select envoyer_resume_opportunites(${url}) as n`.execute(trx))).rows[0]?.n ?? 0
    console.log(`Opportunités de vente : ${resumes} résumé(s) hebdomadaire(s) mis en file.`)
  }

  if (!emailConfigure()) { console.log('E-mail : SMTP_HOST non renseigné, la file reste en attente.'); return }
  const url = process.env.DATABASE_URL_MIGRATE
  if (!url) { console.log('E-mail : DATABASE_URL_MIGRATE absente, envoi ignoré.'); return }
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const b = await envoyerFileEmail(client)
    console.log(`E-mail : ${b.envoyes} envoyé(s), ${b.reportes} reporté(s), ${b.echecs} en échec définitif.`)
  } finally {
    await client.end()
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
