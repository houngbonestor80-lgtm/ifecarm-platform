import argon2 from 'argon2'

/**
 * Paramètres argon2id explicites (revue de sécurité, point 3), alignés sur
 * l'OWASP Password Storage Cheat Sheet (argon2id, m=19 MiB, t=2, p=1) :
 * mémoire élevée pour freiner les attaques GPU/ASIC, temps de calcul faible
 * pour garder une latence de connexion acceptable.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const

export async function hacherMotDePasse(motDePasse: string): Promise<string> {
  return argon2.hash(motDePasse, ARGON2_OPTIONS)
}

export async function verifierMotDePasse(hash: string, motDePasse: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, motDePasse)
  } catch {
    // Hash corrompu ou format inattendu : traité comme un échec, jamais une exception qui fuite.
    return false
  }
}
