'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconeCroix, IconePlus, IconeSortie } from '@/ui/icones'

interface Ligne { id: string, code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, actif: boolean, nb_questions: number, nb_evaluations: number }
interface Question { id: string, texte: string, aide: string, poids: number, recommandation: string }
interface Theme { code: string, libelle: string, questions: Question[] }
interface Echelle { code: string, libelle: string, coefficient: number }
interface Niveau { seuilMax: number, libelle: string, message: string }
interface Formulaire {
  id: string | null, code: string, titre: string, description: string, duree: number, avertissement: string
  echelle: Echelle[], niveaux: Niveau[], themes: Theme[]
}

const alea = () => Math.random().toString(16).slice(2, 6)
const slug = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
const nouvelleQuestion = (): Question => ({ id: `q${alea()}${alea()}`, texte: '', aide: '', poids: 2, recommandation: '' })
const nouveauTheme = (): Theme => ({ code: `t${alea()}${alea()}`, libelle: '', questions: [nouvelleQuestion()] })

const MODELE: Formulaire = {
  id: null, code: '', titre: '', description: '', duree: 10,
  avertissement: 'Diagnostic indicatif. Il ne remplace ni un audit de conformité ni un audit de certification.',
  echelle: [
    { code: 'oui', libelle: 'Oui, en place et documenté', coefficient: 1 },
    { code: 'partiel', libelle: 'Partiellement, ou de façon informelle', coefficient: 0.5 },
    { code: 'non', libelle: 'Non', coefficient: 0 },
    { code: 'ne-sais-pas', libelle: 'Je ne sais pas', coefficient: 0 },
  ],
  niveaux: [
    { seuilMax: 39, libelle: 'Démarrage', message: 'Le système reste à construire : l’essentiel est d’établir une base solide.' },
    { seuilMax: 59, libelle: 'En construction', message: 'Des éléments existent, mais dispersés : il faut les structurer et combler les manques prioritaires.' },
    { seuilMax: 79, libelle: 'Structuré', message: 'L’organisation dispose de bases sérieuses : il reste à traiter les écarts identifiés.' },
    { seuilMax: 100, libelle: 'Avancé', message: 'Le système est mature : un audit blanc confirmerait l’état de préparation.' },
  ],
  themes: [nouveauTheme()],
}

/** Déplace l'élément `i` d'une liste de `delta` rang(s) (haut / bas). */
function deplacer<T>(liste: T[], i: number, delta: number): T[] {
  const j = i + delta
  if (j < 0 || j >= liste.length) return liste
  const copie = [...liste]
  ;[copie[i], copie[j]] = [copie[j]!, copie[i]!]
  return copie
}

/**
 * Référentiels d'autodiagnostic (administrateur) : questionnaires proposés aux consultants. Modifier un référentiel ne change
 * jamais une évaluation déjà commencée ou terminée (son questionnaire est une copie figée).
 */
