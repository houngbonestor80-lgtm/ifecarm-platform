'use client'

import { use, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeCoche, IconeCroix, IconePlus } from '@/ui/icones'

type Gravite = 'mineure' | 'majeure' | 'critique'
interface Item { libelle: string, aide: string | null, gravite_defaut: Gravite }
interface Modele {
  id: string
  intitule: string
  domaine: string
  cible_type: 'site' | 'equipement'
  description: string | null
  actif: boolean
  portee: 'catalogue' | 'entreprise'
  items: Item[]
}
interface Droits { peutGererEntreprise: boolean, peutGererCatalogue: boolean }
interface Saisie {
  intitule: string, domaine: string, cibleType: 'site' | 'equipement', description: string, actif: boolean,
  items: { libelle: string, aide: string, gravite: Gravite }[]
}

const VIDE: Saisie = { intitule: '', domaine: 'Sécurité', cibleType: 'site', description: '', actif: true, items: [{ libelle: '', aide: '', gravite: 'mineure' }] }
const versSaisie = (m: Modele): Saisie => ({
  intitule: m.intitule, domaine: m.domaine, cibleType: m.cible_type, description: m.description ?? '', actif: m.actif,
  items: m.items.map((i) => ({ libelle: i.libelle, aide: i.aide ?? '', gravite: i.gravite_defaut })),
})

