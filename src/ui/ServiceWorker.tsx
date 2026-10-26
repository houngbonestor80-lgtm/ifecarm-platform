'use client'

import { useEffect, useState } from 'react'

/**
 * Enregistre le service worker (public/sw.js) pour que la plateforme soit installable et que la saisie du registre
 * fonctionne hors ligne. Production seulement : en développement, les fichiers gardent leur nom et une copie en cache
 * masquerait les modifications. Une nouvelle version n'est jamais appliquée d'office : un bandeau propose d'actualiser.
 */
export default function ServiceWorker() {
  const [attente, setAttente] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    let recharge = false
    const surControleur = () => { if (recharge) window.location.reload() }
    navigator.serviceWorker.addEventListener('controllerchange', surControleur)

    let enregistrement: ServiceWorkerRegistration | undefined
    const verifier = () => { void enregistrement?.update().catch(() => undefined) }
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      enregistrement = reg
      const surveiller = (w: ServiceWorker) => w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) setAttente(w)
      })
      if (reg.waiting && navigator.serviceWorker.controller) setAttente(reg.waiting)
      reg.addEventListener('updatefound', () => { if (reg.installing) surveiller(reg.installing) })
    }).catch(() => undefined)
    // Au retour dans l'application (téléphone sorti de veille, onglet repris) : y a-t-il une nouvelle version ?
    const auRetour = () => { if (document.visibilityState === 'visible') verifier() }
    document.addEventListener('visibilitychange', auRetour)

    ;(window as unknown as { __actualiserSw?: () => void }).__actualiserSw = () => { recharge = true }
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', surControleur)
      document.removeEventListener('visibilitychange', auRetour)
    }
  }, [])

  if (!attente) return null
  return (
    <div role="status" style={{ position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 1000, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '12px 16px', borderRadius: 12, background: '#182026', border: '1px solid #2d7a44', color: '#fff', boxShadow: '0 6px 24px rgba(0,0,0,0.4)' }}>
      <span>Une nouvelle version de la plateforme est disponible.</span>
      <button type="button" className="bouton bouton--petit"
        onClick={() => { (window as unknown as { __actualiserSw?: () => void }).__actualiserSw?.(); attente.postMessage({ type: 'SKIP_WAITING' }) }}>
        Actualiser
      </button>
    </div>
  )
}
