import { createHash, randomUUID } from 'node:crypto'
import * as OTPAuth from 'otpauth'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { traiterReinitialisation2fa } from '@/administration/routes'
import { hacherMotDePasse } from '@/auth/password'
import { jetonDepuisRequete } from '@/auth/http'
import {
  traiterCodesSecours2fa, traiterConnexion, traiterDesactivation2fa, traiterConfirmationActivation2fa, traiterDemarrageActivation2fa,
  traiterEtat2fa, traiterMoi, traiterRevocationAppareils, traiterVerification2fa,
} from '@/auth/routes'
import { libererA2f } from './aide-a2f'
import { creerFixtures, nettoyerFixtures, type Fixtures } from './fixtures'

/**
 * Migration 0045 : double authentification (TOTP). Request → Response, base réelle, rôle ifecarm_app.
 * Les secrets sont lus en base (rôle de migration) uniquement pour contrôler qu'ils y sont chiffrés ou pour fabriquer le
 * code que produirait l'application d'authentification.
 */

const MOT_DE_PASSE = 'mot-de-passe-de-test-jamais-utilise'
const HOTE = 'localhost:3000'
const ORIGINE = `http://${HOTE}`
const PAS = 30_000

let f: Fixtures
const ids: string[] = []
const emails = new Map<string, string>()

const migrate = async <T>(cb: (c: Client) => Promise<T>): Promise<T> => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try { return await cb(c) } finally { await c.end() }
}
const ip = () => `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`

function requete(chemin: string, o: { methode?: string, corps?: unknown, jeton?: string | null, appareil?: string } = {}): Request {
  const cookies: string[] = []
  if (o.jeton) cookies.push(`ifecarm_session=${encodeURIComponent(o.jeton)}`)
  if (o.appareil) cookies.push(`ifecarm_appareil=${encodeURIComponent(o.appareil)}`)
  return new Request(`${ORIGINE}${chemin}`, {
    method: o.methode ?? 'POST',
    headers: { host: HOTE, origin: ORIGINE, 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
    body: o.corps === undefined ? undefined : JSON.stringify(o.corps),
  })
}
const cookieDe = (r: Response, nom: string) => {
  const m = r.headers.get('set-cookie')?.match(new RegExp(`${nom}=([^;]*)`))
  return m ? decodeURIComponent(m[1]!) : null
}
const lire = async (r: Response) => (await r.clone().json()) as Record<string, any>

/** Code que produirait l'application d'authentification, au pas courant + `decalage` (−1, 0, +1 acceptés par le serveur). */
const codeTotp = (secret: string, decalage = 0) =>
  new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + decalage * PAS })

async function creerUtilisateur(role: string): Promise<string> {
  const email = `a2f-${randomUUID().slice(0, 10)}@test.local`
  const hash = await hacherMotDePasse(MOT_DE_PASSE)
  const id = await migrate(async (c) => {
    const { rows: [u] } = await c.query('INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id', [f.entrepriseA, email, `A2F ${role}`, hash])
    await c.query('INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, $2)', [u.id, role])
    return u.id as string
  })
  ids.push(id)
  emails.set(id, email)
  return id
}

async function connecter(id: string, o: { appareil?: string } = {}) {
  const r = await traiterConnexion(requete('/api/auth/connexion', { corps: { email: emails.get(id), motDePasse: MOT_DE_PASSE }, appareil: o.appareil }))
  const jeton = cookieDe(r, 'ifecarm_session')
  return { r, jeton, corps: await lire(r) }
}
const moi = async (jeton: string) => (await traiterMoi(requete('/api/auth/moi', { methode: 'GET', jeton }))).status

/** Active la 2FA d'un compte (activation à la connexion) ; renvoie le secret, les codes de secours et la session pleine. */
async function activer(id: string) {
  const { jeton } = await connecter(id)
  const dem = await lire(await traiterDemarrageActivation2fa(requete('/api/auth/2fa/activation/demarrer', { jeton })))
  const conf = await traiterConfirmationActivation2fa(requete('/api/auth/2fa/activation/confirmer', { jeton, corps: { code: codeTotp(dem.secret, -1) } }))
  expect(conf.status).toBe(200)
  return { secret: dem.secret as string, codes: (await lire(conf)).codesSecours as string[], jeton: jeton! }
}
/** Le pas d'un code déjà consommé ne peut plus servir (anti-rejeu) : les tests qui enchaînent plusieurs saisies remettent le compteur à zéro. */
const oublierPas = (id: string) => migrate((c) => c.query('UPDATE utilisateur SET totp_dernier_pas = NULL WHERE id = $1', [id]))

