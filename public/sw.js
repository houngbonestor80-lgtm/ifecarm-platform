/* Service worker IFECARM — plateforme installable (PWA) et hors ligne du registre de sécurité (B3).
 * Rôle : garder la page de saisie et ses ressources statiques utilisables sans réseau.
 *  - Autres pages sans réseau : page statique /hors-ligne.html (aucune donnée, jamais de copie de ces pages).
 *  - Mise à jour : la nouvelle version attend (pas de skipWaiting automatique, une saisie en cours ne doit pas être
 *    rechargée) ; le bandeau « Actualiser » (src/ui/ServiceWorker.tsx) lui envoie SKIP_WAITING.
 *  - Pages (navigations) : réseau d'abord, copie en cache en secours (aucune page périmée tant que le
 *    réseau répond ; sur connexion très lente, la copie prend le relais après quelques secondes).
 *  - Fichiers statiques versionnés (/_next/static, polices, logos) : cache d'abord. Leur nom change quand
 *    leur contenu change, donc une copie n'est jamais périmée ; c'est aussi ce qui rend le chargement
 *    immédiat sans réseau (pas d'attente de délai ressource par ressource).
 *  - JAMAIS d'/api/* en cache : les données d'une entreprise ne doivent pas rester lisibles pour le
 *    prochain utilisateur de l'appareil. Les envois hors ligne passent par IndexedDB (src/registre/hors-ligne.ts).
 */
const VERSION = 'ifecarm-v3'
const PAGE_HORS_LIGNE = '/hors-ligne.html'
const DELAI_PAGE_MS = 3000

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.add(PAGE_HORS_LIGNE)).catch(() => undefined))
})
self.addEventListener('message', (event) => { if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting() })
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const nom of await caches.keys()) if (nom !== VERSION) await caches.delete(nom)
    await self.clients.claim()
  })())
})

const statique = (url) => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/')
const page = (url) => url.pathname === '/registre' || url.pathname.startsWith('/registre/')

const memoriser = async (request, reponse) => {
  // Une redirection (vers /connexion) ou une erreur ne remplace jamais la bonne copie.
  if (reponse.ok && reponse.type === 'basic' && !reponse.redirected) (await caches.open(VERSION)).put(request, reponse.clone())
  return reponse
}

async function cacheDabord(request) {
  const cache = await caches.open(VERSION)
  const copie = await cache.match(request)
  if (copie) return copie
  return memoriser(request, await fetch(request))
}

async function reseauPuisCache(request) {
  const cache = await caches.open(VERSION)
  const copie = await cache.match(request)
  try {
    const reponse = await Promise.race([
      fetch(request),
      new Promise((_, rejeter) => setTimeout(() => rejeter(new Error('lent')), copie ? DELAI_PAGE_MS : 60000)),
    ])
    return await memoriser(request, reponse)
  } catch (e) {
    if (copie) return copie
    throw e
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (statique(url)) event.respondWith(cacheDabord(request))
  else if (page(url) && (request.mode === 'navigate' || request.destination === 'document' || request.destination === 'iframe')) event.respondWith(reseauPuisCache(request))
  else if (request.mode === 'navigate') {
    // Toute autre page : le réseau, sinon la page « hors ligne » (qui ne contient aucune donnée).
    event.respondWith(fetch(request).catch(async () => (await caches.match(PAGE_HORS_LIGNE)) ?? Response.error()))
  }
})
