'use client'

import { useState } from 'react'
import { api, envoyerFormulaire, messageErreur } from '@/ui/api'
import { reduireImage as reduire } from '@/ui/image'
import ChoixPhoto from '@/ui/ChoixPhoto'
import { IconeCroix } from '@/ui/icones'

/**
 * Photos d'un point de contrôle ou d'une non-conformité. Sur téléphone, le
 * deux tuiles : « Photo » ouvre directement l'appareil photo (capture="environment"), « Galerie » le sélecteur de fichiers. Chaque
 * image est réduite dans le navigateur avant envoi (1600 px, JPEG) : sur une
 * connexion mobile lente, une photo de 5 Mo passe à ~300 Ko.
 */

export function Photos({ inspectionId, cible, cibleId, urlEnvoi, photos, modifiable, onChange }: {
  /** Photos d'inspection : inspection + cible (point ou NC). Autres objets (équipement) : `urlEnvoi` seule. */
  inspectionId?: string
  cible?: 'item' | 'nc'
  cibleId?: string
  urlEnvoi?: string
  photos: { id: string, nom: string }[]
  modifiable: boolean
  onChange: () => void | Promise<void>
}) {
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)

  if (!photos.length && !modifiable) return null

  async function ajouter(fichiers: FileList | null) {
    if (!fichiers?.length) return
    setErreur(null)
    setEnvoi(true)
    try {
      for (const fichier of Array.from(fichiers)) {
        const form = new FormData()
        if (cible && cibleId) { form.append('cible', cible); form.append('cibleId', cibleId) }
        form.append('photo', await reduire(fichier), fichier.name.replace(/\.\w+$/, '') + '.jpg')
        await envoyerFormulaire(urlEnvoi ?? `/api/inspections/${inspectionId}/photos`, form)
      }
    } catch (e) {
      setErreur(messageErreur(e))
    }
    setEnvoi(false)
    await onChange()
  }

  async function retirer(id: string) {
    if (!window.confirm('Supprimer cette photo ?')) return
    try {
      await api(`/api/photos/${id}`, { method: 'DELETE' })
    } catch (e) {
      setErreur(messageErreur(e))
    }
    await onChange()
  }

  return (
    <div className="photos">
      {photos.map((p) => (
        <div key={p.id} className="photo">
          <a href={`/api/photos/${p.id}`} target="_blank" rel="noopener" title={p.nom}>
            <img src={`/api/photos/${p.id}`} alt={p.nom} loading="lazy" />
          </a>
          {modifiable && (
            <button type="button" className="photo__retirer" aria-label={`Supprimer la photo ${p.nom}`} onClick={() => retirer(p.id)}>
              <IconeCroix />
            </button>
          )}
        </div>
      ))}
      {modifiable && photos.length < 10 && (
        <ChoixPhoto variante="tuile" envoi={envoi} onFichiers={(f) => void ajouter(f)} />
      )}
      {erreur && <p className="photos__erreur" role="alert">{erreur}</p>}
    </div>
  )
}
