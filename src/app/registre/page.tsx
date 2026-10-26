'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { classeCriticite, dateHeureFr, LIBELLE_STATUT_DECLARATION, LIBELLE_TYPE_DECLARATION } from '@/ui/libelles'
import { IconeAlerte, IconeBatiment, IconeCalendrier, IconePlus } from '@/ui/icones'
import { SortieEnAttente } from '@/registre/SortieEnAttente'

interface Ligne {
  id: string, reference: string, type: string, statut: string, survenu_le: string, lieu: string | null, site_nom: string | null
  anonyme: boolean, gravite: number | null, frequence: number | null, criticite: number | null, actions_ouvertes: number
}
interface Droits { equipe: boolean, responsable: boolean, responsableSite?: boolean }

const FILTRES: [string, string][] = [['', 'Tout'], ['a_qualifier', 'À qualifier'], ['en_analyse', 'En analyse'], ['en_action', 'Actions en cours'], ['cloturee', 'Clôturées'], ['sans_suite', 'Sans suite']]

/** Registre de sécurité : les déclarations que l'utilisateur a le droit de lire (la base en décide, pas l'écran). */
export default function PageRegistre() {
  const [lignes, setLignes] = useState<Ligne[] | null>(null)
  const [droits, setDroits] = useState<Droits | null>(null)
  const [statut, setStatut] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)

  const charger = useCallback(() => {
    api<{ declarations: Ligne[] }>(`/api/registre/declarations${statut ? `?statut=${statut}` : ''}`)
      .then((r) => { setLignes(r.declarations); setErreur(null) })
      .catch((e) => setErreur(messageErreur(e)))
  }, [statut])

  useEffect(() => { charger() }, [charger])
  useEffect(() => { api<Droits>('/api/registre/contexte').then(setDroits).catch(() => {}) }, [])

  // Charge une fois la page de saisie (et ses ressources) en arrière-plan : le service worker la garde pour le hors ligne.
  useEffect(() => {
    try { if (sessionStorage.getItem('ifecarm.amorce-saisie')) return; sessionStorage.setItem('ifecarm.amorce-saisie', '1') } catch { return }
    const cadre = document.createElement('iframe')
    cadre.src = '/registre/nouvelle'
    cadre.hidden = true
    cadre.setAttribute('aria-hidden', 'true')
    cadre.tabIndex = -1
    document.body.appendChild(cadre)
    const t = window.setTimeout(() => cadre.remove(), 20_000)
    return () => { window.clearTimeout(t); cadre.remove() }
  }, [])

  const voitTout = droits?.equipe || droits?.responsable
  const voitSonSite = !voitTout && droits?.responsableSite

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Incidents</div>
          <h1>{voitTout ? 'Registre de sécurité' : voitSonSite ? 'Déclarations de mon site' : 'Mes déclarations'}</h1>
          <p className="tete-page__desc">{voitTout ? 'Accidents, presqu’accidents et situations dangereuses, de la déclaration à la clôture.' : voitSonSite ? 'Les déclarations nominatives de votre site, et les vôtres. Une déclaration anonyme n’apparaît pas ici.' : 'Vos déclarations nominatives. Une déclaration anonyme n’apparaît pas ici.'}</p>
        </div>
        <a className="bouton" href="/registre/nouvelle"><IconePlus /> Déclarer</a>
      </div>

      <SortieEnAttente onEnvoyees={charger} />

      {(voitTout || voitSonSite) && (
        <div className="onglets" role="group" aria-label="Filtrer par statut" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          {FILTRES.map(([v, t]) => <button key={v} type="button" aria-pressed={statut === v} onClick={() => setStatut(v)}>{t}</button>)}
        </div>
      )}

      {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
      {!lignes && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
      {lignes?.length === 0 && <p className="texte-discret">Aucune déclaration{statut ? ' avec ce statut' : ''} pour l’instant.</p>}
      <div className="pile">
        {lignes?.map((d) => {
          const t = LIBELLE_TYPE_DECLARATION[d.type] ?? { texte: d.type, classe: 'badge--neutre' }
          const s = LIBELLE_STATUT_DECLARATION[d.statut] ?? { texte: d.statut, classe: 'badge--neutre' }
          return (
            <a key={d.id} className="carte inspection-ligne" href={`/registre/${d.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="inspection-ligne__tete">
                <strong>{d.reference}</strong>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className={`badge ${t.classe}`}>{t.texte}</span>
                  <span className={`badge ${s.classe}`}>{s.texte}</span>
                  {d.criticite != null && <span className={`badge ${classeCriticite(d.criticite)}`} title={`Gravité ${d.gravite} × fréquence ${d.frequence}`}>Criticité {d.criticite}</span>}
                </span>
              </div>
              <div className="inspection-ligne__meta">
                <span><IconeCalendrier />{dateHeureFr(d.survenu_le)}</span>
                {d.site_nom && <span><IconeBatiment />{d.site_nom}</span>}
                {d.lieu && <span>{d.lieu}</span>}
                {d.anonyme && <span>Anonyme</span>}
                {d.actions_ouvertes > 0 && <span><IconeAlerte />{d.actions_ouvertes} action{d.actions_ouvertes > 1 ? 's' : ''} ouverte{d.actions_ouvertes > 1 ? 's' : ''}</span>}
              </div>
            </a>
          )
        })}
      </div>
    </main>
  )
}
