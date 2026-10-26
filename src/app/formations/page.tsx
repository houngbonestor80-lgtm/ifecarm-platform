'use client'

import { useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { LIBELLE_STATUT_SESSION, horaires, periode } from '@/ui/libelles'
import { IconeCalendrier, IconePersonne, IconePlus } from '@/ui/icones'

interface SessionListe {
  id: string, reference: string, intitule: string, date_debut: string, date_fin: string
  heure_debut: string | null, heure_fin: string | null, duree_heures: number | null, lieu: string | null
  statut: string, places_max: number | null, participants: number, formateur_nom: string | null
}

/** Sessions de formation de l'entreprise active : les consultants les planifient, le client les consulte. */
export default function PageFormations() {
  const { peutConduire } = useContexteApp()
  const [sessions, setSessions] = useState<SessionListe[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  useEffect(() => {
    api<{ sessions: SessionListe[] }>('/api/formations/sessions').then((r) => setSessions(r.sessions)).catch((e) => setErreur(messageErreur(e)))
  }, [])

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Formations</div>
          <h1>Sessions de formation</h1>
          <p className="tete-page__desc">Planification des sessions, participants et résultats.</p>
        </div>
        {peutConduire && <a className="bouton" href="/formations/nouvelle"><IconePlus /> Nouvelle session</a>}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
      {!sessions && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
      {sessions?.length === 0 && <p className="texte-discret">Aucune session pour l’instant.</p>}
      <div className="pile">
        {sessions?.map((s) => {
          const st = LIBELLE_STATUT_SESSION[s.statut] ?? { texte: s.statut, classe: 'badge--neutre' }
          return (
            <a key={s.id} className="carte inspection-ligne" href={`/formations/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="inspection-ligne__tete">
                <strong>{s.intitule}</strong>
                <span className={`badge ${st.classe}`}>{st.texte}</span>
              </div>
              <div className="inspection-ligne__meta">
                <span>{s.reference}</span>
                <span><IconeCalendrier />{periode(s)}{horaires(s) && ` · ${horaires(s)}`}</span>
                <span><IconePersonne />{s.participants}{s.places_max ? `/${s.places_max}` : ''} participant{s.participants > 1 ? 's' : ''}</span>
                {s.lieu && <span>{s.lieu}</span>}
              </div>
            </a>
          )
        })}
      </div>
    </main>
  )
}
