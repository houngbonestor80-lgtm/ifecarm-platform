import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { randomBytes } from 'node:crypto'
import { ErreurMetier, date, plageHoraire, texte, texteOptionnel, uuid } from '@/inspections/service'

/**
 * B2 formations : sessions, participants, et lien avec les demandes de
 * formation (migrations 0004, 0028, 0029, 0031). Lecture : tout utilisateur du
 * tenant (module « formations » requis). Écriture : équipe IFECARM seulement,
 * contrôlée par les routes ET par la RLS (0029).
 */

export const STATUTS_SESSION = ['planifiee', 'confirmee', 'realisee', 'annulee'] as const
export const STATUTS_PARTICIPANT = ['inscrit', 'present', 'absent', 'abandon'] as const
const RESULTATS = ['apte', 'inapte', 'non_evalue'] as const

type Ctx = { entrepriseId: string, utilisateurId: string }

const entierBorne = (v: unknown, champ: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ErreurMetier(400, `${champ} invalide (${min} à ${max}).`)
  return n
}

/** Durée décidée par le consultant pour cette session : heures, une décimale au plus. */
const dureeHeures = (v: unknown): number => {
  const n = Number(v)
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n <= 0 || n > 1000) {
    throw new ErreurMetier(400, 'Durée de la formation requise, en heures (0,5 à 1 000).')
  }
  return Math.round(n * 10) / 10
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/** Catalogue IFECARM + formations propres à l'entreprise active (actives). */
export async function listerCatalogue(trx: Transaction<DB>) {
  return trx.selectFrom('formation')
    .select(['id', 'slug', 'intitule', 'domaine', 'duree_jours', 'duree_libelle', 'validite_mois'])
    .where('actif', '=', true).orderBy('domaine').orderBy('intitule').execute()
}

export async function listerSessions(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string, reference: string, intitule: string, date_debut: string, date_fin: string,
    heure_debut: string | null, heure_fin: string | null, duree_heures: string | null, lieu: string | null,
    statut: string, places_max: number | null, participants: number, formateur_nom: string | null,
  }>`
    select s.id, s.reference, f.intitule,
           to_char(s.date_debut, 'YYYY-MM-DD') as date_debut, to_char(s.date_fin, 'YYYY-MM-DD') as date_fin,
           to_char(s.heure_debut, 'HH24:MI') as heure_debut, to_char(s.heure_fin, 'HH24:MI') as heure_fin,
           s.duree_heures::text as duree_heures, s.lieu, s.statut, s.places_max, s.formateur_nom,
           (select count(*)::int from participant p where p.session_id = s.id) as participants
    from session_formation s join formation f on f.id = s.formation_id
    order by s.date_debut desc, s.cree_le desc
  `.execute(trx)
  return rows.map((r) => ({ ...r, duree_heures: r.duree_heures == null ? null : Number(r.duree_heures) }))
}

export async function obtenirSession(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Session')
  const { rows: [s] } = await sql<{
    id: string, reference: string, formation_id: string, intitule: string, domaine: string,
    date_debut: string, date_fin: string, heure_debut: string | null, heure_fin: string | null,
    duree_heures: string | null, lieu: string | null, site_id: string | null, formateur_nom: string | null,
    places_max: number | null, statut: string, commentaire: string | null,
  }>`
    select s.id, s.reference, s.formation_id, f.intitule, f.domaine,
           to_char(s.date_debut, 'YYYY-MM-DD') as date_debut, to_char(s.date_fin, 'YYYY-MM-DD') as date_fin,
           to_char(s.heure_debut, 'HH24:MI') as heure_debut, to_char(s.heure_fin, 'HH24:MI') as heure_fin,
           s.duree_heures::text as duree_heures, s.lieu, s.site_id, s.formateur_nom, s.places_max, s.statut, s.commentaire
    from session_formation s join formation f on f.id = s.formation_id
    where s.id = ${id}
  `.execute(trx)
  if (!s) throw new ErreurMetier(404, 'Session introuvable.')

  const participants = await trx.selectFrom('participant as p')
    .innerJoin('salarie as sa', 'sa.id', 'p.salarie_id')
    .select(['p.id', 'p.salarie_id', 'p.statut', 'p.resultat', 'p.commentaire', 'sa.nom', 'sa.prenom', 'sa.poste'])
    .where('p.session_id', '=', id).orderBy('sa.nom').orderBy('sa.prenom').execute()
  // Invisible pour un client (RLS de demande_formation, 0028) : reste vide pour lui.
  const demande = await trx.selectFrom('demande_formation')
    .select(['id', 'formation_slug', 'nb_participants', sql<string | null>`to_char(date_souhaitee, 'YYYY-MM-DD')`.as('date_souhaitee'), 'note'])
    .where('session_id', '=', id).executeTakeFirst()
  const emargements = await trx.selectFrom('emargement as e')
    .innerJoin('participant as p', 'p.id', 'e.participant_id')
    .select(['e.participant_id', sql<string>`to_char(e.jour, 'YYYY-MM-DD')`.as('jour'), 'e.demi_journee', 'e.present'])
    .where('p.session_id', '=', id).execute()
  return { ...s, duree_heures: s.duree_heures == null ? null : Number(s.duree_heures), participants, emargements, demande: demande ?? null }
}

