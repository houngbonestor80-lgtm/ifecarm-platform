'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeCoche } from '@/ui/icones'

interface FicheCatalogue { id: string, slug: string, intitule: string, domaine: string, duree_jours: string | null, duree_libelle: string | null, validite_mois: number | null }
interface Demande { id: string, formation_slug: string, nb_participants: number | null, date_souhaitee: string | null, note: string | null, session_id: string | null, formation_id: string | null, intitule: string | null, intitule_libre: string | null }

const sansAccent = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Planification d'une session. La durée est décidée ici par le consultant
 * (la durée du catalogue n'est qu'indicative). Une demande de formation du
 * client peut être liée : elle préremplit participants et date, puis passe
 * « planifiée ».
 */
export default function PageNouvelleSession() {
  const { peutConduire, entreprise } = useContexteApp()
  const [catalogue, setCatalogue] = useState<FicheCatalogue[]>([])
  const [demandes, setDemandes] = useState<Demande[]>([])
  const [formation, setFormation] = useState<FicheCatalogue | null>(null)
  const [demandeId, setDemandeId] = useState('')
  // Formation hors catalogue, écrite par le consultant.
  const [surMesure, setSurMesure] = useState<{ intitule: string, domaine: string, validiteMois: string } | null>(null)
  const [q, setQ] = useState('')
  const [v, setV] = useState({ dateDebut: '', dateFin: '', heureDebut: '', heureFin: '', dureeHeures: '', lieu: '', formateurNom: '', placesMax: '', commentaire: '' })
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)
  const maj = (champ: keyof typeof v, valeur: string) => setV((x) => ({ ...x, [champ]: valeur }))

  useEffect(() => {
    Promise.all([
      api<{ formations: FicheCatalogue[] }>('/api/formations/catalogue'),
      api<{ demandes: Demande[] }>('/api/formations/demandes').catch(() => ({ demandes: [] as Demande[] })),
    ]).then(([c, d]) => {
      setCatalogue(c.formations)
      const libres = d.demandes.filter((x) => !x.session_id && (x.formation_id || x.intitule_libre))
      setDemandes(libres)
      const voulue = new URLSearchParams(window.location.search).get('demande')
      const dem = libres.find((x) => x.id === voulue)
      if (dem) choisirDemande(dem, c.formations)
    }).catch((e) => setErreur(messageErreur(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function choisirDemande(d: Demande | undefined, fiches = catalogue) {
    setDemandeId(d?.id ?? '')
    if (!d) return
    setFormation(fiches.find((f) => f.id === d.formation_id) ?? null)
    // Demande hors catalogue : la formation sur mesure est préremplie avec l'intitulé demandé.
    if (d.intitule_libre) setSurMesure({ intitule: d.intitule_libre, domaine: '', validiteMois: '' })
    setV((x) => ({
      ...x,
      placesMax: d.nb_participants ? String(d.nb_participants) : x.placesMax,
      dateDebut: d.date_souhaitee ?? x.dateDebut,
      dateFin: d.date_souhaitee ?? x.dateFin,
      commentaire: x.commentaire || d.note || '',
    }))
  }

  const resultats = useMemo(() => {
    const mots = sansAccent(q).split(/\s+/).filter(Boolean)
    return mots.length ? catalogue.filter((f) => mots.every((m) => sansAccent(f.intitule).includes(m))).slice(0, 10) : []
  }, [q, catalogue])

  async function soumettre(e: React.FormEvent) {
    e.preventDefault()
    if (!formation && !surMesure?.intitule.trim()) return
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ id: string }>('/api/formations/sessions', {
        method: 'POST',
        corps: {
          ...v, demandeId: demandeId || undefined, dureeHeures: v.dureeHeures.replace(',', '.'),
          ...(formation ? { formationId: formation.id } : { formationSurMesure: { intitule: surMesure!.intitule.trim(), domaine: surMesure!.domaine.trim() || undefined, validiteMois: surMesure!.validiteMois || undefined } }),
        },
      })
      window.location.assign(`/formations/${r.id}`)
    } catch (err) {
      setErreur(messageErreur(err))
      setEnCours(false)
    }
  }

  if (!peutConduire) {
    return <main className="contenu contenu--etroit"><div className="alerte alerte--info">La planification est réservée aux consultants IFECARM GROUP ayant un accès en écriture.</div></main>
  }

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/formations">Formations</a> / Nouvelle session</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">{entreprise.nom}</div>
          <h1>Nouvelle session</h1>
        </div>
      </div>

      <form className="carte" onSubmit={soumettre}>
        {demandes.length > 0 && (
          <div className="champ">
            <label htmlFor="demande">Demande du client à planifier <span className="aide">(facultatif)</span></label>
            <select id="demande" className="saisie" value={demandeId} onChange={(e) => choisirDemande(demandes.find((d) => d.id === e.target.value))}>
              <option value="">Aucune : session libre</option>
              {demandes.map((d) => (
                <option key={d.id} value={d.id}>{d.intitule ?? d.intitule_libre}{d.nb_participants ? ` · ${d.nb_participants} pers.` : ''}{d.date_souhaitee ? ` · souhaitée le ${d.date_souhaitee.split('-').reverse().join('/')}` : ''}</option>
              ))}
            </select>
            <span className="aide">Participants, date et note sont repris de la demande ; la demande passe « planifiée ».</span>
          </div>
        )}

        <div className="champ" style={{ marginTop: 14 }}>
          <label htmlFor="formation">Formation</label>
          {formation ? (
            <div className="pastille" style={{ alignSelf: 'start' }}>
              <span>{formation.intitule}</span>
              {!demandeId && <button type="button" aria-label="Changer de formation" onClick={() => setFormation(null)}>×</button>}
            </div>
          ) : surMesure ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <input id="formation" className="saisie" maxLength={200} required autoFocus placeholder="Intitulé de la formation (hors catalogue)" value={surMesure.intitule} onChange={(e) => setSurMesure({ ...surMesure, intitule: e.target.value })} />
              <div className="grille-2">
                <input className="saisie" maxLength={80} aria-label="Domaine" placeholder="Domaine (facultatif) — ex. Sécurité" value={surMesure.domaine} onChange={(e) => setSurMesure({ ...surMesure, domaine: e.target.value })} />
                <input className="saisie" type="number" min={1} max={240} aria-label="Validité en mois" placeholder="Validité en mois (facultatif)" value={surMesure.validiteMois} onChange={(e) => setSurMesure({ ...surMesure, validiteMois: e.target.value })} />
              </div>
              <button type="button" className="lien-action" style={{ justifySelf: 'start' }} onClick={() => setSurMesure(null)}>Plutôt choisir dans le catalogue</button>
            </div>
          ) : (
            <>
              <input id="formation" className="saisie" placeholder="Rechercher dans le catalogue (SST, CACES, incendie…)" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
              {resultats.length > 0 && (
                <ul className="resultats-formations">
                  {resultats.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => { setFormation(f); setQ('') }}>
                        <span>{f.intitule}</span>
                        <span className="texte-discret">{f.domaine}{f.duree_libelle ? ` · indicatif : ${f.duree_libelle}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!demandeId && (
                <button type="button" className="lien-action" style={{ justifySelf: 'start', marginTop: 8 }} onClick={() => setSurMesure({ intitule: q.trim(), domaine: '', validiteMois: '' })}>
                  Ma formation n’est pas dans le catalogue : l’écrire moi-même
                </button>
              )}
            </>
          )}
          {formation?.duree_libelle && <span className="aide">Durée indicative du catalogue : {formation.duree_libelle}. La durée réelle se décide ci-dessous.</span>}
        </div>

        <div className="grille-2" style={{ marginTop: 14 }}>
          <div className="champ">
            <label htmlFor="dd">Premier jour</label>
            <input id="dd" type="date" className="saisie" required value={v.dateDebut} onChange={(e) => { maj('dateDebut', e.target.value); if (!v.dateFin || v.dateFin < e.target.value) maj('dateFin', e.target.value) }} />
          </div>
          <div className="champ">
            <label htmlFor="df">Dernier jour</label>
            <input id="df" type="date" className="saisie" required min={v.dateDebut || undefined} value={v.dateFin} onChange={(e) => maj('dateFin', e.target.value)} />
          </div>
        </div>
        <div className="grille-3" style={{ marginTop: 14 }}>
          <div className="champ">
            <label htmlFor="hd">Heure de début <span className="aide">(chaque jour)</span></label>
            <input id="hd" type="time" className="saisie" value={v.heureDebut} onChange={(e) => maj('heureDebut', e.target.value)} />
          </div>
          <div className="champ">
            <label htmlFor="hf">Heure de fin</label>
            <input id="hf" type="time" className="saisie" min={v.heureDebut || undefined} disabled={!v.heureDebut} value={v.heureFin} onChange={(e) => maj('heureFin', e.target.value)} />
          </div>
          <div className="champ">
            <label htmlFor="duree">Durée totale (heures)</label>
            <input id="duree" className="saisie" inputMode="decimal" required placeholder="Ex. 14" value={v.dureeHeures} onChange={(e) => maj('dureeHeures', e.target.value)} />
          </div>
        </div>
        <div className="grille-2" style={{ marginTop: 14 }}>
          <div className="champ">
            <label htmlFor="lieu">Lieu <span className="aide">(facultatif)</span></label>
            <input id="lieu" className="saisie" maxLength={200} value={v.lieu} onChange={(e) => maj('lieu', e.target.value)} />
          </div>
          <div className="champ">
            <label htmlFor="formateur">Formateur <span className="aide">(facultatif)</span></label>
            <input id="formateur" className="saisie" maxLength={200} value={v.formateurNom} onChange={(e) => maj('formateurNom', e.target.value)} />
          </div>
          <div className="champ">
            <label htmlFor="places">Places <span className="aide">(facultatif)</span></label>
            <input id="places" type="number" min={1} max={1000} className="saisie" value={v.placesMax} onChange={(e) => maj('placesMax', e.target.value)} />
          </div>
        </div>
        <div className="champ" style={{ marginTop: 14 }}>
          <label htmlFor="commentaire">Commentaire <span className="aide">(facultatif)</span></label>
          <textarea id="commentaire" className="saisie" rows={2} maxLength={2000} value={v.commentaire} onChange={(e) => maj('commentaire', e.target.value)} />
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 14 }}>{erreur}</div>}
        <button type="submit" className="bouton" style={{ marginTop: 18 }} disabled={enCours || (!formation && !surMesure?.intitule.trim())}><IconeCoche /> {enCours ? 'Création…' : 'Créer la session'}</button>
      </form>
    </main>
  )
}
