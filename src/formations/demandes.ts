import { ficheDe } from './catalogue'

export const SERVICES = ['inspection', 'formation', 'audit', 'conseil']

export interface DemandeFormation { slug: string, intitule: string | null, nb_participants: number | null, date_souhaitee: string | null, note: string | null }

/** Identifiant d'une formation écrite à la main (hors catalogue du site) : « libre- » + l'intitulé simplifié. */
export const slugLibre = (intitule: string) =>
  `libre-${intitule.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'formation'}`

/** Service souhaité écrit à la main, en plus des quatre cases (facultatif, 300 caractères au plus). */
export function lireServiceAutre(brut: unknown): string | null | { erreur: string } {
  if (brut == null || brut === '') return null
  if (typeof brut !== 'string') return { erreur: 'Service souhaité invalide.' }
  const t = brut.trim()
  return t.length > 300 ? { erreur: 'Service souhaité : 300 caractères au maximum.' } : t || null
}

/** Services cochés : dédoublonnés, valeurs connues seulement. */
export function lireServices(brut: unknown): string[] | { erreur: string } {
  const services = Array.isArray(brut) ? [...new Set(brut.filter((x): x is string => typeof x === 'string'))] : []
  return services.some((x) => !SERVICES.includes(x)) ? { erreur: 'Service inconnu.' } : services
}

/**
 * Demandes de formation saisies par le consultant (migration 0028) : chaque
 * entrée est un slug du catalogue, ou un objet {slug, nb_participants?,
 * date_souhaitee?, note?}. Les doublons de slug sont fusionnés (le dernier gagne).
 */
export function lireDemandes(brutes: unknown): DemandeFormation[] | { erreur: string } {
  const liste = Array.isArray(brutes) ? brutes : []
  const demandes = new Map<string, DemandeFormation>()
  for (const b of liste) {
    const o: Record<string, unknown> = typeof b === 'string' ? { slug: b } : b && typeof b === 'object' ? b as Record<string, unknown> : {}
    // Formation du catalogue (par son identifiant) OU écrite à la main (intitulé) : dans ce cas l'identifiant est recalculé ici.
    const intituleBrut = typeof o.intitule === 'string' ? o.intitule.trim() : ''
    const libre = typeof o.slug === 'string' && o.slug.startsWith('libre-')
    if (libre && !intituleBrut) return { erreur: 'Une formation hors catalogue a besoin d’un intitulé.' }
    if (libre && intituleBrut.length > 200) return { erreur: 'Intitulé de formation : 200 caractères au maximum.' }
    if (!libre && (typeof o.slug !== 'string' || !ficheDe(o.slug))) return { erreur: 'Formation inconnue (30 au maximum).' }
    const slug = libre ? slugLibre(intituleBrut) : (o.slug as string)
    const nb = o.nb_participants == null || o.nb_participants === '' ? null : Number(o.nb_participants)
    if (nb !== null && (!Number.isInteger(nb) || nb < 1 || nb > 10000)) return { erreur: 'Nombre de participants invalide (1 à 10 000).' }
    const date = o.date_souhaitee == null || o.date_souhaitee === '' ? null : o.date_souhaitee
    if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) return { erreur: 'Date souhaitée invalide.' }
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim() : null
    if (note && note.length > 1000) return { erreur: 'Note trop longue (1 000 caractères au maximum).' }
    demandes.set(slug, { slug, intitule: libre ? intituleBrut : null, nb_participants: nb, date_souhaitee: date, note })
  }
  return demandes.size > 30 ? { erreur: 'Formation inconnue (30 au maximum).' } : [...demandes.values()]
}
