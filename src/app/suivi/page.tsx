'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { ficheDe } from '@/formations/catalogue'
import ChoixFormations, { type DemandeSaisie } from '@/ui/ChoixFormations'
import { IconeCoche, IconePersonne } from '@/ui/icones'

interface Note { id: string, auteur_id: string | null, auteur_nom: string, contenu: string, cree_le: string }

const SERVICES: [string, string][] = [['inspection', 'Inspection'], ['formation', 'Formation'], ['audit', 'Audit'], ['conseil', 'Conseil']]

const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Carnet de suivi interne de l'entreprise active : ce que le consultant et
 * l'administrateur observent (relances, intérêt, réactivité…). Jamais visible
 * du client ni du prospect.
 */
export default function PageSuivi() {
  const { entreprise, consultant, peutConduire } = useContexteApp()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [texte, setTexte] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ notes: Note[] }>('/api/suivi').then((r) => setNotes(r.notes)).catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(() => { if (consultant) charger() }, [charger, consultant])
  const [services, setServices] = useState<string[] | null>(null)
  const [planification, setPlanification] = useState<{ id: string, slug: string, intitule: string | null, session_id: string | null, session_reference: string | null }[]>([])
  const [peutPlanifier, setPeutPlanifier] = useState(false)
  const [demandes, setDemandes] = useState<DemandeSaisie[]>([])
  const [souhaitsEnregistres, setSouhaitsEnregistres] = useState(false)
  const [serviceAutre, setServiceAutre] = useState('')

  const chargerSouhaits = useCallback(() => {
    api<{ services: string[], serviceAutre: string | null, formationsActif: boolean, demandes: { id: string, session_id: string | null, session_reference: string | null, slug: string, intitule: string | null, nb_participants: number | null, date_souhaitee: string | null, note: string | null }[] }>('/api/suivi/souhaits')
      .then((r) => {
        setServices(r.services)
        setServiceAutre(r.serviceAutre ?? '')
        setPeutPlanifier(r.formationsActif)
        setPlanification(r.demandes)
        setDemandes(r.demandes.map((d) => ({ slug: d.slug, intitule: d.intitule, nb_participants: d.nb_participants == null ? '' : String(d.nb_participants), date_souhaitee: d.date_souhaitee ?? '', note: d.note ?? '' })))
      })
      .catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(() => { if (consultant) chargerSouhaits() }, [chargerSouhaits, consultant])

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

  async function ajouter(ev: React.FormEvent) {
    ev.preventDefault()
    if (await agir(() => api('/api/suivi', { method: 'POST', corps: { contenu: texte } }))) setTexte('')
  }

  if (!consultant) {
    return <main className="contenu contenu--etroit"><div className="alerte alerte--info">Le suivi est réservé à l’équipe IFECARM GROUP.</div></main>
  }

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Suivi interne</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">Notez comment cette entreprise se comporte : relances, intérêts, réactivité. <strong>Ces notes ne sont jamais visibles du client.</strong></p>
        </div>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      {services && (
        <form className="carte" style={{ marginBottom: 20 }} onSubmit={async (ev) => {
          ev.preventDefault()
          setSouhaitsEnregistres(false)
          if (await agir(() => api('/api/suivi/souhaits', { method: 'PUT', corps: { services, serviceAutre, formations: services.includes('formation') ? demandes : [] } }))) {
            setSouhaitsEnregistres(true)
            chargerSouhaits()
          }
        }}>
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Ce que l’entreprise souhaite</h2>
          <fieldset className="fieldset-nu">
            <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Services</legend>
            <div className="modules-cases">
              {SERVICES.map(([code, libelle]) => (
                <label key={code} className="case">
                  <input type="checkbox" checked={services.includes(code)} disabled={!peutConduire}
                    onChange={(e) => setServices(e.target.checked ? [...services, code] : services.filter((x) => x !== code))} />
                  {libelle}
                </label>
              ))}
            </div>
            <div className="champ" style={{ marginTop: 10 }}>
              <label htmlFor="service-autre">Autre service souhaité <span className="aide">(facultatif, à écrire)</span></label>
              <input id="service-autre" className="saisie" maxLength={300} disabled={!peutConduire} placeholder="Ex. Étude de dangers, accompagnement ISO 45001…" value={serviceAutre} onChange={(ev) => setServiceAutre(ev.target.value)} />
            </div>
          </fieldset>
          {services.includes('formation') && (peutConduire
            ? <ChoixFormations valeur={demandes} onChange={setDemandes} />
            : <p className="texte-discret">{demandes.length} formation{demandes.length > 1 ? 's' : ''} demandée{demandes.length > 1 ? 's' : ''} (lecture seule).</p>)}
          {planification.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <span className="label">Planification</span>
              <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gap: 6 }}>
                {planification.map((d) => (
                  <li key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{ficheDe(d.slug)?.titre ?? d.intitule ?? d.slug}</span>
                    {d.session_id
                      ? <a className="badge badge--vert" href={`/formations/${d.session_id}`}>Planifiée · {d.session_reference}</a>
                      : peutPlanifier && peutConduire
                        ? <a className="bouton bouton--secondaire bouton--petit" href={`/formations/nouvelle?demande=${d.id}`}>Planifier une session</a>
                        : <span className="badge badge--neutre">À planifier{peutPlanifier ? '' : ' (après conversion en client)'}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {peutConduire && (
            <button type="submit" className="bouton" disabled={enCours} style={{ marginTop: 14 }}><IconeCoche /> Enregistrer les souhaits</button>
          )}
          {souhaitsEnregistres && <span className="aide" role="status" style={{ marginLeft: 12 }}>Enregistré.</span>}
        </form>
      )}

      {peutConduire ? (
        <form className="carte" onSubmit={ajouter} style={{ marginBottom: 20 }}>
          <div className="champ">
            <label htmlFor="note">Nouvelle note</label>
            <textarea id="note" className="saisie" required maxLength={2000} placeholder="Ex. Relancé par téléphone, intéressé par la formation SST pour 12 personnes en novembre."
              value={texte} onChange={(e) => setTexte(e.target.value)} />
          </div>
          <button type="submit" className="bouton" disabled={enCours || !texte.trim()} style={{ marginTop: 14 }}><IconeCoche /> Enregistrer la note</button>
        </form>
      ) : (
        <div className="alerte alerte--info" style={{ marginBottom: 14 }}>Accès en lecture seule : vous ne pouvez pas ajouter de note pour cette entreprise.</div>
      )}

      {!notes && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
      {notes?.length === 0 && <p className="texte-discret">Aucune note pour l’instant.</p>}
      <div className="pile">
        {notes?.map((n) => (
          <article key={n.id} className="carte note-suivi">
            <div className="note-suivi__tete">
              <span><IconePersonne /> {n.auteur_nom}</span>
              <time dateTime={n.cree_le}>{quand(n.cree_le)}</time>
            </div>
            <p className="note-suivi__texte">{n.contenu}</p>
            {peutConduire && (
              <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                onClick={() => window.confirm('Supprimer cette note ?') && agir(() => api(`/api/suivi/${n.id}`, { method: 'DELETE' }))}>
                Supprimer
              </button>
            )}
          </article>
        ))}
      </div>
    </main>
  )
}
