import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import QRCode from 'qrcode'
import { PDFDocument, degrees, rgb, type PDFFont, type RGB } from 'pdf-lib'
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ecrireJournal } from '@/db/journal'
import { ErreurMetier, texteOptionnel, uuid } from '@/inspections/service'
import { dateFr } from '@/ui/libelles'

/**
 * B2 attestations : émission en lot pour une session réalisée, PDF avec QR code
 * de vérification, annulation. Données figées à l'émission (trigger 0029).
 * Une annulation est DÉFINITIVE : l'attestation disparaît (0034), sans retour possible ;
 * le participant redevient éligible à une nouvelle attestation. Conditions : session réalisée, participant déclaré apte, présent à toutes
 * les demi-journées de la session.
 */

type Ctx = { entrepriseId: string, utilisateurId: string }

const DOSSIER_ASSETS = path.join(process.cwd(), 'assets', 'pdf')
const MAX_JOURS = 31

const joursDe = (debut: string, fin: string): string[] => {
  const jours: string[] = []
  for (let d = new Date(`${debut}T00:00:00Z`); d <= new Date(`${fin}T00:00:00Z`) && jours.length < MAX_JOURS; d.setUTCDate(d.getUTCDate() + 1)) {
    jours.push(d.toISOString().slice(0, 10))
  }
  return jours
}

const ajouterMois = (isoJour: string, mois: number): string => {
  const d = new Date(`${isoJour}T00:00:00Z`)
  const jour = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + mois)
  if (d.getUTCDate() !== jour) d.setUTCDate(0) // 31 janvier + 1 mois → fin février
  return d.toISOString().slice(0, 10)
}

/** Durée de la formation d'après le catalogue (texte du site, sinon nombre de jours) ; à défaut, heures de la session. */
const dureeFormation = (s: { duree_libelle: string | null, duree_jours: string | null, duree_heures: string | null }): string | null => {
  if (s.duree_libelle?.trim() && !/sur mesure/i.test(s.duree_libelle)) return s.duree_libelle.trim()
  if (s.duree_jours != null) { const n = Number(s.duree_jours); return `${String(n).replace('.', ',')} jour${n > 1 ? 's' : ''}` }
  return s.duree_heures == null ? null : `${Number(s.duree_heures).toString().replace('.', ',')} heures`
}

export async function listerAttestationsSession(trx: Transaction<DB>, sessionIdBrut: unknown) {
  const sessionId = uuid(sessionIdBrut, 'Session')
  const { rows } = await sql<{
    id: string, participant_id: string, nom_salarie: string, prenom_salarie: string, statut: string,
    emise_le: string, expire_le: string | null, motif_annulation: string | null,
  }>`
    select a.id, a.participant_id, a.nom_salarie, a.prenom_salarie, a.statut,
           to_char(a.emise_le, 'YYYY-MM-DD') as emise_le, to_char(a.expire_le, 'YYYY-MM-DD') as expire_le, a.motif_annulation
    from attestation a join participant p on p.id = a.participant_id
    where p.session_id = ${sessionId} order by a.nom_salarie, a.prenom_salarie`.execute(trx)
  return rows
}

/** Émet les attestations des participants éligibles qui n'en ont pas déjà une valide. */
export async function emettreAttestations(trx: Transaction<DB>, ctx: Ctx, sessionIdBrut: unknown) {
  const sessionId = uuid(sessionIdBrut, 'Session')
  const { rows: [s] } = await sql<{
    statut: string, intitule: string, validite_mois: number | null, formateur_nom: string | null,
    duree_heures: string | null, duree_libelle: string | null, duree_jours: string | null, debut: string, fin: string, entreprise: string,
  }>`
    select s.statut, f.intitule, f.validite_mois, f.duree_libelle, f.duree_jours::text as duree_jours, s.formateur_nom, s.duree_heures::text as duree_heures,
           to_char(s.date_debut, 'YYYY-MM-DD') as debut, to_char(s.date_fin, 'YYYY-MM-DD') as fin, e.nom as entreprise
    from session_formation s join formation f on f.id = s.formation_id join entreprise e on e.id = s.entreprise_id
    where s.id = ${sessionId}`.execute(trx)
  if (!s) throw new ErreurMetier(404, 'Session introuvable.')
  if (s.statut !== 'realisee') throw new ErreurMetier(409, 'Les attestations s’émettent une fois la session passée au statut « Réalisée ».')

  const demiJournees = joursDe(s.debut, s.fin).length * 2
  const { rows: candidats } = await sql<{ id: string, nom: string, prenom: string, resultat: string | null, statut: string, presences: number, deja: boolean }>`
    select p.id, sa.nom, sa.prenom, p.resultat, p.statut,
           (select count(*)::int from emargement e where e.participant_id = p.id and e.present) as presences,
           exists (select 1 from attestation a where a.participant_id = p.id and a.statut = 'valide') as deja
    from participant p join salarie sa on sa.id = p.salarie_id
    where p.session_id = ${sessionId} order by sa.nom, sa.prenom`.execute(trx)

  const emises: string[] = []
  const ignores: { nom: string, motif: string }[] = []
  const emiseLe = new Date().toISOString().slice(0, 10)
  for (const c of candidats) {
    const nom = `${c.prenom} ${c.nom}`
    const motif = c.deja ? 'attestation déjà émise'
      : c.resultat !== 'apte' ? 'non déclaré apte'
      : c.statut === 'abandon' || c.statut === 'absent' ? 'absent ou abandon'
      : c.presences < demiJournees ? `présence incomplète (${c.presences}/${demiJournees} demi-journées)`
      : null
    if (motif) { ignores.push({ nom, motif }); continue }
    const a = await trx.insertInto('attestation').values({
      entreprise_id: ctx.entrepriseId, participant_id: c.id, code_verification: randomBytes(16).toString('base64url'),
      nom_salarie: c.nom, prenom_salarie: c.prenom, intitule_formation: s.intitule, nom_entreprise: s.entreprise,
      date_debut: s.debut, date_fin: s.fin, duree_libelle: dureeFormation(s),
      formateur: s.formateur_nom, emise_le: emiseLe, expire_le: s.validite_mois ? ajouterMois(s.fin, s.validite_mois) : null,
    }).returning('id').executeTakeFirstOrThrow()
    emises.push(a.id)
  }
  if (emises.length) {
    await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'creation', objetType: 'attestation', objetId: emises[0], details: { sessionId, emises: emises.length } })
  }
  return { emises: emises.length, ignores }
}

