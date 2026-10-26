import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { ecrireJournal } from '@/db/journal'
import { withAuthenticatedUser, withPlatformAdmin, withTenant, withoutTenant } from '@/db/tenant'
import type { PlatformAdminOp } from '@/db/tenant'
import type { DB } from '@/db/types.generated'
import { exigerAccesConsultant } from './acces'
import { exigerModuleActif, type Module } from './modules'
import type { Role } from './permissions'
import { definirEntrepriseSession, revoquerSession, validerSession } from './session'
import { ErreurMetier } from '@/inspections/service'
import { hacherMotDePasse, verifierMotDePasse } from './password'
import { supprimerFichier } from '@/storage/s3'

/**
 * Contexte de requête : qui appelle, et dans quel tenant il a le droit d'agir.
 * C'est LA porte d'entrée des routes : elles reçoivent le jeton de session
 * (cookie httpOnly) et jamais un entreprise_id ou un utilisateur_id venu du
 * navigateur.
 *
 * Règle non négociable (cf. src/app/api/inspections/LISEZ-MOI.md) : pour un
 * consultant IFECARM ou un admin_plateforme, l'accès à l'entreprise active est
 * REVÉRIFIÉ À CHAQUE REQUÊTE par exigerAccesConsultant — un mandat expiré ou
 * une entreprise désactivée en cours de session coupe l'accès immédiatement,
 * sans attendre la fin de la session.
 */

export class ErreurAcces extends Error {
  constructor(public readonly statut: 401 | 403 | 409, message: string) {
    super(message)
  }
}

export interface ContexteSession {
  sessionId: string
  utilisateurId: string
  /** Entreprise active de la session (null tant qu'un consultant n'en a pas choisi). */
  entrepriseId: string | null
  roles: Role[]
  estConsultant: boolean
  estAdminPlateforme: boolean
}

export async function lireContexte(jeton: string | null): Promise<ContexteSession | null> {
  if (!jeton) return null
  const session = await withoutTenant((trx) => validerSession(trx, jeton))
  if (!session) return null

  const roles = await withAuthenticatedUser(session.utilisateurId, async (trx) =>
    (await trx.selectFrom('role_utilisateur').select('role').where('utilisateur_id', '=', session.utilisateurId).execute())
      .map((r) => r.role as Role),
  )
  return {
    sessionId: session.sessionId,
    utilisateurId: session.utilisateurId,
    entrepriseId: session.entrepriseId,
    roles,
    estConsultant: roles.includes('consultant_ifecarm'),
    estAdminPlateforme: roles.includes('admin_plateforme'),
  }
}

async function exigerContexte(jeton: string | null): Promise<ContexteSession> {
  const ctx = await lireContexte(jeton)
  if (!ctx) throw new ErreurAcces(401, 'Session absente, expirée ou révoquée.')
  return ctx
}

/**
 * Exécute `cb` dans le tenant de la session, après TOUS les contrôles d'accès.
 * Utilisateur d'une entreprise cliente : son entreprise (posée à la connexion).
 * Consultant / admin_plateforme : l'entreprise choisie, avec accès consultant
 * valide et, si `ecriture`, en écriture.
 */
