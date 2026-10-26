import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { supprimerFichier } from '@/storage/s3'

/**
 * Logique métier des inspections. Toutes ces fonctions reçoivent une
 * transaction déjà ouverte par avecTenant (src/auth/contexte.ts) : le
 * cloisonnement (RLS) et le contrôle d'accès du consultant ont déjà eu lieu,
 * et chaque requête ci-dessous ne voit que l'entreprise de la session.
 *
 * Les entrées viennent du navigateur : chaque identifiant reçu est relu en
 * base (sous RLS) avant usage, et une erreur ErreurMetier (400/404/409) est
 * levée s'il n'existe pas dans ce tenant.
 */

export class ErreurMetier extends Error {
  constructor(public readonly statut: 400 | 404 | 409, message: string) {
    super(message)
  }
}

export type Resultat = 'conforme' | 'non_conforme' | 'non_applicable'
export type Gravite = 'mineure' | 'majeure' | 'critique'
export type StatutAction = 'a_faire' | 'en_cours' | 'realisee' | 'verifiee' | 'abandonnee'

const RESULTATS: Resultat[] = ['conforme', 'non_conforme', 'non_applicable']
const GRAVITES: Gravite[] = ['mineure', 'majeure', 'critique']
const STATUTS_ACTION: StatutAction[] = ['a_faire', 'en_cours', 'realisee', 'verifiee', 'abandonnee']

export const texte = (v: unknown, champ: string, max = 2000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ErreurMetier(400, `${champ} requis.`)
  if (v.length > max) throw new ErreurMetier(400, `${champ} trop long (${max} caractères maximum).`)
  return v.trim()
}
export const texteOptionnel = (v: unknown, champ: string, max = 2000): string | null =>
  v === undefined || v === null || v === '' ? null : texte(v, champ, max)
export const uuid = (v: unknown, champ: string): string => {
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new ErreurMetier(400, `${champ} invalide.`)
  return v
}
export const date = (v: unknown, champ: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ErreurMetier(400, `${champ} invalide (format AAAA-MM-JJ).`)
  }
  return v
}

/** Heure locale HH:MM (24 h), vide = non renseignée. */
export const heureOptionnelle = (v: unknown, champ: string): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new ErreurMetier(400, `${champ} invalide (format HH:MM).`)
  return v
}

