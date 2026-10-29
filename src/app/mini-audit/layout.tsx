// Page publique (vitrine du mini-audit) : indexable, contrairement au reste de la plateforme. Le résultat ([code]) reste non indexé.
export const metadata = {
  title: 'Mini-audit QHSE gratuit — IFECARM GROUP',
  description: 'Évaluez en 5 minutes la santé, la sécurité et l’environnement de votre entreprise : score immédiat et priorités d’action.',
  robots: { index: true, follow: true },
}

export default function LayoutMiniAudit({ children }: { children: React.ReactNode }) {
  return children
}