/** Annulation DÉFINITIVE : la ligne est supprimée (0034) ; seule la trace du journal d'audit (motif, sans nom ni code) subsiste. */
export async function annulerAttestation(trx: Transaction<DB>, ctx: Ctx, idBrut: unknown, corps: Record<string, unknown>) {
  const id = uuid(idBrut, 'Attestation')
  const motif = texteOptionnel(corps.motif, 'Motif', 500)
  if (!motif) throw new ErreurMetier(400, 'Motif d’annulation requis.')
  const a = await trx.selectFrom('attestation').select('participant_id').where('id', '=', id).executeTakeFirst()
  if (!a) throw new ErreurMetier(404, 'Attestation introuvable.')
  await ecrireJournal(trx, { utilisateurId: ctx.utilisateurId, entrepriseId: ctx.entrepriseId, action: 'suppression', objetType: 'attestation', objetId: id, details: { participantId: a.participant_id, motif } })
  const r = await trx.deleteFrom('attestation').where('id', '=', id).executeTakeFirst()
  if (!Number(r.numDeletedRows)) throw new ErreurMetier(404, 'Attestation introuvable.')
}

/** PDF paysage A4 ; `origine` sert à construire l'adresse de vérification (QR code et pied de page). */
export async function genererAttestationPdf(trx: Transaction<DB>, idBrut: unknown, origine: string): Promise<{ octets: Uint8Array, nomFichier: string }> {
  const id = uuid(idBrut, 'Attestation')
  const a = await trx.selectFrom('attestation').selectAll().where('id', '=', id).executeTakeFirst()
  if (!a) throw new ErreurMetier(404, 'Attestation introuvable.')
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
  const adresse = `${origine}/verifier/${a.code_verification}`

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle(`Attestation de formation — ${a.prenom_salarie} ${a.nom_salarie}`)
  pdf.setAuthor('IFECARM GROUP')
  const police = (nom: string) => readFile(path.join(DOSSIER_ASSETS, 'fonts', nom)).then((o) => pdf.embedFont(o, { subset: true }))
  const titre = await police('Poppins-Bold.ttf')
  const gras = await police('Poppins-SemiBold.ttf')
  const texte = await police('Poppins-Regular.ttf')
  const mont = await police('Montserrat-Regular.ttf') // titre, « Délivré à », signatures et pied : comme le modèle de la charte
  const logo = await pdf.embedPng(await readFile(path.join(DOSSIER_ASSETS, 'entete-logo.png')))
  const qr = await pdf.embedPng(await QRCode.toBuffer(adresse, { margin: 1, width: 360, errorCorrectionLevel: 'M' }))

  // Mise en page : modèle « Certificat de formation » de la charte graphique IFECARM (§4 Papeterie, p. 16).
  // Proportions relevées sur le modèle (cadre 1167 × 968 px) : positions en fraction de la hauteur du cadre,
  // tailles calées sur la largeur des textes du modèle. Montserrat Regular pour titre, libellés et pied ; Poppins pour le corps.
  const W = 841.89
  const H = 595.28
  const vert = rgb(0.176, 0.478, 0.267) // #2D7A44
  const noir = rgb(0.102, 0.102, 0.102) // #1A1A1A
  const anthracite = rgb(0.235, 0.282, 0.302) // #3C484D
  const gris = rgb(0.431, 0.478, 0.463) // #6E7A76
  const ivoire = rgb(0.961, 0.965, 0.957) // #F5F6F4
  const page = pdf.addPage([W, H])
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: ivoire })

  const cadre = { x: 28, y: 28, w: W - 56, h: H - 56 }
  const rayon = 12
  const rect = `M ${rayon} 0 H ${cadre.w - rayon} A ${rayon} ${rayon} 0 0 1 ${cadre.w} ${rayon} V ${cadre.h - rayon} A ${rayon} ${rayon} 0 0 1 ${cadre.w - rayon} ${cadre.h} H ${rayon} A ${rayon} ${rayon} 0 0 1 0 ${cadre.h - rayon} V ${rayon} A ${rayon} ${rayon} 0 0 1 ${rayon} 0 Z`
  page.drawSvgPath(rect, { x: cadre.x, y: H - cadre.y, borderColor: noir, borderWidth: 1.3 })
  /** Ordonnée PDF du centre d'une ligne, en fraction de la hauteur du cadre depuis le haut. */
  const yPdf = (fraction: number) => H - (cadre.y + fraction * cadre.h)

  const largeur = (t: string, taille: number, f: PDFFont, espace: number) => f.widthOfTextAtSize(t, taille) + espace * Math.max(t.length - 1, 0)
  /** Texte centré sur la page ; `espace` = approche entre lettres ; réduit la taille si le texte dépasse `max`. */
  const centre = (t: string, fraction: number, taille: number, f: PDFFont, couleur: RGB, espace = 0, max = cadre.w - 80) => {
    let tl = taille
    while (largeur(t, tl, f, espace * (tl / taille)) > max && tl > 6) tl -= 0.5
    const e = espace * (tl / taille)
    let x = (W - largeur(t, tl, f, e)) / 2
    const y = yPdf(fraction) - tl * 0.35
    if (!e) { page.drawText(t, { x, y, size: tl, font: f, color: couleur }); return }
    for (const c of t) { page.drawText(c, { x, y, size: tl, font: f, color: couleur }); x += f.widthOfTextAtSize(c, tl) + e }
  }

  // Logo horizontal centré (58 % de la largeur du cadre).
  const lw = cadre.w * 0.58
  const lh = (logo.height / logo.width) * lw
  page.drawImage(logo, { x: (W - lw) / 2, y: yPdf(0.043) - lh, width: lw, height: lh })

  centre('CERTIFICAT DE FORMATION', 0.293, 20.5, mont, vert, 4.1)
  page.drawRectangle({ x: (W - cadre.w * 0.247) / 2, y: yPdf(0.34) - 2.5, width: cadre.w * 0.247, height: 5, color: vert })
  centre('DÉLIVRÉ À', 0.433, 14.9, mont, gris, 3.7)
  centre(`${a.prenom_salarie} ${a.nom_salarie}`, 0.482, 27.6, texte, noir)
  centre('pour avoir suivi et validé la formation', 0.532, 19.5, texte, anthracite)
  centre(a.intitule_formation, 0.576, 19.5, gras, noir)
  const periode = iso(a.date_debut) === iso(a.date_fin) ? `le ${dateFr(iso(a.date_debut))}` : `du ${dateFr(iso(a.date_debut))} au ${dateFr(iso(a.date_fin))}`
  centre(`${periode}${a.duree_libelle ? ` · durée : ${a.duree_libelle}` : ''}`, 0.62, 19.5, texte, anthracite)

  // Signatures : deux lignes grises (28 % de la largeur), libellés Montserrat Regular dessous.
  const ligneY = yPdf(0.797)
  const lg = cadre.w * 0.28
  for (const [x, libelle] of [[cadre.x + cadre.w * 0.057, 'Le formateur'], [cadre.x + cadre.w * 0.936 - lg, 'Le directeur de la formation']] as const) {
    page.drawRectangle({ x, y: ligneY, width: lg, height: 0.9, color: gris })
    page.drawText(libelle, { x: x + (lg - mont.widthOfTextAtSize(libelle, 14)) / 2, y: yPdf(0.827) - 14 * 0.35, size: 14, font: mont, color: gris })
  }
  if (a.formateur) page.drawText(a.formateur, { x: cadre.x + cadre.w * 0.057 + (lg - gras.widthOfTextAtSize(a.formateur, 12)) / 2, y: ligneY + 8, size: 12, font: gras, color: noir })

  // QR de vérification entre les signatures ; pied : code, vérification, raison sociale, RCCM, SIREN.
  const q = 58
  page.drawImage(qr, { x: (W - q) / 2, y: ligneY - 14, width: q, height: q })
  const hote = new URL(adresse).host
  centre(`Code ${a.code_verification} · vérifiable sur ${hote}/verifier · délivré le ${dateFr(iso(a.emise_le))}`, 0.933, 10, mont, gris, 0.2)
  centre('IFECARM GROUP SARL · RCCM RB/COT/26 B 42475 · SIREN 952 449 346', 0.963, 10, mont, gris, 0.2)
  if (a.statut === 'annulee') {
    page.drawText('ANNULÉE', { x: W / 2 - 150, y: H / 2 - 40, size: 90, font: titre, color: rgb(0.78, 0.21, 0.17), opacity: 0.25, rotate: degrees(20) })
  }

  const nomFichier = `attestation-${a.nom_salarie}-${a.prenom_salarie}`.normalize('NFD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').toLowerCase() + '.pdf'
  return { octets: await pdf.save(), nomFichier }
}
