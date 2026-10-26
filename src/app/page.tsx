import { redirect } from 'next/navigation'

/**
 * Accueil : le module actif est celui des inspections. La page d'inspections
 * redirige elle-même vers la connexion (pas de session) ou vers le choix
 * d'entreprise (consultant sans entreprise active).
 */
export default function Accueil() {
  redirect('/inspections')
}
