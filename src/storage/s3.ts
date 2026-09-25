import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Région non arbitrée (UE ou Afrique de l'Ouest) : jamais codée en dur,
 * uniquement via S3_REGION (revue de sécurité, note sur le stockage).
 * S3_ENDPOINT / S3_FORCE_PATH_STYLE ne sont renseignés qu'en local (MinIO) ;
 * absents en production, le client résout l'endpoint AWS standard depuis
 * S3_REGION seule.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} non définie (voir .env.example).`)
  return value
}

const client = new S3Client({
  region: requireEnv('S3_REGION'),
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  },
})

const bucket = () => requireEnv('S3_BUCKET')

/** Même durée que les liens de documents déjà en place sur le site vitrine IFECARM. */
const DUREE_URL_SECONDES = 600

/** Clé namespacée par entreprise — défense en profondeur, en plus du RLS sur la table `fichier`. */
export function construireCleStockage(entrepriseId: string, nomOriginal: string): string {
  const nomSanitise = nomOriginal.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 120)
  return `entreprise/${entrepriseId}/${randomUUID()}-${nomSanitise}`
}

/** Le client téléverse directement vers le stockage ; le serveur n'écrit que la ligne `fichier` (référence). */
export async function urlUploadPresignee(cleStockage: string, typeMime?: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: bucket(), Key: cleStockage, ContentType: typeMime })
  return getSignedUrl(client, command, { expiresIn: DUREE_URL_SECONDES })
}

export async function urlTelechargementPresignee(cleStockage: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket(), Key: cleStockage })
  return getSignedUrl(client, command, { expiresIn: DUREE_URL_SECONDES })
}

export async function supprimerFichier(cleStockage: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: cleStockage }))
}
