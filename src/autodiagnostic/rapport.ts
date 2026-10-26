import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'
import { ENTETE } from '@/inspections/rapport'
import { ErreurMetier, contexteEntreprise } from '@/inspections/service'
import { dateCourteFr, dateFr } from '@/ui/libelles'
import { obtenirEvaluation, type Niveau } from './service'

/**
 * Rapport PDF d'une évaluation d'autodiagnostic TERMINÉE (même charte que les rapports d'inspection et d'équipements :
 * Poppins seule, noir #1A1A1A, un seul vert, LOGO-01 en couverture, pied légal page 1, en-tête technique ensuite).
 * Contenu : synthèse (score, niveau, comparaison avec l'évaluation précédente), scores par thème, points d'amélioration
 * prioritaires (poids décroissant, actions engagées), détail des réponses et commentaires, avertissement du référentiel.
 */

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
const C = {
  vert: hex('2D7A44'), gris: hex('6E7A76'), encre: hex('1A1A1A'), encreDouce: hex('3C484D'), pale: hex('F5F6F4'),
  filet: hex('DCE0DD'), blanc: rgb(1, 1, 1), rouge: hex('C6362C'), orange: hex('E39C2A'), bleu: hex('4A86A8'), grisClair: hex('E4E8E3'),
}

const LARGEUR = 595.28
const HAUTEUR = 841.89
const MARGE = 44
const L = LARGEUR - MARGE * 2
const HAUT_SUITE = HAUTEUR - MARGE - 14
const BAS_SUITE = 62
const DOSSIER_ASSETS = path.join(process.cwd(), 'assets', 'pdf')

/** Couleur d'un score selon le rang du niveau de maturité qui le contient (du plus bas au plus haut). */
function couleurScore(score: number, niveaux: Niveau[]): RGB {
  const rang = Math.max(0, niveaux.findIndex((n) => score >= n.seuilMin && score <= n.seuilMax))
  const ratio = niveaux.length > 1 ? rang / (niveaux.length - 1) : 1
  return ratio === 0 ? C.rouge : ratio < 0.5 ? C.orange : ratio < 1 ? C.bleu : C.vert
}
/** Étiquette d'une réponse dans une pastille : ce qui précède la première virgule (« Oui, en place et documenté » → « OUI »). */
const etiquetteCourte = (libelle?: string) => {
  const t = (libelle ?? 'Sans réponse').split(',')[0]!.trim().toUpperCase()
  return t.length > 22 ? `${t.slice(0, 21)}…` : t
}
const couleurCoefficient = (c: number): RGB => (c >= 1 ? C.vert : c > 0 ? C.orange : C.rouge)

