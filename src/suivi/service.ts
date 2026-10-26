import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces } from '@/auth/contexte'
import { moduleEstActif } from '@/auth/modules'
import { ecrireJournal } from '@/db/journal'
import { ErreurMetier, texte, uuid } from '@/inspections/service'
import { lireDemandes, lireServiceAutre, lireServices } from '@/formations/demandes'

/**
 * Notes de suivi internes (migration 0027) : la RLS les réserve aux
 * consultants et administrateurs IFECARM GROUP ; un utilisateur client n'en
 * voit jamais aucune, même en interrogeant la base directement.
 */

export async function listerNotes(trx: Transaction<DB>) {
  return trx.selectFrom('note_suivi')
    .select(['id', 'auteur_id', 'auteur_nom', 'contenu', 'cree_le'])
    .orderBy('cree_le', 'desc').limit(200).execute()
}

export async function ajouterNote(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string }, corps: Record<string, unknown>) {
  const contenu = texte(corps.contenu, 'Note', 2000)
  const { rows: [u] } = await sql<{ nom: string | null }>`select nom_utilisateur_courant() as nom`.execute(trx)
  const { id } = await trx.insertInto('note_suivi')
    .values({ entreprise_id: ctx.entrepriseId, auteur_id: ctx.utilisateurId, auteur_nom: u?.nom ?? 'IFECARM GROUP', contenu })
    .returning('id').executeTakeFirstOrThrow()
  return { id }
}

/** Suppression : son auteur, ou l'administrateur. */
export async function supprimerNote(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string, estAdminPlateforme: boolean }, idBrut: unknown) {
  const id = uuid(idBrut, 'Note')
  const n = await trx.selectFrom('note_suivi').select(['auteur_id']).where('id', '=', id).executeTakeFirst()
  if (!n) throw new ErreurMetier(404, 'Note introuvable.')
  if (!ctx.estAdminPlateforme && n.auteur_id !== ctx.utilisateurId) throw new ErreurAcces(403, 'Seul l’auteur d’une note ou l’administrateur peut la supprimer.')
  await trx.deleteFrom('note_suivi').where('id', '=', id).execute()
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'note_suivi', objetId: id })
}

/**
 * Souhaits du prospect (services + demandes de formation, migration 0028) :
 * mêmes réservations que les notes — la RLS de demande_formation écarte tout
 * utilisateur qui n'est pas consultant ou administrateur IFECARM GROUP.
 */
export async function lireSouhaits(trx: Transaction<DB>, entrepriseId: string) {
  const e = await trx.selectFrom('entreprise').select(['services_souhaites', 'service_autre', 'statut_relation']).where('id', '=', entrepriseId).executeTakeFirst()
  if (!e) throw new ErreurMetier(404, 'Entreprise introuvable.')
  const demandes = await trx.selectFrom('demande_formation as d')
    .leftJoin('session_formation as s', 's.id', 'd.session_id')
    .select(['d.id', 'd.formation_slug as slug', 'd.intitule', 'd.nb_participants', sql<string | null>`to_char(d.date_souhaitee, 'YYYY-MM-DD')`.as('date_souhaitee'), 'd.note', 'd.session_id', 's.reference as session_reference'])
    .orderBy('d.cree_le').orderBy('d.formation_slug').execute()
  // Planification possible seulement si le module formations est actif (jamais pour un prospect).
  const formationsActif = await moduleEstActif(trx, { entrepriseId, module: 'formations' })
  return { services: e.services_souhaites, serviceAutre: e.service_autre, statut_relation: e.statut_relation, formationsActif, demandes }
}

export async function definirSouhaits(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string }, corps: Record<string, unknown>) {
  const services = lireServices(corps.services)
  if ('erreur' in services) throw new ErreurMetier(400, services.erreur)
  const demandes = lireDemandes(services.includes('formation') ? corps.formations : [])
  if ('erreur' in demandes) throw new ErreurMetier(400, demandes.erreur)
  const serviceAutre = lireServiceAutre(corps.serviceAutre)
  if (serviceAutre !== null && typeof serviceAutre === 'object') throw new ErreurMetier(400, serviceAutre.erreur)
  try {
    await sql`select definir_souhaits_prospect(${ctx.entrepriseId}, ${services}::text[], ${JSON.stringify(demandes)}::jsonb, ${serviceAutre})`.execute(trx)
  } catch (e) {
    // Codes métier de la fonction SQL : IF403 (accès), IF404 (introuvable ou interne), IF409 (valeur refusée).
    const code = (e as { code?: string }).code
    if (code === 'IF404') throw new ErreurMetier(404, 'Entreprise introuvable.')
    if (code === 'IF403') throw new ErreurAcces(403, 'Accès en écriture à cette entreprise requis.')
    if (code === 'IF409') throw new ErreurMetier(409, e instanceof Error ? e.message : 'Valeur refusée.')
    throw e
  }
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'demande_formation', details: { services, formations: demandes.length, serviceAutre: serviceAutre !== null } })
}
