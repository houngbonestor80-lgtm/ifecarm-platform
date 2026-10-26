import { randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { construireCleStockage, lireFichier, supprimerFichier, televerserFichier } from '@/storage/s3'
import { ErreurMetier, date, resoudreSite, texte, texteOptionnel, uuid } from '@/inspections/service'

/**
 * B4 habilitations (migration 0043). Les droits sont portés par la RLS : l'équipe IFECARM écrit ; l'équipe, l'admin
 * d'entreprise et le responsable QHSE lisent tout ; le responsable de site lit les salariés de son site. Ce module
 * ne contourne rien : il valide les entrées, enchaîne les opérations d'un renouvellement et traduit les refus de la
 * base (déclencheurs IF409, unicité, contrôles) en erreurs lisibles.
 */

export const DOMAINES = ['electrique', 'conduite_levage', 'hauteur', 'secourisme', 'incendie', 'autre'] as const
const STATUTS_SAISIS = ['active', 'suspendue', 'retiree'] as const

type Ctx = { entrepriseId: string, utilisateurId: string }

export async function traduireErreursBase<T>(cb: () => Promise<T>): Promise<T> {
  try {
    return await cb()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'IF409') throw new ErreurMetier(409, (e as Error).message)
    if (code === '23505') throw new ErreurMetier(409, 'Un titre en cours existe déjà pour ce salarié, ce type et ce niveau (ou ce code existe déjà).')
    if (code === '23503') throw new ErreurMetier(409, 'Référence invalide (élément d’une autre entreprise, supprimé ou encore utilisé).')
    if (code === '23514') throw new ErreurMetier(400, 'Valeurs incohérentes (dates, motif obligatoire…).')
    throw e
  }
}

const choix = <T extends string>(v: unknown, liste: readonly T[], champ: string): T => {
  if (!liste.includes(v as T)) throw new ErreurMetier(400, `${champ} invalide.`)
  return v as T
}
const entierBorne = (v: unknown, champ: string, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ErreurMetier(400, `${champ} invalide (${min} à ${max}).`)
  return n
}
const ajouterMois = (isoJour: string, mois: number): string => {
  const d = new Date(`${isoJour}T00:00:00Z`)
  const jour = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + mois)
  if (d.getUTCDate() !== jour) d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}
const aujourdhui = () => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Types d'habilitation
// ---------------------------------------------------------------------------

export async function listerTypes(trx: Transaction<DB>) {
  return trx.selectFrom('type_habilitation')
    .select(['id', 'entreprise_id', 'code', 'intitule', 'domaine', 'referentiel', 'validite_mois', 'actif'])
    .orderBy('domaine').orderBy('intitule').execute()
}

function valeursType(corps: Record<string, unknown>, creation: boolean) {
  const v: Record<string, unknown> = {}
  if (creation || 'code' in corps) v.code = texte(corps.code, 'Code', 40)
  if (creation || 'intitule' in corps) v.intitule = texte(corps.intitule, 'Intitulé', 200)
  if (creation || 'domaine' in corps) v.domaine = choix(corps.domaine, DOMAINES, 'Domaine')
  if ('referentiel' in corps) v.referentiel = texteOptionnel(corps.referentiel, 'Référentiel', 200)
  if ('validiteMois' in corps) v.validite_mois = entierBorne(corps.validiteMois, 'Validité', 1, 240)
  if ('actif' in corps) {
    if (typeof corps.actif !== 'boolean') throw new ErreurMetier(400, 'actif requis.')
    v.actif = corps.actif
  }
  return v
}

/** Type propre à une entreprise (équipe IFECARM) ; `entrepriseId` null = catalogue IFECARM (administrateur). */
export async function creerType(trx: Transaction<DB>, entrepriseId: string | null, corps: Record<string, unknown>) {
  const v = valeursType(corps, true)
  return traduireErreursBase(() => trx.insertInto('type_habilitation')
    .values({ ...v, entreprise_id: entrepriseId } as never).returning(['id', 'code']).executeTakeFirstOrThrow())
}

