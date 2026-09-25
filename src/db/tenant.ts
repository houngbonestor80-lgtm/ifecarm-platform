import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import { appDb } from './client'
import type { DB } from './types.generated'

/**
 * Mécanisme central de cloisonnement (revue de sécurité, point 1) : ce
 * fichier expose les TROIS SEULES façons d'obtenir un handle de requête
 * dans toute l'application. `appDb` (client.ts) n'est importé nulle part
 * ailleurs. Chaque fonction ouvre une transaction Postgres — obligatoire,
 * car `set_config(..., true)` (SET LOCAL) n'a d'effet que pour la
 * transaction courante, sur LA MÊME connexion physique — et positionne les
 * variables de session que lisent les politiques RLS (migrations/0001).
 */

/**
 * Aucune variable de session positionnée : réservé aux 3 tables sans RLS
 * (session, password_reset_token, tentative_connexion — cf. migrations/
 * 0002_session_auth.sql), pour la phase de connexion, avant qu'un
 * utilisateur ou une entreprise ne soit identifié. Sur une table protégée
 * par RLS, ce wrapper ne peut jamais renvoyer de ligne (comparaison à NULL
 * toujours fausse) : un mauvais usage échoue silencieusement en "aucun
 * résultat", jamais en fuite de données d'un autre tenant.
 */
export async function withoutTenant<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return appDb.transaction().execute(callback)
}

export interface TenantContext {
  entrepriseId: string
  utilisateurId: string
}

/** Contexte normal : toutes les requêtes métier au sein d'une entreprise cliente. */
export async function withTenant<T>(
  { entrepriseId, utilisateurId }: TenantContext,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return appDb.transaction().execute(async (trx) => {
    await sql`select set_config('app.entreprise_id', ${entrepriseId}, true)`.execute(trx)
    await sql`select set_config('app.utilisateur_id', ${utilisateurId}, true)`.execute(trx)
    return callback(trx)
  })
}

/**
 * Contexte "authentifié, entreprise pas encore choisie" : juste après la
 * connexion (mot de passe + 2FA validés), pour résoudre les entreprises
 * accessibles via role_utilisateur et acces_consultant avant que
 * l'utilisateur (ou le consultant) n'en sélectionne une. app.entreprise_id
 * n'est PAS positionné ici : c'est précisément pour ça que les politiques
 * RLS de role_utilisateur/acces_consultant ont une clause "soi-même".
 */
export async function withAuthenticatedUser<T>(
  utilisateurId: string,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return appDb.transaction().execute(async (trx) => {
    await sql`select set_config('app.utilisateur_id', ${utilisateurId}, true)`.execute(trx)
    return callback(trx)
  })
}

/**
 * Liste FERMÉE des opérations admin_plateforme, codée en dur (exigence
 * explicite de la revue) : jamais construite dynamiquement à partir d'une
 * chaîne fournie par l'appelant.
 */
export type PlatformAdminOp =
  | 'creer_entreprise'
  | 'modifier_entreprise'
  | 'activer_module'
  | 'desactiver_module'
  | 'accorder_acces_consultant'
  | 'revoquer_acces_consultant'
  | 'lister_entreprises'
  | 'consulter_journal_audit_global'
  | 'gerer_catalogue_formation'

const PLATFORM_ADMIN_OPS = new Set<PlatformAdminOp>([
  'creer_entreprise',
  'modifier_entreprise',
  'activer_module',
  'desactiver_module',
  'accorder_acces_consultant',
  'revoquer_acces_consultant',
  'lister_entreprises',
  'consulter_journal_audit_global',
  'gerer_catalogue_formation',
])

export interface PlatformAdminParams {
  utilisateurId: string
  operation: PlatformAdminOp
  details?: Record<string, unknown>
  adresseIp?: string
}

/**
 * Accès transverse pour admin_plateforme. Le rôle est REVÉRIFIÉ ici, sous
 * app.utilisateur_id seul (pas encore platform_admin) — jamais supposé déjà
 * vérifié par l'appelant, même si les couches au-dessus (routes API) font
 * aussi leur propre contrôle en amont : une primitive aussi privilégiée ne
 * doit dépendre que d'elle-même pour sa garantie de sécurité.
 *
 * L'opération est journalisée AVANT tout effet de bord : si l'écriture dans
 * journal_audit échoue, la transaction entière est annulée (ROLLBACK) et
 * l'opération n'a pas eu lieu.
 */
export async function withPlatformAdmin<T>(
  params: PlatformAdminParams,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!PLATFORM_ADMIN_OPS.has(params.operation)) {
    // Le type le garantit déjà à la compilation ; filet de sécurité runtime
    // au cas où l'appelant contourne TypeScript (JS pur, valeur désérialisée).
    throw new Error(`Opération admin_plateforme non autorisée : ${params.operation as string}`)
  }

  return appDb.transaction().execute(async (trx) => {
    await sql`select set_config('app.utilisateur_id', ${params.utilisateurId}, true)`.execute(trx)

    const detientLeRole = await trx
      .selectFrom('role_utilisateur')
      .select('id')
      .where('utilisateur_id', '=', params.utilisateurId)
      .where('role', '=', 'admin_plateforme')
      .executeTakeFirst()

    if (!detientLeRole) {
      throw new Error('Accès admin_plateforme refusé : rôle absent pour cet utilisateur.')
    }

    await sql`select set_config('app.platform_admin', 'true', true)`.execute(trx)

    await trx
      .insertInto('journal_audit')
      .values({
        utilisateur_id: params.utilisateurId,
        entreprise_id: null,
        action: params.operation,
        objet_type: 'platform_admin',
        objet_id: null,
        details: params.details ? JSON.stringify(params.details) : null,
        adresse_ip: params.adresseIp ?? null,
      })
      .execute()

    return callback(trx)
  })
}
