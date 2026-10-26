/**
 * Génère le guide d'utilisation en PDF (docs/guide-utilisation.pdf) à partir de docs/guide-utilisation.md, avec la charte
 * graphique IFECARM GROUP des autres documents (Poppins seule, noir #1A1A1A, un seul vert, LOGO-01 en couverture, pied légal
 * page 1, en-tête technique ensuite). Le sommaire, avec ses numéros de page, est calculé à la génération.
 *
 * Markdown pris en charge : titres #, ##, ###, paragraphes, listes à puces et numérotées (avec retrait), tableaux, citations >,
 * séparateurs ---, gras **, code `…`, liens [texte](adresse) (le texte seul est gardé).
 * Usage : npm run guide:pdf
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'

// Papier à en-tête officiel (mêmes données que src/inspections/rapport.ts, recopiées pour ne pas charger le stockage S3).
const ENTETE = {
  colonnes: [
    { titre: 'SIÈGE INTERNATIONAL', lignes: ['6 rue d’Armaillé, Paris — France', '(+33) 7 67 72 43 68', 'SIREN 952 449 346 R.C.S · Code NAF 71.12B'] },
    { titre: 'SIÈGE AFRIQUE', lignes: ['Aïbatin Kpota, Cotonou — Bénin', '(+229) 01 91 38 44 44 · 01 91 32 24 70', 'RCCM RB/COT/26 B 42475 · IFU 3202686150102'] },
    { titre: 'CONTACT', lignes: ['info@ifecarm-qhse.com', 'www.ifecarm-qhse.com'] },
  ],
}


const RACINE = process.cwd()
const SOURCE = path.join(RACINE, 'docs', 'guide-utilisation.md')
const SORTIE = path.join(RACINE, 'docs', 'guide-utilisation.pdf')
const ASSETS = path.join(RACINE, 'assets', 'pdf')

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
const C = { vert: hex('2D7A44'), gris: hex('6E7A76'), encre: hex('1A1A1A'), douce: hex('3C484D'), pale: hex('F5F6F4'), filet: hex('DCE0DD'), blanc: rgb(1, 1, 1) }

const LARGEUR = 595.28
const HAUTEUR = 841.89
const MARGE = 44
const L = LARGEUR - MARGE * 2
const HAUT = HAUTEUR - MARGE - 14
const BAS = 62

type Mot = { t: string, f: PDFFont, c: RGB, espace: boolean }

async function main() {
  const md = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n')
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const police = (nom: string) => pdf.embedFont(readFileSync(path.join(ASSETS, 'fonts', nom)), { subset: true })
  const F = { gras: await police('Poppins-Bold.ttf'), semi: await police('Poppins-SemiBold.ttf'), moyen: await police('Poppins-Medium.ttf'), texte: await police('Poppins-Regular.ttf') }
  const logo = await pdf.embedPng(readFileSync(path.join(ASSETS, 'logo-prestige.png')))
  pdf.setTitle('Plateforme QHSE IFECARM GROUP — Guide d’utilisation')
  pdf.setAuthor('IFECARM GROUP')

  // Caractères que Poppins ne sait pas dessiner : remplacés (et signalés) plutôt que d'échouer.
  const connus = new Set(F.texte.getCharacterSet())
  const remplace = new Map<string, number>()
  const SUBST: Record<string, string> = { '→': '›', '≥': '>=', '≤': '<=', '✓': 'OK', '×': 'x', ' ': ' ', ' ': ' ', '＋': '+' }
  const nettoie = (t: string) => [...t].map((ch) => {
    if (ch === '\n' || connus.has(ch.codePointAt(0)!)) return ch
    remplace.set(ch, (remplace.get(ch) ?? 0) + 1)
    return SUBST[ch] ?? '?'
  }).join('')

  // ------------------------------------------------------------ Mise en forme du texte
  function runs(texte: string, base: PDFFont, couleur: RGB): Mot[] {
    const mots: Mot[] = []
    let espaceEnAttente = false
    const pousser = (segment: string, f: PDFFont, c: RGB) => {
      for (const part of nettoie(segment).split(/(\s+)/)) {
        if (part === '') continue
        if (/^\s+$/.test(part)) { espaceEnAttente = true; continue }
        mots.push({ t: part, f, c, espace: espaceEnAttente && mots.length > 0 })
        espaceEnAttente = false
      }
    }
    for (const morceau of texte.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/)) {
      if (!morceau) continue
      if (morceau.startsWith('**')) pousser(morceau.slice(2, -2), F.semi, couleur === C.douce ? C.encre : couleur)
      else if (morceau.startsWith('`')) pousser(morceau.slice(1, -1), F.moyen, C.vert)
      else if (morceau.startsWith('[')) pousser(morceau.slice(1, morceau.indexOf(']')), base, couleur)
      else pousser(morceau, base, couleur)
      // L'espace d'un segment voisin (ex. « **a** b ») est porté par le texte suivant : on le détecte ici.
      const apres = morceau.match(/\s+$/)
      if (apres) espaceEnAttente = true
    }
    return mots
  }

  function lignes(mots: Mot[], taille: number, largeur: number): Mot[][] {
    const out: Mot[][] = [[]]
    let x = 0
    for (const m of mots) {
      const w = m.f.widthOfTextAtSize(m.t, taille)
      const sp = m.espace ? F.texte.widthOfTextAtSize(' ', taille) : 0
      if (out[out.length - 1]!.length && x + sp + w > largeur) { out.push([]); x = 0 }
      const ligne = out[out.length - 1]!
      x += ligne.length ? sp + w : w
      ligne.push(ligne.length ? m : { ...m, espace: false })
    }
    return out
  }

  // ------------------------------------------------------------ Pages
  const couverture = pdf.addPage([LARGEUR, HAUTEUR])
  const pageSommaire = pdf.addPage([LARGEUR, HAUTEUR])
  let page: PDFPage = pdf.addPage([LARGEUR, HAUTEUR])
  let y = HAUT
  const nouvellePage = () => { page = pdf.addPage([LARGEUR, HAUTEUR]); y = HAUT }
  const place = (besoin: number) => { if (y - besoin < BAS) nouvellePage() }
  const numeroPage = () => pdf.getPageCount()

  function dessiner(ligne: Mot[], x0: number, yy: number, taille: number, p: PDFPage = page) {
    let x = x0
    for (const m of ligne) {
      if (m.espace) x += F.texte.widthOfTextAtSize(' ', taille)
      p.drawText(m.t, { x, y: yy, size: taille, font: m.f, color: m.c })
      x += m.f.widthOfTextAtSize(m.t, taille)
    }
  }

  function bloc(texte: string, { x = MARGE, largeur = L, taille = 9.5, base = F.texte, couleur = C.douce, interligne = 14.5 } = {}) {
    for (const l of lignes(runs(texte, base, couleur), taille, largeur)) {
      place(interligne)
      dessiner(l, x, y, taille)
      y -= interligne
    }
  }

  // ------------------------------------------------------------ Lecture du Markdown
  const brut = md.split('\n')
  const titreDocument = (brut.find((l) => l.startsWith('# ')) ?? '# Guide d’utilisation').slice(2)
  const version = /Version du ([0-9/]+)/.exec(md)?.[1] ?? new Date().toLocaleDateString('fr-FR')
  // Introduction : lignes entre le titre et le premier « --- » ; sommaire écrit à la main : ignoré (recalculé plus bas).
  let i = brut.findIndex((l) => l.startsWith('# ')) + 1
  const intro: string[] = []
  while (i < brut.length && brut[i] !== '---') { if (brut[i]!.trim()) intro.push(brut[i]!.trim()); i++ }
  while (i < brut.length && !brut[i]!.startsWith('## 1.')) i++
  const corps = brut.slice(i)

  const sommaire: { niveau: 2 | 3, titre: string, page: number }[] = []

  // ------------------------------------------------------------ Corps
  const introMots = intro.join(' ')
  if (introMots) { bloc(introMots, { taille: 10, couleur: C.encre, interligne: 15.5 }); y -= 10 }

  let n = 0
  while (n < corps.length) {
    const l = corps[n]!
    if (!l.trim() || l.trim() === '---') { n++; continue }

    if (l.startsWith('## ')) {
      const titre = l.slice(3).trim()
      if (y < HAUT - 20) place(200) // un chapitre ne démarre pas en bas de page
      y -= 6
      place(60)
      page.drawRectangle({ x: MARGE, y: y - 4, width: 4, height: 18, color: C.vert })
      for (const t of lignes(runs(titre, F.gras, C.encre), 15, L - 14)) { dessiner(t, MARGE + 14, y, 15); y -= 20 }
      sommaire.push({ niveau: 2, titre, page: numeroPage() })
      y -= 6
      n++; continue
    }
    if (l.startsWith('### ')) {
      const titre = l.slice(4).trim()
      place(70)
      y -= 8
      for (const t of lignes(runs(titre, F.semi, C.vert), 11.5, L)) { dessiner(t, MARGE, y, 11.5); y -= 16 }
      sommaire.push({ niveau: 3, titre, page: numeroPage() })
      y -= 2
      n++; continue
    }
    if (l.startsWith('>')) {
      const texte: string[] = []
      while (n < corps.length && corps[n]!.startsWith('>')) { texte.push(corps[n]!.replace(/^>\s?/, '')); n++ }
      const mots = runs(texte.join(' '), F.texte, C.douce)
      const ls = lignes(mots, 9, L - 26)
      const h = ls.length * 13 + 16
      place(h + 6)
      page.drawRectangle({ x: MARGE, y: y - h + 12, width: L, height: h, color: C.pale })
      page.drawRectangle({ x: MARGE, y: y - h + 12, width: 3, height: h, color: C.vert })
      let yy = y - 2
      for (const t of ls) { dessiner(t, MARGE + 14, yy, 9); yy -= 13 }
      y -= h + 8
      continue
    }
    if (l.startsWith('|')) {
      const rangees: string[][] = []
      while (n < corps.length && corps[n]!.startsWith('|')) {
        const cellules = corps[n]!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
        if (!cellules.every((c) => /^:?-{2,}:?$/.test(c))) rangees.push(cellules)
        n++
      }
      const nb = Math.max(...rangees.map((r) => r.length))
      const poids = Array.from({ length: nb }, (_, k) => Math.min(48, Math.max(8, ...rangees.map((r) => (r[k] ?? '').replace(/\*\*|`/g, '').length / 1.6))))
      const total = poids.reduce((a, b) => a + b, 0)
      const largeurs = poids.map((p) => (p / total) * L)
      const taille = 8.4
      const dessinerRangee = (r: string[], entete: boolean) => {
        const cases = largeurs.map((w, k) => lignes(runs(r[k] ?? '', entete ? F.semi : F.texte, entete ? C.encre : C.douce), taille, w - 12))
        const h = Math.max(...cases.map((c) => c.length)) * 11.5 + 9
        place(h)
        let x = MARGE
        cases.forEach((c, k) => {
          page.drawRectangle({ x, y: y - h + 11, width: largeurs[k]!, height: h, color: entete ? C.pale : C.blanc, borderColor: C.filet, borderWidth: 0.6 })
          let yy = y - 3
          for (const t of c) { dessiner(t, x + 6, yy, taille); yy -= 11.5 }
          x += largeurs[k]!
        })
        y -= h
      }
      y -= 2
      rangees.forEach((r, k) => {
        if (k > 0 && y - 40 < BAS) { nouvellePage(); dessinerRangee(rangees[0]!, true) }
        dessinerRangee(r, k === 0)
      })
      y -= 10
      continue
    }
    const puce = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l)
    if (puce) {
      const niveau = Math.floor(puce[1]!.length / 3)
      const marque = /^\d/.test(puce[2]!) ? puce[2]! : '•'
      const retrait = 14 + niveau * 16
      // Ligne suivante indentée sans puce : suite du même élément.
      let texte = puce[3]!
      while (n + 1 < corps.length && /^\s{2,}\S/.test(corps[n + 1]!) && !/^\s*([-*]|\d+\.)\s/.test(corps[n + 1]!)) { texte += ` ${corps[n + 1]!.trim()}`; n++ }
      const ls = lignes(runs(texte, F.texte, C.douce), 9.5, L - retrait - 6)
      place(Math.min(ls.length, 2) * 14.5)
      page.drawText(nettoie(marque), { x: MARGE + 3 + niveau * 16, y, size: 9.5, font: marque === '•' ? F.semi : F.semi, color: C.vert })
      for (const t of ls) { place(14.5); dessiner(t, MARGE + retrait + (marque === '•' ? 2 : 6), y, 9.5); y -= 14.5 }
      y -= 1.5
      n++; continue
    }
    // Paragraphe : lignes consécutives fusionnées.
    const texte: string[] = [l.trim()]
    while (n + 1 < corps.length && corps[n + 1]!.trim() && !/^(#|>|\||---|\s*([-*]|\d+\.)\s)/.test(corps[n + 1]!)) { texte.push(corps[n + 1]!.trim()); n++ }
    bloc(texte.join(' '))
    y -= 4
    n++
  }

  // ------------------------------------------------------------ Couverture
  const lw = 210
  const lh = (logo.height / logo.width) * lw
  couverture.drawImage(logo, { x: (LARGEUR - lw) / 2, y: HAUTEUR - 96 - lh, width: lw, height: lh })
  const centre = (t: string, yy: number, taille: number, f: PDFFont, couleur: RGB, espace = 0) => {
    const w = f.widthOfTextAtSize(t, taille) + espace * Math.max(t.length - 1, 0)
    let x = (LARGEUR - w) / 2
    if (!espace) { couverture.drawText(t, { x, y: yy, size: taille, font: f, color: couleur }); return }
    for (const c of t) { couverture.drawText(c, { x, y: yy, size: taille, font: f, color: couleur }); x += f.widthOfTextAtSize(c, taille) + espace }
  }
  const cy = HAUTEUR - 96 - lh - 70
  centre('GUIDE D’UTILISATION', cy, 18, F.texte, C.encre, 1.4)
  centre('PLATEFORME QHSE', cy - 30, 10.5, F.texte, C.douce, 0.8)
  centre('CLIENTS · CONSULTANTS · ADMINISTRATEURS', cy - 48, 9, F.texte, C.vert, 0.6)
  centre(`Version du ${version}`, cy - 78, 9, F.texte, C.gris)
  centre('IFECARM GROUP SARL — QHSE RISK MANAGEMENT', 176, 8.5, F.texte, C.gris, 0.5)

  // ------------------------------------------------------------ Sommaire (page 2) : titres et numéros de page
  const total = pdf.getPageCount()
  {
    let ys = HAUT
    pageSommaire.drawRectangle({ x: MARGE, y: ys - 4, width: 4, height: 18, color: C.vert })
    pageSommaire.drawText('Sommaire', { x: MARGE + 14, y: ys, size: 15, font: F.gras, color: C.encre })
    ys -= 34
    const nbLignes = sommaire.length
    const pas = Math.min(15, (ys - BAS) / (nbLignes + 4))
    for (const e of sommaire) {
      const h2 = e.niveau === 2
      if (h2) ys -= pas * 0.35
      const taille = h2 ? 10 : 8.8
      const f = h2 ? F.semi : F.texte
      const titre = nettoie(e.titre.replace(/\*\*|`/g, ''))
      const x = MARGE + (h2 ? 0 : 16)
      let t = titre
      while (f.widthOfTextAtSize(t, taille) > L - x + MARGE - 40 && t.length > 10) t = `${t.slice(0, -2)}…`
      pageSommaire.drawText(t, { x, y: ys, size: taille, font: f, color: h2 ? C.encre : C.douce })
      const num = String(e.page)
      const wn = f.widthOfTextAtSize(num, taille)
      const finTitre = x + f.widthOfTextAtSize(t, taille) + 6
      const debutNum = LARGEUR - MARGE - wn
      for (let px = finTitre; px < debutNum - 6; px += 4) pageSommaire.drawText('.', { x: px, y: ys, size: taille, font: F.texte, color: C.filet })
      pageSommaire.drawText(num, { x: debutNum, y: ys, size: taille, font: f, color: h2 ? C.vert : C.gris })
      ys -= pas
    }
  }

  // ------------------------------------------------------------ En-têtes et pieds
  const edite = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Porto-Novo' })
  const filet = (p: PDFPage, yy: number) => p.drawLine({ start: { x: MARGE, y: yy }, end: { x: LARGEUR - MARGE, y: yy }, thickness: 0.85, color: C.filet })
  for (let k = 0; k < total; k++) {
    const p = pdf.getPage(k)
    if (k === 0) {
      filet(p, 94)
      const col = L / 3
      ENTETE.colonnes.forEach((c, j) => {
        const x = MARGE + j * col
        p.drawText(c.titre, { x, y: 81, size: 6.5, font: F.semi, color: C.vert })
        c.lignes.forEach((ligne, m) => {
          let taille = 7
          while (F.texte.widthOfTextAtSize(ligne, taille) > col - 10 && taille > 5.5) taille -= 0.25
          p.drawText(nettoie(ligne), { x, y: 70 - m * 11.2, size: taille, font: F.texte, color: C.gris })
        })
      })
      continue
    }
    const haut = HAUTEUR - MARGE + 6
    p.drawText('GUIDE D’UTILISATION', { x: MARGE, y: haut, size: 8, font: F.semi, color: C.vert })
    const droite = `Plateforme QHSE · Page ${k + 1} / ${total}`
    p.drawText(droite, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(droite, 8), y: haut, size: 8, font: F.texte, color: C.gris })
    filet(p, haut - 8)
    filet(p, 46)
    p.drawText('IFECARM GROUP SARL — QHSE Risk Management · Cotonou — Paris · www.ifecarm-qhse.com', { x: MARGE, y: 32, size: 7, font: F.texte, color: C.gris })
    const date = `Version du ${version} · édité le ${edite}`
    p.drawText(date, { x: LARGEUR - MARGE - F.texte.widthOfTextAtSize(date, 7), y: 32, size: 7, font: F.texte, color: C.gris })
  }

  writeFileSync(SORTIE, await pdf.save())
  console.log(`${SORTIE} — ${total} pages, ${sommaire.length} entrées au sommaire.`)
  if (remplace.size) console.log(`Caractères absents de Poppins, remplacés : ${[...remplace].map(([c, k]) => `« ${c} » ×${k}`).join(', ')}`)
  void titreDocument
}

main().catch((e) => { console.error(e); process.exit(1) })