beforeAll(async () => {
  f = await creerFixtures()
  await migrate(async (c) => {
    const { rows } = await c.query('SELECT id, email::text FROM utilisateur WHERE id = ANY($1)', [[f.adminPlateformeP1, f.consultantC1, f.utilisateurA1]])
    rows.forEach((r) => emails.set(r.id, r.email))
  })
})

afterAll(async () => {
  try { await migrate((c) => c.query('DELETE FROM utilisateur WHERE id = ANY($1)', [ids])) } catch { /* journal : cf. tenant-isolation.test.ts */ }
  try { await nettoyerFixtures(f) } catch { /* idem */ }
})

describe('2FA — session partielle et activation', () => {
  it('rôle à 2FA obligatoire sans 2FA : session PARTIELLE (étape « activation »), inutilisable ailleurs, mais la page 2FA la lit', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { r, jeton, corps } = await connecter(u)
    expect(r.status).toBe(200)
    expect(corps).toMatchObject({ a2f: 'activation', destination: '/connexion/2fa' })
    expect(await moi(jeton!)).toBe(401)
    const etat = await lire(await traiterEtat2fa(requete('/api/auth/2fa/etat', { methode: 'GET', jeton })))
    expect(etat).toMatchObject({ etape: 'activation', actif: false, obligatoire: true, codesRestants: 0 })
  })

  it('rôle optionnel sans 2FA : session complète directement', async () => {
    const u = await creerUtilisateur('declarant')
    const { corps, jeton } = await connecter(u)
    expect(corps.a2f ?? null).toBeNull()
    expect(await moi(jeton!)).toBe(200)
  })

  it('activation : secret chiffré au repos, 10 codes de secours hachés, session libérée ; mauvais code refusé', async () => {
    const u = await creerUtilisateur('responsable_qhse')
    const { jeton } = await connecter(u)
    const dem = await lire(await traiterDemarrageActivation2fa(requete('/api/auth/2fa/activation/demarrer', { jeton })))
    expect(dem.secret).toMatch(/^[A-Z2-7]{20,}$/)
    expect(dem.uri).toMatch(/^otpauth:\/\/totp\//)
    expect(dem.qr).toMatch(/^data:image\/png/)

    const mauvais = await traiterConfirmationActivation2fa(requete('/api/auth/2fa/activation/confirmer', { jeton, corps: { code: '000000' } }))
    expect(mauvais.status).toBe(400)
    expect(await moi(jeton!)).toBe(401)

    const conf = await traiterConfirmationActivation2fa(requete('/api/auth/2fa/activation/confirmer', { jeton, corps: { code: codeTotp(dem.secret, -1) } }))
    expect(conf.status).toBe(200)
    const { codesSecours } = await lire(conf)
    expect(codesSecours).toHaveLength(10)
    expect(new Set(codesSecours).size).toBe(10)
    expect(await moi(jeton!)).toBe(200)

    const { u: ligne, codes } = await migrate(async (c) => ({
      u: (await c.query('SELECT totp_actif, totp_secret_chiffre, totp_secret_en_attente_chiffre FROM utilisateur WHERE id = $1', [u])).rows[0],
      codes: (await c.query('SELECT code_hash FROM code_secours_2fa WHERE utilisateur_id = $1', [u])).rows.map((r) => r.code_hash as string),
    }))
    expect(ligne.totp_actif).toBe(true)
    expect(ligne.totp_secret_en_attente_chiffre).toBeNull()
    expect(ligne.totp_secret_chiffre).not.toContain(dem.secret)
    expect(ligne.totp_secret_chiffre.split(':')).toHaveLength(3)
    expect(codes).toHaveLength(10)
    for (const c of codesSecours as string[]) expect(codes.some((h) => h.includes(c.replace(/[^A-Za-z0-9]/g, '')))).toBe(false)
  })
})

