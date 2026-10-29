'use client'

import { useEffect, useMemo, useState } from 'react'
import { classeScore } from '@/autodiagnostic/classes'
import { api, messageErreur } from '@/ui/api'
import EnteteEquipe from '@/ui/EnteteEquipe'
import { dateCourteFr } from '@/ui/libelles'
import { lienWhatsApp } from '@/ui/whatsapp'

/**
 * Demandes du mini-audit gratuit (migration 0052), pour l'équipe IFECARM : rappeler (WhatsApp prérédigé, e-mail),
 * suivre, convertir en prospect. Jamais visible d'un client (RLS).
 */

interface Demande {
  id: string, code_suivi: string, referentiel_titre: string, score_global: number, niveau_libelle: string
  nom_contact: string, fonction: string | null, entreprise_nom: string, email: string, telephone: string | null
  pays: string, secteur: string | null, effectif: string | null, cree_le: string
  statut: 'nouveau' | 'contacte' | 'converti' | 'sans_suite', suivi_le: string | null, entreprise_id: string | null, prospect_nom: string | null
  resultat: { recommendations: { texte: string }[] }
}

type Filtre = 'a_traiter' | 'converti' | 'sans_suite' | 'tous'
const LIBELLE_STATUT: Record<Demande['statut'], [string, string]> = {
  nouveau: ['Nouveau', 'badge--orange'], contacte: ['Contacté', 'badge--bleu'], converti: ['Converti en prospect', 'badge--vert'], sans_suite: ['Sans suite', 'badge--neutre'],
}

const messageRappel = (d: Demande) => [
  `Bonjour ${d.nom_contact},`,
  `Merci d'avoir fait le mini-audit QHSE d'IFECARM GROUP. ${d.entreprise_nom} obtient ${d.score_global} % (${d.niveau_libelle}).`,
  d.resultat.recommendations[0] ? `Votre première priorité : ${d.resultat.recommendations[0].texte}` : '',
  'Je vous propose un échange de 20 minutes pour en parler et voir comment vous accompagner. Quand êtes-vous disponible ?',
].filter(Boolean).join('\n\n')

