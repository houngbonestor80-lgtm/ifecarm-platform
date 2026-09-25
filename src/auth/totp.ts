import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import * as OTPAuth from 'otpauth'

/**
 * Secret TOTP chiffré au repos (AES-256-GCM), jamais stocké en clair (revue
 * de sécurité, point 3). Valeur stockée : "iv:tag:ciphertext", chaque partie
 * en base64. Clé distincte de SESSION_COOKIE_SECRET — une rotation de l'une
 * ne doit jamais invalider l'autre.
 */
function cle(): Buffer {
  const b64 = process.env.TOTP_ENCRYPTION_KEY
  if (!b64) throw new Error('TOTP_ENCRYPTION_KEY non définie.')
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY doit faire 32 octets une fois décodée (AES-256).')
  return key
}

export function chiffrerSecretTotp(secretBase32: string): string {
  const iv = randomBytes(12) // taille recommandée pour AES-GCM
  const cipher = createCipheriv('aes-256-gcm', cle(), iv)
  const ciphertext = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function dechiffrerSecretTotp(valeurStockee: string): string {
  const [ivB64, tagB64, ciphertextB64] = valeurStockee.split(':')
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Format de secret TOTP chiffré invalide.')
  }
  const decipher = createDecipheriv('aes-256-gcm', cle(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

export interface EnrolementTotp {
  secretBase32: string
  uriEnrolement: string
}

/** Génère un nouveau secret TOTP + l'URI à encoder en QR pour l'enrôlement. */
export function genererSecretTotp(email: string): EnrolementTotp {
  const totp = new OTPAuth.TOTP({
    issuer: 'IFECARM GROUP',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  })
  return { secretBase32: totp.secret.base32, uriEnrolement: totp.toString() }
}

export function verifierCodeTotp(secretBase32: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: 'IFECARM GROUP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  })
  // window: 1 -> tolère un décalage d'horloge de +/- 30s, usage standard TOTP.
  return totp.validate({ token: code, window: 1 }) !== null
}
