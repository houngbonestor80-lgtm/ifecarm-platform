'use client'

import { useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeHorloge, IconeListe, IconePersonne } from '@/ui/icones'
import { LIBELLE_GRAVITE, STATUTS_ACTION, dateCourteFr } from '@/ui/libelles'
import { VoletRegistre } from '@/registre/VoletRegistre'
import { VoletHabilitations } from '@/habilitations/VoletHabilitations'
import { VoletAutodiagnostic } from '@/autodiagnostic/VoletAutodiagnostic'

interface Tableau {
  indicateurs: {
    inspectionsEnCours: number
    inspectionsTerminees90j: number
    tauxConformite90j: number | null
    ncOuvertes: { critique: number, majeure: number, mineure: number }
    actionsOuvertes: number
    actionsEnRetard: number
    tauxTraitementDelais: number | null
  }
  actions: {
    id: string, libelle: string, responsable_nom: string | null, echeance: string | null, statut: string,
    en_retard: boolean, gravite: string | null, inspection_id: string | null, intitule_modele: string | null, declaration_id: string | null, autodiagnostic_id: string | null
  }[]
  nonConformites: {
    id: string, gravite: string, description: string, cree_le: string,
    inspection_id: string, intitule_modele: string, a_une_action: boolean
  }[]
  evolution: { mois: string, inspections: number, taux: number | null }[]
}

