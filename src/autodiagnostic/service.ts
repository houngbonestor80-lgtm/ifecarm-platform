import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ErreurAcces } from '@/auth/contexte'
import { ecrireJournal } from '@/db/journal'
import { ErreurMetier, date, resoudreSite, texte, texteOptionnel, uuid } from '@/inspections/service'

/**
 * B1 — autodiagnostic QHSE (migration 0047). Le consultant conduit l'évaluation chez / avec le client ; le client
 * (admin d'entreprise, responsable QHSE) lit les évaluations TERMINÉES. Le questionnaire est copié du catalogue à la création,
 * le résultat est calculé par la base (terminer_autodiagnostic) : ce service ne calcule aucun score.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Reponse { code: string, libelle: string, coefficient: number }
export interface Niveau { seuilMin: number, seuilMax: number, libelle: string, message: string }
export interface Question { id: string, texte: string, aide?: string | null, poids: number, recommandation: string }
export interface Theme { code: string, libelle: string, questions: Question[] }
export interface Definition { echelleReponses: Reponse[], niveaux: Niveau[], themes: Theme[] }
export interface Resultat {
  globalScore: number
  niveau: Niveau
  themes: { code: string, libelle: string, score: number }[]
  recommendations: { questionId: string, texte: string, poids: number, themeCode: string, themeLibelle: string }[]
}

/** Règles de la base (codes IF403 / IF404 / IF409) renvoyées telles quelles à l'utilisateur. */
async function regles<T>(cb: () => Promise<T>): Promise<T> {
  try {
    return await cb()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
    if (code === 'IF404') throw new ErreurMetier(404, (e as Error).message)
    if (code === 'IF403') throw new ErreurAcces(403, (e as Error).message)
    if (code === '23503') throw new ErreurMetier(409, 'Des actions dépendent de cette évaluation : elle ne peut pas être supprimée.')
    throw e
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

const NB_QUESTIONS = sql<number>`(select count(*) from jsonb_array_elements(definition->'themes') t, jsonb_array_elements(t->'questions') q)::int`

export async function listerReferentiels(trx: Transaction<DB>) {
  const { rows } = await sql<{ code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, nb_questions: number }>`
    select code, titre, description, duree_estimee_minutes, avertissement, ${NB_QUESTIONS} as nb_questions
    from referentiel_autodiagnostic where actif order by titre`.execute(trx)
  return rows
}

export async function listerEvaluations(trx: Transaction<DB>) {
  const { rows } = await sql<{
    id: string, reference: string, referentiel_code: string, referentiel_titre: string, statut: string, score_global: number | null,
    niveau_libelle: string | null, realise_le: string, site_nom: string | null, interlocuteur: string | null, conduit_par_nom: string | null,
    nb_questions: number, nb_reponses: number, score_precedent: number | null,
  }>`
    select a.id, a.reference, a.referentiel_code, a.referentiel_titre, a.statut, a.score_global, a.niveau_libelle,
           to_char(a.realise_le, 'YYYY-MM-DD') as realise_le, s.nom as site_nom, a.interlocuteur, u.nom as conduit_par_nom,
           (select count(*) from jsonb_array_elements(a.definition->'themes') t, jsonb_array_elements(t->'questions') q)::int as nb_questions,
           (select count(*) from jsonb_object_keys(a.reponses))::int as nb_reponses,
           (select p.score_global from autodiagnostic p
             where p.entreprise_id = a.entreprise_id and p.referentiel_code = a.referentiel_code and p.statut = 'terminee' and p.id <> a.id
               and (p.realise_le, p.terminee_le) < (a.realise_le, coalesce(a.terminee_le, now()))
             order by p.realise_le desc, p.terminee_le desc limit 1) as score_precedent
    from autodiagnostic a
    left join site s on s.id = a.site_id
    left join utilisateur u on u.id = a.conduit_par
    order by a.realise_le desc, a.cree_le desc
    limit 500`.execute(trx)
  return rows
}

export async function obtenirEvaluation(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Évaluation')
  const { rows: [a] } = await sql<{
    id: string, reference: string, referentiel_code: string, referentiel_titre: string, avertissement: string, definition: Definition,
    statut: string, reponses: Record<string, string>, commentaires: Record<string, string>, resultat: Resultat | null, score_global: number | null,
    niveau_libelle: string | null, realise_le: string, terminee_le: string | null, site_id: string | null, site_nom: string | null,
    interlocuteur: string | null, conduit_par_nom: string | null, entreprise_id: string,
  }>`
    select a.id, a.entreprise_id, a.reference, a.referentiel_code, a.referentiel_titre, a.avertissement, a.definition, a.statut, a.reponses,
           a.commentaires, a.resultat, a.score_global, a.niveau_libelle, to_char(a.realise_le, 'YYYY-MM-DD') as realise_le,
           a.terminee_le::text as terminee_le, a.site_id, s.nom as site_nom, a.interlocuteur, u.nom as conduit_par_nom
    from autodiagnostic a
    left join site s on s.id = a.site_id
    left join utilisateur u on u.id = a.conduit_par
    where a.id = ${id}`.execute(trx)
  if (!a) throw new ErreurMetier(404, 'Évaluation introuvable.')

  // Évaluation précédente du même référentiel pour la même entreprise : comparaison thème par thème.
  let precedente: { id: string, realise_le: string, score_global: number, themes: { code: string, score: number }[] } | null = null
  if (a.statut === 'terminee') {
    const { rows: [p] } = await sql<{ id: string, realise_le: string, score_global: number, resultat: Resultat }>`
      select id, to_char(realise_le, 'YYYY-MM-DD') as realise_le, score_global, resultat from autodiagnostic
      where entreprise_id = ${a.entreprise_id} and referentiel_code = ${a.referentiel_code} and statut = 'terminee' and id <> ${a.id}
        and (realise_le, terminee_le) < (${a.realise_le}::date, ${a.terminee_le}::timestamptz)
      order by realise_le desc, terminee_le desc limit 1`.execute(trx)
    if (p) precedente = { id: p.id, realise_le: p.realise_le, score_global: p.score_global, themes: p.resultat.themes.map((t) => ({ code: t.code, score: t.score })) }
  }

  const { rows: actions } = await sql<{ question_id: string, id: string, reference: string, libelle: string, statut: string, echeance: string | null, responsable_nom: string | null, en_retard: boolean }>`
    select l.question_id, ac.id, ac.reference, ac.libelle, ac.statut, to_char(ac.echeance, 'YYYY-MM-DD') as echeance, ac.responsable_nom,
           (ac.echeance is not null and ac.echeance < current_date and ac.statut in ('a_faire', 'en_cours')) as en_retard
    from autodiagnostic_action l join action_corrective ac on ac.id = l.action_id
    where l.autodiagnostic_id = ${a.id} order by ac.cree_le`.execute(trx)

  const { entreprise_id: _e, ...reste } = a
  return { ...reste, precedente, actions }
}

/** Dernier résultat par référentiel (vue du tableau de bord) avec le précédent. */
export async function resumeAutodiagnostic(trx: Transaction<DB>) {
  const { rows } = await sql<{ id: string, referentiel_code: string, referentiel_titre: string, score_global: number, niveau_libelle: string, realise_le: string, score_precedent: number | null }>`
    select id, referentiel_code, referentiel_titre, score_global, niveau_libelle, to_char(realise_le, 'YYYY-MM-DD') as realise_le, score_precedent
    from v_autodiagnostic_dernier order by realise_le desc, referentiel_titre`.execute(trx)
  return { derniers: rows }
}

// ---------------------------------------------------------------------------
// Écriture (équipe IFECARM)
// ---------------------------------------------------------------------------

type Ctx = { entrepriseId: string, utilisateurId: string }

export async function creerEvaluation(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const referentiel = texte(corps.referentiel, 'Référentiel', 60)
  const siteId = await resoudreSite(trx, ctx.entrepriseId, corps)
  const realiseLe = corps.realiseLe === undefined || corps.realiseLe === '' ? new Date().toLocaleDateString('sv-SE') : date(corps.realiseLe, 'Date de l’évaluation')
  const { rows: [a] } = await regles(() => sql<{ id: string, reference: string }>`
    insert into autodiagnostic (entreprise_id, referentiel_code, site_id, interlocuteur, realise_le, conduit_par)
    values (${ctx.entrepriseId}, ${referentiel}, ${siteId}, ${texteOptionnel(corps.interlocuteur, 'Interlocuteur', 200)}, ${realiseLe}::date, ${ctx.utilisateurId})
    returning id, reference`.execute(trx))
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'autodiagnostic', objetId: a!.id, details: { referentiel } })
  return a!
}

