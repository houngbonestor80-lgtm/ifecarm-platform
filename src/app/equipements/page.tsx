'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { Photos } from '@/ui/Photos'
import { NotesInternes } from '@/ui/NotesInternes'
import { useContexteApp } from '@/ui/CadreApplication'
import ChoixSite, { corpsSite } from '@/ui/ChoixSite'
import { IconeBatiment, IconeCalendrier, IconeCoche, IconeHorloge, IconeListe, IconeOutil, IconePersonne, IconePlus } from '@/ui/icones'
import { dateCourteFr } from '@/ui/libelles'

interface Equipement {
  id: string
  type: string
  designation: string
  numero_serie: string | null
  site_id: string | null
  site_nom: string | null
  affecte_a: string | null
  date_mise_service: string | null
  periodicite_mois: number | null
  derniere_verif: string | null
  prochaine_verif: string | null
  actif: boolean
  inspections: number
  photos: { id: string, nom: string }[]
}
interface Donnees { equipements: Equipement[], sites: { id: string, nom: string }[], peutGerer: boolean }

type Filtre = 'tous' | 'retard' | 'bientot' | 'epi' | 'retires'
const TYPES = ['EPI', 'Extincteur', 'Appareil de levage', 'Installation électrique', 'Échafaudage', 'Engin de manutention', 'Équipement sous pression']
const FORMULAIRE_VIDE = {
  type: '', designation: '', numeroSerie: '', affecteA: '', siteId: '', siteNom: '', siteVille: '',
  dateMiseService: '', periodiciteMois: '', derniereVerif: '', prochaineVerif: '',
}

const aujourdHui = () => new Date().toLocaleDateString('sv-SE')
const dans30j = () => new Date(Date.now() + 30 * 86400e3).toLocaleDateString('sv-SE')
const estEpi = (e: Equipement) => /\bepi\b/i.test(e.type)

function etat(e: Equipement): { texte: string, classe: string, cle: 'retard' | 'bientot' | 'ok' | 'sans' } {
  if (!e.prochaine_verif) return { texte: 'Sans échéance', classe: 'badge--neutre', cle: 'sans' }
  if (e.prochaine_verif < aujourdHui()) return { texte: 'Vérification en retard', classe: 'badge--rouge', cle: 'retard' }
  if (e.prochaine_verif <= dans30j()) return { texte: 'À vérifier sous 30 jours', classe: 'badge--orange', cle: 'bientot' }
  return { texte: 'À jour', classe: 'badge--vert', cle: 'ok' }
}

