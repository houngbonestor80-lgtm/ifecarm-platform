import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { ecrireJournal } from '@/db/journal'
import type { DB } from '@/db/types.generated'

export interface CreerDeclarationParams {
  entrepriseId: string
  /** Utilisateur/appareil authentifié qui synchronise — toujours présent
   * (withTenant l'exige), même pour une déclaration anonyme : l'anonymat
   * porte sur le CONTENU, jamais sur la session qui l'envoie. */
  utilisateurId: string
  siteId?: string | null
  type: string
  survenuLe: Date
  lieu?: string | null
  service?: string | null
  description: string
  anonyme: boolean
  declarantId?: string | null
  salarieId?: string | null
  victimeExterne?: string | null
  arretTravail?: boolean | null
  joursArret?: number | null
  /** Générée par l'appareil (crypto.randomUUID()) — absente = pas de garantie de rejeu. */
  cleClient?: string | null
  saisiHorsLigne: boolean
}

export interface DeclarationCreee {
  id: string
  reference: string
}

/**
 * Point d'entrée unique de création d'une déclaration (saisie directe ou
 * synchronisation hors ligne). Concentre trois garanties issues de la revue
 * de sécurité :
 *
 *   1. Idempotence du rejeu : ON CONFLICT (entreprise_id, cle_client) DO
 *      NOTHING RETURNING, puis un SELECT explicite si rien n'est revenu
 *      (conflit = rejeu). Pas `(xmax = 0)` : cette astuce, bien que très
 *      répandue, s'appuie sur un détail d'implémentation NON documenté de
 *      Postgres — non garanti par l'API (cf. liste de diffusion
 *      pgsql-hackers, aucune sémantique officielle de RETURNING pour
 *      distinguer insert/update sur un conflit). DO NOTHING RETURNING, lui,
 *      a un comportement documenté et stable : aucune ligne renvoyée en cas
 *      de conflit, point. Les effets de bord (journal, historique,
 *      notification) ne s'exécutent que sur une vraie insertion — un rejeu
 *      ne doit pas doubler la notification du responsable.
 *   2. Génération de référence sans condition de course : déléguée à
 *      generer_reference_declaration() (compteur atomique en base). Sur un
 *      rejeu, une référence est générée puis jetée (jamais écrite) : gaspille
 *      un numéro de compteur, sans incidence sur la justesse — la ligne
 *      renvoyée porte toujours sa référence RÉELLE (celle de la première
 *      insertion), lue depuis RETURNING, jamais depuis la variable locale.
 *   3. Anonymat qui ne fuite ni dans journal_audit ni dans la notification
 *      déposée — même si l'appelant authentifié (utilisateurId) est connu.
 */
export async function creerDeclaration(
  trx: Transaction<DB>,
  params: CreerDeclarationParams,
): Promise<DeclarationCreee> {
  const { rows: [refRow] } = await sql<{ generer_reference_declaration: string }>`
    select generer_reference_declaration(${params.entrepriseId}::uuid)
  `.execute(trx)
  const referenceCandidate = refRow!.generer_reference_declaration

  // La contrainte CHECK en base bloque déjà declarant_id/salarie_id non-NULL
  // sur une ligne anonyme ; on ne prend pas le risque de laisser passer une
  // valeur fournie par erreur par l'appelant avant même d'atteindre la base.
  const declarantId = params.anonyme ? null : (params.declarantId ?? null)
  const salarieId = params.anonyme ? null : (params.salarieId ?? null)

  const insere = await trx
    .insertInto('declaration')
    .values({
      entreprise_id: params.entrepriseId,
      site_id: params.siteId ?? null,
      reference: referenceCandidate,
      type: params.type,
      survenu_le: params.survenuLe,
      lieu: params.lieu ?? null,
      service: params.service ?? null,
      description: params.description,
      anonyme: params.anonyme,
      declarant_id: declarantId,
      salarie_id: salarieId,
      victime_externe: params.victimeExterne ?? null,
      arret_travail: params.arretTravail ?? null,
      jours_arret: params.joursArret ?? null,
      cle_client: params.cleClient ?? null,
      saisi_hors_ligne: params.saisiHorsLigne,
    })
    .onConflict((oc) => oc.columns(['entreprise_id', 'cle_client']).doNothing())
    .returning(['id', 'reference'])
    .executeTakeFirst()

  // insere === undefined ne peut arriver QUE sur un vrai conflit (NULL ne
  // "conflicte" jamais en SQL standard, donc uniquement possible si
  // params.cleClient était renseigné) : on va chercher la ligne déjà là.
  const inserted =
    insere ??
    (await trx
      .selectFrom('declaration')
      .select(['id', 'reference'])
      .where('entreprise_id', '=', params.entrepriseId)
      .where('cle_client', '=', params.cleClient!)
      .executeTakeFirstOrThrow())

  const etaitUneInsertion = insere !== undefined

  if (etaitUneInsertion) {
    // journal_audit : jamais l'identité de l'appelant sur une déclaration
    // anonyme — sinon un administrateur recoupe "qui" a créé "quelle"
    // déclaration anonyme par horodatage, ce qui annule l'anonymat.
    await ecrireJournal(trx, {
      utilisateurId: params.anonyme ? null : params.utilisateurId,
      entrepriseId: params.entrepriseId,
      action: 'creation_declaration',
      objetType: 'declaration',
      objetId: inserted.id,
      details: null, // jamais de description/lieu ici (contrainte projet)
    })

    await trx
      .insertInto('historique_declaration')
      .values({
        entreprise_id: params.entrepriseId,
        declaration_id: inserted.id,
        utilisateur_id: params.anonyme ? null : params.utilisateurId,
        statut_avant: null,
        statut_apres: 'a_qualifier',
        commentaire: null,
      })
      .execute()

    // Notification au(x) responsable(s) : contenu générique (référence,
    // rien d'autre) — jamais l'identité du déclarant, anonyme ou pas. Le
    // responsable ouvre la déclaration dans l'app pour le détail.
    const responsables = await trx
      .selectFrom('role_utilisateur as ru')
      .innerJoin('utilisateur as u', 'u.id', 'ru.utilisateur_id')
      .select(['u.email'])
      .where('ru.role', 'in', ['responsable_qhse', 'admin_entreprise'])
      .where('u.entreprise_id', '=', params.entrepriseId)
      .execute()

    for (const responsable of responsables) {
      await trx
        .insertInto('notification')
        .values({
          entreprise_id: params.entrepriseId,
          canal: 'email',
          destinataire: responsable.email,
          sujet: 'Nouvelle déclaration à qualifier',
          corps: `Une nouvelle déclaration (${inserted.reference}) a été enregistrée et attend qualification.`,
          module: 'registre',
        })
        .execute()
    }
  }

  return { id: inserted.id, reference: inserted.reference }
}