/**
 * Réponses et commentaires, par lot : { reponses: { questionId: code | null }, commentaires: { questionId: texte | null } }.
 * `null` ou chaîne vide retire la valeur. La base valide les identifiants et les codes contre le questionnaire copié.
 */
export async function enregistrerReponses(trx: Transaction<DB>, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Évaluation')
  const lot = (v: unknown, champ: string) => {
    if (v === undefined) return {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ErreurMetier(400, `${champ} : objet attendu.`)
    return v as Record<string, unknown>
  }
  const reponses = lot(corps.reponses, 'reponses')
  const commentaires = lot(corps.commentaires, 'commentaires')
  if (!Object.keys(reponses).length && !Object.keys(commentaires).length) throw new ErreurMetier(400, 'Rien à enregistrer.')

  const { rows: [a] } = await sql<{ statut: string, reponses: Record<string, string>, commentaires: Record<string, string> }>`
    select statut, reponses, commentaires from autodiagnostic where id = ${id} for update`.execute(trx)
  if (!a) throw new ErreurMetier(404, 'Évaluation introuvable.')
  if (a.statut === 'terminee') throw new ErreurMetier(409, 'Évaluation terminée : définitive.')

  const fusion = (actuel: Record<string, string>, lotRecu: Record<string, unknown>, max: number) => {
    const r = { ...actuel }
    for (const [k, v] of Object.entries(lotRecu)) {
      if (v === null || v === '') { delete r[k]; continue }
      if (typeof v !== 'string' || v.length > max) throw new ErreurMetier(400, `Valeur invalide pour ${k}.`)
      r[k] = v
    }
    return r
  }
  const nouvellesReponses = fusion(a.reponses, reponses, 40)
  const nouveauxCommentaires = fusion(a.commentaires, Object.fromEntries(Object.entries(commentaires).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])), 1000)
  await regles(() => sql`update autodiagnostic set reponses = ${JSON.stringify(nouvellesReponses)}::jsonb, commentaires = ${JSON.stringify(nouveauxCommentaires)}::jsonb where id = ${id}`.execute(trx))
  return { reponses: Object.keys(nouvellesReponses).length }
}

