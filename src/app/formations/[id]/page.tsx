'use client'

import { use, useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { NotesInternes } from '@/ui/NotesInternes'
import { useContexteApp } from '@/ui/CadreApplication'
import { LIBELLE_STATUT_SESSION, dateFr, horaires, periode } from '@/ui/libelles'
import { IconeCalendrier, IconeCoche, IconePersonne } from '@/ui/icones'

interface Participant { id: string, salarie_id: string, statut: string, resultat: string | null, commentaire: string | null, nom: string, prenom: string, poste: string | null }
interface Session {
  id: string, reference: string, intitule: string, domaine: string, date_debut: string, date_fin: string
  heure_debut: string | null, heure_fin: string | null, duree_heures: number | null, lieu: string | null
  formateur_nom: string | null, places_max: number | null, statut: string, commentaire: string | null
  participants: Participant[]
  emargements: { participant_id: string, jour: string, demi_journee: string, present: boolean }[]
  demande: { id: string, nb_participants: number | null, date_souhaitee: string | null, note: string | null } | null
}
interface Salarie { id: string, nom: string, prenom: string, poste: string | null }

const STATUTS_PARTICIPANT: [string, string][] = [['inscrit', 'Inscrit'], ['present', 'Présent'], ['absent', 'Absent'], ['abandon', 'Abandon']]
const RESULTATS: [string, string][] = [['', 'Non saisi'], ['apte', 'Apte'], ['inapte', 'Inapte'], ['non_evalue', 'Non évalué']]

export default function PageSession({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { peutConduire } = useContexteApp()
  const [s, setS] = useState<Session | null>(null)
  const [salaries, setSalaries] = useState<Salarie[]>([])
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ session: Session }>(`/api/formations/sessions/${id}`).then((r) => setS(r.session)).catch((e) => setErreur(messageErreur(e)))
  }, [id])
  useEffect(() => { charger() }, [charger])
  useEffect(() => {
    if (peutConduire) api<{ salaries: Salarie[] }>('/api/formations/salaries').then((r) => setSalaries(r.salaries)).catch(() => {})
  }, [peutConduire, s?.participants.length])

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

  if (!s) {
    return <main className="contenu contenu--etroit">{erreur ? <div className="alerte alerte--erreur" role="alert">{erreur}</div> : <div className="squelette" style={{ height: 120 }} aria-busy="true" />}</main>
  }
  const st = LIBELLE_STATUT_SESSION[s.statut] ?? { texte: s.statut, classe: 'badge--neutre' }
  const modifiable = peutConduire && s.statut !== 'annulee'
  const inscrits = new Set(s.participants.map((p) => p.salarie_id))

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/formations">Formations</a> / {s.reference}</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">{s.reference} · {s.domaine}</div>
          <h1>{s.intitule}</h1>
          <div className="inspection-ligne__meta" style={{ marginTop: 8 }}>
            <span><IconeCalendrier />{periode(s)}</span>
            {horaires(s) && <span>{horaires(s)}</span>}
            {s.lieu && <span>{s.lieu}</span>}
            {s.formateur_nom && <span><IconePersonne />{s.formateur_nom}</span>}
          </div>
        </div>
        <span className={`badge ${st.classe}`} style={{ fontSize: '0.82rem', padding: '5px 12px' }}>{st.texte}</span>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      {s.demande && (
        <div className="alerte alerte--info" style={{ marginBottom: 14 }}>
          Planifiée depuis la demande du client : {s.demande.nb_participants ? `${s.demande.nb_participants} participants` : 'participants non précisés'}
          {s.demande.date_souhaitee && `, souhaitée le ${dateFr(s.demande.date_souhaitee)}`}{s.demande.note && ` — ${s.demande.note}`}
        </div>
      )}

      {modifiable && <FormulaireSession s={s} enCours={enCours} onEnregistrer={(corps) => agir(() => api(`/api/formations/sessions/${id}`, { method: 'PATCH', corps }))} />}

      <section className="carte">
        <div className="carte__titre">
          <h2>Participants ({s.participants.length}{s.places_max ? `/${s.places_max}` : ''})</h2>
        </div>
        {s.participants.length === 0 && <p className="texte-discret">Aucun participant inscrit.</p>}
        <ul className="pile" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {s.participants.map((p) => (
            <li key={p.id} className="demande-formation">
              <div className="demande-formation__tete">
                <strong>{p.prenom} {p.nom}{p.poste && <span className="texte-discret"> · {p.poste}</span>}</strong>
                {modifiable && (
                  <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                    onClick={() => window.confirm(`Retirer ${p.prenom} ${p.nom} de la session ?`) && agir(() => api(`/api/formations/participants/${p.id}`, { method: 'DELETE' }))}>
                    Retirer
                  </button>
                )}
              </div>
              <div className="grille-2">
                <div className="champ">
                  <label htmlFor={`st-${p.id}`}>Présence</label>
                  <select id={`st-${p.id}`} className="saisie" value={p.statut} disabled={!modifiable || enCours}
                    onChange={(e) => agir(() => api(`/api/formations/participants/${p.id}`, { method: 'PATCH', corps: { statut: e.target.value } }))}>
                    {STATUTS_PARTICIPANT.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </div>
                <div className="champ">
                  <label htmlFor={`re-${p.id}`}>Résultat</label>
                  <select id={`re-${p.id}`} className="saisie" value={p.resultat ?? ''} disabled={!modifiable || enCours}
                    onChange={(e) => agir(() => api(`/api/formations/participants/${p.id}`, { method: 'PATCH', corps: { resultat: e.target.value || null } }))}>
                    {RESULTATS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {modifiable && <AjoutParticipant salaries={salaries.filter((x) => !inscrits.has(x.id))} enCours={enCours}
          onAjouter={(corps) => agir(() => api(`/api/formations/sessions/${id}/participants`, { method: 'POST', corps }))} />}
      </section>

      <NotesInternes objetType="session_formation" objetId={id} />

      {s.participants.length > 0 && (
        <Emargement s={s} modifiable={modifiable && !enCours}
          onCocher={(participantId, jour, demiJournee, present) => agir(() => api(`/api/formations/participants/${participantId}/emargement`, { method: 'PUT', corps: { jour, demiJournee, present } }))} />
      )}

      {s.participants.length > 0 && <Attestations sessionId={id} statut={s.statut} modifiable={modifiable} nbParticipants={s.participants.length} />}
    </main>
  )
}

interface Attestation { id: string, nom_salarie: string, prenom_salarie: string, statut: string, emise_le: string, expire_le: string | null, motif_annulation: string | null }

/** Émission en lot (apte + présence complète + session réalisée), PDF avec QR, annulation motivée. */
function Attestations({ sessionId, statut, modifiable, nbParticipants }: { sessionId: string, statut: string, modifiable: boolean, nbParticipants: number }) {
  const [liste, setListe] = useState<Attestation[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)
  const charger = useCallback(() => {
    api<{ attestations: Attestation[] }>(`/api/formations/sessions/${sessionId}/attestations`).then((r) => setListe(r.attestations)).catch((e) => setErreur(messageErreur(e)))
  }, [sessionId])
  useEffect(() => { charger() }, [charger, nbParticipants])

  async function emettre() {
    setErreur(null); setMessage(null); setEnCours(true)
    try {
      const r = await api<{ emises: number, ignores: { nom: string, motif: string }[] }>(`/api/formations/sessions/${sessionId}/attestations`, { method: 'POST' })
      setMessage(`${r.emises} attestation${r.emises > 1 ? 's' : ''} émise${r.emises > 1 ? 's' : ''}.${r.ignores.length ? ' Non émises : ' + r.ignores.map((i) => `${i.nom} (${i.motif})`).join(' ; ') + '.' : ''}`)
      charger()
    } catch (e) { setErreur(messageErreur(e)) } finally { setEnCours(false) }
  }
  async function annuler(a: Attestation) {
    if (!window.confirm(`Annuler l’attestation de ${a.prenom_salarie} ${a.nom_salarie} ?

L’attestation sera SUPPRIMÉE définitivement : elle disparaît, son QR code ne sera plus vérifiable et l’opération est irréversible.`)) return
    const motif = window.prompt('Motif d’annulation (obligatoire) :')
    if (!motif?.trim()) return
    setErreur(null)
    try { await api(`/api/formations/attestations/${a.id}`, { method: 'PATCH', corps: { motif } }); charger() } catch (e) { setErreur(messageErreur(e)) }
  }

  return (
    <section className="carte" style={{ marginTop: 20 }}>
      <div className="carte__titre"><h2>Attestations ({liste.filter((a) => a.statut === 'valide').length})</h2></div>
      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 10 }}>{erreur}</div>}
      {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 10 }}>{message}</div>}
      {liste.length === 0 && <p className="texte-discret">{statut === 'realisee' ? 'Aucune attestation émise.' : 'Passez la session au statut « Réalisée » pour émettre les attestations.'}</p>}
      <ul className="pile" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {liste.map((a) => (
          <li key={a.id} className="demande-formation">
            <div className="demande-formation__tete">
              <strong>{a.prenom_salarie} {a.nom_salarie}
                <span className="texte-discret"> · émise le {dateFr(a.emise_le)}{a.expire_le && `, échéance ${dateFr(a.expire_le)}`}</span>
              </strong>
              <span style={{ display: 'flex', gap: 12 }}>
                <a className="lien-action" href={`/api/formations/attestations/${a.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
                {modifiable && <button type="button" className="lien-action lien-action--rouge" onClick={() => void annuler(a)}>Annuler</button>}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {modifiable && statut === 'realisee' && (
        <button type="button" className="bouton" style={{ marginTop: 14 }} disabled={enCours} onClick={() => void emettre()}><IconeCoche /> Émettre les attestations</button>
      )}
    </section>
  )
}

const MAX_JOURS_EMARGEMENT = 31

function joursDe(debut: string, fin: string): string[] {
  const jours: string[] = []
  for (let d = new Date(`${debut}T00:00:00Z`); d <= new Date(`${fin}T00:00:00Z`) && jours.length < MAX_JOURS_EMARGEMENT; d.setUTCDate(d.getUTCDate() + 1)) {
    jours.push(d.toISOString().slice(0, 10))
  }
  return jours
}

/** Feuille d'émargement : une case par participant, jour et demi-journée. */
function Emargement({ s, modifiable, onCocher }: { s: Session, modifiable: boolean, onCocher: (participantId: string, jour: string, demiJournee: string, present: boolean) => Promise<boolean> }) {
  const jours = joursDe(s.date_debut, s.date_fin)
  const presents = new Set(s.emargements.filter((e) => e.present).map((e) => `${e.participant_id}|${e.jour}|${e.demi_journee}`))
  const DEMIS: [string, string][] = [['matin', 'Matin'], ['apres_midi', 'Après-midi']]

  return (
    <section className="carte" style={{ marginTop: 20 }}>
      <div className="carte__titre"><h2>Émargement</h2></div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tableau" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>Participant</th>
              {jours.map((j) => <th key={j} scope="colgroup" colSpan={2} style={{ textAlign: 'center' }}>{dateFr(j)}</th>)}
            </tr>
            <tr>{jours.flatMap((j) => DEMIS.map(([k, t]) => <th key={j + k} scope="col" style={{ textAlign: 'center', fontWeight: 500 }}>{t}</th>))}</tr>
          </thead>
          <tbody>
            {s.participants.map((p) => (
              <tr key={p.id}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>{p.prenom} {p.nom}</th>
                {jours.flatMap((j) => DEMIS.map(([k, t]) => (
                  <td key={j + k} style={{ textAlign: 'center' }}>
                    <input type="checkbox" aria-label={`${p.prenom} ${p.nom}, ${dateFr(j)}, ${t}`} disabled={!modifiable}
                      checked={presents.has(`${p.id}|${j}|${k}`)} onChange={(e) => void onCocher(p.id, j, k, e.target.checked)} />
                  </td>
                )))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {jours.length === MAX_JOURS_EMARGEMENT && <p className="texte-discret">Seuls les {MAX_JOURS_EMARGEMENT} premiers jours sont affichés.</p>}
    </section>
  )
}

function FormulaireSession({ s, enCours, onEnregistrer }: { s: Session, enCours: boolean, onEnregistrer: (corps: Record<string, unknown>) => Promise<boolean> }) {
  const initial = {
    dateDebut: s.date_debut, dateFin: s.date_fin, heureDebut: s.heure_debut ?? '', heureFin: s.heure_fin ?? '',
    dureeHeures: s.duree_heures == null ? '' : String(s.duree_heures), lieu: s.lieu ?? '', formateurNom: s.formateur_nom ?? '',
    placesMax: s.places_max == null ? '' : String(s.places_max), statut: s.statut,
  }
  const [v, setV] = useState(initial)
  const maj = (champ: keyof typeof v, valeur: string) => setV((x) => ({ ...x, [champ]: valeur }))
  const change = JSON.stringify(v) !== JSON.stringify(initial)

  return (
    <form className="carte" style={{ marginBottom: 20 }} onSubmit={(e) => { e.preventDefault(); void onEnregistrer({ ...v, dureeHeures: v.dureeHeures.replace(',', '.') }) }}>
      <div className="carte__titre"><h2>Date, horaires et durée</h2></div>
      <div className="grille-2">
        <div className="champ"><label htmlFor="e-dd">Premier jour</label>
          <input id="e-dd" type="date" className="saisie" required value={v.dateDebut} onChange={(e) => maj('dateDebut', e.target.value)} /></div>
        <div className="champ"><label htmlFor="e-df">Dernier jour</label>
          <input id="e-df" type="date" className="saisie" required min={v.dateDebut} value={v.dateFin} onChange={(e) => maj('dateFin', e.target.value)} /></div>
      </div>
      <div className="grille-3" style={{ marginTop: 14 }}>
        <div className="champ"><label htmlFor="e-hd">Heure de début</label>
          <input id="e-hd" type="time" className="saisie" value={v.heureDebut} onChange={(e) => maj('heureDebut', e.target.value)} /></div>
        <div className="champ"><label htmlFor="e-hf">Heure de fin</label>
          <input id="e-hf" type="time" className="saisie" min={v.heureDebut || undefined} disabled={!v.heureDebut} value={v.heureFin} onChange={(e) => maj('heureFin', e.target.value)} /></div>
        <div className="champ"><label htmlFor="e-du">Durée totale (heures)</label>
          <input id="e-du" className="saisie" inputMode="decimal" required value={v.dureeHeures} onChange={(e) => maj('dureeHeures', e.target.value)} /></div>
      </div>
      <div className="grille-3" style={{ marginTop: 14 }}>
        <div className="champ"><label htmlFor="e-li">Lieu</label>
          <input id="e-li" className="saisie" maxLength={200} value={v.lieu} onChange={(e) => maj('lieu', e.target.value)} /></div>
        <div className="champ"><label htmlFor="e-fo">Formateur</label>
          <input id="e-fo" className="saisie" maxLength={200} value={v.formateurNom} onChange={(e) => maj('formateurNom', e.target.value)} /></div>
        <div className="champ"><label htmlFor="e-pl">Places</label>
          <input id="e-pl" type="number" min={1} max={1000} className="saisie" value={v.placesMax} onChange={(e) => maj('placesMax', e.target.value)} /></div>
      </div>
      <div className="champ" style={{ marginTop: 14, maxWidth: 260 }}>
        <label htmlFor="e-st">Statut</label>
        <select id="e-st" className="saisie" value={v.statut} onChange={(e) => maj('statut', e.target.value)}>
          {Object.entries(LIBELLE_STATUT_SESSION).map(([k, x]) => <option key={k} value={k}>{x.texte}</option>)}
        </select>
      </div>
      {change && <button type="submit" className="bouton bouton--petit" style={{ marginTop: 14 }} disabled={enCours}><IconeCoche /> Enregistrer</button>}
    </form>
  )
}

/** « Prénom ; Nom ; Poste » par ligne (point-virgule ou tabulation : un copier-coller de tableur passe tel quel). */
function lireLignes(texte: string): { lignes: { prenom: string, nom: string, poste: string }[], invalides: number[] } {
  const lignes: { prenom: string, nom: string, poste: string }[] = []
  const invalides: number[] = []
  texte.split(/\r?\n/).forEach((brut, i) => {
    if (!brut.trim()) return
    const [prenom = '', nom = '', poste = ''] = brut.split(/[;\t]/).map((x) => x.trim())
    if (prenom && nom) lignes.push({ prenom, nom, poste })
    else invalides.push(i + 1)
  })
  return { lignes, invalides }
}

function AjoutParticipant({ salaries, enCours, onAjouter }: { salaries: Salarie[], enCours: boolean, onAjouter: (corps: Record<string, unknown>) => Promise<boolean> }) {
  const [choisis, setChoisis] = useState<string[]>([])
  const [liste, setListe] = useState('')
  const { lignes, invalides } = lireLignes(liste)
  const total = choisis.length + lignes.length

  async function inscrire(e: React.FormEvent) {
    e.preventDefault()
    if (await onAjouter({ salarieIds: choisis, nouveauxSalaries: lignes })) { setChoisis([]); setListe('') }
  }

  return (
    <form onSubmit={inscrire} style={{ marginTop: 18, borderTop: '1px solid var(--ink-100)', paddingTop: 14 }}>
      <h3 style={{ fontSize: '0.95rem', margin: '0 0 10px' }}>Inscrire des participants</h3>

      {salaries.length > 0 && (
        <fieldset className="fieldset-nu" style={{ marginBottom: 14 }}>
          <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 6 }}>
            Salariés déjà connus ({choisis.length} choisi{choisis.length > 1 ? 's' : ''})
          </legend>
          <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
            <button type="button" className="lien-action" onClick={() => setChoisis(salaries.map((x) => x.id))}>Tout cocher</button>
            <button type="button" className="lien-action" onClick={() => setChoisis([])}>Tout décocher</button>
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 2 }}>
            {salaries.map((x) => (
              <label key={x.id} className="case">
                <input type="checkbox" checked={choisis.includes(x.id)}
                  onChange={(e) => setChoisis(e.target.checked ? [...choisis, x.id] : choisis.filter((i) => i !== x.id))} />
                {x.prenom} {x.nom}{x.poste ? ' · ' + x.poste : ''}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="champ">
        <label htmlFor="lot">Nouveaux salariés <span className="aide">(un par ligne : Prénom ; Nom ; Poste)</span></label>
        <textarea id="lot" className="saisie" rows={5} placeholder={'Afi ; Dossou ; Soudeuse\nKoffi ; Agbodjan ; Magasinier'} value={liste} onChange={(e) => setListe(e.target.value)} />
        <span className="aide">
          {lignes.length} nouveau{lignes.length > 1 ? 'x' : ''} salarié{lignes.length > 1 ? 's' : ''} reconnu{lignes.length > 1 ? 's' : ''}
          {invalides.length > 0 && <strong style={{ color: 'var(--qhse-red, #ffb4ad)' }}> · ligne{invalides.length > 1 ? 's' : ''} {invalides.join(', ')} à corriger (prénom et nom requis)</strong>}
        </span>
      </div>

      <button type="submit" className="bouton" style={{ marginTop: 12 }} disabled={enCours || total === 0 || invalides.length > 0}>
        <IconeCoche /> Inscrire {total > 0 ? total + ' participant' + (total > 1 ? 's' : '') : ''}
      </button>
    </form>
  )
}
