'use client'

import { useEffect, useState } from 'react'
import { IconeCroix, IconePlus } from '@/ui/icones'

interface Entreprise {
  id: string
  nom: string
  statutRelation: 'client' | 'prospect'
  ecriture: boolean
  finLe: string | null
  supprimable: boolean
}

/**
 * Sélecteur de tenant du consultant : la liste vient du serveur (accès valides
 * uniquement) ; le choix est revérifié côté serveur (exigerAccesConsultant).
 * Le navigateur n'envoie qu'un identifiant que le serveur contrôle.
 */
export default function PageEntreprises() {
  const [entreprises, setEntreprises] = useState<Entreprise[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/entreprises')
      .then(async (r) => {
        if (r.status === 401) return window.location.assign('/connexion')
        const corps = await r.json()
        if (r.status === 403) return window.location.assign('/inspections') // utilisateur client : pas de sélecteur
        if (!r.ok) return setErreur(corps.erreur ?? 'Chargement impossible.')
        setEntreprises(corps.entreprises)
      })
      .catch(() => setErreur('Chargement impossible.'))
  }, [])

  async function choisir(id: string) {
    setErreur(null)
    setEnCours(id)
    const r = await fetch('/api/auth/entreprise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entrepriseId: id }),
    })
    const corps = await r.json().catch(() => ({}))
    if (!r.ok) {
      setErreur(corps.erreur ?? 'Accès refusé.')
      setEnCours(null)
      return
    }
    window.location.assign('/inspections')
  }

  async function supprimer(e: Entreprise) {
    const quoi = e.statutRelation === 'prospect' ? 'ce prospect' : 'ce client'
    const saisie = window.prompt(
      `Suppression DÉFINITIVE de ${quoi} : ${e.nom}\n\nTout sera effacé : inspections, non-conformités, plans d’action, photos, utilisateurs et accès. Aucun retour possible.\n\nPour confirmer, tapez le nom de l’entreprise :`,
    )
    if (saisie === null) return
    setErreur(null)
    setEnCours(e.id)
    const r = await fetch(`/api/auth/entreprises/${e.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: saisie }),
    })
    const corps = await r.json().catch(() => ({}))
    setEnCours(null)
    if (!r.ok) return setErreur(corps.erreur ?? 'Suppression impossible.')
    setEntreprises((l) => l?.filter((x) => x.id !== e.id) ?? null)
  }

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  const clients = entreprises?.filter((e) => e.statutRelation === 'client') ?? []
  const prospects = entreprises?.filter((e) => e.statutRelation === 'prospect') ?? []

  const liste = (items: Entreprise[]) => (
    <ul className="liste-entreprises">
      {items.map((e) => (
        <li key={e.id} className="liste-entreprises__ligne">
          <button type="button" disabled={enCours !== null} onClick={() => choisir(e.id)}>
            <span className="nom">{e.nom}</span>
            <span className={`badge ${e.statutRelation === 'prospect' ? 'badge--prospect' : 'badge--vert'}`}>
              {e.statutRelation === 'prospect' ? 'Prospect' : 'Client'}
            </span>
            <span className="meta">
              {e.ecriture ? 'Lecture et écriture' : 'Lecture seule'}
              {e.finLe ? ` · mandat jusqu’au ${new Date(e.finLe).toLocaleDateString('fr-FR')}` : ''}
            </span>
          </button>
          {e.supprimable && (
            <button type="button" className="liste-entreprises__suppr" disabled={enCours !== null} onClick={() => supprimer(e)}
              title={`Supprimer définitivement ${e.nom}`} aria-label={`Supprimer définitivement ${e.nom}`}>
              <IconeCroix />
            </button>
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <main className="page-centree">
      <div className="carte-centree" style={{ maxWidth: 520 }}>
        <div className="carte-centree__logo">
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Plateforme QHSE</div>
          </div>
        </div>
        <h1>Choisir une entreprise</h1>
        <p className="sous-titre">Clients et prospects sur lesquels votre mandat est en cours.</p>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {entreprises === null && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}
        {entreprises?.length === 0 && (
          <div className="alerte alerte--info">Aucun mandat en cours. Contactez l’administration IFECARM GROUP, ou créez un prospect.</div>
        )}

        {clients.length > 0 && liste(clients)}
        {prospects.length > 0 && (
          <>
            <div className="separateur">Prospects</div>
            {liste(prospects)}
          </>
        )}

        <a className="bouton bouton--secondaire bouton--bloc" href="/prospects/nouveau" style={{ marginTop: 20 }}>
          <IconePlus /> Nouveau prospect
        </a>
        <button type="button" className="bouton bouton--discret bouton--bloc" onClick={deconnecter} style={{ marginTop: 10 }}>
          Se déconnecter
        </button>
      </div>
    </main>
  )
}