export async function modifierType(trx: Transaction<DB>, idBrut: unknown, corps: Record<string, unknown>, catalogue: boolean) {
  const id = uuid(idBrut, 'Type')
  const v = valeursType(corps, false)
  if ('code' in v) delete v.code // le code identifie le type dans la matrice : il ne change pas
  if (!Object.keys(v).length) throw new ErreurMetier(400, 'Aucune modification.')
  let q = trx.updateTable('type_habilitation').set(v as never).where('id', '=', id)
  q = catalogue ? q.where('entreprise_id', 'is', null) : q.where('entreprise_id', 'is not', null)
  const r = await traduireErreursBase(() => q.executeTakeFirst())
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, catalogue ? 'Type du catalogue introuvable.' : 'Type introuvable (ou du catalogue : réservé à l’administrateur).')
}

// ---------------------------------------------------------------------------
// Salariés
// ---------------------------------------------------------------------------

/** `restreint` : le responsable de site ne voit que les salariés de SON site (la liste des salariés est lisible de tout le tenant, pas son périmètre B4). */
export async function listerSalaries(trx: Transaction<DB>, restreint = false) {
  let q = trx.selectFrom('salarie as s').leftJoin('site', 'site.id', 's.site_id')
    .select(['s.id', 's.nom', 's.prenom', 's.poste', 's.service', 's.matricule', 'site.nom as site_nom', 's.actif'])
    .where('s.actif', '=', true).where((eb) => eb.or([eb('s.date_sortie', 'is', null), eb('s.date_sortie', '>=', sql<Date>`current_date`)]))
  if (restreint) q = q.where(sql<boolean>`est_responsable_du_salarie_courant(s.id)`)
  return q.orderBy('s.nom').orderBy('s.prenom').limit(2000).execute()
}

export async function creerSalarie(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const siteId = await resoudreSite(trx, ctx.entrepriseId, corps)
  const s = await traduireErreursBase(() => trx.insertInto('salarie').values({
    entreprise_id: ctx.entrepriseId, nom: texte(corps.nom, 'Nom', 120), prenom: texte(corps.prenom, 'Prénom', 120),
    poste: texteOptionnel(corps.poste, 'Poste', 120), service: texteOptionnel(corps.service, 'Service', 120),
    matricule: texteOptionnel(corps.matricule, 'Matricule', 60), site_id: siteId,
  }).returning('id').executeTakeFirstOrThrow())
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'salarie', objetId: s.id, details: null })
  return s
}

// ---------------------------------------------------------------------------
// Lecture : matrice et fiche salarié
// ---------------------------------------------------------------------------

/** Matrice « qui est habilité à quoi » : salariés en poste × types, avec les titres EN COURS (active ou suspendue). */
export async function matrice(trx: Transaction<DB>, restreint = false) {
  const salaries = await listerSalaries(trx, restreint)
  const types = await trx.selectFrom('type_habilitation').select(['id', 'code', 'intitule', 'domaine', 'actif']).orderBy('domaine').orderBy('intitule').execute()
  const { rows: titres } = await sql<{
    id: string, salarie_id: string, type_id: string, niveau: string | null, date_validite: string | null, statut: string, etat: string, jours_restants: number | null,
  }>`
    select h.id, h.salarie_id, h.type_id, h.niveau, h.date_validite::text as date_validite, h.statut,
           etat_habilitation(h.statut, h.date_validite) as etat,
           case when h.date_validite is null then null else h.date_validite - current_date end as jours_restants
    from habilitation h where h.statut in ('active', 'suspendue')`.execute(trx)
  return { salaries, types, titres }
}

