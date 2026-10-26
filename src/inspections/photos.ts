import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { construireCleStockage, lireFichier, supprimerFichier, televerserFichier } from '@/storage/s3'
import { ErreurMetier, exigerInspectionModifiable, uuid } from './service'

/**
 * Photos d'inspection (preuves terrain) : rattachées à un point de contrôle
 * (objet_type 'item_inspection') ou à une non-conformité ('non_conformite')
 * via la table `fichier` (RLS : cloisonnement par entreprise).
 *
 * Le fichier transite par le serveur (pas d'URL présignée) : son type RÉEL est
 * vérifié sur les premiers octets, jamais sur l'extension ou le Content-Type
 * annoncés par le navigateur. Les photos sont réduites côté navigateur avant
 * envoi (connexions mobiles lentes sur le terrain).
 */

const TAILLE_MAX = 8 * 1024 * 1024
const MAX_PAR_OBJET = 10
const OBJETS = { item: 'item_inspection', nc: 'non_conformite' } as const
/** Photos du registre des équipements : même stockage, sans inspection (écriture consultant, lecture par tout le tenant). */
export const OBJET_EQUIPEMENT = 'equipement'
type Cible = keyof typeof OBJETS

function typeReel(o: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return 'image/jpeg'
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) return 'image/png'
  const ascii = (a: number, b: number) => String.fromCharCode(...o.slice(a, b))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** Inspection à laquelle appartient la cible (point ou NC), ou 404. */
async function inspectionDeLaCible(trx: Transaction<DB>, cible: Cible, cibleId: string): Promise<string> {
  const ligne = cible === 'item'
    ? await trx.selectFrom('item_inspection').select('inspection_id').where('id', '=', cibleId).executeTakeFirst()
    : await trx.selectFrom('non_conformite').select('inspection_id').where('id', '=', cibleId).executeTakeFirst()
  if (!ligne) throw new ErreurMetier(404, cible === 'item' ? 'Point de contrôle introuvable.' : 'Non-conformité introuvable.')
  return ligne.inspection_id
}