/** Début et fin d'une plage horaire : la fin suppose un début et lui est postérieure. */
export function plageHoraire(debut: unknown, fin: unknown): { heure_debut: string | null, heure_fin: string | null } {
  const heure_debut = heureOptionnelle(debut, 'Heure de début')
  const heure_fin = heureOptionnelle(fin, 'Heure de fin')
  if (heure_fin && !heure_debut) throw new ErreurMetier(400, 'Renseignez l’heure de début avant l’heure de fin.')
  if (heure_debut && heure_fin && heure_fin <= heure_debut) throw new ErreurMetier(400, 'L’heure de fin doit être après l’heure de début.')
  return { heure_debut, heure_fin }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function contexteEntreprise(trx: Transaction<DB>, entrepriseId: string) {
  const e = await trx
    .selectFrom('entreprise')
    .select(['nom', 'statut_relation'])
    .where('id', '=', entrepriseId)
    .executeTakeFirst()
  if (!e) throw new ErreurMetier(404, 'Entreprise introuvable.')
  return { nom: e.nom, statutRelation: e.statut_relation }
}

export async function listerInspections(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string
    intitule_modele: string
    cible_type: string
    cible_nom: string | null
    date_inspection: string
    heure_debut: string | null
    heure_fin: string | null
    statut: string
    consultant_nom: string | null
    items_total: number
    items_renseignes: number
    items_non_conformes: number
    nc_critique: number
    nc_majeure: number
    nc_mineure: number
    actions_ouvertes: number
    actions_en_retard: number
  }>`
    select
      i.id, i.intitule_modele, i.cible_type,
      coalesce(s.nom, e.designation) as cible_nom,
      to_char(i.date_inspection, 'YYYY-MM-DD') as date_inspection,
      to_char(i.heure_debut, 'HH24:MI') as heure_debut, to_char(i.heure_fin, 'HH24:MI') as heure_fin,
      i.statut,
      u.nom as consultant_nom,
      (select count(*)::int from item_inspection it where it.inspection_id = i.id) as items_total,
      (select count(*)::int from item_inspection it where it.inspection_id = i.id and it.resultat is not null) as items_renseignes,
      (select count(*)::int from item_inspection it where it.inspection_id = i.id and it.resultat = 'non_conforme') as items_non_conformes,
      (select count(*)::int from non_conformite nc where nc.inspection_id = i.id and nc.gravite = 'critique') as nc_critique,
      (select count(*)::int from non_conformite nc where nc.inspection_id = i.id and nc.gravite = 'majeure') as nc_majeure,
      (select count(*)::int from non_conformite nc where nc.inspection_id = i.id and nc.gravite = 'mineure') as nc_mineure,
      (select count(*)::int from action_corrective ac join non_conformite nc on nc.id = ac.origine_id
         where ac.origine_type = 'inspection' and nc.inspection_id = i.id and ac.statut in ('a_faire','en_cours')) as actions_ouvertes,
      (select count(*)::int from action_corrective ac join non_conformite nc on nc.id = ac.origine_id
         where ac.origine_type = 'inspection' and nc.inspection_id = i.id and ac.statut in ('a_faire','en_cours')
           and ac.echeance < current_date) as actions_en_retard
    from inspection i
    left join site s on s.id = i.site_id
    left join equipement e on e.id = i.equipement_id
    left join utilisateur u on u.id = i.consultant_id
    order by i.date_inspection desc, i.cree_le desc
  `.execute(trx)
  return rows
}

export async function obtenirInspection(trx: Transaction<DB>, inspectionId: unknown) {
  const id = uuid(inspectionId, 'Inspection')
  const { rows: [inspection] } = await sql<{
    id: string
    intitule_modele: string
    cible_type: string
    cible_nom: string | null
    date_inspection: string
    heure_debut: string | null
    heure_fin: string | null
    statut: string
    commentaire: string | null
    consultant_nom: string | null
    inspecteur_nom: string | null
    representant_client: string | null
  }>`
    select i.id, i.intitule_modele, i.cible_type, coalesce(s.nom, e.designation) as cible_nom,
           to_char(i.date_inspection, 'YYYY-MM-DD') as date_inspection,
      to_char(i.heure_debut, 'HH24:MI') as heure_debut, to_char(i.heure_fin, 'HH24:MI') as heure_fin, i.statut, i.commentaire,
           u.nom as consultant_nom, i.inspecteur_nom, i.representant_client
    from inspection i
    left join site s on s.id = i.site_id
    left join equipement e on e.id = i.equipement_id
    left join utilisateur u on u.id = i.consultant_id
    where i.id = ${id}
  `.execute(trx)
  if (!inspection) throw new ErreurMetier(404, 'Inspection introuvable.')

  const items = await trx
    .selectFrom('item_inspection as it')
    .leftJoin('item_modele_inspection as im', 'im.id', 'it.item_modele_id')
    .select(['it.id', 'it.ordre', 'it.libelle', 'it.resultat', 'it.commentaire', 'it.personnalise', 'im.aide', 'im.gravite_defaut'])
    .where('it.inspection_id', '=', id)
    .orderBy('it.ordre')
    .execute()

  const nonConformites = await trx
    .selectFrom('non_conformite')
    .select(['id', 'item_inspection_id', 'gravite', 'description', 'cree_le'])
    .where('inspection_id', '=', id)
    .orderBy('cree_le')
    .execute()

  const actions = nonConformites.length
    ? await sql<{
        id: string
        origine_id: string
        reference: string
        libelle: string
        responsable_nom: string | null
        echeance: string | null
        statut: string
        en_retard: boolean
      }>`
        select id, origine_id, reference, libelle, responsable_nom,
               to_char(echeance, 'YYYY-MM-DD') as echeance, statut,
               (statut in ('a_faire','en_cours') and echeance < current_date) as en_retard
        from action_corrective
        where origine_type = 'inspection'
          and origine_id in (${sql.join(nonConformites.map((n) => sql`${n.id}`))})
        order by cree_le
      `.execute(trx).then((r) => r.rows)
    : []

  // Photos (table fichier, objet_type item_inspection / non_conformite).
  const objets = [...items.map((it) => it.id), ...nonConformites.map((n) => n.id)]
  const photos = objets.length
    ? await trx
      .selectFrom('fichier')
      .select(['id', 'objet_id', 'nom_origine'])
      .where('objet_type', 'in', ['item_inspection', 'non_conformite'])
      .where('objet_id', 'in', objets)
      .orderBy('cree_le')
      .execute()
    : []
  const photosDe = (objetId: string) =>
    photos.filter((p) => p.objet_id === objetId).map((p) => ({ id: p.id, nom: p.nom_origine }))

  return {
    ...inspection,
    items: items.map((it) => ({ ...it, photos: photosDe(it.id) })),
    nonConformites: nonConformites.map((nc) => ({
      ...nc,
      photos: photosDe(nc.id),
      actions: actions.filter((a) => a.origine_id === nc.id),
    })),
  }
}

