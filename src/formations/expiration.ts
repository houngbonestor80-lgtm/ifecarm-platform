/**
 * expire_le d'une attestation : calculée UNE FOIS à l'émission depuis
 * formation.validite_mois, puis figée sur la ligne attestation — jamais
 * recalculée depuis la formation source ensuite (cf. contrainte du module :
 * "ne les relis jamais depuis salarie ou formation pour afficher ou
 * régénérer une attestation").
 */
export function calculerExpiration(emiseLe: Date, validiteMois: number | null): Date | null {
  if (validiteMois === null) return null
  const expiration = new Date(emiseLe)
  expiration.setMonth(expiration.getMonth() + validiteMois)
  return expiration
}
