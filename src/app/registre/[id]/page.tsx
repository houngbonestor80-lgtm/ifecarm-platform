'use client'

import { use, useCallback, useEffect, useState } from 'react'
import { api, envoyerFormulaire, messageErreur } from '@/ui/api'
import { reduireImage } from '@/ui/image'
import ChoixPhoto from '@/ui/ChoixPhoto'
import { NotesInternes } from '@/ui/NotesInternes'
import { IconeCoche, IconeCommentaire, IconeCroix, IconePlus } from '@/ui/icones'
import {
  classeCriticite, dateCourteFr, dateHeureFr, LIBELLE_FREQUENCE_NIVEAU, LIBELLE_GRAVITE_NIVEAU, LIBELLE_STATUT_DECLARATION,
  LIBELLE_TYPE_DECLARATION, NATURES_ACTION_ORDONNEES,
} from '@/ui/libelles'

interface Action {
  id: string, reference: string, libelle: string, description: string | null, nature: string | null, statut: string
  responsable_nom: string | null, echeance: string | null, en_retard: boolean, realisee_le: string | null
  efficace: boolean | null, commentaire_verification: string | null, motif_abandon: string | null, derniere_relance: string | null
}
interface Etape { ordre?: number, question?: string, reponse?: string, id?: string, texte?: string, parentIds?: string[] }
interface Declaration {
  id: string, reference: string, type: string, statut: string, survenu_le: string, lieu: string | null, service: string | null
  description: string, anonyme: boolean, site_nom: string | null, victime_nom: string | null, victime_externe: string | null
  arret_travail: boolean | null, jours_arret: number | null, gravite: number | null, frequence: number | null, criticite: number | null
  qualifie_le: string | null, motif_sans_suite: string | null, saisi_hors_ligne: boolean, declarant_nom: string | null
  historique: { id: string, statut_avant: string | null, statut_apres: string, commentaire: string | null, cree_le: string, auteur: string | null }[]
  analyse: { methode: string, etapes: Etape[], causes_profondes: string[] | null, realisee_le: string | null } | null
  actions: Action[]
  pieces: { id: string, fichier_id: string, legende: string | null }[]
}
interface Droits { equipe: boolean, responsable: boolean, responsableSite?: boolean }

/** Transitions autorisées par la base (déclencheur proteger_declaration, 0035) — l'écran ne propose que celles-là. */
const SUIVANTS: Record<string, [string, string][]> = {
  a_qualifier: [['en_analyse', 'Passer en analyse'], ['en_action', 'Passer directement aux actions'], ['sans_suite', 'Classer sans suite']],
  en_analyse: [['en_action', 'Passer aux actions'], ['cloturee', 'Clôturer'], ['sans_suite', 'Classer sans suite']],
  en_action: [['en_analyse', 'Revenir en analyse'], ['cloturee', 'Clôturer']],
}
const LIBELLE_ACTION: Record<string, string> = { a_faire: 'À faire', en_cours: 'En cours', realisee: 'Réalisée', verifiee: 'Vérifiée', abandonnee: 'Abandonnée' }
const NATURE_LIBELLE = Object.fromEntries(NATURES_ACTION_ORDONNEES)

