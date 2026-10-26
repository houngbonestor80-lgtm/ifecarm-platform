'use client'

import { useEffect, useState } from 'react'
import { api } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { reduireImage } from '@/ui/image'
import { IconeAppareilPhoto, IconeCoche, IconeCroix } from '@/ui/icones'
import ChoixPhoto from '@/ui/ChoixPhoto'
import { LIBELLE_TYPE_DECLARATION } from '@/ui/libelles'
import { SortieEnAttente } from '@/registre/SortieEnAttente'
import {
  contexteMemorise, demanderStockagePersistant, enregistrerEnSortie, memoriserContexte, nouvelleCle, synchroniser,
  type ContexteHorsLigne,
} from '@/registre/hors-ligne'

/**
 * Saisie rapide d'une déclaration (moins d'une minute, sur téléphone, avec ou sans réseau). Rien n'est
 * obligatoire sauf : le type, la date et ce qui s'est passé. La déclaration est d'abord écrite sur l'appareil,
 * puis envoyée — voir src/registre/hors-ligne.ts.
 */

const MAX_PHOTOS = 8
const maintenantLocal = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

interface Photo { nom: string, blob: Blob, apercu: string }
type Resultat = { etat: 'envoyee', reference: string } | { etat: 'sur_appareil' }

/** Valeur de la liste : le site n'est pas dans la liste, la personne l'écrit dans « Lieu précis ». */
const AUTRE_SITE = '__autre__'