export default function PageModele({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const creation = id === 'nouveau'
  const [modele, setModele] = useState<Modele | null>(null)
  const [droits, setDroits] = useState<Droits | null>(null)
  const [s, setS] = useState<Saisie | null>(null)
  const [portee, setPortee] = useState<'catalogue' | 'entreprise'>('entreprise')
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const depuis = q.get('depuis')
    Promise.all([
      api<Droits>('/api/modeles'),
      creation && !depuis ? Promise.resolve(null) : api<{ modele: Modele }>(`/api/modeles/${creation ? depuis : id}`).then((r) => r.modele),
    ]).then(([dr, m]) => {
      setDroits(dr)
      if (creation) {
        setPortee(q.get('portee') === 'catalogue' ? 'catalogue' : 'entreprise')
        setS(m ? { ...versSaisie(m), intitule: `${m.intitule} (adapté)`, actif: true } : { ...VIDE, items: [...VIDE.items] })
      } else if (m) {
        setModele(m)
        setPortee(m.portee)
        setS(versSaisie(m))
      }
    }).catch((e) => setErreur(messageErreur(e)))
  }, [creation, id])

  const modifiable = droits && (portee === 'catalogue' ? droits.peutGererCatalogue : droits.peutGererEntreprise)
  const majItem = (i: number, champ: 'libelle' | 'aide' | 'gravite', v: string) =>
    setS((x) => x && { ...x, items: x.items.map((it, k) => (k === i ? { ...it, [champ]: v } : it)) })
  const deplacer = (i: number, sens: -1 | 1) => setS((x) => {
    if (!x) return x
    const items = [...x.items]
    const j = i + sens
    if (j < 0 || j >= items.length) return x
    ;[items[i], items[j]] = [items[j]!, items[i]!]
    return { ...x, items }
  })

  async function agir(fn: () => Promise<unknown>, apres: string) {
    setErreur(null)
    setEnCours(true)
    try {
      await fn()
      window.location.assign(apres)
    } catch (e) {
      setErreur(messageErreur(e))
      setEnCours(false)
    }
  }

  function enregistrer(ev: React.FormEvent) {
    ev.preventDefault()
    if (!s) return
    const corps = { ...s, portee }
    void agir(() => creation
      ? api('/api/modeles', { method: 'POST', corps })
      : api(`/api/modeles/${id}`, { method: 'PUT', corps }), '/modeles')
  }

  if (erreur && !s) return <main className="contenu contenu--etroit"><div className="alerte alerte--erreur" role="alert">{erreur}</div></main>
  if (!s || !droits) return <main className="contenu contenu--etroit"><div className="squelette" style={{ height: 200 }} aria-busy="true" /></main>

  return (
    <main className="contenu contenu--etroit">
      <nav className="fil-ariane"><a href="/modeles">Modèles</a> / {creation ? 'Nouveau' : s.intitule}</nav>
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">{portee === 'catalogue' ? 'Catalogue IFECARM GROUP' : 'Modèle de l’entreprise'}</div>
          <h1>{creation ? 'Nouveau modèle' : modifiable ? 'Modifier le modèle' : s.intitule}</h1>
        </div>
        {!creation && droits.peutGererEntreprise && (
          <a className="bouton bouton--secondaire bouton--petit" href={`/modeles/nouveau?depuis=${id}`}>Dupliquer pour cette entreprise</a>
        )}
      </div>

      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 14 }}>{erreur}</div>}
      {!modifiable && (
        <div className="alerte alerte--info" style={{ marginBottom: 14 }}>
          {portee === 'catalogue' ? 'Le catalogue est géré par l’administrateur IFECARM GROUP : dupliquez ce modèle pour l’adapter à cette entreprise.' : 'Consultation seule.'}
        </div>
      )}

      <form onSubmit={enregistrer}>
        <fieldset disabled={!modifiable || enCours} className="fieldset-nu">
          <section className="carte">
            <div className="grille-2">
              <div className="champ">
                <label htmlFor="m-intitule">Intitulé</label>
                <input id="m-intitule" className="saisie" required maxLength={200} value={s.intitule} onChange={(e) => setS({ ...s, intitule: e.target.value })} />
              </div>
              <div className="champ">
                <label htmlFor="m-domaine">Domaine</label>
                <input id="m-domaine" className="saisie" required maxLength={80} list="m-domaines" value={s.domaine} onChange={(e) => setS({ ...s, domaine: e.target.value })} />
                <datalist id="m-domaines">{['Sécurité', 'Santé au travail', 'Environnement', 'Qualité', 'Hygiène', 'Incendie'].map((d) => <option key={d} value={d} />)}</datalist>
              </div>
              <div className="champ">
                <label htmlFor="m-cible">Ce modèle s’applique à</label>
                <select id="m-cible" className="saisie" value={s.cibleType} onChange={(e) => setS({ ...s, cibleType: e.target.value as Saisie['cibleType'] })}>
                  <option value="site">Un site (visite)</option>
                  <option value="equipement">Un équipement (contrôle)</option>
                </select>
              </div>
            </div>
            <div className="champ" style={{ marginTop: 14 }}>
              <label htmlFor="m-desc">Description <span className="aide">(facultatif)</span></label>
              <textarea id="m-desc" className="saisie" maxLength={2000} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} />
            </div>
          </section>

          <section className="carte">
            <div className="carte__titre"><h2>Points de contrôle ({s.items.length})</h2></div>
            <ol className="items-modele">
              {s.items.map((it, i) => (
                <li key={i} className="items-modele__ligne">
                  <div className="champ">
                    <label htmlFor={`it-${i}`}>Point {i + 1}</label>
                    <input id={`it-${i}`} className="saisie" required maxLength={500} value={it.libelle} placeholder="Ex. Les issues de secours sont dégagées"
                      onChange={(e) => majItem(i, 'libelle', e.target.value)} />
                  </div>
                  <div className="grille-2" style={{ marginTop: 8 }}>
                    <div className="champ">
                      <label htmlFor={`aide-${i}`}>Consigne <span className="aide">(facultatif)</span></label>
                      <input id={`aide-${i}`} className="saisie" maxLength={1000} value={it.aide} onChange={(e) => majItem(i, 'aide', e.target.value)} />
                    </div>
                    <div className="champ">
                      <label htmlFor={`g-${i}`}>Gravité par défaut si non conforme</label>
                      <select id={`g-${i}`} className="saisie" value={it.gravite} onChange={(e) => majItem(i, 'gravite', e.target.value)}>
                        <option value="mineure">Mineure</option>
                        <option value="majeure">Majeure</option>
                        <option value="critique">Critique</option>
                      </select>
                    </div>
                  </div>
                  {modifiable && (
                    <div className="items-modele__actions">
                      <button type="button" className="lien-action" onClick={() => deplacer(i, -1)} disabled={i === 0} aria-label={`Monter le point ${i + 1}`}>↑ Monter</button>
                      <button type="button" className="lien-action" onClick={() => deplacer(i, 1)} disabled={i === s.items.length - 1} aria-label={`Descendre le point ${i + 1}`}>↓ Descendre</button>
                      {s.items.length > 1 && (
                        <button type="button" className="lien-action lien-action--rouge" onClick={() => setS({ ...s, items: s.items.filter((_, k) => k !== i) })}>
                          <IconeCroix /> Retirer
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {modifiable && (
              <button type="button" className="bouton bouton--secondaire bouton--petit" style={{ marginTop: 12 }}
                onClick={() => setS({ ...s, items: [...s.items, { libelle: '', aide: '', gravite: 'mineure' }] })}>
                <IconePlus /> Ajouter un point
              </button>
            )}
          </section>
        </fieldset>

        {modifiable && (
          <div className="pied-cloture">
            <span className="pied-cloture__texte">Les inspections déjà réalisées ne sont pas modifiées.</span>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {!creation && (
                <>
                  <button type="button" className="bouton bouton--discret" disabled={enCours}
                    onClick={() => agir(() => api(`/api/modeles/${id}`, { method: 'PUT', corps: { ...s, actif: !s.actif } }), '/modeles')}>
                    {s.actif ? 'Archiver' : 'Réactiver'}
                  </button>
                  <button type="button" className="bouton bouton--discret" style={{ color: 'var(--qhse-red)' }} disabled={enCours}
                    onClick={() => window.confirm(`Supprimer définitivement le modèle « ${modele?.intitule} » ?`)
                      && agir(() => api(`/api/modeles/${id}`, { method: 'DELETE' }), '/modeles')}>
                    Supprimer
                  </button>
                </>
              )}
              <button type="submit" className="bouton" disabled={enCours}><IconeCoche /> Enregistrer</button>
            </div>
          </div>
        )}
      </form>
    </main>
  )
}