export default function PageDeclaration({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [d, setD] = useState<Declaration | null>(null)
  const [droits, setDroits] = useState<Droits>({ equipe: false, responsable: false })
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ declaration: Declaration }>(`/api/registre/declarations/${id}`).then((r) => setD(r.declaration)).catch((e) => setErreur(messageErreur(e)))
  }, [id])
  useEffect(() => { charger() }, [charger])
  useEffect(() => { api<Droits>('/api/registre/contexte').then(setDroits).catch(() => {}) }, [])

  async function agir(fn: () => Promise<unknown>): Promise<boolean> {
    setErreur(null); setEnCours(true)
    try { await fn(); charger(); return true } catch (e) { setErreur(messageErreur(e)); return false } finally { setEnCours(false) }
  }

  if (!d) {
    return <main className="contenu contenu--etroit">{erreur ? <div className="alerte alerte--erreur" role="alert">{erreur}</div> : <div className="squelette" style={{ height: 120 }} aria-busy="true" />}</main>
  }
  const t = LIBELLE_TYPE_DECLARATION[d.type] ?? { texte: d.type, aide: '', classe: 'badge--neutre' }
  const st = LIBELLE_STATUT_DECLARATION[d.statut] ?? { texte: d.statut, classe: 'badge--neutre' }
  const final = d.statut === 'cloturee' || d.statut === 'sans_suite'
  const peutTraiter = droits.equipe && !final
  // Les données décident : un responsable de site reçoit analyse et actions de son site (0040), pas l'historique.
  const voitSuivi = droits.equipe || droits.responsable || d.analyse !== null || d.actions.length > 0

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/registre">Incidents</a> / {d.reference}</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">{d.reference}{d.saisi_hors_ligne && ' · saisie hors ligne'}</div>
          <h1>{t.texte}</h1>
          <div className="inspection-ligne__meta" style={{ marginTop: 8 }}>
            <span>{dateHeureFr(d.survenu_le)}</span>
            {d.site_nom && <span>{d.site_nom}</span>}
            {d.lieu && <span>{d.lieu}</span>}
            {d.service && <span>Service : {d.service}</span>}
            <span>{d.anonyme ? 'Déclaration anonyme' : d.declarant_nom ? `Déclarée par ${d.declarant_nom}` : ''}</span>
          </div>
        </div>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className={`badge ${st.classe}`}>{st.texte}</span>
          {d.criticite != null && <span className={`badge ${classeCriticite(d.criticite)}`}>Criticité {d.criticite}</span>}
        </span>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      <section className="carte">
        <div className="carte__titre"><h2>Faits</h2></div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{d.description}</p>
        {(d.victime_nom || d.victime_externe || d.arret_travail) && (
          <p className="texte-discret" style={{ marginTop: 10 }}>
            {[d.victime_nom && `Victime : ${d.victime_nom}`, d.victime_externe && `Victime : ${d.victime_externe}`, d.arret_travail && `Arrêt de travail${d.jours_arret != null ? ` : ${d.jours_arret} jour${d.jours_arret > 1 ? 's' : ''}` : ''}`].filter(Boolean).join(' · ')}
          </p>
        )}
        <Pieces d={d} droits={droits} agir={agir} enCours={enCours} />
        {droits.equipe && d.statut === 'a_qualifier' && <CorrectionFaits d={d} agir={agir} enCours={enCours} />}
        {d.statut !== 'a_qualifier' && droits.equipe && !final && <p className="texte-discret" style={{ marginTop: 10 }}>Les faits sont figés depuis la qualification : ajoutez un commentaire pour toute précision.</p>}
      </section>

      {droits.equipe && !final && <Qualification d={d} agir={agir} enCours={enCours} />}
      {d.statut === 'sans_suite' && <div className="alerte alerte--info" style={{ marginTop: 16 }}>Classée sans suite : {d.motif_sans_suite}</div>}
      {final && d.criticite != null && <p className="texte-discret" style={{ marginTop: 12 }}>Qualifiée le {dateHeureFr(d.qualifie_le)} : gravité {LIBELLE_GRAVITE_NIVEAU[d.gravite ?? 0]}, fréquence {LIBELLE_FREQUENCE_NIVEAU[d.frequence ?? 0]}.</p>}

      <NotesInternes objetType="declaration" objetId={d.id} />

      {voitSuivi && (
        <>
          <Analyse d={d} modifiable={peutTraiter} agir={agir} enCours={enCours} />
          <Actions d={d} modifiable={peutTraiter} lectureEquipe={droits.equipe} agir={agir} enCours={enCours} />
          {(droits.equipe || d.historique.length > 0) && <Historique d={d} peutCommenter={droits.equipe} agir={agir} enCours={enCours} />}
        </>
      )}
    </main>
  )
}

type Agir = (fn: () => Promise<unknown>) => Promise<boolean>

