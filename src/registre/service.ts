import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { construireCleStockage, lireFichier, supprimerFichier, televerserFichier } from '@/storage/s3'
import { ErreurMetier, date, texte, texteOptionnel, uuid } from '@/inspections/service'
import { creerDeclaration } from './declarations'

/**
 * B3 registre de sécurité : lecture, qualification, analyse des causes et actions (migrations 0005,
 * 0035-0038). Les droits sont portés par la RLS : un déclarant ne lit que ses déclarations non
 * anonymes, le responsable de site celles de son site, le responsable QHSE / admin d'entreprise et
 * l'équipe IFECARM tout ; l'écriture (hors déclaration) est réservée à l'équipe IFECARM. Ce module
 * ne contourne rien : il traduit les refus de la base en erreurs lisibles.
 */

export const TYPES_DECLARATION = ['accident_avec_arret', 'accident_sans_arret', 'presqu_accident', 'situation_dangereuse', 'incident_materiel', 'incident_environnemental'] as const
export const STATUTS_DECLARATION = ['a_qualifier', 'en_analyse', 'en_action', 'cloturee', 'sans_suite'] as const
export const NATURES_ACTION = ['suppression', 'substitution', 'protection_collective', 'protection_individuelle', 'organisation', 'formation', 'consigne'] as const
const METHODES = ['cinq_pourquoi', 'arbre_des_causes', 'libre'] as const
const STATUTS_ACTION = ['a_faire', 'en_cours', 'realisee', 'verifiee', 'abandonnee'] as const

type Ctx = { entrepriseId: string, utilisateurId: string }

/** Les contrôles de la base (déclencheurs 0035/0036, code IF409) deviennent des erreurs 409 lisibles. */
export async function traduireErreursBase<T>(cb: () => Promise<T>): Promise<T> {
  try {
    return await cb()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
    if (code === '23503') throw new ErreurMetier(409, 'Référence invalide (élément d’une autre entreprise ou supprimé).')
    throw e
  }
}

