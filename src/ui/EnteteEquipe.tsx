'use client'

import { IconePlus, IconeSortie } from './icones'

/** En-tête des pages transverses de l'équipe IFECARM (sans entreprise active) : mini-audits, opportunités. */
export default function EnteteEquipe({ administrateur = false }: { administrateur?: boolean }) {
  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }
  return (
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
          <a className="lien-entete" href="/vue-ensemble" title="Vue d’ensemble de tous les clients"><span className="libelle">Vue d’ensemble</span></a>
          <a className="lien-entete" href="/opportunites" title="Échéances des clients à vendre"><span className="libelle">À relancer</span></a>
          <a className="lien-entete" href="/mini-audits" title="Demandes du mini-audit gratuit"><span className="libelle">Mini-audits</span></a>
          <a className="lien-entete" href="/prospects/nouveau" title="Nouveau prospect"><IconePlus className="icone" /><span className="libelle">Prospect</span></a>
          {administrateur && <a className="lien-entete" href="/administration" title="Clients, modules et accès"><span className="libelle">Administration</span></a>}
          <a className="lien-entete" href="/mon-compte" title="Mon compte"><span className="libelle">Mon compte</span></a>
          <button type="button" className="lien-entete" onClick={deconnecter} title="Se déconnecter"><IconeSortie /><span className="libelle">Déconnexion</span></button>
        </nav>
      </div>
    </header>
  )
}
