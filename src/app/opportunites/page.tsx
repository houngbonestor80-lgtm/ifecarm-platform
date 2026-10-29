'use client'

import { useEffect, useMemo, useState } from 'react'
import { messageRelance, sujetRelance } from '@/opportunites/messages'
import { api, messageErreur } from '@/ui/api'
import EnteteEquipe from '@/ui/EnteteEquipe'
import { dateCourteFr } from '@/ui/libelles'
import { lienWhatsApp } from '@/ui/whatsapp'

/**
 * Opportunités de vente (migration 0053) : les échéances des clients (recyclages, habilitations, vérifications
 * d'équipements) à vendre, avec un message WhatsApp prérédigé. Équipe IFECARM seulement.
 */

interface Opportunite {
  entreprise_id: string, entreprise_nom: string, statut_relation: string, pays: string
  contact_nom: string | null, contact_telephone: string | null, contact_email: string | null
  type: 'recyclage' | 'habilitation' | 'verification', cle: string, libelle: string, nb: number
  premiere_echeance: string, derniere_echeance: string, echues: number
  suivi_statut: 'contacte' | 'gagne' | 'perdu' | 'plus_tard' | null, suivi_le: string | null, suivi_par: string | null, suivi_note: string | null
}

type Filtre = 'a_relancer' | 'contacte' | 'clos' | 'toutes'
const LIBELLE_TYPE = { recyclage: ['Recyclage formation', 'badge--bleu'], habilitation: ['Habilitation', 'badge--orange'], verification: ['Vérification équipement', 'badge--neutre'] } as const
const LIBELLE_SUIVI = { contacte: ['Contacté', 'badge--bleu'], gagne: ['Gagné', 'badge--vert'], perdu: ['Perdu', 'badge--rouge'], plus_tard: ['Plus tard', 'badge--neutre'] } as const
const garder = (f: Filtre, o: Opportunite) =>
  f === 'toutes' || (f === 'a_relancer' ? !o.suivi_statut : f === 'contacte' ? o.suivi_statut === 'contacte' : o.suivi_statut === 'gagne' || o.suivi_statut === 'perdu' || o.suivi_statut === 'plus_tard')
const joursAvant = (iso: string) => Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86_400_000)