export async function ficheSalarie(trx: Transaction<DB>, idBrut: unknown, restreint = false) {
  const id = uuid(idBrut, 'Salarié')
  if (restreint) {
    const { rows: [ok] } = await sql<{ ok: boolean }>`select est_responsable_du_salarie_courant(${id}::uuid) as ok`.execute(trx)
    if (!ok?.ok) throw new ErreurMetier(404, 'Salarié introuvable.')
  }
  const salarie = await trx.selectFrom('salarie as s').leftJoin('site', 'site.id', 's.site_id')
    .select(['s.id', 's.nom', 's.prenom', 's.poste', 's.service', 's.matricule', 's.actif', 'site.nom as site_nom'])
    .where('s.id', '=', id).executeTakeFirst()
  if (!salarie) throw new ErreurMetier(404, 'Salarié introuvable.')
  const { rows: titres } = await sql<{
    id: string, type_id: string, type_code: string, type_intitule: string, niveau: string | null, reference_titre: string | null, delivre_par: string | null,
    date_delivrance: string, date_validite: string | null, statut: string, etat: string, jours_restants: number | null, motif: string | null,
    commentaire: string | null, renouvelle_id: string | null, attestation_id: string | null, attestation_intitule: string | null, fichier_id: string | null, cree_le: string,
  }>`
    select h.id, h.type_id, t.code as type_code, t.intitule as type_intitule, h.niveau, h.reference_titre, h.delivre_par,
           h.date_delivrance::text as date_delivrance, h.date_validite::text as date_validite, h.statut,
           etat_habilitation(h.statut, h.date_validite) as etat,
           case when h.date_validite is null then null else h.date_validite - current_date end as jours_restants,
           h.motif, h.commentaire, h.renouvelle_id, h.attestation_id, a.intitule_formation as attestation_intitule, h.fichier_id, h.cree_le::text as cree_le
    from habilitation h
    join type_habilitation t on t.id = h.type_id
    left join attestation a on a.id = h.attestation_id
    where h.salarie_id = ${id}
    order by t.intitule, h.cree_le desc`.execute(trx)
  return { salarie, titres }
}

/** Attestations de formation valides du salarié (B2), proposées pour justifier une habilitation. */
export async function attestationsDuSalarie(trx: Transaction<DB>, idBrut: unknown) {
  const id = uuid(idBrut, 'Salarié')
  const { rows } = await sql<{ id: string, intitule_formation: string, date_fin: string, expire_le: string | null }>`
    select a.id, a.intitule_formation, a.date_fin::text as date_fin, a.expire_le::text as expire_le
    from attestation a join participant p on p.id = a.participant_id
    where p.salarie_id = ${id} and a.statut = 'valide' order by a.date_fin desc`.execute(trx)
  return rows
}

// ---------------------------------------------------------------------------
// Écriture (équipe IFECARM)
// ---------------------------------------------------------------------------

interface Titre {
  niveau: string | null, reference_titre: string | null, delivre_par: string | null, date_delivrance: string,
  date_validite: string | null, attestation_id: string | null, commentaire: string | null,
}

/** Validité : saisie explicite (null = sans échéance) ; sinon celle de l'attestation liée ; sinon délivrance + durée habituelle du type. */
async function lireTitre(trx: Transaction<DB>, corps: Record<string, unknown>, typeId: string): Promise<Titre> {
  const dateDelivrance = date(corps.dateDelivrance, 'Date de délivrance')
  if (dateDelivrance > aujourdhui()) throw new ErreurMetier(400, 'La date de délivrance ne peut pas être dans le futur.')
  const attestationId = corps.attestationId ? uuid(corps.attestationId, 'Attestation') : null
  let validite: string | null
  if ('dateValidite' in corps) {
    validite = corps.dateValidite === null || corps.dateValidite === '' ? null : date(corps.dateValidite, 'Date de validité')
  } else if (attestationId) {
    const a = await trx.selectFrom('attestation').select(sql<string | null>`expire_le::text`.as('expire_le')).where('id', '=', attestationId).executeTakeFirst()
    if (!a) throw new ErreurMetier(404, 'Attestation introuvable.')
    validite = a.expire_le
  } else {
    const t = await trx.selectFrom('type_habilitation').select('validite_mois').where('id', '=', typeId).executeTakeFirst()
    validite = t?.validite_mois ? ajouterMois(dateDelivrance, t.validite_mois) : null
  }
  if (validite && validite < dateDelivrance) throw new ErreurMetier(400, 'La date de validité précède la date de délivrance.')
  return {
    niveau: texteOptionnel(corps.niveau, 'Niveau', 100), reference_titre: texteOptionnel(corps.referenceTitre, 'Référence du titre', 200),
    delivre_par: texteOptionnel(corps.delivrePar, 'Organisme', 200), date_delivrance: dateDelivrance, date_validite: validite,
    attestation_id: attestationId, commentaire: texteOptionnel(corps.commentaire, 'Commentaire', 2000),
  }
}