export default function PageNouvelleDeclaration() {
  const app = useContexteApp()
  const [donnees, setDonnees] = useState<ContexteHorsLigne | null>(null)
  const [type, setType] = useState('')
  const [quand, setQuand] = useState(maintenantLocal)
  const [siteId, setSiteId] = useState('')
  const autreSite = siteId === AUTRE_SITE
  const [lieu, setLieu] = useState('')
  const [service, setService] = useState('')
  const [description, setDescription] = useState('')
  const [anonyme, setAnonyme] = useState(false)
  const [victime, setVictime] = useState(false)
  const [salarieId, setSalarieId] = useState('')
  const [victimeExterne, setVictimeExterne] = useState('')
  const [arret, setArret] = useState(false)
  const [joursArret, setJoursArret] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [erreur, setErreur] = useState<string | null>(null)
  const [envoi, setEnvoi] = useState(false)
  const [resultat, setResultat] = useState<Resultat | null>(null)

  // Sites et salariés : réseau si possible (et mémorisés pour la prochaine fois sans réseau), sinon la mémoire de l'appareil.
  useEffect(() => {
    void demanderStockagePersistant()
    api<ContexteHorsLigne>('/api/registre/contexte')
      .then((c) => { setDonnees(c); void memoriserContexte(c) })
      .catch(async () => {
        const memo = await contexteMemorise().catch(() => undefined)
        setDonnees(memo && memo.moi === app.moi ? memo : { moi: app.moi, entrepriseId: app.entrepriseId, sites: [], salaries: [], equipe: false, responsable: false })
      })
  }, [app.moi, app.entrepriseId])

  const avecArret = type === 'accident_avec_arret' || arret
  const victimeAttendue = type === 'accident_avec_arret' || type === 'accident_sans_arret'

  async function ajouterPhotos(fichiers: FileList | null) {
    if (!fichiers?.length) return
    const places = MAX_PHOTOS - photos.length
    const nouvelles: Photo[] = []
    for (const f of Array.from(fichiers).slice(0, places)) {
      const blob = await reduireImage(f)
      nouvelles.push({ nom: f.name.replace(/\.\w+$/, '') + '.jpg', blob, apercu: URL.createObjectURL(blob) })
    }
    setPhotos((p) => [...p, ...nouvelles])
  }

  async function envoyer(e: React.FormEvent) {
    e.preventDefault()
    setErreur(null)
    if (!type) { setErreur('Choisissez le type d’événement.'); return }
    if (!description.trim()) { setErreur('Décrivez ce qui s’est passé.'); return }
    const date = new Date(quand)
    if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 60_000) { setErreur('La date de l’événement ne peut pas être dans le futur.'); return }
    setEnvoi(true)
    try {
      const cleClient = nouvelleCle()
      await enregistrerEnSortie({
        cleClient, utilisateurId: app.moi, entrepriseId: app.entrepriseId, creeLe: Date.now(),
        corps: {
          type, survenuLe: date.toISOString(), description: description.trim(), anonyme,
          siteId: siteId && siteId !== AUTRE_SITE ? siteId : null, lieu: lieu.trim() || null, service: service.trim() || null,
          salarieId: !anonyme && victime && salarieId ? salarieId : null,
          victimeExterne: victime && victimeExterne.trim() ? victimeExterne.trim() : null,
          arretTravail: avecArret ? true : null, joursArret: avecArret && joursArret ? Number(joursArret) : null,
        },
        photos: photos.map((p) => ({ nom: p.nom, blob: p.blob })),
      })
      // Écrite sur l'appareil : on tente l'envoi tout de suite. Sans réseau, elle partira toute seule plus tard.
      let reference: string | null = null
      if (navigator.onLine) {
        const { envoyees } = await synchroniser(app.moi)
        reference = envoyees.length ? envoyees[envoyees.length - 1]!.reference : null
      }
      setResultat(reference ? { etat: 'envoyee', reference } : { etat: 'sur_appareil' })
    } catch {
      setErreur('Impossible d’enregistrer sur cet appareil (stockage plein ou bloqué). Réessayez, ou notez les faits et prévenez le responsable.')
    }
    setEnvoi(false)
  }

  function recommencer() {
    photos.forEach((p) => URL.revokeObjectURL(p.apercu))
    setType(''); setQuand(maintenantLocal()); setLieu(''); setService(''); setDescription(''); setAnonyme(false)
    setVictime(false); setSalarieId(''); setVictimeExterne(''); setArret(false); setJoursArret(''); setPhotos([]); setResultat(null)
  }

  if (resultat) {
    return (
      <main className="contenu contenu--etroit">
        <section className="carte" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <div className={`alerte ${resultat.etat === 'envoyee' ? 'alerte--info' : 'alerte--attention'}`} role="status" style={{ justifyContent: 'center', marginBottom: 16 }}>
            <IconeCoche /> {resultat.etat === 'envoyee' ? 'Déclaration envoyée' : 'Enregistrée sur cet appareil'}
          </div>
          {resultat.etat === 'envoyee' ? (
            <>
              <p className="texte-discret">Référence à conserver :</p>
              <p style={{ fontSize: '1.8rem', fontWeight: 700, margin: '6px 0 14px' }}>{resultat.reference}</p>
              {anonyme && <p className="texte-discret">Déclaration anonyme : vous ne pourrez pas la relire, mais le responsable la traitera.</p>}
            </>
          ) : (
            <p>Pas de réseau pour l’instant. La déclaration partira automatiquement dès que la connexion reviendra — gardez cet appareil, vous n’avez rien d’autre à faire.</p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 20 }}>
            <button type="button" className="bouton" onClick={recommencer}>Déclarer autre chose</button>
            <a className="bouton bouton--secondaire" href="/registre">Voir le registre</a>
          </div>
        </section>
        <div style={{ marginTop: 16 }}><SortieEnAttente /></div>
      </main>
    )
  }

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/registre">Incidents</a> / Nouvelle déclaration</nav>
      <div className="tete-page"><div><h1>Déclarer un événement</h1><p className="tete-page__desc">Une minute suffit. Même sans réseau, rien n’est perdu.</p></div></div>
      <SortieEnAttente />

      <form onSubmit={envoyer} className="pile" noValidate>
        <section className="carte">
          <fieldset className="fieldset-nu">
            <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 10 }}>Que s’est-il passé ? <span aria-hidden="true">*</span></legend>
            <div className="choix">
              {Object.entries(LIBELLE_TYPE_DECLARATION).map(([k, t]) => (
                <label key={k} className="choix__option">
                  <input type="radio" name="type" value={k} checked={type === k} onChange={() => setType(k)} />
                  <span className="choix__titre">{t.texte}</span>
                  <span className="choix__meta">{t.aide}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>

        <section className="carte">
          <div className="grille-2">
            <div className="champ">
              <label htmlFor="d-quand">Quand ? <span aria-hidden="true">*</span></label>
              <input id="d-quand" type="datetime-local" className="saisie" required max={maintenantLocal()} value={quand} onChange={(e) => setQuand(e.target.value)} />
            </div>
            <div className="champ">
              <label htmlFor="d-site">Site</label>
              <select id="d-site" className="saisie" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">—</option>
                {(donnees?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
                <option value={AUTRE_SITE}>Autre site (à écrire ci-dessous)</option>
              </select>
            </div>
          </div>
          <div className="grille-2" style={{ marginTop: 14 }}>
            <div className="champ"><label htmlFor="d-lieu">{autreSite ? 'Site et lieu précis' : 'Lieu précis'}{autreSite && <span aria-hidden="true"> *</span>}</label><input id="d-lieu" className="saisie" maxLength={200} required={autreSite} placeholder={autreSite ? 'Nom du site, atelier, quai 2…' : 'Atelier, quai 2…'} value={lieu} onChange={(e) => setLieu(e.target.value)} /></div>
            <div className="champ"><label htmlFor="d-service">Service</label><input id="d-service" className="saisie" maxLength={200} value={service} onChange={(e) => setService(e.target.value)} /></div>
          </div>
          <div className="champ" style={{ marginTop: 14 }}>
            <label htmlFor="d-desc">Description <span aria-hidden="true">*</span></label>
            <textarea id="d-desc" className="saisie" rows={5} maxLength={4000} required placeholder="Ce qui s’est passé, comment, avec quoi…" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </section>

        <section className="carte">
          <label className="case"><input type="checkbox" checked={victime || victimeAttendue} disabled={victimeAttendue} onChange={(e) => setVictime(e.target.checked)} /> Une personne est concernée (victime)</label>
          {(victime || victimeAttendue) && (
            <div style={{ marginTop: 14 }}>
              <div className="grille-2">
                {!anonyme && (donnees?.salaries.length ?? 0) > 0 && (
                  <div className="champ">
                    <label htmlFor="d-sal">Salarié</label>
                    <select id="d-sal" className="saisie" value={salarieId} onChange={(e) => setSalarieId(e.target.value)}>
                      <option value="">—</option>
                      {donnees!.salaries.map((s) => <option key={s.id} value={s.id}>{s.prenom} {s.nom}</option>)}
                    </select>
                  </div>
                )}
                <div className="champ">
                  <label htmlFor="d-ext">{anonyme || !(donnees?.salaries.length) ? 'Nom de la victime' : 'Ou personne extérieure'}</label>
                  <input id="d-ext" className="saisie" maxLength={200} placeholder="Intérimaire, sous-traitant, visiteur…" value={victimeExterne} onChange={(e) => setVictimeExterne(e.target.value)} />
                </div>
              </div>
              <label className="case" style={{ marginTop: 14 }}><input type="checkbox" checked={avecArret} disabled={type === 'accident_avec_arret'} onChange={(e) => setArret(e.target.checked)} /> Arrêt de travail</label>
              {avecArret && (
                <div className="champ" style={{ marginTop: 10, maxWidth: 200 }}>
                  <label htmlFor="d-jours">Jours d’arrêt</label>
                  <input id="d-jours" type="number" min={0} max={3650} inputMode="numeric" className="saisie" value={joursArret} onChange={(e) => setJoursArret(e.target.value)} />
                </div>
              )}
              {anonyme && <p className="texte-discret" style={{ marginTop: 10 }}>Déclaration anonyme : le salarié concerné ne sera pas relié à la fiche, seul le nom saisi ci-dessus sera conservé.</p>}
            </div>
          )}
        </section>

        <section className="carte">
          <div className="carte__titre"><h2>Photos <span className="texte-discret">({photos.length}/{MAX_PHOTOS})</span></h2></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {photos.map((p, i) => (
              <div key={p.apercu} style={{ position: 'relative' }}>
                <img src={p.apercu} alt={`Photo ${i + 1}`} style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--ink-100)' }} />
                <button type="button" className="lien-action lien-action--rouge" aria-label={`Retirer la photo ${i + 1}`} style={{ position: 'absolute', top: -6, right: -6, background: 'var(--surface)', borderRadius: 999, padding: 2 }}
                  onClick={() => { URL.revokeObjectURL(p.apercu); setPhotos((l) => l.filter((x) => x !== p)) }}><IconeCroix /></button>
              </div>
            ))}
            {photos.length < MAX_PHOTOS && (
              <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><ChoixPhoto onFichiers={(f) => void ajouterPhotos(f)} /></span>
            )}
          </div>
        </section>

        <section className="carte">
          <label className="case"><input type="checkbox" checked={anonyme} onChange={(e) => setAnonyme(e.target.checked)} /> Déclarer anonymement</label>
          <p className="texte-discret" style={{ marginTop: 6 }}>Votre nom n’est enregistré nulle part avec cette déclaration. Vous ne pourrez pas la relire ensuite ; gardez la référence.</p>
        </section>

        {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
        <button type="submit" className="bouton bouton--bloc" disabled={envoi} style={{ minHeight: 52, fontSize: '1rem' }}>
          <IconeCoche /> {envoi ? 'Enregistrement…' : 'Envoyer la déclaration'}
        </button>
      </form>
    </main>
  )
}