export async function donneesCreation(trx: Transaction<DB>) {
  const [modeles, sites, equipements] = await Promise.all([
    trx
      .selectFrom('modele_inspection as m')
      .select((eb) => [
        'm.id', 'm.intitule', 'm.domaine', 'm.cible_type', 'm.description',
        eb.selectFrom('item_modele_inspection as im').whereRef('im.modele_id', '=', 'm.id')
          .select((e2) => e2.fn.countAll<string>().as('n')).as('nb_items'),
      ])
      .where('m.actif', '=', true)
      .orderBy('m.intitule')
      .execute(),
    trx.selectFrom('site').select(['id', 'nom', 'ville']).where('actif', '=', true).orderBy('nom').execute(),
    trx.selectFrom('equipement').select(['id', 'designation', 'type']).where('actif', '=', true).orderBy('designation').execute(),
  ])
  return {
    modeles: modeles.map((m) => ({ ...m, nb_items: Number(m.nb_items ?? 0) })),
    sites,
    equipements,
  }
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Crée une inspection à partir d'un modèle : les items du modèle sont COPIÉS
 * (libellé figé), pour que l'inspection ne change pas si le modèle évolue.
 * La cible est soit un site existant, soit un nouveau site créé à la volée
 * (cas du prospect visité pour la première fois).
 */
export async function creerInspection(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string, utilisateurId: string, estConsultant: boolean },
  corps: Record<string, unknown>,
) {
  const dateInspection = corps.date === undefined ? new Date().toISOString().slice(0, 10) : date(corps.date, 'Date')

  // Avec un modèle (points copiés et figés) OU en checklist LIBRE : intitulé, cible et points écrits par l'inspecteur.
  const libre = corps.modeleId === undefined || corps.modeleId === null || corps.modeleId === ''
  const points = libre ? pointsLibres(corps.points) : []
  const modele: { id: string | null, intitule: string, cible_type: 'site' | 'equipement' } = libre
    ? { id: null, intitule: texte(corps.intitule, 'Intitulé de l’inspection', 200), cible_type: cibleLibre(corps.cibleType) }
    : await (async () => {
      const m = await trx
        .selectFrom('modele_inspection')
        .select(['id', 'intitule', 'cible_type'])
        .where('id', '=', uuid(corps.modeleId, 'Modèle'))
        .where('actif', '=', true)
        .executeTakeFirst()
      if (!m) throw new ErreurMetier(404, 'Modèle introuvable.')
      return { id: m.id, intitule: m.intitule, cible_type: m.cible_type as 'site' | 'equipement' }
    })()

  let siteId: string | null = null
  let equipementId: string | null = null

  if (modele.cible_type === 'site') {
    if (corps.nouveauSite && typeof corps.nouveauSite === 'object') {
      const ns = corps.nouveauSite as Record<string, unknown>
      const cree = await trx
        .insertInto('site')
        .values({ entreprise_id: ctx.entrepriseId, nom: texte(ns.nom, 'Nom du site', 200), ville: texteOptionnel(ns.ville, 'Ville', 120) })
        .returning('id')
        .executeTakeFirstOrThrow()
      siteId = cree.id
    } else {
      siteId = uuid(corps.siteId, 'Site')
      const s = await trx.selectFrom('site').select('id').where('id', '=', siteId).executeTakeFirst()
      if (!s) throw new ErreurMetier(404, 'Site introuvable.')
    }
  } else {
    if (corps.nouvelEquipement && typeof corps.nouvelEquipement === 'object') {
      // Équipement écrit à la main (pas encore au registre) : créé dans l'entreprise, puis inspecté.
      const ne = corps.nouvelEquipement as Record<string, unknown>
      const cree = await trx.insertInto('equipement')
        .values({
          entreprise_id: ctx.entrepriseId, type: texte(ne.type, 'Type d’équipement', 80), designation: texte(ne.designation, 'Désignation', 200),
          numero_serie: texteOptionnel(ne.numeroSerie, 'Numéro de série', 100), site_id: await resoudreSite(trx, ctx.entrepriseId, ne),
        })
        .returning('id').executeTakeFirstOrThrow()
      equipementId = cree.id
    } else {
      equipementId = uuid(corps.equipementId, 'Équipement')
      const e = await trx.selectFrom('equipement').select('id').where('id', '=', equipementId).executeTakeFirst()
      if (!e) throw new ErreurMetier(404, 'Équipement introuvable.')
    }
  }

  const inspection = await trx
    .insertInto('inspection')
    .values({
      entreprise_id: ctx.entrepriseId,
      modele_id: modele.id,
      intitule_modele: modele.intitule,
      cible_type: modele.cible_type,
      site_id: siteId,
      equipement_id: equipementId,
      consultant_id: ctx.estConsultant ? ctx.utilisateurId : null,
      // Pré-rempli avec le nom du compte connecté, modifiable (la personne qui
      // inspecte n'est pas forcément le titulaire du compte).
      inspecteur_nom: texteOptionnel(corps.inspecteurNom, 'Inspecteur', 200)
        ?? (await sql<{ nom: string | null }>`select nom_utilisateur_courant() as nom`.execute(trx)).rows[0]?.nom ?? null,
      representant_client: texteOptionnel(corps.representantClient, 'Représentant du client', 200),
      date_inspection: dateInspection,
      ...plageHoraire(corps.heureDebut, corps.heureFin),
      statut: 'en_cours',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const itemsModele = modele.id
    ? await trx
      .selectFrom('item_modele_inspection')
      .select(['id', 'ordre', 'libelle'])
      .where('modele_id', '=', modele.id)
      .orderBy('ordre')
      .execute()
    : []

  if (itemsModele.length) {
    await trx
      .insertInto('item_inspection')
      .values(itemsModele.map((it) => ({
        entreprise_id: ctx.entrepriseId,
        inspection_id: inspection.id,
        item_modele_id: it.id,
        ordre: it.ordre,
        libelle: it.libelle,
      })))
      .execute()
  }

  if (points.length) {
    await trx
      .insertInto('item_inspection')
      .values(points.map((libelle, i) => ({
        entreprise_id: ctx.entrepriseId,
        inspection_id: inspection.id,
        item_modele_id: null,
        ordre: i + 1,
        libelle,
        personnalise: true,
      })))
      .execute()
  }

  return { id: inspection.id }
}

const cibleLibre = (v: unknown): 'site' | 'equipement' => {
  if (v !== 'site' && v !== 'equipement') throw new ErreurMetier(400, 'Choisissez ce qui est inspecté : un site ou un équipement.')
  return v
}

/** Points écrits à la main : texte ou { libelle } ; vides ignorés ; 1 à 150 ; 500 caractères au plus chacun. */
export function pointsLibres(brut: unknown): string[] {
  if (!Array.isArray(brut)) throw new ErreurMetier(400, 'Ajoutez au moins un point de contrôle.')
  const points = brut
    .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' ? (p as Record<string, unknown>).libelle : ''))
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  if (points.length === 0) throw new ErreurMetier(400, 'Ajoutez au moins un point de contrôle.')
  if (points.length > 150) throw new ErreurMetier(400, '150 points de contrôle au maximum au départ.')
  for (const [i, p] of points.entries()) if (p.length > 500) throw new ErreurMetier(400, `Point ${i + 1} : 500 caractères au maximum.`)
  return points
}

/** Règles de la base (code IF409, ex. 200 points maximum) : renvoyées telles quelles à l'utilisateur, en 409. */
async function regles<T>(cb: () => Promise<T>): Promise<T> {
  try {
    return await cb()
  } catch (e) {
    if ((e as { code?: string }).code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
    throw e
  }
}

/** Ajoute un point de contrôle écrit par l'inspecteur, à la fin de la checklist (inspection ouverte). */
export async function ajouterPoint(trx: Transaction<DB>, ctx: { entrepriseId: string }, inspectionId: unknown, corps: Record<string, unknown>) {
  const id = uuid(inspectionId, 'Inspection')
  await exigerInspectionModifiable(trx, id)
  const libelle = texte(corps.libelle, 'Point de contrôle', 500).trim()
  const { rows: [m] } = await sql<{ ordre: number }>`select coalesce(max(ordre), 0) + 1 as ordre from item_inspection where inspection_id = ${id}`.execute(trx)
  const cree = await regles(() => trx.insertInto('item_inspection')
    .values({ entreprise_id: ctx.entrepriseId, inspection_id: id, item_modele_id: null, ordre: Number(m!.ordre), libelle, personnalise: true })
    .returning('id').executeTakeFirstOrThrow())
  return { id: cree.id }
}

async function pointPersonnalise(trx: Transaction<DB>, inspectionId: string, itemId: string) {
  await exigerInspectionModifiable(trx, inspectionId)
  const it = await trx.selectFrom('item_inspection').select(['id', 'personnalise']).where('id', '=', itemId).where('inspection_id', '=', inspectionId).executeTakeFirst()
  if (!it) throw new ErreurMetier(404, 'Point introuvable dans cette inspection.')
  if (!it.personnalise) throw new ErreurMetier(409, 'Ce point vient d’un modèle : marquez-le « non applicable » plutôt que de le modifier ou le supprimer.')
}

/** Reformule un point écrit par l'inspecteur. */
export async function modifierPoint(trx: Transaction<DB>, inspectionId: unknown, itemId: unknown, corps: Record<string, unknown>) {
  const insp = uuid(inspectionId, 'Inspection')
  const item = uuid(itemId, 'Point')
  await pointPersonnalise(trx, insp, item)
  await regles(() => trx.updateTable('item_inspection').set({ libelle: texte(corps.libelle, 'Point de contrôle', 500).trim() }).where('id', '=', item).execute())
}

/** Supprime un point écrit par l'inspecteur (et ses photos), sauf s'il porte une non-conformité. */
export async function supprimerPoint(trx: Transaction<DB>, inspectionId: unknown, itemId: unknown) {
  const insp = uuid(inspectionId, 'Inspection')
  const item = uuid(itemId, 'Point')
  await pointPersonnalise(trx, insp, item)
  const nc = await trx.selectFrom('non_conformite').select('id').where('item_inspection_id', '=', item).executeTakeFirst()
  if (nc) throw new ErreurMetier(409, 'Ce point porte une non-conformité : il ne peut plus être supprimé.')
  const photos = await trx.selectFrom('fichier').select(['id', 'cle_stockage']).where('objet_type', '=', 'item_inspection').where('objet_id', '=', item).execute()
  await trx.deleteFrom('fichier').where('objet_type', '=', 'item_inspection').where('objet_id', '=', item).execute()
  await regles(() => trx.deleteFrom('item_inspection').where('id', '=', item).execute())
  for (const p of photos) await supprimerFichier(p.cle_stockage).catch(() => undefined)
}

/** Noms des intervenants (inspecteur, représentant du client), tant que l'inspection est modifiable. */
export async function modifierIntervenants(trx: Transaction<DB>, inspectionId: unknown, corps: Record<string, unknown>) {
  const id = uuid(inspectionId, 'Inspection')
  await exigerInspectionModifiable(trx, id)
  const valeurs: { inspecteur_nom?: string | null, representant_client?: string | null } = {}
  if ('inspecteurNom' in corps) valeurs.inspecteur_nom = texteOptionnel(corps.inspecteurNom, 'Inspecteur', 200)
  if ('representantClient' in corps) valeurs.representant_client = texteOptionnel(corps.representantClient, 'Représentant du client', 200)
  if (!Object.keys(valeurs).length) throw new ErreurMetier(400, 'Aucune modification.')
  await trx.updateTable('inspection').set(valeurs).where('id', '=', id).execute()
}

export async function exigerInspectionModifiable(trx: Transaction<DB>, inspectionId: string) {
  const i = await trx.selectFrom('inspection').select(['id', 'statut']).where('id', '=', inspectionId).executeTakeFirst()
  if (!i) throw new ErreurMetier(404, 'Inspection introuvable.')
  if (i.statut === 'terminee' || i.statut === 'annulee') {
    throw new ErreurMetier(409, 'Inspection clôturée : elle ne peut plus être modifiée.')
  }
}

export async function enregistrerResultat(trx: Transaction<DB>, inspectionId: unknown, itemId: unknown, corps: Record<string, unknown>) {
  const insp = uuid(inspectionId, 'Inspection')
  const item = uuid(itemId, 'Item')
  await exigerInspectionModifiable(trx, insp)

  const resultat = corps.resultat === null ? null : corps.resultat
  if (resultat !== null && !RESULTATS.includes(resultat as Resultat)) throw new ErreurMetier(400, 'Résultat invalide.')

  const maj: { resultat?: string | null, commentaire?: string | null } = {}
  if ('resultat' in corps) maj.resultat = resultat as string | null
  if ('commentaire' in corps) maj.commentaire = texteOptionnel(corps.commentaire, 'Commentaire')
  if (!Object.keys(maj).length) throw new ErreurMetier(400, 'Rien à enregistrer.')

  const r = await trx
    .updateTable('item_inspection')
    .set(maj)
    .where('id', '=', item)
    .where('inspection_id', '=', insp)
    .executeTakeFirst()
  if (Number(r.numUpdatedRows) !== 1) throw new ErreurMetier(404, 'Item introuvable dans cette inspection.')
}

export async function declarerNonConformite(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string },
  inspectionId: unknown,
  corps: Record<string, unknown>,
) {
  const insp = uuid(inspectionId, 'Inspection')
  await exigerInspectionModifiable(trx, insp)
  const gravite = corps.gravite
  if (!GRAVITES.includes(gravite as Gravite)) throw new ErreurMetier(400, 'Gravité invalide.')
  const itemId = corps.itemId ? uuid(corps.itemId, 'Item') : null

  const nc = await trx
    .insertInto('non_conformite')
    .values({
      entreprise_id: ctx.entrepriseId,
      inspection_id: insp,
      item_inspection_id: itemId,
      gravite: gravite as string,
      description: texte(corps.description, 'Description'),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Un item signalé en non-conformité est, de fait, non conforme.
  if (itemId) {
    await trx.updateTable('item_inspection').set({ resultat: 'non_conforme' })
      .where('id', '=', itemId).where('inspection_id', '=', insp).execute()
  }
  return { id: nc.id }
}

/** Référence lisible et unique par entreprise : PA-AAAA-XXXXXX (aléatoire, pas de compteur à maintenir). */
const referencePlanAction = () =>
  `PA-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`

export async function creerPlanAction(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string },
  nonConformiteId: unknown,
  corps: Record<string, unknown>,
) {
  const ncId = uuid(nonConformiteId, 'Non-conformité')
  const nc = await trx.selectFrom('non_conformite').select(['id', 'inspection_id']).where('id', '=', ncId).executeTakeFirst()
  if (!nc) throw new ErreurMetier(404, 'Non-conformité introuvable.')
  await exigerInspectionModifiable(trx, nc.inspection_id)

  const echeance = corps.echeance ? date(corps.echeance, 'Échéance') : null
  const action = await trx
    .insertInto('action_corrective')
    .values({
      entreprise_id: ctx.entrepriseId,
      reference: referencePlanAction(),
      origine_type: 'inspection',
      origine_id: nc.id,
      libelle: texte(corps.libelle, 'Action', 300),
      description: texteOptionnel(corps.description, 'Description'),
      responsable_nom: texteOptionnel(corps.responsable, 'Responsable', 200),
      echeance,
    })
    .returning(['id', 'reference'])
    .executeTakeFirstOrThrow()
  return action
}

/** Le cycle de vie d'un plan d'action continue après la clôture de l'inspection. */
export async function changerStatutAction(trx: Transaction<DB>, actionId: unknown, corps: Record<string, unknown>) {
  const id = uuid(actionId, 'Action')
  const statut = corps.statut
  if (!STATUTS_ACTION.includes(statut as StatutAction)) throw new ErreurMetier(400, 'Statut invalide.')
  const r = await trx
    .updateTable('action_corrective')
    .set({
      statut: statut as string,
      realisee_le: statut === 'realisee' || statut === 'verifiee' ? sql`coalesce(realisee_le, current_date)` : null,
    })
    .where('id', '=', id)
    .where('origine_type', 'in', ['inspection', 'audit']) // plans d'action des inspections et de l'autodiagnostic (B3 a son propre circuit de vérification)
    .executeTakeFirst()
  if (Number(r.numUpdatedRows) !== 1) throw new ErreurMetier(404, 'Action introuvable.')
}

/**
 * « Supprimer » une inspection, règle mixte (migration 0012) : suppression
 * définitive si elle n'est pas clôturée et n'a aucune non-conformité ; sinon
 * annulation (statut 'annulee'), conservée pour la traçabilité. Dans les deux
 * cas, une entrée au journal d'audit (immuable) garde la trace de l'opération.
 */
export async function supprimerInspection(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string, utilisateurId: string },
  inspectionId: unknown,
): Promise<{ resultat: 'supprimee' | 'annulee' | 'purgee' }> {
  const id = uuid(inspectionId, 'Inspection')
  const i = await trx
    .selectFrom('inspection')
    .select(['id', 'statut', 'intitule_modele', 'terminee_le'])
    .select(sql<string>`to_char(date_inspection, 'YYYY-MM-DD')`.as('date_inspection'))
    .where('id', '=', id)
    .executeTakeFirst()
  if (!i) throw new ErreurMetier(404, 'Inspection introuvable.')

  const { rows: [nc] } = await sql<{ n: number }>`
    select count(*)::int as n from non_conformite where inspection_id = ${id}
  `.execute(trx)
  const details = { intitule: i.intitule_modele, date: i.date_inspection, statut: i.statut, nonConformites: nc?.n ?? 0 }

  // Inspection déjà rangée : suppression définitive (NC, plans d'action, photos).
  if (i.statut === 'annulee') {
    const { rows: [p] } = await sql<{ cles: string[] }>`select purger_inspection_annulee(${id}) as cles`.execute(trx)
    await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'inspection', objetId: id, details })
    await Promise.allSettled((p?.cles ?? []).map((cle) => supprimerFichier(cle)))
    return { resultat: 'purgee' }
  }

  if ((i.statut === 'brouillon' || i.statut === 'en_cours') && !nc?.n) {
    // Photos des points de contrôle (sans NC, il n'y a pas de photo de NC).
    const photos = await trx
      .selectFrom('fichier as f')
      .innerJoin('item_inspection as it', 'it.id', 'f.objet_id')
      .select(['f.id', 'f.cle_stockage'])
      .where('f.objet_type', '=', 'item_inspection')
      .where('it.inspection_id', '=', id)
      .execute()
    if (photos.length) await trx.deleteFrom('fichier').where('id', 'in', photos.map((p) => p.id)).execute()
    await trx.deleteFrom('inspection').where('id', '=', id).execute()
    // ponytail: effacement du stockage au mieux, hors transaction ; un objet
    // orphelin ne coûte que de la place (jamais d'accès : plus de ligne fichier).
    await Promise.allSettled(photos.map((p) => supprimerFichier(p.cle_stockage)))
    await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'inspection', objetId: id, details })
    return { resultat: 'supprimee' }
  }

  // Annulation : terminee_le est remis à NULL (contrainte statut/terminee_le),
  // la date de clôture d'origine est conservée au journal.
  await trx.updateTable('inspection').set({ statut: 'annulee', terminee_le: null }).where('id', '=', id).execute()
  await ecrireJournal(trx, {
    utilisateurId: ctx.utilisateurId,
    entrepriseId: ctx.entrepriseId,
    action: 'annulation',
    objetType: 'inspection',
    objetId: id,
    details: { ...details, termineeLe: i.terminee_le },
  })
  return { resultat: 'annulee' }
}

