'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconePlus, IconeSortie } from '@/ui/icones'
import { LIBELLE_DOMAINE_HABILITATION } from '@/ui/libelles'

interface Type { id: string, code: string, intitule: string, domaine: string, referentiel: string | null, validite_mois: number | null, actif: boolean }

const sansAccent = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const VIDE = { code: '', intitule: '', domaine: 'electrique', referentiel: '', validiteMois: '' }

/**
 * Catalogue d'habilitations (administrateur) : types proposés à tous les clients, avec leur durée de validité
 * habituelle (indicative : elle préremplit la date de validité à la saisie, jamais imposée). Un type désactivé
 * n'est plus proposé pour de nouveaux titres ; les titres existants restent.
 */
export default function PageCatalogueHabilitations() {
  const [types, setTypes] = useState<Type[] | null>(null)
  const [q, setQ] = useState('')
  const [nouveau, setNouveau] = useState<typeof VIDE | null>(null)
  const [saisie, setSaisie] = useState<Record<string, { intitule: string, referentiel: string, validiteMois: string, domaine: string }>>({})
  const [erreur, setErreur] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const charger = useCallback(() => {
    api<{ types: Type[] }>('/api/administration/habilitations').then((r) => setTypes(r.types)).catch((e) => {
      if ((e as { statut?: number }).statut === 403) return window.location.assign('/vue-ensemble')
      setErreur(messageErreur(e))
    })
  }, [])
  useEffect(() => { charger() }, [charger])

  const visibles = useMemo(() => {
    const mots = sansAccent(q).split(/\s+/).filter(Boolean)
    return (types ?? []).filter((t) => mots.every((m) => sansAccent(`${t.code} ${t.intitule} ${t.referentiel ?? ''} ${LIBELLE_DOMAINE_HABILITATION[t.domaine] ?? ''}`).includes(m)))
  }, [types, q])

  async function agir(fn: () => Promise<unknown>, ok: string) {
    setErreur(null); setMessage(null)
    try { await fn(); setMessage(ok); charger(); return true } catch (e) { setErreur(messageErreur(e)); return false }
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
            <span className="marque__texte"><span className="marque__nom">IFECARM GROUP</span><span className="marque__sous">Plateforme QHSE</span></span>
          </a>
          <nav className="entete__actions" aria-label="Session" style={{ marginLeft: 'auto' }}>
            <a className="lien-entete" href="/administration"><span className="libelle">Administration</span></a>
            <button type="button" className="lien-entete" onClick={deconnecter}><IconeSortie /><span className="libelle">Déconnexion</span></button>
          </nav>
        </div>
      </header>

      <main className="contenu contenu--etroit">
        <div className="tete-page">
          <div>
            <div className="tete-page__sur">Administration</div>
            <h1>Catalogue d’habilitations</h1>
            <p className="tete-page__desc">Types d’habilitation proposés à tous les clients. La durée de validité est indicative : elle préremplit la date de validité à la saisie. Les mentions précises (B2V, catégorie 3…) se saisissent sur chaque titre, dans le champ « niveau ».</p>
          </div>
          {!nouveau && <button type="button" className="bouton" onClick={() => setNouveau({ ...VIDE })}><IconePlus /> Ajouter un type</button>}
        </div>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
        {message && <div className="alerte alerte--info" role="status" style={{ marginBottom: 14 }}><IconeCoche /> {message}</div>}

        {nouveau && (
          <form className="carte" style={{ marginBottom: 16 }} onSubmit={(e) => {
            e.preventDefault()
            void agir(() => api('/api/administration/habilitations', { method: 'POST', corps: { ...nouveau, validiteMois: nouveau.validiteMois === '' ? null : Number(nouveau.validiteMois) } }), `Type « ${nouveau.intitule} » ajouté.`).then((ok) => ok && setNouveau(null))
          }}>
            <div className="carte__titre"><h2>Nouveau type</h2></div>
            <div className="grille-2">
              <div className="champ"><label htmlFor="n-code">Code</label><input id="n-code" className="saisie" required maxLength={40} placeholder="Ex. HAB-ELEC" value={nouveau.code} onChange={(e) => setNouveau({ ...nouveau, code: e.target.value })} /><span className="aide">Ne change plus ensuite.</span></div>
              <div className="champ"><label htmlFor="n-dom">Domaine</label>
                <select id="n-dom" className="saisie" value={nouveau.domaine} onChange={(e) => setNouveau({ ...nouveau, domaine: e.target.value })}>
                  {Object.entries(LIBELLE_DOMAINE_HABILITATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select></div>
            </div>
            <div className="champ" style={{ marginTop: 14 }}><label htmlFor="n-int">Intitulé</label><input id="n-int" className="saisie" required maxLength={200} value={nouveau.intitule} onChange={(e) => setNouveau({ ...nouveau, intitule: e.target.value })} /></div>
            <div className="grille-2" style={{ marginTop: 14 }}>
              <div className="champ"><label htmlFor="n-ref">Référentiel</label><input id="n-ref" className="saisie" maxLength={200} placeholder="Ex. NF C 18-510" value={nouveau.referentiel} onChange={(e) => setNouveau({ ...nouveau, referentiel: e.target.value })} /></div>
              <div className="champ"><label htmlFor="n-val">Validité habituelle (mois)</label><input id="n-val" type="number" min={1} max={240} className="saisie" placeholder="Sans échéance" value={nouveau.validiteMois} onChange={(e) => setNouveau({ ...nouveau, validiteMois: e.target.value })} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button type="submit" className="bouton"><IconeCoche /> Ajouter</button>
              <button type="button" className="bouton bouton--secondaire" onClick={() => setNouveau(null)}>Annuler</button>
            </div>
          </form>
        )}

        <div className="carte" style={{ marginBottom: 16 }}>
          <div className="champ">
            <label htmlFor="cat-q">Rechercher un type</label>
            <input id="cat-q" className="saisie" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex. CACES, électrique, SST…" />
          </div>
        </div>

        {!types && !erreur && <div className="squelette" style={{ height: 96 }} aria-busy="true" />}
        {types?.length === 0 && <p className="texte-discret">Le catalogue est vide pour l’instant.</p>}
        <ul className="pile" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {visibles.map((t) => {
            const v = saisie[t.id] ?? { intitule: t.intitule, referentiel: t.referentiel ?? '', validiteMois: t.validite_mois == null ? '' : String(t.validite_mois), domaine: t.domaine }
            const modifie = v.intitule !== t.intitule || v.referentiel !== (t.referentiel ?? '') || v.validiteMois !== (t.validite_mois == null ? '' : String(t.validite_mois)) || v.domaine !== t.domaine
            return (
              <li key={t.id} className="demande-formation" style={t.actif ? undefined : { opacity: 0.6 }}>
                <div className="demande-formation__tete">
                  <strong>{t.code}</strong>
                  <span className="texte-discret">{LIBELLE_DOMAINE_HABILITATION[t.domaine]}</span>
                </div>
                <form style={{ display: 'grid', gap: 10 }} onSubmit={(e) => {
                  e.preventDefault()
                  void agir(() => api(`/api/administration/habilitations/${t.id}`, { method: 'PATCH', corps: { intitule: v.intitule, referentiel: v.referentiel || null, domaine: v.domaine, validiteMois: v.validiteMois === '' ? null : Number(v.validiteMois) } }), `« ${t.code} » enregistré.`).then((ok) => ok && setSaisie((s) => { const { [t.id]: _, ...reste } = s; return reste }))
                }}>
                  <div className="grille-2">
                    <div className="champ"><label htmlFor={`i-${t.id}`}>Intitulé</label><input id={`i-${t.id}`} className="saisie" required maxLength={200} value={v.intitule} onChange={(e) => setSaisie((s) => ({ ...s, [t.id]: { ...v, intitule: e.target.value } }))} /></div>
                    <div className="champ"><label htmlFor={`r-${t.id}`}>Référentiel</label><input id={`r-${t.id}`} className="saisie" maxLength={200} value={v.referentiel} onChange={(e) => setSaisie((s) => ({ ...s, [t.id]: { ...v, referentiel: e.target.value } }))} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
                    <div className="champ" style={{ width: 200 }}>
                      <label htmlFor={`d-${t.id}`}>Domaine</label>
                      <select id={`d-${t.id}`} className="saisie" value={v.domaine} onChange={(e) => setSaisie((s) => ({ ...s, [t.id]: { ...v, domaine: e.target.value } }))}>
                        {Object.entries(LIBELLE_DOMAINE_HABILITATION).map(([k, x]) => <option key={k} value={k}>{x}</option>)}
                      </select>
                    </div>
                    <div className="champ" style={{ width: 170 }}>
                      <label htmlFor={`v-${t.id}`}>Validité (mois)</label>
                      <input id={`v-${t.id}`} type="number" min={1} max={240} className="saisie" placeholder="Sans échéance" value={v.validiteMois} onChange={(e) => setSaisie((s) => ({ ...s, [t.id]: { ...v, validiteMois: e.target.value } }))} />
                    </div>
                    {modifie && <button type="submit" className="bouton bouton--petit">Enregistrer</button>}
                    <label className="case">
                      <input type="checkbox" checked={t.actif} onChange={(e) => void agir(() => api(`/api/administration/habilitations/${t.id}`, { method: 'PATCH', corps: { actif: e.target.checked } }), e.target.checked ? 'Type activé.' : 'Type désactivé (plus proposé pour de nouveaux titres).')} /> Actif
                    </label>
                  </div>
                </form>
              </li>
            )
          })}
        </ul>
      </main>
    </>
  )
}
