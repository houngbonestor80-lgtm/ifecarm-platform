import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // En développement, Next bloque ses ressources (/_next/*) pour tout hôte
  // autre que localhost : sans cette ligne, une ouverture via 127.0.0.1
  // affiche les pages sans JavaScript (formulaires inertes).
  allowedDevOrigins: ['127.0.0.1'],
  // Rapport PDF d'inspection : polices (OFL) et logo du papier à en-tête, lus
  // sur disque par src/inspections/rapport.ts — à embarquer avec la route.
  outputFileTracingIncludes: {
    '/api/inspections/**': ['./assets/pdf/**/*'],
    '/api/equipements/**': ['./assets/pdf/**/*'],
    '/api/autodiagnostic/**': ['./assets/pdf/**/*'],
  },
  async headers() {
    return [
      // Le service worker doit toujours être revalidé : une copie périmée retarderait chaque mise à jour.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ]
  },
}

export default nextConfig