export async function listerSalaries(trx: Transaction<DB>) {
  return trx.selectFrom('salarie').select(['id', 'nom', 'prenom', 'poste']).where('actif', '=', true).orderBy('nom').orderBy('prenom').limit(1000).execute()
}

/**
 * Demandes de formation de l'entreprise active, avec leur état de planification
 * (consultant / admin : la RLS les cache au client). Sert à préremplir une session.
 */
export async function listerDemandes(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string, formation_slug: string, nb_participants: number | null, date_souhaitee: string | null, note: string | null,
    session_id: string | null, reference: string | null, formation_id: string | null, intitule: string | null, intitule_libre: string | null,
  }>`
    select d.id, d.formation_slug, d.nb_participants, to_char(d.date_souhaitee, 'YYYY-MM-DD') as date_souhaitee, d.note,
           d.session_id, s.reference, f.id as formation_id, f.intitule, d.intitule as intitule_libre
    from demande_formation d
    left join session_formation s on s.id = d.session_id
    left join formation f on f.slug = d.formation_slug and f.entreprise_id is null
    order by d.cree_le, d.formation_slug
  `.execute(trx)
  return rows
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/** Référence séquentielle par entreprise et par année (S-2027-001), sous verrou : pas de max()+1 concurrent. */
async function prochaineReference(trx: Transaction<DB>, entrepriseId: string, annee: string) {
  await sql`select pg_advisory_xact_lock(hashtext(${'session_formation:' + entrepriseId}))`.execute(trx)
  const { rows: [r] } = await sql<{ n: number }>`
    select coalesce(max(substring(reference from '-([0-9]+)$')::int), 0) + 1 as n
    from session_formation where entreprise_id = ${entrepriseId} and reference like ${`S-${annee}-%`}`.execute(trx)
  return `S-${annee}-${String(r!.n).padStart(3, '0')}`
}

/**
 * Formation HORS catalogue, écrite par le consultant : elle devient une formation propre à l'entreprise (réutilisable pour ses
 * prochaines sessions). Un intitulé déjà connu de l'entreprise (casse ignorée) est réutilisé au lieu d'être dupliqué.
 */
async function formationSurMesure(trx: Transaction<DB>, ctx: Ctx, brut: Record<string, unknown>): Promise<string> {
  const intitule = texte(brut.intitule, 'Intitulé de la formation', 200).trim()
  const existante = await trx.selectFrom('formation').select('id').where('entreprise_id', '=', ctx.entrepriseId).where('actif', '=', true)
    .where(sql<boolean>`lower(btrim(intitule)) = lower(btrim(${intitule}))`).executeTakeFirst()
  if (existante) return existante.id
  const validite = brut.validiteMois === undefined || brut.validiteMois === null || brut.validiteMois === '' ? null : Number(brut.validiteMois)
  if (validite !== null && (!Number.isInteger(validite) || validite < 1 || validite > 240)) throw new ErreurMetier(400, 'Validité : un nombre de mois entre 1 et 240.')
  const slug = `${intitule.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${randomBytes(3).toString('hex')}`
  const { id } = await trx.insertInto('formation')
    .values({ entreprise_id: ctx.entrepriseId, slug, intitule, domaine: texteOptionnel(brut.domaine, 'Domaine', 80) ?? 'Sur mesure', validite_mois: validite })
    .returning('id').executeTakeFirstOrThrow()
  return id
}