const entierBorne = (v: unknown, champ: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ErreurMetier(400, `${champ} invalide (${min} à ${max}).`)
  return n
}
const dateHeure = (v: unknown, champ: string): Date => {
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) throw new ErreurMetier(400, `${champ} invalide.`)
  if (d.getTime() > Date.now() + 24 * 3_600_000) throw new ErreurMetier(400, `${champ} ne peut pas être dans le futur.`)
  return d
}
const choix = <T extends string>(v: unknown, liste: readonly T[], champ: string): T => {
  if (!liste.includes(v as T)) throw new ErreurMetier(400, `${champ} invalide.`)
  return v as T
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function listerSitesRegistre(trx: Transaction<DB>) {
  return trx.selectFrom('site').select(['id', 'nom']).orderBy('nom').limit(500).execute()
}

export async function listerSalariesRegistre(trx: Transaction<DB>) {
  return trx.selectFrom('salarie').select(['id', 'nom', 'prenom']).where('actif', '=', true).orderBy('nom').orderBy('prenom').limit(1000).execute()
}

export async function listerDeclarations(trx: Transaction<DB>, filtres: { statut?: string | null, type?: string | null } = {}) {
  const statut = filtres.statut ? choix(filtres.statut, STATUTS_DECLARATION, 'Statut') : null
  const type = filtres.type ? choix(filtres.type, TYPES_DECLARATION, 'Type') : null
  const { rows } = await sql<{
    id: string, reference: string, type: string, statut: string, survenu_le: string, lieu: string | null,
    site_nom: string | null, anonyme: boolean, gravite: number | null, frequence: number | null, criticite: number | null,
    actions_ouvertes: number,
  }>`
    select d.id, d.reference, d.type, d.statut, d.survenu_le::text as survenu_le, d.lieu, s.nom as site_nom, d.anonyme,
           d.gravite, d.frequence, d.criticite,
           (select count(*)::int from action_corrective a where a.origine_type = 'declaration' and a.origine_id = d.id
              and a.statut in ('a_faire', 'en_cours')) as actions_ouvertes
    from declaration d left join site s on s.id = d.site_id
    where (${statut}::text is null or d.statut = ${statut}) and (${type}::text is null or d.type = ${type})
    order by d.survenu_le desc, d.cree_le desc
    limit 500`.execute(trx)
  return rows
}

export async function obtenirDeclaration(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Déclaration')
  const { rows: [d] } = await sql<{
    id: string, reference: string, type: string, statut: string, survenu_le: string, lieu: string | null, service: string | null,
    description: string, anonyme: boolean, site_id: string | null, site_nom: string | null,
    salarie_id: string | null, victime_nom: string | null, victime_externe: string | null,
    arret_travail: boolean | null, jours_arret: number | null, gravite: number | null, frequence: number | null, criticite: number | null,
    qualifie_le: string | null, motif_sans_suite: string | null, saisi_hors_ligne: boolean, declarant_nom: string | null,
  }>`
    select d.id, d.reference, d.type, d.statut, d.survenu_le::text as survenu_le, d.lieu, d.service, d.description, d.anonyme,
           d.site_id, s.nom as site_nom, d.salarie_id, nullif(btrim(sa.prenom || ' ' || sa.nom), '') as victime_nom,
           d.victime_externe, d.arret_travail, d.jours_arret, d.gravite, d.frequence, d.criticite, d.qualifie_le::text as qualifie_le,
           d.motif_sans_suite, d.saisi_hors_ligne, u.nom as declarant_nom
    from declaration d
    left join site s on s.id = d.site_id
    left join salarie sa on sa.id = d.salarie_id
    left join utilisateur u on u.id = d.declarant_id
    where d.id = ${id}`.execute(trx)
  if (!d) throw new ErreurMetier(404, 'Déclaration introuvable.')

  // Visibles seulement des responsables et de l'équipe (RLS) : vides pour un déclarant ou un responsable de site.
  const historique = await sql<{ id: string, statut_avant: string | null, statut_apres: string, commentaire: string | null, cree_le: string, auteur: string | null }>`
    select h.id::text, h.statut_avant, h.statut_apres, h.commentaire, h.cree_le::text as cree_le, u.nom as auteur
    from historique_declaration h left join utilisateur u on u.id = h.utilisateur_id
    where h.declaration_id = ${id} order by h.id`.execute(trx)
  const analyse = await trx.selectFrom('analyse_cause')
    .select(['methode', 'etapes', 'causes_profondes', sql<string | null>`realisee_le::text`.as('realisee_le')])
    .where('declaration_id', '=', id).executeTakeFirst()
  const actions = await sql<{
    id: string, reference: string, libelle: string, description: string | null, nature: string | null, statut: string,
    responsable_nom: string | null, echeance: string | null, en_retard: boolean, realisee_le: string | null,
    efficace: boolean | null, commentaire_verification: string | null, motif_abandon: string | null, derniere_relance: string | null,
  }>`
    select a.id, a.reference, a.libelle, a.description, a.nature, a.statut,
           coalesce(a.responsable_nom, u.nom) as responsable_nom, a.echeance::text as echeance,
           (a.echeance is not null and a.echeance < current_date and a.statut in ('a_faire', 'en_cours')) as en_retard,
           a.realisee_le::text as realisee_le, a.efficace, a.commentaire_verification, a.motif_abandon,
           -- Lisible des responsables et de l'équipe seulement (RLS de relance_action) : NULL pour les autres.
           (select max(r.declenchee_le)::text from relance_action r where r.action_id = a.id) as derniere_relance
    from action_corrective a left join utilisateur u on u.id = a.responsable_id
    where a.origine_type = 'declaration' and a.origine_id = ${id}
    order by a.cree_le`.execute(trx)
  const pieces = await sql<{ id: string, fichier_id: string, legende: string | null }>`
    select p.id, p.fichier_id, p.legende from piece_jointe_declaration p where p.declaration_id = ${id} order by p.cree_le`.execute(trx)

  return { ...d, historique: historique.rows, analyse: analyse ?? null, actions: actions.rows, pieces: pieces.rows }
}

// ---------------------------------------------------------------------------
// Déclaration (tout utilisateur du client, ou l'équipe pour le compte d'un tiers)
// ---------------------------------------------------------------------------

export async function declarer(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const type = choix(corps.type, TYPES_DECLARATION, 'Type')
  const arretTravail = corps.arretTravail === undefined || corps.arretTravail === null ? (type === 'accident_avec_arret' ? true : null) : corps.arretTravail === true
  const joursArret = arretTravail ? entierBorne(corps.joursArret, 'Jours d’arrêt', 0, 3650) : null
  if (type === 'accident_avec_arret' && arretTravail === false) throw new ErreurMetier(400, 'Un accident avec arrêt implique un arrêt de travail.')
  const siteId = corps.siteId ? uuid(corps.siteId, 'Site') : null
  const salarieId = corps.salarieId ? uuid(corps.salarieId, 'Victime') : null
  const cleClient = corps.cleClient ? uuid(corps.cleClient, 'Clé client') : null
  return traduireErreursBase(() => creerDeclaration(trx, {
    entrepriseId: ctx.entrepriseId,
    utilisateurId: ctx.utilisateurId,
    siteId,
    type,
    survenuLe: dateHeure(corps.survenuLe, 'Date de l’événement'),
    lieu: texteOptionnel(corps.lieu, 'Lieu', 200),
    service: texteOptionnel(corps.service, 'Service', 200),
    description: texte(corps.description, 'Description', 4000),
    anonyme: corps.anonyme === true,
    salarieId,
    victimeExterne: texteOptionnel(corps.victimeExterne, 'Victime', 200),
    arretTravail,
    joursArret,
    cleClient,
    saisiHorsLigne: corps.saisiHorsLigne === true,
  }))
}

// ---------------------------------------------------------------------------
// Qualification et suivi (équipe IFECARM : consultant ou admin)
// ---------------------------------------------------------------------------

export async function modifierDeclaration(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Déclaration')
  const v: Record<string, unknown> = {}
  if ('type' in corps) v.type = choix(corps.type, TYPES_DECLARATION, 'Type')
  if ('survenuLe' in corps) v.survenu_le = dateHeure(corps.survenuLe, 'Date de l’événement')
  if ('lieu' in corps) v.lieu = texteOptionnel(corps.lieu, 'Lieu', 200)
  if ('service' in corps) v.service = texteOptionnel(corps.service, 'Service', 200)
  if ('description' in corps) v.description = texte(corps.description, 'Description', 4000)
  if ('siteId' in corps) v.site_id = corps.siteId ? uuid(corps.siteId, 'Site') : null
  if ('salarieId' in corps) v.salarie_id = corps.salarieId ? uuid(corps.salarieId, 'Victime') : null
  if ('victimeExterne' in corps) v.victime_externe = texteOptionnel(corps.victimeExterne, 'Victime', 200)
  if ('arretTravail' in corps) v.arret_travail = corps.arretTravail === null ? null : corps.arretTravail === true
  if ('joursArret' in corps) v.jours_arret = entierBorne(corps.joursArret, 'Jours d’arrêt', 0, 3650)
  if ('gravite' in corps) v.gravite = entierBorne(corps.gravite, 'Gravité', 1, 4)
  if ('frequence' in corps) v.frequence = entierBorne(corps.frequence, 'Fréquence', 1, 4)
  if ('statut' in corps) v.statut = choix(corps.statut, STATUTS_DECLARATION, 'Statut')
  if ('motifSansSuite' in corps) v.motif_sans_suite = texteOptionnel(corps.motifSansSuite, 'Motif', 1000)
  if (!Object.keys(v).length) throw new ErreurMetier(400, 'Aucune modification.')

  const r = await traduireErreursBase(() => trx.updateTable('declaration').set(v as never).where('id', '=', id).executeTakeFirst())
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Déclaration introuvable.')
  // Pas de description ni de contenu dans le journal (jamais de donnée de la déclaration ici).
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'declaration', objetId: id, details: { champs: Object.keys(v) } })
}

