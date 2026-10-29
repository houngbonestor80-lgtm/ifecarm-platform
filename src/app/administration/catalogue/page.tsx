'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconeOutil, IconeSortie } from '@/ui/icones'

interface Fiche { id: string, slug: string, intitule: string, domaine: string, duree_jours: string | null, duree_libelle: string | null, validite_mois: number | null, actif: boolean }

const sansAccent = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Catalogue de formations (administrateur) : validité de la certification en
 * mois — elle déclenche les alertes de recyclage — et activation de la fiche.
 * Les fiches viennent de l'import du catalogue du site (npm run import:catalogue).
 */
export default function PageCatalogue() {
  const [fiches, setFiches] = useState<Fiche[] | null>(null)
  const [q, setQ] = useState('')
  const [seulementSansValidite, setSeulementSansValidite] = useState(false)
  const [saisie, setSaisie] = useState<Record<string, string>>({})
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    api<{ formations: Fiche[] }>('/api/administration/catalogue').then((r) => setFiches(r.formations)).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/vue-ensemble')
      setErreur(messageErreur(e))
    })
  }, [])

  const visibles = useMemo(() => {
    const mots = sansAccent(q).split(/\s+/).filter(Boolean)
    return (fiches ?? []).filter((f) => (!seulementSansValidite || f.validite_mois == null) && mots.every((m) => sansAccent(`${f.intitule} ${f.domaine}`).includes(m))).slice(0, 60)
  }, [fiches, q, seulementSansValidite])

  async function modifier(f: Fiche, corps: Record<string, unknown>, ok: string) {
    setErreur(null)
    setMessage(null)
    try {
      await api(`/api/administration/catalogue/${f.id}`, { method: 'PATCH', corps })
      setFiches((l) => l && l.map((x) => (x.id === f.id ? { ...x, ...('validiteMois' in corps ? { validite_mois: corps.validiteMois as number | null } : {}), ...('actif' in corps ? { actif: corps.actif as boolean } : {}) } : x)))
      setSaisie((s) => { const { [f.id]: _, ...reste } = s; return reste })
      setMessage(ok)
    } catch (e) {
      setErreur(messageErreur(e))
    }
  }

  async function deconnecter() {
    await fetch('/api/auth/deconnexion', { method: 'POST' })
    window.location.assign('/connexion')
  }

  const sans = (fiches ?? []).filter((f) => f.actif && f.validite_mois == null).length

  return (
    <>
      <header className="entete">
        <div className="entete__barre">
          <a className="marque" href="/vue-ensemble" aria-label="IFECARM GROUP — Plateforme QHSE, vue d’ensemble">
            <img src="/brand/logo-circle.svg" alt="" />
            <span className="marque__texte"><span className="marque__nom">IFECARM GROUP</span><span className="marque__sous">Plateforme QHSE</span></span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/administration" title="Clients, modules et accès"><IconeOutil /><span className="libelle">Administration</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter}><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu contenu--etroit">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Administration</div>
            <h1>Catalogue de formations</h1>
            <p className="tete-page__desc">Indiquez la validité de la certification, en mois : laissez vide pour une formation sans échéance. {fiches && `${sans} fiche${sans > 1 ? 's' : ''} active${sans > 1 ? 's' : ''} sans validité renseignée.`}</p>
          </div>
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> {message}</div>}

        <div className="carte" style={{ marginBottom: 16 }}>
          <div className="champ">
            <label htmlFor="cat-q">Rechercher une formation ou une famille</label>
            <input id="cat-q" className="saisie" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex. SST, habilitation, incendie…" />
          </div>
          <label className="case" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={seulementSansValidite} onChange={(e) => setSeulementSansValidite(e.target.checked)} /> Seulement celles sans validité
          </label>
        </div>

        {!fiches && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
        <ul className="pile" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {visibles.map((f) => {
            const valeur = saisie[f.id] ?? (f.validite_mois == null ? '' : String(f.validite_mois))
            const modifie = valeur !== (f.validite_mois == null ? '' : String(f.validite_mois))
            return (
              <li key={f.id} className="demande-formation" style={f.actif ? undefined : { opacity: 0.6 }}>
                <div className="demande-formation__tete">
                  <strong>{f.intitule}</strong>
                  <span className="texte-discret">{f.domaine}{f.duree_libelle ? ` · site : ${f.duree_libelle}` : ''}</span>
                </div>
                <form style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }} onSubmit={(e) => {
                  e.preventDefault()
                  void modifier(f, { validiteMois: valeur.trim() === '' ? null : Number(valeur) }, `Validité de « ${f.intitule} » enregistrée.`)
                }}>
                  <div className="champ" style={{ width: 170 }}>
                    <label htmlFor={`v-${f.id}`}>Validité (mois)</label>
                    <input id={`v-${f.id}`} type="number" min={1} max={240} className="saisie" placeholder="Sans échéance" value={valeur}
                      onChange={(e) => setSaisie((s) => ({ ...s, [f.id]: e.target.value }))} />
                  </div>
                  {modifie && <button type="submit" className="bouton bouton--petit">Enregistrer</button>}
                  <label className="case">
                    <input type="checkbox" checked={f.actif} onChange={(e) => void modifier(f, { actif: e.target.checked }, e.target.checked ? 'Fiche activée.' : 'Fiche désactivée (plus proposée pour de nouvelles sessions).')} /> Active
                  </label>
                </form>
              </li>
            )
          })}
        </ul>
        {fiches && visibles.length === 60 && <p className="texte-discret" style={{ marginTop: 12 }}>60 premières fiches affichées : affinez la recherche.</p>}
      </main>
    </>
  )
}
