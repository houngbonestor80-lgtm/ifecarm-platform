'use client'

import { usePathname } from 'next/navigation'
import { createContext, useContext, useEffect, useState } from 'react'
import { api, messageErreur } from './api'
import { IconeAlerte, IconeEchange, IconeListe, IconePersonne, IconePlus, IconeSortie } from './icones'
import { DUREE_CONTEXTE_MS, listerSortie, viderCache } from '@/registre/hors-ligne'

/**
 * Cadre commun des écrans (en-tête IFECARM, entreprise active, navigation).
 * Charge le contexte une fois — la session décide de tout côté serveur ; ce
 * composant ne fait qu'afficher et rediriger (connexion / choix d'entreprise).
 */

export interface ContexteApp {
  entreprise: { nom: string, statutRelation: 'client' | 'prospect' }
  consultant: boolean
  peutConduire: boolean
  tableauDeBord: boolean
  formations: boolean
  incidents: boolean
  habilitations: boolean
  autodiagnostic: boolean
  moi: string
  entrepriseId: string
  /** Contexte relu depuis l'appareil faute de réseau : seules les pages hors ligne (saisie d'une déclaration) fonctionnent. */
  horsLigne?: boolean
}

const CLE_CONTEXTE = 'ifecarm.contexte'

const Contexte = createContext<ContexteApp | null>(null)
export const useContexteApp = () => {
  const c = useContext(Contexte)
  if (!c) throw new Error('useContexteApp hors de CadreApplication')
  return c
}

export default function CadreApplication({ children }: { children: React.ReactNode }) {
  const [ctx, setCtx] = useState<ContexteApp | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const chemin = usePathname()

  useEffect(() => {
    api<ContexteApp>('/api/inspections/contexte')
      .then((c) => {
        setCtx(c)
        try { localStorage.setItem(CLE_CONTEXTE, JSON.stringify({ memoriseLe: Date.now(), contexte: c })) } catch { /* stockage indisponible : sans effet */ }
      })
      .catch((e) => {
        // Pas de réseau (fetch rejeté) : on rouvre avec le dernier contexte connu, pour que la saisie hors ligne reste possible.
        if (e instanceof TypeError) {
          try {
            const memo = JSON.parse(localStorage.getItem(CLE_CONTEXTE) ?? 'null') as { memoriseLe?: number, contexte?: ContexteApp } | null
            // Contexte plus vieux qu'une session (12 h), ancien format ou illisible : effacé, jamais réutilisé.
            if (memo?.contexte && typeof memo.memoriseLe === 'number' && Date.now() - memo.memoriseLe <= DUREE_CONTEXTE_MS) { setCtx({ ...memo.contexte, horsLigne: true }); return }
            localStorage.removeItem(CLE_CONTEXTE)
          } catch { /* mémo illisible */ }
        }
        setErreur(messageErreur(e))
      })
  }, [])

  // Le service worker (saisie hors ligne du registre, installation) est enregistré par src/ui/ServiceWorker.tsx.

  async function deconnecter() {
    // Des déclarations non envoyées restent sur l'appareil : on prévient avant de partir.
    if (ctx) {
      const restantes = (await listerSortie().catch(() => [])).filter((e) => e.utilisateurId === ctx.moi && !e.refus).length
      if (restantes > 0 && !window.confirm(`${restantes} déclaration${restantes > 1 ? 's' : ''} non envoyée${restantes > 1 ? 's' : ''} reste${restantes > 1 ? 'nt' : ''} sur cet appareil et partira${restantes > 1 ? 'ont' : ''} à votre prochaine connexion avec ce compte. Se déconnecter quand même ?`)) return
    }
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    try { localStorage.removeItem(CLE_CONTEXTE) } catch { /* sans effet */ }
    await viderCache().catch(() => {}) // sites et salariés de l'entreprise : pas pour le prochain utilisateur de l'appareil
    window.location.assign('/connexion')
  }

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href={ctx?.consultant ? '/vue-ensemble' : '/inspections'} aria-label="IFECARM GROUP — Plateforme QHSE, accueil">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte">
              <span className="marque__nom">IFECARM GROUP</span>
              <span className="marque__sous">Plateforme QHSE</span>
            </span>
          </a>

          {ctx && (
            <div className="entete__entreprise" title="Entreprise active">
              <span className="entete__entreprise-nom">{ctx.entreprise.nom}</span>
              {ctx.entreprise.statutRelation === 'prospect' && <span className="badge badge--prospect">Prospect</span>}
            </div>
          )}

          <nav className="entete__actions" aria-label="Session">
            {ctx?.consultant && (
              <>
                <a className="lien-entete" href="/vue-ensemble" title="Vue d’ensemble de tous les clients">
                  <IconeListe /><span className="libelle">Vue d’ensemble</span>
                </a>
                <a className="lien-entete" href="/prospects/nouveau" title="Nouveau prospect">
                  <IconePlus className="icone" /><span className="libelle">Prospect</span>
                </a>
                <a className="lien-entete" href="/entreprises" title="Changer d’entreprise">
                  <IconeEchange /><span className="libelle">Changer</span>
                </a>
              </>
            )}
            <a className="lien-entete" href="/mon-compte" title="Mon compte">
              <IconePersonne /><span className="libelle">Mon compte</span>
            </a>
            <button type="button" className="lien-entete" onClick={deconnecter} title="Se déconnecter">
              <IconeSortie /><span className="libelle">Déconnexion</span>
            </button>
          </nav>
        </div>
        {ctx && (
          <nav className="onglets-app" aria-label="Modules">
            {[
              ...(ctx.tableauDeBord ? [['/tableau-de-bord', 'Tableau de bord']] : []),
              ['/inspections', 'Inspections'],
              ['/equipements', 'Équipements & EPI'],
              ...(ctx.formations ? [['/formations', 'Formations']] : []),
              ...(ctx.incidents ? [['/registre', 'Incidents']] : []),
              ...(ctx.habilitations ? [['/habilitations', 'Habilitations']] : []),
              ...(ctx.autodiagnostic ? [['/autodiagnostic', 'Autodiagnostic']] : []),
              ...(ctx.consultant ? [['/modeles', 'Modèles'], ['/suivi', 'Suivi']] : []),
              ...(ctx.peutConduire ? [['/acces', 'Accès']] : []),
            ].map(([href, texte]) => (
              <a key={href} href={href} aria-current={chemin.startsWith(href!) ? 'page' : undefined}>{texte}</a>
            ))}
          </nav>
        )}
      </header>

      {ctx?.horsLigne && (
        <div className="alerte alerte--attention" role="status" style={{ maxWidth: 1088, margin: '12px auto 0' }}>
          <IconeAlerte /> Hors ligne : seule la saisie d’une déclaration est disponible. Elle sera envoyée dès le retour du réseau.
        </div>
      )}
      {erreur && (
        <main className="contenu contenu--etroit">
          <div className="alerte alerte--erreur" role="alert">{erreur}</div>
          <p style={{ marginTop: 16 }}>
            <a className="bouton bouton--secondaire" href="/entreprises">Choisir une autre entreprise</a>
          </p>
        </main>
      )}
      {!erreur && !ctx && (
        <main className="contenu" aria-busy="true">
          <div className="squelette" style={{ height: 36, width: 260, marginBottom: 20 }} />
          <div className="squelette" style={{ height: 96 }} />
        </main>
      )}
      {ctx && <Contexte.Provider value={ctx}>{children}</Contexte.Provider>}
    </>
  )
}
