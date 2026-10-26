'use client'

/** Valeur de la liste pour « autre site » : l'utilisateur écrit lui-même le nom (en plus des sites déjà enregistrés). */
export const SITE_NOUVEAU = '__nouveau__'

export interface ValeurSite { siteId: string, siteNom: string, siteVille: string }
export const SITE_VIDE: ValeurSite = { siteId: '', siteNom: '', siteVille: '' }

/** Champs de site à fusionner dans le corps de la requête : site existant OU nouveau site saisi. */
export const corpsSite = (v: ValeurSite) =>
  v.siteId === SITE_NOUVEAU ? { siteId: null, nouveauSite: { nom: v.siteNom, ville: v.siteVille } } : { siteId: v.siteId || null }

/** Liste des sites existants + possibilité d'écrire un nouveau site (visible même si aucun site n'existe encore). */
export default function ChoixSite({ sites, valeur, onChange, id, facultatif = true }: {
  sites: { id: string, nom: string }[]
  valeur: ValeurSite
  onChange: (v: ValeurSite) => void
  id: string
  facultatif?: boolean
}) {
  const nouveau = valeur.siteId === SITE_NOUVEAU
  return (
    <>
      <div className="champ">
        <label htmlFor={id}>Site {facultatif && <span className="aide">(facultatif)</span>}</label>
        <select id={id} className="saisie" value={valeur.siteId} onChange={(e) => onChange({ ...valeur, siteId: e.target.value })}>
          <option value="">—</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
          <option value={SITE_NOUVEAU}>＋ Autre site (saisir son nom)…</option>
        </select>
      </div>
      {nouveau && (
        <>
          <div className="champ">
            <label htmlFor={`${id}-nom`}>Nom du nouveau site</label>
            <input id={`${id}-nom`} className="saisie" required maxLength={200} placeholder="Ex. Entrepôt principal" autoFocus
              value={valeur.siteNom} onChange={(e) => onChange({ ...valeur, siteNom: e.target.value })} />
          </div>
          <div className="champ">
            <label htmlFor={`${id}-ville`}>Ville <span className="aide">(facultatif)</span></label>
            <input id={`${id}-ville`} className="saisie" maxLength={120} placeholder="Ex. Cotonou"
              value={valeur.siteVille} onChange={(e) => onChange({ ...valeur, siteVille: e.target.value })} />
          </div>
        </>
      )}
    </>
  )
}
