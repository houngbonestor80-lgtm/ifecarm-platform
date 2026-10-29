import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { withoutTenant } from '@/db/tenant'
import type { DB } from '@/db/types.generated'
import { ErreurMetier } from '@/inspections/service'
import { envoyerEmail, urlPublique, type Courriel } from '@/notifications/email'

/**
 * Mini-audit gratuit public (migration 0052). Le visiteur n'a pas de compte : tout passe par les fonctions SECURITY
 * DEFINER de la base (questionnaires, envoi, lecture par code de suivi). L'équipe IFECARM lit les demandes (RLS),
 * les suit et les convertit en prospect.
 */

/** Limite atteinte (5 demandes par heure et par IP, 3 par jour et par e-mail) : la route répond 429. */
export class ErreurLimite extends Error {}

export type StatutMiniAudit = 'nouveau' | 'contacte' | 'converti' | 'sans_suite'
export const EFFECTIFS = ['1-9', '10-49', '50-249', '250+'] as const

interface Resultat {
  globalScore: number
  niveau: { libelle: string, message: string }
  themes: { code: string, libelle: string, score: number }[]
  recommendations: { questionId: string, texte: string, poids: number, themeLibelle: string }[]
}

const codeErreur = (e: unknown) => (e as { code?: string }).code

/** Questionnaires publics et pays proposés (page publique, sans compte). */
export async function questionnairesPublics() {
  return withoutTenant(async (trx) => ({
    questionnaires: (await sql<{ code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, definition: unknown }>`
      select * from questionnaires_mini_audit()`.execute(trx)).rows,
    pays: await trx.selectFrom('pays_intervention').select(['code', 'nom']).where('actif', '=', true).orderBy('nom').execute(),
  }))
}

const texte = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Enregistre la demande. Les contrôles qui comptent (réponses complètes, score, limites, coordonnées) sont faits par la
 * base ; ici, seulement la forme du corps. Renvoie le code de suivi et l'envoi des e-mails (non attendu par la route).
 */
export async function soumettreMiniAudit(
  corps: Record<string, unknown>,
  adresseIp: string,
  envoyer: (c: Courriel) => Promise<void> = envoyerEmail,
): Promise<{ code: string, score: number, niveau: string, envoi: Promise<void> }> {
  // Champ piège invisible : un robot le remplit, un humain jamais.
  if (texte(corps.siteWeb, 10)) throw new ErreurMetier(400, 'Demande refusée.')
  const contact = (corps.contact && typeof corps.contact === 'object' ? corps.contact : {}) as Record<string, unknown>
  const c = {
    nom: texte(contact.nom, 200), fonction: texte(contact.fonction, 200), entreprise: texte(contact.entreprise, 200),
    email: texte(contact.email, 200).toLowerCase(), telephone: texte(contact.telephone, 30), pays: texte(contact.pays, 2),
    secteur: texte(contact.secteur, 200), effectif: (EFFECTIFS as readonly string[]).includes(contact.effectif as string) ? contact.effectif : '',
    consentement: contact.consentement === true,
  }
  const reponses = corps.reponses && typeof corps.reponses === 'object' && !Array.isArray(corps.reponses) ? corps.reponses : {}
  let ligne: { code_suivi: string, score_global: number, niveau_libelle: string } | undefined
  try {
    ligne = (await withoutTenant((trx) => sql<{ code_suivi: string, score_global: number, niveau_libelle: string }>`
      select * from soumettre_mini_audit(${texte(corps.questionnaire, 60)}, ${JSON.stringify(reponses)}::jsonb, ${JSON.stringify(c)}::jsonb, ${adresseIp}::inet)`
      .execute(trx))).rows[0]
  } catch (e) {
    if (codeErreur(e) === 'IF429') throw new ErreurLimite((e as Error).message)
    if (codeErreur(e) === 'IF409') throw new ErreurMetier(400, (e as Error).message)
    throw e
  }
  const code = ligne!.code_suivi
  const envoi = (async () => {
    const r = await lireResultat(code)
    const equipe = await withoutTenant(async (trx) => (await sql<{ email: string }>`select destinataires_alerte_mini_audit() as email`.execute(trx)).rows)
    const courriels = [courrielResultat(c.nom, c.email, code, r!.referentiel_titre, r!.resultat)]
    for (const d of equipe) courriels.push(courrielAlerte(d.email, code, { ...c, score: ligne!.score_global, niveau: ligne!.niveau_libelle }))
    for (const m of courriels) {
      // Jamais le contenu (il porte le lien du résultat) : seulement le fait et la cause.
      await envoyer(m).catch((e) => console.error('[mini-audit] envoi impossible :', (e as Error).message))
    }
  })()
  return { code, score: ligne!.score_global, niveau: ligne!.niveau_libelle, envoi }
}

