import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurMetier, date, texte, texteOptionnel, uuid } from '@/inspections/service'
import { ecrireJournal } from '@/db/journal'
import { hacherMotDePasse } from '@/auth/password'
import { revoquerToutesLesSessions } from '@/auth/session'
import { email, motDePasseProvisoire } from '@/acces/service'

/**
 * Administration (administrateur uniquement, sous withPlatformAdmin) :
 * création d'un client, modules activés par entreprise et accès des
 * consultants. Chaque opération est journalisée par withPlatformAdmin.
 */

export const MODULES = ['inspections', 'tableau_bord', 'formations', 'incidents', 'habilitations', 'autodiagnostic'] as const
export type ModuleNom = (typeof MODULES)[number]
const MODULES_PROSPECT: ModuleNom[] = ['inspections', 'tableau_bord', 'autodiagnostic']

export async function lireAdministration(trx: Transaction<DB>) {
  const [{ rows: entreprises }, { rows: consultants }] = await Promise.all([
    sql<{
      id: string, nom: string, statut_relation: 'client' | 'prospect', pays: string,
      modules: { module: ModuleNom, actif: boolean }[],
      acces: { utilisateur_id: string, nom: string, ecriture: boolean, fin_le: string | null }[],
    }>`
      select e.id, e.nom, e.statut_relation, e.pays,
        coalesce((select json_agg(json_build_object('module', m.module, 'actif', m.actif) order by m.module)
                  from abonnement_module m where m.entreprise_id = e.id), '[]'::json) as modules,
        coalesce((select json_agg(json_build_object('utilisateur_id', a.utilisateur_id, 'nom', u.nom, 'ecriture', a.ecriture,
                                                    'fin_le', to_char(a.fin_le, 'YYYY-MM-DD')) order by u.nom)
                  from acces_consultant a join utilisateur u on u.id = a.utilisateur_id
                  where a.entreprise_id = e.id), '[]'::json) as acces
      from entreprise e where not e.interne and e.desactive_le is null
      order by e.statut_relation, e.nom
    `.execute(trx),
    sql<{
      id: string, nom: string, email: string, cree_le: string,
      acces: { entreprise_id: string, nom: string, ecriture: boolean, fin_le: string | null }[],
    }>`
      select u.id, u.nom, u.email::text as email, to_char(u.cree_le, 'YYYY-MM-DD') as cree_le,
        coalesce((select json_agg(json_build_object('entreprise_id', x.id, 'nom', x.nom, 'ecriture', a.ecriture,
                                                    'fin_le', to_char(a.fin_le, 'YYYY-MM-DD')) order by x.nom)
                  from acces_consultant a join entreprise x on x.id = a.entreprise_id
                  where a.utilisateur_id = u.id and not x.interne and x.desactive_le is null), '[]'::json) as acces
      from utilisateur u
      join role_utilisateur r on r.utilisateur_id = u.id and r.role = 'consultant_ifecarm'
      join entreprise e on e.id = u.entreprise_id and e.interne
      where u.actif order by u.nom
    `.execute(trx),
  ])
  return { entreprises, consultants, modules: MODULES }
}

const moduleValide = (v: unknown): ModuleNom => {
  if (!MODULES.includes(v as ModuleNom)) throw new ErreurMetier(400, 'Module inconnu.')
  return v as ModuleNom
}

export async function creerClient(trx: Transaction<DB>, corps: Record<string, unknown>): Promise<{ id: string }> {
  const nom = texte(corps.nom, 'Nom', 200)
  const pays = texte(corps.pays, 'Pays', 2)
  if (!(await trx.selectFrom('pays_intervention').select('code').where('code', '=', pays).where('actif', '=', true).executeTakeFirst())) {
    throw new ErreurMetier(400, 'Pays d’intervention inconnu ou archivé.')
  }
  const modules = Array.isArray(corps.modules) && corps.modules.length ? [...new Set(corps.modules.map(moduleValide))] : ['inspections', 'tableau_bord' as ModuleNom]
  const { id } = await trx.insertInto('entreprise')
    .values({ nom, pays, secteur: texteOptionnel(corps.secteur, 'Secteur', 120), statut_relation: 'client' })
    .returning('id').executeTakeFirstOrThrow()
  await trx.insertInto('abonnement_module').values(modules.map((module) => ({ entreprise_id: id, module }))).execute()
  return { id }
}

