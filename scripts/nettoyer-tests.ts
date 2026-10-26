/**
 * Nettoyage des données laissées dans la base de DÉVELOPPEMENT par la suite de
 * tests (la suite désactive ses entreprises au lieu de les supprimer : le
 * journal d'audit et les inspections clôturées bloquent la suppression tant
 * que l'entreprise est active). Supprime, dans UNE transaction :
 *   1. les entreprises désactivées dont le nom suit un motif de test
 *      (« Prospect … », « Client créé … », « Test Cloisonnement … ») avec tout
 *      ce qui en dépend (comptes, inspections, sessions, attestations…) ;
 *   2. les comptes internes @test.local (consultants et administrateurs de test) ;
 *   3. les modèles de catalogue « Modèle catalogue (test) » devenus inutilisés.
 * Les lignes du journal d'audit ne sont jamais effacées : leurs références
 * passent à NULL (0015). Garde-fous : rien d'autre que ces motifs n'est
 * touché, et si une entreprise active, un compte hors motif de test ou une
 * fiche du catalogue disparaît, tout est annulé.
 * Usage : npm run nettoyer:tests [-- --dry-run]   (connecte en ifecarm_migrate)
 */
import 'dotenv/config'
import { Client } from 'pg'

const MOTIF_ENTREPRISE = '^(Prospect |Client créé |Test Cloisonnement )'

async function main() {
  const essai = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_MIGRATE
  if (!connectionString) throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')
  const client = new Client({ connectionString })
  await client.connect()

  const compter = async (sql: string, params: unknown[] = []) => Number((await client.query<{ n: string }>(sql, params)).rows[0]!.n)
  const protege = async () => [
    await compter('select count(*) n from entreprise where desactive_le is null'),
    await compter(`select count(*) n from utilisateur where email::text not like '%@test.local' and email::text not like '%@client.test'`),
    await compter('select count(*) n from formation where entreprise_id is null'),
  ]

  try {
    await client.query('begin')
    const avant = await protege()

    const entreprises = (await client.query<{ id: string }>(
      `select id from entreprise where not interne and desactive_le is not null and nom ~ $1`, [MOTIF_ENTREPRISE])).rows.map((r) => r.id)
    // Même ordre que supprimer_entreprise() (0015) : les inspections clôturées ne partent
    // que si leur entreprise existe encore au moment du DELETE, donc avant elle.
    for (const table of ['action_corrective', 'non_conformite', 'inspection', 'attestation', 'participant', 'session_formation']) {
      await client.query(`delete from ${table} where entreprise_id = any($1)`, [entreprises])
    }
    await client.query('delete from entreprise where id = any($1)', [entreprises])

    const comptes = await client.query(
      `delete from utilisateur u using entreprise e
       where e.id = u.entreprise_id and e.interne and u.email::text like '%@test.local'`)
    const restants = await compter(`select count(*) n from utilisateur where email::text like '%@test.local' or email::text like '%@client.test'`)
    const modeles = await client.query(
      `delete from modele_inspection m where m.entreprise_id is null and m.intitule = 'Modèle catalogue (test)'
         and not exists (select 1 from inspection i where i.modele_id = m.id)`)

    const apres = await protege()
    if (apres.some((n, i) => n !== avant[i])) {
      throw new Error(`Garde-fou : entreprises actives / comptes réels / catalogue modifiés (${avant.join(',')} → ${apres.join(',')}). Tout est annulé.`)
    }

    console.log(`Entreprises de test supprimées : ${entreprises.length}`)
    console.log(`Comptes internes @test.local supprimés : ${comptes.rowCount}`)
    console.log(`Modèles « catalogue (test) » supprimés : ${modeles.rowCount}`)
    console.log(`Comptes @test.local / @client.test restants : ${restants}`)
    console.log(`Conservés — entreprises actives : ${apres[0]}, comptes réels : ${apres[1]}, fiches du catalogue : ${apres[2]}`)
    await client.query(essai ? 'rollback' : 'commit')
    if (essai) console.log('Essai à blanc : rien n’a été supprimé.')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