export async function ajouterCommentaire(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Déclaration')
  const commentaire = texte(corps.commentaire, 'Commentaire', 2000)
  const d = await trx.selectFrom('declaration').select('statut').where('id', '=', id).executeTakeFirst()
  if (!d) throw new ErreurMetier(404, 'Déclaration introuvable.')
  await trx.insertInto('historique_declaration').values({
    entreprise_id: ctx.entrepriseId, declaration_id: id, utilisateur_id: ctx.utilisateurId,
    statut_avant: d.statut, statut_apres: d.statut, commentaire,
  }).execute()
}

/** Contenu libre validé selon la méthode (formats documentés dans 0005) : tableau de petits objets texte. */
function etapesValides(methode: (typeof METHODES)[number], brut: unknown): unknown[] {
  if (!Array.isArray(brut) || brut.length > 60) throw new ErreurMetier(400, 'Étapes invalides (60 maximum).')
  return brut.map((e, i) => {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
    if (methode === 'cinq_pourquoi') return { ordre: i + 1, question: texte(o.question, `Question ${i + 1}`, 500), reponse: texte(o.reponse, `Réponse ${i + 1}`, 1000) }
    if (methode === 'arbre_des_causes') {
      return { id: texte(o.id, `Identifiant ${i + 1}`, 40), texte: texte(o.texte, `Cause ${i + 1}`, 1000), parentIds: Array.isArray(o.parentIds) ? o.parentIds.map((p) => texte(p, 'Parent', 40)) : [] }
    }
    return { texte: texte(o.texte, `Étape ${i + 1}`, 2000) }
  })
}

