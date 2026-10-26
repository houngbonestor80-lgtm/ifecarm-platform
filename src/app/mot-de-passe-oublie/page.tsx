'use client'

import { useState } from 'react'
import { api, messageErreur } from '@/ui/api'

export default function PageMotDePasseOublie() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  async function envoyer(ev: React.FormEvent) {
    ev.preventDefault()
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ message: string }>('/api/auth/mot-de-passe-oublie', { method: 'POST', corps: { email } })
      setMessage(r.message)
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
        <h1>Mot de passe oublié</h1>
        {message ? (
          <>
            <div className="alerte alerte--info" role="status" style={{ marginTop: 16 }}>
              {message} Le lien est valable 60 minutes. Pensez à vérifier vos courriers indésirables.
            </div>
            <a className="bouton bouton--secondaire bouton--bloc" style={{ marginTop: 20 }} href="/connexion">Retour à la connexion</a>
          </>
        ) : (
          <>
            <p className="sous-titre">Saisissez votre adresse email : si elle correspond à un compte, vous recevrez un lien pour choisir un nouveau mot de passe.</p>
            <div className="champ">
              <label htmlFor="email">Adresse email</label>
              <input id="email" type="email" className="saisie" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>{erreur}</div>}
            <button type="submit" className="bouton bouton--bloc" style={{ marginTop: 22 }} disabled={enCours}>{enCours ? 'Envoi…' : 'Envoyer le lien'}</button>
            <p style={{ marginTop: 14, textAlign: 'center' }}><a className="lien-action" href="/connexion">Retour à la connexion</a></p>
          </>
        )}
      </form>
    </main>
  )
}