export async function creerSession(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const surMesure = corps.formationSurMesure && typeof corps.formationSurMesure === 'object' && !corps.formationId
  const formationId = surMesure ? await formationSurMesure(trx, ctx, corps.formationSurMesure as Record<string, unknown>) : uuid(corps.formationId, 'Formation')
  const formation = await trx.selectFrom('formation').select(['id', 'slug']).where('id', '=', formationId).where('actif', '=', true).executeTakeFirst()
  if (!formation) throw new ErreurMetier(404, 'Formation introuvable.')
  const debut = date(corps.dateDebut, 'Date de début')
  const fin = date(corps.dateFin, 'Date de fin')
  if (fin < debut) throw new ErreurMetier(400, 'La date de fin doit être après la date de début.')
  const horaires = plageHoraire(corps.heureDebut, corps.heureFin)
  const duree = dureeHeures(corps.dureeHeures)
  const places = entierBorne(corps.placesMax, 'Nombre de places', 1, 1000)
  let siteId: string | null = null
  if (corps.siteId) {
    siteId = uuid(corps.siteId, 'Site')
    if (!(await trx.selectFrom('site').select('id').where('id', '=', siteId).executeTakeFirst())) throw new ErreurMetier(404, 'Site introuvable.')
  }

  // Demande à lier : de cette entreprise, pas encore planifiée, pour la même formation du catalogue.
  let demandeId: string | null = null
  if (corps.demandeId) {
    demandeId = uuid(corps.demandeId, 'Demande')
    const d = await trx.selectFrom('demande_formation').select(['formation_slug', 'session_id', 'intitule']).where('id', '=', demandeId).executeTakeFirst()
    if (!d) throw new ErreurMetier(404, 'Demande introuvable.')
    if (d.session_id) throw new ErreurMetier(409, 'Cette demande est déjà planifiée dans une session.')
    // Demande « hors catalogue » (intitulé écrit à la main) : planifiable avec une formation sur mesure ; sinon, même formation du catalogue.
    if (d.intitule === null && d.formation_slug !== formation.slug) throw new ErreurMetier(409, 'La demande porte sur une autre formation.')
  }

  const reference = await prochaineReference(trx, ctx.entrepriseId, debut.slice(0, 4))
  const { id } = await trx.insertInto('session_formation').values({
    entreprise_id: ctx.entrepriseId, formation_id: formationId, site_id: siteId, reference,
    date_debut: debut, date_fin: fin, ...horaires, duree_heures: duree,
    lieu: texteOptionnel(corps.lieu, 'Lieu', 200), formateur_nom: texteOptionnel(corps.formateurNom, 'Formateur', 200),
    places_max: places, commentaire: texteOptionnel(corps.commentaire, 'Commentaire', 2000),
  }).returning('id').executeTakeFirstOrThrow()
  if (demandeId) await trx.updateTable('demande_formation').set({ session_id: id }).where('id', '=', demandeId).execute()
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'session_formation', objetId: id, details: { reference, demandeLiee: demandeId !== null } })
  return { id, reference }
}

export async function modifierSession(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Session')
  const actuelle = await trx.selectFrom('session_formation').select(['date_debut', 'date_fin', 'heure_debut', 'heure_fin']).where('id', '=', id).executeTakeFirst()
  if (!actuelle) throw new ErreurMetier(404, 'Session introuvable.')
  const valeurs: Record<string, unknown> = {}
  if ('dateDebut' in corps || 'dateFin' in corps) {
    const debut = date(corps.dateDebut, 'Date de début')
    const fin = date(corps.dateFin, 'Date de fin')
    if (fin < debut) throw new ErreurMetier(400, 'La date de fin doit être après la date de début.')
    Object.assign(valeurs, { date_debut: debut, date_fin: fin })
  }
  if ('heureDebut' in corps || 'heureFin' in corps) Object.assign(valeurs, plageHoraire(corps.heureDebut, corps.heureFin))
  if ('dureeHeures' in corps) valeurs.duree_heures = dureeHeures(corps.dureeHeures)
  if ('lieu' in corps) valeurs.lieu = texteOptionnel(corps.lieu, 'Lieu', 200)
  if ('formateurNom' in corps) valeurs.formateur_nom = texteOptionnel(corps.formateurNom, 'Formateur', 200)
  if ('placesMax' in corps) valeurs.places_max = entierBorne(corps.placesMax, 'Nombre de places', 1, 1000)
  if ('commentaire' in corps) valeurs.commentaire = texteOptionnel(corps.commentaire, 'Commentaire', 2000)
  if ('statut' in corps) {
    if (!STATUTS_SESSION.includes(corps.statut as never)) throw new ErreurMetier(400, 'Statut invalide.')
    valeurs.statut = corps.statut
  }
  if (!Object.keys(valeurs).length) throw new ErreurMetier(400, 'Aucune modification.')
  await trx.updateTable('session_formation').set(valeurs as never).where('id', '=', id).execute()
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'session_formation', objetId: id, details: { champs: Object.keys(valeurs) } })
}

