import { createHash, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import { sql } from 'kysely'
import { withAuthenticatedUser, withoutTenant } from '@/db/tenant'
import { ErreurMetier } from '@/inspections/service'
import { ErreurAcces } from './contexte'
import { verifierMotDePasse } from './password'
import { enregistrerTentative, verifierLimiteConnexion } from './rateLimit'
import { compterEchecA2f, validerA2fSession, validerSessionPartielle, type SessionPartielle } from './session'
import { chiffrerSecretTotp, dechiffrerSecretTotp, empreinteCodeSecours, genererSecretTotp, pasTotpValide } from './totp'
import { DUREE_APPAREIL_JOURS } from './http'
import type { Role } from './permissions'

/**
 * Double authentification (TOTP, migration 0045).
 *   - Obligatoire pour l'équipe IFECARM, l'admin d'entreprise et le responsable QHSE ; facultative pour les autres.
 *   - Une session créée après le mot de passe est PARTIELLE tant que le code n'est pas validé : validerSession la refuse
 *     partout, seules les routes de ce module l'acceptent.
 *   - Un code (un pas de 30 s) ne sert qu'une fois (anti-rejeu) ; 5 échecs révoquent la session ; les échecs comptent
 *     aussi dans la limite de connexion du compte.
 *   - 10 codes de secours à usage unique (empreinte HMAC) ; « appareil de confiance » 30 jours (hash du jeton en base).
 */

export const ROLES_A2F_OBLIGATOIRE: Role[] = ['consultant_ifecarm', 'admin_plateforme', 'admin_entreprise', 'responsable_qhse']
export const a2fObligatoire = (roles: Role[]) => roles.some((r) => ROLES_A2F_OBLIGATOIRE.includes(r))

const NB_CODES_SECOURS = 10
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // sans I, O, 0, 1 : lisible à la main
const hacherJeton = (j: string) => createHash('sha256').update(j).digest('hex')

function genererCodesSecours(): string[] {
  return Array.from({ length: NB_CODES_SECOURS }, () => {
    const o = randomBytes(10)
    const c = Array.from(o, (b) => ALPHABET[b % ALPHABET.length]).join('')
    return `${c.slice(0, 5)}-${c.slice(5)}`
  })
}
const normaliserCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '')

async function sessionPartielle(jeton: string | null): Promise<SessionPartielle> {
  if (!jeton) throw new ErreurAcces(401, 'Non connecté.')
  const s = await withoutTenant((trx) => validerSessionPartielle(trx, jeton))
  if (!s) throw new ErreurAcces(401, 'Session expirée.')
  return s
}

const rolesDe = (utilisateurId: string) => withAuthenticatedUser(utilisateurId, async (trx) =>
  (await trx.selectFrom('role_utilisateur').select('role').where('utilisateur_id', '=', utilisateurId).execute()).map((r) => r.role as Role))

const etat2fa = (utilisateurId: string) => withAuthenticatedUser(utilisateurId, async (trx) => {
  const { rows: [e] } = await sql<{ email: string, actif: boolean, secret_chiffre: string | null, secret_attente_chiffre: string | null, dernier_pas: string | null }>`select * from a2f_etat_courant()`.execute(trx)
  if (!e) throw new ErreurAcces(401, 'Compte introuvable.')
  return e
})

// ---------------------------------------------------------------------------
// Appareils de confiance
// ---------------------------------------------------------------------------

/** Vrai si le jeton désigne un appareil de confiance valide de CET utilisateur ; met à jour sa dernière utilisation. */
export async function appareilEstDeConfiance(utilisateurId: string, jeton: string | null | undefined): Promise<boolean> {
  if (!jeton) return false
  return withoutTenant(async (trx) => {
    const r = await trx.updateTable('appareil_confiance').set({ derniere_utilisation: new Date() })
      .where('jeton_hash', '=', hacherJeton(jeton)).where('utilisateur_id', '=', utilisateurId)
      .where('revoque_le', 'is', null).where('expire_le', '>', new Date()).executeTakeFirst()
    return Number(r.numUpdatedRows) === 1
  })
}

async function creerAppareil(utilisateurId: string, adresseIp: string | undefined, userAgent: string | undefined) {
  const jeton = randomBytes(32).toString('base64url')
  const expireLe = new Date(Date.now() + DUREE_APPAREIL_JOURS * 86_400_000)
  await withoutTenant((trx) => trx.insertInto('appareil_confiance')
    .values({ utilisateur_id: utilisateurId, jeton_hash: hacherJeton(jeton), expire_le: expireLe, user_agent: userAgent?.slice(0, 300) ?? null, adresse_ip: adresseIp ?? null }).execute())
  return { jeton, expireLe }
}

export const revoquerAppareilsUtilisateur = (utilisateurId: string) => withoutTenant((trx) =>
  trx.updateTable('appareil_confiance').set({ revoque_le: new Date() }).where('utilisateur_id', '=', utilisateurId).where('revoque_le', 'is', null).execute())

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