/** Intervenants et site tant que l'évaluation est ouverte. */
export async function modifierEvaluation(trx: Transaction<DB>, idBrut: unknown, ctx: Ctx, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Évaluation')
  const maj: { interlocuteur?: string | null, site_id?: string | null, realise_le?: string } = {}
  if ('interlocuteur' in corps) maj.interlocuteur = texteOptionnel(corps.interlocuteur, 'Interlocuteur', 200)
  if ('siteId' in corps || 'nouveauSite' in corps) maj.site_id = await resoudreSite(trx, ctx.entrepriseId, corps)
  if ('realiseLe' in corps) maj.realise_le = date(corps.realiseLe, 'Date de l’évaluation')
  if (!Object.keys(maj).length) throw new ErreurMetier(400, 'Rien à modifier.')
  const r = await regles(() => trx.updateTable('autodiagnostic').set(maj as never).where('id', '=', id).executeTakeFirst())
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Évaluation introuvable.')
}

export async function terminerEvaluation(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown) {
  const id = uuid(idBrut, 'Évaluation')
  const { rows: [r] } = await regles(() => sql<{ r: Resultat }>`select terminer_autodiagnostic(${id}) as r`.execute(trx))
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'cloture', objetType: 'autodiagnostic', objetId: id, details: { score: r!.r.globalScore } })
  return r!.r
}

