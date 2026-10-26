'use client'

import { useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche } from '@/ui/icones'
import Section2fa from '@/ui/Section2fa'

export default function PageMonCompte() {
  const [actuel, setActuel] = useState('')
  const [nouveau, setNouveau] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [succes, setSucces] = useState(false)
  const [enCours, setEnCours] = useState(false)

  async function envoyer(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    setSucces(false)
    if (nouveau !== confirmation) return setErreur('La confirmation ne correspond pas au nouveau mot de passe.')
    setEnCours(true)
    try {
      await api('/api/auth/mot-de-passe', { method: 'POST', corps: { actuel, nouveau } })
      setSucces(true)
      setActuel('')
      setNouveau('')
      setConfirmation('')
    } catch (e) {
      setErreur(messageErreur(e))
    } finally {
      setEnCours(false)
    }
  }

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Mon compte</div>
          <h1>Changer mon mot de passe</h1>
          <p className="tete-page__desc">
            Remplacez le mot de passe provisoire reçu de votre consultant par un mot de passe personnel.
            Vos autres sessions ouvertes seront fermées.
          </p>
        </div>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {succes && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> Mot de passe modifié.</div>}

      <form className="carte" onSubmit={envoyer} style={{ maxWidth: 480 }}>
        <div className="champ">
          <label htmlFor="mdp-actuel">Mot de passe actuel</label>
          <input id="mdp-actuel" type="password" className="saisie" required autoComplete="current-password"
            value={actuel} onChange={(e) => setActuel(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="mdp-nouveau">Nouveau mot de passe <span className="aide">(10 caractères minimum)</span></label>
          <input id="mdp-nouveau" type="password" className="saisie" required minLength={10} maxLength={200} autoComplete="new-password"
            value={nouveau} onChange={(e) => setNouveau(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="mdp-confirmation">Confirmer le nouveau mot de passe</label>
          <input id="mdp-confirmation" type="password" className="saisie" required minLength={10} maxLength={200} autoComplete="new-password"
            value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </div>
        <button type="submit" className="bouton" disabled={enCours} style={{ marginTop: 18 }}><IconeCoche /> Enregistrer</button>
      </form>

      <Section2fa />
    </main>
  )
}
