'use client'

import { useEffect, useMemo, useState } from 'react'
import { ficheDe } from '@/formations/catalogue'
import { api, messageErreur } from '@/ui/api'
import { IconeAlerte, IconeHorloge, IconePersonne, IconePlus, IconeSortie } from '@/ui/icones'

interface Ligne {
  entreprise_id: string
  nom: string
  statut_relation: 'client' | 'prospect'
  inspections_en_cours: number
  inspections_terminees_90j: number
  taux_conformite_90j: number | null
  nc_critique: number
  nc_majeure: number
  nc_mineure: number
  actions_ouvertes: number
  actions_en_retard: number
  equipements_en_retard: number
  comptes_actifs: number
  noms_comptes: string | null
  services_souhaites: string[]
  formations_souhaitees: string[]
  notes_nb: number
  derniere_note: string | null
}

const LIBELLE_SERVICE: Record<string, string> = { inspection: 'Inspection', formation: 'Formation', audit: 'Audit', conseil: 'Conseil' }

type Filtre = 'tous' | 'compte' | 'client' | 'prospect' | 'attention'
const pct = (t: number | null) => (t == null ? '—' : `${Math.round(t * 100)} %`)
const attention = (l: Ligne) => l.nc_critique > 0 || l.actions_en_retard > 0 || l.equipements_en_retard > 0

/**
 * Tableau commun au consultant et à l'administrateur : tous leurs clients et
 * prospects d'un coup d'œil. Le périmètre (tout pour l'administrateur, les
 * accès valides pour le consultant) est décidé en base ; un clic sur une
 * ligne ouvre l'entreprise, avec le contrôle d'accès habituel.
 */
