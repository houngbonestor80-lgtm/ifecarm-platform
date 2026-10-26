'use client'

import { use, useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import {
  IconeAlerte, IconeBatiment, IconeCalendrier, IconeCoche, IconeCommentaire, IconeCroix, IconeHorloge,
  IconeListe, IconeMoins, IconeOutil, IconePersonne, IconePlus,
} from '@/ui/icones'
import { LIBELLE_GRAVITE, LIBELLE_STATUT_INSPECTION, STATUTS_ACTION, dateCourteFr, dateFr } from '@/ui/libelles'
import { NotesInternes } from '@/ui/NotesInternes'
import { Photos } from '@/ui/Photos'

type Resultat = 'conforme' | 'non_conforme' | 'non_applicable'
type Gravite = 'mineure' | 'majeure' | 'critique'
type Photo = { id: string, nom: string }

interface Item { id: string, ordre: number, libelle: string, resultat: Resultat | null, commentaire: string | null, personnalise: boolean, aide: string | null, gravite_defaut: Gravite | null, photos: Photo[] }
interface Action { id: string, reference: string, libelle: string, responsable_nom: string | null, echeance: string | null, statut: string, en_retard: boolean }
interface NonConformite { id: string, item_inspection_id: string | null, gravite: Gravite, description: string, actions: Action[], photos: Photo[] }
interface Inspection {
  id: string
  intitule_modele: string
  cible_type: 'site' | 'equipement'
  cible_nom: string | null
  date_inspection: string
  heure_debut: string | null
  heure_fin: string | null
  statut: string
  consultant_nom: string | null
  inspecteur_nom: string | null
  representant_client: string | null
  items: Item[]
  nonConformites: NonConformite[]
}

const VERDICTS: { valeur: Resultat, texte: string, Icone: typeof IconeCoche }[] = [
  { valeur: 'conforme', texte: 'Conforme', Icone: IconeCoche },
  { valeur: 'non_conforme', texte: 'Non conforme', Icone: IconeCroix },
  { valeur: 'non_applicable', texte: 'N/A', Icone: IconeMoins },
]

export default function PageInspection({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { consultant, peutConduire, entreprise } = useContexteApp()
  const [insp, setInsp] = useState<Inspection | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [ncOuverte, setNcOuverte] = useState<string | null>(null) // id d'item, ou 'generale'
  const [commentaireOuvert, setCommentaireOuvert] = useState<string | null>(null)
  // Points écrits par l'inspecteur : ajout en fin de liste, reformulation, suppression.
  const [nouveauPoint, setNouveauPoint] = useState('')
  const [pointEdite, setPointEdite] = useState<{ id: string, libelle: string } | null>(null)
  const [cloture, setCloture] = useState(false)

  const charger = useCallback(() =>
    api<{ inspection: Inspection }>(`/api/inspections/${id}`).then((r) => setInsp(r.inspection)).catch((e) => setErreur(messageErreur(e))),
  [id])

  useEffect(() => { void charger() }, [charger])

  if (erreur && !insp) {
    return (
      <main className="contenu contenu--etroit">
        <nav className="fil-ariane"><a href="/inspections">Inspections</a></nav>
        <div className="alerte alerte--erreur" role="alert">{erreur}</div>
      </main>
    )
  }
  if (!insp) {
    return <main className="contenu contenu--etroit" aria-busy="true"><div className="squelette" style={{ height: 320 }} /></main>
  }

  const modifiable = peutConduire && insp.statut !== 'terminee' && insp.statut !== 'annulee'
  // Client et prospect consultent seulement : le consultant tient les plans d’action.
  const statutActionModifiable = peutConduire
  const renseignes = insp.items.filter((i) => i.resultat).length
  const restants = insp.items.length - renseignes
  const nonConformes = insp.items.filter((i) => i.resultat === 'non_conforme').length
  const statut = LIBELLE_STATUT_INSPECTION[insp.statut] ?? { texte: insp.statut, classe: 'badge--neutre' }
  const pct = insp.items.length ? Math.round((renseignes / insp.items.length) * 100) : 0

  async function executer(fn: () => Promise<unknown>) {
    setErreur(null)
    try {
      await fn()
    } catch (e) {
      setErreur(messageErreur(e))
    }
    await charger()
  }

  async function verdict(item: Item, valeur: Resultat) {
    const nouveau = item.resultat === valeur ? null : valeur
    // Mise à jour immédiate à l'écran (saisie terrain fluide), confirmée par le rechargement.
    setInsp({ ...insp!, items: insp!.items.map((i) => (i.id === item.id ? { ...i, resultat: nouveau } : i)) })
    await executer(() => api(`/api/inspections/${id}/items/${item.id}`, { method: 'PATCH', corps: { resultat: nouveau } }))
    if (nouveau === 'non_conforme' && !insp!.nonConformites.some((n) => n.item_inspection_id === item.id)) setNcOuverte(item.id)
  }

  async function cloturer() {
    setCloture(true)
    await executer(() => api(`/api/inspections/${id}/terminer`, { method: 'POST' }))
    setCloture(false)
  }

  // Règle mixte (migration 0012) : effacement si non clôturée et sans NC, sinon annulation.
  const effacable = (insp.statut === 'brouillon' || insp.statut === 'en_cours') && insp.nonConformites.length === 0

  async function supprimer() {
    if (insp?.statut === 'annulee') {
      // Purge (migration 0014) : NC, plans d'action et photos compris — saisie de confirmation.
      const saisie = window.prompt('Suppression DÉFINITIVE : l’inspection, ses non-conformités, ses plans d’action et ses photos seront effacés, sans retour possible.\n\nTapez SUPPRIMER pour confirmer.')
      if (saisie?.trim().toUpperCase() !== 'SUPPRIMER') return
    } else {
      const message = effacable
        ? 'Supprimer définitivement cette inspection ? Cette action est irréversible.'
        : 'Cette inspection est clôturée ou comporte des non-conformités : elle sera RANGÉE (annulée : retirée des listes, mais conservée avec ses non-conformités et plans d’action). Vous pourrez ensuite la supprimer définitivement depuis l’onglet « Annulées ». Continuer ?'
      if (!window.confirm(message)) return
    }
    setErreur(null)
    try {
      await api(`/api/inspections/${id}`, { method: 'DELETE' })
      window.location.assign('/inspections')
    } catch (e) {
      setErreur(messageErreur(e))
    }
  }

  const libelleItem = (itemId: string | null) => insp.items.find((i) => i.id === itemId)

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/inspections">Inspections</a> / {insp.intitule_modele}</nav>

      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Inspection</div>
          <h1>{insp.intitule_modele}</h1>
          <div className="inspection-ligne__meta" style={{ marginTop: 8 }}>
            <span>{insp.cible_type === 'site' ? <IconeBatiment /> : <IconeOutil />}{insp.cible_nom ?? '—'}</span>
            <span><IconeCalendrier />{dateFr(insp.date_inspection)}{insp.heure_debut && ` · ${insp.heure_debut}${insp.heure_fin ? ` – ${insp.heure_fin}` : ''}`}</span>
            {insp.consultant_nom && <span><IconePersonne />{insp.consultant_nom}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <span className={`badge ${statut.classe}`} style={{ fontSize: '0.82rem', padding: '5px 12px' }}>{statut.texte}</span>
          {/* Rapport généré à la demande (état à date), ouvert dans un nouvel onglet. */}
          <a className="bouton bouton--secondaire bouton--petit" href={`/api/inspections/${id}/rapport`} target="_blank" rel="noopener">
            <IconeListe /> Rapport PDF
          </a>
        </div>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {insp.statut === 'annulee' && (
        <div className="alerte alerte--info" style={{ marginBottom: 14 }}>
          Inspection annulée : elle n’apparaît plus dans les listes et ne peut plus être modifiée. Elle est conservée pour la traçabilité{peutConduire && ' — vous pouvez la supprimer définitivement en bas de page'}.
        </div>
      )}
      {!peutConduire && insp.statut !== 'terminee' && insp.statut !== 'annulee' && (
        <div className="alerte alerte--info" style={{ marginBottom: 14 }}>
          {consultant
            ? 'Consultation seule : vous n’avez pas l’accès en écriture à cette entreprise.'
            : 'Inspection conduite par votre consultant IFECARM GROUP : vous pouvez tout consulter, sans rien modifier.'}
        </div>
      )}

      {/* ------------------------------------------------------ Date et horaires */}
      <HoraireInspection
        inspection={insp}
        modifiable={modifiable}
        onEnregistrer={(corps) => executer(() => api(`/api/inspections/${id}/horaire`, { method: 'PUT', corps }))}
      />

      {/* ------------------------------------------------------ Intervenants */}
      <Intervenants
        inspection={insp}
        modifiable={modifiable}
        libelleRepresentant={entreprise.statutRelation === 'prospect' ? 'Représentant du prospect' : 'Représentant du client'}
        onEnregistrer={(corps) => executer(() => api(`/api/inspections/${id}`, { method: 'PATCH', corps }))}
      />

      {/* ---------------------------------------------------------- Checklist */}
      <section className="carte">
        <div className="carte__titre">
          <h2>Checklist</h2>
          <div className="progression" style={{ maxWidth: 200 }}>
            <div className="progression__barre"><div className="progression__remplissage" style={{ width: `${pct}%` }} /></div>
            <div className="progression__texte">{renseignes}/{insp.items.length} renseignés{nonConformes ? ` · ${nonConformes} non conforme${nonConformes > 1 ? 's' : ''}` : ''}</div>
          </div>
        </div>

        <ol className="checklist" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {insp.items.map((item) => {
            const ncs = insp.nonConformites.filter((n) => n.item_inspection_id === item.id)
            return (
              <li key={item.id} className={`point ${item.resultat ? `point--${item.resultat}` : ''}`}>
                <div className="point__tete">
                  <span className="point__numero">{item.ordre}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {pointEdite?.id === item.id ? (
                      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onSubmit={async (e) => {
                        e.preventDefault()
                        if (!pointEdite.libelle.trim()) return
                        await executer(() => api(`/api/inspections/${id}/items/${item.id}`, { method: 'PATCH', corps: { libelle: pointEdite.libelle } }))
                        setPointEdite(null)
                      }}>
                        <input className="saisie" style={{ flex: 1, minWidth: 200 }} maxLength={500} autoFocus value={pointEdite.libelle}
                          aria-label="Libellé du point de contrôle" onChange={(e) => setPointEdite({ id: item.id, libelle: e.target.value })} />
                        <button type="submit" className="bouton bouton--petit">Enregistrer</button>
                        <button type="button" className="bouton bouton--discret bouton--petit" onClick={() => setPointEdite(null)}>Annuler</button>
                      </form>
                    ) : (
                      <div className="point__libelle">{item.libelle}{item.personnalise && <span className="badge badge--neutre" style={{ marginLeft: 8 }}>Ajouté</span>}</div>
                    )}
                    {item.aide && <div className="point__aide">{item.aide}</div>}
                  </div>
                  {ncs.length > 0 && (
                    <span className={`badge gravite--${ncs[0]!.gravite}`}><IconeAlerte />NC</span>
                  )}
                </div>

                <div className="point__corps">
                  <div className="verdict" role="group" aria-label={`Résultat : ${item.libelle}`}>
                    {VERDICTS.map(({ valeur, texte, Icone }) => (
                      <button key={valeur} type="button" className={`v-${valeur}`} aria-pressed={item.resultat === valeur}
                        disabled={!modifiable} onClick={() => verdict(item, valeur)}>
                        <Icone /><span className="libelle">{texte}</span>
                      </button>
                    ))}
                  </div>

                  {item.commentaire && commentaireOuvert !== item.id && (
                    <p style={{ fontSize: '0.88rem', color: 'var(--ink-600)', display: 'flex', gap: 6 }}>
                      <IconeCommentaire className="icone" /> {item.commentaire}
                    </p>
                  )}

                  <Photos inspectionId={id} cible="item" cibleId={item.id} photos={item.photos} modifiable={modifiable} onChange={charger} />

                  {modifiable && (
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <button type="button" className="lien-action" onClick={() => setCommentaireOuvert(commentaireOuvert === item.id ? null : item.id)}>
                        <IconeCommentaire />{item.commentaire ? 'Modifier le commentaire' : 'Ajouter un commentaire'}
                      </button>
                      <button type="button" className="lien-action lien-action--rouge" onClick={() => setNcOuverte(ncOuverte === item.id ? null : item.id)}>
                        <IconeAlerte />Signaler une non-conformité
                      </button>
                      {item.personnalise && (
                        <>
                          <button type="button" className="lien-action" onClick={() => setPointEdite({ id: item.id, libelle: item.libelle })}>Reformuler</button>
                          {ncs.length === 0 && (
                            <button type="button" className="lien-action lien-action--rouge"
                              onClick={() => window.confirm('Supprimer ce point de contrôle (et ses photos) ?')
                                && executer(() => api(`/api/inspections/${id}/items/${item.id}`, { method: 'DELETE' }))}>
                              Supprimer le point
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {commentaireOuvert === item.id && (
                    <FormCommentaire
                      initial={item.commentaire ?? ''}
                      onAnnuler={() => setCommentaireOuvert(null)}
                      onValider={async (texte) => {
                        await executer(() => api(`/api/inspections/${id}/items/${item.id}`, { method: 'PATCH', corps: { commentaire: texte } }))
                        setCommentaireOuvert(null)
                      }}
                    />
                  )}

                  {ncOuverte === item.id && (
                    <FormNonConformite
                      graviteDefaut={item.gravite_defaut ?? 'mineure'}
                      onAnnuler={() => setNcOuverte(null)}
                      onValider={async (gravite, description) => {
                        await executer(() => api(`/api/inspections/${id}/non-conformites`, { method: 'POST', corps: { itemId: item.id, gravite, description } }))
                        setNcOuverte(null)
                      }}
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        {modifiable && (
          <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }} onSubmit={async (e) => {
            e.preventDefault()
            if (!nouveauPoint.trim()) return
            await executer(() => api(`/api/inspections/${id}/items`, { method: 'POST', corps: { libelle: nouveauPoint } }))
            setNouveauPoint('')
          }}>
            <input className="saisie" style={{ flex: 1, minWidth: 220 }} maxLength={500} value={nouveauPoint}
              placeholder="Ajouter votre propre point de contrôle…" aria-label="Nouveau point de contrôle" onChange={(e) => setNouveauPoint(e.target.value)} />
            <button type="submit" className="bouton bouton--secondaire" disabled={!nouveauPoint.trim()}><IconePlus /> Ajouter un point</button>
          </form>
        )}
      </section>

      {/* ------------------------------------------- Non-conformités & actions */}
      <section className="carte">
        <div className="carte__titre">
          <h2>Non-conformités et plans d’action</h2>
          {modifiable && ncOuverte !== 'generale' && (
            <button type="button" className="bouton bouton--secondaire bouton--petit" onClick={() => setNcOuverte('generale')}>
              <IconePlus /> Non-conformité générale
            </button>
          )}
        </div>

        {ncOuverte === 'generale' && (
          <div style={{ marginBottom: 14 }}>
            <FormNonConformite
              graviteDefaut="mineure"
              onAnnuler={() => setNcOuverte(null)}
              onValider={async (gravite, description) => {
                await executer(() => api(`/api/inspections/${id}/non-conformites`, { method: 'POST', corps: { gravite, description } }))
                setNcOuverte(null)
              }}
            />
          </div>
        )}

        {insp.nonConformites.length === 0 && (
          <p style={{ color: 'var(--ink-500)', fontSize: '0.92rem' }}>Aucune non-conformité relevée.</p>
        )}

        {insp.nonConformites.map((nc) => {
          const item = libelleItem(nc.item_inspection_id)
          return (
            <article key={nc.id} className="nc">
              <div className="nc__tete">
                <span className={`badge gravite--${nc.gravite}`}><IconeAlerte />{LIBELLE_GRAVITE[nc.gravite]}</span>
                <span className="nc__point">{item ? `Point ${item.ordre} — ${item.libelle}` : 'Non-conformité générale'}</span>
              </div>
              <p className="nc__description">{nc.description}</p>
              <Photos inspectionId={id} cible="nc" cibleId={nc.id} photos={nc.photos} modifiable={modifiable} onChange={charger} />

              <div className="actions">
                {nc.actions.map((a) => (
                  <div key={a.id} className={`action ${a.en_retard ? 'action--retard' : ''}`}>
                    <div>
                      <div className="action__libelle">{a.libelle}</div>
                      <div className="action__meta">
                        <span>{a.reference}</span>
                        {a.responsable_nom && <span>Responsable : {a.responsable_nom}</span>}
                        <span>Échéance : {dateCourteFr(a.echeance)}</span>
                        {a.en_retard && <span className="retard"><IconeHorloge />En retard</span>}
                      </div>
                    </div>
                    <label className="visually-hidden" htmlFor={`statut-${a.id}`}>Statut de l’action</label>
                    <select id={`statut-${a.id}`} className={`select-statut statut--${a.statut}`} value={a.statut}
                      disabled={!statutActionModifiable}
                      onChange={(e) => executer(() => api(`/api/actions/${a.id}`, { method: 'PATCH', corps: { statut: e.target.value } }))}>
                      {STATUTS_ACTION.map((s) => <option key={s.valeur} value={s.valeur}>{s.texte}</option>)}
                    </select>
                    <div style={{ gridColumn: '1 / -1' }}><NotesInternes objetType="action_corrective" objetId={a.id} repli /></div>
                  </div>
                ))}
                {modifiable && (
                  <FormPlanAction
                    onValider={(corps) => executer(() => api(`/api/non-conformites/${nc.id}/actions`, { method: 'POST', corps }))}
                  />
                )}
                {!modifiable && nc.actions.length === 0 && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--ink-400)' }}>Aucun plan d’action défini.</p>
                )}
              </div>
            </article>
          )
        })}
      </section>

      <NotesInternes objetType="inspection" objetId={id} />

      {peutConduire && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0 24px' }}>
          <button type="button" className="bouton bouton--discret bouton--petit" style={{ color: 'var(--qhse-red)' }} onClick={supprimer}>
            <IconeCroix /> {insp.statut === 'annulee' ? 'Supprimer définitivement' : effacable ? 'Supprimer l’inspection' : 'Ranger (annuler) l’inspection'}
          </button>
        </div>
      )}

      {modifiable && (
        <div className="pied-cloture">
          <span className="pied-cloture__texte">
            {restants > 0
              ? `${restants} point${restants > 1 ? 's' : ''} à renseigner avant de clôturer`
              : 'Tous les points sont renseignés.'}
          </span>
          <button type="button" className="bouton" disabled={restants > 0 || cloture} onClick={cloturer}>
            <IconeCoche /> {cloture ? 'Clôture…' : 'Clôturer l’inspection'}
          </button>
        </div>
      )}
    </main>
  )
}

// ---------------------------------------------------------------------------

function FormCommentaire({ initial, onValider, onAnnuler }: { initial: string, onValider: (t: string) => Promise<void>, onAnnuler: () => void }) {
  const [texte, setTexte] = useState(initial)
  const [enCours, setEnCours] = useState(false)
  return (
    <form className="encadre" onSubmit={async (e) => { e.preventDefault(); setEnCours(true); await onValider(texte); setEnCours(false) }}>
      <div className="champ">
        <label htmlFor="commentaire">Commentaire</label>
        <textarea id="commentaire" className="saisie" value={texte} maxLength={2000} onChange={(e) => setTexte(e.target.value)} autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="bouton bouton--discret bouton--petit" onClick={onAnnuler}>Annuler</button>
        <button type="submit" className="bouton bouton--petit" disabled={enCours}>{enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

function FormNonConformite({ graviteDefaut, onValider, onAnnuler }: {
  graviteDefaut: Gravite
  onValider: (g: Gravite, d: string) => Promise<void>
  onAnnuler: () => void
}) {
  const [gravite, setGravite] = useState<Gravite>(graviteDefaut)
  const [description, setDescription] = useState('')
  const [enCours, setEnCours] = useState(false)
  return (
    <form className="encadre encadre--rouge"
      onSubmit={async (e) => { e.preventDefault(); setEnCours(true); await onValider(gravite, description); setEnCours(false) }}>
      <div className="champ">
        <span className="label">Gravité</span>
        <div className="gravites" role="group" aria-label="Gravité">
          {(['mineure', 'majeure', 'critique'] as Gravite[]).map((g) => (
            <button key={g} type="button" className={`g-${g}`} aria-pressed={gravite === g} onClick={() => setGravite(g)}>{LIBELLE_GRAVITE[g]}</button>
          ))}
        </div>
      </div>
      <div className="champ">
        <label htmlFor="nc-description">Constat</label>
        <textarea id="nc-description" className="saisie" value={description} maxLength={2000} required
          placeholder="Décrivez précisément ce qui a été constaté (lieu, écart, risque)."
          onChange={(e) => setDescription(e.target.value)} autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="bouton bouton--discret bouton--petit" onClick={onAnnuler}>Annuler</button>
        <button type="submit" className="bouton bouton--danger bouton--petit" disabled={enCours || !description.trim()}>{enCours ? 'Enregistrement…' : 'Enregistrer la non-conformité'}</button>
      </div>
    </form>
  )
}

function FormPlanAction({ onValider }: { onValider: (c: { libelle: string, responsable: string, echeance: string }) => Promise<void> }) {
  const [ouvert, setOuvert] = useState(false)
  const [libelle, setLibelle] = useState('')
  const [responsable, setResponsable] = useState('')
  const [echeance, setEcheance] = useState('')
  const [enCours, setEnCours] = useState(false)

  if (!ouvert) {
    return (
      <button type="button" className="lien-action" onClick={() => setOuvert(true)} style={{ justifySelf: 'start' }}>
        <IconePlus />Ajouter un plan d’action
      </button>
    )
  }
  return (
    <form className="encadre" onSubmit={async (e) => {
      e.preventDefault()
      setEnCours(true)
      await onValider({ libelle, responsable, echeance })
      setEnCours(false)
      setOuvert(false)
      setLibelle(''); setResponsable(''); setEcheance('')
    }}>
      <div className="champ">
        <label htmlFor="pa-libelle">Action à mener</label>
        <input id="pa-libelle" className="saisie" value={libelle} maxLength={300} required autoFocus
          placeholder="Ex. Remplacer l’extincteur et mettre à jour le registre" onChange={(e) => setLibelle(e.target.value)} />
      </div>
      <div className="grille-2" style={{ marginTop: 14 }}>
        <div className="champ">
          <label htmlFor="pa-responsable">Responsable</label>
          <input id="pa-responsable" className="saisie" value={responsable} maxLength={200}
            placeholder="Nom ou fonction" onChange={(e) => setResponsable(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="pa-echeance">Échéance</label>
          <input id="pa-echeance" type="date" className="saisie" value={echeance} onChange={(e) => setEcheance(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="bouton bouton--discret bouton--petit" onClick={() => setOuvert(false)}>Annuler</button>
        <button type="submit" className="bouton bouton--petit" disabled={enCours || !libelle.trim()}>{enCours ? 'Enregistrement…' : 'Ajouter l’action'}</button>
      </div>
    </form>
  )
}

/** Qui a réalisé l'inspection, et qui l'a accompagnée côté client / prospect (repris dans le rapport). */
function Intervenants({ inspection, modifiable, libelleRepresentant, onEnregistrer }: {
  inspection: Inspection
  modifiable: boolean
  libelleRepresentant: string
  onEnregistrer: (corps: { inspecteurNom: string, representantClient: string }) => Promise<void>
}) {
  const [inspecteur, setInspecteur] = useState(inspection.inspecteur_nom ?? '')
  const [representant, setRepresentant] = useState(inspection.representant_client ?? '')
  const [enCours, setEnCours] = useState(false)
  const change = inspecteur !== (inspection.inspecteur_nom ?? '') || representant !== (inspection.representant_client ?? '')

  if (!modifiable) {
    return (
      <section className="carte">
        <div className="intervenants">
          <div>
            <span className="label">Inspection réalisée par</span>
            <div className="intervenants__valeur">{inspection.inspecteur_nom || <span className="intervenants__vide">Non renseigné</span>}</div>
          </div>
          <div>
            <span className="label">{libelleRepresentant}</span>
            <div className="intervenants__valeur">{inspection.representant_client || <span className="intervenants__vide">Non renseigné</span>}</div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <form
      className="carte"
      method="post"
      onSubmit={async (e) => {
        e.preventDefault()
        setEnCours(true)
        await onEnregistrer({ inspecteurNom: inspecteur, representantClient: representant })
        setEnCours(false)
      }}
    >
      <div className="intervenants">
        <div className="champ">
          <label htmlFor="inspecteur">Inspection réalisée par</label>
          <input id="inspecteur" className="saisie" value={inspecteur} maxLength={200} placeholder="Nom et fonction" onChange={(e) => setInspecteur(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="representant">{libelleRepresentant}</label>
          <input id="representant" className="saisie" value={representant} maxLength={200} placeholder="Nom et fonction de la personne présente" onChange={(e) => setRepresentant(e.target.value)} />
        </div>
      </div>
      {change && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="submit" className="bouton bouton--petit" disabled={enCours}>{enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      )}
    </form>
  )
}

/** Jour, heure de début et heure de fin de l'inspection : décidés par le consultant, modifiables tant qu'elle n'est pas clôturée. */
function HoraireInspection({ inspection, modifiable, onEnregistrer }: {
  inspection: Inspection
  modifiable: boolean
  onEnregistrer: (corps: { date: string, heureDebut: string, heureFin: string }) => Promise<void>
}) {
  const [jour, setJour] = useState(inspection.date_inspection)
  const [debut, setDebut] = useState(inspection.heure_debut ?? '')
  const [fin, setFin] = useState(inspection.heure_fin ?? '')
  const [enCours, setEnCours] = useState(false)
  const change = jour !== inspection.date_inspection || debut !== (inspection.heure_debut ?? '') || fin !== (inspection.heure_fin ?? '')

  if (!modifiable) {
    return (
      <section className="carte">
        <span className="label">Date et horaires</span>
        <div className="intervenants__valeur">
          {dateFr(inspection.date_inspection)}
          {inspection.heure_debut ? ` · de ${inspection.heure_debut}${inspection.heure_fin ? ` à ${inspection.heure_fin}` : ''}` : <span className="intervenants__vide"> · horaires non renseignés</span>}
        </div>
      </section>
    )
  }

  return (
    <form
      className="carte"
      method="post"
      onSubmit={async (e) => {
        e.preventDefault()
        setEnCours(true)
        await onEnregistrer({ date: jour, heureDebut: debut, heureFin: fin })
        setEnCours(false)
      }}
    >
      <div className="grille-3">
        <div className="champ">
          <label htmlFor="h-jour">Jour de l’inspection</label>
          <input id="h-jour" type="date" className="saisie" value={jour} required onChange={(e) => setJour(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="h-debut">Heure de début</label>
          <input id="h-debut" type="time" className="saisie" value={debut} onChange={(e) => setDebut(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="h-fin">Heure de fin</label>
          <input id="h-fin" type="time" className="saisie" value={fin} min={debut || undefined} disabled={!debut} onChange={(e) => setFin(e.target.value)} />
        </div>
      </div>
      {change && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="submit" className="bouton bouton--petit" disabled={enCours || !jour}>{enCours ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      )}
    </form>
  )
}