/**
 * Type d'habilitation écrit à la main (hors catalogue) : propre à l'entreprise, réutilisable ensuite. Un intitulé déjà connu
 * (catalogue ou entreprise, casse ignorée) est réutilisé au lieu d'être dupliqué.
 */
async function typeEcrit(trx: Transaction<DB>, ctx: Ctx, brut: Record<string, unknown>): Promise<string> {
  const intitule = texte(brut.intitule, 'Intitulé du type', 200).trim()
  const connu = await trx.selectFrom('type_habilitation').select('id').where('actif', '=', true)
    .where(sql<boolean>`lower(btrim(intitule)) = lower(btrim(${intitule}))`).executeTakeFirst()
  if (connu) return connu.id
  const base = intitule.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'TYPE'
  const t = await creerType(trx, ctx.entrepriseId, {
    code: `${base}-${randomBytes(2).toString('hex').toUpperCase()}`, intitule, domaine: brut.domaine ?? 'autre',
    ...(brut.referentiel ? { referentiel: brut.referentiel } : {}), ...(brut.validiteMois ? { validiteMois: brut.validiteMois } : {}),
  })
  return t.id
}

export async function creerHabilitation(trx: Transaction<DB>, ctx: Ctx, corps: Record<string, unknown>) {
  const salarieId = uuid(corps.salarieId, 'Salarié')
  const typeId = corps.nouveauType && typeof corps.nouveauType === 'object' && !corps.typeId
    ? await typeEcrit(trx, ctx, corps.nouveauType as Record<string, unknown>)
    : uuid(corps.typeId, 'Type')
  const titre = await lireTitre(trx, corps, typeId)
  const h = await traduireErreursBase(() => trx.insertInto('habilitation')
    .values({ entreprise_id: ctx.entrepriseId, salarie_id: salarieId, type_id: typeId, ...titre } as never).returning('id').executeTakeFirstOrThrow())
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'habilitation', objetId: h.id, details: { typeId } })
  return h
}

/** Corrige les faits d'un titre en cours, ou change son statut (suspendre, réactiver, retirer). « Remplacée » ne se pose que par un renouvellement. */
export async function modifierHabilitation(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Habilitation')
  const v: Record<string, unknown> = {}
  if ('niveau' in corps) v.niveau = texteOptionnel(corps.niveau, 'Niveau', 100)
  if ('referenceTitre' in corps) v.reference_titre = texteOptionnel(corps.referenceTitre, 'Référence du titre', 200)
  if ('delivrePar' in corps) v.delivre_par = texteOptionnel(corps.delivrePar, 'Organisme', 200)
  if ('dateDelivrance' in corps) v.date_delivrance = date(corps.dateDelivrance, 'Date de délivrance')
  if ('dateValidite' in corps) v.date_validite = corps.dateValidite === null || corps.dateValidite === '' ? null : date(corps.dateValidite, 'Date de validité')
  if ('commentaire' in corps) v.commentaire = texteOptionnel(corps.commentaire, 'Commentaire', 2000)
  if ('statut' in corps) {
    v.statut = choix(corps.statut, STATUTS_SAISIS, 'Statut')
    if (v.statut !== 'active') v.motif = texte(corps.motif, 'Motif', 1000)
  }
  if (!Object.keys(v).length) throw new ErreurMetier(400, 'Aucune modification.')
  const r = await traduireErreursBase(() => trx.updateTable('habilitation').set(v as never).where('id', '=', id).executeTakeFirst())
  if (!Number(r.numUpdatedRows)) throw new ErreurMetier(404, 'Habilitation introuvable.')
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'habilitation', objetId: id, details: { champs: Object.keys(v) } })
}