export default function PageEquipements() {
  const { entreprise } = useContexteApp()
  const [d, setD] = useState<Donnees | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [edition, setEdition] = useState<{ id: string | null, valeurs: typeof FORMULAIRE_VIDE } | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<Donnees>('/api/equipements').then(setD).catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(charger, [charger])

  const actifs = useMemo(() => (d?.equipements ?? []).filter((e) => e.actif), [d])
  const compte = (cle: string) => actifs.filter((e) => etat(e).cle === cle).length
  const affiches = (d?.equipements ?? []).filter((e) =>
    filtre === 'retires' ? !e.actif
      : e.actif && (filtre === 'tous' || (filtre === 'epi' ? estEpi(e) : etat(e).cle === filtre)))

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

  const ouvrir = (e?: Equipement) => setEdition(e
    ? {
      id: e.id,
      valeurs: {
        type: e.type, designation: e.designation, numeroSerie: e.numero_serie ?? '', affecteA: e.affecte_a ?? '',
        siteId: e.site_id ?? '', siteNom: '', siteVille: '', dateMiseService: e.date_mise_service ?? '', periodiciteMois: e.periodicite_mois?.toString() ?? '',
        derniereVerif: e.derniere_verif ?? '', prochaineVerif: e.prochaine_verif ?? '',
      },
    }
    : { id: null, valeurs: { ...FORMULAIRE_VIDE } })

  async function enregistrer(ev: React.FormEvent) {
    ev.preventDefault()
    if (!edition) return
    const { siteId: _s, siteNom: _n, siteVille: _v, ...reste } = edition.valeurs
    const corps = { ...reste, ...corpsSite({ siteId: edition.valeurs.siteId, siteNom: edition.valeurs.siteNom, siteVille: edition.valeurs.siteVille }) }
    const ok = await agir(() => edition.id
      ? api(`/api/equipements/${edition.id}`, { method: 'PATCH', corps })
      : api('/api/equipements', { method: 'POST', corps }))
    if (ok) setEdition(null)
  }

  const champ = (cle: keyof typeof FORMULAIRE_VIDE) => ({
    value: edition?.valeurs[cle] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setEdition((x) => x && { ...x, valeurs: { ...x.valeurs, [cle]: e.target.value } }),
  })

  return (
    <main className="contenu">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Équipements & EPI</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">
            Registre des équipements à vérifier périodiquement et des équipements de protection individuelle,
            avec leurs échéances de vérification.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {/* Rapport généré à la demande (état à date), ouvert dans un nouvel onglet. */}
          <a className="bouton bouton--secondaire" href="/api/equipements/rapport" target="_blank" rel="noopener"><IconeListe /> Rapport PDF</a>
          {d?.peutGerer && !edition && <button type="button" className="bouton" onClick={() => ouvrir()}><IconePlus /> Ajouter</button>}
        </div>
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {!d && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}

      {edition && d && (
        <form className="carte" onSubmit={enregistrer} style={{ marginBottom: 20 }}>
          <div className="carte__titre"><h2>{edition.id ? 'Modifier l’équipement' : 'Nouvel équipement'}</h2></div>
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="eq-type">Type</label>
              <input id="eq-type" className="saisie" list="eq-types" required maxLength={80} placeholder="Ex. EPI, Extincteur…" {...champ('type')} />
              <datalist id="eq-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
            </div>
            <div className="champ">
              <label htmlFor="eq-designation">Désignation</label>
              <input id="eq-designation" className="saisie" required maxLength={200} placeholder="Ex. Harnais antichute, Extincteur CO2 5 kg" {...champ('designation')} />
            </div>
            <div className="champ">
              <label htmlFor="eq-serie">N° de série <span className="aide">(facultatif)</span></label>
              <input id="eq-serie" className="saisie" maxLength={100} {...champ('numeroSerie')} />
            </div>
            <div className="champ">
              <label htmlFor="eq-affecte">Affecté à <span className="aide">(porteur de l’EPI, service…)</span></label>
              <input id="eq-affecte" className="saisie" maxLength={200} {...champ('affecteA')} />
            </div>
            <ChoixSite id="eq-site" sites={d.sites} valeur={{ siteId: edition.valeurs.siteId, siteNom: edition.valeurs.siteNom, siteVille: edition.valeurs.siteVille }}
              onChange={(v) => setEdition({ ...edition, valeurs: { ...edition.valeurs, ...v } })} />
            <div className="champ">
              <label htmlFor="eq-mes">Mise en service <span className="aide">(facultatif)</span></label>
              <input id="eq-mes" type="date" className="saisie" {...champ('dateMiseService')} />
            </div>
            <div className="champ">
              <label htmlFor="eq-perio">Périodicité de vérification <span className="aide">(en mois)</span></label>
              <input id="eq-perio" type="number" min={1} max={120} inputMode="numeric" className="saisie" placeholder="Ex. 12" {...champ('periodiciteMois')} />
            </div>
            <div className="champ">
              <label htmlFor="eq-derniere">Dernière vérification</label>
              <input id="eq-derniere" type="date" className="saisie" {...champ('derniereVerif')} />
            </div>
            <div className="champ">
              <label htmlFor="eq-prochaine">Prochaine vérification <span className="aide">(calculée si vide)</span></label>
              <input id="eq-prochaine" type="date" className="saisie" {...champ('prochaineVerif')} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            <button type="submit" className="bouton" disabled={enCours}><IconeCoche /> Enregistrer</button>
            <button type="button" className="bouton bouton--secondaire" onClick={() => setEdition(null)}>Annuler</button>
          </div>
        </form>
      )}

      {d && (
        <>
          <section className="tuiles" aria-label="Indicateurs">
            <div className={`tuile ${compte('retard') ? 'tuile--rouge' : 'tuile--vert'}`}>
              <div className="tuile__valeur">{compte('retard')}</div>
              <div className="tuile__libelle">Vérification{compte('retard') > 1 ? 's' : ''} en retard</div>
            </div>
            <div className="tuile tuile--orange">
              <div className="tuile__valeur">{compte('bientot')}</div>
              <div className="tuile__libelle">À vérifier sous 30 jours</div>
            </div>
            <div className="tuile tuile--vert">
              <div className="tuile__valeur">{compte('ok')}</div>
              <div className="tuile__libelle">À jour</div>
            </div>
            <div className="tuile tuile--bleu">
              <div className="tuile__valeur">{actifs.length}</div>
              <div className="tuile__libelle">En service · dont {actifs.filter(estEpi).length} EPI</div>
            </div>
          </section>

          <div className="onglets" role="group" aria-label="Filtrer le registre" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            {([['tous', 'Tous'], ['retard', 'En retard'], ['bientot', 'Sous 30 jours'], ['epi', 'EPI'], ['retires', 'Retirés']] as [Filtre, string][]).map(([f, t]) => (
              <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>{t}</button>
            ))}
          </div>

          {d.equipements.length === 0 && (
            <div className="vide">
              <IconeOutil />
              <h2>Registre vide</h2>
              <p>Ajoutez vos extincteurs, appareils de levage, EPI… : la plateforme suit leurs échéances de vérification.</p>
              {d.peutGerer && !edition && <button type="button" className="bouton" onClick={() => ouvrir()}><IconePlus /> Ajouter un équipement</button>}
            </div>
          )}

          <div className="inspections">
            {affiches.map((e) => {
              const s = etat(e)
              return (
                <div key={e.id} className="inspection-ligne">
                  <div>
                    <div className="inspection-ligne__titre">{e.designation}</div>
                    <div className="inspection-ligne__meta">
                      <span><IconeOutil />{e.type}{e.numero_serie ? ` · n° ${e.numero_serie}` : ''}</span>
                      {e.site_nom && <span><IconeBatiment />{e.site_nom}</span>}
                      {e.affecte_a && <span><IconePersonne />{e.affecte_a}</span>}
                      {e.periodicite_mois && <span><IconeHorloge />Tous les {e.periodicite_mois} mois</span>}
                    </div>
                    <div className="inspection-ligne__badges">
                      {e.actif ? <span className={`badge ${s.classe}`}>{s.texte}</span> : <span className="badge badge--neutre">Retiré</span>}
                      {e.prochaine_verif && <span className="badge badge--neutre"><IconeCalendrier />Prochaine : {dateCourteFr(e.prochaine_verif)}</span>}
                      {e.derniere_verif && <span className="badge badge--neutre">Dernière : {dateCourteFr(e.derniere_verif)}</span>}
                    </div>
                    <Photos urlEnvoi={`/api/equipements/${e.id}/photos`} photos={e.photos} modifiable={Boolean(d.peutGerer)} onChange={charger} />
                    <NotesInternes objetType="equipement" objetId={e.id} repli />
                  </div>
                  {d.peutGerer && (
                    <div className="equipement-actions">
                      {e.actif && (
                        <button type="button" className="lien-action" disabled={enCours}
                          onClick={() => agir(() => api(`/api/equipements/${e.id}`, { method: 'PATCH', corps: { action: 'verification' } }))}>
                          <IconeCoche /> Vérifié aujourd’hui
                        </button>
                      )}
                      <button type="button" className="lien-action" disabled={enCours} onClick={() => { ouvrir(e); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Modifier</button>
                      <button type="button" className="lien-action" disabled={enCours}
                        onClick={() => agir(() => api(`/api/equipements/${e.id}`, { method: 'PATCH', corps: { action: 'actif', actif: !e.actif } }))}>
                        {e.actif ? 'Retirer du service' : 'Remettre en service'}
                      </button>
                      {e.inspections === 0 && (
                        <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
                          onClick={() => window.confirm(`Supprimer définitivement « ${e.designation} » ?`)
                            && agir(() => api(`/api/equipements/${e.id}`, { method: 'DELETE' }))}>
                          Supprimer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {d.equipements.length > 0 && affiches.length === 0 && <p className="texte-discret">Aucun équipement dans cette catégorie.</p>}
          </div>
        </>
      )}
    </main>
  )
}
