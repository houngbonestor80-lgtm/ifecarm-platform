'use client'

import { useMemo, useState } from 'react'
import { IconeCoche } from '@/ui/icones'
import { dateFr, LIBELLE_DOMAINE_HABILITATION } from '@/ui/libelles'

export interface TypeHab { id: string, entreprise_id: string | null, code: string, intitule: string, domaine: string, referentiel: string | null, validite_mois: number | null, actif: boolean }
export interface AttestationSalarie { id: string, intitule_formation: string, date_fin: string, expire_le: string | null }

const aujourdhui = () => new Date().toISOString().slice(0, 10)
const ajouterMois = (iso: string, mois: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  const jour = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + mois)
  if (d.getUTCDate() !== jour) d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

export interface ValeursTitre {
  typeId: string, niveau: string, referenceTitre: string, delivrePar: string, dateDelivrance: string
  dateValidite: string | null | undefined // undefined = automatique, null = sans échéance
  attestationId: string, commentaire: string
}

/** Valeur de la liste : le type n'est pas dans la liste, l'équipe l'écrit (il devient un type propre à l'entreprise). */
const TYPE_ECRIT = '__ecrit__'

/**
 * Formulaire d'un titre : création, renouvellement ou correction. La date de validité est AUTOMATIQUE tant que
 * l'utilisateur ne la saisit pas (échéance de l'attestation liée, sinon date de délivrance + durée habituelle du
 * type) ; elle peut être fixée à la main ou déclarée « sans échéance ». Le serveur applique la même règle.
 */
