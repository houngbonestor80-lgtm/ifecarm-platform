/**
 * Réduction d'une photo dans le navigateur avant envoi (1600 px, JPEG) : sur une connexion mobile lente,
 * une photo de 5 Mo passe à ~300 Ko. Le passage par un canvas applique l'orientation EXIF puis supprime
 * toutes les métadonnées (position GPS comprise).
 */

const COTE_MAX = 1600

export async function reduireImage(fichier: File | Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(fichier).catch(() => null)
  if (!bitmap) return fichier // format non lisible par le navigateur : le serveur tranchera
  const echelle = Math.min(1, COTE_MAX / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * echelle)
  canvas.height = Math.round(bitmap.height * echelle)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? fichier), 'image/jpeg', 0.82))
}
