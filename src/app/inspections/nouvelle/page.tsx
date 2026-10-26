'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeBatiment, IconeCroix, IconeOutil, IconePlus } from '@/ui/icones'

interface Modele { id: string, intitule: string, domaine: string, cible_type: 'site' | 'equipement', description: string | null, nb_items: number }
interface Donnees {
  modeles: Modele[]
  sites: { id: string, nom: string, ville: string | null }[]
  equipements: { id: string, designation: string, type: string }[]
}

/** Valeur de la liste d'équipements : l'équipement n'est pas au registre, l'inspecteur l'écrit. */
const EQUIPEMENT_NOUVEAU = '__nouveau__'

export default function PageNouvelleInspection() {
  const { entreprise, peutConduire } = useContexteApp()
  const [donnees, setDonnees] = useState<Donnees | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  // Deux façons de partir : un modèle (points copiés) ou une checklist LIBRE écrite par l'inspecteur.
  const [mode, setMode] = useState<'modele' | 'libre'>('modele')
  const [intitule, setIntitule] = useState('')
  const [cibleLibre, setCibleLibre] = useState<'site' | 'equipement'>('site')
  const [points, setPoints] = useState<string[]>([''])
  const [garder, setGarder] = useState(false)
  const [domaine, setDomaine] = useState('')
  const [modeleId, setModeleId] = useState('')
  const [modeSite, setModeSite] = useState<'existant' | 'nouveau'>('existant')
  const [siteId, setSiteId] = useState('')
  const [nouveauSite, setNouveauSite] = useState({ nom: '', ville: '' })
  const [equipementId, setEquipementId] = useState('')
  // Équipement pas encore au registre : écrit à la main (valeur « nouveau » de la liste).
  const [nouvelEquipement, setNouvelEquipement] = useState({ type: '', designation: '', numeroSerie: '' })
  const equipementEcrit = equipementId === EQUIPEMENT_NOUVEAU
  // Date LOCALE (format sv-SE = AAAA-MM-JJ) : toISOString() donnerait la date
  // UTC, soit la veille entre minuit et 1 h au Bénin.
  const [date, setDate] = useState(() => new Date().toLocaleDateString('sv-SE'))
  const [heureDebut, setHeureDebut] = useState('')
  const [heureFin, setHeureFin] = useState('')
  // Laissé vide : le serveur pré-remplit avec le nom du compte connecté.
  const [inspecteurNom, setInspecteurNom] = useState('')
  const [representantClient, setRepresentantClient] = useState('')

  useEffect(() => {
    if (!peutConduire) return
    api<Donnees>('/api/inspections/creation')
      .then((d) => {
        setDonnees(d)
        if (d.modeles.length === 1) setModeleId(d.modeles[0]!.id)
        if (d.sites.length === 0) setModeSite('nouveau')
        if (d.sites.length === 1) setSiteId(d.sites[0]!.id)
      })
      .catch((e) => setErreur(messageErreur(e)))
  }, [peutConduire])

  const modele = useMemo(() => donnees?.modeles.find((m) => m.id === modeleId), [donnees, modeleId])

  const cibleType = mode === 'libre' ? cibleLibre : modele?.cible_type
  const pointsSaisis = points.map((x) => x.trim()).filter(Boolean)
  const pret = mode === 'libre' ? intitule.trim().length > 0 && pointsSaisis.length > 0 : Boolean(modele)

  function majPoint(i: number, valeur: string) {
    setPoints((l) => l.map((x, k) => (k === i ? valeur : x)))
  }
  function ajouterPointApres(i: number) {
    setPoints((l) => [...l.slice(0, i + 1), '', ...l.slice(i + 1)])
    setTimeout(() => document.getElementById(`pt-${i + 1}`)?.focus(), 0)
  }
  function retirerPoint(i: number) {
    setPoints((l) => (l.length > 1 ? l.filter((_, k) => k !== i) : ['']))
  }
  // Coller une liste (un point par ligne) remplit plusieurs lignes d'un coup.
  function coller(i: number, texte: string) {
    const lignes = texte.split(/\r?\n/).map((x) => x.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(Boolean)
    if (lignes.length < 2) return false
    setPoints((l) => [...l.slice(0, i), ...lignes, ...l.slice(i + 1)])
    return true
  }

  async function soumettre(e: React.FormEvent) {
    e.preventDefault()
    if (!pret) return setErreur(mode === 'libre' ? 'Donnez un intitulé et au moins un point de contrôle.' : 'Choisissez un modèle d’inspection.')
    setErreur(null)
    setEnCours(true)
    try {
      const corps: Record<string, unknown> = { date, heureDebut, heureFin, inspecteurNom, representantClient }
      if (mode === 'libre') Object.assign(corps, { intitule: intitule.trim(), cibleType: cibleLibre, points: pointsSaisis, enregistrerModele: garder, domaine: domaine.trim() || undefined })
      else corps.modeleId = modeleId
      if (cibleType === 'site') {
        if (modeSite === 'nouveau') corps.nouveauSite = nouveauSite
        else corps.siteId = siteId
      } else {
        if (equipementEcrit) corps.nouvelEquipement = nouvelEquipement
        else corps.equipementId = equipementId
      }
      const r = await api<{ id: string }>('/api/inspections', { method: 'POST', corps })
      window.location.assign(`/inspections/${r.id}`)
    } catch (err) {
      setErreur(messageErreur(err))
      setEnCours(false)
    }
  }

  if (!peutConduire) {
    return (
      <main className="contenu contenu--etroit">
        <div className="alerte alerte--attention">
          La création d’une inspection est réservée aux consultants IFECARM GROUP disposant d’un accès en écriture.
        </div>
      </main>
    )
  }

  const cibleIncomplete = !pret
    || (cibleType === 'site' && (modeSite === 'nouveau' ? !nouveauSite.nom.trim() : !siteId))
    || (cibleType === 'equipement' && (equipementEcrit ? !nouvelEquipement.designation.trim() || !nouvelEquipement.type.trim() : !equipementId))

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/inspections">Inspections</a> / Nouvelle</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Nouvelle inspection</div>
          <h1>{entreprise.nom}</h1>
          <p className="tete-page__desc">Partez d’un modèle (sa checklist est copiée dans l’inspection) ou écrivez votre propre checklist : vous n’êtes pas limité aux modèles par défaut, et vous pourrez aussi ajouter des points en cours d’inspection.</p>
        </div>
      </div>

      {!donnees && !erreur && <div className="squelette" style={{ height: 240 }} aria-busy="true" />}
      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 16 }}>{erreur}</div>}

      {donnees && (
        <form method="post" onSubmit={soumettre}>
          <section className="carte">
            <div className="carte__titre">
              <h2>1. Checklist</h2>
              <div className="onglets" role="group" aria-label="Modèle ou checklist libre">
                <button type="button" aria-pressed={mode === 'modele'} onClick={() => setMode('modele')}>À partir d’un modèle</button>
                <button type="button" aria-pressed={mode === 'libre'} onClick={() => setMode('libre')}>Ma propre checklist</button>
              </div>
            </div>
            {mode === 'libre' && (
              <div>
                <div className="grille-2">
                  <div className="champ">
                    <label htmlFor="intitule">Intitulé de l’inspection</label>
                    <input id="intitule" className="saisie" maxLength={200} required placeholder="Ex. Visite de sécurité — atelier soudure"
                      value={intitule} onChange={(e) => setIntitule(e.target.value)} />
                  </div>
                  <div className="champ">
                    <label htmlFor="cible-libre">Ce qui est inspecté</label>
                    <select id="cible-libre" className="saisie" value={cibleLibre} onChange={(e) => setCibleLibre(e.target.value as 'site' | 'equipement')}>
                      <option value="site">Un site</option>
                      <option value="equipement">Un équipement</option>
                    </select>
                  </div>
                </div>
                <div className="champ" style={{ marginTop: 14 }}>
                  <label>Points de contrôle <span className="aide">(Entrée = point suivant ; collez une liste, un point par ligne)</span></label>
                  <div className="pile" style={{ gap: 8 }}>
                    {points.map((pt, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="aide" style={{ minWidth: 22, textAlign: 'right' }}>{i + 1}.</span>
                        <input id={`pt-${i}`} className="saisie" maxLength={500} placeholder="Ex. Extincteurs accessibles et vérifiés" value={pt}
                          onChange={(e) => majPoint(i, e.target.value)}
                          onPaste={(e) => { if (coller(i, e.clipboardData.getData('text'))) e.preventDefault() }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (pt.trim()) ajouterPointApres(i) } }} />
                        <button type="button" className="lien-action" aria-label={`Retirer le point ${i + 1}`} onClick={() => retirerPoint(i)}><IconeCroix /></button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="bouton bouton--secondaire bouton--petit" style={{ marginTop: 10 }} onClick={() => ajouterPointApres(points.length - 1)}>
                    <IconePlus /> Ajouter un point
                  </button>
                </div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
                  <input type="checkbox" checked={garder} onChange={(e) => setGarder(e.target.checked)} />
                  Garder cette checklist comme modèle de l’entreprise (réutilisable pour les prochaines inspections)
                </label>
                {garder && (
                  <div className="champ" style={{ marginTop: 10, maxWidth: 360 }}>
                    <label htmlFor="domaine">Domaine du modèle <span className="aide">(facultatif)</span></label>
                    <input id="domaine" className="saisie" maxLength={80} list="domaines-libres" placeholder="Ex. Incendie" value={domaine} onChange={(e) => setDomaine(e.target.value)} />
                    <datalist id="domaines-libres">{['Sécurité', 'Santé au travail', 'Environnement', 'Qualité', 'Hygiène', 'Incendie'].map((d) => <option key={d} value={d} />)}</datalist>
                  </div>
                )}
              </div>
            )}
            {mode === 'modele' && (donnees.modeles.length === 0 ? (
              <div className="alerte alerte--attention">Aucun modèle d’inspection n’est encore disponible. L’administration IFECARM doit en créer un.</div>
            ) : (
              <div className="choix" role="radiogroup" aria-label="Modèle d’inspection">
                {donnees.modeles.map((m) => (
                  <label key={m.id} className="choix__option">
                    <input type="radio" name="modele" value={m.id} checked={modeleId === m.id} onChange={() => setModeleId(m.id)} />
                    <div className="choix__titre">{m.intitule}</div>
                    <div className="choix__meta">
                      {m.cible_type === 'site' ? 'Visite de site' : 'Contrôle d’équipement'} · {m.nb_items} point{m.nb_items > 1 ? 's' : ''} · {m.domaine}
                    </div>
                    {m.description && <div className="choix__meta">{m.description}</div>}
                  </label>
                ))}
              </div>
            ))}
          </section>

          {pret && (
            <section className="carte">
              <div className="carte__titre">
                <h2>2. {cibleType === 'site' ? 'Site inspecté' : 'Équipement contrôlé'}</h2>
                {cibleType === 'site' && donnees.sites.length > 0 && (
                  <div className="onglets" role="group" aria-label="Site existant ou nouveau">
                    <button type="button" aria-pressed={modeSite === 'existant'} onClick={() => setModeSite('existant')}>Existant</button>
                    <button type="button" aria-pressed={modeSite === 'nouveau'} onClick={() => setModeSite('nouveau')}>Nouveau site</button>
                  </div>
                )}
              </div>

              {cibleType === 'site' && modeSite === 'existant' && (
                <div className="champ">
                  <label htmlFor="site"><IconeBatiment className="visually-hidden" />Site</label>
                  <select id="site" className="saisie" value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
                    <option value="">Choisir un site…</option>
                    {donnees.sites.map((s) => <option key={s.id} value={s.id}>{s.nom}{s.ville ? ` — ${s.ville}` : ''}</option>)}
                  </select>
                </div>
              )}

              {cibleType === 'site' && modeSite === 'nouveau' && (
                <div className="grille-2">
                  <div className="champ">
                    <label htmlFor="site-nom">Nom du site</label>
                    <input id="site-nom" className="saisie" value={nouveauSite.nom} maxLength={200} required
                      placeholder="Ex. Entrepôt principal"
                      onChange={(e) => setNouveauSite({ ...nouveauSite, nom: e.target.value })} />
                  </div>
                  <div className="champ">
                    <label htmlFor="site-ville">Ville <span className="aide">(facultatif)</span></label>
                    <input id="site-ville" className="saisie" value={nouveauSite.ville} maxLength={120}
                      placeholder="Ex. Cotonou"
                      onChange={(e) => setNouveauSite({ ...nouveauSite, ville: e.target.value })} />
                  </div>
                </div>
              )}

              {cibleType === 'equipement' && (
                <>
                  <div className="champ">
                    <label htmlFor="equipement"><IconeOutil className="visually-hidden" />Équipement</label>
                    <select id="equipement" className="saisie" value={equipementId} onChange={(e) => setEquipementId(e.target.value)} required>
                      <option value="">{donnees.equipements.length ? 'Choisir un équipement…' : 'Aucun équipement enregistré'}</option>
                      {donnees.equipements.map((q) => <option key={q.id} value={q.id}>{q.designation} ({q.type})</option>)}
                      <option value={EQUIPEMENT_NOUVEAU}>＋ Autre équipement (l’écrire moi-même)…</option>
                    </select>
                  </div>
                  {equipementEcrit && (
                    <div className="grille-2" style={{ marginTop: 12 }}>
                      <div className="champ">
                        <label htmlFor="eq-ecrit-type">Type</label>
                        <input id="eq-ecrit-type" className="saisie" required maxLength={80} placeholder="Ex. Extincteur, harnais, échelle…" value={nouvelEquipement.type}
                          onChange={(e) => setNouvelEquipement({ ...nouvelEquipement, type: e.target.value })} />
                      </div>
                      <div className="champ">
                        <label htmlFor="eq-ecrit-des">Désignation</label>
                        <input id="eq-ecrit-des" className="saisie" required maxLength={200} placeholder="Ex. Extincteur CO2 5 kg — atelier" value={nouvelEquipement.designation}
                          onChange={(e) => setNouvelEquipement({ ...nouvelEquipement, designation: e.target.value })} />
                      </div>
                      <div className="champ">
                        <label htmlFor="eq-ecrit-serie">N° de série <span className="aide">(facultatif)</span></label>
                        <input id="eq-ecrit-serie" className="saisie" maxLength={100} value={nouvelEquipement.numeroSerie}
                          onChange={(e) => setNouvelEquipement({ ...nouvelEquipement, numeroSerie: e.target.value })} />
                      </div>
                      <p className="aide" style={{ alignSelf: 'end' }}>Il est ajouté au registre des équipements de l’entreprise.</p>
                    </div>
                  )}
                </>
              )}

              <div className="grille-3" style={{ marginTop: 16, maxWidth: 560 }}>
                <div className="champ">
                  <label htmlFor="date">Date de l’inspection</label>
                  <input id="date" type="date" className="saisie" value={date} onChange={(e) => setDate(e.target.value)} required />
                </div>
                <div className="champ">
                  <label htmlFor="h-debut">Début <span className="aide">(facultatif)</span></label>
                  <input id="h-debut" type="time" className="saisie" value={heureDebut} onChange={(e) => setHeureDebut(e.target.value)} />
                </div>
                <div className="champ">
                  <label htmlFor="h-fin">Fin <span className="aide">(facultatif)</span></label>
                  <input id="h-fin" type="time" className="saisie" value={heureFin} min={heureDebut || undefined} disabled={!heureDebut} onChange={(e) => setHeureFin(e.target.value)} />
                </div>
              </div>
            </section>
          )}

          {pret && (
            <section className="carte">
              <h2 style={{ marginBottom: 14 }}>3. Intervenants</h2>
              <div className="intervenants">
                <div className="champ">
                  <label htmlFor="inspecteur">Inspection réalisée par</label>
                  <input id="inspecteur" className="saisie" value={inspecteurNom} maxLength={200}
                    placeholder="Par défaut : votre nom" onChange={(e) => setInspecteurNom(e.target.value)} />
                </div>
                <div className="champ">
                  <label htmlFor="representant">
                    {entreprise.statutRelation === 'prospect' ? 'Représentant du prospect' : 'Représentant du client'}
                  </label>
                  <input id="representant" className="saisie" value={representantClient} maxLength={200}
                    placeholder="Nom et fonction de la personne présente" onChange={(e) => setRepresentantClient(e.target.value)} />
                </div>
              </div>
            </section>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' }}>
            <a className="bouton bouton--discret" href="/inspections">Annuler</a>
            <button type="submit" className="bouton" disabled={enCours || cibleIncomplete}>
              {enCours ? 'Création…' : 'Démarrer l’inspection'}
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