function Pieces({ d, droits, agir, enCours }: { d: Declaration, droits: Droits, agir: Agir, enCours: boolean }) {
  if (!d.pieces.length && !droits.equipe) return null
  async function ajouter(fichiers: FileList | null) {
    if (!fichiers?.length) return
    await agir(async () => {
      for (const f of Array.from(fichiers)) {
        const form = new FormData()
        form.append('photo', await reduireImage(f), f.name.replace(/\.\w+$/, '') + '.jpg')
        await envoyerFormulaire(`/api/registre/declarations/${d.id}/pieces`, form)
      }
    })
  }
  return (
    <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {d.pieces.map((p, i) => (
        <div key={p.id} style={{ position: 'relative' }}>
          <a href={`/api/registre/pieces/${p.fichier_id}`} target="_blank" rel="noreferrer">
            <img src={`/api/registre/pieces/${p.fichier_id}`} alt={p.legende ?? `Photo ${i + 1}`} loading="lazy" style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--ink-100)' }} />
          </a>
          {droits.equipe && (
            <button type="button" className="lien-action lien-action--rouge" aria-label={`Supprimer la photo ${i + 1}`} disabled={enCours}
              style={{ position: 'absolute', top: -6, right: -6, background: 'var(--surface)', borderRadius: 999, padding: 2 }}
              onClick={() => window.confirm('Supprimer cette photo ?') && agir(() => api(`/api/registre/pieces/${p.fichier_id}`, { method: 'DELETE' }))}><IconeCroix /></button>
          )}
        </div>
      ))}
      {droits.equipe && (
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignSelf: 'center' }}><ChoixPhoto desactive={enCours} onFichiers={(f) => void ajouter(f)} /></span>
      )}
    </div>
  )
}

function CorrectionFaits({ d, agir, enCours }: { d: Declaration, agir: Agir, enCours: boolean }) {
  const [ouvert, setOuvert] = useState(false)
  const [v, setV] = useState({ type: d.type, lieu: d.lieu ?? '', service: d.service ?? '', description: d.description })
  if (!ouvert) return <button type="button" className="lien-action" style={{ marginTop: 12 }} onClick={() => setOuvert(true)}>Corriger les faits</button>
  return (
    <form style={{ marginTop: 14, borderTop: '1px solid var(--ink-100)', paddingTop: 14 }} onSubmit={(e) => { e.preventDefault(); void agir(() => api(`/api/registre/declarations/${d.id}`, { method: 'PATCH', corps: v })).then((ok) => ok && setOuvert(false)) }}>
      <div className="grille-3">
        <div className="champ"><label htmlFor="c-type">Type</label>
          <select id="c-type" className="saisie" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>
            {Object.entries(LIBELLE_TYPE_DECLARATION).map(([k, x]) => <option key={k} value={k}>{x.texte}</option>)}
          </select></div>
        <div className="champ"><label htmlFor="c-lieu">Lieu</label><input id="c-lieu" className="saisie" value={v.lieu} onChange={(e) => setV({ ...v, lieu: e.target.value })} /></div>
        <div className="champ"><label htmlFor="c-serv">Service</label><input id="c-serv" className="saisie" value={v.service} onChange={(e) => setV({ ...v, service: e.target.value })} /></div>
      </div>
      <div className="champ" style={{ marginTop: 14 }}><label htmlFor="c-desc">Description</label><textarea id="c-desc" className="saisie" rows={4} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button type="submit" className="bouton bouton--petit" disabled={enCours}><IconeCoche /> Enregistrer</button>
        <button type="button" className="bouton bouton--petit bouton--discret" onClick={() => setOuvert(false)}>Annuler</button>
      </div>
    </form>
  )
}