export async function enregistrerAnalyse(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Déclaration')
  const methode = choix(corps.methode ?? 'libre', METHODES, 'Méthode')
  const etapes = etapesValides(methode, corps.etapes ?? [])
  const causes = Array.isArray(corps.causesProfondes) ? corps.causesProfondes.map((c) => texte(c, 'Cause profonde', 500)).slice(0, 20) : []
  const d = await trx.selectFrom('declaration').select('id').where('id', '=', id).executeTakeFirst()
  if (!d) throw new ErreurMetier(404, 'Déclaration introuvable.')
  await traduireErreursBase(() => trx.insertInto('analyse_cause')
    .values({ entreprise_id: ctx.entrepriseId, declaration_id: id, methode, etapes: JSON.stringify(etapes) as never, causes_profondes: causes })
    .onConflict((oc) => oc.column('declaration_id').doUpdateSet({ methode, etapes: JSON.stringify(etapes) as never, causes_profondes: causes }))
    .execute())
}

// ---------------------------------------------------------------------------
// Actions correctives d'origine « déclaration »
// ---------------------------------------------------------------------------

const referenceAction = () => `PA-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`

export async function creerAction(trx: Transaction<DB>, ctx: Ctx, declarationIdBrut: unknown, corps: Record<string, unknown>) {
  const declarationId = uuid(declarationIdBrut, 'Déclaration')
  const d = await trx.selectFrom('declaration').select(['id', 'site_id']).where('id', '=', declarationId).executeTakeFirst()
  if (!d) throw new ErreurMetier(404, 'Déclaration introuvable.')
  const nature = corps.nature ? choix(corps.nature, NATURES_ACTION, 'Nature') : null
  const action = await traduireErreursBase(() => trx.insertInto('action_corrective').values({
    entreprise_id: ctx.entrepriseId,
    site_id: d.site_id,
    reference: referenceAction(),
    origine_type: 'declaration',
    origine_id: declarationId,
    libelle: texte(corps.libelle, 'Action', 300),
    description: texteOptionnel(corps.description, 'Description', 2000),
    nature,
    responsable_nom: texteOptionnel(corps.responsable, 'Responsable', 200),
    echeance: corps.echeance ? date(corps.echeance, 'Échéance') : null,
  }).returning(['id', 'reference']).executeTakeFirstOrThrow())
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'action_corrective', objetId: action.id, details: { origine: 'declaration' } })
  return action
}

