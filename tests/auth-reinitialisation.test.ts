import { createHash, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hacherMotDePasse } from '@/auth/password'
import { traiterConnexion, traiterDemandeReinitialisation, traiterReinitialisation } from '@/auth/routes'
import type { Courriel } from '@/notifications/email'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Migration 0045 : réinitialisation du mot de passe par e-mail. Request → Response, base réelle, rôle ifecarm_app.
 * L'envoi est remplacé par une boîte aux lettres factice : on lit ce qui AURAIT été envoyé.
 */

const ANCIEN = 'ancien-mot-de-passe-de-test'
const NOUVEAU = 'nouveau-mot-de-passe-de-test'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`

let f: Fixtures
const ids: string[] = []
const emails = new Map<string, string>()
let boite: Courriel[] = []
const envoyer = async (c: Courriel) => { boite.push(c) }

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
const requete = (chemin: string, corps: unknown, o: { ip?: string, origine?: string, jeton?: string } = {}) => new Request(`${ORIGINE}${chemin}`, {
  method: 'POST',
  headers: { host: HOTE, origin: o.origine ?? ORIGINE, 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? ip(), ...(o.jeton ? { cookie: `ifecarm_session=${encodeURIComponent(o.jeton)}` } : {}) },
  body: JSON.stringify(corps),
})
const demander = (email: string, o: { ip?: string } = {}) => traiterDemandeReinitialisation(requete('/api/auth/mot-de-passe-oublie', { email }, o), envoyer)
const reinitialiser = (jeton: unknown, motDePasse: unknown) => traiterReinitialisation(requete('/api/auth/reinitialiser', { jeton, motDePasse }))
const jetonDuCourriel = (c: Courriel) => decodeURIComponent(c.texte.match(/jeton=([^\s]+)/)![1]!)

async function creerUtilisateur(role = 'declarant', actif = true): Promise<string> {
  const email = `reset-${randomUUID().slice(0, 10)}@test.local`
  const hash = await hacherMotDePasse(ANCIEN)
  const id = await migrate(async (c) => {
    const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash, actif) VALUES ($1, $2, $3, $4, $5) RETURNING id', [f.entrepriseA, email, 'Personne Test', hash, actif])
    await c.query('INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, $2)', [u.id, role])
    return u.id as string
  })
  ids.push(id)
  emails.set(id, email)
  return id
}
/** Demande un lien pour `id` et renvoie le jeton lu dans le courriel. */
async function lien(id: string, o: { ip?: string } = {}): Promise<string> {
  boite = []
  await demander(emails.get(id)!, o)
  expect(boite).toHaveLength(1)
  return jetonDuCourriel(boite[0]!)
}
const seConnecter = (id: string, mdp: string) => traiterConnexion(requete('/api/auth/connexion', { email: emails.get(id), motDePasse: mdp }))

beforeAll(async () => { f = await creerFixtures() })
afterAll(async () => {
  try { await migrate((c) => c.query('DELETE FROM utilisateur WHERE id = ANY($1)', [ids])) } catch { /* journal */ }
  try { await nettoyerFixtures(f) } catch { /* idem */ }
})

describe('Demande de lien', () => {
  it('réponse strictement identique pour un compte connu, inconnu, inactif ou une adresse invalide ; e-mail envoyé au seul compte actif', async () => {
    const connu = await creerUtilisateur()
    const inactif = await creerUtilisateur('declarant', false)
    boite = []
    const reponses = await Promise.all([emails.get(connu)!, emails.get(inactif)!, `inconnu-${randomUUID()}@test.local`, 'pas-une-adresse', ''].map((e) => demander(e)))
    const corps = await Promise.all(reponses.map(async (r) => ({ status: r.status, corps: await r.json() })))
    for (const c of corps) expect(c).toEqual(corps[0])
    expect(corps[0]!.status).toBe(200)
    expect(boite.map((c) => c.a)).toEqual([emails.get(connu)])
  })

  it('le courriel porte un lien /reinitialiser?jeton=… valable 60 min ; seul le hash du jeton est en base', async () => {
    const id = await creerUtilisateur()
    const jeton = await lien(id)
    expect(boite[0]!.texte).toMatch(/\/reinitialiser\?jeton=/)
    expect(boite[0]!.texte).toMatch(/60 minutes/)
    expect(boite[0]!.sujet).toMatch(/Réinitialisation/)
    const lignes = await migrate(async (c) => (await c.query('SELECT jeton_hash, expire_le FROM password_reset_token WHERE utilisateur_id = $1', [id])).rows)
    expect(lignes).toHaveLength(1)
    expect(lignes[0].jeton_hash).toBe(createHash('sha256').update(jeton).digest('hex'))
    expect(JSON.stringify(lignes)).not.toContain(jeton)
    const minutes = (lignes[0].expire_le.getTime() - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(58)
    expect(minutes).toBeLessThanOrEqual(60.5)
  })

  it('limite par compte : 3 demandes par heure, la 4e est silencieusement ignorée', async () => {
    const id = await creerUtilisateur()
    boite = []
    for (let i = 0; i < 5; i++) expect((await demander(emails.get(id)!)).status).toBe(200)
    expect(boite).toHaveLength(3)
  })

  it('limite par adresse IP : 10 demandes par heure toutes adresses confondues', async () => {
    const adresse = ip()
    const comptes = await Promise.all(Array.from({ length: 12 }, () => creerUtilisateur()))
    boite = []
    for (const c of comptes) expect((await demander(emails.get(c)!, { ip: adresse })).status).toBe(200)
    expect(boite).toHaveLength(10)
  })

  it('origine étrangère refusée (CSRF)', async () => {
    const r = await traiterDemandeReinitialisation(requete('/api/auth/mot-de-passe-oublie', { email: 'x@test.local' }, { origine: 'http://evil.example' }), envoyer)
    expect(r.status).toBe(403)
  })
})

describe('Nouveau mot de passe', () => {
  it('le lien sert une seule fois : le mot de passe change, l’ancien ne marche plus', async () => {
    const id = await creerUtilisateur()
    const jeton = await lien(id)
    expect((await reinitialiser(jeton, NOUVEAU)).status).toBe(200)
    expect((await seConnecter(id, NOUVEAU)).status).toBe(200)
    expect((await seConnecter(id, ANCIEN)).status).toBe(401)
    expect((await reinitialiser(jeton, 'encore-un-autre-mot-de-passe')).status).toBe(400)
    expect((await seConnecter(id, NOUVEAU)).status).toBe(200) // le 2e essai n'a rien changé
  })

  it('jeton inventé, trop court, absent ou expiré : « lien invalide ou expiré », même message', async () => {
    const id = await creerUtilisateur()
    const jeton = await lien(id)
    await migrate((c) => c.query("UPDATE password_reset_token SET expire_le = now() - interval '1 minute' WHERE utilisateur_id = $1", [id]))
    const reponses = await Promise.all([reinitialiser(jeton, NOUVEAU), reinitialiser('x'.repeat(43), NOUVEAU), reinitialiser('court', NOUVEAU), reinitialiser(undefined, NOUVEAU)])
    for (const r of reponses) {
      expect(r.status).toBe(400)
      expect((await r.json()).erreur ?? (await r.clone().text())).toMatch(/invalide ou expiré/i)
    }
    expect((await seConnecter(id, NOUVEAU)).status).toBe(401)
  })

  it('politique de mot de passe : 10 caractères minimum, 200 maximum ; un refus ne consomme pas le lien', async () => {
    const id = await creerUtilisateur()
    const jeton = await lien(id)
    expect((await reinitialiser(jeton, 'court')).status).toBe(400)
    expect((await reinitialiser(jeton, 'x'.repeat(201))).status).toBe(400)
    expect((await reinitialiser(jeton, 12345678901234)).status).toBe(400)
    expect((await reinitialiser(jeton, NOUVEAU)).status).toBe(200)
  })

  it('un nouveau lien invalide-t-il les précédents ? Chaque lien reste valable une fois, jamais deux comptes', async () => {
    const a = await creerUtilisateur()
    const b = await creerUtilisateur()
    const ja = await lien(a)
    const jb = await lien(b)
    expect((await reinitialiser(ja, NOUVEAU)).status).toBe(200)
    expect((await seConnecter(b, ANCIEN)).status).toBe(200) // le compte B n'a pas bougé
    expect((await reinitialiser(jb, NOUVEAU)).status).toBe(200)
  })

  it('réinitialiser révoque les sessions et les appareils de confiance, sans toucher à la 2FA', async () => {
    const id = await creerUtilisateur('admin_entreprise')
    await migrate(async (c) => {
      await c.query("UPDATE utilisateur SET totp_actif = true, totp_secret_chiffre = 'iv:tag:ct' WHERE id = $1", [id])
      await c.query("INSERT INTO appareil_confiance (utilisateur_id, jeton_hash, expire_le) VALUES ($1, $2, now() + interval '30 days')", [id, randomUUID().replace(/-/g, '')])
    })
    await seConnecter(id, ANCIEN)
    // Session libérée en base pour pouvoir constater ensuite qu'elle a bien été révoquée.
    await migrate((c) => c.query("UPDATE session SET a2f_validee_le = now(), a2f_etape = NULL WHERE utilisateur_id = $1", [id]))

    expect((await reinitialiser(await lien(id), NOUVEAU)).status).toBe(200)

    const etat = await migrate(async (c) => ({
      sessions: (await c.query('SELECT count(*)::int AS n FROM session WHERE utilisateur_id = $1 AND revoque_le IS NULL', [id])).rows[0].n,
      appareils: (await c.query('SELECT count(*)::int AS n FROM appareil_confiance WHERE utilisateur_id = $1 AND revoque_le IS NULL', [id])).rows[0].n,
      u: (await c.query('SELECT totp_actif, totp_secret_chiffre FROM utilisateur WHERE id = $1', [id])).rows[0],
    }))
    expect(etat.sessions).toBe(0)
    expect(etat.appareils).toBe(0)
    expect(etat.u).toMatchObject({ totp_actif: true, totp_secret_chiffre: 'iv:tag:ct' })
  })
})
