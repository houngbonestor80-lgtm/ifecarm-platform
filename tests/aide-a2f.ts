import { createHash } from 'node:crypto'
import { Client } from 'pg'

/**
 * Aide de test : les comptes de l'équipe IFECARM, l'admin d'entreprise et le responsable QHSE doivent valider la 2FA à
 * la connexion (0045) ; leur session naît « partielle ». Les tests qui ne portent pas sur la 2FA « libèrent » la session
 * comme le ferait la saisie du code, directement en base (jamais par une option de contournement dans le code du site).
 */
export async function libererA2f(jeton: string): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await c.connect()
  try {
    await c.query('UPDATE session SET a2f_validee_le = now(), a2f_etape = NULL WHERE jeton_hash = $1 AND a2f_requise', [createHash('sha256').update(jeton).digest('hex')])
  } finally {
    await c.end()
  }
}