export async function changerStatutActionDeclaration(trx: Transaction<DB>, ctx: Ctx, actionIdBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(actionIdBrut, 'Action')
  const statut = choix(corps.statut, STATUTS_ACTION, 'Statut')
  const v: Record<string, unknown> = { statut }
  if (statut === 'realisee' || statut === 'verifiee') v.realisee_le = sql`coalesce(realisee_le, current_date)`
  if (statut === 'verifiee') {
    if (typeof corps.efficace !== 'boolean') throw new ErreurMetier(400, 'Indiquez si l’action est efficace.')
    v.efficace = corps.efficace
    v.verifiee_par = ctx.utilisateurId
    v.verifiee_le = sql`current_date`
    v.commentaire_verification = texteOptionnel(corps.commentaire, 'Commentaire', 1000)
  }
  if (statut === 'abandonnee') v.motif_abandon = texte(corps.motif, 'Motif d’abandon', 1000)
  const r = await traduireErreursBase(() => trx.updateTable('action_corrective').set(v as never)
    .where('id', '=', id).where('origine_type', '=', 'declaration').executeTakeFirst())
  if (Number(r.numUpdatedRows) !== 1) throw new ErreurMetier(404, 'Action introuvable.')
}

// ---------------------------------------------------------------------------
// Pièces jointes (photos) : le fichier transite par le serveur, type vérifié sur les premiers octets
// ---------------------------------------------------------------------------

const TAILLE_MAX = 8 * 1024 * 1024
const MAX_PAR_DECLARATION = 8

function typeReel(o: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return 'image/jpeg'
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) return 'image/png'
  const ascii = (a: number, b: number) => String.fromCharCode(...o.slice(a, b))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * Joint une photo à une déclaration encore « à qualifier » (RLS : declaration_ouverte_aux_pieces) ou, pour
 * l'équipe, à tout moment. Aucun RETURNING (un déclarant ne relit pas une déclaration anonyme) ; televerse_par
 * reste NULL (sinon la colonne désanonymiserait la photo) ; aucune ligne de journal pour l'envoi.
 */
export async function ajouterPieceJointe(
  trx: Transaction<DB>, ctx: Ctx, declarationIdBrut: unknown, entree: { octets: Uint8Array, nom: string, legende?: string | null },
): Promise<{ id: string }> {
  const declarationId = uuid(declarationIdBrut, 'Déclaration')
  if (!entree.octets.length) throw new ErreurMetier(400, 'Fichier vide.')
  if (entree.octets.length > TAILLE_MAX) throw new ErreurMetier(400, 'Photo trop lourde (8 Mo maximum).')
  const type = typeReel(entree.octets)
  if (!type) throw new ErreurMetier(400, 'Format non accepté : JPEG, PNG ou WebP uniquement.')

  const { rows: [ouverte] } = await sql<{ ok: boolean }>`select declaration_ouverte_aux_pieces(${declarationId}::uuid) as ok`.execute(trx)
  const { rows: [equipe] } = await sql<{ ok: boolean }>`select est_consultant_ou_admin_courant() as ok`.execute(trx)
  if (!ouverte?.ok && !equipe?.ok) throw new ErreurMetier(409, 'Cette déclaration n’accepte plus de pièce jointe.')

  // Compte par fonction dédiée : un déclarant ne peut pas relire les pièces d'une déclaration anonyme (RLS).
  const { rows: [compte] } = await sql<{ total: number }>`select compter_pieces_declaration(${declarationId}::uuid) as total`.execute(trx)
  const total = compte?.total ?? 0
  if (total >= MAX_PAR_DECLARATION) throw new ErreurMetier(409, `${MAX_PAR_DECLARATION} photos maximum par déclaration.`)

  const nom = (entree.nom || 'photo').slice(0, 200)
  const cle = construireCleStockage(ctx.entrepriseId, nom)
  await televerserFichier(cle, entree.octets, type)
  const fichierId = randomUUID()
  try {
    await trx.insertInto('fichier').values({
      id: fichierId, entreprise_id: ctx.entrepriseId, cle_stockage: cle, nom_origine: nom, type_mime: type,
      taille_octets: entree.octets.length, objet_type: 'declaration', objet_id: declarationId, televerse_par: null,
    }).execute()
    await traduireErreursBase(() => trx.insertInto('piece_jointe_declaration').values({
      entreprise_id: ctx.entrepriseId, declaration_id: declarationId, fichier_id: fichierId, legende: texteOptionnel(entree.legende, 'Légende', 200),
    }).execute())
  } catch (e) {
    await supprimerFichier(cle).catch(() => {})
    throw e
  }
  return { id: fichierId }
}

