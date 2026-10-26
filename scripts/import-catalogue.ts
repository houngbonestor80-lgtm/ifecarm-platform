/**
 * Import du catalogue de formations du site vitrine (src/formations/catalogue.json)
 * dans la table `formation` (entreprise_id NULL = catalogue IFECARM GROUP).
 * Rejouable : mise à jour par slug de l'intitulé, du domaine et de la durée
 * indicative ; ne touche JAMAIS à validite_mois ni à actif (décidés par
 * l'administrateur). Ne supprime rien : les fiches absentes du JSON sont
 * seulement signalées. Connecte avec ifecarm_migrate (propriétaire).
 *
 * Durée : seules les « N jour(s) » donnent duree_jours ; le texte du site
 * (« 5H », « Sur mesure »…) est toujours conservé dans duree_libelle.
 * Usage : npm run import:catalogue [-- --dry-run]
 */
import 'dotenv/config'
import { Client } from 'pg'
import catalogue from '../src/formations/catalogue.json'

const SECTION = /^\s*(\d+(?:[.,]\d+)?)\s*jours?\s*$/i

export function dureeEnJours(libelle: string): number | null {
  const m = SECTION.exec(libelle)
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null
}

async function main() {
  const essai = process.argv.includes('--dry-run')
  const connectionString = process.env.DATABASE_URL_MIGRATE
  if (!connectionString) throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')

  const fiches = catalogue.flatMap((famille) => famille.formations.map((f) => ({ ...f, domaine: famille.label })))
  const slugs = new Map<string, number>()
  for (const f of fiches) slugs.set(f.slug, (slugs.get(f.slug) ?? 0) + 1)
  const doublons = [...slugs].filter(([, n]) => n > 1).map(([s]) => s)
  if (doublons.length) throw new Error(`Slugs en double dans catalogue.json : ${doublons.join(', ')}`)

  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('begin')
    const avant = new Set((await client.query<{ slug: string }>('select slug from formation where entreprise_id is null')).rows.map((r) => r.slug))
    let crees = 0
    let misAJour = 0
    const nonConverties = new Map<string, number>()

    for (const f of fiches) {
      const jours = dureeEnJours(f.duree)
      if (jours === null) nonConverties.set(f.duree, (nonConverties.get(f.duree) ?? 0) + 1)
      await client.query(
        `insert into formation (entreprise_id, slug, intitule, domaine, duree_jours, duree_libelle)
         values (null, $1, $2, $3, $4, $5)
         on conflict (slug) where entreprise_id is null do update
           set intitule = excluded.intitule, domaine = excluded.domaine,
               duree_jours = excluded.duree_jours, duree_libelle = excluded.duree_libelle`,
        [f.slug, f.titre, f.domaine, jours, f.duree],
      )
      if (avant.has(f.slug)) misAJour++
      else crees++
    }

    const horsJson = [...avant].filter((s) => !slugs.has(s))
    console.log(`${fiches.length} fiches lues : ${crees} créées, ${misAJour} mises à jour.`)
    console.log(`Durées sans équivalent en jours (duree_jours vide, texte conservé) : ${[...nonConverties.values()].reduce((a, b) => a + b, 0)}`)
    for (const [d, n] of [...nonConverties].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} × « ${d} »`)
    if (horsJson.length) {
      console.log(`Fiches du catalogue en base absentes du JSON (conservées) : ${horsJson.length}`)
      for (const s of horsJson.slice(0, 10)) console.log(`  ${s}`)
      if (horsJson.length > 10) console.log(`  … et ${horsJson.length - 10} autres`)
    }
    await client.query(essai ? 'rollback' : 'commit')
    if (essai) console.log('Essai à blanc : rien n’a été écrit.')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    await client.end()
  }
}

if (process.argv[1]?.includes('import-catalogue')) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