export async function ajouterPhoto(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string, utilisateurId: string },
  inspectionId: unknown,
  entree: { cible: unknown, cibleId: unknown, octets: Uint8Array, nom: string },
): Promise<{ id: string }> {
  const inspection = uuid(inspectionId, 'Inspection')
  if (entree.cible !== 'item' && entree.cible !== 'nc') throw new ErreurMetier(400, 'Cible invalide (item ou nc).')
  const cible = entree.cible
  const cibleId = uuid(entree.cibleId, 'Cible')

  if ((await inspectionDeLaCible(trx, cible, cibleId)) !== inspection) {
    throw new ErreurMetier(404, 'Cet élément n’appartient pas à cette inspection.')
  }
  await exigerInspectionModifiable(trx, inspection)

  if (!entree.octets.length) throw new ErreurMetier(400, 'Fichier vide.')
  if (entree.octets.length > TAILLE_MAX) throw new ErreurMetier(400, 'Photo trop lourde (8 Mo maximum).')
  const type = typeReel(entree.octets)
  if (!type) throw new ErreurMetier(400, 'Format non accepté : JPEG, PNG ou WebP uniquement.')

  const { n } = await trx
    .selectFrom('fichier')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('objet_type', '=', OBJETS[cible])
    .where('objet_id', '=', cibleId)
    .executeTakeFirstOrThrow()
  if (Number(n) >= MAX_PAR_OBJET) throw new ErreurMetier(409, `${MAX_PAR_OBJET} photos maximum par élément.`)

  const nom = (entree.nom || 'photo').slice(0, 200)
  const cle = construireCleStockage(ctx.entrepriseId, nom)
  await televerserFichier(cle, entree.octets, type)
  try {
    const f = await trx
      .insertInto('fichier')
      .values({
        entreprise_id: ctx.entrepriseId,
        cle_stockage: cle,
        nom_origine: nom,
        type_mime: type,
        taille_octets: entree.octets.length,
        objet_type: OBJETS[cible],
        objet_id: cibleId,
        televerse_par: ctx.utilisateurId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id: f.id }
  } catch (e) {
    await supprimerFichier(cle).catch(() => undefined)
    throw e
  }
}

/** Photo d'un équipement du registre (JPEG/PNG/WebP vérifié sur les octets, 8 Mo, 10 par équipement). */
export async function ajouterPhotoEquipement(
  trx: Transaction<DB>,
  ctx: { entrepriseId: string, utilisateurId: string },
  equipementId: unknown,
  entree: { octets: Uint8Array, nom: string },
): Promise<{ id: string }> {
  const id = uuid(equipementId, 'Équipement')
  if (!(await trx.selectFrom('equipement').select('id').where('id', '=', id).executeTakeFirst())) throw new ErreurMetier(404, 'Équipement introuvable.')
  if (!entree.octets.length) throw new ErreurMetier(400, 'Fichier vide.')
  if (entree.octets.length > TAILLE_MAX) throw new ErreurMetier(400, 'Photo trop lourde (8 Mo maximum).')
  const type = typeReel(entree.octets)
  if (!type) throw new ErreurMetier(400, 'Format non accepté : JPEG, PNG ou WebP uniquement.')
  const { n } = await trx.selectFrom('fichier').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('objet_type', '=', OBJET_EQUIPEMENT).where('objet_id', '=', id).executeTakeFirstOrThrow()
  if (Number(n) >= MAX_PAR_OBJET) throw new ErreurMetier(409, `${MAX_PAR_OBJET} photos maximum par équipement.`)
  const nom = (entree.nom || 'photo').slice(0, 200)
  const cle = construireCleStockage(ctx.entrepriseId, nom)
  await televerserFichier(cle, entree.octets, type)
  try {
    const f = await trx.insertInto('fichier').values({
      entreprise_id: ctx.entrepriseId, cle_stockage: cle, nom_origine: nom, type_mime: type, taille_octets: entree.octets.length,
      objet_type: OBJET_EQUIPEMENT, objet_id: id, televerse_par: ctx.utilisateurId,
    }).returning('id').executeTakeFirstOrThrow()
    return { id: f.id }
  } catch (e) {
    await supprimerFichier(cle).catch(() => undefined)
    throw e
  }
}

/** Photo d'inspection ou d'équipement visible dans le tenant (RLS), ou 404 — jamais un autre type de fichier. */
async function photoVisible(trx: Transaction<DB>, fichierId: unknown) {
  const id = uuid(fichierId, 'Photo')
  const f = await trx
    .selectFrom('fichier')
    .select(['id', 'cle_stockage', 'type_mime', 'objet_type', 'objet_id'])
    .where('id', '=', id)
    .where('objet_type', 'in', [...Object.values(OBJETS), OBJET_EQUIPEMENT])
    .executeTakeFirst()
  if (!f) throw new ErreurMetier(404, 'Photo introuvable.')
  return f
}

export async function lirePhoto(trx: Transaction<DB>, fichierId: unknown) {
  const f = await photoVisible(trx, fichierId)
  return { octets: await lireFichier(f.cle_stockage), typeMime: f.type_mime ?? 'application/octet-stream' }
}

export async function supprimerPhoto(trx: Transaction<DB>, fichierId: unknown) {
  const f = await photoVisible(trx, fichierId)
  if (f.objet_type === OBJET_EQUIPEMENT) {
    await trx.deleteFrom('fichier').where('id', '=', f.id).execute()
    await supprimerFichier(f.cle_stockage).catch(() => undefined)
    return
  }
  const cible: Cible = f.objet_type === OBJETS.nc ? 'nc' : 'item'
  await exigerInspectionModifiable(trx, await inspectionDeLaCible(trx, cible, f.objet_id!))
  await trx.deleteFrom('fichier').where('id', '=', f.id).execute()
  await supprimerFichier(f.cle_stockage).catch(() => undefined)
}