export async function etatA2f(jeton: string | null) {
  const s = await sessionPartielle(jeton)
  const [roles, e] = await Promise.all([rolesDe(s.utilisateurId), etat2fa(s.utilisateurId)])
  const [codes, appareils] = await withoutTenant(async (trx) => [
    Number((await trx.selectFrom('code_secours_2fa').select((eb) => eb.fn.countAll<string>().as('n')).where('utilisateur_id', '=', s.utilisateurId).where('utilise_le', 'is', null).executeTakeFirstOrThrow()).n),
    Number((await trx.selectFrom('appareil_confiance').select((eb) => eb.fn.countAll<string>().as('n')).where('utilisateur_id', '=', s.utilisateurId).where('revoque_le', 'is', null).where('expire_le', '>', new Date()).executeTakeFirstOrThrow()).n),
  ])
  return { etape: s.etape, actif: e.actif, obligatoire: a2fObligatoire(roles), codesRestants: codes, appareils }
}

// ---------------------------------------------------------------------------
// Activation (obligatoire à la connexion pour certains rôles, ou volontaire depuis « Mon compte »)
// ---------------------------------------------------------------------------

export async function demarrerActivation(jeton: string | null) {
  const s = await sessionPartielle(jeton)
  if (s.etape === 'code') throw new ErreurAcces(403, 'Saisissez d’abord le code de votre application.')
  const e = await etat2fa(s.utilisateurId)
  if (e.actif) throw new ErreurMetier(409, 'La double authentification est déjà activée.')
  const { secretBase32, uriEnrolement } = genererSecretTotp(e.email)
  await withAuthenticatedUser(s.utilisateurId, (trx) => sql`select a2f_definir_attente(${chiffrerSecretTotp(secretBase32)})`.execute(trx))
  return { secret: secretBase32, uri: uriEnrolement, qr: await QRCode.toDataURL(uriEnrolement, { margin: 1, width: 240 }) }
}

async function enregistrerEchec(email: string, adresseIp: string, session?: SessionPartielle) {
  await withoutTenant(async (trx) => {
    await enregistrerTentative(trx, { email, adresseIp, reussie: false })
    if (session?.etape) await compterEchecA2f(trx, session.sessionId)
  })
}

export async function confirmerActivation(jeton: string | null, code: unknown, adresseIp: string) {
  const s = await sessionPartielle(jeton)
  if (s.etape === 'code') throw new ErreurAcces(403, 'Saisissez d’abord le code de votre application.')
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.replace(/\s/g, ''))) throw new ErreurMetier(400, 'Code à 6 chiffres requis.')
  const e = await etat2fa(s.utilisateurId)
  if (e.actif) throw new ErreurMetier(409, 'La double authentification est déjà activée.')
  if (!e.secret_attente_chiffre) throw new ErreurMetier(409, 'Aucune activation en cours : recommencez.')
  const pas = pasTotpValide(dechiffrerSecretTotp(e.secret_attente_chiffre), code.replace(/\s/g, ''))
  if (pas === null) {
    await enregistrerEchec(e.email, adresseIp, s)
    throw new ErreurMetier(400, 'Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.')
  }
  await withAuthenticatedUser(s.utilisateurId, (trx) => sql`select a2f_activer(${pas}::bigint)`.execute(trx))
  const codes = genererCodesSecours()
  await withoutTenant(async (trx) => {
    await trx.deleteFrom('code_secours_2fa').where('utilisateur_id', '=', s.utilisateurId).execute()
    await trx.insertInto('code_secours_2fa').values(codes.map((c) => ({ utilisateur_id: s.utilisateurId, code_hash: empreinteCodeSecours(normaliserCode(c)) }))).execute()
    if (s.etape === 'activation') await validerA2fSession(trx, s.sessionId)
  })
  return { codesSecours: codes }
}

// ---------------------------------------------------------------------------
// Connexion : saisie du code
// ---------------------------------------------------------------------------

