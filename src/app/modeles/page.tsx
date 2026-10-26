'use client'

import { useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { IconeBatiment, IconeListe, IconeOutil, IconePlus } from '@/ui/icones'

interface Modele {
  id: string
  intitule: string
  domaine: string
  cible_type: 'site' | 'equipement'
  description: string | null
  actif: boolean
  portee: 'catalogue' | 'entreprise'
  nb_items: number
  inspections: number
}
interface Donnees { modeles: Modele[], peutGererEntreprise: boolean, peutGererCatalogue: boolean }

export default function PageModeles() {
  const [d, setD] = useState<Donnees | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  useEffect(() => {
    api<Donnees>('/api/modeles').then(setD).catch((e) => setErreur(messageErreur(e)))
  }, [])

  const bloc = (titre: string, desc: string, liste: Modele[], nouveau: string | null) => (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2>{titre}</h2>
        {nouveau && <a className="bouton bouton--secondaire bouton--petit" href={nouveau}><IconePlus /> Nouveau modèle</a>}
      </div>
      <p className="texte-discret" style={{ marginBottom: 12 }}>{desc}</p>
      {liste.length === 0 && <p className="texte-discret">Aucun modèle.</p>}
      <div className="inspections">
        {liste.map((m) => (
          <a key={m.id} className="inspection-ligne" href={`/modeles/${m.id}`}>
            <div>
              <div className="inspection-ligne__titre">{m.intitule}</div>
              <div className="inspection-ligne__meta">
                <span>{m.cible_type === 'site' ? <IconeBatiment /> : <IconeOutil />}{m.cible_type === 'site' ? 'Visite de site' : 'Contrôle d’équipement'}</span>
                <span><IconeListe />{m.nb_items} point{m.nb_items > 1 ? 's' : ''}</span>
                <span>{m.domaine}</span>
              </div>
              <div className="inspection-ligne__badges">
                {!m.actif && <span className="badge badge--neutre">Archivé</span>}
                {m.inspections > 0 && <span className="badge badge--bleu">{m.inspections} inspection{m.inspections > 1 ? 's' : ''} ici</span>}
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  )

  return (
    <main className="contenu contenu--etroit">
      <div className="tete-page">
        <div>
          <div className="tete-page__sur">Modèles d’inspection</div>
          <h1>Checklists</h1>
          <p className="tete-page__desc">
            Chaque inspection part d’un modèle. Modifier un modèle ne change jamais les inspections déjà réalisées.
          </p>
        </div>
      </div>
      {erreur && <div className="alerte alerte--erreur" role="alert">{erreur}</div>}
      {!d && !erreur && <div className="squelette" style={{ height: 120 }} aria-busy="true" />}
      {d && (
        <>
          {bloc('Modèles de cette entreprise', 'Checklists adaptées à ce client ou prospect, visibles de lui seul.',
            d.modeles.filter((m) => m.portee === 'entreprise'), d.peutGererEntreprise ? '/modeles/nouveau' : null)}
          {bloc('Catalogue IFECARM GROUP', 'Checklists de référence, communes à tous les clients.',
            d.modeles.filter((m) => m.portee === 'catalogue'), d.peutGererCatalogue ? '/modeles/nouveau?portee=catalogue' : null)}
        </>
      )}
    </main>
  )
}