/** Renouvellement : l'ancien titre passe « remplacée » et un NOUVEAU titre le remplace, dans la même transaction. */
export async function renouveler(trx: Transaction<DB>, ctx: Ctx, ancienIdBrut: unknown, corps: Record<string, unknown>) {
  const ancienId = uuid(ancienIdBrut, 'Habilitation')
  const ancien = await trx.selectFrom('habilitation').select(['salarie_id', 'type_id', 'niveau', 'statut']).where('id', '=', ancienId).executeTakeFirst()
  if (!ancien) throw new ErreurMetier(404, 'Habilitation introuvable.')
  if (ancien.statut !== 'active' && ancien.statut !== 'suspendue') throw new ErreurMetier(409, 'Seul un titre en cours se renouvelle.')
  const titre = await lireTitre(trx, corps, ancien.type_id)
  if (!('niveau' in corps)) titre.niveau = ancien.niveau
  const nouveau = await traduireErreursBase(async () => {
    await trx.updateTable('habilitation').set({ statut: 'remplacee' }).where('id', '=', ancienId).execute()
    const h = await trx.insertInto('habilitation')
      .values({ entreprise_id: ctx.entrepriseId, salarie_id: ancien.salarie_id, type_id: ancien.type_id, renouvelle_id: ancienId, ...titre } as never)
      .returning('id').executeTakeFirstOrThrow()
    await sql`set constraints all immediate`.execute(trx) // contrôle du successeur ici, pas au COMMIT
    return h
  })
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'habilitation', objetId: nouveau.id, details: { renouvelle: ancienId } })
  return nouveau
}

export async function supprimerHabilitation(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown) {
  const id = uuid(idBrut, 'Habilitation')
  const h = await trx.selectFrom('habilitation').select(['fichier_id']).where('id', '=', id).executeTakeFirst()
  if (!h) throw new ErreurMetier(404, 'Habilitation introuvable.')
  const fichier = h.fichier_id ? await trx.selectFrom('fichier').select('cle_stockage').where('id', '=', h.fichier_id).executeTakeFirst() : undefined
  await traduireErreursBase(async () => {
    await trx.deleteFrom('habilitation').where('id', '=', id).execute()
    await sql`set constraints all immediate`.execute(trx)
  })
  if (h.fichier_id) await trx.deleteFrom('fichier').where('id', '=', h.fichier_id).execute()
  if (fichier) await supprimerFichier(fichier.cle_stockage).catch(() => {})
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'habilitation', objetId: id, details: null })
}

// ---------------------------------------------------------------------------
// Justificatif (titre scanné) : passe par le serveur, type vérifié sur les premiers octets
// ---------------------------------------------------------------------------

const TAILLE_MAX = 8 * 1024 * 1024

function typeReel(o: Uint8Array): string | null {
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return 'image/jpeg'
  if (o[0] === 0x89 && o[1] === 0x50 && o[2] === 0x4e && o[3] === 0x47) return 'image/png'
  const ascii = (a: number, b: number) => String.fromCharCode(...o.slice(a, b))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  return null
}

/** Joint (ou remplace) le justificatif d'une habilitation en cours. Un seul fichier par titre. */
export async function joindreJustificatif(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, entree: { octets: Uint8Array, nom: string }) {
  const id = uuid(idBrut, 'Habilitation')
  if (!entree.octets.length) throw new ErreurMetier(400, 'Fichier vide.')
  if (entree.octets.length > TAILLE_MAX) throw new ErreurMetier(400, 'Fichier trop lourd (8 Mo maximum).')
  const type = typeReel(entree.octets)
  if (!type) throw new ErreurMetier(400, 'Format non accepté : PDF, JPEG, PNG ou WebP.')
  const h = await trx.selectFrom('habilitation').select(['fichier_id', 'statut']).where('id', '=', id).executeTakeFirst()
  if (!h) throw new ErreurMetier(404, 'Habilitation introuvable.')
  if (h.statut === 'retiree' || h.statut === 'remplacee') throw new ErreurMetier(409, 'Une habilitation retirée ou remplacée est figée.')
  const ancien = h.fichier_id ? await trx.selectFrom('fichier').select('cle_stockage').where('id', '=', h.fichier_id).executeTakeFirst() : undefined

  const nom = (entree.nom || 'justificatif').slice(0, 200)
  const cle = construireCleStockage(ctx.entrepriseId, nom)
  await televerserFichier(cle, entree.octets, type)
  const fichierId = randomUUID()
  try {
    await trx.insertInto('fichier').values({
      id: fichierId, entreprise_id: ctx.entrepriseId, cle_stockage: cle, nom_origine: nom, type_mime: type,
      taille_octets: entree.octets.length, objet_type: 'habilitation', objet_id: id, televerse_par: ctx.utilisateurId,
    }).execute()
    await traduireErreursBase(() => trx.updateTable('habilitation').set({ fichier_id: fichierId }).where('id', '=', id).execute())
  } catch (e) {
    await supprimerFichier(cle).catch(() => {})
    throw e
  }
  if (h.fichier_id) {
    await trx.deleteFrom('fichier').where('id', '=', h.fichier_id).execute()
    if (ancien) await supprimerFichier(ancien.cle_stockage).catch(() => {})
  }
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'modification', objetType: 'habilitation', objetId: id, details: { justificatif: true } })
  return { id: fichierId }
}