function Qualification({ d, agir, enCours }: { d: Declaration, agir: Agir, enCours: boolean }) {
  const [gravite, setGravite] = useState(String(d.gravite ?? ''))
  const [frequence, setFrequence] = useState(String(d.frequence ?? ''))
  const [suite, setSuite] = useState('')
  const [motif, setMotif] = useState('')
  const criticite = gravite && frequence ? Number(gravite) * Number(frequence) : null
  const suivants = SUIVANTS[d.statut] ?? []

  function enregistrer(e: React.FormEvent) {
    e.preventDefault()
    void agir(() => api(`/api/registre/declarations/${d.id}`, {
      method: 'PATCH',
      corps: {
        gravite: gravite ? Number(gravite) : null, frequence: frequence ? Number(frequence) : null,
        ...(suite ? { statut: suite } : {}), ...(suite === 'sans_suite' ? { motifSansSuite: motif } : {}),
      },
    })).then((ok) => ok && setSuite(''))
  }

  return (
    <form className="carte" style={{ marginTop: 16 }} onSubmit={enregistrer}>
      <div className="carte__titre">
        <h2>Qualification</h2>
        {criticite != null && <span className={`badge ${classeCriticite(criticite)}`}>Criticité {criticite} / 16</span>}
      </div>
      <div className="grille-2">
        <div className="champ"><label htmlFor="q-grav">Gravité</label>
          <select id="q-grav" className="saisie" value={gravite} onChange={(e) => setGravite(e.target.value)}>
            <option value="">À évaluer</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} — {LIBELLE_GRAVITE_NIVEAU[n]}</option>)}
          </select></div>
        <div className="champ"><label htmlFor="q-freq">Fréquence</label>
          <select id="q-freq" className="saisie" value={frequence} onChange={(e) => setFrequence(e.target.value)}>
            <option value="">À évaluer</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} — {LIBELLE_FREQUENCE_NIVEAU[n]}</option>)}
          </select></div>
      </div>
      <div className="champ" style={{ marginTop: 14, maxWidth: 360 }}>
        <label htmlFor="q-suite">Étape suivante</label>
        <select id="q-suite" className="saisie" value={suite} onChange={(e) => setSuite(e.target.value)}>
          <option value="">Garder « {LIBELLE_STATUT_DECLARATION[d.statut]?.texte} »</option>
          {suivants.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        {suite && suite !== 'sans_suite' && !criticite && <span className="aide">Gravité et fréquence sont requises pour qualifier.</span>}
      </div>
      {suite === 'sans_suite' && (
        <div className="champ" style={{ marginTop: 14 }}><label htmlFor="q-motif">Motif (obligatoire)</label><textarea id="q-motif" className="saisie" rows={2} required value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
      )}
      {suite === 'cloturee' && <p className="texte-discret" style={{ marginTop: 10 }}>La clôture est définitive et impossible tant qu’une action reste ouverte.</p>}
      <button type="submit" className="bouton bouton--petit" style={{ marginTop: 14 }} disabled={enCours}><IconeCoche /> Enregistrer</button>
    </form>
  )
}

