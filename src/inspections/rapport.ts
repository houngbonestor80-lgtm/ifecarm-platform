import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { lireFichier } from '@/storage/s3'
import { LIBELLE_GRAVITE, LIBELLE_RESULTAT, LIBELLE_STATUT_INSPECTION, STATUTS_ACTION, dateCourteFr, dateFr } from '@/ui/libelles'
import { contexteEntreprise, obtenirInspection } from './service'

/**
 * Rapport PDF d'une inspection, généré à la demande (état à date : les plans
 * d'action continuent d'évoluer après la clôture). Mise en page reprise du
 * papier à en-tête officiel IFECARM GROUP (logo, activités, mentions légales
 * des deux sièges), comme les fiches formation du site vitrine.
 * Mise en page conforme à la charte graphique IFECARM GROUP (v1.0, §2.2, §3, §4) :
 * Poppins seule (Bold = titres 1, SemiBold = titres 2/3 et libellés, Medium =
 * intertitres, Regular = texte) — Montserrat est interdite pour les titres et
 * les textes longs ; noir #1A1A1A (jamais #000) ; un seul vert ; couleurs
 * sectorielles réservées au repérage (gravité, résultat) ; pas de slogan ajouté.
 * Papeterie : page 1 = en-tête complet + pied légal ; pages suivantes = en-tête
 * technique (référence · référentiel · Page n / N) + pied court.
 */

// Papier à en-tête (« entete IFECARM GROUP SARL.docx ») — mêmes données que
// app/data/site.ts du site vitrine.
export const ENTETE = {
  colonnes: [
    { titre: 'SIÈGE INTERNATIONAL', lignes: ['6 rue d’Armaillé, Paris — France', '(+33) 7 67 72 43 68', 'SIREN 952 449 346 R.C.S · Code NAF 71.12B'] },
    { titre: 'SIÈGE AFRIQUE', lignes: ['Aïbatin Kpota, Cotonou — Bénin', '(+229) 01 91 38 44 44 · 01 91 32 24 70', 'RCCM RB/COT/26 B 42475 · IFU 3202686150102'] },
    { titre: 'CONTACT', lignes: ['info@ifecarm-qhse.com', 'www.ifecarm-qhse.com'] },
  ],
}

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
const C = {
  vert: hex('2D7A44'), gris: hex('6E7A76'), encre: hex('1A1A1A'), encreDouce: hex('3C484D'),
  pale: hex('F5F6F4'), filet: hex('DCE0DD'), blanc: rgb(1, 1, 1), rouge: hex('C6362C'), orange: hex('E39C2A'), bleu: hex('4A86A8'),
  grisClair: hex('E4E8E3'),
}
const COULEUR_RESULTAT: Record<string, RGB> = { conforme: C.vert, non_conforme: C.rouge, non_applicable: C.gris }
const COULEUR_GRAVITE: Record<string, RGB> = { critique: C.rouge, majeure: C.orange, mineure: C.bleu }
const LIBELLE_ACTION = Object.fromEntries(STATUTS_ACTION.map((s) => [s.valeur, s.texte]))

const LARGEUR = 595.28 // A4 portrait, points
const HAUTEUR = 841.89
const MARGE = 44
const L = LARGEUR - MARGE * 2
const HAUT_SUITE = HAUTEUR - MARGE - 14 // sous l'en-tête technique (pages suivantes)
const BAS_SUITE = 62 // au-dessus du pied court

const DOSSIER_ASSETS = path.join(process.cwd(), 'assets', 'pdf')