describe('2FA — connexion avec code', () => {
  it('étape « code » : mauvais code refusé, bon code accepté ; le MÊME code ne sert pas deux fois (anti-rejeu)', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { secret } = await activer(u)
    await oublierPas(u)

    const a = await connecter(u)
    expect(a.corps).toMatchObject({ a2f: 'code', destination: '/connexion/2fa' })
    expect(await moi(a.jeton!)).toBe(401)
    expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: a.jeton, corps: { code: '123456' } }))).status).toBe(403)
    const bon = codeTotp(secret)
    const ok = await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: a.jeton, corps: { code: bon } }))
    expect(ok.status).toBe(200)
    expect((await lire(ok)).destination).toBe('/')
    expect(await moi(a.jeton!)).toBe(200)

    const b = await connecter(u)
    expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: b.jeton, corps: { code: bon } }))).status).toBe(403)
  })

  it('5 mauvais codes révoquent la session : même le bon code ne la sauve plus', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { secret } = await activer(u)
    await oublierPas(u)
    const { jeton } = await connecter(u)
    for (let i = 0; i < 5; i++) {
      expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton, corps: { code: '000000' } }))).status).toBeGreaterThanOrEqual(400)
    }
    const apres = await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton, corps: { code: codeTotp(secret) } }))
    expect(apres.status).toBeGreaterThanOrEqual(401)
    expect(await moi(jeton!)).toBe(401)
  })

  it('code de secours : accepté une seule fois, le compteur diminue ; régénération avec un code TOTP remplace les anciens', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { secret, codes } = await activer(u)
    await oublierPas(u)

    const a = await connecter(u)
    const ok = await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: a.jeton, corps: { code: codes[0], secours: true } }))
    expect(ok.status).toBe(200)
    expect((await lire(ok)).codesSecoursRestants).toBe(9)

    const b = await connecter(u)
    expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: b.jeton, corps: { code: codes[0], secours: true } }))).status).toBe(403)

    // Session pleine (a) : régénérer les codes exige un code TOTP valide.
    expect((await traiterCodesSecours2fa(requete('/api/auth/2fa/codes-secours', { jeton: a.jeton, corps: { code: '000000' } }))).status).toBe(400)
    const regen = await traiterCodesSecours2fa(requete('/api/auth/2fa/codes-secours', { jeton: a.jeton, corps: { code: codeTotp(secret, 1) } }))
    expect(regen.status).toBe(200)
    const nouveaux = (await lire(regen)).codesSecours as string[]
    expect(nouveaux).toHaveLength(10)
    const c = await connecter(u)
    expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: c.jeton, corps: { code: codes[1], secours: true } }))).status).toBe(403) // ancien code : remplacé
    expect((await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: c.jeton, corps: { code: nouveaux[0], secours: true } }))).status).toBe(200)
  })
})

describe('2FA — appareil de confiance (30 jours, révocable)', () => {
  it('« mémoriser » pose un cookie ; la connexion suivante n’exige plus le code ; la révocation le rétablit ; seul le hash est en base', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { secret } = await activer(u)
    await oublierPas(u)

    const a = await connecter(u)
    const ok = await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: a.jeton, corps: { code: codeTotp(secret), memoriser: true } }))
    expect(ok.status).toBe(200)
    const appareil = cookieDe(ok, 'ifecarm_appareil')
    expect(appareil).toBeTruthy()
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/)
    const stocke = await migrate(async (c) => (await c.query('SELECT jeton_hash, expire_le FROM appareil_confiance WHERE utilisateur_id = $1', [u])).rows)
    expect(stocke).toHaveLength(1)
    expect(stocke[0].jeton_hash).toBe(createHash('sha256').update(appareil!).digest('hex'))
    expect(JSON.stringify(stocke)).not.toContain(appareil!)
    expect(stocke[0].expire_le.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000)
    expect(stocke[0].expire_le.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 60_000)

    const b = await connecter(u, { appareil: appareil! })
    expect(b.corps.a2f ?? null).toBeNull()
    expect(await moi(b.jeton!)).toBe(200)
    // Un cookie inventé ne vaut rien.
    expect((await connecter(u, { appareil: 'appareil-forge' })).corps.a2f).toBe('code')

    const rev = await traiterRevocationAppareils(requete('/api/auth/2fa/appareils/revoquer', { jeton: b.jeton }))
    expect(rev.status).toBe(200)
    expect(rev.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await connecter(u, { appareil: appareil! })).corps.a2f).toBe('code')
  })

  it('l’appareil d’un AUTRE compte ne dispense pas du code', async () => {
    const u1 = await creerUtilisateur('admin_entreprise')
    const u2 = await creerUtilisateur('admin_entreprise')
    const s1 = await activer(u1)
    await activer(u2)
    await oublierPas(u1)
    const a = await connecter(u1)
    const ok = await traiterVerification2fa(requete('/api/auth/2fa/verifier', { jeton: a.jeton, corps: { code: codeTotp(s1.secret), memoriser: true } }))
    expect((await connecter(u2, { appareil: cookieDe(ok, 'ifecarm_appareil')! })).corps.a2f).toBe('code')
  })
})