function Analyse({ d, modifiable, agir, enCours }: { d: Declaration, modifiable: boolean, agir: Agir, enCours: boolean }) {
  const [methode, setMethode] = useState(d.analyse?.methode ?? 'cinq_pourquoi')
  const [etapes, setEtapes] = useState<Etape[]>(() => d.analyse?.etapes?.length ? d.analyse.etapes : [{ question: 'Pourquoi cela s’est-il produit ?', reponse: '' }])
  const [causes, setCauses] = useState((d.analyse?.causes_profondes ?? []).join('\n'))
  if (!d.analyse && !modifiable) return null

  const maj = (i: number, patch: Partial<Etape>) => setEtapes((l) => l.map((e, k) => (k === i ? { ...e, ...patch } : e)))
  const changerMethode = (m: string) => {
    setMethode(m)
    setEtapes(m === 'cinq_pourquoi' ? [{ question: 'Pourquoi cela s’est-il produit ?', reponse: '' }] : m === 'arbre_des_causes' ? [{ id: 'A', texte: '', parentIds: [] }] : [{ texte: '' }])
  }
  const enregistrer = () => agir(() => api(`/api/registre/declarations/${d.id}/analyse`, {
    method: 'PUT', corps: { methode, etapes: etapes.filter((e) => (e.reponse ?? e.texte ?? '').trim()), causesProfondes: causes.split('\n').map((c) => c.trim()).filter(Boolean) },
  }))

  return (
    <section className="carte" style={{ marginTop: 16 }}>
      <div className="carte__titre"><h2>Analyse des causes</h2></div>
      {!modifiable ? (
        <>
          <p className="texte-discret">Méthode : {{ cinq_pourquoi: '5 pourquoi', arbre_des_causes: 'Arbre des causes', libre: 'Saisie libre' }[d.analyse!.methode]}</p>
          <ol style={{ paddingLeft: 20, display: 'grid', gap: 6, marginTop: 8 }}>
            {d.analyse!.etapes.map((e, i) => <li key={i}>{e.question ? <><em>{e.question}</em> {e.reponse}</> : e.texte}</li>)}
          </ol>
          {d.analyse!.causes_profondes?.length ? <p style={{ marginTop: 10 }}><strong>Causes profondes :</strong> {d.analyse!.causes_profondes.join(' ; ')}</p> : null}
        </>
      ) : (
        <>
          <div className="onglets" role="group" aria-label="Méthode d’analyse" style={{ marginBottom: 14 }}>
            {[['cinq_pourquoi', '5 pourquoi'], ['arbre_des_causes', 'Arbre des causes'], ['libre', 'Libre']].map(([v, t]) => (
              <button key={v} type="button" aria-pressed={methode === v} onClick={() => methode !== v && (!etapes.some((e) => (e.reponse ?? e.texte ?? '').trim()) || window.confirm('Changer de méthode efface les étapes saisies. Continuer ?')) && changerMethode(v!)}>{t}</button>
            ))}
          </div>
          <div className="pile">
            {etapes.map((e, i) => (
              <div key={i} className="demande-formation">
                {methode === 'cinq_pourquoi' && (
                  <>
                    <div className="champ"><label htmlFor={`e-q-${i}`}>Question {i + 1}</label><input id={`e-q-${i}`} className="saisie" value={e.question ?? ''} onChange={(ev) => maj(i, { question: ev.target.value })} /></div>
                    <div className="champ" style={{ marginTop: 10 }}><label htmlFor={`e-r-${i}`}>Réponse</label><textarea id={`e-r-${i}`} className="saisie" rows={2} value={e.reponse ?? ''} onChange={(ev) => maj(i, { reponse: ev.target.value })} /></div>
                  </>
                )}
                {methode === 'arbre_des_causes' && (
                  <div className="grille-2">
                    <div className="champ"><label htmlFor={`e-t-${i}`}>Fait ou cause « {e.id} »</label><textarea id={`e-t-${i}`} className="saisie" rows={2} value={e.texte ?? ''} onChange={(ev) => maj(i, { texte: ev.target.value })} /></div>
                    <div className="champ"><label htmlFor={`e-p-${i}`}>Conséquence de</label>
                      <select id={`e-p-${i}`} className="saisie" multiple value={e.parentIds ?? []} onChange={(ev) => maj(i, { parentIds: Array.from(ev.target.selectedOptions).map((o) => o.value) })}>
                        {etapes.filter((_, k) => k !== i).map((x) => <option key={x.id} value={x.id}>{x.id} — {(x.texte ?? '').slice(0, 40)}</option>)}
                      </select></div>
                  </div>
                )}
                {methode === 'libre' && <div className="champ"><label htmlFor={`e-l-${i}`}>Étape {i + 1}</label><textarea id={`e-l-${i}`} className="saisie" rows={2} value={e.texte ?? ''} onChange={(ev) => maj(i, { texte: ev.target.value })} /></div>}
                {etapes.length > 1 && <button type="button" className="lien-action lien-action--rouge" style={{ marginTop: 8 }} onClick={() => setEtapes((l) => l.filter((_, k) => k !== i))}>Retirer</button>}
              </div>
            ))}
          </div>
          {etapes.length < (methode === 'cinq_pourquoi' ? 5 : 60) && (
            <button type="button" className="lien-action" style={{ marginTop: 10 }}
              onClick={() => setEtapes((l) => [...l, methode === 'cinq_pourquoi' ? { question: 'Pourquoi ?', reponse: '' } : methode === 'arbre_des_causes' ? { id: String.fromCharCode(65 + l.length), texte: '', parentIds: [] } : { texte: '' }])}><IconePlus /> Ajouter une étape</button>
          )}
          <div className="champ" style={{ marginTop: 14 }}><label htmlFor="a-causes">Causes profondes <span className="aide">(une par ligne)</span></label><textarea id="a-causes" className="saisie" rows={3} value={causes} onChange={(e) => setCauses(e.target.value)} /></div>
          <button type="button" className="bouton bouton--petit" style={{ marginTop: 14 }} disabled={enCours} onClick={() => void enregistrer()}><IconeCoche /> Enregistrer l’analyse</button>
        </>
      )}
    </section>
  )
}