export async function genererRapport(trx: Transaction<DB>, ctx: { entrepriseId: string }, inspectionId: unknown): Promise<{ octets: Uint8Array, nomFichier: string }> {
  const insp = await obtenirInspection(trx, inspectionId)
  const entreprise = await contexteEntreprise(trx, ctx.entrepriseId)

  // Photos : lues dans le stockage (JPEG/PNG seulement — pdf-lib n'intègre pas le WebP).
  const idsPhotos = [...insp.items.flatMap((i) => i.photos), ...insp.nonConformites.flatMap((n) => n.photos)].map((p) => p.id)
  const fichiers = idsPhotos.length
    ? await trx.selectFrom('fichier').select(['id', 'cle_stockage', 'type_mime']).where('id', 'in', idsPhotos).execute()
    : []

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle(`Rapport d’inspection — ${insp.intitule_modele}`)
  pdf.setAuthor('IFECARM GROUP')
  pdf.setSubject(`${entreprise.nom} — ${dateCourteFr(insp.date_inspection)}`)

  const police = (nom: string) => readFile(path.join(DOSSIER_ASSETS, 'fonts', nom)).then((o) => pdf.embedFont(o, { subset: true }))
  const F = {
    titre: await police('Poppins-Bold.ttf'),
    titre2: await police('Poppins-SemiBold.ttf'),
    label: await police('Poppins-SemiBold.ttf'),
    texte: await police('Poppins-Regular.ttf'),
    moyen: await police('Poppins-Medium.ttf'),
  }
  const logoCouverture = await pdf.embedPng(await readFile(path.join(DOSSIER_ASSETS, 'logo-prestige.png'))) // LOGO-01, couverture de rapport seulement

  const images = new Map<string, PDFImage>()
  await Promise.all(fichiers.map(async (f) => {
    try {
      const octets = await lireFichier(f.cle_stockage)
      if (f.type_mime === 'image/jpeg') images.set(f.id, await pdf.embedJpg(octets))
      else if (f.type_mime === 'image/png') images.set(f.id, await pdf.embedPng(octets))
    } catch {
      // photo illisible ou absente du stockage : ignorée plutôt que de bloquer le rapport
    }
  }))

  const couverture = pdf.addPage([LARGEUR, HAUTEUR])
  let page: PDFPage = pdf.addPage([LARGEUR, HAUTEUR])
  let y = HAUT_SUITE
  const nouvellePage = () => { page = pdf.addPage([LARGEUR, HAUTEUR]); y = HAUT_SUITE }
  const place = (besoin: number) => { if (y - besoin < BAS_SUITE) nouvellePage() }

  function couper(texte: string, f: PDFFont, taille: number, largeur: number): string[] {
    const lignes: string[] = []
    let ligne = ''
    for (const mot of texte.split(/\s+/).filter(Boolean)) {
      const essai = ligne ? `${ligne} ${mot}` : mot
      if (f.widthOfTextAtSize(essai, taille) > largeur && ligne) { lignes.push(ligne); ligne = mot } else ligne = essai
    }
    if (ligne) lignes.push(ligne)
    return lignes.length ? lignes : ['']
  }

  function paragraphe(texte: string, { x = MARGE, largeur = L, taille = 9.5, f = F.texte, couleur = C.encreDouce, interligne = 14 } = {}) {
    for (const ligne of couper(texte, f, taille, largeur)) {
      place(interligne)
      page.drawText(ligne, { x, y, size: taille, font: f, color: couleur })
      y -= interligne
    }
  }

  /** Pastille colorée ; renvoie sa largeur. */
  function pastille(texte: string, x: number, yBase: number, couleur: RGB, { taille = 7.5, clair = false } = {}): number {
    const largeur = F.label.widthOfTextAtSize(texte, taille) + 12
    page.drawRectangle({ x, y: yBase - 4, width: largeur, height: taille + 7, color: clair ? C.pale : couleur, borderColor: couleur, borderWidth: clair ? 0.8 : 0 })
    page.drawText(texte, { x: x + 6, y: yBase, size: taille, font: F.label, color: clair ? couleur : C.blanc })
    return largeur
  }

  /** `suite` : hauteur minimale de contenu à garder sous le titre (jamais de titre orphelin en bas de page). */
  function titreSection(texte: string, suite = 80) {
    place(34 + suite)
    y -= 12
    page.drawRectangle({ x: MARGE, y: y - 2, width: 3, height: 13, color: C.vert })
    page.drawText(texte, { x: MARGE + 10, y, size: 12, font: F.titre2, color: C.encre })
    y -= 22
  }

  /** Vignettes de photos sur une ligne (retour à la ligne automatique). */
  function vignettes(photos: { id: string }[], hauteur: number, x0 = MARGE) {
    const liste = photos.map((p) => images.get(p.id)).filter((i): i is PDFImage => Boolean(i))
    if (!liste.length) return
    let x = x0
    place(hauteur + 8)
    for (const img of liste) {
      const largeur = Math.min((img.width / img.height) * hauteur, 200)
      if (x + largeur > MARGE + L) { y -= hauteur + 8; place(hauteur + 8); x = x0 }
      page.drawImage(img, { x, y: y - hauteur + 8, width: largeur, height: hauteur })
      page.drawRectangle({ x, y: y - hauteur + 8, width: largeur, height: hauteur, borderColor: C.filet, borderWidth: 0.8 })
      x += largeur + 8
    }
    y -= hauteur + 6
  }

  // ── Couverture (charte §4 : LOGO-01 centré, titre, référentiel, site · date, référence et raison sociale en pied) ──
  const statut = LIBELLE_STATUT_INSPECTION[insp.statut]?.texte ?? insp.statut
  const centre = (t: string, yy: number, taille: number, f: PDFFont, couleur: RGB, espace = 0) => {
    const w = f.widthOfTextAtSize(t, taille) + espace * Math.max(t.length - 1, 0)
    let x = (LARGEUR - w) / 2
    if (!espace) { couverture.drawText(t, { x, y: yy, size: taille, font: f, color: couleur }); return }
    for (const c of t) { couverture.drawText(c, { x, y: yy, size: taille, font: f, color: couleur }); x += f.widthOfTextAtSize(c, taille) + espace }
  }
  const lw = 210
  const lh = (logoCouverture.height / logoCouverture.width) * lw
  couverture.drawImage(logoCouverture, { x: (LARGEUR - lw) / 2, y: HAUTEUR - 96 - lh, width: lw, height: lh })
  let cy = HAUTEUR - 96 - lh - 70
  centre('RAPPORT D’INSPECTION QHSE', cy, 17, F.texte, C.encre, 1.2)
  cy -= 30
  for (const ligne of couper(insp.intitule_modele.toUpperCase(), F.texte, 10.5, L - 60)) { centre(ligne, cy, 10.5, F.texte, C.encreDouce, 0.6); cy -= 16 }
  const cible = `${insp.cible_type === 'site' ? 'SITE' : 'ÉQUIPEMENT'} : ${(insp.cible_nom ?? '—').toUpperCase()} · ${dateFr(insp.date_inspection).toUpperCase()}`
  for (const ligne of couper(cible, F.texte, 10.5, L - 60)) { centre(ligne, cy, 10.5, F.texte, C.encreDouce, 0.6); cy -= 16 }
  const nomEntreprise = `${entreprise.nom}${entreprise.statutRelation === 'prospect' ? ' (prospect)' : ''}`
  centre(nomEntreprise, cy - 6, 10.5, F.moyen, C.vert)
  centre(`Statut : ${statut}`, cy - 24, 9, F.texte, C.gris)
  const reference = `INS-${insp.date_inspection.slice(0, 4)}-${String(insp.id).slice(0, 8).toUpperCase()}`
  centre(`RÉF. ${reference}`, 190, 8.5, F.texte, C.gris, 0.5)
  centre('IFECARM GROUP SARL — QHSE RISK MANAGEMENT', 176, 8.5, F.texte, C.gris, 0.5)
  y = HAUT_SUITE

  // ── Intervenants ──
  const demi = (L - 12) / 2
  const intervenants = [
    { label: 'INSPECTION RÉALISÉE PAR', valeur: insp.inspecteur_nom },
    { label: entreprise.statutRelation === 'prospect' ? 'REPRÉSENTANT DU PROSPECT' : 'REPRÉSENTANT DU CLIENT', valeur: insp.representant_client },
  ]
  intervenants.forEach((it, k) => {
    const x = MARGE + k * (demi + 12)
    page.drawRectangle({ x, y: y - 50, width: demi, height: 56, borderColor: C.filet, borderWidth: 0.8 })
    page.drawText(it.label, { x: x + 12, y: y - 8, size: 6.8, font: F.label, color: C.gris })
    couper(it.valeur || 'Non renseigné', F.moyen, 9.5, demi - 24).slice(0, 2).forEach((ligne, j) =>
      page.drawText(ligne, { x: x + 12, y: y - 24 - j * 13, size: 9.5, font: F.moyen, color: it.valeur ? C.encre : C.gris }))
  })
  y -= 70

  // ── Synthèse ──
  const renseignes = insp.items.filter((i) => i.resultat).length
  const conformes = insp.items.filter((i) => i.resultat === 'conforme').length
  const nonConformes = insp.items.filter((i) => i.resultat === 'non_conforme').length
  const evalues = conformes + nonConformes
  const taux = evalues ? Math.round((conformes / evalues) * 100) : null
  const actions = insp.nonConformites.flatMap((n) => n.actions)
  const ouvertes = actions.filter((a) => a.statut === 'a_faire' || a.statut === 'en_cours').length
  const enRetard = actions.filter((a) => a.en_retard).length

  titreSection('Synthèse')
  const tuiles = [
    { valeur: `${renseignes}/${insp.items.length}`, label: 'Points contrôlés', couleur: C.bleu },
    { valeur: taux === null ? '—' : `${taux} %`, label: 'Taux de conformité', couleur: taux !== null && taux >= 80 ? C.vert : C.orange },
    { valeur: String(insp.nonConformites.length), label: 'Non-conformités', couleur: insp.nonConformites.length ? C.rouge : C.vert },
    { valeur: `${ouvertes}${enRetard ? ` (${enRetard} en retard)` : ''}`, label: 'Actions ouvertes', couleur: enRetard ? C.rouge : C.orange },
  ]
  const largeurTuile = (L - 3 * 8) / 4
  tuiles.forEach((t, k) => {
    const x = MARGE + k * (largeurTuile + 8)
    page.drawRectangle({ x, y: y - 44, width: largeurTuile, height: 50, color: C.blanc, borderColor: C.filet, borderWidth: 0.8 })
    page.drawRectangle({ x, y: y - 44, width: 3, height: 50, color: t.couleur })
    let taille = 17
    while (F.titre.widthOfTextAtSize(t.valeur, taille) > largeurTuile - 20 && taille > 9) taille -= 0.5
    page.drawText(t.valeur, { x: x + 12, y: y - 18, size: taille, font: F.titre, color: C.encre })
    page.drawText(t.label, { x: x + 12, y: y - 34, size: 7.5, font: F.moyen, color: C.gris })
  })
  y -= 60
  if (insp.nonConformites.length) {
    let x = MARGE
    page.drawText('Par gravité :', { x, y, size: 8.5, font: F.moyen, color: C.encreDouce })
    x += F.moyen.widthOfTextAtSize('Par gravité :', 8.5) + 8
    for (const g of ['critique', 'majeure', 'mineure']) {
      const n = insp.nonConformites.filter((nc) => nc.gravite === g).length
      if (n) x += pastille(`${n} ${LIBELLE_GRAVITE[g]!.toLowerCase()}${n > 1 ? 's' : ''}`, x, y, COULEUR_GRAVITE[g]!) + 6
    }
    y -= 18
  }

  // ── Checklist ──
  titreSection('Points de contrôle')
  for (const item of insp.items) {
    const libelle = couper(item.libelle, F.moyen, 9.5, L - 150)
    place(libelle.length * 13 + 12)
    const haut = y
    page.drawCircle({ x: MARGE + 8, y: y + 3, size: 8, color: C.grisClair })
    const n = String(item.ordre)
    page.drawText(n, { x: MARGE + 8 - F.titre2.widthOfTextAtSize(n, 7.5) / 2, y: y + 0.5, size: 7.5, font: F.titre2, color: C.encreDouce })
    libelle.forEach((ligne, k) => page.drawText(ligne, { x: MARGE + 24, y: y - k * 13, size: 9.5, font: F.moyen, color: C.encre }))
    const res = item.resultat ? LIBELLE_RESULTAT[item.resultat]! : 'Non renseigné'
    const largeurRes = F.label.widthOfTextAtSize(res, 7.5) + 12
    pastille(res, MARGE + L - largeurRes, haut, item.resultat ? COULEUR_RESULTAT[item.resultat]! : C.gris, { clair: !item.resultat })
    y -= libelle.length * 13 + 2
    if (item.commentaire) paragraphe(`« ${item.commentaire} »`, { x: MARGE + 24, largeur: L - 24, taille: 8.5, f: F.texte, couleur: C.gris, interligne: 12 })
    if (item.photos.length) { y -= 2; vignettes(item.photos, 56, MARGE + 24) }
    y -= 4
    page.drawLine({ start: { x: MARGE + 24, y: y + 4 }, end: { x: MARGE + L, y: y + 4 }, thickness: 0.4, color: C.filet })
    y -= 6
  }

  // ── Non-conformités et plans d'action ──
  if (insp.nonConformites.length) {
    titreSection('Non-conformités et plans d’action')
    for (const nc of insp.nonConformites) {
      place(60)
      const point = insp.items.find((i) => i.id === nc.item_inspection_id)
      const g = LIBELLE_GRAVITE[nc.gravite] ?? nc.gravite
      const lg = pastille(g, MARGE, y, COULEUR_GRAVITE[nc.gravite] ?? C.gris)
      page.drawText(point ? `Point ${point.ordre} — ${couper(point.libelle, F.texte, 8.5, L - lg - 16)[0]}` : 'Non-conformité générale', {
        x: MARGE + lg + 8, y, size: 8.5, font: F.texte, color: C.gris,
      })
      y -= 18
      paragraphe(nc.description, { taille: 10, f: F.moyen, couleur: C.encre, interligne: 14.5 })
      if (nc.photos.length) { y -= 2; vignettes(nc.photos, 96) }
      if (nc.actions.length) {
        y -= 2
        for (const a of nc.actions) {
          const details = [
            a.reference,
            a.responsable_nom ? `Responsable : ${a.responsable_nom}` : null,
            `Échéance : ${dateCourteFr(a.echeance)}`,
            `Statut : ${LIBELLE_ACTION[a.statut] ?? a.statut}${a.en_retard ? ' — EN RETARD' : ''}`,
          ].filter(Boolean).join('   ·   ')
          const lignes = couper(a.libelle, F.moyen, 9, L - 28)
          const hauteur = 16 + lignes.length * 12 + 14
          place(hauteur + 6)
          page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: L, height: hauteur, color: a.en_retard ? hex('FDF1F0') : C.pale })
          page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: 3, height: hauteur, color: a.en_retard ? C.rouge : C.vert })
          let ay = y
          for (const ligne of lignes) { page.drawText(ligne, { x: MARGE + 14, y: ay, size: 9, font: F.moyen, color: C.encre }); ay -= 12 }
          page.drawText(couper(details, F.texte, 7.8, L - 28)[0]!, { x: MARGE + 14, y: ay - 2, size: 7.8, font: F.texte, color: a.en_retard ? C.rouge : C.encreDouce })
          y -= hauteur + 4
        }
      } else {
        paragraphe('Aucun plan d’action défini.', { taille: 8.5, couleur: C.gris })
      }
      y -= 10
    }
  }

  // ── Signatures ──
  titreSection('Validation', 110)
  const hautSig = y
  intervenants.forEach((it, k) => {
    const x = MARGE + k * (demi + 12)
    page.drawRectangle({ x, y: hautSig - 100, width: demi, height: 106, borderColor: C.filet, borderWidth: 0.8 })
    page.drawText(k === 0 ? 'L’INSPECTEUR' : it.label, { x: x + 12, y: hautSig - 8, size: 6.8, font: F.label, color: C.gris })
    couper(it.valeur || '', F.moyen, 9.5, demi - 24).slice(0, 2).forEach((ligne, j) =>
      page.drawText(ligne, { x: x + 12, y: hautSig - 24 - j * 13, size: 9.5, font: F.moyen, color: C.encre }))
    page.drawText('Date :', { x: x + 12, y: hautSig - 56, size: 8, font: F.texte, color: C.gris })
    page.drawText('Signature :', { x: x + 12, y: hautSig - 72, size: 8, font: F.texte, color: C.gris })
  })
  y = hautSig - 112

  // ── En-têtes et pieds (charte §4 : page 1 = pied légal ; suivantes = en-tête technique + pied court) ──
  const total = pdf.getPageCount()
  const edite = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Porto-Novo' })
  const filet = (p: PDFPage, yy: number) => p.drawLine({ start: { x: MARGE, y: yy }, end: { x: LARGEUR - MARGE, y: yy }, thickness: 0.85, color: C.filet }) // 0,3 mm
  for (let i = 0; i < total; i++) {
    const p = pdf.getPage(i)
    if (i === 0) {
      filet(p, 94)
      const col = L / 3
      ENTETE.colonnes.forEach((c, k) => {
        const x = MARGE + k * col
        p.drawText(c.titre, { x, y: 81, size: 6.5, font: F.titre2, color: C.vert })
        c.lignes.forEach((ligne, j) => {
          let taille = 7
          while (F.texte.widthOfTextAtSize(ligne, taille) > col - 10 && taille > 5.5) taille -= 0.25
          p.drawText(ligne, { x, y: 70 - j * 11.2, size: taille, font: F.texte, color: C.gris }) // interligne 1,6
        })
      })
      continue
    }
    // En-tête technique (type C) : référence à gauche, référentiel · Page n / N à droite.
    const haut = HAUTEUR - MARGE + 6
    p.drawText(reference, { x: MARGE, y: haut, size: 8, font: F.titre2, color: C.vert })
    const droite = `${couper(insp.intitule_modele, F.texte, 8, 260)[0]} · Page ${i + 1} / ${total}`
    p.drawText(droite, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(droite, 8), y: haut, size: 8, font: F.texte, color: C.gris })
    filet(p, haut - 8)
    // Pied court.
    filet(p, 46)
    p.drawText('IFECARM GROUP SARL — QHSE Risk Management · Cotonou — Paris · www.ifecarm-qhse.com', { x: MARGE, y: 32, size: 7, font: F.texte, color: C.gris })
    const date = `Édité le ${edite}`
    p.drawText(date, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(date, 7), y: 32, size: 7, font: F.texte, color: C.gris })
  }

  const octets = await pdf.save()
  const slug = `${insp.intitule_modele}-${insp.date_inspection}`.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return { octets, nomFichier: `rapport-inspection-${slug}.pdf` }
}