export const lienResultat = (code: string) => `${urlPublique()}/mini-audit/${encodeURIComponent(code)}`

export function courrielResultat(nom: string, email: string, code: string, titre: string, r: Resultat): Courriel {
  return {
    a: email,
    sujet: `Votre résultat au ${titre} : ${r.globalScore} % — IFECARM GROUP`,
    texte: [
      `Bonjour ${nom},`,
      '',
      `Merci d'avoir répondu au ${titre}. Votre score : ${r.globalScore} % (${r.niveau.libelle}).`,
      r.niveau.message,
      '',
      'Vos trois priorités :',
      ...r.recommendations.slice(0, 3).map((x, i) => `${i + 1}. ${x.texte}`),
      '',
      `Votre résultat complet (code de suivi ${code}) :`,
      lienResultat(code),
      '',
      'Un consultant IFECARM GROUP vous contactera pour en parler et vous proposer un diagnostic sur site.',
      '',
      'IFECARM GROUP — Conseil QHSE, Cotonou et Paris',
    ].join('\n'),
  }
}

export function courrielAlerte(
  email: string,
  code: string,
  c: { nom: string, fonction: string, entreprise: string, email: string, telephone: string, pays: string, secteur: string, effectif: unknown, score: number, niveau: string },
): Courriel {
  return {
    a: email,
    sujet: `Nouveau mini-audit : ${c.entreprise} (${c.score} %)`,
    texte: [
      `${c.entreprise} (${c.pays}${c.secteur ? `, ${c.secteur}` : ''}${c.effectif ? `, ${c.effectif} salariés` : ''}) a fait le mini-audit gratuit.`,
      `Score : ${c.score} % (${c.niveau}). Code de suivi : ${code}.`,
      '',
      `Contact : ${c.nom}${c.fonction ? `, ${c.fonction}` : ''}`,
      `E-mail : ${c.email}`,
      c.telephone ? `Téléphone : ${c.telephone}` : 'Téléphone : non renseigné',
      '',
      `À rappeler depuis la plateforme : ${urlPublique()}/mini-audits`,
    ].join('\n'),
  }
}

/** Résultat pour qui détient le code (jamais l'e-mail ni le téléphone). */
export async function lireResultat(code: string) {
  if (!/^MA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code)) return undefined
  return (await withoutTenant((trx) => sql<{
    code_suivi: string, referentiel_titre: string, entreprise_nom: string, nom_contact: string, cree_le: Date, resultat: Resultat, avertissement: string,
  }>`select * from lire_mini_audit(${code})`.execute(trx))).rows[0]
}

// ---------------------------------------------------------------------
// Équipe IFECARM (sous withAuthenticatedUser : la RLS exige un consultant ou un admin)
// ---------------------------------------------------------------------

export async function listerMiniAudits(trx: Transaction<DB>) {
  return trx.selectFrom('mini_audit as m')
    .leftJoin('entreprise as e', 'e.id', 'm.entreprise_id')
    .select(['m.id', 'm.code_suivi', 'm.referentiel_titre', 'm.score_global', 'm.niveau_libelle', 'm.nom_contact', 'm.fonction',
      'm.entreprise_nom', 'm.email', 'm.telephone', 'm.pays', 'm.secteur', 'm.effectif', 'm.cree_le', 'm.statut', 'm.suivi_le',
      'm.entreprise_id', 'e.nom as prospect_nom', 'm.resultat'])
    .orderBy('m.cree_le', 'desc').limit(500).execute()
}

export async function suivreMiniAudit(trx: Transaction<DB>, id: string, statut: unknown): Promise<void> {
  try {
    await sql`select suivre_mini_audit(${id}::uuid, ${typeof statut === 'string' ? statut : ''})`.execute(trx)
  } catch (e) {
    if (codeErreur(e) === 'IF404') throw new ErreurMetier(404, 'Demande introuvable.')
    if (codeErreur(e) === 'IF409' || codeErreur(e) === 'IF403') throw new ErreurMetier(409, (e as Error).message)
    throw e
  }
}

export async function convertirMiniAudit(trx: Transaction<DB>, id: string): Promise<string> {
  try {
    return (await sql<{ id: string }>`select convertir_mini_audit(${id}::uuid) as id`.execute(trx)).rows[0]!.id
  } catch (e) {
    if (codeErreur(e) === 'IF404') throw new ErreurMetier(404, 'Demande introuvable.')
    if (codeErreur(e) === 'IF409' || codeErreur(e) === 'IF403') throw new ErreurMetier(409, (e as Error).message)
    // Messages métier de creer_prospect() (plafond, pays…) : affichables.
    if (e instanceof Error && /creer_prospect : /.test(e.message)) throw new ErreurMetier(409, e.message.replace(/^.*creer_prospect : /, ''))
    throw e
  }
}
