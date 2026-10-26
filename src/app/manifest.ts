import type { MetadataRoute } from 'next'

/** Plateforme installable (« Ajouter à l'écran d'accueil »). Lancement sur « / » : redirige selon la session et le rôle. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Plateforme QHSE — IFECARM GROUP',
    short_name: 'IFECARM QHSE',
    description: 'Inspections, registre de sécurité, formations et habilitations — IFECARM GROUP.',
    lang: 'fr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#11181c',
    theme_color: '#2d7a44',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