export async function lireJustificatif(trx: Transaction<DB>, fichierIdBrut: unknown): Promise<{ octets: Uint8Array, typeMime: string, nom: string }> {
  const id = uuid(fichierIdBrut, 'Fichier')
  // Sous RLS : le fichier n'est visible que de ceux qui peuvent lire l'habilitation (0043).
  const f = await trx.selectFrom('fichier').select(['cle_stockage', 'type_mime', 'nom_origine']).where('id', '=', id).where('objet_type', '=', 'habilitation').executeTakeFirst()
  if (!f) throw new ErreurMetier(404, 'Justificatif introuvable.')
  return { octets: await lireFichier(f.cle_stockage), typeMime: f.type_mime ?? 'application/octet-stream', nom: f.nom_origine }
}

export async function retirerJustificatif(trx: Transaction<DB>, ctx: Ctx, fichierIdBrut: unknown) {
  const id = uuid(fichierIdBrut, 'Fichier')
  const f = await trx.selectFrom('fichier').select('cle_stockage').where('id', '=', id).where('objet_type', '=', 'habilitation').executeTakeFirst()
  if (!f) throw new ErreurMetier(404, 'Justificatif introuvable.')
  const r = await trx.deleteFrom('fichier').where('id', '=', id).executeTakeFirst()
  if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Justificatif introuvable.')
  await supprimerFichier(f.cle_stockage).catch(() => {})
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'justificatif_habilitation', objetId: id, details: null })
}

// ---------------------------------------------------------------------------
// Résumé pour le tableau de bord (responsables et équipe)
// ---------------------------------------------------------------------------

/** Chiffres sous la RLS de l'appelant : réservés à ceux qui lisent toute l'entreprise (un responsable de site n'en verrait qu'une partie). */
export async function resumeHabilitations(trx: Transaction<DB>) {
  const { rows: [c] } = await sql<{ valides: number, a_renouveler: number, urgentes: number, expirees: number, suspendues: number }>`
    select count(*) filter (where etat_habilitation(statut, date_validite) = 'valide')::int as valides,
           count(*) filter (where etat_habilitation(statut, date_validite) = 'a_renouveler')::int as a_renouveler,
           count(*) filter (where statut = 'active' and date_validite is not null and date_validite >= current_date and date_validite - current_date <= 30)::int as urgentes,
           count(*) filter (where etat_habilitation(statut, date_validite) = 'expiree')::int as expirees,
           count(*) filter (where statut = 'suspendue')::int as suspendues
    from habilitation where statut in ('active', 'suspendue')`.execute(trx)
  const { rows: urgentes } = await sql<{ id: string, salarie_id: string, salarie: string, type_intitule: string, niveau: string | null, date_validite: string, jours_restants: number }>`
    select h.id, h.salarie_id, s.prenom || ' ' || s.nom as salarie, t.intitule as type_intitule, h.niveau, h.date_validite::text as date_validite,
           (h.date_validite - current_date) as jours_restants
    from habilitation h join salarie s on s.id = h.salarie_id join type_habilitation t on t.id = h.type_id
    where h.statut = 'active' and h.date_validite is not null and h.date_validite - current_date <= 90
      and s.actif and (s.date_sortie is null or s.date_sortie >= current_date)
    order by h.date_validite, s.nom limit 5`.execute(trx)
  return { valides: c?.valides ?? 0, a_renouveler: c?.a_renouveler ?? 0, urgentes: c?.urgentes ?? 0, expirees: c?.expirees ?? 0, suspendues: c?.suspendues ?? 0, a_traiter: urgentes }
}
