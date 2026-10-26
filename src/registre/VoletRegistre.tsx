'use client'

import { useEffect, useState } from 'react'
import { api } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeAlerte, IconeListe } from '@/ui/icones'
import { classeCriticite, dateCourteFr, LIBELLE_GRAVITE_NIVEAU, LIBELLE_STATUT_DECLARATION, LIBELLE_TYPE_DECLARATION } from '@/ui/libelles'

interface Resume {
  ouvertes: number, a_qualifier: number, par_gravite: number[], actions_ouvertes: number, actions_en_retard: number
  a_traiter: { id: string, reference: string, type: string, statut: string, criticite: number | null, survenu_le: string, lieu: string | null }[]
}

/**
 * Volet « Registre de sécurité » du tableau de bord. Réservé aux responsables du client et à l'équipe IFECARM : la
 * route répond 403 aux autres (qui ne voient qu'une partie des déclarations), et le volet disparaît alors sans bruit.
 */
export function VoletRegistre() {
  const { incidents } = useContexteApp()
  const [r, setR] = useState<Resume | null>(null)

  useEffect(() => {
    if (incidents) api<Resume>('/api/registre/resume').then(setR).catch(() => setR(null))
  }, [incidents])

  if (!incidents || !r) return null
  const totalGravite = r.par_gravite.reduce((a, b) => a + b, 0)

  return (
    <section aria-labelledby="titre-registre" style={{ marginBottom: 20 }}>
      <div className="carte__titre" style={{ marginBottom: 10 }}>
        <h2 id="titre-registre">Registre de sécurité</h2>
        <a className="lien-action" href="/registre"><IconeListe /> Ouvrir le registre</a>
      </div>
      <div className="tuiles" aria-label="Indicateurs du registre de sécurité">
        <div className={`tuile ${r.ouvertes ? 'tuile--orange' : 'tuile--vert'}`}>
          <div className="tuile__valeur">{r.ouvertes}</div>
          <div className="tuile__libelle">Déclaration{r.ouvertes > 1 ? 's' : ''} en cours</div>
        </div>
        <div className={`tuile ${r.a_qualifier ? 'tuile--rouge' : 'tuile--vert'}`}>
          <div className="tuile__valeur">{r.a_qualifier}</div>
          <div className="tuile__libelle">À qualifier</div>
        </div>
        <div className={`tuile ${r.actions_en_retard ? 'tuile--rouge' : 'tuile--vert'}`}>
          <div className="tuile__valeur">{r.actions_en_retard}<span className="tuile__sur"> / {r.actions_ouvertes}</span></div>
          <div className="tuile__libelle">Actions en retard / ouvertes</div>
        </div>
      </div>

      <div className="grille-tableau">
        <div className="carte">
          <div className="carte__titre"><h3 style={{ fontSize: '0.95rem' }}>Gravité des déclarations qualifiées en cours</h3></div>
          {totalGravite === 0 ? <p className="texte-discret">Aucune déclaration qualifiée en cours.</p> : (
            <div style={{ display: 'grid', gap: 10 }}>
              {r.par_gravite.map((n, k) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 28px', alignItems: 'center', gap: 10 }}>
                  <span className="texte-discret">{k + 1} · {LIBELLE_GRAVITE_NIVEAU[k + 1]}</span>
                  <div className="evolution__piste" style={{ height: 14, maxWidth: 'none', borderRadius: 7, display: 'block' }} aria-hidden="true">
                    <div style={{ width: `${(n / totalGravite) * 100}%`, height: '100%', borderRadius: 7, background: k >= 2 ? 'var(--qhse-red)' : k === 1 ? 'var(--qhse-orange, #e39c2a)' : 'var(--brand-600)' }} />
                  </div>
                  <strong>{n}</strong>
                </div>
              ))}
              {r.a_qualifier > 0 && <p className="texte-discret">{r.a_qualifier} déclaration{r.a_qualifier > 1 ? 's' : ''} pas encore qualifiée{r.a_qualifier > 1 ? 's' : ''} (gravité à évaluer).</p>}
            </div>
          )}
        </div>

        <div className="carte">
          <div className="carte__titre"><h3 style={{ fontSize: '0.95rem' }}>À traiter en priorité</h3></div>
          {r.a_traiter.length === 0 && <p className="texte-discret">Rien en attente.</p>}
          <div className="actions" style={{ marginTop: 0 }}>
            {r.a_traiter.map((d) => (
              <a key={d.id} className="action action--lien" href={`/registre/${d.id}`}>
                <div>
                  <div className="action__libelle">{d.reference} · {LIBELLE_TYPE_DECLARATION[d.type]?.texte ?? d.type}</div>
                  <div className="action__meta">
                    <span>{dateCourteFr(d.survenu_le)}</span>
                    {d.lieu && <span>{d.lieu}</span>}
                    <span>{LIBELLE_STATUT_DECLARATION[d.statut]?.texte}</span>
                    {d.statut === 'a_qualifier' && <span className="retard"><IconeAlerte />À qualifier</span>}
                  </div>
                </div>
                <span className={`badge ${classeCriticite(d.criticite)}`}>{d.criticite == null ? 'Non évaluée' : `Criticité ${d.criticite}`}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