const MAX_LOT = 100

/**
 * Inscrit un ou plusieurs participants en une fois, tout ou rien : salariés
 * existants (salarieId / salarieIds) et nouveaux salariés à créer
 * (nouveauSalarie / nouveauxSalaries : nom, prénom, poste). Le contrôle des
 * places porte sur le lot entier.
 */
export async function ajouterParticipant(trx: Transaction<DB>, ctx: Ctx, sessionIdBrut: unknown, corps: Record<string, unknown>) {
  const sessionId = uuid(sessionIdBrut, 'Session')
  const s = await trx.selectFrom('session_formation').select(['statut', 'places_max']).where('id', '=', sessionId).executeTakeFirst()
  if (!s) throw new ErreurMetier(404, 'Session introuvable.')
  if (s.statut === 'annulee') throw new ErreurMetier(409, 'Session annulée : plus d’inscription possible.')

  const existants = [...new Set([
    ...(corps.salarieId ? [corps.salarieId] : []),
    ...(Array.isArray(corps.salarieIds) ? corps.salarieIds : []),
  ].map((x) => uuid(x, 'Salarié')))]
  const bruts = [
    ...(corps.nouveauSalarie && typeof corps.nouveauSalarie === 'object' ? [corps.nouveauSalarie] : []),
    ...(Array.isArray(corps.nouveauxSalaries) ? corps.nouveauxSalaries : []),
  ]
  const nouveaux = bruts.map((b, i) => {
    const n = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
    const nom = texteOptionnel(n.nom, 'Nom', 120)
    const prenom = texteOptionnel(n.prenom, 'Prénom', 120)
    if (!nom || !prenom) throw new ErreurMetier(400, `Nom et prénom requis (participant ${i + 1}).`)
    return { nom, prenom, poste: texteOptionnel(n.poste, 'Poste', 120) }
  })
  const total = existants.length + nouveaux.length
  if (total === 0) throw new ErreurMetier(400, 'Aucun participant à inscrire.')
  if (total > MAX_LOT) throw new ErreurMetier(400, `${MAX_LOT} participants au maximum par ajout.`)

  if (s.places_max != null) {
    const { n } = await trx.selectFrom('participant').select((eb) => eb.fn.countAll<number>().as('n')).where('session_id', '=', sessionId).executeTakeFirstOrThrow()
    const restantes = s.places_max - Number(n)
    if (total > restantes) throw new ErreurMetier(409, restantes <= 0 ? 'Session complète.' : `Il ne reste que ${restantes} place${restantes > 1 ? 's' : ''} : ${total} participants demandés.`)
  }

  if (existants.length) {
    const trouves = await trx.selectFrom('salarie').select('id').where('id', 'in', existants).execute()
    if (trouves.length !== existants.length) throw new ErreurMetier(404, 'Salarié introuvable.')
  }
  const salarieIds = [...existants]
  for (const n of nouveaux) {
    salarieIds.push((await trx.insertInto('salarie').values({ entreprise_id: ctx.entrepriseId, ...n }).returning('id').executeTakeFirstOrThrow()).id)
  }
  try {
    const crees = await trx.insertInto('participant')
      .values(salarieIds.map((salarie_id) => ({ entreprise_id: ctx.entrepriseId, session_id: sessionId, salarie_id })))
      .returning('id').execute()
    const ids = crees.map((c) => c.id)
    await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'participant', objetId: ids[0], details: { sessionId, inscrits: ids.length } })
    return { id: ids[0]!, ids, ajoutes: ids.length }
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ErreurMetier(409, 'Un de ces salariés est déjà inscrit à cette session : aucun participant n’a été ajouté.')
    throw e
  }
}

