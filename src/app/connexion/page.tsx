'use client'

import { useState } from 'react'

export default function PageConnexion() {
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  async function soumettre(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErreur(null)
    setEnCours(true)
    const donnees = new FormData(e.currentTarget)
    try {
      const reponse = await fetch('/api/auth/connexion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: donnees.get('email'), motDePasse: donnees.get('motDePasse') }),
      })
      const corps = await reponse.json().catch(() => ({}))
      if (!reponse.ok) {
        setErreur(corps.erreur ?? 'Connexion impossible.')
        return
      }
      window.location.assign(corps.destination ?? '/')
    } catch {
      setErreur('Connexion impossible. Vérifiez votre réseau.')
    } finally {
      setEnCours(false)
    }
  }

  return (
    <main className="page-centree">
      {/* method="post" : si le JavaScript ne se charge pas, le mot de passe ne part jamais dans l'URL. */}
      <form className="carte-centree" method="post" onSubmit={soumettre}>
        <div className="carte-centree__logo">
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Plateforme QHSE</div>
          </div>
        </div>
        <h1>Connexion</h1>
        <p className="sous-titre">Espace réservé aux clients et aux consultants IFECARM GROUP.</p>

        <div className="champ">
          <label htmlFor="email">Adresse email</label>
          <input id="email" name="email" type="email" className="saisie" autoComplete="username" required />
        </div>
        <div className="champ">
          <label htmlFor="motDePasse">Mot de passe</label>
          <input id="motDePasse" name="motDePasse" type="password" className="saisie" autoComplete="current-password" required />
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>{erreur}</div>}

        <button type="submit" className="bouton bouton--bloc" style={{ marginTop: 22 }} disabled={enCours}>
          {enCours ? 'Connexion…' : 'Se connecter'}
        </button>
        <p style={{ marginTop: 14, textAlign: 'center' }}><a className="lien-action" href="/mot-de-passe-oublie">Mot de passe oublié ?</a></p>
      </form>
    </main>
  )
}