function Actions({ d, modifiable, lectureEquipe, agir, enCours }: { d: Declaration, modifiable: boolean, lectureEquipe: boolean, agir: Agir, enCours: boolean }) {
  const [ouvert, setOuvert] = useState(false)
  const [v, setV] = useState({ libelle: '', nature: '', responsable: '', echeance: '', description: '' })
  const statutAction = (a: Action, corps: Record<string, unknown>) => agir(() => api(`/api/registre/actions/${a.id}`, { method: 'PATCH', corps }))

  return (
    <section className="carte" style={{ marginTop: 16 }}>
      <div className="carte__titre">
        <h2>Plan d’actions ({d.actions.length})</h2>
        {modifiable && !ouvert && <button type="button" className="bouton bouton--petit bouton--secondaire" onClick={() => setOuvert(true)}><IconePlus /> Action</button>}
      </div>
      {d.actions.length === 0 && !ouvert && <p className="texte-discret">Aucune action pour l’instant.</p>}
      <div className="pile">
        {d.actions.map((a) => (
          <div key={a.id} className="demande-formation" style={a.en_retard ? { borderColor: 'var(--qhse-red)' } : undefined}>
            <div className="demande-formation__tete">
              <strong>{a.libelle}</strong>
              <span className={`badge ${a.statut === 'verifiee' ? 'badge--vert' : a.statut === 'abandonnee' ? 'badge--neutre' : a.en_retard ? 'badge--rouge' : 'badge--bleu'}`}>{LIBELLE_ACTION[a.statut]}{a.en_retard && ' — en retard'}</span>
            </div>
            <div className="inspection-ligne__meta">
              <span>{a.reference}</span>
              {a.nature && <span>{NATURE_LIBELLE[a.nature]}</span>}
              {a.responsable_nom && <span>Responsable : {a.responsable_nom}</span>}
              {a.echeance && <span>Échéance : {dateCourteFr(a.echeance)}</span>}
              {a.derniere_relance && <span>Relancée le {dateCourteFr(a.derniere_relance)}</span>}
              {a.efficace != null && <span>{a.efficace ? 'Efficace' : 'Inefficace'}</span>}
            </div>
            {a.description && <p className="texte-discret">{a.description}</p>}
            <NotesInternes objetType="action_corrective" objetId={a.id} repli />
            {a.commentaire_verification && <p className="texte-discret">Vérification : {a.commentaire_verification}</p>}
            {a.motif_abandon && <p className="texte-discret">Abandon : {a.motif_abandon}</p>}
            {lectureEquipe && modifiable && ['a_faire', 'en_cours', 'realisee'].includes(a.statut) && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                {a.statut === 'a_faire' && <button type="button" className="lien-action" disabled={enCours} onClick={() => void statutAction(a, { statut: 'en_cours' })}>Démarrer</button>}
                {a.statut !== 'realisee' && <button type="button" className="lien-action" disabled={enCours} onClick={() => void statutAction(a, { statut: 'realisee' })}>Marquer réalisée</button>}
                {a.statut === 'realisee' && (
                  <>
                    <button type="button" className="lien-action" disabled={enCours} onClick={() => { const c = window.prompt('Commentaire de vérification (facultatif) :'); if (c !== null) void statutAction(a, { statut: 'verifiee', efficace: true, commentaire: c }) }}>Vérifiée : efficace</button>
                    <button type="button" className="lien-action lien-action--rouge" disabled={enCours} onClick={() => { const c = window.prompt('Pourquoi l’action est-elle inefficace ?'); if (c) void statutAction(a, { statut: 'verifiee', efficace: false, commentaire: c }) }}>Vérifiée : inefficace</button>
                  </>
                )}
                <button type="button" className="lien-action lien-action--rouge" disabled={enCours} onClick={() => { const m = window.prompt('Motif d’abandon :'); if (m?.trim()) void statutAction(a, { statut: 'abandonnee', motif: m }) }}>Abandonner</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {modifiable && ouvert && (
        <form style={{ marginTop: 14, borderTop: '1px solid var(--ink-100)', paddingTop: 14 }} onSubmit={(e) => { e.preventDefault(); void agir(() => api(`/api/registre/declarations/${d.id}/actions`, { method: 'POST', corps: v })).then((ok) => { if (ok) { setOuvert(false); setV({ libelle: '', nature: '', responsable: '', echeance: '', description: '' }) } }) }}>
          <div className="champ"><label htmlFor="n-lib">Action</label><input id="n-lib" className="saisie" required maxLength={300} value={v.libelle} onChange={(e) => setV({ ...v, libelle: e.target.value })} /></div>
          <div className="grille-3" style={{ marginTop: 14 }}>
            <div className="champ"><label htmlFor="n-nat">Nature <span className="aide">(de la plus efficace à la moins)</span></label>
              <select id="n-nat" className="saisie" value={v.nature} onChange={(e) => setV({ ...v, nature: e.target.value })}>
                <option value="">—</option>
                {NATURES_ACTION_ORDONNEES.map(([k, t], i) => <option key={k} value={k}>{i + 1}. {t}</option>)}
              </select></div>
            <div className="champ"><label htmlFor="n-resp">Responsable</label><input id="n-resp" className="saisie" maxLength={200} value={v.responsable} onChange={(e) => setV({ ...v, responsable: e.target.value })} /></div>
            <div className="champ"><label htmlFor="n-ech">Échéance</label><input id="n-ech" type="date" className="saisie" value={v.echeance} onChange={(e) => setV({ ...v, echeance: e.target.value })} /></div>
          </div>
          <div className="champ" style={{ marginTop: 14 }}><label htmlFor="n-desc">Détail</label><textarea id="n-desc" className="saisie" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="submit" className="bouton bouton--petit" disabled={enCours}><IconeCoche /> Ajouter</button>
            <button type="button" className="bouton bouton--petit bouton--discret" onClick={() => setOuvert(false)}>Annuler</button>
          </div>
        </form>
      )}
    </section>
  )
}

function Historique({ d, peutCommenter, agir, enCours }: { d: Declaration, peutCommenter: boolean, agir: Agir, enCours: boolean }) {
  const [texte, setTexte] = useState('')
  return (
    <section className="carte" style={{ marginTop: 16 }}>
      <div className="carte__titre"><h2>Historique</h2></div>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        {d.historique.map((h) => (
          <li key={h.id} className="texte-discret" style={{ borderLeft: '2px solid var(--brand-200)', paddingLeft: 12 }}>
            <strong style={{ color: 'var(--ink-800)' }}>
              {h.commentaire ? <><IconeCommentaire /> Commentaire</> : h.statut_avant ? `${LIBELLE_STATUT_DECLARATION[h.statut_avant]?.texte} → ${LIBELLE_STATUT_DECLARATION[h.statut_apres]?.texte}` : 'Déclaration enregistrée'}
            </strong>
            <span> · {dateHeureFr(h.cree_le)}{h.auteur && ` · ${h.auteur}`}</span>
            {h.commentaire && <div style={{ color: 'var(--ink-800)', whiteSpace: 'pre-wrap' }}>{h.commentaire}</div>}
          </li>
        ))}
      </ol>
      {peutCommenter && (
        <form style={{ marginTop: 14, display: 'grid', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void agir(() => api(`/api/registre/declarations/${d.id}/commentaires`, { method: 'POST', corps: { commentaire: texte } })).then((ok) => ok && setTexte('')) }}>
          <label className="label" htmlFor="h-com" style={{ fontWeight: 600, fontSize: '0.85rem' }}>Ajouter un commentaire</label>
          <textarea id="h-com" className="saisie" rows={2} maxLength={2000} value={texte} onChange={(e) => setTexte(e.target.value)} />
          <button type="submit" className="bouton bouton--petit bouton--secondaire" style={{ justifySelf: 'start' }} disabled={enCours || !texte.trim()}>Commenter</button>
        </form>
      )}
    </section>
  )
}
