'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconeListe, IconePlus, IconeSortie } from '@/ui/icones'

interface Pays { code: string, nom: string, actif: boolean, entreprises: number }

/**
 * Pays d'intervention d'IFECARM GROUP. Ajout : consultant et administrateur.
 * Renommer, archiver, supprimer : administrateur seulement (les droits sont
 * contrôlés en base, ces boutons ne font que refléter ce qui est permis).
 */
export default function PagePays() {
  const [d, setD] = useState<{ pays: Pays[], administrateur: boolean } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [nom, setNom] = useState('')
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ pays: Pays[], administrateur: boolean }>('/api/pays').then(setD).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/inspections')
      setErreur(messageErreur(e))
    })
  }, [])
  useEffect(charger, [charger])

  async function agir(fn: () => Promise<unknown>) {
    setErreur(null)
    setEnCours(true)
    try {
      await fn()
      charger()
      return true
    } catch (e) {
      setErreur(messageErreur(e))
      return false
    } finally {
      setEnCours(false)
    }
  }

  async function ajouter(ev: React.FormEvent) {
    ev.preventDefault()
    if (await agir(() => api('/api/pays', { method: 'POST', corps: { code, nom } }))) {
      setCode('')
      setNom('')
    }
  }

  function renommer(p: Pays) {
    const saisie = window.prompt(`Nouveau nom pour ${p.nom} :`, p.nom)
    if (saisie && saisie.trim() !== p.nom) void agir(() => api(`/api/pays/${p.code}`, { method: 'PATCH', corps: { nom: saisie, actif: p.actif } }))
  }

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte">
              <span className="marque__nom">IFECARM GROUP</span>
              <span className="marque__sous">Plateforme QHSE</span>
            </span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/vue-ensemble" title="Vue d’ensemble de tous les clients"><IconeListe /><span className="libelle">Vue d’ensemble</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter}><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu contenu--etroit">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Pays d’intervention</div>
            <h1>Où intervient IFECARM GROUP</h1>
            <p className="tete-page__desc">
              Ces pays sont proposés à la création d’un prospect. {d?.administrateur ? 'Vous pouvez les renommer, les archiver ou les supprimer.' : 'Vous pouvez en ajouter ; l’administrateur gère le reste.'}
            </p>
          </div>
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

        <form className="carte" onSubmit={ajouter} style={{ marginBottom: 20 }}>
          <div className="carte__titre"><h2>Ajouter un pays</h2></div>
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="p-nom">Nom du pays</label>
              <input id="p-nom" className="saisie" required maxLength={100} placeholder="Ex. Sénégal" value={nom} onChange={(e) => setNom(e.target.value)} />
            </div>
            <div className="champ">
              <label htmlFor="p-code">Code <span className="aide">(2 lettres, norme ISO)</span></label>
              <input id="p-code" className="saisie" required minLength={2} maxLength={2} placeholder="SN" style={{ textTransform: 'uppercase' }}
                value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </div>
          <button type="submit" className="bouton" disabled={enCours} style={{ marginTop: 16 }}><IconePlus /> Ajouter</button>
        </form>

        {!d && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
        <div className="inspections">
          {d?.pays.map((p) => (
            <div key={p.code} className="inspection-ligne">
              <div>
                <div className="inspection-ligne__titre">{p.nom}</div>
                <div className="inspection-ligne__badges">
                  <span className="badge badge--neutre">{p.code}</span>
                  {p.actif ? <span className="badge badge--vert"><IconeCoche />Proposé</span> : <span className="badge badge--neutre">Archivé</span>}
                  <span className="badge badge--bleu">{p.entreprises} entreprise{p.entreprises > 1 ? 's' : ''}</span>
                </div>
              </div>
              {d.administrateur && (
                <div className="equipement-actions">
                  <button type="button" className="lien-action" disabled={enCours} onClick={() => renommer(p)}>Renommer</button>
                  <button type="button" className="lien-action" disabled={enCours}
                    onClick={() => agir(() => api(`/api/pays/${p.code}`, { method: 'PATCH', corps: { nom: p.nom, actif: !p.actif } }))}>
                    {p.actif ? 'Archiver' : 'Remettre'}
                  </button>
                  {p.entreprises === 0 && (
                    <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                      onClick={() => window.confirm(`Supprimer « ${p.nom} » de la liste ?`) && agir(() => api(`/api/pays/${p.code}`, { method: 'DELETE' }))}>
                      Supprimer
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </>
  )
}
