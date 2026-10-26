import type { Client } from 'pg'
import { envoyerEmail, type Courriel } from './email'

/**
 * Envoi de la file d'e-mails (table notification, canal « email », statut « en_attente »), alimentée par les relances
 * (B3 : actions en retard, B4 : habilitations, B2 : recyclages). Exécuté par le script quotidien `npm run relances`
 * avec le rôle propriétaire (ifecarm_migrate) : la file couvre TOUTES les entreprises et ne doit jamais être lisible
 * par le code du site web (rôle ifecarm_app).
 *
 * Au moins une fois : une ligne est « réservée » (tentatives + 1, report de la prochaine tentative) avant l'envoi,
 * dans sa propre transaction, puis marquée « envoyee » ; un plantage entre les deux entraîne un nouvel essai, jamais
 * une perte. Échec : nouvel essai dans 30 min × n° de tentative, « echec » définitif à la 5e tentative.
 */

const MAX_TENTATIVES = 5
const LOT = 50

export interface BilanFile { envoyes: number, reportes: number, echecs: number }

/** `entrepriseId` : limite l'envoi à une entreprise (tests, reprise) ; sans lui, toute la file. */
export async function envoyerFileEmail(client: Client, envoyer: (c: Courriel) => Promise<void> = envoyerEmail, entrepriseId: string | null = null): Promise<BilanFile> {
  const bilan: BilanFile = { envoyes: 0, reportes: 0, echecs: 0 }
  for (;;) {
    const { rows } = await client.query<{ id: string, destinataire: string, sujet: string | null, corps: string, tentatives: number }>(
      `UPDATE notification SET tentatives = tentatives + 1, planifie_le = now() + interval '30 minutes' * (tentatives + 1)
       WHERE id IN (SELECT id FROM notification WHERE canal = 'email' AND statut = 'en_attente' AND planifie_le <= now() AND ($2::uuid IS NULL OR entreprise_id = $2)
                    ORDER BY planifie_le, cree_le LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, destinataire, sujet, corps, tentatives`, [LOT, entrepriseId])
    if (!rows.length) return bilan
    for (const n of rows) {
      try {
        await envoyer({ a: n.destinataire, sujet: n.sujet ?? 'Notification IFECARM GROUP', texte: n.corps })
        await client.query("UPDATE notification SET statut = 'envoye', envoye_le = now(), erreur = NULL WHERE id = $1", [n.id])
        bilan.envoyes++
      } catch (e) {
        const definitif = n.tentatives >= MAX_TENTATIVES
        // Le message d'erreur du SMTP ne contient jamais le corps du courriel ; on le tronque quand même.
        await client.query('UPDATE notification SET statut = $2, erreur = $3 WHERE id = $1', [n.id, definitif ? 'echec' : 'en_attente', String((e as Error).message ?? e).slice(0, 300)])
        if (definitif) bilan.echecs++
        else bilan.reportes++
      }
    }
    if (rows.length < LOT) return bilan
  }
}
