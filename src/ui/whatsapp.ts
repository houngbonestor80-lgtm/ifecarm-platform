/**
 * Lien « WhatsApp » avec message prérédigé (wa.me) : ouvre WhatsApp sur le téléphone ou WhatsApp Web, le consultant
 * relit et envoie lui-même. Aucune API ni compte WhatsApp Business : rien ne part sans lui.
 */

/** Indicatif des pays d'intervention ; seul le numéro français perd son 0 initial (Bénin : +229 01…, Côte d'Ivoire : +225 07…). */
const INDICATIFS: Record<string, { indicatif: string, sansZero?: boolean }> = {
  BJ: { indicatif: '229' }, CI: { indicatif: '225' }, TG: { indicatif: '228' }, SN: { indicatif: '221' }, FR: { indicatif: '33', sansZero: true },
}

/** Numéro au format international sans « + » ni espace, ou null s'il est inexploitable. */
export function numeroWhatsApp(telephone: string | null | undefined, pays: string | null | undefined): string | null {
  if (!telephone) return null
  const brut = telephone.trim()
  let chiffres = brut.replace(/\D/g, '')
  if (brut.startsWith('+')) return chiffres.length >= 8 ? chiffres : null
  if (chiffres.startsWith('00')) return chiffres.length >= 10 ? chiffres.slice(2) : null
  const p = INDICATIFS[pays ?? '']
  if (!p) return null
  if (chiffres.startsWith(p.indicatif) && chiffres.length > p.indicatif.length + 7) return chiffres
  if (p.sansZero) chiffres = chiffres.replace(/^0/, '')
  return chiffres.length >= 7 ? p.indicatif + chiffres : null
}

export function lienWhatsApp(telephone: string | null | undefined, pays: string | null | undefined, message: string): string | null {
  const numero = numeroWhatsApp(telephone, pays)
  return numero ? `https://wa.me/${numero}?text=${encodeURIComponent(message)}` : null
}