export async function lirePieceJointe(trx: Transaction<DB>, fichierIdBrut: unknown): Promise<{ octets: Uint8Array, typeMime: string }> {
  const id = uuid(fichierIdBrut, 'Fichier')
  // Sous RLS : le fichier d'une déclaration n'est visible que de ceux qui peuvent lire la déclaration (0038).
  const f = await trx.selectFrom('fichier').select(['cle_stockage', 'type_mime']).where('id', '=', id).where('objet_type', '=', 'declaration').executeTakeFirst()
  if (!f) throw new ErreurMetier(404, 'Photo introuvable.')
  return { octets: await lireFichier(f.cle_stockage), typeMime: f.type_mime ?? 'application/octet-stream' }
}

export async function supprimerPieceJointe(trx: Transaction<DB>, ctx: Ctx, fichierIdBrut: unknown) {
  const id = uuid(fichierIdBrut, 'Fichier')
  const f = await trx.selectFrom('fichier').select('cle_stockage').where('id', '=', id).where('objet_type', '=', 'declaration').executeTakeFirst()
  if (!f) throw new ErreurMetier(404, 'Photo introuvable.')
  const r = await trx.deleteFrom('fichier').where('id', '=', id).executeTakeFirst()
  if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Photo introuvable.')
  await supprimerFichier(f.cle_stockage).catch(() => {})
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'piece_jointe_declaration', objetId: id, details: null })
}

// ---------------------------------------------------------------------------
// Résumé pour le tableau de bord (responsables et équipe IFECARM)
// ---------------------------------------------------------------------------

/**
 * Chiffres du registre pour le tableau de bord principal. Calculés sous la RLS de l'appelant : un déclarant ou
 * un responsable de site ne verrait qu'une partie des déclarations, donc la route les en exclut (le résumé
 * serait faux). Les déclarations anonymes sont comptées : le responsable et l'équipe les lisent.
 */
export async function resumeRegistre(trx: Transaction<DB>) {
  const { rows: [c] } = await sql<{
    ouvertes: number, a_qualifier: number, gravite_1: number, gravite_2: number, gravite_3: number, gravite_4: number, non_qualifiees: number,
  }>`
    select count(*) filter (where statut in ('a_qualifier', 'en_analyse', 'en_action'))::int as ouvertes,
           count(*) filter (where statut = 'a_qualifier')::int as a_qualifier,
           count(*) filter (where statut in ('en_analyse', 'en_action') and gravite = 1)::int as gravite_1,
           count(*) filter (where statut in ('en_analyse', 'en_action') and gravite = 2)::int as gravite_2,
           count(*) filter (where statut in ('en_analyse', 'en_action') and gravite = 3)::int as gravite_3,
           count(*) filter (where statut in ('en_analyse', 'en_action') and gravite = 4)::int as gravite_4,
           count(*) filter (where statut = 'a_qualifier')::int as non_qualifiees
    from declaration`.execute(trx)
  const { rows: [a] } = await sql<{ en_retard: number, ouvertes: number }>`
    select count(*) filter (where echeance < current_date)::int as en_retard, count(*)::int as ouvertes
    from action_corrective where origine_type = 'declaration' and statut in ('a_faire', 'en_cours')`.execute(trx)
  const critiques = await sql<{ id: string, reference: string, type: string, statut: string, criticite: number | null, gravite: number | null, survenu_le: string, lieu: string | null }>`
    select id, reference, type, statut, criticite, gravite, survenu_le::text as survenu_le, lieu
    from declaration where statut in ('a_qualifier', 'en_analyse', 'en_action')
    order by criticite desc nulls first, survenu_le desc limit 5`.execute(trx)
  return {
    ouvertes: c?.ouvertes ?? 0,
    a_qualifier: c?.a_qualifier ?? 0,
    // Répartition par gravité des déclarations qualifiées en cours ; les « à qualifier » n'ont pas encore de gravité.
    par_gravite: [c?.gravite_1 ?? 0, c?.gravite_2 ?? 0, c?.gravite_3 ?? 0, c?.gravite_4 ?? 0],
    actions_ouvertes: a?.ouvertes ?? 0,
    actions_en_retard: a?.en_retard ?? 0,
    a_traiter: critiques.rows,
  }
}
