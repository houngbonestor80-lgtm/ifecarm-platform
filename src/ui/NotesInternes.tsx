'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, messageErreur } from '@/ui/api'
import { useContexteApp } from '@/ui/CadreApplication'
import { IconeCommentaire, IconeCroix } from '@/ui/icones'
import { dateHeureFr } from '@/ui/libelles'

type TypeObjet = 'inspection' | 'non_conformite' | 'action_corrective' | 'session_formation' | 'equipement' | 'declaration'
interface Note { id: string, auteur_nom: string, contenu: string, cree_le: string, supprimable: boolean }

/**
 * Notes internes de l'équipe IFECARM sur un objet (migration 0042). Jamais visibles du client : le composant
 * ne s'affiche que pour un consultant ou un administrateur, et la base refuse de toute façon la lecture aux autres.
 * `repli` : version discrète sous un élément de liste (action, équipement) — les notes ne se chargent qu'à l'ouverture.
 */
export function NotesInternes({ objetType, objetId, repli = false }: { objetType: TypeObjet, objetId: string, repli?: boolean }) {
  const { consultant } = useContexteApp()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [ouvert, setOuvert] = useState(!repli)
  const [texte, setTexte] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [enCours, setEnCours] = useState(false)

  const charger = useCallback(() => {
    api<{ notes: Note[] }>(`/api/notes?type=${objetType}&id=${objetId}`).then((r) => setNotes(r.notes)).catch((e) => setErreur(messageErreur(e)))
  }, [objetType, objetId])
  useEffect(() => { if (consultant && ouvert && notes === null) charger() }, [consultant, ouvert, notes, charger])

  if (!consultant) return null

  async function agir(fn: () => Promise<unknown>) {
    setErreur(null); setEnCours(true)
    try { await fn(); charger(); return true } catch (e) { setErreur(messageErreur(e)); return false } finally { setEnCours(false) }
  }

  const contenu = (
    <>
      {erreur && <div className="alerte alerte--erreur" role="alert" style={{ marginBottom: 10 }}>{erreur}</div>}
      {notes?.length === 0 && <p className="texte-discret">Aucune note pour l’instant.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
        {notes?.map((n) => (
          <li key={n.id} style={{ borderLeft: '2px solid var(--brand-200)', paddingLeft: 12 }}>
            <div className="texte-discret">
              <strong style={{ color: 'var(--ink-800)' }}>{n.auteur_nom}</strong> · {dateHeureFr(n.cree_le)}
              {n.supprimable && (
                <button type="button" className="lien-action lien-action--rouge" style={{ marginLeft: 10 }} disabled={enCours} aria-label="Supprimer la note"
                  onClick={() => window.confirm('Supprimer cette note ?') && agir(() => api(`/api/notes/${n.id}`, { method: 'DELETE' }))}><IconeCroix /></button>
              )}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.contenu}</div>
          </li>
        ))}
      </ul>
      <form style={{ marginTop: 12, display: 'grid', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void agir(() => api('/api/notes', { method: 'POST', corps: { objetType, objetId, contenu: texte } })).then((ok) => ok && setTexte('')) }}>
        <label className="visually-hidden" htmlFor={`note-${objetId}`}>Nouvelle note interne</label>
        <textarea id={`note-${objetId}`} className="saisie" rows={2} maxLength={2000} placeholder="Écrire une note…" value={texte} onChange={(e) => setTexte(e.target.value)} />
        <button type="submit" className="bouton bouton--petit bouton--secondaire" style={{ justifySelf: 'start' }} disabled={enCours || !texte.trim()}>Ajouter la note</button>
      </form>
    </>
  )

  if (repli) {
    return (
      <details style={{ marginTop: 8 }} onToggle={(e) => setOuvert((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="lien-action" style={{ cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <IconeCommentaire /> Notes internes{notes ? ` (${notes.length})` : ''}
        </summary>
        <div style={{ marginTop: 10 }}>{ouvert && contenu}</div>
      </details>
    )
  }
  return (
    <section className="carte" style={{ marginTop: 16 }}>
      <div className="carte__titre">
        <h2>Notes internes</h2>
        <span className="badge badge--neutre">Équipe IFECARM seulement</span>
      </div>
      {contenu}
    </section>
  )
}