export async function supprimerEvaluation(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown) {
  const id = uuid(idBrut, 'Évaluation')
  const r = await regles(() => trx.deleteFrom('autodiagnostic').where('id', '=', id).executeTakeFirst())
  if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Évaluation introuvable.')
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'autodiagnostic', objetId: id, details: null })
}

/**
 * Plan d'action depuis les écarts : une action corrective (origine « audit ») par question choisie parmi les recommandations
 * du résultat. Une question déjà traitée est ignorée (une action par question).
 */
export async function creerActionsDepuisEcarts(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Évaluation')
  if (!Array.isArray(corps.questionIds) || corps.questionIds.length === 0) throw new ErreurMetier(400, 'Choisissez au moins un écart.')
  if (corps.questionIds.length > 100) throw new ErreurMetier(400, '100 actions au maximum à la fois.')
  const echeance = corps.echeance ? date(corps.echeance, 'Échéance') : null
  const responsable = texteOptionnel(corps.responsable, 'Responsable', 200)

  const { rows: [a] } = await sql<{ reference: string, referentiel_titre: string, site_id: string | null, statut: string, resultat: Resultat | null, definition: Definition }>`
    select reference, referentiel_titre, site_id, statut, resultat, definition from autodiagnostic where id = ${id}`.execute(trx)
  if (!a) throw new ErreurMetier(404, 'Évaluation introuvable.')
  if (a.statut !== 'terminee' || !a.resultat) throw new ErreurMetier(409, 'Les actions se créent depuis une évaluation terminée.')

  const ecarts = new Map(a.resultat.recommendations.map((r) => [r.questionId, r]))
  const texteQuestion = new Map(a.definition.themes.flatMap((t) => t.questions.map((q) => [q.id, q.texte] as const)))
  const deja = new Set((await sql<{ question_id: string }>`select question_id from autodiagnostic_action where autodiagnostic_id = ${id}`.execute(trx)).rows.map((r) => r.question_id))

  const crees: { questionId: string, id: string, reference: string }[] = []
  for (const brut of [...new Set(corps.questionIds)]) {
    const questionId = texte(brut, 'Question', 40)
    const ecart = ecarts.get(questionId)
    if (!ecart) throw new ErreurMetier(400, `« ${questionId} » n’est pas un écart de cette évaluation.`)
    if (deja.has(questionId)) continue
    const action = await trx.insertInto('action_corrective').values({
      entreprise_id: ctx.entrepriseId,
      site_id: a.site_id,
      reference: `PA-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`,
      origine_type: 'audit',
      origine_id: id,
      libelle: ecart.texte.slice(0, 300),
      description: `Écart relevé lors de l’autodiagnostic « ${a.referentiel_titre} » (${a.reference}), thème « ${ecart.themeLibelle} ». Question : ${texteQuestion.get(questionId) ?? questionId}`,
      responsable_nom: responsable,
      echeance,
    }).returning(['id', 'reference']).executeTakeFirstOrThrow()
    await regles(() => sql`insert into autodiagnostic_action (autodiagnostic_id, entreprise_id, question_id, action_id) values (${id}, ${ctx.entrepriseId}, ${questionId}, ${action.id})`.execute(trx))
    crees.push({ questionId, id: action.id, reference: action.reference })
  }
  if (crees.length) await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'autodiagnostic', objetId: id, details: { actions: crees.length } })
  return { crees }
}

// ---------------------------------------------------------------------------
// Catalogue des référentiels (administrateur)
// ---------------------------------------------------------------------------

