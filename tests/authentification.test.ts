import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErreurAcces, avecPlateformeAdmin } from '@/auth/contexte'
import { jetonDepuisRequete } from '@/auth/http'
import {
  traiterChoixEntreprise, traiterConnexion, traiterDeconnexion, traiterListeEntreprises, traiterMoi, traiterSondeTenant,
} from '@/auth/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'
import { creerFixturesInspections, nettoyerFixturesInspections, type FixturesInspections } from './fixtures-inspections'

/**
 * Parcours d'authentification de bout en bout (Request → Response, base réelle) :
 * connexion, session, sélecteur de tenant du consultant, contrôle d'accès
 * REVÉRIFIÉ à chaque requête (mandat expiré, entreprise désactivée en cours de
 * session), et refus des mauvaises tentatives.
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
let fi: FixturesInspections
const emails = new Map<string, string>()

async function avecMigrate<T>(cb: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  try {
    return await cb(client)
  } finally {
    await client.end()
  }
}

const emailDe = (utilisateurId: string) => emails.get(utilisateurId)!

/** Une IP différente par appel : la limitation par IP ne doit pas faire déborder un test sur un autre. */
const ipAleatoire = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

function requete(chemin: string, options: { method?: string, corps?: unknown, jeton?: string, origine?: string | null, ip?: string } = {}): Request {
  const headers: Record<string, string> = { host: HOTE, 'content-type': 'application/json', 'x-forwarded-for': options.ip ?? ipAleatoire() }
  if (options.origine !== null) headers.origin = options.origine ?? ORIGINE
  if (options.jeton) headers.cookie = `ifecarm_session=${encodeURIComponent(options.jeton)}`
  return new Request(`${ORIGINE}${chemin}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.corps === undefined ? undefined : JSON.stringify(options.corps),
  })
}

/** `liberer` : valide la 2FA en base comme le ferait la saisie du code (les tests de 2FA passent `false`). */
async function seConnecter(utilisateurId: string, motDePasse = MOT_DE_PASSE, liberer = true) {
  const reponse = await traiterConnexion(requete('/api/auth/connexion', { corps: { email: emailDe(utilisateurId), motDePasse } }))
  const cookie = reponse.headers.get('set-cookie')
  const jeton = cookie ? jetonDepuisRequete(new Request(ORIGINE, { headers: { cookie: cookie.split(';')[0]! } })) : null
  if (jeton && liberer) await libererA2f(jeton)
  return { reponse, cookie, jeton, corps: (await reponse.clone().json()) as Record<string, unknown> }
}

beforeAll(async () => {
  f = await creerFixtures()
  fi = await creerFixturesInspections(f)
  await avecMigrate(async (c) => {
    const ids = [f.utilisateurA1, f.utilisateurB1, f.consultantC1, f.adminPlateformeP1, fi.consultantExpire, fi.consultantLecture, fi.consultantSansAcces]
    const { rows } = await c.query<{ id: string, email: string }>('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [ids])
    rows.forEach((r) => emails.set(r.id, r.email))
  })
})

afterAll(async () => {
  try {
    await nettoyerFixtures(f)
  } catch {
    // ignoré, cf. tests/tenant-isolation.test.ts
  }
  try {
    await nettoyerFixturesInspections(fi)
  } catch {
    // idem
  }
})

describe('Connexion — cas nominal et cookie de session', () => {
  it('un utilisateur d’entreprise cliente se connecte : cookie httpOnly, jeton absent du corps', async () => {
    const { reponse, cookie, jeton, corps } = await seConnecter(f.utilisateurA1)
    expect(reponse.status).toBe(200)
    expect(cookie).toMatch(/^ifecarm_session=/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(jeton).toBeTruthy()
    // Le jeton ne doit exister que dans le cookie.
    expect(JSON.stringify(corps)).not.toContain(jeton!)
    // A1 est admin d'entreprise : la 2FA est obligatoire, la session attend son activation.
    expect(corps.destination).toBe('/connexion/2fa')
    expect(corps.a2f).toBe('activation')
  })

  it("la session porte l'identité et l'entreprise de rattachement — jamais fournies par le navigateur", async () => {
    const { jeton } = await seConnecter(f.utilisateurA1)
    const moi = await (await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))).json()
    expect(moi).toMatchObject({ utilisateurId: f.utilisateurA1, entrepriseId: f.entrepriseA, consultant: false, adminPlateforme: false })
    // La connexion est journalisée dans le tenant.
    const journal = await avecMigrate((c) => c.query("SELECT count(*)::int AS n FROM journal_audit WHERE action = 'connexion' AND utilisateur_id = $1", [f.utilisateurA1]))
    expect(journal.rows[0].n).toBeGreaterThan(0)
  })

  it('la déconnexion révoque la session : le même cookie ne donne plus rien', async () => {
    const { jeton } = await seConnecter(f.utilisateurA1)
    const sortie = await traiterDeconnexion(requete('/api/auth/deconnexion', { jeton: jeton! }))
    expect(sortie.status).toBe(200)
    expect(sortie.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    const apres = await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))
    expect(apres.status).toBe(401)
  })

  it('un jeton inventé ou absent est refusé', async () => {
    expect((await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: 'jeton-forge' }))).status).toBe(401)
    expect((await traiterMoi(requete('/api/auth/moi', { method: 'GET' }))).status).toBe(401)
  })
})

describe('Connexion — refus', () => {
  it('mauvais mot de passe et email inconnu : réponse strictement identique (pas d’énumération de comptes)', async () => {
    const mauvais = await traiterConnexion(requete('/api/auth/connexion', { corps: { email: emailDe(f.utilisateurA1), motDePasse: 'faux' } }))
    const inconnu = await traiterConnexion(requete('/api/auth/connexion', { corps: { email: `inconnu-${randomUUID()}@test.local`, motDePasse: 'faux' } }))
    expect(mauvais.status).toBe(401)
    expect(inconnu.status).toBe(401)
    expect(await mauvais.json()).toEqual(await inconnu.json())
    expect(mauvais.headers.get('set-cookie')).toBeNull()
  })

  it('chaque échec est enregistré, et la limitation freine au-delà du seuil', async () => {
    const email = `limite-${randomUUID()}@test.local`
    const ip = ipAleatoire()
    for (let i = 0; i < 5; i++) {
      const r = await traiterConnexion(requete('/api/auth/connexion', { corps: { email, motDePasse: 'faux' }, ip }))
      expect(r.status).toBe(401)
    }
    const bloque = await traiterConnexion(requete('/api/auth/connexion', { corps: { email, motDePasse: 'faux' }, ip }))
    expect(bloque.status).toBe(429)
    expect(bloque.headers.get('retry-after')).toBeTruthy()
    const n = await avecMigrate((c) => c.query('SELECT count(*)::int AS n FROM tentative_connexion WHERE email = $1', [email]))
    expect(n.rows[0].n).toBe(5)
  })

  it('un compte inactif ne peut pas se connecter', async () => {
    await avecMigrate((c) => c.query('UPDATE utilisateur SET actif = false WHERE id = $1', [fi.consultantSansAcces]))
    try {
      const { reponse } = await seConnecter(fi.consultantSansAcces)
      expect(reponse.status).toBe(401)
    } finally {
      await avecMigrate((c) => c.query('UPDATE utilisateur SET actif = true WHERE id = $1', [fi.consultantSansAcces]))
    }
  })

  it('un compte sans mot de passe défini ne peut pas se connecter', async () => {
    await avecMigrate((c) => c.query('UPDATE utilisateur SET mot_de_passe_hash = NULL WHERE id = $1', [fi.consultantSansAcces]))
    const { reponse } = await seConnecter(fi.consultantSansAcces)
    expect(reponse.status).toBe(401)
  })

  it("un compte dont la 2FA est activée n'obtient qu'une session PARTIELLE : inutilisable tant que le code n'est pas saisi", async () => {
    await avecMigrate((c) => c.query('UPDATE utilisateur SET totp_actif = true WHERE id = $1', [f.utilisateurB1]))
    try {
      const { reponse, jeton, corps } = await seConnecter(f.utilisateurB1, MOT_DE_PASSE, false)
      expect(reponse.status).toBe(200)
      expect(corps).toMatchObject({ a2f: 'code', destination: '/connexion/2fa' })
      expect((await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))).status).toBe(401)
    } finally {
      await avecMigrate((c) => c.query('UPDATE utilisateur SET totp_actif = false WHERE id = $1', [f.utilisateurB1]))
    }
  })

  it("les entreprises désactivées ferment la connexion de leurs utilisateurs", async () => {
    await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseB]))
    try {
      const { reponse } = await seConnecter(f.utilisateurB1)
      expect(reponse.status).toBe(401)
    } finally {
      await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = NULL WHERE id = $1', [f.entrepriseB]))
    }
  })

  it("protection CSRF : sans en-tête Origin, ou avec l'Origin d'un autre site, la requête est refusée", async () => {
    const corps = { email: emailDe(f.utilisateurA1), motDePasse: MOT_DE_PASSE }
    expect((await traiterConnexion(requete('/api/auth/connexion', { corps, origine: null }))).status).toBe(403)
    expect((await traiterConnexion(requete('/api/auth/connexion', { corps, origine: 'https://site-malveillant.example' }))).status).toBe(403)
  })

  it('corps invalide : 400', async () => {
    const r = await traiterConnexion(requete('/api/auth/connexion', { corps: { email: 123 } }))
    expect(r.status).toBe(400)
  })

  it("l'email est globalement unique parmi les utilisateurs actifs", async () => {
    await avecMigrate(async (c) => {
      await expect(
        c.query("INSERT INTO utilisateur (entreprise_id, email, nom) VALUES ($1, $2, 'Doublon')", [f.entrepriseB, emailDe(f.utilisateurA1).toUpperCase()]),
      ).rejects.toMatchObject({ code: '23505' })
    })
  })
})

describe('Sonde de tenant — le client ne voit que son entreprise, et le module doit être actif', () => {
  it('module inspections non souscrit : refusé même pour un utilisateur légitime', async () => {
    const { jeton } = await seConnecter(f.utilisateurA1)
    expect((await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))).status).toBe(403)
  })

  it('module souscrit : l’utilisateur A voit uniquement les données de A', async () => {
    await avecMigrate(async (c) => {
      await c.query("INSERT INTO abonnement_module (entreprise_id, module) VALUES ($1, 'inspections'), ($2, 'inspections')", [f.entrepriseA, f.entrepriseB])
    })
    const { jeton } = await seConnecter(f.utilisateurA1)
    const r = await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ entrepriseId: f.entrepriseA, inspections: 2 }) // inspectionA et inspectionA2
  })

  it("un utilisateur d'une entreprise cliente n'a aucun sélecteur ni moyen de changer d'entreprise", async () => {
    const { jeton, corps } = await seConnecter(f.utilisateurA1)
    expect(corps.destination).toBe('/connexion/2fa') // 2FA obligatoire (rôle client avec 2FA requise) : la destination finale suit la saisie du code
    expect((await traiterListeEntreprises(requete('/api/auth/entreprises', { method: 'GET', jeton: jeton! }))).status).toBe(403)
    const choix = await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseB }, jeton: jeton! }))
    expect(choix.status).toBe(403)
    // …et sa session est restée sur A.
    const moi = await (await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))).json()
    expect(moi.entrepriseId).toBe(f.entrepriseA)
  })
})

describe('Consultant — sélecteur de tenant et contrôle d’accès à chaque requête', () => {
  it('connexion : pas d’entreprise sur la session, destination = sélecteur, sonde refusée tant qu’aucune n’est choisie', async () => {
    const { jeton, corps } = await seConnecter(f.consultantC1)
    expect(corps.destination).toBe('/connexion/2fa') // consultant : 2FA obligatoire
    const moi = await (await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))).json()
    expect(moi).toMatchObject({ consultant: true, entrepriseId: null })
    expect((await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))).status).toBe(409)
  })

  it('le sélecteur liste les entreprises à accès valide (avec nom) — B, pas A', async () => {
    const { jeton } = await seConnecter(f.consultantC1)
    const r = await traiterListeEntreprises(requete('/api/auth/entreprises', { method: 'GET', jeton: jeton! }))
    expect(r.status).toBe(200)
    const { entreprises } = (await r.json()) as { entreprises: { id: string, nom: string }[] }
    expect(entreprises.map((e) => e.id)).toContain(f.entrepriseB)
    expect(entreprises.map((e) => e.id)).not.toContain(f.entrepriseA)
    expect(entreprises.find((e) => e.id === f.entrepriseB)!.nom).toMatch(/Test Cloisonnement B/)
  })

  it('choisir B (accès valide) : la sonde lit B, et seulement B', async () => {
    const { jeton } = await seConnecter(f.consultantC1)
    const choix = await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseB }, jeton: jeton! }))
    expect(choix.status).toBe(200)
    const sonde = await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))
    expect(sonde.status).toBe(200)
    expect(await sonde.json()).toEqual({ entrepriseId: f.entrepriseB, inspections: 1 })
  })

  it("choisir A (jamais accordé) est refusé, et la session n'y entre pas", async () => {
    const { jeton } = await seConnecter(f.consultantC1)
    const choix = await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseA }, jeton: jeton! }))
    expect(choix.status).toBe(403)
    const moi = await (await traiterMoi(requete('/api/auth/moi', { method: 'GET', jeton: jeton! }))).json()
    expect(moi.entrepriseId).toBeNull()
  })

  it('un accès dont la date de fin est dépassée ne permet pas de choisir l’entreprise', async () => {
    const { jeton } = await seConnecter(fi.consultantExpire)
    const liste = (await (await traiterListeEntreprises(requete('/api/auth/entreprises', { method: 'GET', jeton: jeton! }))).json()) as { entreprises: unknown[] }
    expect(liste.entreprises).toEqual([])
    const choix = await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseA }, jeton: jeton! }))
    expect(choix.status).toBe(403)
  })

  it("le mandat qui expire EN COURS de session coupe l'accès à la requête suivante", async () => {
    const { jeton } = await seConnecter(fi.consultantLecture)
    expect((await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseA }, jeton: jeton! }))).status).toBe(200)
    expect((await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))).status).toBe(200)

    await avecMigrate((c) => c.query('UPDATE acces_consultant SET fin_le = CURRENT_DATE - 1 WHERE utilisateur_id = $1', [fi.consultantLecture]))
    const apres = await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))
    expect(apres.status).toBe(403)
  })

  it("l'entreprise désactivée EN COURS de session coupe l'accès, même avec un mandat valide", async () => {
    const { jeton } = await seConnecter(f.consultantC1)
    await traiterChoixEntreprise(requete('/api/auth/entreprise', { corps: { entrepriseId: f.entrepriseB }, jeton: jeton! }))
    expect((await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))).status).toBe(200)

    await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = now() WHERE id = $1', [f.entrepriseB]))
    try {
      expect((await traiterSondeTenant(requete('/api/auth/sonde', { method: 'GET', jeton: jeton! }))).status).toBe(403)
    } finally {
      await avecMigrate((c) => c.query('UPDATE entreprise SET desactive_le = NULL WHERE id = $1', [f.entrepriseB]))
    }
  })

  it('la sélection est journalisée', async () => {
    const n = await avecMigrate((c) => c.query("SELECT count(*)::int AS n FROM journal_audit WHERE action = 'selection_entreprise' AND utilisateur_id = $1", [f.consultantC1]))
    expect(n.rows[0].n).toBeGreaterThan(0)
  })
})

describe('admin_plateforme — accès à part, rôle vérifié depuis la session', () => {
  it('un admin_plateforme se connecte sans entreprise et peut lancer une opération autorisée (journalisée)', async () => {
    const { jeton, corps } = await seConnecter(f.adminPlateformeP1)
    expect(corps.destination).toBe('/connexion/2fa') // admin_plateforme : 2FA obligatoire
    const lignes = await avecPlateformeAdmin(jeton, 'lister_entreprises', (trx) => trx.selectFrom('entreprise').select('id').execute())
    expect(lignes.map((l) => l.id)).toContain(f.entrepriseA)
    const n = await avecMigrate((c) => c.query("SELECT count(*)::int AS n FROM journal_audit WHERE action = 'lister_entreprises' AND utilisateur_id = $1", [f.adminPlateformeP1]))
    expect(n.rows[0].n).toBeGreaterThan(0)
  })

  it('un consultant ou un utilisateur client ne peut pas prendre le contexte admin_plateforme', async () => {
    for (const utilisateur of [f.consultantC1, f.utilisateurA1]) {
      const { jeton } = await seConnecter(utilisateur)
      await expect(avecPlateformeAdmin(jeton, 'lister_entreprises', async () => 'x')).rejects.toBeInstanceOf(ErreurAcces)
    }
    await expect(avecPlateformeAdmin(null, 'lister_entreprises', async () => 'x')).rejects.toMatchObject({ statut: 401 })
  })
})
