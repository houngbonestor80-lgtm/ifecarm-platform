import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ENTETE } from '@/inspections/rapport'
import { lireFichier } from '@/storage/s3'
import { contexteEntreprise } from '@/inspections/service'
import { dateCourteFr, dateFr } from '@/ui/libelles'
import { listerEquipements, type LigneEquipement } from './service'

/**
 * Rapport PDF du registre des équipements et EPI de l'entreprise, généré à la demande (état à date).
 * Même charte que le rapport d'inspection (Poppins seule, noir #1A1A1A, un seul vert, LOGO-01 en couverture,
 * pied légal page 1, en-tête technique ensuite). Photos de chaque équipement (4 vignettes maximum). Contenu : synthèse, points à traiter (en retard, sous 30 jours),
 * registre complet séparé en équipements et EPI, nombre d'éléments retirés du service.
 * États : calculés à la date du rapport, comme l'écran /equipements (en retard, sous 30 jours, à jour, sans échéance).
 */

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
const C = {
  vert: hex('2D7A44'), gris: hex('6E7A76'), encre: hex('1A1A1A'), encreDouce: hex('3C484D'), pale: hex('F5F6F4'),
  filet: hex('DCE0DD'), blanc: rgb(1, 1, 1), rouge: hex('C6362C'), orange: hex('E39C2A'), bleu: hex('4A86A8'),
}

const LARGEUR = 595.28
const HAUTEUR = 841.89
const MARGE = 44
const L = LARGEUR - MARGE * 2
const HAUT_SUITE = HAUTEUR - MARGE - 14
const BAS_SUITE = 62
const PHOTOS_PAR_EQUIPEMENT = 4 // vignettes reprises dans le rapport (la fiche en garde jusqu'à 10)
const HAUTEUR_VIGNETTE = 54
const DOSSIER_ASSETS = path.join(process.cwd(), 'assets', 'pdf')

type Etat = 'retard' | 'bientot' | 'ok' | 'sans'
const ETATS: Record<Etat, { texte: string, couleur: RGB, rang: number }> = {
  retard: { texte: 'EN RETARD', couleur: C.rouge, rang: 0 },
  bientot: { texte: 'SOUS 30 JOURS', couleur: C.orange, rang: 1 },
  ok: { texte: 'À JOUR', couleur: C.vert, rang: 2 },
  sans: { texte: 'SANS ÉCHÉANCE', couleur: C.gris, rang: 3 },
}
const estEpi = (e: LigneEquipement) => /\bepi\b/i.test(e.type)

function etatDe(e: LigneEquipement, aujourdhui: string, dans30: string): Etat {
  if (!e.prochaine_verif) return 'sans'
  if (e.prochaine_verif < aujourdhui) return 'retard'
  return e.prochaine_verif <= dans30 ? 'bientot' : 'ok'
}

type Ligne = { e: LigneEquipement, etat: Etat }

