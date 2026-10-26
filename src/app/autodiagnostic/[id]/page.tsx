'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import { classeScore, couleurBarre } from '@/autodiagnostic/classes'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeCoche, IconeCommentaire, IconeListe } from '@/ui/icones'
import { STATUTS_ACTION, dateCourteFr, dateFr } from '@/ui/libelles'

interface Reponse { code: string, libelle: string, coefficient: number }
interface Question { id: string, texte: string, aide?: string | null, poids: number, recommandation: string }
interface Theme { code: string, libelle: string, questions: Question[] }
interface Niveau { seuilMin: number, seuilMax: number, libelle: string, message: string }
interface Resultat {
  globalScore: number, niveau: Niveau, themes: { code: string, libelle: string, score: number }[]
  recommendations: { questionId: string, texte: string, poids: number, themeCode: string, themeLibelle: string }[]
}
interface ActionLiee { question_id: string, id: string, reference: string, libelle: string, statut: string, echeance: string | null, responsable_nom: string | null, en_retard: boolean }
interface Evaluation {
  id: string, reference: string, referentiel_code: string, referentiel_titre: string, avertissement: string
  definition: { echelleReponses: Reponse[], niveaux: Niveau[], themes: Theme[] }
  statut: 'en_cours' | 'terminee', reponses: Record<string, string>, commentaires: Record<string, string>, resultat: Resultat | null
  score_global: number | null, niveau_libelle: string | null, realise_le: string, terminee_le: string | null
  site_nom: string | null, interlocuteur: string | null, conduit_par_nom: string | null
  precedente: { id: string, realise_le: string, score_global: number, themes: { code: string, score: number }[] } | null
  actions: ActionLiee[]
}

/** Couleur d'une réponse selon son coefficient : pleine conformité, partielle, nulle. */
const couleurReponse = (c: number) => (c >= 1 ? 'var(--brand-600)' : c > 0 ? 'var(--qhse-orange)' : 'var(--qhse-red)')