export default function PageCatalogueAutodiagnostic() {
  const [liste, setListe] = useState<Ligne[] | null>(null)
  const [f, setF] = useState<Formulaire | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ referentiels: Ligne[] }>('/api/administration/autodiagnostic').then((r) => setListe(r.referentiels)).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/vue-ensemble')
      setErreur(messageErreur(e))
    })
  }, [])
  useEffect(() => { charger() }, [charger])

  async function agir(fn: () => Promise<unknown>, ok: string) {
    setErreur(null)
    setMessage(null)
    setEnCours(true)
    try { await fn(); setMessage(ok); charger(); return true } catch (e) { setErreur(messageErreur(e)); return false } finally { setEnCours(false) }
  }

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  async function ouvrir(id: string, copie = false) {
    setErreur(null)
    try {
      const { referentiel: r } = await api<{ referentiel: { id: string, code: string, titre: string, description: string, duree_estimee_minutes: number, avertissement: string, definition: { echelleReponses: Echelle[], niveaux: { seuilMin: number, seuilMax: number, libelle: string, message: string }[], themes: { code: string, libelle: string, questions: { id: string, texte: string, aide?: string | null, poids: number, recommandation: string }[] }[] } } }>(`/api/administration/autodiagnostic/${id}`)
      setF({
        id: copie ? null : r.id, code: copie ? `${r.code}-copie` : r.code, titre: copie ? `${r.titre} (copie)` : r.titre, description: r.description,
        duree: r.duree_estimee_minutes, avertissement: r.avertissement, echelle: r.definition.echelleReponses,
        niveaux: r.definition.niveaux.map((n) => ({ seuilMax: n.seuilMax, libelle: n.libelle, message: n.message })),
        themes: r.definition.themes.map((t) => ({ code: t.code, libelle: t.libelle, questions: t.questions.map((q) => ({ id: q.id, texte: q.texte, aide: q.aide ?? '', poids: q.poids, recommandation: q.recommandation })) })),
      })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) { setErreur(messageErreur(e)) }
  }

  function definition(form: Formulaire) {
    let precedent = -1
    return {
      echelleReponses: form.echelle.map((e) => ({ code: e.code || slug(e.libelle) || `r${alea()}`, libelle: e.libelle.trim(), coefficient: Number(e.coefficient) })),
      niveaux: form.niveaux.map((n, i) => {
        const seuilMax = i === form.niveaux.length - 1 ? 100 : Number(n.seuilMax)
        const niveau = { seuilMin: precedent + 1, seuilMax, libelle: n.libelle.trim(), message: n.message.trim() }
        precedent = seuilMax
        return niveau
      }),
      themes: form.themes.map((t) => ({
        code: t.code || `t${alea()}`, libelle: t.libelle.trim(),
        questions: t.questions.map((q) => ({ id: q.id, texte: q.texte.trim(), aide: q.aide.trim() || null, poids: Number(q.poids), recommandation: q.recommandation.trim() })),
      })),
    }
  }

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault()
    if (!f) return
    const corps = { titre: f.titre.trim(), description: f.description.trim(), dureeEstimeeMinutes: f.duree, avertissement: f.avertissement.trim(), definition: definition(f) }
    const ok = await agir(
      () => (f.id ? api(`/api/administration/autodiagnostic/${f.id}`, { method: 'PATCH', corps }) : api('/api/administration/autodiagnostic', { method: 'POST', corps: { ...corps, code: f.code.trim() } })),
      f.id ? 'Référentiel enregistré.' : 'Référentiel créé.',
    )
    if (ok) setF(null)
  }

  const maj = (patch: Partial<Formulaire>) => setF((x) => (x ? { ...x, ...patch } : x))
  const majTheme = (i: number, patch: Partial<Theme>) => f && maj({ themes: f.themes.map((t, k) => (k === i ? { ...t, ...patch } : t)) })
  const majQuestion = (i: number, j: number, patch: Partial<Question>) => f && majTheme(i, { questions: f.themes[i]!.questions.map((q, k) => (k === j ? { ...q, ...patch } : q)) })

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte"><span className="marque__nom">IFECARM GROUP</span><span className="marque__sous">Plateforme QHSE</span></span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/administration"><span className="libelle">Administration</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter}><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu contenu--etroit">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Administration</div>
            <h1>Référentiels d’autodiagnostic</h1>
            <p className="tete-page__desc">
              Questionnaires proposés aux consultants. Chaque évaluation garde une copie figée de son questionnaire : modifier un référentiel
              n’affecte jamais les évaluations existantes.
            </p>
          </div>
          {!f && <button type="button" className="bouton" onClick={() => setF({ ...MODELE, themes: [nouveauTheme()] })}><IconePlus /> Nouveau référentiel</button>}
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> {message}</div>}

        {f && (
          <form className="carte" style={{ marginBottom: 18 }} onSubmit={enregistrer}>
            <div className="carte__titre"><h2>{f.id ? 'Modifier le référentiel' : 'Nouveau référentiel'}</h2></div>
            <div className="grille-2">
              <div className="champ">
                <label htmlFor="r-titre">Titre</label>
                <input id="r-titre" className="saisie" required maxLength={200} value={f.titre} onChange={(e) => maj({ titre: e.target.value })} />
              </div>
              <div className="champ">
                <label htmlFor="r-code">Code {f.id && <span className="aide">(ne change pas)</span>}</label>
                <input id="r-code" className="saisie" required disabled={Boolean(f.id)} maxLength={60} pattern="[a-z0-9][a-z0-9\-]{1,59}" placeholder="ex. iso-9001-interne" value={f.code} onChange={(e) => maj({ code: e.target.value })} />
              </div>
            </div>
            <div className="champ" style={{ marginTop: 12 }}>
              <label htmlFor="r-desc">Description</label>
              <textarea id="r-desc" className="saisie" rows={2} required maxLength={1000} value={f.description} onChange={(e) => maj({ description: e.target.value })} />
            </div>
            <div className="grille-2" style={{ marginTop: 12 }}>
              <div className="champ">
                <label htmlFor="r-duree">Durée estimée (minutes)</label>
                <input id="r-duree" type="number" min={1} max={240} className="saisie" required value={f.duree} onChange={(e) => maj({ duree: Number(e.target.value) })} />
              </div>
              <div className="champ">
                <label htmlFor="r-avert">Avertissement affiché avec le résultat</label>
                <input id="r-avert" className="saisie" required maxLength={1000} value={f.avertissement} onChange={(e) => maj({ avertissement: e.target.value })} />
              </div>
            </div>

            <h3 style={{ margin: '20px 0 8px' }}>Échelle de réponses</h3>
            <p className="texte-discret" style={{ margin: '0 0 8px' }}>Le coefficient (0 à 1) pondère le poids de la question. Une réponse doit valoir 1 (conformité complète).</p>
            <div style={{ display: 'grid', gap: 8 }}>
              {f.echelle.map((e, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="saisie" style={{ flex: 1, minWidth: 220 }} required maxLength={200} aria-label={`Réponse ${i + 1}`} value={e.libelle}
                    onChange={(ev) => maj({ echelle: f.echelle.map((x, k) => (k === i ? { ...x, libelle: ev.target.value, code: x.code || slug(ev.target.value) } : x)) })} />
                  <input className="saisie" style={{ width: 90 }} type="number" min={0} max={1} step={0.25} required aria-label={`Coefficient de la réponse ${i + 1}`} value={e.coefficient}
                    onChange={(ev) => maj({ echelle: f.echelle.map((x, k) => (k === i ? { ...x, coefficient: Number(ev.target.value) } : x)) })} />
                  <button type="button" className="lien-action" aria-label={`Retirer la réponse ${i + 1}`} disabled={f.echelle.length <= 2} onClick={() => maj({ echelle: f.echelle.filter((_, k) => k !== i) })}><IconeCroix /></button>
                </div>
              ))}
            </div>
            <button type="button" className="bouton bouton--secondaire bouton--petit" style={{ marginTop: 8 }} onClick={() => maj({ echelle: [...f.echelle, { code: '', libelle: '', coefficient: 0 }] })}><IconePlus /> Ajouter une réponse</button>

            <h3 style={{ margin: '20px 0 8px' }}>Niveaux de maturité</h3>
            <p className="texte-discret" style={{ margin: '0 0 8px' }}>Du plus bas au plus haut, de 0 à 100 %. Indiquez jusqu’où va chaque niveau ; le dernier va jusqu’à 100 %.</p>
            <div style={{ display: 'grid', gap: 10 }}>
              {f.niveaux.map((n, i) => (
                <div key={i} className="carte" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="saisie" style={{ flex: 1, minWidth: 180 }} required maxLength={80} aria-label={`Libellé du niveau ${i + 1}`} value={n.libelle}
                      onChange={(ev) => maj({ niveaux: f.niveaux.map((x, k) => (k === i ? { ...x, libelle: ev.target.value } : x)) })} />
                    <span>jusqu’à</span>
                    <input className="saisie" style={{ width: 80 }} type="number" min={0} max={100} required disabled={i === f.niveaux.length - 1} aria-label={`Fin du niveau ${i + 1} (%)`}
                      value={i === f.niveaux.length - 1 ? 100 : n.seuilMax} onChange={(ev) => maj({ niveaux: f.niveaux.map((x, k) => (k === i ? { ...x, seuilMax: Number(ev.target.value) } : x)) })} />
                    <span>%</span>
                    <button type="button" className="lien-action" aria-label={`Retirer le niveau ${i + 1}`} disabled={f.niveaux.length <= 1} onClick={() => maj({ niveaux: f.niveaux.filter((_, k) => k !== i) })}><IconeCroix /></button>
                  </div>
                  <textarea className="saisie" style={{ marginTop: 8 }} rows={2} required maxLength={600} aria-label={`Message du niveau ${i + 1}`} placeholder="Message affiché au client pour ce niveau" value={n.message}
                    onChange={(ev) => maj({ niveaux: f.niveaux.map((x, k) => (k === i ? { ...x, message: ev.target.value } : x)) })} />
                </div>
              ))}
            </div>
            <button type="button" className="bouton bouton--secondaire bouton--petit" style={{ marginTop: 8 }}
              onClick={() => maj({ niveaux: [...f.niveaux.slice(0, -1), { ...f.niveaux[f.niveaux.length - 1]!, seuilMax: Math.min(99, (f.niveaux[f.niveaux.length - 2]?.seuilMax ?? 0) + 20) }, { seuilMax: 100, libelle: '', message: '' }] })}>
              <IconePlus /> Ajouter un niveau
            </button>

            <h3 style={{ margin: '20px 0 8px' }}>Thèmes et questions</h3>
            <div style={{ display: 'grid', gap: 14 }}>
              {f.themes.map((t, i) => (
                <fieldset key={t.code} className="carte" style={{ padding: 14 }}>
                  <legend className="visually-hidden">Thème {i + 1}</legend>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="saisie" style={{ flex: 1, minWidth: 220, fontWeight: 700 }} required maxLength={120} aria-label={`Libellé du thème ${i + 1}`} placeholder="Libellé du thème" value={t.libelle} onChange={(ev) => majTheme(i, { libelle: ev.target.value })} />
                    <button type="button" className="lien-action" aria-label="Monter le thème" disabled={i === 0} onClick={() => maj({ themes: deplacer(f.themes, i, -1) })}>↑</button>
                    <button type="button" className="lien-action" aria-label="Descendre le thème" disabled={i === f.themes.length - 1} onClick={() => maj({ themes: deplacer(f.themes, i, 1) })}>↓</button>
                    <button type="button" className="lien-action lien-action--rouge" disabled={f.themes.length <= 1} onClick={() => window.confirm('Supprimer ce thème et ses questions ?') && maj({ themes: f.themes.filter((_, k) => k !== i) })}>Supprimer le thème</button>
                  </div>
                  <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
                    {t.questions.map((q, j) => (
                      <li key={q.id} style={{ borderTop: '1px solid var(--ink-100)', paddingTop: 10, display: 'grid', gap: 8 }}>
                        <textarea className="saisie" rows={2} required maxLength={500} aria-label={`Question ${j + 1} du thème ${i + 1}`} placeholder="Question posée" value={q.texte} onChange={(ev) => majQuestion(i, j, { texte: ev.target.value })} />
                        <input className="saisie" maxLength={500} aria-label="Aide (facultatif)" placeholder="Aide pour la poser, exemples (facultatif)" value={q.aide} onChange={(ev) => majQuestion(i, j, { aide: ev.target.value })} />
                        <textarea className="saisie" rows={2} required maxLength={500} aria-label="Recommandation" placeholder="Recommandation si la réponse n’est pas pleinement conforme" value={q.recommandation} onChange={(ev) => majQuestion(i, j, { recommandation: ev.target.value })} />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <label htmlFor={`poids-${i}-${j}`}>Poids</label>
                          <select id={`poids-${i}-${j}`} className="saisie" style={{ width: 80 }} value={q.poids} onChange={(ev) => majQuestion(i, j, { poids: Number(ev.target.value) })}>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <span className="texte-discret">1 = secondaire · 3 = majeur</span>
                          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                            <button type="button" className="lien-action" aria-label="Monter la question" disabled={j === 0} onClick={() => majTheme(i, { questions: deplacer(t.questions, j, -1) })}>↑</button>
                            <button type="button" className="lien-action" aria-label="Descendre la question" disabled={j === t.questions.length - 1} onClick={() => majTheme(i, { questions: deplacer(t.questions, j, 1) })}>↓</button>
                            <button type="button" className="lien-action lien-action--rouge" disabled={t.questions.length <= 1} onClick={() => majTheme(i, { questions: t.questions.filter((_, k) => k !== j) })}>Retirer</button>
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <button type="button" className="bouton bouton--secondaire bouton--petit" style={{ marginTop: 10 }} onClick={() => majTheme(i, { questions: [...t.questions, nouvelleQuestion()] })}><IconePlus /> Ajouter une question</button>
                </fieldset>
              ))}
            </div>
            <button type="button" className="bouton bouton--secondaire" style={{ marginTop: 10 }} onClick={() => maj({ themes: [...f.themes, nouveauTheme()] })}><IconePlus /> Ajouter un thème</button>

            <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
              <button type="submit" className="bouton" disabled={enCours}><IconeCoche /> {enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
              <button type="button" className="bouton bouton--discret" onClick={() => setF(null)}>Annuler</button>
            </div>
          </form>
        )}

        {!liste && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}
        {liste && (
          <div className="inspections">
            {liste.map((r) => (
              <div key={r.id} className="inspection-ligne">
                <div>
                  <div className="inspection-ligne__titre">{r.titre}</div>
                  <div className="inspection-ligne__meta"><span>{r.code}</span><span>{r.nb_questions} questions</span><span>{r.duree_estimee_minutes} min</span><span>{r.nb_evaluations} évaluation{r.nb_evaluations > 1 ? 's' : ''}</span></div>
                  <div className="inspection-ligne__badges">{r.actif ? <span className="badge badge--vert">Proposé</span> : <span className="badge badge--neutre">Désactivé</span>}</div>
                </div>
                <div className="equipement-actions">
                  <button type="button" className="lien-action" onClick={() => ouvrir(r.id)}>Modifier</button>
                  <button type="button" className="lien-action" onClick={() => ouvrir(r.id, true)}>Dupliquer</button>
                  <button type="button" className="lien-action" disabled={enCours} onClick={() => agir(() => api(`/api/administration/autodiagnostic/${r.id}`, { method: 'PATCH', corps: { actif: !r.actif } }), r.actif ? 'Référentiel désactivé.' : 'Référentiel réactivé.')}>{r.actif ? 'Désactiver' : 'Réactiver'}</button>
                  {r.nb_evaluations === 0 && (
                    <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                      onClick={() => window.confirm(`Supprimer définitivement « ${r.titre} » ?`) && agir(() => api(`/api/administration/autodiagnostic/${r.id}`, { method: 'DELETE' }), 'Référentiel supprimé.')}>Supprimer</button>
                  )}
                </div>
              </div>
            ))}
            {liste.length === 0 && <p className="texte-discret">Aucun référentiel. Créez-en un, ou importez les 5 référentiels ISO du site avec « npm run import:autodiagnostic ».</p>}
          </div>
        )}
      </main>
    </>
  )
}
