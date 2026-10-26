/**
 * Synchronise la copie du catalogue de formations (src/formations/catalogue.json) avec celle du site vitrine, lue directement
 * dans le dépôt du site (app/data/formations.light.json, généré depuis formations.ts par `npm run formations:light` côté site).
 *
 *   npm run catalogue:synchroniser                 compare et affiche les différences, n'écrit rien
 *   npm run catalogue:synchroniser -- --ecrire     réécrit src/formations/catalogue.json
 *   npm run catalogue:synchroniser -- --ecrire --importer   puis met à jour la table `formation` (npm run import:catalogue)
 *
 * Dépôt du site : ../ifecarm par défaut, ou la variable SITE_VITRINE_DIR. Seuls le titre, la durée et la famille sont repris
 * (français). Rien n'est supprimé en base : une fiche retirée du site reste dans `formation` (l'import la signale seulement).
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface CoursSite { slug: string, title: { fr: string }, duration: { fr: string } }
interface FamilleSite { id: string, label: { fr: string }, courses: CoursSite[] }
interface Famille { id: string, label: string, formations: { slug: string, titre: string, duree: string }[] }

const FICHIER_COPIE = path.join(process.cwd(), 'src', 'formations', 'catalogue.json')
const dossierSite = path.resolve(process.cwd(), process.env.SITE_VITRINE_DIR ?? '../ifecarm')
const fichierSite = path.join(dossierSite, 'app', 'data', 'formations.light.json')

function main() {
  const ecrire = process.argv.includes('--ecrire')
  const importer = process.argv.includes('--importer')
  if (importer && !ecrire) throw new Error('--importer suppose --ecrire (on importe la copie à jour).')
  if (!existsSync(fichierSite)) throw new Error(`Catalogue du site introuvable : ${fichierSite}\nIndiquez le dépôt du site avec SITE_VITRINE_DIR.`)

  const site = JSON.parse(readFileSync(fichierSite, 'utf8')) as FamilleSite[]
  const nouveau: Famille[] = site.map((f) => ({
    id: f.id,
    label: f.label.fr,
    formations: f.courses.map((c) => ({ slug: c.slug, titre: c.title.fr, duree: c.duration.fr })),
  }))

  const slugs = new Map<string, number>()
  for (const f of nouveau) for (const c of f.formations) slugs.set(c.slug, (slugs.get(c.slug) ?? 0) + 1)
  const doublons = [...slugs].filter(([, n]) => n > 1).map(([s]) => s)
  if (doublons.length) throw new Error(`Slugs en double dans le catalogue du site : ${doublons.join(', ')}`)

  const actuel = existsSync(FICHIER_COPIE) ? (JSON.parse(readFileSync(FICHIER_COPIE, 'utf8')) as Famille[]) : []
  const aplatir = (l: Famille[]) => new Map(l.flatMap((f) => f.formations.map((c) => [c.slug, { ...c, famille: f.label }] as const)))
  const avant = aplatir(actuel)
  const apres = aplatir(nouveau)

  const ajoutees = [...apres.keys()].filter((s) => !avant.has(s))
  const retirees = [...avant.keys()].filter((s) => !apres.has(s))
  const modifiees = [...apres].filter(([s, c]) => {
    const a = avant.get(s)
    return a && (a.titre !== c.titre || a.duree !== c.duree || a.famille !== c.famille)
  })
  const identique = JSON.stringify(actuel) === JSON.stringify(nouveau)

  console.log(`Site : ${nouveau.length} familles, ${apres.size} formations (${fichierSite}).`)
  console.log(`Copie actuelle : ${actuel.length} familles, ${avant.size} formations.`)
  if (identique) console.log('La copie est identique au catalogue du site.')
  else {
    console.log(`Différences : ${ajoutees.length} ajoutée(s), ${retirees.length} retirée(s), ${modifiees.length} modifiée(s).`)
    for (const s of ajoutees.slice(0, 15)) console.log(`  + ${s} — ${apres.get(s)!.titre} (${apres.get(s)!.duree})`)
    for (const s of retirees.slice(0, 15)) console.log(`  - ${s} — ${avant.get(s)!.titre}`)
    for (const [s, c] of modifiees.slice(0, 15)) {
      const a = avant.get(s)!
      console.log(`  ~ ${s} : ${a.titre !== c.titre ? `titre « ${a.titre} » → « ${c.titre} »` : ''}${a.duree !== c.duree ? ` durée « ${a.duree} » → « ${c.duree} »` : ''}${a.famille !== c.famille ? ` famille « ${a.famille} » → « ${c.famille} »` : ''}`)
    }
    const total = ajoutees.length + retirees.length + modifiees.length
    if (total > 45) console.log(`  … ${total - 45} autre(s) non listée(s)`)
  }

  if (!ecrire) {
    if (!identique) console.log('Rien n’a été écrit. Relancez avec --ecrire pour mettre à jour la copie.')
    return
  }
  if (!identique) {
    writeFileSync(FICHIER_COPIE, JSON.stringify(nouveau))
    console.log('src/formations/catalogue.json mis à jour.')
  }
  if (importer) {
    console.log('Import dans la table formation…')
    const r = spawnSync('npm', ['run', 'import:catalogue'], { stdio: 'inherit', shell: true })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
}

try {
  main()
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