export async function terminerInspection(trx: Transaction<DB>, inspectionId: unknown) {
  const id = uuid(inspectionId, 'Inspection')
  await exigerInspectionModifiable(trx, id)
  const { rows: [r] } = await sql<{ restants: number }>`
    select count(*)::int as restants from item_inspection where inspection_id = ${id} and resultat is null
  `.execute(trx)
  if (r && r.restants > 0) {
    throw new ErreurMetier(409, `${r.restants} point(s) de contrôle non renseigné(s) : complétez la checklist avant de clôturer.`)
  }
  await trx.updateTable('inspection').set({ statut: 'terminee', terminee_le: new Date() }).where('id', '=', id).execute()
}

/** Date et horaires de l'inspection (décidés par le consultant), tant qu'elle est modifiable. */
export async function modifierHoraire(trx: Transaction<DB>, inspectionId: unknown, corps: Record<string, unknown>) {
  const id = uuid(inspectionId, 'Inspection')
  await exigerInspectionModifiable(trx, id)
  await trx.updateTable('inspection')
    .set({ date_inspection: date(corps.date, 'Date'), ...plageHoraire(corps.heureDebut, corps.heureFin) })
    .where('id', '=', id).execute()
}

/**
 * Site d'un objet (équipement, salarié…) : un site existant (`siteId`) OU un nouveau site écrit à la main (`nouveauSite`).
 * Un nom déjà connu (casse et espaces ignorés) réutilise le site existant au lieu d'en créer un doublon.
 */
export async function resoudreSite(trx: Transaction<DB>, entrepriseId: string, corps: Record<string, unknown>): Promise<string | null> {
  if (corps.nouveauSite && typeof corps.nouveauSite === 'object') {
    const ns = corps.nouveauSite as Record<string, unknown>
    const nom = texte(ns.nom, 'Nom du site', 200)
    const existant = await trx.selectFrom('site').select('id')
      .where(sql<boolean>`lower(btrim(nom)) = lower(btrim(${nom}))`).where('actif', '=', true).executeTakeFirst()
    if (existant) return existant.id
    const cree = await trx.insertInto('site')
      .values({ entreprise_id: entrepriseId, nom, ville: texteOptionnel(ns.ville, 'Ville', 120) })
      .returning('id').executeTakeFirstOrThrow()
    return cree.id
  }
  if (!corps.siteId) return null
  const siteId = uuid(corps.siteId, 'Site')
  if (!(await trx.selectFrom('site').select('id').where('id', '=', siteId).executeTakeFirst())) throw new ErreurMetier(400, 'Site invalide.')
  return siteId
}
