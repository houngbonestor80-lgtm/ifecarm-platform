'use client'

import { useMemo, useState } from 'react'
import { slugLibre } from '@/formations/demandes'
import { FAMILLES, FICHES, ficheDe } from '@/formations/catalogue'
import { IconeCroix } from '@/ui/icones'

export interface DemandeSaisie { slug: string, intitule?: string | null, nb_participants: string, date_souhaitee: string, note: string }
export const demandeVide = (slug: string, intitule?: string): DemandeSaisie => ({ slug, intitule: intitule ?? null, nb_participants: '', date_souhaitee: '', note: '' })

const MAX = 30
const sansAccent = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Choix des formations du catalogue IFECARM GROUP qui intéressent un prospect :
 * recherche par mot ou par famille, une carte par formation choisie (participants, date, note interne ; 30 au maximum).
 */
export default function ChoixFormations({ valeur, onChange }: { valeur: DemandeSaisie[], onChange: (v: DemandeSaisie[]) => void }) {
  const slugs = valeur.map((d) => d.slug)
  const modifier = (slug: string, champ: Exclude<keyof DemandeSaisie, 'slug'>, v: string) =>
    onChange(valeur.map((d) => (d.slug === slug ? { ...d, [champ]: v } : d)))
  const [q, setQ] = useState('')
  const [famille, setFamille] = useState('')
  const [libre, setLibre] = useState('')
  const slugLibreSaisi = libre.trim() ? slugLibre(libre.trim()) : ''
  const ajouterLibre = () => {
    if (!slugLibreSaisi || slugs.includes(slugLibreSaisi) || valeur.length >= MAX) return
    onChange([...valeur, demandeVide(slugLibreSaisi, libre.trim())])
    setLibre('')
  }

  const resultats = useMemo(() => {
    const mots = sansAccent(q).split(/\s+/).filter(Boolean)
    return FICHES.filter((f) => !slugs.includes(f.slug)
      && (!famille || f.famille === famille)
      && mots.every((m) => sansAccent(f.titre).includes(m))).slice(0, 12)
  }, [q, famille, slugs.join()])
  const filtre = q.trim() !== '' || famille !== ''

  return (
    <div className="choix-formations">
      {valeur.length > 0 && (
        <ul className="demandes-formation" aria-label="Formations choisies">
          {valeur.map((d) => {
            const titre = ficheDe(d.slug)?.titre ?? d.intitule ?? d.slug
            return (
              <li key={d.slug} className="demande-formation">
                <div className="demande-formation__tete">
                  <strong>{titre}</strong>
                  <button type="button" className="lien-action lien-action--rouge" aria-label={`Retirer ${titre}`} onClick={() => onChange(valeur.filter((x) => x.slug !== d.slug))}><IconeCroix /> Retirer</button>
                </div>
                <div className="grille-2">
                  <div className="champ">
                    <label htmlFor={`nb-${d.slug}`}>Participants <span className="aide">(facultatif)</span></label>
                    <input id={`nb-${d.slug}`} className="saisie" type="number" inputMode="numeric" min={1} max={10000} value={d.nb_participants}
                      onChange={(e) => modifier(d.slug, 'nb_participants', e.target.value)} />
                  </div>
                  <div className="champ">
                    <label htmlFor={`date-${d.slug}`}>Date souhaitée <span className="aide">(facultatif)</span></label>
                    <input id={`date-${d.slug}`} className="saisie" type="date" value={d.date_souhaitee}
                      onChange={(e) => modifier(d.slug, 'date_souhaitee', e.target.value)} />
                  </div>
                </div>
                <div className="champ">
                  <label htmlFor={`note-${d.slug}`}>Note interne <span className="aide">(jamais visible du client)</span></label>
                  <textarea id={`note-${d.slug}`} className="saisie" rows={2} maxLength={1000} placeholder="Ex. sur site, personnel en 2×8"
                    value={d.note} onChange={(e) => modifier(d.slug, 'note', e.target.value)} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="grille-2">
        <div className="champ">
          <label htmlFor="cf-q">Rechercher une formation</label>
          <input id="cf-q" className="saisie" placeholder="Ex. SST, CACES, ATEX, incendie…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="champ">
          <label htmlFor="cf-famille">Famille</label>
          <select id="cf-famille" className="saisie" value={famille} onChange={(e) => setFamille(e.target.value)}>
            <option value="">Toutes ({FICHES.length} formations)</option>
            {FAMILLES.map((f) => <option key={f.id} value={f.label}>{f.label}</option>)}
          </select>
        </div>
      </div>
      {valeur.length >= MAX && <p className="texte-discret">{MAX} formations au maximum.</p>}
      {filtre && valeur.length < MAX && (
        <ul className="resultats-formations">
          {resultats.map((f) => (
            <li key={f.slug}>
              <button type="button" onClick={() => onChange([...valeur, demandeVide(f.slug)])}>
                <span>{f.titre}</span>
                <span className="texte-discret">{f.famille} · {f.duree}</span>
              </button>
            </li>
          ))}
          {resultats.length === 0 && <li className="texte-discret" style={{ padding: 10 }}>Aucune formation ne correspond.</li>}
        </ul>
      )}
      {valeur.length < MAX && (
        <div className="champ" style={{ marginTop: 10 }}>
          <label htmlFor="cf-libre">Une formation qui n’est pas dans le catalogue ? <span className="aide">Écrivez son intitulé.</span></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id="cf-libre" className="saisie" style={{ flex: 1, minWidth: 220 }} maxLength={200} placeholder="Ex. Gestes et postures en entrepôt" value={libre}
              onChange={(ev) => setLibre(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ajouterLibre() } }} />
            <button type="button" className="bouton bouton--secondaire" disabled={!slugLibreSaisi || slugs.includes(slugLibreSaisi)} onClick={ajouterLibre}>Ajouter cette formation</button>
          </div>
        </div>
      )}
    </div>
  )
}
