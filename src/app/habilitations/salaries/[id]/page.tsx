'use client'

import { use, useCallback, useEffect, useState } from 'react'
import { api, envoyerFormulaire, messageErreur } from '@/ui/api'
import { IconeCoche, IconeCroix, IconePlus } from '@/ui/icones'
import { dateFr, LIBELLE_ETAT_HABILITATION } from '@/ui/libelles'
import { FormTitre, type AttestationSalarie, type TypeHab } from '@/habilitations/FormTitre'

interface Titre {
  id: string, type_id: string, type_code: string, type_intitule: string, niveau: string | null, reference_titre: string | null, delivre_par: string | null
  date_delivrance: string, date_validite: string | null, statut: string, etat: string, jours_restants: number | null, motif: string | null
  commentaire: string | null, renouvelle_id: string | null, attestation_id: string | null, attestation_intitule: string | null, fichier_id: string | null, cree_le: string
}
interface Fiche {
  salarie: { id: string, nom: string, prenom: string, poste: string | null, service: string | null, matricule: string | null, site_nom: string | null, actif: boolean }
  titres: Titre[]
}
interface Contexte { equipe: boolean, responsable: boolean, types: TypeHab[] }
type Ouvert = { mode: 'creation' } | { mode: 'renouvellement' | 'edition', titre: Titre } | null

/** Fiche d'un salarié : titres en cours, historique des titres remplacés ou retirés, ajout, correction, renouvellement. */
export default function PageFicheSalarie({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [fiche, setFiche] = useState<Fiche | null>(null)
  const [ctx, setCtx] = useState<Contexte | null>(null)
  const [attestations, setAttestations] = useState<AttestationSalarie[]>([])
  const [ouvert, setOuvert] = useState<Ouvert>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<Fiche>(`/api/habilitations/salaries/${id}`).then((r) => { setFiche(r); setErreur(null) }).catch((e) => setErreur(messageErreur(e)))
  }, [id])
  useEffect(() => { charger() }, [charger])
  useEffect(() => { api<Contexte>('/api/habilitations/contexte').then(setCtx).catch(() => {}) }, [])
  useEffect(() => {
    if (ctx?.equipe) api<{ attestations: AttestationSalarie[] }>(`/api/habilitations/salaries/${id}/attestations`).then((r) => setAttestations(r.attestations)).catch(() => {})
  }, [ctx?.equipe, id])

  async function agir(fn: () => Promise<unknown>): Promise<boolean> {
    setErreur(null); setEnCours(true)
    try { await fn(); charger(); return true } catch (e) { setErreur(messageErreur(e)); return false } finally { setEnCours(false) }
  }

  if (!fiche) {
    return <main className="contenu contenu--etroit">{erreur ? <div className="alerte alerte--erreur" role="alert">{erreur}</div> : <div className="squelette" style={{ height: 120 }} aria-busy="true" />}</main>
  }
  const { salarie, titres } = fiche
  const equipe = ctx?.equipe === true
  const enCoursListe = titres.filter((t) => t.statut === 'active' || t.statut === 'suspendue')
  const historique = titres.filter((t) => t.statut === 'remplacee' || t.statut === 'retiree')

  const valider = (corps: Record<string, unknown>) => {
    if (!ouvert) return Promise.resolve(false)
    const requete = ouvert.mode === 'creation' ? api('/api/habilitations', { method: 'POST', corps: { ...corps, salarieId: id } })
      : ouvert.mode === 'renouvellement' ? api(`/api/habilitations/${ouvert.titre.id}/renouvellement`, { method: 'POST', corps })
      : api(`/api/habilitations/${ouvert.titre.id}`, { method: 'PATCH', corps })
    return agir(() => requete).then((ok) => { if (ok) setOuvert(null); return ok })
  }

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/habilitations">Habilitations</a> / {salarie.prenom} {salarie.nom}</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Fiche salarié</div>
          <h1>{salarie.prenom} {salarie.nom.toUpperCase()}</h1>
          <div className="inspection-ligne__meta" style={{ marginTop: 8 }}>
            {salarie.poste && <span>{salarie.poste}</span>}
            {salarie.service && <span>{salarie.service}</span>}
            {salarie.site_nom && <span>{salarie.site_nom}</span>}
            {salarie.matricule && <span>Matricule {salarie.matricule}</span>}
            {!salarie.actif && <span className="badge badge--neutre">Hors effectif</span>}
          </div>
        </div>
        {equipe && !ouvert && <button type="button" className="bouton" onClick={() => setOuvert({ mode: 'creation' })}><IconePlus /> Ajouter une habilitation</button>}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      {ouvert?.mode === 'creation' && ctx && (
        <FormTitre mode="creation" types={ctx.types} attestations={attestations} enCours={enCours} onValider={valider} onAnnuler={() => setOuvert(null)} />
      )}

      <section style={{ marginTop: 18 }}>
        <div className="carte__titre"><h2>Titres en cours ({enCoursListe.length})</h2></div>
        {enCoursListe.length === 0 && <p className="texte-discret">Aucune habilitation en cours.</p>}
        <div className="pile">
          {enCoursListe.map((t) => (
            <CarteTitre key={t.id} t={t} equipe={equipe} enCours={enCours} agir={agir}
              ouvert={ouvert?.mode !== 'creation' && ouvert?.titre.id === t.id ? ouvert.mode : null}
              onOuvrir={(mode) => setOuvert({ mode, titre: t })}>
              {ouvert && ouvert.mode !== 'creation' && ouvert.titre.id === t.id && ctx && (
                <FormTitre mode={ouvert.mode} types={ctx.types} attestations={ouvert.mode === 'renouvellement' ? attestations : []} enCours={enCours} onValider={valider} onAnnuler={() => setOuvert(null)}
                  initial={ouvert.mode === 'edition'
                    ? { niveau: t.niveau ?? '', referenceTitre: t.reference_titre ?? '', delivrePar: t.delivre_par ?? '', dateDelivrance: t.date_delivrance, dateValidite: t.date_validite, commentaire: t.commentaire ?? '' }
                    : { typeId: t.type_id, niveau: t.niveau ?? '', delivrePar: t.delivre_par ?? '' }} />
              )}
            </CarteTitre>
          ))}
        </div>
      </section>

      {historique.length > 0 && (
        <details style={{ marginTop: 22 }}>
          <summary className="lien-action" style={{ cursor: 'pointer' }}>Historique : titres remplacés ou retirés ({historique.length})</summary>
          <div className="pile" style={{ marginTop: 12 }}>
            {historique.map((t) => <CarteTitre key={t.id} t={t} equipe={false} enCours={enCours} agir={agir} ouvert={null} onOuvrir={() => {}} />)}
          </div>
        </details>
      )}
    </main>
  )
}

