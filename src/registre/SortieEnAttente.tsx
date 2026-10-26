'use client'

import { useCallback, useEffect, useState } from 'react'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeAlerte, IconeCoche } from '@/ui/icones'
import { dateHeureFr } from '@/ui/libelles'
import { listerSortie, supprimerDeSortie, synchroniser, type BilanEnvoi, type EntreeSortie } from './hors-ligne'

/**
 * Boîte d'envoi des déclarations saisies sur cet appareil : celles qui attendent le réseau, et celles que le
 * serveur a refusées (avec le motif). Envoi automatique au retour du réseau, au chargement et toutes les
 * minutes ; `onEnvoyees` laisse l'écran recharger sa liste.
 */
export function SortieEnAttente({ onEnvoyees }: { onEnvoyees?: (references: string[]) => void }) {
  const { moi } = useContexteApp()
  const [entrees, setEntrees] = useState<EntreeSortie[]>([])
  const [bilan, setBilan] = useState<BilanEnvoi | null>(null)
  const [envoi, setEnvoi] = useState(false)

  const charger = useCallback(async () => {
    setEntrees((await listerSortie().catch(() => [])).filter((e) => e.utilisateurId === moi))
  }, [moi])

  const envoyer = useCallback(async () => {
    if (!navigator.onLine) { await charger(); return }
    setEnvoi(true)
    try {
      const b = await synchroniser(moi)
      setBilan(b)
      if (b.envoyees.length) onEnvoyees?.(b.envoyees.map((x) => x.reference))
    } finally {
      setEnvoi(false)
      await charger()
    }
  }, [moi, charger, onEnvoyees])

  useEffect(() => {
    void envoyer()
    const retour = () => void envoyer()
    window.addEventListener('online', retour)
    const minuteur = window.setInterval(() => void envoyer(), 60_000)
    return () => { window.removeEventListener('online', retour); window.clearInterval(minuteur) }
  }, [envoyer])

  const enAttente = entrees.filter((e) => !e.refus)
  const refusees = entrees.filter((e) => e.refus)
  if (!enAttente.length && !refusees.length) return null

  return (
    <div style={{ marginBottom: 16, display: 'grid', gap: 10 }}>
      {enAttente.length > 0 && (
        <div className="alerte alerte--attention" role="status">
          <IconeAlerte />
          <div style={{ flex: 1 }}>
            <strong>{enAttente.length} déclaration{enAttente.length > 1 ? 's' : ''} en attente d’envoi</strong>
            <div className="texte-discret">
              Enregistrée{enAttente.length > 1 ? 's' : ''} sur cet appareil{enAttente.length > 1 ? '' : ''}
              {bilan?.suspendu === 'session' ? ' — session expirée : reconnectez-vous pour envoyer.' : navigator.onLine ? '' : ' — hors ligne : envoi automatique au retour du réseau.'}
            </div>
          </div>
          <button type="button" className="bouton bouton--petit bouton--secondaire" disabled={envoi || !navigator.onLine} onClick={() => void envoyer()}>
            <IconeCoche /> {envoi ? 'Envoi…' : 'Envoyer maintenant'}
          </button>
        </div>
      )}
      {refusees.map((e) => (
        <div key={e.cleClient} className="alerte alerte--erreur" role="alert">
          <IconeAlerte />
          <div style={{ flex: 1 }}>
            <strong>Déclaration du {dateHeureFr(new Date(e.creeLe).toISOString())} refusée</strong>
            <div>{e.refus}</div>
            <div className="texte-discret">« {String(e.corps.description ?? '').slice(0, 120)} »</div>
          </div>
          <button type="button" className="bouton bouton--petit bouton--discret" onClick={() => window.confirm('Supprimer définitivement cette déclaration de l’appareil ?') && supprimerDeSortie(e.cleClient).then(charger)}>
            Supprimer
          </button>
        </div>
      ))}
    </div>
  )
}