/** Contrôle lisible du questionnaire (la base reste l'autorité : definition_autodiagnostic_valide). */
export function validerDefinition(d: unknown): Definition {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
  const echelle = o.echelleReponses
  if (!Array.isArray(echelle) || echelle.length < 2) throw new ErreurMetier(400, 'L’échelle de réponses doit comporter au moins deux réponses.')
  const codes = new Set<string>()
  let pleine = false
  for (const e of echelle as Record<string, unknown>[]) {
    if (typeof e.code !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e.code)) throw new ErreurMetier(400, 'Code de réponse invalide (minuscules, chiffres, tirets).')
    if (typeof e.libelle !== 'string' || !e.libelle.trim()) throw new ErreurMetier(400, 'Chaque réponse a besoin d’un libellé.')
    if (typeof e.coefficient !== 'number' || e.coefficient < 0 || e.coefficient > 1) throw new ErreurMetier(400, 'Le coefficient d’une réponse est compris entre 0 et 1.')
    if (codes.has(e.code)) throw new ErreurMetier(400, `Réponse en double : ${e.code}.`)
    codes.add(e.code)
    if (e.coefficient === 1) pleine = true
  }
  if (!pleine) throw new ErreurMetier(400, 'Une réponse doit valoir 1 (conformité complète).')
  const niveaux = o.niveaux
  if (!Array.isArray(niveaux) || niveaux.length < 1) throw new ErreurMetier(400, 'Au moins un niveau de maturité est requis.')
  let attendu = 0
  for (const n of niveaux as Record<string, unknown>[]) {
    if (!Number.isInteger(n.seuilMin) || !Number.isInteger(n.seuilMax) || typeof n.libelle !== 'string' || typeof n.message !== 'string') throw new ErreurMetier(400, 'Niveau incomplet (seuils, libellé, message).')
    if (n.seuilMin !== attendu || (n.seuilMax as number) < (n.seuilMin as number)) throw new ErreurMetier(400, `Les niveaux doivent se suivre sans trou ni chevauchement, de 0 à 100 (attendu : à partir de ${attendu} %).`)
    attendu = (n.seuilMax as number) + 1
  }
  if (attendu !== 101) throw new ErreurMetier(400, 'Les niveaux doivent couvrir de 0 à 100 %.')
  const themes = o.themes
  if (!Array.isArray(themes) || themes.length < 1) throw new ErreurMetier(400, 'Au moins un thème est requis.')
  const ids = new Set<string>()
  let nb = 0
  for (const t of themes as Record<string, unknown>[]) {
    if (typeof t.code !== 'string' || !t.code.trim() || typeof t.libelle !== 'string' || !t.libelle.trim()) throw new ErreurMetier(400, 'Chaque thème a besoin d’un code et d’un libellé.')
    if (!Array.isArray(t.questions) || t.questions.length < 1) throw new ErreurMetier(400, `Le thème « ${t.libelle} » n’a aucune question.`)
    for (const q of t.questions as Record<string, unknown>[]) {
      if (typeof q.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(q.id)) throw new ErreurMetier(400, 'Identifiant de question invalide (minuscules, chiffres, tirets).')
      if (ids.has(q.id)) throw new ErreurMetier(400, `Identifiant de question en double : ${q.id}.`)
      ids.add(q.id)
      if (typeof q.texte !== 'string' || !q.texte.trim()) throw new ErreurMetier(400, `La question ${q.id} n’a pas de texte.`)
      if (typeof q.recommandation !== 'string' || !q.recommandation.trim()) throw new ErreurMetier(400, `La question ${q.id} n’a pas de recommandation.`)
      if (!Number.isInteger(q.poids) || (q.poids as number) < 1 || (q.poids as number) > 10) throw new ErreurMetier(400, `Le poids de la question ${q.id} est un entier de 1 à 10.`)
      nb++
    }
  }
  if (nb > 300) throw new ErreurMetier(400, '300 questions au maximum.')
  return d as Definition
}