describe('2FA — désactivation et réinitialisation par l’admin', () => {
  it('désactivation refusée pour un rôle obligatoire', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const { secret, jeton } = await activer(u)
    await oublierPas(u)
    const r = await traiterDesactivation2fa(requete('/api/auth/2fa/desactiver', { jeton, corps: { motDePasse: MOT_DE_PASSE, code: codeTotp(secret) } }))
    expect(r.status).toBe(409)
    expect((await migrate((c) => c.query('SELECT totp_actif FROM utilisateur WHERE id = $1', [u]))).rows[0].totp_actif).toBe(true)
  })

  it('rôle optionnel : activation volontaire depuis « Mon compte », désactivation avec mot de passe ET code', async () => {
    const u = await creerUtilisateur('declarant')
    const { jeton } = await connecter(u)
    const dem = await lire(await traiterDemarrageActivation2fa(requete('/api/auth/2fa/activation/demarrer', { jeton })))
    expect((await traiterConfirmationActivation2fa(requete('/api/auth/2fa/activation/confirmer', { jeton, corps: { code: codeTotp(dem.secret, -1) } }))).status).toBe(200)
    expect(await moi(jeton!)).toBe(200)

    await oublierPas(u)
    const mauvaisMdp = await traiterDesactivation2fa(requete('/api/auth/2fa/desactiver', { jeton, corps: { motDePasse: 'faux-faux-faux', code: codeTotp(dem.secret) } }))
    expect(mauvaisMdp.status).toBe(400)
    const mauvaisCode = await traiterDesactivation2fa(requete('/api/auth/2fa/desactiver', { jeton, corps: { motDePasse: MOT_DE_PASSE, code: '000000' } }))
    expect(mauvaisCode.status).toBe(400)
    const ok = await traiterDesactivation2fa(requete('/api/auth/2fa/desactiver', { jeton, corps: { motDePasse: MOT_DE_PASSE, code: codeTotp(dem.secret) } }))
    expect(ok.status).toBe(200)
    const ligne = (await migrate((c) => c.query('SELECT totp_actif, totp_secret_chiffre FROM utilisateur WHERE id = $1', [u]))).rows[0]
    expect(ligne).toMatchObject({ totp_actif: false, totp_secret_chiffre: null })
    expect((await connecter(u)).corps.a2f ?? null).toBeNull()
  })

  it('réinitialisation par l’admin : 2FA effacée, codes/appareils/sessions révoqués, journalisée ; retour à l’étape « activation »', async () => {
    const u = await creerUtilisateur('admin_entreprise')
    const s = await activer(u)
    const admin = await connecter(f.adminPlateformeP1)
    await libererA2f(admin.jeton!)

    const r = await traiterReinitialisation2fa(requete(`/api/administration/comptes/${u}/2fa`, { jeton: admin.jeton }), u)
    expect(r.status).toBe(200)
    expect(await moi(s.jeton)).toBe(401) // sa session ouverte est révoquée
    const etat = await migrate(async (c) => ({
      u: (await c.query('SELECT totp_actif, totp_secret_chiffre FROM utilisateur WHERE id = $1', [u])).rows[0],
      codes: (await c.query('SELECT count(*)::int AS n FROM code_secours_2fa WHERE utilisateur_id = $1', [u])).rows[0].n,
      journal: (await c.query("SELECT count(*)::int AS n FROM journal_audit WHERE action ILIKE '%2fa%' AND utilisateur_id = $1", [f.adminPlateformeP1])).rows[0].n,
    }))
    expect(etat.u).toMatchObject({ totp_actif: false, totp_secret_chiffre: null })
    expect(etat.codes).toBe(0)
    expect(etat.journal).toBeGreaterThan(0)
    expect((await connecter(u)).corps.a2f).toBe('activation')
  })

  it('un admin ne réinitialise pas sa propre 2FA ; un consultant ou un client ne peut pas réinitialiser celle d’autrui', async () => {
    const admin = await connecter(f.adminPlateformeP1)
    await libererA2f(admin.jeton!)
    expect((await traiterReinitialisation2fa(requete('/x', { jeton: admin.jeton }), f.adminPlateformeP1)).status).toBe(409)

    const cible = await creerUtilisateur('declarant')
    const consultant = await connecter(f.consultantC1)
    await libererA2f(consultant.jeton!)
    expect((await traiterReinitialisation2fa(requete('/x', { jeton: consultant.jeton }), cible)).status).toBe(403)
    const client = await connecter(f.utilisateurA1)
    await libererA2f(client.jeton!)
    expect((await traiterReinitialisation2fa(requete('/x', { jeton: client.jeton }), cible)).status).toBe(403)
    expect(jetonDepuisRequete(requete('/x', { jeton: 'a' }))).toBe('a')
  })
})

describe('2FA — origine', () => {
  it('une requête sans origine valide est refusée (CSRF)', async () => {
    const r = new Request(`${ORIGINE}/api/auth/2fa/verifier`, { method: 'POST', headers: { host: HOTE, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect((await traiterVerification2fa(r)).status).toBe(403)
  })
})