export async function verifierCodeConnexion(
  jeton: string | null,
  params: { code: unknown, secours?: boolean, memoriser?: boolean },
  contexte: { adresseIp: string, userAgent?: string },
) {
  const s = await sessionPartielle(jeton)
  if (s.etape !== 'code') throw new ErreurMetier(409, s.etape === 'activation' ? 'Activez d’abord la double authentification.' : 'Aucun code à saisir.')
  if (typeof params.code !== 'string' || !params.code.trim()) throw new ErreurMetier(400, 'Code requis.')
  const e = await etat2fa(s.utilisateurId)
  const limite = await withoutTenant((trx) => verifierLimiteConnexion(trx, { email: e.email, adresseIp: contexte.adresseIp }))
  if (!limite.autorise) throw new ErreurAcces(403, 'Trop de tentatives. Réessayez plus tard.')

  let valide = false
  if (params.secours) {
    const h = empreinteCodeSecours(normaliserCode(params.code))
    valide = await withoutTenant(async (trx) => {
      const r = await trx.updateTable('code_secours_2fa').set({ utilise_le: new Date() })
        .where('utilisateur_id', '=', s.utilisateurId).where('code_hash', '=', h).where('utilise_le', 'is', null).executeTakeFirst()
      return Number(r.numUpdatedRows) === 1
    })
  } else if (e.secret_chiffre) {
    const code = params.code.replace(/\s/g, '')
    const pas = /^\d{6}$/.test(code) ? pasTotpValide(dechiffrerSecretTotp(e.secret_chiffre), code) : null
    if (pas !== null) valide = await withAuthenticatedUser(s.utilisateurId, async (trx) => (await sql<{ ok: boolean }>`select a2f_marquer_pas(${pas}::bigint) as ok`.execute(trx)).rows[0]?.ok === true)
  }
  if (!valide) {
    await enregistrerEchec(e.email, contexte.adresseIp, s)
    throw new ErreurAcces(403, params.secours ? 'Code de secours incorrect ou déjà utilisé.' : 'Code incorrect.')
  }
  await withoutTenant((trx) => validerA2fSession(trx, s.sessionId))
  const appareil = params.memoriser ? await creerAppareil(s.utilisateurId, contexte.adresseIp, contexte.userAgent) : null
  const roles = await rolesDe(s.utilisateurId)
  const codesRestants = params.secours
    ? Number((await withoutTenant((trx) => trx.selectFrom('code_secours_2fa').select((eb) => eb.fn.countAll<string>().as('n')).where('utilisateur_id', '=', s.utilisateurId).where('utilise_le', 'is', null).executeTakeFirstOrThrow())).n)
    : null
  return { appareil, roles, codesRestants }
}

// ---------------------------------------------------------------------------
// Gestion depuis « Mon compte » (session complète)
// ---------------------------------------------------------------------------

async function exigerSessionComplete(jeton: string | null) {
  const s = await sessionPartielle(jeton)
  if (s.etape) throw new ErreurAcces(403, 'Terminez d’abord la connexion (double authentification).')
  return s
}

/** Vérifie un code TOTP de l'utilisateur (avec garde anti-rejeu) pour autoriser une opération sensible. */
async function exigerCodeTotp(utilisateurId: string, code: unknown, adresseIp: string): Promise<void> {
  const e = await etat2fa(utilisateurId)
  if (!e.actif || !e.secret_chiffre) throw new ErreurMetier(409, 'La double authentification n’est pas activée.')
  const c = typeof code === 'string' ? code.replace(/\s/g, '') : ''
  const pas = /^\d{6}$/.test(c) ? pasTotpValide(dechiffrerSecretTotp(e.secret_chiffre), c) : null
  const ok = pas !== null && await withAuthenticatedUser(utilisateurId, async (trx) => (await sql<{ ok: boolean }>`select a2f_marquer_pas(${pas}::bigint) as ok`.execute(trx)).rows[0]?.ok === true)
  if (!ok) {
    await enregistrerEchec(e.email, adresseIp)
    throw new ErreurMetier(400, 'Code incorrect.')
  }
}

export async function desactiverA2f(jeton: string | null, params: { motDePasse: unknown, code: unknown }, adresseIp: string) {
  const s = await exigerSessionComplete(jeton)
  if (a2fObligatoire(await rolesDe(s.utilisateurId))) throw new ErreurMetier(409, 'La double authentification est obligatoire pour votre rôle : elle ne peut pas être désactivée.')
  if (typeof params.motDePasse !== 'string') throw new ErreurMetier(400, 'Mot de passe requis.')
  const hash = await withAuthenticatedUser(s.utilisateurId, async (trx) => (await sql<{ h: string | null }>`select hash_mot_de_passe_courant() as h`.execute(trx)).rows[0]?.h ?? null)
  if (!hash || !(await verifierMotDePasse(hash, params.motDePasse))) throw new ErreurMetier(400, 'Mot de passe incorrect.')
  await exigerCodeTotp(s.utilisateurId, params.code, adresseIp)
  await withAuthenticatedUser(s.utilisateurId, (trx) => sql`select a2f_desactiver()`.execute(trx))
}

export async function regenererCodesSecours(jeton: string | null, code: unknown, adresseIp: string) {
  const s = await exigerSessionComplete(jeton)
  await exigerCodeTotp(s.utilisateurId, code, adresseIp)
  const codes = genererCodesSecours()
  await withoutTenant(async (trx) => {
    await trx.deleteFrom('code_secours_2fa').where('utilisateur_id', '=', s.utilisateurId).execute()
    await trx.insertInto('code_secours_2fa').values(codes.map((c) => ({ utilisateur_id: s.utilisateurId, code_hash: empreinteCodeSecours(normaliserCode(c)) }))).execute()
  })
  return { codesSecours: codes }
}

export async function revoquerMesAppareils(jeton: string | null) {
  const s = await exigerSessionComplete(jeton)
  await revoquerAppareilsUtilisateur(s.utilisateurId)
}
