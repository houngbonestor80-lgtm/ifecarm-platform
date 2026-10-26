'use client'

import { useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'

export default function PageReinitialiser() {
  const [jeton, setJeton] = useState<string | null>(null)
  const [nouveau, setNouveau] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [fait, setFait] = useState(false)
  const [enCours, setEnCours] = useState(false)

  useEffect(() => {
    // Le jeton est lu dans l'URL puis retiré de la barre d'adresse (historique, copier-coller).
    setJeton(new URLSearchParams(window.location.search).get('jeton') ?? '')
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  async function envoyer(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    if (nouveau !== confirmation) return setErreur('La confirmation ne correspond pas au nouveau mot de passe.')
    setEnCours(true)
    try {
      await api('/api/auth/reinitialiser', { method: 'POST', corps: { jeton, motDePasse: nouveau } })
      setFait(true)
    } catch (e) {
      setErreur(messageErreur(e))
    } finally {
      setEnCours(false)
    }
  }

  return (
    <main className="page-centree">
      <form className="carte-centree" onSubmit={envoyer}>
        <div className="carte-centree__logo">
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Plateforme QHSE</div>
          </div>
        </div>
        <h1>Nouveau mot de passe</h1>
        {fait ? (
          <>
            <div className="alerte alerte--info" role="status" style={{ marginTop: 16 }}>
              Mot de passe modifié. Vos autres sessions ont été fermées ; la double authentification, si elle est activée, reste demandée.
            </div>
            <a className="bouton bouton--bloc" style={{ marginTop: 20 }} href="/connexion">Se connecter</a>
          </>
        ) : jeton === '' ? (
          <>
            <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>Lien invalide ou expiré.</div>
            <a className="bouton bouton--secondaire bouton--bloc" style={{ marginTop: 20 }} href="/mot-de-passe-oublie">Demander un nouveau lien</a>
          </>
        ) : (
          <>
            <p className="sous-titre">Choisissez un mot de passe personnel (10 caractères minimum).</p>
            <div className="champ">
              <label htmlFor="mdp-nouveau">Nouveau mot de passe</label>
              <input id="mdp-nouveau" type="password" className="saisie" required minLength={10} maxLength={200} autoComplete="new-password"
                value={nouveau} onChange={(e) => setNouveau(e.target.value)} />
            </div>
            <div className="champ">
              <label htmlFor="mdp-confirmation">Confirmer le mot de passe</label>
              <input id="mdp-confirmation" type="password" className="saisie" required minLength={10} maxLength={200} autoComplete="new-password"
                value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </div>
            {erreur && (
              <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>
                {erreur} {/invalide ou expiré/i.test(erreur) && <a href="/mot-de-passe-oublie">Demander un nouveau lien</a>}
              </div>
            )}
            <button type="submit" className="bouton bouton--bloc" style={{ marginTop: 22 }} disabled={enCours || jeton === null}>{enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
          </>
        )}
      </form>
    </main>
  )
}
