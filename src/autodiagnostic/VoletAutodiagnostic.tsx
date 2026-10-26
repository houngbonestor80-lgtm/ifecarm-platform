'use client'

import { useEffect, useState } from 'react'
import { api } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeListe } from '@/ui/icones'
import { dateCourteFr } from '@/ui/libelles'
import { classeScore, couleurBarre } from './classes'

interface Dernier { id: string, referentiel_code: string, referentiel_titre: string, score_global: number, niveau_libelle: string, realise_le: string, score_precedent: number | null }

/**
 * Volet « Autodiagnostic » du tableau de bord : dernier résultat par référentiel, avec l'évolution depuis l'évaluation précédente.
 * Réservé aux responsables du client et à l'équipe (la route répond 403 aux autres : le volet disparaît alors sans bruit).
 */
export function VoletAutodiagnostic() {
  const { autodiagnostic } = useContexteApp()
  const [derniers, setDerniers] = useState<Dernier[] | null>(null)

  useEffect(() => {
    if (autodiagnostic) api<{ derniers: Dernier[] }>('/api/autodiagnostic/resume').then((r) => setDerniers(r.derniers)).catch(() => setDerniers(null))
  }, [autodiagnostic])

  if (!autodiagnostic || !derniers || derniers.length === 0) return null

  return (
    <section aria-labelledby="titre-autodiagnostic" style={{ marginBottom: 20 }}>
      <div className="carte__titre" style={{ marginBottom: 10 }}>
        <h2 id="titre-autodiagnostic">Autodiagnostic</h2>
        <a className="lien-action" href="/autodiagnostic"><IconeListe /> Toutes les évaluations</a>
      </div>
      <div className="carte">
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 14 }}>
          {derniers.map((d) => {
            const delta = d.score_precedent === null ? null : d.score_global - d.score_precedent
            return (
              <li key={d.id}>
                <a href={`/autodiagnostic/${d.id}`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                    <strong>{d.referentiel_titre}</strong>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className={`badge ${classeScore(d.score_global)}`}>{d.score_global} % · {d.niveau_libelle}</span>
                      {delta !== null && <span className={`badge ${delta >= 0 ? 'badge--vert' : 'badge--rouge'}`}>{delta > 0 ? '+' : ''}{delta} pt</span>}
                    </span>
                  </div>
                  <div className="progression__barre" role="img" aria-label={`${d.referentiel_titre} : ${d.score_global} %`}>
                    <div className="progression__remplissage" style={{ width: `${d.score_global}%`, background: couleurBarre(d.score_global) }} />
                  </div>
                  <div className="texte-discret" style={{ marginTop: 4 }}>Évaluation du {dateCourteFr(d.realise_le)}</div>
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