export async function genererRapportEquipements(trx: Transaction<DB>, ctx: { entrepriseId: string }): Promise<{ octets: Uint8Array, nomFichier: string }> {
  const [{ equipements }, entreprise] = await Promise.all([listerEquipements(trx), contexteEntreprise(trx, ctx.entrepriseId)])
  const aujourdhui = new Date().toLocaleDateString('sv-SE')
  const dans30 = new Date(Date.now() + 30 * 86400e3).toLocaleDateString('sv-SE')
  const actifs: Ligne[] = equipements.filter((e) => e.actif).map((e) => ({ e, etat: etatDe(e, aujourdhui, dans30) }))
  const retires = equipements.length - actifs.length
  actifs.sort((a, b) =>
    ETATS[a.etat].rang - ETATS[b.etat].rang
    || (a.e.prochaine_verif ?? '9').localeCompare(b.e.prochaine_verif ?? '9')
    || a.e.designation.localeCompare(b.e.designation, 'fr'))
  const compte = (s: Etat) => actifs.filter((a) => a.etat === s).length

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle(`Rapport des équipements et EPI — ${entreprise.nom}`)
  pdf.setAuthor('IFECARM GROUP')
  pdf.setSubject(`État au ${dateCourteFr(aujourdhui)}`)
  const police = (nom: string) => readFile(path.join(DOSSIER_ASSETS, 'fonts', nom)).then((o) => pdf.embedFont(o, { subset: true }))
  const F = { titre: await police('Poppins-Bold.ttf'), titre2: await police('Poppins-SemiBold.ttf'), texte: await police('Poppins-Regular.ttf'), moyen: await police('Poppins-Medium.ttf') }
  const logo = await pdf.embedPng(await readFile(path.join(DOSSIER_ASSETS, 'logo-prestige.png')))

  // Photos : JPEG/PNG seulement (pdf-lib n'intègre pas le WebP ; le navigateur envoie du JPEG). Photo illisible : ignorée.
  const idsPhotos = actifs.flatMap((a) => a.e.photos.slice(0, PHOTOS_PAR_EQUIPEMENT).map((ph) => ph.id))
  const fichiers = idsPhotos.length
    ? await trx.selectFrom('fichier').select(['id', 'cle_stockage', 'type_mime']).where('id', 'in', idsPhotos).execute()
    : []
  const images = new Map<string, PDFImage>()
  await Promise.all(fichiers.map(async (f) => {
    try {
      const octets = await lireFichier(f.cle_stockage)
      if (f.type_mime === 'image/jpeg') images.set(f.id, await pdf.embedJpg(octets))
      else if (f.type_mime === 'image/png') images.set(f.id, await pdf.embedPng(octets))
    } catch {
      // absente du stockage ou illisible
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
  function pastille(texte: string, x: number, yBase: number, couleur: RGB, taille = 7.5): number {
    const largeur = F.titre2.widthOfTextAtSize(texte, taille) + 12
    page.drawRectangle({ x, y: yBase - 4, width: largeur, height: taille + 7, color: couleur })
    page.drawText(texte, { x: x + 6, y: yBase, size: taille, font: F.titre2, color: C.blanc })
    return largeur
  }
  function titreSection(texte: string, suite = 80) {
    place(34 + suite)
    y -= 12
    page.drawRectangle({ x: MARGE, y: y - 2, width: 3, height: 13, color: C.vert })
    page.drawText(texte, { x: MARGE + 10, y, size: 12, font: F.titre2, color: C.encre })
    y -= 22
  }

  /** Une ligne du registre : désignation + état, puis détails et dates. */
  function ligneEquipement(e: LigneEquipement, etat: Etat) {
    const details = [e.type, e.numero_serie ? `N° ${e.numero_serie}` : null, e.site_nom ? `Site : ${e.site_nom}` : null, e.affecte_a ? `Affecté à : ${e.affecte_a}` : null].filter(Boolean).join('   ·   ')
    const dates = [
      e.date_mise_service ? `Mise en service : ${dateCourteFr(e.date_mise_service)}` : null,
      e.periodicite_mois ? `Périodicité : ${e.periodicite_mois} mois` : null,
      e.derniere_verif ? `Dernière vérification : ${dateCourteFr(e.derniere_verif)}` : 'Jamais vérifié',
      e.prochaine_verif ? `Prochaine : ${dateCourteFr(e.prochaine_verif)}` : null,
    ].filter(Boolean).join('   ·   ')
    const titre = couper(e.designation, F.titre2, 9.5, L - 130)
    const l2 = couper(details, F.texte, 7.8, L - 24)
    const l3 = couper(dates, F.texte, 7.8, L - 24)
    const vignettes = e.photos.slice(0, PHOTOS_PAR_EQUIPEMENT).map((ph) => images.get(ph.id)).filter((i): i is PDFImage => Boolean(i))
    const hauteur = 8 + titre.length * 13 + l2.length * 11 + l3.length * 11 + 6 + (vignettes.length ? HAUTEUR_VIGNETTE + 6 : 0)
    place(hauteur + 4)
    const st = ETATS[etat]
    page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: L, height: hauteur, color: etat === 'retard' ? hex('FDF1F0') : C.pale })
    page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: 3, height: hauteur, color: st.couleur })
    pastille(st.texte, MARGE + L - (F.titre2.widthOfTextAtSize(st.texte, 7.5) + 12) - 8, y - 2, st.couleur)
    titre.forEach((t, k) => page.drawText(t, { x: MARGE + 12, y: y - 2 - k * 13, size: 9.5, font: F.titre2, color: C.encre }))
    let ly = y - 2 - titre.length * 13
    for (const t of l2) { page.drawText(t, { x: MARGE + 12, y: ly, size: 7.8, font: F.texte, color: C.encreDouce }); ly -= 11 }
    for (const t of l3) { page.drawText(t, { x: MARGE + 12, y: ly, size: 7.8, font: F.texte, color: etat === 'retard' ? C.rouge : C.gris }); ly -= 11 }
    let vx = MARGE + 12
    for (const img of vignettes) {
      const ratio = img.width / img.height
      let largeur = ratio * HAUTEUR_VIGNETTE
      let h = HAUTEUR_VIGNETTE
      if (largeur > 110) { largeur = 110; h = largeur / ratio }
      const vy = ly - 4 - HAUTEUR_VIGNETTE
      page.drawImage(img, { x: vx, y: vy + (HAUTEUR_VIGNETTE - h) / 2, width: largeur, height: h })
      vx += largeur + 6
    }
    y -= hauteur + 4
  }

  // ── Couverture ──
  const centre = (t: string, yy: number, taille: number, f: PDFFont, couleur: RGB, espace = 0) => {
    const w = f.widthOfTextAtSize(t, taille) + espace * Math.max(t.length - 1, 0)
    let x = (LARGEUR - w) / 2
    if (!espace) { couverture.drawText(t, { x, y: yy, size: taille, font: f, color: couleur }); return }
    for (const c of t) { couverture.drawText(c, { x, y: yy, size: taille, font: f, color: couleur }); x += f.widthOfTextAtSize(c, taille) + espace }
  }
  const lw = 210
  const lh = (logo.height / logo.width) * lw
  couverture.drawImage(logo, { x: (LARGEUR - lw) / 2, y: HAUTEUR - 96 - lh, width: lw, height: lh })
  const cy = HAUTEUR - 96 - lh - 70
  centre('RAPPORT DES ÉQUIPEMENTS ET EPI', cy, 17, F.texte, C.encre, 1.2)
  centre(`REGISTRE ARRÊTÉ AU ${dateFr(aujourdhui).toUpperCase()}`, cy - 30, 10.5, F.texte, C.encreDouce, 0.6)
  centre(`${entreprise.nom}${entreprise.statutRelation === 'prospect' ? ' (prospect)' : ''}`, cy - 58, 10.5, F.moyen, C.vert)
  const reference = `EQP-${aujourdhui.slice(0, 4)}-${ctx.entrepriseId.slice(0, 8).toUpperCase()}`
  centre(`RÉF. ${reference}`, 190, 8.5, F.texte, C.gris, 0.5)
  centre('IFECARM GROUP SARL — QHSE RISK MANAGEMENT', 176, 8.5, F.texte, C.gris, 0.5)

  // ── Synthèse ──
  titreSection('Synthèse')
  const nbEpi = actifs.filter((a) => estEpi(a.e)).length
  const tuiles = [
    { valeur: String(actifs.length), label: `En service · dont ${nbEpi} EPI`, couleur: C.bleu },
    { valeur: String(compte('retard')), label: 'Vérifications en retard', couleur: compte('retard') ? C.rouge : C.vert },
    { valeur: String(compte('bientot')), label: 'À vérifier sous 30 jours', couleur: compte('bientot') ? C.orange : C.vert },
    { valeur: String(compte('ok')), label: `À jour${compte('sans') ? ` · ${compte('sans')} sans échéance` : ''}`, couleur: C.vert },
  ]
  const lt = (L - 3 * 8) / 4
  tuiles.forEach((t, k) => {
    const x = MARGE + k * (lt + 8)
    page.drawRectangle({ x, y: y - 44, width: lt, height: 50, color: C.blanc, borderColor: C.filet, borderWidth: 0.8 })
    page.drawRectangle({ x, y: y - 44, width: 3, height: 50, color: t.couleur })
    page.drawText(t.valeur, { x: x + 12, y: y - 18, size: 17, font: F.titre, color: C.encre })
    couper(t.label, F.moyen, 7.5, lt - 18).slice(0, 2).forEach((l, j) => page.drawText(l, { x: x + 12, y: y - 32 - j * 9, size: 7.5, font: F.moyen, color: C.gris }))
  })
  y -= 62
  const suivis = actifs.length - compte('sans')
  if (suivis) {
    const taux = Math.round(((compte('ok') + compte('bientot')) / suivis) * 100)
    page.drawText(`Taux de vérifications à jour (hors équipements sans échéance) : ${taux} %.`, { x: MARGE, y, size: 9, font: F.texte, color: C.encreDouce })
    y -= 16
  }

  // ── À traiter ──
  const urgents = actifs.filter((a) => a.etat === 'retard' || a.etat === 'bientot')
  titreSection('Points à traiter', 60)
  if (!urgents.length) {
    page.drawText('Aucune vérification en retard ni à prévoir dans les 30 jours.', { x: MARGE, y, size: 9.5, font: F.texte, color: C.encreDouce })
    y -= 16
  }
  for (const a of urgents) ligneEquipement(a.e, a.etat)

  // ── Registre complet ──
  const groupes: [string, (a: Ligne) => boolean][] = [['Registre — équipements', (a) => !estEpi(a.e)], ['Registre — EPI', (a) => estEpi(a.e)]]
  for (const [titre, filtre] of groupes) {
    const liste = actifs.filter(filtre)
    titreSection(`${titre} (${liste.length})`, 60)
    if (!liste.length) { page.drawText('Aucun élément enregistré.', { x: MARGE, y, size: 9.5, font: F.texte, color: C.gris }); y -= 16 }
    for (const a of liste) ligneEquipement(a.e, a.etat)
  }
  if (retires) {
    place(40)
    y -= 8
    page.drawText(`${retires} élément${retires > 1 ? 's' : ''} retiré${retires > 1 ? 's' : ''} du service, non repris ci-dessus.`, { x: MARGE, y, size: 8.5, font: F.texte, color: C.gris })
  }

  // ── En-têtes et pieds ──
  const total = pdf.getPageCount()
  const edite = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Porto-Novo' })
  const filet = (p: PDFPage, yy: number) => p.drawLine({ start: { x: MARGE, y: yy }, end: { x: LARGEUR - MARGE, y: yy }, thickness: 0.85, color: C.filet })
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
          p.drawText(ligne, { x, y: 70 - j * 11.2, size: taille, font: F.texte, color: C.gris })
        })
      })
      continue
    }
    const haut = HAUTEUR - MARGE + 6
    p.drawText(reference, { x: MARGE, y: haut, size: 8, font: F.titre2, color: C.vert })
    const droite = `Équipements et EPI · Page ${i + 1} / ${total}`
    p.drawText(droite, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(droite, 8), y: haut, size: 8, font: F.texte, color: C.gris })
    filet(p, haut - 8)
    filet(p, 46)
    p.drawText('IFECARM GROUP SARL — QHSE Risk Management · Cotonou — Paris · www.ifecarm-qhse.com', { x: MARGE, y: 32, size: 7, font: F.texte, color: C.gris })
    const date = `Édité le ${edite}`
    p.drawText(date, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(date, 7), y: 32, size: 7, font: F.texte, color: C.gris })
  }

  const slug = entreprise.nom.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return { octets: await pdf.save(), nomFichier: `rapport-equipements-epi-${slug}-${aujourdhui}.pdf` }
}
