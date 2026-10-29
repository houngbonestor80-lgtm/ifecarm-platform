'use client'

import { IconeBatiment, IconeBouclier, IconeGlobe, IconeHorloge, IconeListe, IconeOutil, IconePersonne, IconePlus, IconeSortie } from './icones'

/**
 * En-tête des pages transverses de l'équipe IFECARM (sans entreprise active) : vue d'ensemble, relances, mini-audits.
 * Ligne 1 : logo et compte. Ligne 2 : les outils, avec leur texte (elle défile sur elle-même si l'écran est étroit).
 * Sur téléphone, tout tient sur une seule ligne défilante.
 */
export default function EnteteEquipe({ administrateur = false, courant }: { administrateur?: boolean, courant?: string }) {
  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }
  const ac = (href: string) => (href === courant ? ('page' as const) : undefined)
  return (
    <header className="entete entete--outils entete--equipe">
      <div className="entete__barre">
        <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
          <img src="/brand/logo-circle.svg" alt="" />
          <span className="marque__texte">
            <span className="marque__nom">IFECARM GROUP</span>
            <span className="marque__sous">Plateforme QHSE</span>
          </span>
        </a>
        <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
          <a className="lien-entete" href="/mon-compte" title="Mon compte"><IconePersonne /><span className="libelle">Mon compte</span></a>
          <button type="button" className="lien-entete" onClick={deconnecter} title="Se déconnecter"><IconeSortie /><span className="libelle">Déconnexion</span></button>
        </nav>
      </div>
      <div className="entete__sous">
        <nav className="entete__outils" aria-label="Outils de l’équipe">
          <a className="lien-entete" href="/vue-ensemble" aria-current={ac('/vue-ensemble')} title="Vue d’ensemble de tous les clients"><IconeListe /><span className="libelle">Vue d’ensemble</span></a>
          <a className="lien-entete" href="/opportunites" aria-current={ac('/opportunites')} title="Échéances des clients à vendre"><IconeHorloge /><span className="libelle">À relancer</span></a>
          <a className="lien-entete" href="/mini-audits" aria-current={ac('/mini-audits')} title="Demandes du mini-audit gratuit"><IconeBouclier /><span className="libelle">Mini-audits</span></a>
          <a className="lien-entete" href="/prospects/nouveau" aria-current={ac('/prospects/nouveau')} title="Nouveau prospect"><IconePlus className="icone" /><span className="libelle">Prospect</span></a>
          <a className="lien-entete" href="/entreprises" aria-current={ac('/entreprises')} title="Choisir une entreprise"><IconeBatiment /><span className="libelle">Entreprises</span></a>
          <a className="lien-entete" href="/pays" aria-current={ac('/pays')} title="Pays d’intervention"><IconeGlobe /><span className="libelle">Pays</span></a>
          {administrateur && <a className="lien-entete" href="/administration" aria-current={ac('/administration')} title="Clients, modules et accès"><IconeOutil /><span className="libelle">Administration</span></a>}
          <a className="lien-entete lien-entete--mobile" href="/mon-compte" title="Mon compte"><IconePersonne /><span className="libelle">Mon compte</span></a>
          <button type="button" className="lien-entete lien-entete--mobile" onClick={deconnecter} title="Se déconnecter"><IconeSortie /><span className="libelle">Déconnexion</span></button>
        </nav>
      </div>
    </header>
  )
}
