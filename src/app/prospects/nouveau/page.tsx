'use client'

import { useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import ChoixFormations, { type DemandeSaisie } from '@/ui/ChoixFormations'

const SERVICES: [string, string][] = [['inspection', 'Inspection'], ['formation', 'Formation'], ['audit', 'Audit'], ['conseil', 'Conseil']]

/**
 * Création terrain d'un prospect par le consultant : l'entreprise est créée
 * en statut « prospect » (modules inspections et tableau de bord seulement),
 * le consultant reçoit un accès limité dans le temps, et la session bascule
 * directement dessus pour démarrer l'inspection.
 */
export default function PageNouveauProspect() {
  const [nom, setNom] = useState('')
  const [secteur, setSecteur] = useState('')
  const [pays, setPays] = useState('BJ')
  const [services, setServices] = useState<string[]>(['inspection'])
  const [formations, setFormations] = useState<DemandeSaisie[]>([])
  const [serviceAutre, setServiceAutre] = useState('')
  const [listePays, setListePays] = useState<{ code: string, nom: string, actif: boolean }[]>([])

  // Liste gérée en base (page « Pays d’intervention ») : seuls les pays actifs sont proposés.
  useEffect(() => {
    api<{ pays: { code: string, nom: string, actif: boolean }[] }>('/api/pays')
      .then((r) => {
        const actifs = r.pays.filter((p) => p.actif)
        setListePays(actifs)
        setPays((courant) => (actifs.some((p) => p.code === courant) ? courant : actifs[0]?.code ?? courant))
      })
      .catch(() => {})
  }, [])
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  async function soumettre(e: React.FormEvent) {
    e.preventDefault()
    setErreur(null)
    setEnCours(true)
    try {
      const r = await api<{ destination: string }>('/api/prospects', { method: 'POST', corps: { nom, secteur, pays, services, serviceAutre, formations: services.includes('formation') ? formations : [] } })
      window.location.assign(r.destination)
    } catch (err) {
      setErreur(messageErreur(err))
      setEnCours(false)
    }
  }

  return (
    <main className="page-centree">
      <form className="carte-centree" method="post" onSubmit={soumettre}>
        <div className="carte-centree__logo">
          <img src="/brand/logo-circle.svg" alt="IFECARM GROUP" />
          <div>
            <div className="marque__nom">IFECARM GROUP</div>
            <div className="marque__sous">Plateforme QHSE</div>
          </div>
        </div>
        <h1>Nouveau prospect</h1>
        <p className="sous-titre">
          Pour inspecter un site chez une entreprise qui n’est pas encore cliente. Vous gardez l’accès en écriture à ce prospect, sans date de fin (l’administrateur peut le retirer).
        </p>

        <div className="champ">
          <label htmlFor="nom">Raison sociale</label>
          <input id="nom" className="saisie" value={nom} onChange={(e) => setNom(e.target.value)} required maxLength={200} autoFocus />
        </div>
        <div className="champ">
          <label htmlFor="secteur">Secteur d’activité <span className="aide">(facultatif)</span></label>
          <input id="secteur" className="saisie" value={secteur} onChange={(e) => setSecteur(e.target.value)} maxLength={120}
            placeholder="Ex. BTP, agroalimentaire, logistique" />
        </div>
        <div className="champ">
          <label htmlFor="pays">Pays</label>
          <select id="pays" className="saisie" value={pays} onChange={(e) => setPays(e.target.value)}>
            {listePays.map((p) => <option key={p.code} value={p.code}>{p.nom}</option>)}
          </select>
          <span className="aide">Un pays manque ? <a href="/pays">Ajoutez-le dans « Pays d’intervention »</a>.</span>
        </div>

        <fieldset className="fieldset-nu" style={{ marginTop: 16 }}>
          <legend className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Service souhaité</legend>
          <div className="modules-cases">
            {SERVICES.map(([code, libelle]) => (
              <label key={code} className="case">
                <input type="checkbox" checked={services.includes(code)}
                  onChange={(e) => setServices(e.target.checked ? [...services, code] : services.filter((x) => x !== code))} />
                {libelle}
              </label>
            ))}
          </div>
          <div className="champ" style={{ marginTop: 10 }}>
            <label htmlFor="service-autre">Autre service souhaité <span className="aide">(facultatif, à écrire)</span></label>
            <input id="service-autre" className="saisie" maxLength={300} placeholder="Ex. Étude de dangers, accompagnement ISO 45001…" value={serviceAutre} onChange={(ev) => setServiceAutre(ev.target.value)} />
          </div>
          {services.includes('formation') && <ChoixFormations valeur={formations} onChange={setFormations} />}
          <span className="aide">Ce que le prospect veut faire avec IFECARM GROUP. Sans « Inspection », vous revenez à la liste après la création.</span>
        </fieldset>

        {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginTop: 16 }}>{erreur}</div>}

        <button type="submit" className="bouton bouton--bloc" style={{ marginTop: 22 }} disabled={enCours || !nom.trim()}>
          {enCours ? 'Création…' : services.length === 0 || services.includes('inspection') ? 'Créer et démarrer une inspection' : 'Créer le prospect'}
        </button>
        <a className="bouton bouton--discret bouton--bloc" href="/entreprises" style={{ marginTop: 10 }}>Annuler</a>
      </form>
    </main>
  )
}