export default function PageEvaluation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { peutConduire, entreprise } = useContexteApp()
  const [ev, setEv] = useState<Evaluation | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [commentaireOuvert, setCommentaireOuvert] = useState<string | null>(null)
  const [brouillonCommentaire, setBrouillonCommentaire] = useState('')
  const [selection, setSelection] = useState<string[]>([])
  const [action, setAction] = useState({ responsable: '', echeance: '' })
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(async () => {
    try {
      const r = await api<{ evaluation: Evaluation }>(`/api/autodiagnostic/${id}`)
      setEv(r.evaluation)
    } catch (e) {
      setErreur(messageErreur(e))
    }
  }, [id])
  useEffect(() => { void charger() }, [charger])

  const questions = useMemo(() => (ev ? ev.definition.themes.flatMap((t) => t.questions) : []), [ev])
  const modifiable = Boolean(ev && peutConduire && ev.statut === 'en_cours')
  const nbRepondues = ev ? questions.filter((q) => ev.reponses[q.id]).length : 0

  async function executer(fn: () => Promise<unknown>, ok?: string) {
    setErreur(null)
    setMessage(null)
    setEnCours(true)
    try {
      await fn()
      if (ok) setMessage(ok)
      await charger()
      return true
    } catch (e) {
      setErreur(messageErreur(e))
      await charger()
      return false
    } finally {
      setEnCours(false)
    }
  }

  async function repondre(q: Question, code: string) {
    if (!ev) return
    const nouveau = ev.reponses[q.id] === code ? null : code
    // Affichage immédiat (saisie terrain fluide), confirmé par le rechargement.
    setEv({ ...ev, reponses: nouveau ? { ...ev.reponses, [q.id]: nouveau } : Object.fromEntries(Object.entries(ev.reponses).filter(([k]) => k !== q.id)) })
    setErreur(null)
    try {
      await api(`/api/autodiagnostic/${id}/reponses`, { method: 'PATCH', corps: { reponses: { [q.id]: nouveau } } })
    } catch (e) {
      setErreur(messageErreur(e))
      await charger()
    }
  }

  if (erreur && !ev) {
    return <main className="contenu contenu--etroit"><nav className="fil-ariane"><a href="/autodiagnostic">Autodiagnostic</a></nav><div className="alerte alerte--erreur" role="alert">{erreur}</div></main>
  }
  if (!ev) return <main className="contenu"><div className="squelette" style={{ height: 240 }} aria-busy="true" /></main>

  const echelle = ev.definition.echelleReponses
  const libelleReponse = new Map(echelle.map((r) => [r.code, r]))
  const actionParQuestion = new Map(ev.actions.map((a) => [a.question_id, a]))
  const r = ev.resultat
  const nbQuestions = questions.length

  return (
    <main className="contenu">
      <nav className="fil-ariane"><a href="/autodiagnostic">Autodiagnostic</a> / {ev.reference}</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">{entreprise.nom}</div>
          <h1>{ev.referentiel_titre}</h1>
          <p className="tete-page__desc">
            {dateFr(ev.realise_le)}{ev.site_nom ? ` · ${ev.site_nom}` : ''}{ev.interlocuteur ? ` · Interlocuteur : ${ev.interlocuteur}` : ''}{ev.conduit_par_nom ? ` · Conduite par ${ev.conduit_par_nom}` : ''}
          </p>
        </div>
        {ev.statut === 'terminee' && (
          <a className="bouton bouton--secondaire" href={`/api/autodiagnostic/${id}/rapport`} target="_blank" rel="noopener"><IconeListe /> Rapport PDF</a>
        )}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> {message}</div>}

      {/* ------------------------------------------------------------------ Conduite */}
      {ev.statut === 'en_cours' && (
        <>
          <div className="alerte alerte--info" style={{ marginBottom: 14 }}>{ev.avertissement}</div>
          <div className="carte" style={{ marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 5 }}>
            <div className="progression" style={{ flex: 1, minWidth: 200 }}>
              <div className="progression__barre"><div className="progression__remplissage" style={{ width: `${nbQuestions ? (nbRepondues / nbQuestions) * 100 : 0}%` }} /></div>
              <div className="progression__texte">{nbRepondues}/{nbQuestions} questions répondues</div>
            </div>
            {modifiable && (
              <button type="button" className="bouton" disabled={enCours || nbRepondues < nbQuestions}
                onClick={() => window.confirm('Terminer l’évaluation ? Le résultat sera calculé et l’évaluation ne pourra plus être modifiée.') && executer(() => api(`/api/autodiagnostic/${id}/terminer`, { method: 'POST', corps: {} }), 'Évaluation terminée.')}>
                <IconeCoche /> Terminer l’évaluation
              </button>
            )}
          </div>
          {!peutConduire && <div className="alerte alerte--attention" style={{ marginBottom: 14 }}>Évaluation en cours, conduite par votre consultant IFECARM GROUP.</div>}

          {ev.definition.themes.map((t) => (
            <section key={t.code} className="carte" style={{ marginBottom: 14 }}>
              <div className="carte__titre"><h2>{t.libelle}</h2></div>
              <ol className="checklist" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {t.questions.map((q) => {
                  const rep = ev.reponses[q.id]
                  const com = ev.commentaires[q.id]
                  return (
                    <li key={q.id} className="point" style={{ borderLeftColor: rep ? couleurReponse(libelleReponse.get(rep)?.coefficient ?? 0) : undefined }}>
                      <div className="point__tete">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="point__libelle">{q.texte}</div>
                          {q.aide && <div className="point__aide">{q.aide}</div>}
                        </div>
                      </div>
                      <div className="point__corps">
                        <div className="verdict" role="group" aria-label={`Réponse : ${q.texte}`} style={{ gridTemplateColumns: `repeat(${Math.min(echelle.length, 4)}, 1fr)` }}>
                          {echelle.map((e) => (
                            <button key={e.code} type="button" aria-pressed={rep === e.code} disabled={!modifiable}
                              style={rep === e.code ? { background: couleurReponse(e.coefficient), borderColor: couleurReponse(e.coefficient), color: '#fff' } : undefined}
                              onClick={() => repondre(q, e.code)}>
                              <span className="libelle">{e.libelle}</span>
                            </button>
                          ))}
                        </div>
                        {com && commentaireOuvert !== q.id && <p style={{ fontSize: '0.88rem', color: 'var(--ink-600)', display: 'flex', gap: 6 }}><IconeCommentaire className="icone" /> {com}</p>}
                        {modifiable && commentaireOuvert !== q.id && (
                          <button type="button" className="lien-action" onClick={() => { setCommentaireOuvert(q.id); setBrouillonCommentaire(com ?? '') }}>
                            <IconeCommentaire />{com ? 'Modifier la remarque' : 'Ajouter une remarque'}
                          </button>
                        )}
                        {commentaireOuvert === q.id && (
                          <form style={{ display: 'grid', gap: 8 }} onSubmit={async (e) => {
                            e.preventDefault()
                            await executer(() => api(`/api/autodiagnostic/${id}/reponses`, { method: 'PATCH', corps: { commentaires: { [q.id]: brouillonCommentaire.trim() || null } } }))
                            setCommentaireOuvert(null)
                          }}>
                            <textarea className="saisie" rows={2} maxLength={1000} autoFocus value={brouillonCommentaire} aria-label="Remarque" onChange={(e) => setBrouillonCommentaire(e.target.value)} />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button type="submit" className="bouton bouton--petit" disabled={enCours}>Enregistrer</button>
                              <button type="button" className="bouton bouton--discret bouton--petit" onClick={() => setCommentaireOuvert(null)}>Annuler</button>
                            </div>
                          </form>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}

          {modifiable && (
            <div style={{ textAlign: 'right', marginTop: 8 }}>
              <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                onClick={() => window.confirm('Supprimer cette évaluation en cours ?') && executer(async () => { await api(`/api/autodiagnostic/${id}`, { method: 'DELETE' }); window.location.assign('/autodiagnostic') })}>
                Supprimer cette évaluation
              </button>
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ Résultat */}
      {ev.statut === 'terminee' && r && (
        <>
          <section className="tuiles" aria-label="Résultat">
            <div className={`tuile ${r.globalScore >= 80 ? 'tuile--vert' : r.globalScore >= 60 ? 'tuile--bleu' : r.globalScore >= 40 ? 'tuile--orange' : 'tuile--rouge'}`}>
              <div className="tuile__valeur">{r.globalScore} %</div>
              <div className="tuile__libelle">Score global</div>
            </div>
            <div className="tuile tuile--bleu"><div className="tuile__valeur" style={{ fontSize: '1.3rem' }}>{r.niveau.libelle}</div><div className="tuile__libelle">Niveau de maturité</div></div>
            <div className="tuile tuile--vert"><div className="tuile__valeur">{nbQuestions - r.recommendations.length}/{nbQuestions}</div><div className="tuile__libelle">Points pleinement conformes</div></div>
            <div className={`tuile ${r.recommendations.length ? 'tuile--orange' : 'tuile--vert'}`}><div className="tuile__valeur">{r.recommendations.length}</div><div className="tuile__libelle">Écart{r.recommendations.length > 1 ? 's' : ''} à traiter</div></div>
          </section>

          <section className="carte" style={{ marginBottom: 14 }}>
            <p style={{ margin: 0 }}>{r.niveau.message}</p>
            {ev.precedente && (
              <p style={{ margin: '10px 0 0' }}>
                <span className={`badge ${r.globalScore - ev.precedente.score_global >= 0 ? 'badge--vert' : 'badge--rouge'}`}>
                  {r.globalScore - ev.precedente.score_global > 0 ? '+' : ''}{r.globalScore - ev.precedente.score_global} pt
                </span>{' '}
                par rapport à l’évaluation du <a href={`/autodiagnostic/${ev.precedente.id}`}>{dateCourteFr(ev.precedente.realise_le)}</a> ({ev.precedente.score_global} %).
              </p>
            )}
            <p className="texte-discret" style={{ margin: '10px 0 0' }}>{ev.avertissement}</p>
          </section>

          <section className="carte" style={{ marginBottom: 14 }}>
            <div className="carte__titre"><h2>Scores par thème</h2></div>
            <div style={{ display: 'grid', gap: 12 }}>
              {r.themes.map((t) => {
                const avant = ev.precedente?.themes.find((x) => x.code === t.code)?.score
                return (
                  <div key={t.code}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                      <strong>{t.libelle}</strong>
                      <span>{t.score} %{avant !== undefined && <span className="texte-discret"> ({t.score - avant > 0 ? '+' : ''}{t.score - avant})</span>}</span>
                    </div>
                    <div className="progression__barre" role="img" aria-label={`${t.libelle} : ${t.score} %`}><div className="progression__remplissage" style={{ width: `${t.score}%`, background: couleurBarre(t.score) }} /></div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="carte" style={{ marginBottom: 14 }}>
            <div className="carte__titre"><h2>Points d’amélioration prioritaires ({r.recommendations.length})</h2></div>
            {r.recommendations.length === 0 && <p className="texte-discret">Aucun écart : toutes les réponses sont pleinement conformes.</p>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
              {r.recommendations.map((e) => {
                const q = questions.find((x) => x.id === e.questionId)
                const rep = libelleReponse.get(ev.reponses[e.questionId] ?? '')
                const liee = actionParQuestion.get(e.questionId)
                return (
                  <li key={e.questionId} className="point" style={{ borderLeftColor: couleurReponse(rep?.coefficient ?? 0) }}>
                    <div className="point__tete">
                      {peutConduire && !liee && (
                        <input type="checkbox" aria-label={`Créer une action : ${e.texte}`} checked={selection.includes(e.questionId)}
                          onChange={(c) => setSelection(c.target.checked ? [...selection, e.questionId] : selection.filter((x) => x !== e.questionId))} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="point__libelle">{e.texte}</div>
                        <div className="point__aide">{e.themeLibelle} — {q?.texte}</div>
                        {ev.commentaires[e.questionId] && <div className="point__aide">« {ev.commentaires[e.questionId]} »</div>}
                      </div>
                      <span className="badge badge--neutre">{rep?.libelle ?? 'Sans réponse'} · poids {e.poids}</span>
                    </div>
                    {liee && (
                      <div className="action__meta" style={{ marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="badge badge--vert">Action {liee.reference}</span>
                        {liee.responsable_nom && <span>{liee.responsable_nom}</span>}
                        {liee.echeance && <span className={liee.en_retard ? 'retard' : undefined}>Échéance : {dateCourteFr(liee.echeance)}{liee.en_retard ? ' — en retard' : ''}</span>}
                        {peutConduire ? (
                          <select className="select-statut" value={liee.statut} aria-label={`Statut de l’action ${liee.reference}`} disabled={enCours}
                            onChange={(c) => executer(() => api(`/api/actions/${liee.id}`, { method: 'PATCH', corps: { statut: c.target.value } }))}>
                            {STATUTS_ACTION.map((s) => <option key={s.valeur} value={s.valeur}>{s.texte}</option>)}
                          </select>
                        ) : <span className="badge badge--neutre">{STATUTS_ACTION.find((s) => s.valeur === liee.statut)?.texte ?? liee.statut}</span>}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {peutConduire && r.recommendations.some((e) => !actionParQuestion.has(e.questionId)) && (
              <form style={{ marginTop: 16, borderTop: '1px solid var(--ink-100)', paddingTop: 14 }} onSubmit={async (e) => {
                e.preventDefault()
                if (!selection.length) return setErreur('Cochez au moins un écart.')
                const ok = await executer(() => api(`/api/autodiagnostic/${id}/actions`, { method: 'POST', corps: { questionIds: selection, responsable: action.responsable || undefined, echeance: action.echeance || undefined } }), `${selection.length} action(s) créée(s).`)
                if (ok) setSelection([])
              }}>
                <h3 style={{ fontSize: '0.95rem', margin: '0 0 10px' }}>Créer un plan d’action depuis les écarts cochés ({selection.length})</h3>
                <div className="grille-2">
                  <div className="champ">
                    <label htmlFor="act-resp">Responsable <span className="aide">(facultatif)</span></label>
                    <input id="act-resp" className="saisie" maxLength={200} value={action.responsable} onChange={(e) => setAction({ ...action, responsable: e.target.value })} />
                  </div>
                  <div className="champ">
                    <label htmlFor="act-ech">Échéance <span className="aide">(facultatif)</span></label>
                    <input id="act-ech" type="date" className="saisie" value={action.echeance} onChange={(e) => setAction({ ...action, echeance: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                  <button type="submit" className="bouton" disabled={enCours || !selection.length}>Créer les actions</button>
                  <button type="button" className="bouton bouton--discret" onClick={() => setSelection(r.recommendations.filter((e) => !actionParQuestion.has(e.questionId)).map((e) => e.questionId))}>Tout cocher</button>
                  <button type="button" className="bouton bouton--discret" onClick={() => setSelection([])}>Tout décocher</button>
                </div>
              </form>
            )}
          </section>

          <section className="carte" style={{ marginBottom: 14 }}>
            <div className="carte__titre"><h2>Détail des réponses</h2></div>
            {ev.definition.themes.map((t) => (
              <details key={t.code} style={{ marginBottom: 8 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 700 }}>{t.libelle}</summary>
                <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
                  {t.questions.map((q) => {
                    const rep = libelleReponse.get(ev.reponses[q.id] ?? '')
                    return (
                      <li key={q.id} style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap', borderBottom: '1px solid var(--ink-100)', paddingBottom: 8 }}>
                        <span style={{ flex: 1, minWidth: 220 }}>{q.texte}{ev.commentaires[q.id] && <em className="texte-discret" style={{ display: 'block' }}>« {ev.commentaires[q.id]} »</em>}</span>
                        <span className={`badge ${classeScore((rep?.coefficient ?? 0) * 100)}`}>{rep?.libelle ?? 'Sans réponse'}</span>
                      </li>
                    )
                  })}
                </ul>
              </details>
            ))}
          </section>

          {peutConduire && (
            <div style={{ textAlign: 'right' }}>
              <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                onClick={() => window.confirm('Supprimer définitivement cette évaluation terminée ? Réservé à l’administrateur ; impossible si des actions en dépendent.')
                  && executer(async () => { await api(`/api/autodiagnostic/${id}`, { method: 'DELETE' }); window.location.assign('/autodiagnostic') })}>
                Supprimer l’évaluation (administrateur)
              </button>
            </div>
          )}
        </>
      )}
    </main>
  )
}
