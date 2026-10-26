'use client'

import { useEffect, useState } from 'react'
import { api } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeListe } from '@/ui/icones'
import { dateCourteFr } from '@/ui/libelles'

interface Resume {
  valides: number, a_renouveler: number, urgentes: number, expirees: number, suspendues: number
  a_traiter: { id: string, salarie_id: string, salarie: string, type_intitule: string, niveau: string | null, date_validite: string, jours_restants: number }[]
}

/**
 * Volet « Habilitations » du tableau de bord. Réservé aux responsables du client et à l'équipe IFECARM : la route répond
 * 403 aux autres (qui ne verraient qu'une partie des titres), et le volet disparaît alors sans bruit.
 */
export function VoletHabilitations() {
  const { habilitations } = useContexteApp()
  const [r, setR] = useState<Resume | null>(null)

  useEffect(() => {
    if (habilitations) api<Resume>('/api/habilitations/resume').then(setR).catch(() => setR(null))
  }, [habilitations])

  if (!habilitations || !r) return null

  return (
    <section aria-labelledby="titre-habilitations" style={{ marginBottom: 20 }}>
      <div className="carte__titre" style={{ marginBottom: 10 }}>
        <h2 id="titre-habilitations">Habilitations</h2>
        <a className="lien-action" href="/habilitations"><IconeListe /> Ouvrir la matrice</a>
      </div>
      <div className="tuiles" aria-label="Indicateurs des habilitations">
        <div className="tuile tuile--vert"><div className="tuile__valeur">{r.valides}</div><div className="tuile__libelle">Titre{r.valides > 1 ? 's' : ''} valide{r.valides > 1 ? 's' : ''}</div></div>
        <div className={`tuile ${r.a_renouveler ? 'tuile--orange' : 'tuile--vert'}`}>
          <div className="tuile__valeur">{r.a_renouveler}</div>
          <div className="tuile__libelle">À renouveler (90 jours){r.urgentes > 0 && ` · ${r.urgentes} sous 30 jours`}</div>
        </div>
        <div className={`tuile ${r.expirees ? 'tuile--rouge' : 'tuile--vert'}`}><div className="tuile__valeur">{r.expirees}</div><div className="tuile__libelle">Expirée{r.expirees > 1 ? 's' : ''}</div></div>
      </div>
      <div className="carte">
        <div className="carte__titre"><h3 style={{ fontSize: '0.95rem' }}>Prochaines échéances</h3></div>
        {r.a_traiter.length === 0 && <p className="texte-discret">Aucune échéance dans les 90 jours.</p>}
        <div className="actions" style={{ marginTop: 0 }}>
          {r.a_traiter.map((h) => (
            <a key={h.id} className={`action action--lien ${h.jours_restants < 0 ? 'action--retard' : ''}`} href={`/habilitations/salaries/${h.salarie_id}`}>
              <div>
                <div className="action__libelle">{h.salarie} · {h.type_intitule}{h.niveau ? ` ${h.niveau}` : ''}</div>
                <div className="action__meta">
                  {h.jours_restants < 0
                    ? <span className="retard">Expirée depuis le {dateCourteFr(h.date_validite)}</span>
                    : <span>Échéance le {dateCourteFr(h.date_validite)}</span>}
                </div>
              </div>
              <span className={`badge ${h.jours_restants < 0 ? 'badge--rouge' : h.jours_restants <= 30 ? 'badge--orange' : 'badge--neutre'}`}>
                {h.jours_restants < 0 ? 'Expirée' : h.jours_restants === 0 ? 'Aujourd’hui' : `${h.jours_restants} j`}
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
