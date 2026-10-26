import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { hacherMotDePasse } from '@/auth/password'
import { revoquerToutesLesSessions } from '@/auth/session'
import { ErreurMetier, texte, uuid } from '@/inspections/service'

/**
 * Comptes des personnes du client ou du prospect (entreprise active). Seul
 * IFECARM les crée : personne ne s'inscrit seul — pour entrer, il faut être
 * dans la base. Le mot de passe provisoire est affiché UNE fois au consultant,
 * qui le transmet ; la base ne garde que son hash argon2id.
 */

export const ROLES_CLIENT = ['admin_entreprise', 'responsable_qhse', 'responsable_site', 'declarant'] as const
type RoleClient = (typeof ROLES_CLIENT)[number]

// Sans caractères ambigus (0/O, 1/l/I) : il se dicte au téléphone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export function motDePasseProvisoire(): string {
  const octets = randomBytes(14)
  const c = Array.from(octets, (o) => ALPHABET[o % ALPHABET.length]).join('')
  return `${c.slice(0, 4)}-${c.slice(4, 9)}-${c.slice(9, 14)}`
}

export async function listerComptes(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string, nom: string, email: string, telephone: string | null, actif: boolean,
    derniere_connexion: string | null, roles: string[],
  }>`
    select u.id, u.nom, u.email::text as email, u.telephone, u.actif,
           to_char(u.derniere_connexion, 'YYYY-MM-DD"T"HH24:MI:SSOF') as derniere_connexion,
           coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles
    from utilisateur u
    left join role_utilisateur r on r.utilisateur_id = u.id
    group by u.id
    order by u.actif desc, u.nom
  `.execute(trx)
  return rows
}

const role = (v: unknown): RoleClient => {
  if (!ROLES_CLIENT.includes(v as RoleClient)) throw new ErreurMetier(400, 'Rôle invalide.')
  return v as RoleClient
}
export const email = (v: unknown): string => {
  const e = texte(v, 'Email', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ErreurMetier(400, 'Email invalide.')
  return e
}

export async function creerCompte(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string, utilisateurId: string },
  corps: Record<string, unknown>,
): Promise<{ id: string, motDePasse: string }> {
  const valeurs = { nom: texte(corps.nom, 'Nom', 200), email: email(corps.email), role: role(corps.role) }
  const motDePasse = motDePasseProvisoire()
  let id: string
  try {
    id = (await trx.insertInto('utilisateur').values({
      entreprise_id: ctx.entrepriseId, nom: valeurs.nom, email: valeurs.email,
      mot_de_passe_hash: await hacherMotDePasse(motDePasse),
    }).returning('id').executeTakeFirstOrThrow()).id
  } catch (e) {
    // Email globalement unique parmi les comptes actifs (migration 0011).
    if ((e as { code?: string }).code === '23505') throw new ErreurMetier(409, 'Cette adresse email a déjà un compte sur la plateforme.')
    throw e
  }
  await trx.insertInto('role_utilisateur').values({ utilisateur_id: id, role: valeurs.role }).execute()
  await ecrireJournal(trx, {
    utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'utilisateur', objetId: id,
    details: { email: valeurs.email, role: valeurs.role },
  })
  return { id, motDePasse }
}

/** Compte du tenant, jamais un compte interne IFECARM (sa ligne n'est de toute façon pas visible ici). */
async function exigerCompte(trx: Transaction<DB>, id: unknown) {
  const u = await trx.selectFrom('utilisateur').select(['id', 'email']).where('id', '=', uuid(id, 'Compte')).executeTakeFirst()
  if (!u) throw new ErreurMetier(404, 'Compte introuvable.')
  return u
}

export async function changerActifCompte(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string }, id: unknown, actif: unknown) {
  if (typeof actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
  const u = await exigerCompte(trx, id)
  try {
    await trx.updateTable('utilisateur').set({ actif }).where('id', '=', u.id).execute()
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ErreurMetier(409, 'Cette adresse email est déjà utilisée par un autre compte actif.')
    throw e
  }
  if (!actif) await revoquerToutesLesSessions(trx, u.id) // déconnexion immédiate
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: actif ? 'reactivation' : 'desactivation', objetType: 'utilisateur', objetId: u.id })
}

export async function reinitialiserMotDePasse(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string }, id: unknown) {
  const u = await exigerCompte(trx, id)
  const motDePasse = motDePasseProvisoire()
  await trx.updateTable('utilisateur').set({ mot_de_passe_hash: await hacherMotDePasse(motDePasse) }).where('id', '=', u.id).execute()
  await revoquerToutesLesSessions(trx, u.id)
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'reinitialisation_mot_de_passe', objetType: 'utilisateur', objetId: u.id })
  return { motDePasse }
}