function CarteTitre({ t, equipe, enCours, agir, ouvert, onOuvrir, children }: {
  t: Titre, equipe: boolean, enCours: boolean, agir: (fn: () => Promise<unknown>) => Promise<boolean>
  ouvert: 'renouvellement' | 'edition' | null, onOuvrir: (mode: 'renouvellement' | 'edition') => void, children?: React.ReactNode
}) {
  const e = LIBELLE_ETAT_HABILITATION[t.etat] ?? { texte: t.etat, classe: 'badge--neutre' }
  const final = t.statut === 'retiree' || t.statut === 'remplacee'
  const patch = (corps: Record<string, unknown>) => agir(() => api(`/api/habilitations/${t.id}`, { method: 'PATCH', corps }))

  async function joindre(fichiers: FileList | null) {
    if (!fichiers?.length) return
    const form = new FormData()
    form.append('fichier', fichiers[0]!)
    await agir(() => envoyerFormulaire(`/api/habilitations/${t.id}/justificatif`, form))
  }

  return (
    <article className="demande-formation" style={final ? { opacity: 0.8 } : undefined}>
      <div className="demande-formation__tete">
        <strong>{t.type_intitule}{t.niveau ? ` — ${t.niveau}` : ''}</strong>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className={`badge ${e.classe}`}>{e.texte}</span>
          {t.statut === 'active' && t.jours_restants != null && t.jours_restants >= 0 && t.jours_restants <= 90 && <span className="badge badge--neutre">{t.jours_restants} jour{t.jours_restants > 1 ? 's' : ''}</span>}
        </span>
      </div>
      <div className="inspection-ligne__meta">
        <span>Délivré le {dateFr(t.date_delivrance)}</span>
        <span>{t.date_validite ? `Valide jusqu’au ${dateFr(t.date_validite)}` : 'Sans échéance'}</span>
        {t.reference_titre && <span>Réf. {t.reference_titre}</span>}
        {t.delivre_par && <span>{t.delivre_par}</span>}
        {t.attestation_intitule && <span>Attestation : {t.attestation_intitule}</span>}
        {t.renouvelle_id && <span>Renouvelle un titre précédent</span>}
      </div>
      {t.motif && <p className="texte-discret">Motif : {t.motif}</p>}
      {t.commentaire && <p className="texte-discret">{t.commentaire}</p>}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
        {t.fichier_id && (
          <>
            <a className="lien-action" href={`/api/habilitations/justificatifs/${t.fichier_id}`} target="_blank" rel="noreferrer">Voir le justificatif</a>
            {equipe && !final && <button type="button" className="lien-action lien-action--rouge" disabled={enCours} aria-label="Retirer le justificatif"
              onClick={() => window.confirm('Retirer le justificatif ?') && agir(() => api(`/api/habilitations/justificatifs/${t.fichier_id}`, { method: 'DELETE' }))}><IconeCroix /></button>}
          </>
        )}
        {equipe && !final && (
          <label className="lien-action" style={{ cursor: 'pointer' }}>
            {t.fichier_id ? 'Remplacer le justificatif' : 'Joindre le justificatif'}
            <input type="file" accept="application/pdf,image/*" hidden disabled={enCours} onChange={(ev) => { void joindre(ev.target.files); ev.target.value = '' }} />
          </label>
        )}
      </div>

      {equipe && !final && !ouvert && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
          <button type="button" className="lien-action" disabled={enCours} onClick={() => onOuvrir('renouvellement')}><IconeCoche /> Renouveler</button>
          <button type="button" className="lien-action" disabled={enCours} onClick={() => onOuvrir('edition')}>Corriger</button>
          {t.statut === 'active'
            ? <button type="button" className="lien-action" disabled={enCours} onClick={() => { const m = window.prompt('Motif de la suspension :'); if (m?.trim()) void patch({ statut: 'suspendue', motif: m }) }}>Suspendre</button>
            : <button type="button" className="lien-action" disabled={enCours} onClick={() => void patch({ statut: 'active' })}>Réactiver</button>}
          <button type="button" className="lien-action lien-action--rouge" disabled={enCours} onClick={() => { const m = window.prompt('Motif du retrait (définitif) :'); if (m?.trim()) void patch({ statut: 'retiree', motif: m }) }}>Retirer</button>
          <button type="button" className="lien-action lien-action--rouge" disabled={enCours}
            onClick={() => window.confirm('Supprimer définitivement ce titre ? Préférez « Retirer » pour garder une trace.') && agir(() => api(`/api/habilitations/${t.id}`, { method: 'DELETE' }))}>Supprimer</button>
        </div>
      )}
      {children}
    </article>
  )
}