export default function PageVueEnsemble() {
  const [d, setD] = useState<{ administrateur: boolean, entreprises: Ligne[] } | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [filtre, setFiltre] = useState<Filtre>('tous')
  const [ouverture, setOuverture] = useState<string | null>(null)

  useEffect(() => {
    api<{ administrateur: boolean, entreprises: Ligne[] }>('/api/vue-ensemble').then(setD).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/inspections')
      setErreur(messageErreur(e))
    })
  }, [])

  const lignes = d?.entreprises ?? []
  const totaux = useMemo(() => ({
    entreprises: lignes.length,
    nc: lignes.reduce((n, l) => n + l.nc_critique + l.nc_majeure + l.nc_mineure, 0),
    critiques: lignes.reduce((n, l) => n + l.nc_critique, 0),
    retard: lignes.reduce((n, l) => n + l.actions_en_retard, 0),
    enCours: lignes.reduce((n, l) => n + l.inspections_en_cours, 0),
  }), [lignes])

  const affichees = lignes.filter((l) => filtre === 'tous' || (filtre === 'compte' ? l.comptes_actifs > 0 : filtre === 'attention' ? attention(l) : l.statut_relation === filtre))

  /** Ouvre l'entreprise (contrôle d'accès habituel côté serveur) : direct sur une nouvelle inspection, ou sur son tableau de bord. */
  async function ouvrir(l: Ligne, but: 'inspection' | 'tableau') {
    setErreur(null)
    setOuverture(l.entreprise_id)
    try {
      await api('/api/auth/entreprise', { method: 'POST', corps: { entrepriseId: l.entreprise_id } })
      const ctx = await api<{ tableauDeBord: boolean, peutConduire: boolean }>('/api/inspections/contexte')
      if (but === 'inspection') window.location.assign(ctx.peutConduire ? '/inspections/nouvelle' : '/inspections')
      else window.location.assign(ctx.tableauDeBord ? '/tableau-de-bord' : '/inspections')
    } catch (e) {
      setErreur(messageErreur(e))
      setOuverture(null)
    }
  }

  async function passerEnClient(l: Ligne) {
    if (!window.confirm(`Passer « ${l.nom} » en client ? Ses inspections, comptes et équipements sont conservés.`)) return
    setErreur(null)
    setOuverture(l.entreprise_id)
    try {
      await api(`/api/auth/entreprises/${l.entreprise_id}`, { method: 'PATCH', corps: {} })
      setD((x) => x && { ...x, entreprises: x.entreprises.map((e) => (e.entreprise_id === l.entreprise_id ? { ...e, statut_relation: 'client' } : e)) })
    } catch (e) {
      setErreur(messageErreur(e))
    } finally {
      setOuverture(null)
    }
  }

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte">
              <span className="marque__nom">IFECARM GROUP</span>
              <span className="marque__sous">Plateforme QHSE</span>
            </span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/opportunites" title="Échéances des clients à vendre"><span className="libelle">À relancer</span></a>
            <a className="lien-entete" href="/mini-audits" title="Demandes du mini-audit gratuit"><span className="libelle">Mini-audits</span></a>
            <a className="lien-entete" href="/prospects/nouveau" title="Nouveau prospect"><IconePlus className="icone" /><span className="libelle">Prospect</span></a>
            {d?.administrateur && <a className="lien-entete" href="/administration" title="Clients, modules et accès"><span className="libelle">Administration</span></a>}
            <a className="lien-entete" href="/pays" title="Pays d’intervention"><span className="libelle">Pays</span></a>
            <a className="lien-entete" href="/entreprises" title="Choisir une entreprise"><span className="libelle">Entreprises</span></a>
            <a className="lien-entete" href="/mon-compte" title="Mon compte"><span className="libelle">Mon compte</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter} title="Se déconnecter"><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Vue d’ensemble</div>
            <h1>Clients et prospects</h1>
            <p className="tete-page__desc">
              {d?.administrateur ? 'Toutes les entreprises de la plateforme' : 'Les entreprises pour lesquelles votre accès est en cours'}
              {' '}: choisissez une entreprise pour démarrer son inspection.
            </p>
          </div>
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {!d && !erreur && <div aria-busy="true" className="tuiles">{[1, 2, 3, 4].map((k) => <div key={k} className="squelette" style={{ height: 84 }} />)}</div>}

        {d && (
          <>
            <section className="tuiles" aria-label="Synthèse">
              <div className="tuile tuile--bleu"><div className="tuile__valeur">{totaux.entreprises}</div><div className="tuile__libelle">Entreprise{totaux.entreprises > 1 ? 's' : ''} suivie{totaux.entreprises > 1 ? 's' : ''}</div></div>
              <div className={`tuile ${totaux.critiques ? 'tuile--rouge' : 'tuile--orange'}`}>
                <div className="tuile__valeur">{totaux.nc}</div>
                <div className="tuile__libelle">Non-conformités ouvertes{totaux.critiques > 0 && ` · ${totaux.critiques} critique${totaux.critiques > 1 ? 's' : ''}`}</div>
              </div>
              <div className={`tuile ${totaux.retard ? 'tuile--rouge' : 'tuile--vert'}`}><div className="tuile__valeur">{totaux.retard}</div><div className="tuile__libelle">Actions en retard</div></div>
              <div className="tuile tuile--bleu"><div className="tuile__valeur">{totaux.enCours}</div><div className="tuile__libelle">Inspections en cours</div></div>
            </section>

            <div className="onglets" role="group" aria-label="Filtrer les entreprises" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
              {([['tous', 'Toutes'], ['compte', 'Avec un compte'], ['client', 'Clients'], ['prospect', 'Prospects'], ['attention', 'À surveiller']] as [Filtre, string][]).map(([f, t]) => (
                <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>{t}</button>
              ))}
            </div>

            {lignes.length === 0 && (
              <div className="vide">
                <h2>Aucune entreprise pour l’instant</h2>
                <p>Créez un prospect pour démarrer votre première inspection.</p>
                <a className="bouton" href="/prospects/nouveau"><IconePlus /> Nouveau prospect</a>
              </div>
            )}

            <div className="inspections">
              {affichees.map((l) => (
                <div key={l.entreprise_id} className="inspection-ligne rangee-entreprise">
                  <div>
                    <div className="inspection-ligne__titre">
                      {l.nom} <span className={`badge ${l.statut_relation === 'prospect' ? 'badge--prospect' : 'badge--vert'}`}>{l.statut_relation === 'prospect' ? 'Prospect' : 'Client'}</span>
                    </div>
                    <div className="inspection-ligne__meta">
                      {l.comptes_actifs > 0
                        ? <span><IconePersonne />{l.comptes_actifs} compte{l.comptes_actifs > 1 ? 's' : ''} : {l.noms_comptes}</span>
                        : <span className="texte-discret"><IconePersonne />Aucun compte pour l’instant</span>}
                    </div>
                    {l.derniere_note && (
                      <p className="derniere-note" title={l.derniere_note}>
                        <strong>Dernière note{l.notes_nb > 1 ? ` (sur ${l.notes_nb})` : ''} :</strong> {l.derniere_note}
                      </p>
                    )}
                    <div className="inspection-ligne__badges">
                      {l.services_souhaites.map((x) => <span key={x} className="badge badge--bleu">{LIBELLE_SERVICE[x] ?? x}</span>)}
                      {l.formations_souhaitees.length > 0 && (
                        <span className="badge badge--bleu" title={l.formations_souhaitees.map((x) => ficheDe(x)?.titre ?? x).join(' · ')}>
                          {l.formations_souhaitees.length} formation{l.formations_souhaitees.length > 1 ? 's' : ''} souhaitée{l.formations_souhaitees.length > 1 ? 's' : ''}
                        </span>
                      )}
                      <span className="badge badge--neutre">Conformité 90 j : {pct(l.taux_conformite_90j)}</span>
                      {l.nc_critique > 0 && <span className="badge gravite--critique">{l.nc_critique} critique{l.nc_critique > 1 ? 's' : ''}</span>}
                      {l.nc_majeure > 0 && <span className="badge gravite--majeure">{l.nc_majeure} majeure{l.nc_majeure > 1 ? 's' : ''}</span>}
                      {l.nc_mineure > 0 && <span className="badge gravite--mineure">{l.nc_mineure} mineure{l.nc_mineure > 1 ? 's' : ''}</span>}
                      {l.actions_en_retard > 0 && <span className="badge badge--rouge"><IconeHorloge />{l.actions_en_retard} action{l.actions_en_retard > 1 ? 's' : ''} en retard</span>}
                      {l.equipements_en_retard > 0 && <span className="badge badge--rouge"><IconeAlerte />{l.equipements_en_retard} vérification{l.equipements_en_retard > 1 ? 's' : ''} d’équipement</span>}
                      {l.inspections_en_cours > 0 && <span className="badge badge--bleu">{l.inspections_en_cours} inspection{l.inspections_en_cours > 1 ? 's' : ''} en cours</span>}
                    </div>
                  </div>
                  <div className="equipement-actions">
                    <button type="button" className="bouton bouton--petit" disabled={ouverture !== null} onClick={() => ouvrir(l, 'inspection')}>
                      <IconePlus /> Démarrer une inspection
                    </button>
                    <button type="button" className="bouton bouton--secondaire bouton--petit" disabled={ouverture !== null} onClick={() => ouvrir(l, 'tableau')}>
                      Tableau de bord
                    </button>
                    {d.administrateur && l.statut_relation === 'prospect' && (
                      <button type="button" className="lien-action" disabled={ouverture !== null} onClick={() => passerEnClient(l)}>
                        Passer en client
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {lignes.length > 0 && affichees.length === 0 && <p className="texte-discret">Aucune entreprise dans cette catégorie.</p>}
            </div>
          </>
        )}
      </main>
    </>
  )
}