const pct = (t: number | null) => (t == null ? '—' : `${Math.round(t * 100)} %`)
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export default function PageTableauDeBord() {
  const { entreprise } = useContexteApp()
  const [t, setT] = useState<Tableau | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  useEffect(() => {
    api<Tableau>('/api/tableau-de-bord').then(setT).catch((e) => setErreur(messageErreur(e)))
  }, [])

  const i = t?.indicateurs
  const ncTotal = i ? i.ncOuvertes.critique + i.ncOuvertes.majeure + i.ncOuvertes.mineure : 0

  return (
    <main className="contenu">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Tableau de bord</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">Où en est votre maîtrise QHSE : conformité, non-conformités ouvertes et actions à mener.</p>
        </div>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
      {!t && !erreur && (
        <div aria-busy="true" className="tuiles">{[1, 2, 3, 4].map((k) => <div key={k} className="squelette" style={{ height: 84 }} />)}</div>
      )}

      {t && i && (
        <>
          <section className="tuiles" aria-label="Indicateurs">
            <div className={`tuile ${i.tauxConformite90j == null ? 'tuile--bleu' : i.tauxConformite90j >= 0.8 ? 'tuile--vert' : 'tuile--orange'}`}>
              <div className="tuile__valeur">{pct(i.tauxConformite90j)}</div>
              <div className="tuile__libelle">Taux de conformité (90 jours)</div>
            </div>
            <div className={`tuile ${i.ncOuvertes.critique ? 'tuile--rouge' : 'tuile--orange'}`}>
              <div className="tuile__valeur">{ncTotal}</div>
              <div className="tuile__libelle">
                Non-conformité{ncTotal > 1 ? 's' : ''} ouverte{ncTotal > 1 ? 's' : ''}
                {i.ncOuvertes.critique > 0 && ` · ${i.ncOuvertes.critique} critique${i.ncOuvertes.critique > 1 ? 's' : ''}`}
              </div>
            </div>
            <div className={`tuile ${i.actionsEnRetard ? 'tuile--rouge' : 'tuile--vert'}`}>
              <div className="tuile__valeur">{i.actionsEnRetard}<span className="tuile__sur"> / {i.actionsOuvertes}</span></div>
              <div className="tuile__libelle">Actions en retard / ouvertes</div>
            </div>
            <div className="tuile tuile--bleu">
              <div className="tuile__valeur">{i.inspectionsTerminees90j}</div>
              <div className="tuile__libelle">
                Inspection{i.inspectionsTerminees90j > 1 ? 's' : ''} clôturée{i.inspectionsTerminees90j > 1 ? 's' : ''} (90 j)
                {i.inspectionsEnCours > 0 && ` · ${i.inspectionsEnCours} en cours`}
              </div>
            </div>
          </section>

          <VoletRegistre />
          <VoletHabilitations />
          <VoletAutodiagnostic />

          <section className="carte" aria-labelledby="titre-evolution">
            <div className="carte__titre">
              <h2 id="titre-evolution">Évolution de la conformité</h2>
              <span className="badge badge--neutre">Actions traitées dans les délais : {pct(i.tauxTraitementDelais)}</span>
            </div>
            <div className="evolution" role="list">
              {t.evolution.map((m) => {
                const [a, mo] = m.mois.split('-')
                return (
                  <div key={m.mois} className="evolution__mois" role="listitem"
                    aria-label={`${MOIS[Number(mo) - 1]} ${a} : ${m.taux == null ? 'aucune inspection clôturée' : `${pct(m.taux)} de conformité, ${m.inspections} inspection(s)`}`}>
                    <div className="evolution__valeur">{m.taux == null ? '' : pct(m.taux)}</div>
                    <div className="evolution__piste">
                      <div className={`evolution__barre ${m.taux != null && m.taux < 0.8 ? 'evolution__barre--faible' : ''}`}
                        style={{ height: `${m.taux == null ? 0 : Math.max(4, m.taux * 100)}%` }} />
                    </div>
                    <div className="evolution__libelle">{MOIS[Number(mo) - 1]}</div>
                  </div>
                )
              })}
            </div>
          </section>

          <div className="grille-tableau">
            <section className="carte" aria-labelledby="titre-actions">
              <div className="carte__titre"><h2 id="titre-actions">Actions à mener</h2></div>
              {t.actions.length === 0 && <p className="texte-discret">Aucune action ouverte.</p>}
              <div className="actions" style={{ marginTop: 0 }}>
                {t.actions.map((a) => (
                  <a key={a.id} className={`action action--lien ${a.en_retard ? 'action--retard' : ''}`}
                    href={a.inspection_id ? `/inspections/${a.inspection_id}` : a.declaration_id ? `/registre/${a.declaration_id}` : a.autodiagnostic_id ? `/autodiagnostic/${a.autodiagnostic_id}` : undefined}>
                    <div>
                      <div className="action__libelle">{a.libelle}</div>
                      <div className="action__meta">
                        {a.responsable_nom && <span><IconePersonne />{a.responsable_nom}</span>}
                        {a.echeance && (a.en_retard
                          ? <span className="retard"><IconeHorloge />En retard · {dateCourteFr(a.echeance)}</span>
                          : <span><IconeHorloge />{dateCourteFr(a.echeance)}</span>)}
                        {a.intitule_modele && <span>{a.intitule_modele}</span>}
                      </div>
                    </div>
                    <span className={`badge statut--${a.statut}`}>{STATUTS_ACTION.find((s) => s.valeur === a.statut)?.texte ?? a.statut}</span>
                  </a>
                ))}
              </div>
            </section>

            <section className="carte" aria-labelledby="titre-nc">
              <div className="carte__titre"><h2 id="titre-nc">Non-conformités ouvertes</h2></div>
              {t.nonConformites.length === 0 && <p className="texte-discret">Aucune non-conformité ouverte.</p>}
              <div className="actions" style={{ marginTop: 0 }}>
                {t.nonConformites.map((nc) => (
                  <a key={nc.id} className="action action--lien" href={`/inspections/${nc.inspection_id}`}>
                    <div>
                      <div className="action__libelle">{nc.description}</div>
                      <div className="action__meta">
                        <span>{nc.intitule_modele}</span>
                        <span>{dateCourteFr(nc.cree_le)}</span>
                        {!nc.a_une_action && <span className="retard">Sans plan d’action</span>}
                      </div>
                    </div>
                    <span className={`badge gravite--${nc.gravite}`}>{LIBELLE_GRAVITE[nc.gravite] ?? nc.gravite}</span>
                  </a>
                ))}
              </div>
            </section>
          </div>

          <p style={{ marginTop: 18 }}>
            <a className="bouton bouton--secondaire" href="/inspections"><IconeListe /> Toutes les inspections</a>
          </p>
        </>
      )}
    </main>
  )
}