export async function modifierParticipant(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Participant')
  const valeurs: Record<string, unknown> = {}
  if ('statut' in corps) {
    if (!STATUTS_PARTICIPANT.includes(corps.statut as never)) throw new ErreurMetier(400, 'Statut invalide.')
    valeurs.statut = corps.statut
  }
  if ('resultat' in corps) {
    if (corps.resultat !== null && !RESULTATS.includes(corps.resultat as never)) throw new ErreurMetier(400, 'Résultat invalide.')
    valeurs.resultat = corps.resultat
  }
  if ('commentaire' in corps) valeurs.commentaire = texteOptionnel(corps.commentaire, 'Commentaire', 1000)
  if (!Object.keys(valeurs).length) throw new ErreurMetier(400, 'Aucune modification.')
  const r = await trx.updateTable('participant').set(valeurs as never).where('id', '=', id).executeTakeFirst()
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Participant introuvable.')
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'participant', objetId: id, details: { champs: Object.keys(valeurs) } })
}

export async function retirerParticipant(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown) {
  const id = uuid(idBrut, 'Participant')
  try {
    const r = await trx.deleteFrom('participant').where('id', '=', id).executeTakeFirst()
    if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Participant introuvable.')
  } catch (e) {
    // Une attestation émise garde son participant (0004 : ON DELETE RESTRICT).
    if ((e as { code?: string }).code === '23503') throw new ErreurMetier(409, 'Ce participant a une attestation : il ne peut pas être retiré.')
    throw e
  }
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'participant', objetId: id })
}

/**
 * Émargement d'un participant pour une demi-journée (présent / absent), dans
 * la période de la session. Une ligne par (participant, jour, demi-journée) :
 * ressaisir corrige la précédente. La signature manuscrite reste à venir.
 */
export async function enregistrerEmargement(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const participantId = uuid(idBrut, 'Participant')
  const jour = date(corps.jour, 'Jour')
  if (corps.demiJournee !== 'matin' && corps.demiJournee !== 'apres_midi') throw new ErreurMetier(400, 'Demi-journée invalide.')
  if (typeof corps.present !== 'boolean') throw new ErreurMetier(400, 'Présence invalide.')
  const demiJournee = corps.demiJournee
  const present = corps.present

  const { rows: [p] } = await sql<{ statut: string, debut: string, fin: string }>`
    select s.statut, to_char(s.date_debut, 'YYYY-MM-DD') as debut, to_char(s.date_fin, 'YYYY-MM-DD') as fin
    from participant p join session_formation s on s.id = p.session_id where p.id = ${participantId}`.execute(trx)
  if (!p) throw new ErreurMetier(404, 'Participant introuvable.')
  if (p.statut === 'annulee') throw new ErreurMetier(409, 'Session annulée : émargement impossible.')
  if (jour < p.debut || jour > p.fin) throw new ErreurMetier(400, 'Ce jour est hors de la période de la session.')

  await trx.insertInto('emargement')
    .values({ entreprise_id: ctx.entrepriseId, participant_id: participantId, jour, demi_journee: demiJournee, present, signe_le: present ? sql`now()` : null })
    .onConflict((oc) => oc.columns(['participant_id', 'jour', 'demi_journee']).doUpdateSet({ present, signe_le: present ? sql`now()` : null }))
    .execute()
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'emargement', objetId: participantId, details: { jour, demiJournee, present } })
}

// ---------------------------------------------------------------------------
// Catalogue : administrateur (sous withPlatformAdmin, opération gerer_catalogue_formation)
// ---------------------------------------------------------------------------

export async function listerCatalogueAdmin(trx: Transaction<DB>) {
  return trx.selectFrom('formation')
    .select(['id', 'slug', 'intitule', 'domaine', 'duree_jours', 'duree_libelle', 'validite_mois', 'actif'])
    .where('entreprise_id', 'is', null).orderBy('domaine').orderBy('intitule').execute()
}

/** Validité de la certification (mois, vide = sans échéance) et activation d'une fiche du catalogue. */
export async function modifierFormationCatalogue(trx: Transaction<DB>, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Formation')
  const valeurs: { validite_mois?: number | null, actif?: boolean } = {}
  if ('validiteMois' in corps) valeurs.validite_mois = entierBorne(corps.validiteMois, 'Validité', 1, 240)
  if ('actif' in corps) {
    if (typeof corps.actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
    valeurs.actif = corps.actif
  }
  if (!Object.keys(valeurs).length) throw new ErreurMetier(400, 'Aucune modification.')
  const r = await trx.updateTable('formation').set(valeurs).where('id', '=', id).where('entreprise_id', 'is', null).executeTakeFirst()
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Formation du catalogue introuvable.')
}
