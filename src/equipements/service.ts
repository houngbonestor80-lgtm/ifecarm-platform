import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { supprimerFichier } from '@/storage/s3'
import { ErreurMetier, date, resoudreSite, texte, texteOptionnel, uuid } from '@/inspections/service'

/**
 * Registre des équipements et EPI de l'entreprise active (migration 0016).
 * Toutes les requêtes tournent sous withTenant : la RLS limite à l'entreprise.
 */

export interface LigneEquipement {
  id: string
  type: string
  designation: string
  numero_serie: string | null
  site_id: string | null
  site_nom: string | null
  affecte_a: string | null
  date_mise_service: string | null
  periodicite_mois: number | null
  derniere_verif: string | null
  prochaine_verif: string | null
  actif: boolean
  inspections: number
  photos: { id: string, nom: string }[]
}

export async function listerEquipements(trx: Transaction<DB>) {
  const [{ rows: equipements }, sites] = await Promise.all([
    sql<Omit<LigneEquipement, 'photos'>>`
      select e.id, e.type, e.designation, e.numero_serie, e.site_id, s.nom as site_nom, e.affecte_a,
             to_char(e.date_mise_service, 'YYYY-MM-DD') as date_mise_service, e.periodicite_mois,
             to_char(e.derniere_verif, 'YYYY-MM-DD') as derniere_verif,
             to_char(e.prochaine_verif, 'YYYY-MM-DD') as prochaine_verif, e.actif,
             (select count(*) from inspection i where i.equipement_id = e.id)::int as inspections
      from equipement e
      left join site s on s.id = e.site_id
      order by e.actif desc, e.prochaine_verif nulls last, e.designation
    `.execute(trx),
    trx.selectFrom('site').select(['id', 'nom']).where('actif', '=', true).orderBy('nom').execute(),
  ])
  const ids = equipements.map((e) => e.id)
  const photos = ids.length
    ? await trx.selectFrom('fichier').select(['id', 'nom_origine', 'objet_id']).where('objet_type', '=', 'equipement').where('objet_id', 'in', ids).orderBy('cree_le').execute()
    : []
  return {
    equipements: equipements.map((e) => ({ ...e, photos: photos.filter((p) => p.objet_id === e.id).map((p) => ({ id: p.id, nom: p.nom_origine })) })),
    sites,
  }
}

const entier = (v: unknown, champ: string): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 120) throw new ErreurMetier(400, `${champ} : nombre de mois entre 1 et 120.`)
  return n
}
const dateOptionnelle = (v: unknown, champ: string) => (v === undefined || v === null || v === '' ? null : date(v, champ))

/** Création (id null) ou modification d'un équipement. */
export async function enregistrerEquipement(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string },
  id: string | null,
  corps: Record<string, unknown>,
): Promise<{ id: string }> {
  const siteId = await resoudreSite(trx, ctx.entrepriseId, corps)
  const valeurs = {
    type: texte(corps.type, 'Type', 80),
    designation: texte(corps.designation, 'Désignation', 200),
    numero_serie: texteOptionnel(corps.numeroSerie, 'Numéro de série', 100),
    affecte_a: texteOptionnel(corps.affecteA, 'Affecté à', 200),
    site_id: siteId,
    date_mise_service: dateOptionnelle(corps.dateMiseService, 'Date de mise en service'),
    periodicite_mois: entier(corps.periodiciteMois, 'Périodicité'),
    derniere_verif: dateOptionnelle(corps.derniereVerif, 'Dernière vérification'),
    prochaine_verif: dateOptionnelle(corps.prochaineVerif, 'Prochaine vérification'),
  }

  if (id) {
    const r = await trx.updateTable('equipement').set(valeurs).where('id', '=', uuid(id, 'Équipement')).executeTakeFirst()
    if (!r.numUpdatedRows) throw new ErreurMetier(404, 'Équipement introuvable.')
  } else {
    id = (await trx.insertInto('equipement').values({ ...valeurs, entreprise_id: ctx.entrepriseId })
      .returning('id').executeTakeFirstOrThrow()).id
  }
  // Prochaine vérification non saisie : déduite de la dernière et de la périodicité.
  await sql`
    update equipement set prochaine_verif = (derniere_verif + make_interval(months => periodicite_mois))::date
    where id = ${id} and prochaine_verif is null and derniere_verif is not null and periodicite_mois is not null
  `.execute(trx)
  return { id }
}

/** Vérification effectuée : dernière = date du jour (ou saisie), prochaine = + périodicité. */
export async function enregistrerVerification(trx: Transaction<DB>, id: unknown, corps: Record<string, unknown>) {
  const le = dateOptionnelle(corps.date, 'Date de vérification') ?? new Date().toLocaleDateString('sv-SE')
  const r = await sql`
    update equipement set derniere_verif = ${le}::date,
      prochaine_verif = case when periodicite_mois is null then null
                             else (${le}::date + make_interval(months => periodicite_mois))::date end
    where id = ${uuid(id, 'Équipement')}
  `.execute(trx)
  if (!r.numAffectedRows) throw new ErreurMetier(404, 'Équipement introuvable.')
}

export async function changerActif(trx: Transaction<DB>, id: unknown, actif: unknown) {
  if (typeof actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
  const r = await trx.updateTable('equipement').set({ actif }).where('id', '=', uuid(id, 'Équipement')).executeTakeFirst()
  if (!r.numUpdatedRows) throw new ErreurMetier(404, 'Équipement introuvable.')
}

/** Suppression définitive — refusée (409) si l'équipement a déjà été inspecté. */
export async function supprimerEquipement(trx: Transaction<DB>, ctx: { entrepriseId: string, utilisateurId: string }, idBrut: unknown) {
  const id = uuid(idBrut, 'Équipement')
  const e = await trx.selectFrom('equipement').select(['designation', 'type']).where('id', '=', id).executeTakeFirst()
  if (!e) throw new ErreurMetier(404, 'Équipement introuvable.')
  const { rows: [n] } = await sql<{ n: number }>`select count(*)::int as n from inspection where equipement_id = ${id}`.execute(trx)
  if (n?.n) throw new ErreurMetier(409, 'Cet équipement a déjà été inspecté : retirez-le du registre plutôt que de le supprimer.')
  const photos = await trx.selectFrom('fichier').select('cle_stockage').where('objet_type', '=', 'equipement').where('objet_id', '=', id).execute()
  await trx.deleteFrom('fichier').where('objet_type', '=', 'equipement').where('objet_id', '=', id).execute()
  await trx.deleteFrom('equipement').where('id', '=', id).execute()
  for (const p of photos) await supprimerFichier(p.cle_stockage).catch(() => undefined)
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'equipement', objetId: id, details: e })
}
