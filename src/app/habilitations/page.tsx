'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import ChoixSite, { SITE_VIDE, corpsSite, type ValeurSite } from '@/ui/ChoixSite'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconePlus } from '@/ui/icones'
import { dateCourteFr, LIBELLE_DOMAINE_HABILITATION, LIBELLE_ETAT_HABILITATION } from '@/ui/libelles'

interface Salarie { id: string, nom: string, prenom: string, poste: string | null, service: string | null, matricule: string | null, site_nom: string | null }
interface Type { id: string, code: string, intitule: string, domaine: string, actif: boolean }
interface Titre { id: string, salarie_id: string, type_id: string, niveau: string | null, date_validite: string | null, statut: string, etat: string, jours_restants: number | null }
interface Matrice { salaries: Salarie[], types: Type[], titres: Titre[] }
interface Contexte { equipe: boolean, responsable: boolean, sites: { id: string, nom: string }[] }

/** Gravité d'un état pour résumer plusieurs titres d'un même type : le meilleur l'emporte. */
const RANG: Record<string, number> = { valide: 0, a_renouveler: 1, suspendue: 2, expiree: 3 }
const PIRE: Record<string, number> = { expiree: 0, a_renouveler: 1, suspendue: 2, valide: 3 }
const NOMS_SALARIE = (s: Salarie) => `${s.nom.toUpperCase()} ${s.prenom}`
const sansAccent = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Matrice des habilitations : qui est habilité à quoi, et ce qui demande une action (à renouveler, expiré, suspendu). */
export default function PageHabilitations() {
  const [m, setM] = useState<Matrice | null>(null)
  const [ctx, setCtx] = useState<Contexte | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [domaine, setDomaine] = useState('')
  const [aTraiter, setATraiter] = useState(false)
  const [tousTypes, setTousTypes] = useState(false)
  const [ajout, setAjout] = useState(false)
  const [nouveau, setNouveau] = useState({ nom: '', prenom: '', poste: '', service: '', matricule: '' })
  const [siteNouveau, setSiteNouveau] = useState<ValeurSite>(SITE_VIDE)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<Matrice>('/api/habilitations/matrice').then((r) => { setM(r); setErreur(null) }).catch((e) => setErreur(messageErreur(e)))
  }, [])
  useEffect(() => { charger() }, [charger])
  useEffect(() => { api<Contexte>('/api/habilitations/contexte').then(setCtx).catch(() => {}) }, [])

  const parCellule = useMemo(() => {
    const c = new Map<string, Titre[]>()
    for (const t of m?.titres ?? []) c.set(`${t.salarie_id}|${t.type_id}`, [...(c.get(`${t.salarie_id}|${t.type_id}`) ?? []), t])
    return c
  }, [m])

  // Colonnes : les types qui ont au moins un titre en cours (ou tous, à la demande), filtrés par domaine.
  const colonnes = useMemo(() => {
    const utilises = new Set((m?.titres ?? []).map((t) => t.type_id))
    return (m?.types ?? []).filter((t) => (tousTypes ? t.actif || utilises.has(t.id) : utilises.has(t.id)) && (!domaine || t.domaine === domaine))
  }, [m, tousTypes, domaine])

  const lignes = useMemo(() => {
    const mots = sansAccent(q).split(/\s+/).filter(Boolean)
    return (m?.salaries ?? []).filter((s) => {
      if (!mots.every((x) => sansAccent(`${s.nom} ${s.prenom} ${s.poste ?? ''} ${s.service ?? ''} ${s.matricule ?? ''}`).includes(x))) return false
      if (!aTraiter) return true
      return colonnes.some((c) => (parCellule.get(`${s.id}|${c.id}`) ?? []).some((t) => t.etat !== 'valide'))
    })
  }, [m, q, aTraiter, colonnes, parCellule])

  const decompte = useMemo(() => {
    const d: Record<string, number> = { valide: 0, a_renouveler: 0, expiree: 0, suspendue: 0 }
    for (const t of m?.titres ?? []) d[t.etat] = (d[t.etat] ?? 0) + 1
    return d
  }, [m])

  function cellule(s: Salarie, type: Type) {
    const titres = parCellule.get(`${s.id}|${type.id}`)
    if (!titres?.length) return <span className="texte-discret" aria-label="Pas d’habilitation">—</span>
    const meilleur = [...titres].sort((a, b) => (RANG[a.etat] ?? 9) - (RANG[b.etat] ?? 9))[0]!
    const e = LIBELLE_ETAT_HABILITATION[meilleur.etat]!
    const pire = [...titres].sort((a, b) => (PIRE[a.etat] ?? 9) - (PIRE[b.etat] ?? 9))[0]!
    const niveaux = titres.map((t) => t.niveau).filter(Boolean).join(', ')
    const detail = titres.map((t) => `${t.niveau ?? type.intitule} : ${LIBELLE_ETAT_HABILITATION[t.etat]!.texte}${t.date_validite ? ` jusqu’au ${dateCourteFr(t.date_validite)}` : ' (sans échéance)'}`).join('\n')
    return (
      <a href={`/habilitations/salaries/${s.id}`} title={detail} style={{ textDecoration: 'none', display: 'grid', gap: 2, justifyItems: 'center' }}>
        <span className={`badge ${e.classe}`}>{e.texte}</span>
        {niveaux && <span className="texte-discret" style={{ fontSize: '0.72rem' }}>{niveaux}</span>}
        {pire.etat !== meilleur.etat && <span className={`badge ${LIBELLE_ETAT_HABILITATION[pire.etat]!.classe}`} style={{ fontSize: '0.65rem' }}>{LIBELLE_ETAT_HABILITATION[pire.etat]!.texte}</span>}
      </a>
    )
  }

  async function ajouterSalarie(e: React.FormEvent) {
    e.preventDefault()
    setEnCours(true); setErreur(null)
    try {
      const r = await api<{ id: string }>('/api/habilitations/salaries', { method: 'POST', corps: { ...nouveau, ...corpsSite(siteNouveau) } })
      window.location.assign(`/habilitations/salaries/${r.id}`)
    } catch (err) { setErreur(messageErreur(err)); setEnCours(false) }
  }

  return (
    <main className="contenu">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Habilitations</div>
          <h1>Qui est habilité à quoi</h1>
          <p className="tete-page__desc">Titres en cours de chaque salarié. Une case colorée ouvre la fiche du salarié, avec son historique et ses renouvellements.</p>
        </div>
        {ctx?.equipe && !ajout && <button type="button" className="bouton" onClick={() => setAjout(true)}><IconePlus /> Ajouter un salarié</button>}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}

      {ajout && ctx?.equipe && (
        <form className="carte" style={{ marginBottom: 16 }} onSubmit={ajouterSalarie}>
          <div className="carte__titre"><h2>Nouveau salarié</h2></div>
          <div className="grille-2">
            <div className="champ"><label htmlFor="s-prenom">Prénom</label><input id="s-prenom" className="saisie" required maxLength={120} value={nouveau.prenom} onChange={(e) => setNouveau({ ...nouveau, prenom: e.target.value })} /></div>
            <div className="champ"><label htmlFor="s-nom">Nom</label><input id="s-nom" className="saisie" required maxLength={120} value={nouveau.nom} onChange={(e) => setNouveau({ ...nouveau, nom: e.target.value })} /></div>
            <div className="champ"><label htmlFor="s-poste">Poste</label><input id="s-poste" className="saisie" maxLength={120} value={nouveau.poste} onChange={(e) => setNouveau({ ...nouveau, poste: e.target.value })} /></div>
            <div className="champ"><label htmlFor="s-service">Service</label><input id="s-service" className="saisie" maxLength={120} value={nouveau.service} onChange={(e) => setNouveau({ ...nouveau, service: e.target.value })} /></div>
            <div className="champ"><label htmlFor="s-mat">Matricule</label><input id="s-mat" className="saisie" maxLength={60} value={nouveau.matricule} onChange={(e) => setNouveau({ ...nouveau, matricule: e.target.value })} /></div>
            <ChoixSite id="s-site" facultatif={false} sites={ctx.sites} valeur={siteNouveau} onChange={setSiteNouveau} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="submit" className="bouton" disabled={enCours}><IconeCoche /> Créer et ouvrir la fiche</button>
            <button type="button" className="bouton bouton--secondaire" onClick={() => setAjout(false)}>Annuler</button>
          </div>
        </form>
      )}

      {!m && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}

      {m && (
        <>
          <section className="tuiles" aria-label="Titres en cours">
            <div className="tuile tuile--vert"><div className="tuile__valeur">{decompte.valide}</div><div className="tuile__libelle">Valides</div></div>
            <div className={`tuile ${decompte.a_renouveler ? 'tuile--orange' : 'tuile--vert'}`}><div className="tuile__valeur">{decompte.a_renouveler}</div><div className="tuile__libelle">À renouveler (90 jours)</div></div>
            <div className={`tuile ${decompte.expiree ? 'tuile--rouge' : 'tuile--vert'}`}><div className="tuile__valeur">{decompte.expiree}</div><div className="tuile__libelle">Expirées</div></div>
            <div className="tuile tuile--bleu"><div className="tuile__valeur">{decompte.suspendue}</div><div className="tuile__libelle">Suspendues</div></div>
          </section>

          <div className="carte" style={{ marginBottom: 16 }}>
            <div className="grille-2">
              <div className="champ"><label htmlFor="h-q">Rechercher un salarié</label><input id="h-q" className="saisie" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, poste, service, matricule…" /></div>
              <div className="champ"><label htmlFor="h-dom">Domaine</label>
                <select id="h-dom" className="saisie" value={domaine} onChange={(e) => setDomaine(e.target.value)}>
                  <option value="">Tous</option>
                  {Object.entries(LIBELLE_DOMAINE_HABILITATION).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select></div>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
              <label className="case"><input type="checkbox" checked={aTraiter} onChange={(e) => setATraiter(e.target.checked)} /> Seulement ceux qui demandent une action</label>
              <label className="case"><input type="checkbox" checked={tousTypes} onChange={(e) => setTousTypes(e.target.checked)} /> Afficher aussi les types sans titre</label>
            </div>
          </div>

          {m.salaries.length === 0 && <p className="texte-discret">Aucun salarié pour l’instant{ctx?.equipe ? ' : ajoutez-en un pour saisir ses habilitations.' : '.'}</p>}
          {m.salaries.length > 0 && colonnes.length === 0 && <p className="texte-discret">Aucune habilitation saisie{domaine ? ' dans ce domaine' : ''} pour l’instant. Ouvrez la fiche d’un salarié pour en ajouter une.</p>}

          {colonnes.length > 0 && (
            <div className="carte" style={{ padding: 0, overflowX: 'auto' }}>
              <table className="tableau" style={{ width: '100%', minWidth: 160 + colonnes.length * 130 }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ position: 'sticky', left: 0, background: 'var(--surface)', textAlign: 'left', minWidth: 190 }}>Salarié</th>
                    {colonnes.map((c) => <th key={c.id} scope="col" title={c.intitule} style={{ textAlign: 'center', minWidth: 120, verticalAlign: 'bottom' }}>
                      <span style={{ display: 'block', fontSize: '0.78rem' }}>{c.intitule}</span>
                      <span className="texte-discret" style={{ fontSize: '0.68rem', fontWeight: 500 }}>{c.code}</span>
                    </th>)}
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((s) => (
                    <tr key={s.id}>
                      <th scope="row" style={{ position: 'sticky', left: 0, background: 'var(--surface)', textAlign: 'left', fontWeight: 500 }}>
                        <a href={`/habilitations/salaries/${s.id}`} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
                          <strong>{NOMS_SALARIE(s)}</strong>
                          <span className="texte-discret" style={{ display: 'block', fontSize: '0.74rem' }}>{[s.poste, s.site_nom].filter(Boolean).join(' · ')}</span>
                        </a>
                      </th>
                      {colonnes.map((c) => <td key={c.id} style={{ textAlign: 'center' }}>{cellule(s, c)}</td>)}
                    </tr>
                  ))}
                  {lignes.length === 0 && <tr><td colSpan={colonnes.length + 1} className="texte-discret" style={{ textAlign: 'center' }}>Aucun salarié ne correspond.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <p className="texte-discret" style={{ marginTop: 10 }}>Vert : valide · orange : échéance dans 90 jours ou moins · rouge : expirée · bleu : suspendue. Plusieurs titres du même type : le meilleur s’affiche, le moins bon aussi s’il diffère.</p>
        </>
      )}
    </main>
  )
}
