'use client'

import { useCallback, useEffect, useState } from 'react'
import { classeScore } from '@/autodiagnostic/classes'
import { api, messageErreur } from '@/ui/api'
import ChoixSite, { SITE_VIDE, corpsSite, type ValeurSite } from '@/ui/ChoixSite'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeCoche } from '@/ui/icones'
import { dateCourteFr } from '@/ui/libelles'

interface Referentiel { code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, nb_questions: number }
interface Evaluation {
  id: string, reference: string, referentiel_code: string, referentiel_titre: string, statut: 'en_cours' | 'terminee', score_global: number | null,
  niveau_libelle: string | null, realise_le: string, site_nom: string | null, interlocuteur: string | null, conduit_par_nom: string | null,
  nb_questions: number, nb_reponses: number, score_precedent: number | null
}
interface Donnees { evaluations: Evaluation[], referentiels: Referentiel[], sites: { id: string, nom: string }[], equipe: boolean, peutConduire: boolean }

/**
 * Autodiagnostic QHSE (B1). Le consultant conduit l'évaluation chez / avec le client ; le client (admin d'entreprise,
 * responsable QHSE) retrouve ici les évaluations terminées, avec leur évolution.
 */
export default function PageAutodiagnostics() {
  const { entreprise } = useContexteApp()
  const [d, setD] = useState<Donnees | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [ouvert, setOuvert] = useState(false)
  const [code, setCode] = useState('')
  const [site, setSite] = useState<ValeurSite>(SITE_VIDE)
  const [interlocuteur, setInterlocuteur] = useState('')
  const [date, setDate] = useState(() => new Date().toLocaleDateString('sv-SE'))
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<Donnees>('/api/autodiagnostic').then(setD).catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(() => { charger() }, [charger])

  async function demarrer(e: React.FormEvent) {
    e.preventDefault()
    if (!code) return setErreur('Choisissez un référentiel.')
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ id: string }>('/api/autodiagnostic', { method: 'POST', corps: { referentiel: code, interlocuteur, realiseLe: date, ...corpsSite(site) } })
      window.location.assign(`/autodiagnostic/${r.id}`)
    } catch (err) {
      setErreur(messageErreur(err))
      setEnCours(false)
    }
  }

  return (
    <main className="contenu">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Autodiagnostic</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">
            Évaluation de la maturité du système de management, norme par norme. Le consultant conduit l’évaluation avec votre équipe ;
            le résultat, son rapport PDF et le plan d’action issu des écarts sont ensuite consultables ici.
          </p>
        </div>
        {d?.peutConduire && !ouvert && <button type="button" className="bouton" onClick={() => setOuvert(true)}>Nouvelle évaluation</button>}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {!d && !erreur && <div className="squelette" style={{ height: 160 }} aria-busy="true" />}

      {d && ouvert && d.peutConduire && (
        <form className="carte" style={{ marginBottom: 18 }} onSubmit={demarrer}>
          <div className="carte__titre"><h2>Nouvelle évaluation</h2></div>
          {d.referentiels.length === 0 ? (
            <div className="alerte alerte--attention">Aucun référentiel n’est disponible. L’administration IFECARM doit en activer un.</div>
          ) : (
            <div className="choix" role="radiogroup" aria-label="Référentiel">
              {d.referentiels.map((r) => (
                <label key={r.code} className="choix__option">
                  <input type="radio" name="referentiel" value={r.code} checked={code === r.code} onChange={() => setCode(r.code)} />
                  <div className="choix__titre">{r.titre}</div>
                  <div className="choix__meta">{r.nb_questions} questions · environ {r.duree_estimee_minutes} min</div>
                  <div className="choix__meta">{r.description}</div>
                </label>
              ))}
            </div>
          )}
          <div className="grille-2" style={{ marginTop: 16 }}>
            <ChoixSite id="ad-site" sites={d.sites} valeur={site} onChange={setSite} />
            <div className="champ">
              <label htmlFor="ad-interlocuteur">Interlocuteur du client <span className="aide">(facultatif)</span></label>
              <input id="ad-interlocuteur" className="saisie" maxLength={200} placeholder="Nom et fonction de la personne interrogée" value={interlocuteur} onChange={(e) => setInterlocuteur(e.target.value)} />
            </div>
            <div className="champ">
              <label htmlFor="ad-date">Date de l’évaluation</label>
              <input id="ad-date" type="date" className="saisie" required value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="submit" className="bouton" disabled={enCours || !code}><IconeCoche /> {enCours ? 'Création…' : 'Démarrer'}</button>
            <button type="button" className="bouton bouton--discret" onClick={() => setOuvert(false)}>Annuler</button>
          </div>
        </form>
      )}

      {d && d.evaluations.length === 0 && (
        <div className="etat-vide">
          <h2>Aucune évaluation</h2>
          <p>{d.peutConduire ? 'Démarrez un autodiagnostic pour mesurer la maturité de l’entreprise.' : 'Votre consultant IFECARM GROUP conduira l’autodiagnostic ; les résultats apparaîtront ici.'}</p>
        </div>
      )}

      {d && d.evaluations.length > 0 && (
        <div className="inspections">
          {d.evaluations.map((e) => {
            const delta = e.statut === 'terminee' && e.score_global !== null && e.score_precedent !== null ? e.score_global - e.score_precedent : null
            return (
              <a key={e.id} className="inspection-ligne" href={`/autodiagnostic/${e.id}`}>
                <div>
                  <div className="inspection-ligne__titre">{e.referentiel_titre}</div>
                  <div className="inspection-ligne__meta">
                    <span>{e.reference}</span>
                    <span>{dateCourteFr(e.realise_le)}</span>
                    {e.site_nom && <span>{e.site_nom}</span>}
                    {e.interlocuteur && <span>{e.interlocuteur}</span>}
                  </div>
                  <div className="inspection-ligne__badges">
                    {e.statut === 'terminee' && e.score_global !== null ? (
                      <>
                        <span className={`badge ${classeScore(e.score_global)}`}>{e.score_global} % · {e.niveau_libelle}</span>
                        {delta !== null && <span className={`badge ${delta >= 0 ? 'badge--vert' : 'badge--rouge'}`}>{delta > 0 ? '+' : ''}{delta} pt{Math.abs(delta) > 1 ? 's' : ''} vs précédente</span>}
                      </>
                    ) : (
                      <span className="badge badge--orange">En cours · {e.nb_reponses}/{e.nb_questions} réponses</span>
                    )}
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}
    </main>
  )
}