export async function genererRapportAutodiagnostic(trx: Transaction<DB>, ctx: { entrepriseId: string }, id: unknown): Promise<{ octets: Uint8Array, nomFichier: string }> {
  const [a, entreprise] = await Promise.all([obtenirEvaluation(trx, id), contexteEntreprise(trx, ctx.entrepriseId)])
  if (a.statut !== 'terminee' || !a.resultat) throw new ErreurMetier(409, 'Le rapport est disponible une fois l’évaluation terminée.')
  const r = a.resultat
  const def = a.definition
  const libelleReponse = new Map(def.echelleReponses.map((e) => [e.code, e]))
  const actionParQuestion = new Map(a.actions.map((x) => [x.question_id, x]))

  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle(`Rapport d’autodiagnostic — ${a.referentiel_titre}`)
  pdf.setAuthor('IFECARM GROUP')
  pdf.setSubject(`${entreprise.nom} — ${dateCourteFr(a.realise_le)}`)
  const police = (nom: string) => readFile(path.join(DOSSIER_ASSETS, 'fonts', nom)).then((o) => pdf.embedFont(o, { subset: true }))
  const F = { titre: await police('Poppins-Bold.ttf'), titre2: await police('Poppins-SemiBold.ttf'), texte: await police('Poppins-Regular.ttf'), moyen: await police('Poppins-Medium.ttf') }
  const logo = await pdf.embedPng(await readFile(path.join(DOSSIER_ASSETS, 'logo-prestige.png')))

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
  let cy = HAUTEUR - 96 - lh - 70
  centre('RAPPORT D’AUTODIAGNOSTIC QHSE', cy, 17, F.texte, C.encre, 1.2)
  cy -= 30
  for (const ligne of couper(a.referentiel_titre.toUpperCase(), F.texte, 10.5, L - 60)) { centre(ligne, cy, 10.5, F.texte, C.encreDouce, 0.6); cy -= 16 }
  centre(`ÉVALUATION DU ${dateFr(a.realise_le).toUpperCase()}`, cy, 10.5, F.texte, C.encreDouce, 0.6)
  cy -= 28
  centre(`${entreprise.nom}${entreprise.statutRelation === 'prospect' ? ' (prospect)' : ''}`, cy, 10.5, F.moyen, C.vert)
  if (a.site_nom) centre(`Site : ${a.site_nom}`, cy - 18, 9, F.texte, C.gris)
  centre(`RÉF. ${a.reference}`, 190, 8.5, F.texte, C.gris, 0.5)
  centre('IFECARM GROUP SARL — QHSE RISK MANAGEMENT', 176, 8.5, F.texte, C.gris, 0.5)

  // ── Synthèse ──
  titreSection('Synthèse')
  const nbQuestions = def.themes.reduce((n, t) => n + t.questions.length, 0)
  const nbEcarts = r.recommendations.length
  const couleurGlobale = couleurScore(r.globalScore, def.niveaux)
  const tuiles = [
    { valeur: `${r.globalScore} %`, label: 'Score global', couleur: couleurGlobale },
    { valeur: r.niveau.libelle, label: 'Niveau de maturité', couleur: couleurGlobale },
    { valeur: `${nbQuestions - nbEcarts}/${nbQuestions}`, label: 'Points pleinement conformes', couleur: C.vert },
    { valeur: String(nbEcarts), label: 'Écarts à traiter', couleur: nbEcarts ? C.orange : C.vert },
  ]
  const lt = (L - 3 * 8) / 4
  tuiles.forEach((t, k) => {
    const x = MARGE + k * (lt + 8)
    page.drawRectangle({ x, y: y - 44, width: lt, height: 50, color: C.blanc, borderColor: C.filet, borderWidth: 0.8 })
    page.drawRectangle({ x, y: y - 44, width: 3, height: 50, color: t.couleur })
    let taille = 17
    while (F.titre.widthOfTextAtSize(t.valeur, taille) > lt - 20 && taille > 8.5) taille -= 0.5
    page.drawText(t.valeur, { x: x + 12, y: y - 18, size: taille, font: F.titre, color: C.encre })
    couper(t.label, F.moyen, 7.5, lt - 18).slice(0, 2).forEach((l, j) => page.drawText(l, { x: x + 12, y: y - 32 - j * 9, size: 7.5, font: F.moyen, color: C.gris }))
  })
  y -= 64
  paragraphe(r.niveau.message, { taille: 10, couleur: C.encre, interligne: 15 })
  y -= 4
  if (a.precedente) {
    const ecart = r.globalScore - a.precedente.score_global
    paragraphe(`Évaluation précédente (${dateCourteFr(a.precedente.realise_le)}) : ${a.precedente.score_global} % — ${ecart === 0 ? 'score identique' : `${ecart > 0 ? '+' : ''}${ecart} point${Math.abs(ecart) > 1 ? 's' : ''}`}.`, { taille: 9.5, f: F.moyen, couleur: ecart >= 0 ? C.vert : C.rouge })
  }
  const conduite = [a.interlocuteur ? `Interlocuteur : ${a.interlocuteur}` : null, a.conduit_par_nom ? `Évaluation conduite par : ${a.conduit_par_nom}` : null].filter(Boolean).join('   ·   ')
  if (conduite) paragraphe(conduite, { taille: 8.5, couleur: C.gris })

  // ── Scores par thème ──
  titreSection('Scores par thème', 70)
  const precedentParTheme = new Map((a.precedente?.themes ?? []).map((t) => [t.code, t.score]))
  for (const t of r.themes) {
    place(30)
    const couleur = couleurScore(t.score, def.niveaux)
    const libelle = couper(t.libelle, F.moyen, 9, L * 0.4)[0]!
    page.drawText(libelle, { x: MARGE, y, size: 9, font: F.moyen, color: C.encre })
    const debut = MARGE + L * 0.42
    const barre = L * 0.42
    page.drawRectangle({ x: debut, y: y - 2, width: barre, height: 9, color: C.grisClair })
    if (t.score > 0) page.drawRectangle({ x: debut, y: y - 2, width: Math.max(2, (barre * t.score) / 100), height: 9, color: couleur })
    const precedent = precedentParTheme.get(t.code)
    const delta = precedent === undefined ? '' : `  ${t.score - precedent > 0 ? '+' : ''}${t.score - precedent}`
    page.drawText(`${t.score} %${delta}`, { x: debut + barre + 8, y, size: 9, font: F.titre2, color: C.encre })
    y -= 22
  }

  // ── Points d'amélioration prioritaires ──
  titreSection(`Points d’amélioration prioritaires (${nbEcarts})`, 70)
  if (!nbEcarts) paragraphe('Aucun écart : toutes les réponses sont pleinement conformes.', { couleur: C.encreDouce })
  const questions = new Map(def.themes.flatMap((t) => t.questions.map((q) => [q.id, q] as const)))
  for (const e of r.recommendations) {
    const q = questions.get(e.questionId)
    const rep = libelleReponse.get(a.reponses[e.questionId] ?? '')
    const action = actionParQuestion.get(e.questionId)
    const lignes = couper(e.texte, F.moyen, 9.5, L - 150)
    const detail = couper(`${e.themeLibelle} — ${q?.texte ?? ''}`, F.texte, 7.8, L - 28)
    const hauteur = 10 + lignes.length * 13 + detail.length * 11 + (action ? 12 : 0) + 6
    place(hauteur + 4)
    page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: L, height: hauteur, color: C.pale })
    page.drawRectangle({ x: MARGE, y: y - hauteur + 12, width: 3, height: hauteur, color: couleurCoefficient(rep?.coefficient ?? 0) })
    const court = etiquetteCourte(rep?.libelle)
    pastille(court, MARGE + L - (F.titre2.widthOfTextAtSize(court, 7) + 12) - 8, y - 2, couleurCoefficient(rep?.coefficient ?? 0), 7)
    lignes.forEach((l, k) => page.drawText(l, { x: MARGE + 12, y: y - 2 - k * 13, size: 9.5, font: F.moyen, color: C.encre }))
    let ly = y - 2 - lignes.length * 13
    for (const l of detail) { page.drawText(l, { x: MARGE + 12, y: ly, size: 7.8, font: F.texte, color: C.gris }); ly -= 11 }
    if (action) page.drawText(`Action ${action.reference}${action.responsable_nom ? ` — ${action.responsable_nom}` : ''}${action.echeance ? ` — échéance ${dateCourteFr(action.echeance)}` : ''}`, { x: MARGE + 12, y: ly, size: 7.8, font: F.titre2, color: C.vert })
    y -= hauteur + 4
  }

  // ── Détail des réponses ──
  titreSection('Détail des réponses', 70)
  for (const t of def.themes) {
    place(46)
    page.drawText(t.libelle, { x: MARGE, y, size: 10, font: F.titre2, color: C.vert })
    y -= 16
    for (const q of t.questions) {
      const rep = libelleReponse.get(a.reponses[q.id] ?? '')
      const lignes = couper(q.texte, F.texte, 8.8, L - 140)
      const commentaire = a.commentaires[q.id] ? couper(`« ${a.commentaires[q.id]} »`, F.texte, 8, L - 20) : []
      const hauteur = lignes.length * 12 + commentaire.length * 11 + 8
      place(hauteur + 2)
      lignes.forEach((l, k) => page.drawText(l, { x: MARGE, y: y - k * 12, size: 8.8, font: F.texte, color: C.encreDouce }))
      const court = etiquetteCourte(rep?.libelle)
      pastille(court, MARGE + L - (F.titre2.widthOfTextAtSize(court, 7) + 12), y, couleurCoefficient(rep?.coefficient ?? 0), 7)
      let ly = y - lignes.length * 12
      for (const l of commentaire) { page.drawText(l, { x: MARGE + 10, y: ly, size: 8, font: F.texte, color: C.gris }); ly -= 11 }
      page.drawLine({ start: { x: MARGE, y: ly + 5 }, end: { x: MARGE + L, y: ly + 5 }, thickness: 0.4, color: C.filet })
      y -= hauteur + 4
    }
    y -= 6
  }

  paragraphe(a.avertissement, { taille: 8, f: F.texte, couleur: C.gris, interligne: 11 })

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
    p.drawText(a.reference, { x: MARGE, y: haut, size: 8, font: F.titre2, color: C.vert })
    const droite = `${couper(a.referentiel_titre, F.texte, 8, 260)[0]} · Page ${i + 1} / ${total}`
    p.drawText(droite, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(droite, 8), y: haut, size: 8, font: F.texte, color: C.gris })
    filet(p, haut - 8)
    filet(p, 46)
    p.drawText('IFECARM GROUP SARL — QHSE Risk Management · Cotonou — Paris · www.ifecarm-qhse.com', { x: MARGE, y: 32, size: 7, font: F.texte, color: C.gris })
    const date = `Édité le ${edite}`
    p.drawText(date, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(date, 7), y: 32, size: 7, font: F.texte, color: C.gris })
  }

  const slug = `${a.referentiel_code}-${entreprise.nom}-${a.realise_le}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return { octets: await pdf.save(), nomFichier: `rapport-autodiagnostic-${slug}.pdf` }
}