export async function listerCatalogue(trx: Transaction<DB>) {
  const { rows } = await sql<{ id: string, code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, actif: boolean, nb_questions: number, nb_evaluations: number }>`
    select r.id, r.code, r.titre, r.description, r.duree_estimee_minutes, r.avertissement, r.actif, ${NB_QUESTIONS} as nb_questions,
           nombre_evaluations_autodiagnostic(r.code) as nb_evaluations
    from referentiel_autodiagnostic r order by r.actif desc, r.titre`.execute(trx)
  return rows
}

export async function obtenirReferentiel(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Référentiel')
  const { rows: [r] } = await sql<{ id: string, code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, actif: boolean, definition: Definition }>`
    select id, code, titre, description, duree_estimee_minutes, avertissement, actif, definition from referentiel_autodiagnostic where id = ${id}`.execute(trx)
  if (!r) throw new ErreurMetier(404, 'Référentiel introuvable.')
  return r
}

const entierBorne = (v: unknown, champ: string, min: number, max: number) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ErreurMetier(400, `${champ} : un entier entre ${min} et ${max}.`)
  return n
}

export async function creerReferentiel(trx: Transaction<DB>, corps: Record<string, unknown>) {
  const code = texte(corps.code, 'Code', 60)
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(code)) throw new ErreurMetier(400, 'Code : minuscules, chiffres et tirets (2 à 60 caractères), ex. iso-9001-interne.')
  const definition = validerDefinition(corps.definition)
  try {
    const { rows: [r] } = await sql<{ id: string }>`
      insert into referentiel_autodiagnostic (code, titre, description, duree_estimee_minutes, avertissement, definition)
      values (${code}, ${texte(corps.titre, 'Titre', 200)}, ${texte(corps.description, 'Description', 1000)}, ${entierBorne(corps.dureeEstimeeMinutes, 'Durée estimée', 1, 240)},
              ${texte(corps.avertissement, 'Avertissement', 1000)}, ${JSON.stringify(definition)}::jsonb)
      returning id`.execute(trx)
    return r!
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ErreurMetier(409, 'Ce code existe déjà.')
    throw e
  }
}

/** Modifier un référentiel ne touche jamais aux évaluations existantes (leur questionnaire est une copie figée). */
export async function modifierReferentiel(trx: Transaction<DB>, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Référentiel')
  const maj: Record<string, unknown> = {}
  if ('titre' in corps) maj.titre = texte(corps.titre, 'Titre', 200)
  if ('description' in corps) maj.description = texte(corps.description, 'Description', 1000)
  if ('avertissement' in corps) maj.avertissement = texte(corps.avertissement, 'Avertissement', 1000)
  if ('dureeEstimeeMinutes' in corps) maj.duree_estimee_minutes = entierBorne(corps.dureeEstimeeMinutes, 'Durée estimée', 1, 240)
  if ('actif' in corps) {
    if (typeof corps.actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
    maj.actif = corps.actif
  }
  if ('definition' in corps) maj.definition = sql`${JSON.stringify(validerDefinition(corps.definition))}::jsonb`
  if (!Object.keys(maj).length) throw new ErreurMetier(400, 'Aucune modification.')
  const r = await trx.updateTable('referentiel_autodiagnostic').set(maj as never).where('id', '=', id).executeTakeFirst()
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Référentiel introuvable.')
}

/** Suppression d'un référentiel : seulement s'il n'a jamais servi (sinon, désactivez-le). */
export async function supprimerReferentiel(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Référentiel')
  const r = await obtenirReferentiel(trx, id)
  const { rows: [n] } = await sql<{ n: number }>`select nombre_evaluations_autodiagnostic(${r.code}) as n`.execute(trx)
  if (n!.n) throw new ErreurMetier(409, 'Ce référentiel a déjà servi : désactivez-le plutôt que de le supprimer.')
  await trx.deleteFrom('referentiel_autodiagnostic').where('id', '=', id).execute()
}
