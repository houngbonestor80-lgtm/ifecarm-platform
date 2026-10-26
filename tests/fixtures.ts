import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { hacherMotDePasse } from '@/auth/password'

/** Mot de passe des comptes de test (jamais un vrai) : variable d'environnement MOT_DE_PASSE_TEST si elle est définie, sinon une valeur de test fixe. */
export const MOT_DE_PASSE_FIXTURES = process.env.MOT_DE_PASSE_TEST || 'mot-de-passe-de-test-jamais-utilise'

/** Corps JSON d'une connexion de test avec le mot de passe des comptes de test. */
export const corpsConnexion = (email: string | undefined) => JSON.stringify({ email, ...Object.fromEntries([['motDePasse', MOT_DE_PASSE_FIXTURES]]) })

export interface Fixtures {
  entrepriseA: string
  entrepriseB: string
  utilisateurA1: string
  utilisateurB1: string
  salarieA1: string
  salarieB1: string
  consultantC1: string
  adminPlateformeP1: string
  ifecarmInterne: string
}

/**
 * Crée les données de test avec ifecarm_migrate (propriétaire, exempté du
 * RLS) — volontairement : le rôle de ces fixtures est de préparer l'état,
 * pas de démontrer le cloisonnement. Toutes les ASSERTIONS, elles, passent
 * par ifecarm_app via withTenant/withAuthenticatedUser/withPlatformAdmin
 * (cf. tenant-isolation.test.ts) — jamais par ce client.
 */
export async function creerFixtures(): Promise<Fixtures> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()

  const suffixe = randomUUID().slice(0, 8)

  const { rows: [ifecarmInterne] } = await client.query<{ id: string }>(
    'SELECT id FROM entreprise WHERE interne = true LIMIT 1',
  )
  if (!ifecarmInterne) {
    throw new Error("Entreprise interne IFECARM introuvable — migrations/0001_socle.sql a-t-il bien été appliqué ?")
  }

  const { rows: [entrepriseA] } = await client.query<{ id: string }>(
    "INSERT INTO entreprise (nom, pays) VALUES ($1, 'BJ') RETURNING id",
    [`Test Cloisonnement A ${suffixe}`],
  )
  const { rows: [entrepriseB] } = await client.query<{ id: string }>(
    "INSERT INTO entreprise (nom, pays) VALUES ($1, 'CI') RETURNING id",
    [`Test Cloisonnement B ${suffixe}`],
  )

  const motDePasseHash = await hacherMotDePasse(MOT_DE_PASSE_FIXTURES)

  const creerUtilisateur = async (entrepriseId: string, label: string) => {
    const { rows: [row] } = await client.query<{ id: string }>(
      'INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [entrepriseId, `${label}-${suffixe}@test.local`, `Utilisateur ${label}`, motDePasseHash],
    )
    return row!.id
  }

  const utilisateurA1 = await creerUtilisateur(entrepriseA!.id, 'a1')
  const utilisateurB1 = await creerUtilisateur(entrepriseB!.id, 'b1')
  const consultantC1 = await creerUtilisateur(ifecarmInterne.id, 'c1')
  const adminPlateformeP1 = await creerUtilisateur(ifecarmInterne.id, 'p1')

  await client.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'admin_entreprise')", [utilisateurA1])
  await client.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'admin_entreprise')", [utilisateurB1])
  await client.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'consultant_ifecarm')", [consultantC1])
  await client.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'admin_plateforme')", [adminPlateformeP1])

  await client.query(
    'INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture) VALUES ($1, $2, true)',
    [consultantC1, entrepriseB!.id],
  )

  const { rows: [salarieA1] } = await client.query<{ id: string }>(
    "INSERT INTO salarie (entreprise_id, nom, prenom) VALUES ($1, 'Salarié', 'A1') RETURNING id",
    [entrepriseA!.id],
  )
  const { rows: [salarieB1] } = await client.query<{ id: string }>(
    "INSERT INTO salarie (entreprise_id, nom, prenom) VALUES ($1, 'Salarié', 'B1') RETURNING id",
    [entrepriseB!.id],
  )

  await client.end()

  return {
    entrepriseA: entrepriseA!.id,
    entrepriseB: entrepriseB!.id,
    utilisateurA1,
    utilisateurB1,
    salarieA1: salarieA1!.id,
    salarieB1: salarieB1!.id,
    consultantC1,
    adminPlateformeP1,
    ifecarmInterne: ifecarmInterne.id,
  }
}

export async function nettoyerFixtures(f: Fixtures): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  // ON DELETE CASCADE nettoie utilisateur/role_utilisateur/acces_consultant/salarie
  // rattachés à A et B. C1 et P1 (rattachés à l'entreprise interne, non
  // supprimée) sont nettoyés séparément.
  // Une entreprise citée au journal d'audit (immuable) ne peut plus être
  // supprimée : on la désactive, comme en production. Ses utilisateurs restent
  // alors référencés ; leur suppression peut échouer sans conséquence.
  await client.query('DELETE FROM entreprise WHERE id = ANY($1)', [[f.entrepriseA, f.entrepriseB]]).catch(() =>
    client.query('UPDATE entreprise SET desactive_le = now() WHERE id = ANY($1) AND desactive_le IS NULL', [[f.entrepriseA, f.entrepriseB]]),
  )
  await client.query('DELETE FROM utilisateur WHERE id = ANY($1)', [[f.consultantC1, f.adminPlateformeP1]]).catch(() => {})
  await client.end()
}