export async function avecTenant<T>(
  jeton: string | null,
  options: { ecriture?: boolean, module?: Module },
  cb: (trx: Transaction<DB>, ctx: ContexteSession & { entrepriseId: string }) => Promise<T>,
): Promise<T> {
  const ctx = await exigerContexte(jeton)
  const entrepriseId = ctx.entrepriseId
  if (!entrepriseId) throw new ErreurAcces(409, "Aucune entreprise sélectionnée pour cette session.")

  if (ctx.estConsultant || ctx.estAdminPlateforme) {
    try {
      await withAuthenticatedUser(ctx.utilisateurId, (trx) =>
        exigerAccesConsultant(trx, { utilisateurId: ctx.utilisateurId, entrepriseId, ecriture: options.ecriture }),
      )
    } catch (e) {
      throw new ErreurAcces(403, e instanceof Error ? e.message : 'Accès refusé.')
    }
  }

  // Valable pour tous : entreprise désactivée = plus d'accès (cf. migration 0010).
  const active = await withAuthenticatedUser(ctx.utilisateurId, async (trx) => {
    const { rows } = await sql<{ ok: boolean }>`select entreprise_est_active(${entrepriseId}) as ok`.execute(trx)
    return rows[0]?.ok === true
  })
  if (!active) throw new ErreurAcces(403, 'Entreprise désactivée.')

  return withTenant({ entrepriseId, utilisateurId: ctx.utilisateurId }, async (trx) => {
    // Utilisateur d'une entreprise cliente : il doit réellement appartenir au
    // tenant de sa session (la RLS ne lui montre sa ligne que s'il y est).
    if (!ctx.estConsultant && !ctx.estAdminPlateforme) {
      const moi = await trx.selectFrom('utilisateur').select('id').where('id', '=', ctx.utilisateurId).executeTakeFirst()
      if (!moi) throw new ErreurAcces(403, "Cet utilisateur n'appartient pas à l'entreprise de la session.")
    }
    if (options.module) {
      try {
        await exigerModuleActif(trx, { entrepriseId, module: options.module })
      } catch (e) {
        throw new ErreurAcces(403, e instanceof Error ? e.message : 'Module non actif.')
      }
    }
    return cb(trx, { ...ctx, entrepriseId })
  })
}

/** Accès aux opérations admin_plateforme : rôle vérifié ici ET revérifié dans withPlatformAdmin. */
export async function avecPlateformeAdmin<T>(
  jeton: string | null,
  operation: PlatformAdminOp,
  cb: (trx: Transaction<DB>, ctx: ContexteSession) => Promise<T>,
  details?: Record<string, unknown>,
): Promise<T> {
  const ctx = await exigerContexte(jeton)
  if (!ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à admin_plateforme.')
  return withPlatformAdmin({ utilisateurId: ctx.utilisateurId, operation, details }, (trx) => cb(trx, ctx))
}

export interface EntrepriseAccessible {
  entreprise_id: string
  nom: string
  statut_relation: string
  ecriture: boolean
  fin_le: Date | null
}

/** Sélecteur de tenant : les entreprises où le consultant a un accès valide (avec leur nom). */
export async function listerEntreprisesAccessibles(jeton: string | null): Promise<(EntrepriseAccessible & { supprimable: boolean })[]> {
  const ctx = await exigerContexte(jeton)
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants.')
  return withAuthenticatedUser(ctx.utilisateurId, async (trx) => {
    const { rows } = await sql<EntrepriseAccessible>`select * from lister_entreprises_consultant()`.execute(trx)
    // Indicatif pour l'affichage : la règle fait foi en base (supprimer_entreprise).
    return rows.map((e) => ({ ...e, supprimable: ctx.estAdminPlateforme || (e.statut_relation === 'prospect' && e.ecriture) }))
  })
}

/** Choix du tenant par un consultant : c'est CE moment qui appelle exigerAccesConsultant. */
export async function choisirEntreprise(jeton: string | null, entrepriseId: string): Promise<void> {
  const ctx = await exigerContexte(jeton)
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants.')
  try {
    await withAuthenticatedUser(ctx.utilisateurId, (trx) =>
      exigerAccesConsultant(trx, { utilisateurId: ctx.utilisateurId, entrepriseId }),
    )
  } catch (e) {
    throw new ErreurAcces(403, e instanceof Error ? e.message : 'Accès refusé.')
  }
  await withoutTenant((trx) => definirEntrepriseSession(trx, { sessionId: ctx.sessionId, entrepriseId }))
  await withTenant({ entrepriseId, utilisateurId: ctx.utilisateurId }, (trx) =>
    ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId, action: 'selection_entreprise', objetType: 'session', objetId: ctx.sessionId }),
  )
}

/** Prospect → client (migration 0023) : administrateur seulement, contrôlé en base ; l'historique est conservé. */
export async function convertirEnClient(jeton: string | null, entrepriseId: string): Promise<void> {
  const ctx = await exigerContexte(jeton)
  if (!ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé à l’administrateur IFECARM GROUP.')
  if (!/^[0-9a-f-]{36}$/i.test(entrepriseId)) throw new ErreurMetier(404, 'Entreprise introuvable.')
  await withAuthenticatedUser(ctx.utilisateurId, async (trx) => {
    try {
      await sql`select convertir_prospect_en_client(${entrepriseId})`.execute(trx)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'IF403') throw new ErreurAcces(403, (e as Error).message)
      if (code === 'IF404') throw new ErreurMetier(404, (e as Error).message)
      if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
      throw e
    }
  })
}

