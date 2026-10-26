'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeBatiment, IconeCalendrier, IconeHorloge, IconeListe, IconeOutil, IconePersonne, IconePlus } from '@/ui/icones'
import { LIBELLE_STATUT_INSPECTION, dateCourteFr } from '@/ui/libelles'

interface LigneInspection {
  id: string
  intitule_modele: string
  cible_type: 'site' | 'equipement'
  cible_nom: string | null
  date_inspection: string
  heure_debut: string | null
  heure_fin: string | null
  statut: string
  consultant_nom: string | null
  items_total: number
  items_renseignes: number
  items_non_conformes: number
  nc_critique: number
  nc_majeure: number
  nc_mineure: number
  actions_ouvertes: number
  actions_en_retard: number
}

type Filtre = 'toutes' | 'en_cours' | 'terminee' | 'annulee'

export default function PageInspections() {
  const { entreprise, peutConduire } = useContexteApp()
  const [lignes, setLignes] = useState<LigneInspection[] | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [filtre, setFiltre] = useState<Filtre>('toutes')

  useEffect(() => {
    api<{ inspections: LigneInspection[] }>('/api/inspections')
      .then((r) => setLignes(r.inspections))
      .catch((e) => setErreur(messageErreur(e)))
  }, [])

  // Une inspection annulée est conservée pour la traçabilité mais sort des
  // listes et des indicateurs ; l'onglet « Annulées » permet de la retrouver.
  const actives = (lignes ?? []).filter((i) => i.statut !== 'annulee')
  const nbAnnulees = (lignes ?? []).length - actives.length

  const indicateurs = useMemo(() => {
    const l = (lignes ?? []).filter((i) => i.statut !== 'annulee')
    return {
      enCours: l.filter((i) => i.statut === 'en_cours' || i.statut === 'brouillon').length,
      critiques: l.reduce((n, i) => n + i.nc_critique, 0),
      ncTotal: l.reduce((n, i) => n + i.nc_critique + i.nc_majeure + i.nc_mineure, 0),
      actionsOuvertes: l.reduce((n, i) => n + i.actions_ouvertes, 0),
      actionsRetard: l.reduce((n, i) => n + i.actions_en_retard, 0),
    }
  }, [lignes])

  const affichees = filtre === 'annulee'
    ? (lignes ?? []).filter((i) => i.statut === 'annulee')
    : actives.filter((i) =>
      filtre === 'toutes' ? true : filtre === 'terminee' ? i.statut === 'terminee' : i.statut === 'en_cours' || i.statut === 'brouillon')

  return (
    <main className="contenu">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Inspections</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">
            Visites de sites et contrôles d’équipements, non-conformités relevées et plans d’action.
          </p>
        </div>
        {peutConduire && (
          <a className="bouton" href="/inspections/nouvelle"><IconePlus /> Nouvelle inspection</a>
        )}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}

      {lignes === null && !erreur && (
        <div aria-busy="true">
          <div className="tuiles">{[1, 2, 3, 4].map((k) => <div key={k} className="squelette" style={{ height: 84 }} />)}</div>
          {[1, 2, 3].map((k) => <div key={k} className="squelette" style={{ height: 96, marginBottom: 12 }} />)}
        </div>
      )}

      {lignes && lignes.length > 0 && (
        <>
          <section className="tuiles" aria-label="Indicateurs">
            <div className="tuile tuile--bleu">
              <div className="tuile__valeur">{indicateurs.enCours}</div>
              <div className="tuile__libelle">Inspection{indicateurs.enCours > 1 ? 's' : ''} en cours</div>
            </div>
            <div className="tuile tuile--rouge">
              <div className="tuile__valeur">{indicateurs.critiques}</div>
              <div className="tuile__libelle">Non-conformité{indicateurs.critiques > 1 ? 's' : ''} critique{indicateurs.critiques > 1 ? 's' : ''}</div>
            </div>
            <div className="tuile tuile--orange">
              <div className="tuile__valeur">{indicateurs.actionsOuvertes}</div>
              <div className="tuile__libelle">Plan{indicateurs.actionsOuvertes > 1 ? 's' : ''} d’action ouvert{indicateurs.actionsOuvertes > 1 ? 's' : ''}</div>
            </div>
            <div className={`tuile ${indicateurs.actionsRetard ? 'tuile--rouge' : 'tuile--vert'}`}>
              <div className="tuile__valeur">{indicateurs.actionsRetard}</div>
              <div className="tuile__libelle">Action{indicateurs.actionsRetard > 1 ? 's' : ''} en retard</div>
            </div>
          </section>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <h2>Historique</h2>
            <div className="onglets" role="group" aria-label="Filtrer les inspections">
              {(['toutes', 'en_cours', 'terminee', ...(nbAnnulees ? ['annulee'] : [])] as Filtre[]).map((f) => (
                <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>
                  {f === 'toutes' ? 'Toutes' : f === 'en_cours' ? 'En cours' : f === 'terminee' ? 'Clôturées' : `Annulées (${nbAnnulees})`}
                </button>
              ))}
            </div>
          </div>

          <div className="inspections">
            {affichees.map((i) => {
              const statut = LIBELLE_STATUT_INSPECTION[i.statut] ?? { texte: i.statut, classe: 'badge--neutre' }
              const pct = i.items_total ? Math.round((i.items_renseignes / i.items_total) * 100) : 0
              return (
                <a key={i.id} className="inspection-ligne" href={`/inspections/${i.id}`}>
                  <div>
                    <div className="inspection-ligne__titre">{i.intitule_modele}</div>
                    <div className="inspection-ligne__meta">
                      <span>{i.cible_type === 'site' ? <IconeBatiment /> : <IconeOutil />}{i.cible_nom ?? '—'}</span>
                      <span><IconeCalendrier />{dateCourteFr(i.date_inspection)}{i.heure_debut && ` · ${i.heure_debut}${i.heure_fin ? `–${i.heure_fin}` : ''}`}</span>
                      {i.consultant_nom && <span><IconePersonne />{i.consultant_nom}</span>}
                    </div>
                    <div className="inspection-ligne__badges">
                      <span className={`badge ${statut.classe}`}>{statut.texte}</span>
                      {i.nc_critique > 0 && <span className="badge gravite--critique">{i.nc_critique} critique{i.nc_critique > 1 ? 's' : ''}</span>}
                      {i.nc_majeure > 0 && <span className="badge gravite--majeure">{i.nc_majeure} majeure{i.nc_majeure > 1 ? 's' : ''}</span>}
                      {i.nc_mineure > 0 && <span className="badge gravite--mineure">{i.nc_mineure} mineure{i.nc_mineure > 1 ? 's' : ''}</span>}
                      {i.actions_en_retard > 0 && (
                        <span className="badge badge--rouge"><IconeHorloge />{i.actions_en_retard} action{i.actions_en_retard > 1 ? 's' : ''} en retard</span>
                      )}
                    </div>
                  </div>
                  <div className="inspection-ligne__droite">
                    <div className="progression" aria-label={`${i.items_renseignes} points renseignés sur ${i.items_total}`}>
                      <div className="progression__barre"><div className="progression__remplissage" style={{ width: `${pct}%` }} /></div>
                      <div className="progression__texte">{i.items_renseignes}/{i.items_total} points</div>
                    </div>
                  </div>
                </a>
              )
            })}
            {affichees.length === 0 && <p style={{ color: 'var(--ink-500)' }}>Aucune inspection dans cette catégorie.</p>}
          </div>
        </>
      )}

      {lignes && lignes.length === 0 && (
        <div className="vide">
          <IconeListe />
          <h2>Aucune inspection pour l’instant</h2>
          <p>
            {peutConduire
              ? 'Démarrez une première visite à partir d’un modèle : la checklist vous guide point par point.'
              : 'Les inspections réalisées par votre consultant IFECARM GROUP apparaîtront ici.'}
          </p>
          {peutConduire && <a className="bouton" href="/inspections/nouvelle"><IconePlus /> Nouvelle inspection</a>}
        </div>
      )}
    </main>
  )
}
