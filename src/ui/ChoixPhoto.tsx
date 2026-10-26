'use client'

import { useRef } from 'react'
import { IconeAppareilPhoto, IconeGalerie } from './icones'

/**
 * Deux actions distinctes pour ajouter une photo : « Prendre une photo » (caméra arrière, `capture`) et « Choisir depuis la
 * galerie » (sélecteur de fichiers classique). Sur ordinateur, `capture` est ignoré : les deux ouvrent le sélecteur de fichiers.
 * Le composant ne traite rien : chaque écran garde son propre traitement (ré-encodage canvas, envoi, contrôles du serveur).
 *   variante « tuile »  : deux petites tuiles carrées (écrans de photos par objet) ;
 *   variante « bouton » : deux boutons texte (formulaires).
 */
export default function ChoixPhoto({ onFichiers, desactive = false, envoi = false, variante = 'bouton' }: {
  onFichiers: (fichiers: FileList | null) => void
  desactive?: boolean
  envoi?: boolean
  variante?: 'tuile' | 'bouton'
}) {
  const camera = useRef<HTMLInputElement>(null)
  const galerie = useRef<HTMLInputElement>(null)
  const recu = (e: React.ChangeEvent<HTMLInputElement>) => { onFichiers(e.target.files); e.target.value = '' }
  const bloque = desactive || envoi
  const tuile = variante === 'tuile'
  const classe = (extra = '') => (tuile ? `photo-ajout ${envoi ? 'photo-ajout--envoi' : ''}` : `bouton bouton--secondaire ${extra}`)

  return (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" multiple hidden disabled={bloque} onChange={recu} />
      <input ref={galerie} type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple hidden disabled={bloque} onChange={recu} />
      <button type="button" className={classe()} disabled={bloque} onClick={() => camera.current?.click()}>
        <IconeAppareilPhoto />
        <span>{envoi && tuile ? 'Envoi…' : tuile ? 'Photo' : 'Prendre une photo'}</span>
      </button>
      <button type="button" className={classe()} disabled={bloque} onClick={() => galerie.current?.click()}>
        <IconeGalerie />
        <span>{tuile ? 'Galerie' : 'Choisir depuis la galerie'}</span>
      </button>
    </>
  )
}
