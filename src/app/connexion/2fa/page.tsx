'use client'

import { useEffect, useState } from 'react'
import ActivationA2f from '@/ui/ActivationA2f'
import { api, messageErreur } from '@/ui/api'

interface Etat { etape: 'code' | 'activation' | null, obligatoire: boolean }

const destination = (d?: string) => window.location.assign(d ?? '/')

export default function PageA2f() {
  const [etat, setEtat] = useState<Etat | null>(null)
  const [code, setCode] = useState('')
  const [secours, setSecours] = useState(false)
  const [memoriser, setMemoriser] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  useEffect(() => {
    // 401 : pas de session (ou session révoquée après trop d'échecs) → api() renvoie vers /connexion.
    api<Etat>('/api/auth/2fa/etat').then((e) => (e.etape ? setEtat(e) : destination())).catch((e) => setErreur(messageErreur(e)))
  }, [])

  async function verifier(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ destination: string }>('/api/auth/2fa/verifier', { method: 'POST', corps: { code, secours, memoriser } })
      destination(r.destination)
    } catch (e) {
      setErreur(messageErreur(e))
      setEnCours(false)
    }
  }

  async function quitter() {
    await api('/api/auth/deconnexion', { method: 'POST', corps: {} }).catch(() => undefined)
    window.location.assign('/connexion')
  }

  return (
    <main className="page-centree">
      <div className="carte-centree">
        <div className="carte-centree__logo">
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Plateforme QHSE</div>
          </div>
        </div>

        {!etat && !erreur && <p className="sous-titre">Chargement…</p>}
        {!etat && erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}

        {etat?.etape === 'activation' && (
          <>
            <h1>Activer la double authentification</h1>
            <p className="sous-titre">Elle est obligatoire pour votre rôle : un code de votre téléphone sera demandé à chaque connexion.</p>
            <ActivationA2f onActive={() => destination()} />
          </>
        )}

        {etat?.etape === 'code' && (
          <form onSubmit={verifier}>
            <h1>Double authentification</h1>
            <p className="sous-titre">
              {secours ? 'Saisissez l’un de vos codes de secours (usage unique).' : 'Saisissez le code à 6 chiffres affiché par votre application d’authentification.'}
            </p>
            <div className="champ">
              <label htmlFor="a2f-code">{secours ? 'Code de secours' : 'Code à 6 chiffres'}</label>
              <input id="a2f-code" className="saisie" autoFocus required autoComplete="one-time-code"
                inputMode={secours ? 'text' : 'numeric'} maxLength={secours ? 24 : 7}
                value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
              <input type="checkbox" checked={memoriser} onChange={(e) => setMemoriser(e.target.checked)} />
              Ne plus demander sur cet appareil pendant 30 jours
            </label>
            {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>{erreur}</div>}
            <button type="submit" className="bouton bouton--bloc" style={{ marginTop: 20 }} disabled={enCours}>{enCours ? 'Vérification…' : 'Valider'}</button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
              <button type="button" className="lien-action" onClick={() => { setSecours(!secours); setCode(''); setErreur(null) }}>
                {secours ? 'Utiliser mon application' : 'Utiliser un code de secours'}
              </button>
              <button type="button" className="lien-action" onClick={quitter}>Annuler</button>
            </div>
          </form>
        )}
      </div>
    </main>
  )
}