export default function PageMiniAudits() {
  const [demandes, setDemandes] = useState<Demande[] | null>(null)
  const [administrateur, setAdministrateur] = useState(false)
  const [filtre, setFiltre] = useState<Filtre>('a_traiter')
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState<string | null>(null)

  const charger = () => api<{ demandes: Demande[] }>('/api/mini-audits').then((d) => setDemandes(d.demandes)).catch((e) => {
    if ((e as { statut?: number }).statut === 403) return window.location.assign('/inspections')
    setErreur(messageErreur(e))
  })
  useEffect(() => {
    charger()
    api<{ roles?: string[] }>('/api/auth/moi').then((m) => setAdministrateur(Boolean(m.roles?.includes('admin_plateforme')))).catch(() => {})
  }, [])

  const visibles = useMemo(() => (demandes ?? []).filter((d) =>
    filtre === 'tous' || (filtre === 'a_traiter' ? d.statut === 'nouveau' || d.statut === 'contacte' : d.statut === filtre)), [demandes, filtre])
  const compte = (f: Filtre) => (demandes ?? []).filter((d) => f === 'tous' || (f === 'a_traiter' ? d.statut === 'nouveau' || d.statut === 'contacte' : d.statut === f)).length

  async function agir(id: string, action: () => Promise<unknown>) {
    setErreur(null)
    setEnCours(id)
    try { await action(); await charger() } catch (e) { setErreur(messageErreur(e)) } finally { setEnCours(null) }
  }
  const suivre = (d: Demande, statut: string) => agir(d.id, () => api(`/api/mini-audits/${d.id}/statut`, { method: 'POST', corps: { statut } }))
  const convertir = (d: Demande) => {
    if (!window.confirm(`Créer le prospect « ${d.entreprise_nom} » et y entrer ?`)) return
    agir(d.id, async () => {
      const r = await api<{ destination: string }>(`/api/mini-audits/${d.id}/convertir`, { method: 'POST', corps: {} })
      window.location.assign(r.destination)
    })
  }

  return (
    <>
      <EnteteEquipe administrateur={administrateur} courant="/mini-audits" />
      <main className="contenu">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Prospection</div>
            <h1>Demandes du mini-audit gratuit</h1>
            <p className="tete-page__desc">
              Les entreprises qui ont fait le mini-audit sur <a href="/mini-audit" target="_blank" rel="noreferrer">la page publique</a>.
              Rappelez-les vite : un prospect qui vient de voir son score est au plus chaud.
            </p>
          </div>
        </div>

        <div className="onglets" role="group" aria-label="Filtre" style={{ marginBottom: 14 }}>
          {([['a_traiter', 'À traiter'], ['converti', 'Convertis'], ['sans_suite', 'Sans suite'], ['tous', 'Toutes']] as const).map(([f, t]) => (
            <button key={f} type="button" aria-pressed={filtre === f} onClick={() => setFiltre(f)}>{t} ({compte(f)})</button>
          ))}
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {!demandes && !erreur && <div aria-busy="true" className="squelette" style={{ height: 120 }} />}
        {demandes && !visibles.length && <div className="vide">Aucune demande ici pour le moment.</div>}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {visibles.map((d) => {
            const whatsapp = lienWhatsApp(d.telephone, d.pays, messageRappel(d))
            const ouverte = d.statut === 'nouveau' || d.statut === 'contacte'
            return (
              <li key={d.id} className="carte">
                <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{d.entreprise_nom}</h2>
                    <div className="texte-discret">
                      {d.nom_contact}{d.fonction ? `, ${d.fonction}` : ''} · {d.pays}{d.secteur ? ` · ${d.secteur}` : ''}{d.effectif ? ` · ${d.effectif} salariés` : ''}
                    </div>
                    <div className="texte-discret">
                      <a href={`mailto:${d.email}`}>{d.email}</a>{d.telephone ? ` · ${d.telephone}` : ''} · le {dateCourteFr(d.cree_le)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={`badge ${classeScore(d.score_global)}`}>{d.score_global} % · {d.niveau_libelle}</span>
                    <span className={`badge ${LIBELLE_STATUT[d.statut][1]}`}>{LIBELLE_STATUT[d.statut][0]}</span>
                  </div>
                </div>
                {d.resultat.recommendations[0] && <p style={{ margin: '10px 0 0' }}><strong>Priorité n° 1 :</strong> {d.resultat.recommendations[0].texte}</p>}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  {whatsapp
                    ? <a className="bouton bouton--petit" href={whatsapp} target="_blank" rel="noreferrer" onClick={() => d.statut === 'nouveau' && suivre(d, 'contacte')}>WhatsApp</a>
                    : <span className="texte-discret" title="Numéro absent ou inexploitable">Pas de WhatsApp</span>}
                  <a className="bouton bouton--secondaire bouton--petit" href={`mailto:${d.email}?subject=${encodeURIComponent(`Votre mini-audit QHSE (${d.score_global} %)`)}&body=${encodeURIComponent(messageRappel(d))}`}>E-mail</a>
                  <a className="bouton bouton--discret bouton--petit" href={`/mini-audit/${d.code_suivi}`} target="_blank" rel="noreferrer">Voir le résultat</a>
                  {d.statut === 'nouveau' && <button type="button" className="bouton bouton--discret bouton--petit" disabled={enCours === d.id} onClick={() => suivre(d, 'contacte')}>Marquer contacté</button>}
                  {ouverte && <button type="button" className="bouton bouton--petit" disabled={enCours === d.id} onClick={() => convertir(d)}>Convertir en prospect</button>}
                  {ouverte && <button type="button" className="lien-action lien-action--rouge" disabled={enCours === d.id} onClick={() => window.confirm('Classer cette demande sans suite ? C’est définitif.') && suivre(d, 'sans_suite')}>Sans suite</button>}
                  {d.statut === 'converti' && d.prospect_nom && <span className="texte-discret">Prospect créé : {d.prospect_nom}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      </main>
    </>
  )
}
