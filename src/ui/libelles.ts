/** Libellés et correspondances visuelles partagés par les écrans d'inspection. */

export const LIBELLE_STATUT_INSPECTION: Record<string, { texte: string, classe: string }> = {
  brouillon: { texte: 'Brouillon', classe: 'badge--neutre' },
  en_cours: { texte: 'En cours', classe: 'badge--bleu' },
  terminee: { texte: 'Clôturée', classe: 'badge--vert' },
  annulee: { texte: 'Annulée', classe: 'badge--neutre' },
}

export const LIBELLE_GRAVITE: Record<string, string> = {
  mineure: 'Mineure',
  majeure: 'Majeure',
  critique: 'Critique',
}

export const STATUTS_ACTION: { valeur: string, texte: string }[] = [
  { valeur: 'a_faire', texte: 'À faire' },
  { valeur: 'en_cours', texte: 'En cours' },
  { valeur: 'realisee', texte: 'Réalisée' },
  { valeur: 'verifiee', texte: 'Vérifiée (efficace)' },
  { valeur: 'abandonnee', texte: 'Abandonnée' },
]

export const LIBELLE_RESULTAT: Record<string, string> = {
  conforme: 'Conforme',
  non_conforme: 'Non conforme',
  non_applicable: 'Non applicable',
}

export const dateFr = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'

export const dateCourteFr = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'

// --- Formations (B2) ---------------------------------------------------------
export const LIBELLE_STATUT_SESSION: Record<string, { texte: string, classe: string }> = {
  planifiee: { texte: 'Planifiée', classe: 'badge--bleu' },
  confirmee: { texte: 'Confirmée', classe: 'badge--vert' },
  realisee: { texte: 'Réalisée', classe: 'badge--neutre' },
  annulee: { texte: 'Annulée', classe: 'badge--rouge' },
}

export const periode = (s: { date_debut: string, date_fin: string }) =>
  s.date_debut === s.date_fin ? dateCourteFr(s.date_debut) : `${dateCourteFr(s.date_debut)} → ${dateCourteFr(s.date_fin)}`

export const horaires = (s: { heure_debut: string | null, heure_fin: string | null, duree_heures: number | null }) =>
  [s.heure_debut ? `${s.heure_debut}${s.heure_fin ? `–${s.heure_fin}` : ''}` : null, s.duree_heures != null ? `${String(s.duree_heures).replace('.', ',')} h` : null].filter(Boolean).join(' · ')

// --- Registre de sécurité (B3) -------------------------------------------------
export const LIBELLE_TYPE_DECLARATION: Record<string, { texte: string, aide: string, classe: string }> = {
  accident_avec_arret: { texte: 'Accident avec arrêt', aide: 'Blessure avec arrêt de travail', classe: 'badge--rouge' },
  accident_sans_arret: { texte: 'Accident sans arrêt', aide: 'Blessure, soins, pas d’arrêt', classe: 'badge--orange' },
  presqu_accident: { texte: 'Presqu’accident', aide: 'Ça aurait pu mal tourner', classe: 'badge--orange' },
  situation_dangereuse: { texte: 'Situation dangereuse', aide: 'Un danger à corriger', classe: 'badge--bleu' },
  incident_materiel: { texte: 'Incident matériel', aide: 'Panne, casse, dégât', classe: 'badge--bleu' },
  incident_environnemental: { texte: 'Incident environnemental', aide: 'Fuite, rejet, pollution', classe: 'badge--vert' },
}

export const LIBELLE_STATUT_DECLARATION: Record<string, { texte: string, classe: string }> = {
  a_qualifier: { texte: 'À qualifier', classe: 'badge--orange' },
  en_analyse: { texte: 'En analyse', classe: 'badge--bleu' },
  en_action: { texte: 'Actions en cours', classe: 'badge--bleu' },
  cloturee: { texte: 'Clôturée', classe: 'badge--vert' },
  sans_suite: { texte: 'Sans suite', classe: 'badge--neutre' },
}

/** Hiérarchie des mesures de prévention : l'ordre d'affichage est un message en soi (0005). */
export const NATURES_ACTION_ORDONNEES: [string, string][] = [
  ['suppression', 'Supprimer le danger'],
  ['substitution', 'Remplacer par moins dangereux'],
  ['protection_collective', 'Protection collective'],
  ['protection_individuelle', 'Protection individuelle (EPI)'],
  ['organisation', 'Organisation du travail'],
  ['formation', 'Formation'],
  ['consigne', 'Consigne'],
]

export const LIBELLE_GRAVITE_NIVEAU = ['', 'Légère', 'Sérieuse', 'Grave', 'Très grave']
export const LIBELLE_FREQUENCE_NIVEAU = ['', 'Rare', 'Occasionnelle', 'Fréquente', 'Très fréquente']

/** Criticité = gravité × fréquence (1 à 16). */
export const classeCriticite = (c: number | null | undefined) =>
  c == null ? 'badge--neutre' : c >= 12 ? 'badge--rouge-plein' : c >= 8 ? 'badge--rouge' : c >= 4 ? 'badge--orange' : 'badge--vert'

export const dateHeureFr = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

// --- Habilitations (B4) --------------------------------------------------------
export const LIBELLE_DOMAINE_HABILITATION: Record<string, string> = {
  electrique: 'Électrique', conduite_levage: 'Conduite et levage', hauteur: 'Travail en hauteur',
  secourisme: 'Secourisme', incendie: 'Incendie', autre: 'Autre',
}

/** État d'un titre (calculé par la base : etat_habilitation). */
export const LIBELLE_ETAT_HABILITATION: Record<string, { texte: string, classe: string }> = {
  valide: { texte: 'Valide', classe: 'badge--vert' },
  a_renouveler: { texte: 'À renouveler', classe: 'badge--orange' },
  expiree: { texte: 'Expirée', classe: 'badge--rouge' },
  suspendue: { texte: 'Suspendue', classe: 'badge--bleu' },
  retiree: { texte: 'Retirée', classe: 'badge--neutre' },
  remplacee: { texte: 'Remplacée', classe: 'badge--neutre' },
}