export async function definirModule(trx: Transaction<DB>, entrepriseId: unknown, module: unknown, actif: unknown) {
  const id = uuid(entrepriseId, 'Entreprise')
  const m = moduleValide(module)
  if (typeof actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
  const e = await trx.selectFrom('entreprise').select('statut_relation').where('id', '=', id).where('interne', '=', false).executeTakeFirst()
  if (!e) throw new ErreurMetier(404, 'Entreprise introuvable.')
  if (actif && e.statut_relation === 'prospect' && !MODULES_PROSPECT.includes(m)) {
    throw new ErreurMetier(409, 'Ce module est réservé aux clients : passez d’abord ce prospect en client.')
  }
  await trx.insertInto('abonnement_module').values({ entreprise_id: id, module: m, actif })
    .onConflict((oc) => oc.columns(['entreprise_id', 'module']).doUpdateSet({ actif })).execute()
}

export async function accorderAcces(trx: Transaction<DB>, entrepriseId: unknown, corps: Record<string, unknown>) {
  const id = uuid(entrepriseId, 'Entreprise')
  const consultantId = uuid(corps.consultantId, 'Consultant')
  const ecriture = corps.ecriture === true
  const finLe = corps.finLe ? date(corps.finLe, 'Date de fin') : null
  if (!(await trx.selectFrom('entreprise').select('id').where('id', '=', id).where('interne', '=', false).executeTakeFirst())) {
    throw new ErreurMetier(404, 'Entreprise introuvable.')
  }
  const { rows } = await sql`
    select 1 from utilisateur u
    join role_utilisateur r on r.utilisateur_id = u.id and r.role = 'consultant_ifecarm'
    join entreprise e on e.id = u.entreprise_id and e.interne
    where u.id = ${consultantId} and u.actif
  `.execute(trx)
  if (!rows.length) throw new ErreurMetier(400, 'Consultant introuvable.')
  await trx.insertInto('acces_consultant').values({ utilisateur_id: consultantId, entreprise_id: id, ecriture, fin_le: finLe })
    .onConflict((oc) => oc.columns(['utilisateur_id', 'entreprise_id']).doUpdateSet({ ecriture, fin_le: finLe })).execute()
}

export async function revoquerAcces(trx: Transaction<DB>, entrepriseId: unknown, consultantId: unknown) {
  const r = await trx.deleteFrom('acces_consultant')
    .where('entreprise_id', '=', uuid(entrepriseId, 'Entreprise')).where('utilisateur_id', '=', uuid(consultantId, 'Consultant')).executeTakeFirst()
  if (!r.numDeletedRows) throw new ErreurMetier(404, 'Accès introuvable.')
}

/**
 * Compte d'un consultant IFECARM (entreprise interne, rôle consultant_ifecarm ;
 * le trigger 0017 interdit ce rôle partout ailleurs). Sans accès à aucune
 * entreprise tant que l'administrateur n'en accorde pas. Mot de passe
 * provisoire affiché une seule fois, hash argon2id seulement en base.
 */
export async function creerConsultant(trx: Transaction<DB>, ctx: { utilisateurId: string }, corps: Record<string, unknown>): Promise<{ id: string, motDePasse: string }> {
  const nom = texte(corps.nom, 'Nom', 200)
  const adresse = email(corps.email)
  const interne = await trx.selectFrom('entreprise').select('id').where('interne', '=', true).executeTakeFirst()
  if (!interne) throw new ErreurMetier(409, 'Entreprise interne IFECARM GROUP introuvable.')
  const motDePasse = motDePasseProvisoire()
  let id: string
  try {
    id = (await trx.insertInto('utilisateur')
      .values({ entreprise_id: interne.id, nom, email: adresse, mot_de_passe_hash: await hacherMotDePasse(motDePasse) })
      .returning('id').executeTakeFirstOrThrow()).id
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ErreurMetier(409, 'Cette adresse email a déjà un compte sur la plateforme.')
    throw e
  }
  await trx.insertInto('role_utilisateur').values({ utilisateur_id: id, role: 'consultant_ifecarm' }).execute()
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: interne.id, action: 'creation', objetType: 'utilisateur', objetId: id, details: { email: adresse, role: 'consultant_ifecarm' } })
  return { id, motDePasse }
}

/**
 * Suppression définitive d'un consultant : l'email doit être ressaisi
 * (confirmation). Les contrôles de fond sont dans supprimer_compte_consultant() (0033).
 */
export async function supprimerConsultant(trx: Transaction<DB>, ctx: { utilisateurId: string }, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Consultant')
  const confirmation = typeof corps.confirmation === 'string' ? corps.confirmation : ''
  const interne = await trx.selectFrom('entreprise').select('id').where('interne', '=', true).executeTakeFirst()
  try {
    await sql`select supprimer_compte_consultant(${id}, ${confirmation})`.execute(trx)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF404') throw new ErreurMetier(404, 'Consultant introuvable.')
    if (code === 'IF409') throw new ErreurMetier(409, e instanceof Error ? e.message : 'Suppression refusée.')
    if (code === 'IF403') throw new ErreurMetier(409, 'Réservé à l’administrateur.')
    throw e
  }
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: interne?.id ?? null, action: 'suppression', objetType: 'utilisateur', objetId: id, details: { email: confirmation.trim().toLowerCase(), role: 'consultant_ifecarm' } })
}

/**
 * Nouveau mot de passe provisoire pour un consultant (administrateur) : le mot
 * de passe actuel n'est jamais lisible (hash argon2id seulement), on en
 * génère un nouveau, affiché UNE fois ; ses sessions sont révoquées.
 */
export async function reinitialiserMotDePasseConsultant(trx: Transaction<DB>, ctx: { utilisateurId: string }, idBrut: unknown): Promise<{ motDePasse: string }> {
  const id = uuid(idBrut, 'Consultant')
  const { rows: [cible] } = await sql<{ email: string, entreprise_id: string }>`
    select u.email::text as email, u.entreprise_id from utilisateur u
    join entreprise e on e.id = u.entreprise_id and e.interne
    where u.id = ${id} and u.actif
      and exists (select 1 from role_utilisateur r where r.utilisateur_id = u.id and r.role = 'consultant_ifecarm')
      and not exists (select 1 from role_utilisateur r where r.utilisateur_id = u.id and r.role = 'admin_plateforme')`.execute(trx)
  if (!cible) throw new ErreurMetier(404, 'Consultant introuvable.')
  const motDePasse = motDePasseProvisoire()
  await trx.updateTable('utilisateur').set({ mot_de_passe_hash: await hacherMotDePasse(motDePasse) }).where('id', '=', id).execute()
  await revoquerToutesLesSessions(trx, id)
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: cible.entreprise_id, action: 'reinitialisation_mot_de_passe', objetType: 'utilisateur', objetId: id })
  return { motDePasse }
}
