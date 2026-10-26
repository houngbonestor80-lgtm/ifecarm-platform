/** Classe de badge d'un score d'autodiagnostic (0-100) : repère visuel, indépendant des niveaux propres à chaque référentiel. */
export const classeScore = (s: number) => (s >= 80 ? 'badge--vert' : s >= 60 ? 'badge--bleu' : s >= 40 ? 'badge--orange' : 'badge--rouge')

/** Couleur (variable CSS) d'une barre de score. */
export const couleurBarre = (s: number) => (s >= 80 ? 'var(--brand-600)' : s >= 60 ? 'var(--qhse-blue)' : s >= 40 ? 'var(--qhse-orange)' : 'var(--qhse-red)')