/**
 * Suppression définitive d'un prospect ou d'un client (migration 0015) :
 * droits, confirmation par le nom et journalisation sont contrôlés EN BASE
 * par supprimer_entreprise(). Ici : traduction des erreurs et nettoyage S3.
 */
export async function supprimerEntreprise(jeton: string | null, entrepriseId: string, confirmation: string): Promise<void> {
  const ctx = await exigerContexte(jeton)
  if (!ctx.estConsultant && !ctx.estAdminPlateforme) throw new ErreurAcces(403, 'Réservé aux consultants.')
  if (!/^[0-9a-f-]{36}$/i.test(entrepriseId)) throw new ErreurMetier(404, 'Entreprise introuvable.')
  const cles = await withAuthenticatedUser(ctx.utilisateurId, async (trx) => {
    try {
      const { rows } = await sql<{ cles: string[] }>`select supprimer_entreprise(${entrepriseId}, ${confirmation}) as cles`.execute(trx)
      return rows[0]?.cles ?? []
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'IF403') throw new ErreurAcces(403, (e as Error).message)
      if (code === 'IF404') throw new ErreurMetier(404, (e as Error).message)
      if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
      throw e
    }
  })
  // ponytail: effacement du stockage au mieux, après validation ; un objet orphelin ne coûte que de la place.
  await Promise.allSettled(cles.map((cle) => supprimerFichier(cle)))
}

/**
 * Changement de son propre mot de passe : l'actuel est exigé (session volée ≠
 * compte volé). Les AUTRES sessions de la personne sont fermées ; celle en
 * cours reste ouverte. Journalisé en base par definir_mot_de_passe_courant().
 */
export async function changerMotDePasse(jeton: string | null, actuel: unknown, nouveau: unknown): Promise<void> {
  const ctx = await exigerContexte(jeton)
  if (typeof actuel !== 'string' || typeof nouveau !== 'string') throw new ErreurMetier(400, 'Mots de passe requis.')
  if (nouveau.length < 10) throw new ErreurMetier(400, 'Le nouveau mot de passe doit contenir au moins 10 caractères.')
  if (nouveau.length > 200) throw new ErreurMetier(400, 'Nouveau mot de passe trop long (200 caractères maximum).')
  if (nouveau === actuel) throw new ErreurMetier(400, 'Le nouveau mot de passe doit être différent de l’actuel.')

  const hash = await withAuthenticatedUser(ctx.utilisateurId, async (trx) =>
    (await sql<{ h: string | null }>`select hash_mot_de_passe_courant() as h`.execute(trx)).rows[0]?.h ?? null)
  if (!hash || !(await verifierMotDePasse(hash, actuel))) throw new ErreurMetier(400, 'Mot de passe actuel incorrect.')

  const nouveauHash = await hacherMotDePasse(nouveau)
  await withAuthenticatedUser(ctx.utilisateurId, (trx) => sql`select definir_mot_de_passe_courant(${nouveauHash})`.execute(trx))
  await withoutTenant((trx) => trx.updateTable('session').set({ revoque_le: new Date() })
    .where('utilisateur_id', '=', ctx.utilisateurId).where('id', '!=', ctx.sessionId).where('revoque_le', 'is', null).execute())
  // Un nouveau mot de passe invalide aussi les « appareils de confiance » (2FA) : le code est redemandé partout.
  await withoutTenant((trx) => trx.updateTable('appareil_confiance').set({ revoque_le: new Date() }).where('utilisateur_id', '=', ctx.utilisateurId).where('revoque_le', 'is', null).execute())
}

export async function deconnecter(jeton: string | null): Promise<void> {
  const ctx = await lireContexte(jeton)
  if (ctx) await withoutTenant((trx) => revoquerSession(trx, ctx.sessionId))
}