export default function PageOpportunites() {
  const [d, setD] = useState<{ administrateur: boolean, opportunites: Opportunite[] } | null>(null)
  const [horizon, setHorizon] = useState(90)
  const [filtre, setFiltre] = useState<Filtre>('a_relancer')
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState<string | null>(null)

  const charger = (h = horizon) => api<{ administrateur: boolean, opportunites: Opportunite[] }>(`/api/opportunites?horizon=${h}`).then(setD).catch((e) => {
    if ((e as { statut?: number }).statut === 403) return window.location.assign('/inspections')
    setErreur(messageErreur(e))
  })
  useEffect(() => { charger() }, [])

  const liste = useMemo(() => (d?.opportunites ?? []).filter((o) => garder(filtre, o)), [d, filtre])
  const compte = (f: Filtre) => (d?.opportunites ?? []).filter((o) => garder(f, o)).length
  const cleDe = (o: Opportunite) => `${o.entreprise_id}|${o.type}|${o.cle}`

  async function suivre(o: Opportunite, statut: string, note?: string) {
    setErreur(null)
    setEnCours(cleDe(o))
    try {
      await api('/api/opportunites/suivi', { method: 'POST', corps: { entrepriseId: o.entreprise_id, type: o.type, cle: o.cle, statut, note } })
      await charger()
    } catch (e) { setErreur(messageErreur(e)) } finally { setEnCours(null) }
  }

  return (
    <>
      <EnteteEquipe administrateur={d?.administrateur} courant="/opportunites" />
      <main className="contenu">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Ventes</div>
            <h1>Clients à relancer</h1>
            <p className="tete-page__desc">
              Les recyclages, habilitations et vérifications qui arrivent à échéance chez vos clients. Chaque échéance est une vente
              à proposer : le message WhatsApp est déjà écrit, vous le relisez et l’envoyez.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div className="onglets" role="group" aria-label="Filtre">
            {([['a_relancer', 'À relancer'], ['contacte', 'Contactés'], ['clos', 'Traités'], ['toutes', 'Toutes']] as const).map(([f, t]) => (
              <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>{t} ({compte(f)})</button>
            ))}
          </div>
          <label className="texte-discret" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            Échéances dans les
            <select className="select-statut" value={horizon} onChange={(e) => { const h = Number(e.target.value); setHorizon(h); charger(h) }}>
              {[30, 60, 90, 180, 365].map((h) => <option key={h} value={h}>{h} jours</option>)}
            </select>
          </label>
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {!d && !erreur && <div aria-busy="true" className="squelette" style={{ height: 120 }} />}
        {d && !liste.length && <div className="vide">Aucune opportunité ici pour cette période.</div>}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {liste.map((o) => {
            const message = messageRelance(o)
            const whatsapp = lienWhatsApp(o.contact_telephone, o.pays, message)
            const jours = joursAvant(o.premiere_echeance)
            const occupe = enCours === cleDe(o)
            return (
              <li key={cleDe(o)} className="carte">
                <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{o.entreprise_nom}{o.statut_relation === 'prospect' && <span className="badge badge--prospect" style={{ marginLeft: 8 }}>Prospect</span>}</h2>
                    <p style={{ margin: '4px 0 0' }}><strong>{o.libelle}</strong> · {o.nb} {o.type === 'verification' ? `équipement${o.nb > 1 ? 's' : ''}` : `salarié${o.nb > 1 ? 's' : ''}`}</p>
                    <div className="texte-discret">
                      {o.contact_nom ?? 'Contact de l’entreprise'}{o.contact_telephone ? ` · ${o.contact_telephone}` : ''}{o.contact_email ? ` · ${o.contact_email}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={`badge ${LIBELLE_TYPE[o.type][1]}`}>{LIBELLE_TYPE[o.type][0]}</span>
                    <span className={`badge ${o.echues > 0 ? 'badge--rouge' : jours <= 30 ? 'badge--orange' : 'badge--neutre'}`}>
                      {o.echues > 0 ? `${o.echues} échu${o.echues > 1 ? 's' : ''}` : `dans ${jours} j`} · {dateCourteFr(o.premiere_echeance)}
                    </span>
                    {o.suivi_statut && <span className={`badge ${LIBELLE_SUIVI[o.suivi_statut][1]}`}>{LIBELLE_SUIVI[o.suivi_statut][0]}</span>}
                  </div>
                </div>
                {o.suivi_statut && <p className="texte-discret" style={{ margin: '8px 0 0' }}>{LIBELLE_SUIVI[o.suivi_statut][0]} par {o.suivi_par} le {dateCourteFr(o.suivi_le)}{o.suivi_note ? ` : « ${o.suivi_note} »` : ''}</p>}
                <details style={{ marginTop: 10 }}>
                  <summary className="lien-action" style={{ cursor: 'pointer' }}>Voir le message prérédigé</summary>
                  <p style={{ whiteSpace: 'pre-line', margin: '8px 0 0' }}>{message}</p>
                </details>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
                  {whatsapp
                    ? <a className="bouton bouton--petit" href={whatsapp} target="_blank" rel="noreferrer" onClick={() => !o.suivi_statut && suivre(o, 'contacte')}>WhatsApp</a>
                    : <span className="texte-discret" title="Ajoutez un téléphone à l’entreprise ou à son responsable">Pas de numéro</span>}
                  {o.contact_email && <a className="bouton bouton--secondaire bouton--petit" href={`mailto:${o.contact_email}?subject=${encodeURIComponent(sujetRelance(o))}&body=${encodeURIComponent(message)}`} onClick={() => !o.suivi_statut && suivre(o, 'contacte')}>E-mail</a>}
                  {!o.suivi_statut && <button type="button" className="bouton bouton--discret bouton--petit" disabled={occupe} onClick={() => suivre(o, 'contacte')}>Marquer contacté</button>}
                  <button type="button" className="bouton bouton--discret bouton--petit" disabled={occupe} onClick={() => { const n = window.prompt('Gagné : précisez si besoin (montant, date de session…)'); if (n !== null) suivre(o, 'gagne', n) }}>Gagné</button>
                  <button type="button" className="bouton bouton--discret bouton--petit" disabled={occupe} onClick={() => suivre(o, 'plus_tard')}>Plus tard</button>
                  <button type="button" className="lien-action lien-action--rouge" disabled={occupe} onClick={() => { const n = window.prompt('Perdu : pour quelle raison ?'); if (n !== null) suivre(o, 'perdu', n) }}>Perdu</button>
                </div>
              </li>
            )
          })}
        </ul>
      </main>
    </>
  )
}