export function FormTitre({ mode, types, attestations = [], initial, enCours, onValider, onAnnuler }: {
  mode: 'creation' | 'renouvellement' | 'edition'
  types: TypeHab[]
  attestations?: AttestationSalarie[]
  initial?: Partial<ValeursTitre>
  enCours: boolean
  onValider: (corps: Record<string, unknown>) => Promise<boolean>
  onAnnuler: () => void
}) {
  const [v, setV] = useState<ValeursTitre>({
    typeId: initial?.typeId ?? '', niveau: initial?.niveau ?? '', referenceTitre: initial?.referenceTitre ?? '', delivrePar: initial?.delivrePar ?? '',
    dateDelivrance: initial?.dateDelivrance ?? aujourdhui(), dateValidite: mode === 'edition' ? initial?.dateValidite : undefined,
    attestationId: initial?.attestationId ?? '', commentaire: initial?.commentaire ?? '',
  })
  const maj = <K extends keyof ValeursTitre>(cle: K, valeur: ValeursTitre[K]) => setV((x) => ({ ...x, [cle]: valeur }))
  const type = types.find((t) => t.id === v.typeId)
  const [nouveauType, setNouveauType] = useState({ intitule: '', domaine: 'autre', referentiel: '', validiteMois: '' })
  const typeEcrit = v.typeId === TYPE_ECRIT
  const attestation = attestations.find((a) => a.id === v.attestationId)

  const automatique = useMemo(() => {
    if (attestation) return attestation.expire_le
    return type?.validite_mois ? ajouterMois(v.dateDelivrance, type.validite_mois) : null
  }, [attestation, type, v.dateDelivrance])
  const validiteAffichee = v.dateValidite === undefined ? automatique : v.dateValidite

  const parDomaine = useMemo(() => {
    const m = new Map<string, TypeHab[]>()
    for (const t of types.filter((x) => x.actif)) m.set(t.domaine, [...(m.get(t.domaine) ?? []), t])
    return [...m.entries()]
  }, [types])

  async function envoyer(e: React.FormEvent) {
    e.preventDefault()
    const corps: Record<string, unknown> = {
      niveau: v.niveau.trim() || null, referenceTitre: v.referenceTitre.trim() || null, delivrePar: v.delivrePar.trim() || null,
      dateDelivrance: v.dateDelivrance, commentaire: v.commentaire.trim() || null,
    }
    if (v.dateValidite !== undefined) corps.dateValidite = v.dateValidite
    if (mode !== 'edition') { corps.attestationId = v.attestationId || undefined }
    if (mode === 'creation') {
      if (typeEcrit) corps.nouveauType = { intitule: nouveauType.intitule.trim(), domaine: nouveauType.domaine, referentiel: nouveauType.referentiel.trim() || undefined, validiteMois: nouveauType.validiteMois || undefined }
      else corps.typeId = v.typeId
    }
    await onValider(corps)
  }

  return (
    <form className="carte" style={{ marginTop: 14 }} onSubmit={envoyer}>
      <div className="carte__titre"><h2>{mode === 'creation' ? 'Nouvelle habilitation' : mode === 'renouvellement' ? 'Renouveler le titre' : 'Corriger le titre'}</h2></div>

      {mode === 'creation' && (
        <div className="champ">
          <label htmlFor="ft-type">Type d’habilitation</label>
          <select id="ft-type" className="saisie" required value={v.typeId} onChange={(e) => maj('typeId', e.target.value)}>
            <option value="">Choisir…</option>
            {parDomaine.map(([domaine, liste]) => (
              <optgroup key={domaine} label={LIBELLE_DOMAINE_HABILITATION[domaine] ?? domaine}>
                {liste.map((t) => <option key={t.id} value={t.id}>{t.intitule}{t.referentiel ? ` — ${t.referentiel}` : ''}</option>)}
              </optgroup>
            ))}
            <option value={TYPE_ECRIT}>＋ Autre type (l’écrire moi-même)…</option>
          </select>
          {type?.validite_mois && <span className="aide">Validité habituelle : {type.validite_mois} mois.</span>}
        </div>
      )}

      {mode === 'creation' && typeEcrit && (
        <div className="grille-2" style={{ marginTop: 14 }}>
          <div className="champ">
            <label htmlFor="ft-nt-int">Intitulé du type</label>
            <input id="ft-nt-int" className="saisie" required autoFocus maxLength={200} placeholder="Ex. Conduite de pont roulant" value={nouveauType.intitule} onChange={(e) => setNouveauType({ ...nouveauType, intitule: e.target.value })} />
          </div>
          <div className="champ">
            <label htmlFor="ft-nt-dom">Domaine</label>
            <select id="ft-nt-dom" className="saisie" value={nouveauType.domaine} onChange={(e) => setNouveauType({ ...nouveauType, domaine: e.target.value })}>
              {Object.entries(LIBELLE_DOMAINE_HABILITATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </div>
          <div className="champ">
            <label htmlFor="ft-nt-ref">Référentiel <span className="aide">(facultatif)</span></label>
            <input id="ft-nt-ref" className="saisie" maxLength={200} value={nouveauType.referentiel} onChange={(e) => setNouveauType({ ...nouveauType, referentiel: e.target.value })} />
          </div>
          <div className="champ">
            <label htmlFor="ft-nt-val">Validité habituelle, en mois <span className="aide">(facultatif)</span></label>
            <input id="ft-nt-val" className="saisie" type="number" min={1} max={240} value={nouveauType.validiteMois} onChange={(e) => setNouveauType({ ...nouveauType, validiteMois: e.target.value })} />
          </div>
        </div>
      )}

      <div className="grille-2" style={{ marginTop: mode === 'creation' ? 14 : 0 }}>
        <div className="champ">
          <label htmlFor="ft-niveau">Niveau / mention <span className="aide">(B2V, catégorie 3, H0V…)</span></label>
          <input id="ft-niveau" className="saisie" maxLength={100} value={v.niveau} onChange={(e) => maj('niveau', e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="ft-ref">Référence du titre</label>
          <input id="ft-ref" className="saisie" maxLength={200} value={v.referenceTitre} onChange={(e) => maj('referenceTitre', e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="ft-org">Délivré par</label>
          <input id="ft-org" className="saisie" maxLength={200} placeholder="Employeur, organisme de formation…" value={v.delivrePar} onChange={(e) => maj('delivrePar', e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="ft-deliv">Date de délivrance</label>
          <input id="ft-deliv" type="date" className="saisie" required max={aujourdhui()} value={v.dateDelivrance} onChange={(e) => maj('dateDelivrance', e.target.value)} />
        </div>
      </div>

      {mode !== 'edition' && attestations.length > 0 && (
        <div className="champ" style={{ marginTop: 14 }}>
          <label htmlFor="ft-att">Justifié par une attestation de formation <span className="aide">(facultatif)</span></label>
          <select id="ft-att" className="saisie" value={v.attestationId} onChange={(e) => maj('attestationId', e.target.value)}>
            <option value="">Aucune</option>
            {attestations.map((a) => <option key={a.id} value={a.id}>{a.intitule_formation} — {dateFr(a.date_fin)}{a.expire_le ? ` (échéance ${dateFr(a.expire_le)})` : ' (sans échéance)'}</option>)}
          </select>
          {attestation && <span className="aide">La date de validité reprend l’échéance de l’attestation ; elle ne la suivra plus ensuite.</span>}
        </div>
      )}

      <div className="champ" style={{ marginTop: 14, maxWidth: 360 }}>
        <label htmlFor="ft-valid">Valide jusqu’au</label>
        <input id="ft-valid" type="date" className="saisie" disabled={v.dateValidite === null} min={v.dateDelivrance} value={validiteAffichee ?? ''}
          onChange={(e) => maj('dateValidite', e.target.value || undefined)} />
        <label className="case" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={v.dateValidite === null} onChange={(e) => maj('dateValidite', e.target.checked ? null : undefined)} /> Sans échéance
        </label>
        {v.dateValidite === undefined && <span className="aide">{validiteAffichee ? `Calculée automatiquement : ${dateFr(validiteAffichee)}.` : 'Aucune durée habituelle pour ce type : sans échéance.'}</span>}
      </div>

      <div className="champ" style={{ marginTop: 14 }}>
        <label htmlFor="ft-com">Commentaire</label>
        <textarea id="ft-com" className="saisie" rows={2} maxLength={2000} value={v.commentaire} onChange={(e) => maj('commentaire', e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="submit" className="bouton" disabled={enCours || (mode === 'creation' && !v.typeId)}><IconeCoche /> {mode === 'renouvellement' ? 'Renouveler' : 'Enregistrer'}</button>
        <button type="button" className="bouton bouton--secondaire" onClick={onAnnuler}>Annuler</button>
      </div>
    </form>
  )
}
