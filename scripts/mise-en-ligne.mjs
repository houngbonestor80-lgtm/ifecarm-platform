/**
 * Mise en ligne : prépare la base Neon de production, une seule fois.
 *
 *   1. crée les rôles ifecarm_migrate (propriétaire) et ifecarm_app
 *      (NOSUPERUSER, NOBYPASSRLS), avec des mots de passe aléatoires ;
 *   2. applique toutes les migrations (npm run migrate) ;
 *   3. importe les catalogues (formations, habilitations, autodiagnostic) ;
 *   4. crée le premier compte administrateur (admin_plateforme) avec un mot
 *      de passe provisoire aléatoire.
 *
 * Usage (depuis la racine du projet, PowerShell) :
 *   $env:OWNER_URL = "<adresse de connexion du rôle propriétaire fournie par Neon, avec ?sslmode=require>"
 *   node scripts/mise-en-ligne.mjs
 *
 * Variables facultatives : ADMIN_EMAIL, ADMIN_NOM.
 * Rejouable : les rôles existants voient leur mot de passe changé, les
 * migrations déjà appliquées sont ignorées, l'admin existant n'est pas recréé.
 * Aucun secret n'est écrit dans ce fichier ; les valeurs générées sont
 * affichées puis enregistrées dans secrets-mise-en-ligne.local (ignoré par git).
 */
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import argon2 from 'argon2'
import pg from 'pg'

const { Client } = pg

const ownerUrlBrute = process.env.OWNER_URL
if (!ownerUrlBrute) {
  console.error('OWNER_URL non définie. Voir l\'en-tête de scripts/mise-en-ligne.mjs.')
  process.exit(1)
}

const base = new URL(ownerUrlBrute)
const dbName = base.pathname.replace(/^\//, '')
if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Nom de base inattendu : ${dbName}`)

const urlPour = (utilisateur, motDePasse) => {
  // Identifiants encodés pour l'adresse ; channel_binding n'est pas géré par le client pg, d'où sslmode seul.
  const [identifiant, secret] = [utilisateur, motDePasse].map(encodeURIComponent)
  return `${base.protocol}//${identifiant}:${secret}@${base.host}${base.pathname}?sslmode=require`
}

const urlProprietaire = (() => {
  const u = new URL(ownerUrlBrute)
  u.search = '?sslmode=require'
  return u.toString()
})()

const mdpMigrate = randomBytes(24).toString('base64url')
const mdpApp = randomBytes(24).toString('base64url')
const urlMigrate = urlPour('ifecarm_migrate', mdpMigrate)
const urlApp = urlPour('ifecarm_app', mdpApp)

// ---- 1. Rôles --------------------------------------------------------
console.log('\n[1/4] Rôles de la base…')
{
  const owner = new Client({ connectionString: urlProprietaire })
  await owner.connect()
  const existe = async (nom) =>
    (await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [nom])).rowCount > 0

  if (await existe('ifecarm_migrate')) {
    await owner.query(`ALTER ROLE ifecarm_migrate WITH LOGIN PASSWORD '${mdpMigrate}'`)
  } else {
    await owner.query(`CREATE ROLE ifecarm_migrate WITH LOGIN PASSWORD '${mdpMigrate}' CREATEDB`)
  }
  if (await existe('ifecarm_app')) {
    await owner.query(
      `ALTER ROLE ifecarm_app WITH LOGIN PASSWORD '${mdpApp}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    )
  } else {
    await owner.query(
      `CREATE ROLE ifecarm_app WITH LOGIN PASSWORD '${mdpApp}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    )
  }
  await owner.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO ifecarm_migrate`)
  await owner.query('GRANT ALL ON SCHEMA public TO ifecarm_migrate')
  await owner.query('GRANT USAGE ON SCHEMA public TO ifecarm_app')
  await owner.end()
  console.log('      ifecarm_migrate et ifecarm_app prêts.')
}

// ---- 2 et 3. Migrations et imports ----------------------------------
const env = { ...process.env, DATABASE_URL_MIGRATE: urlMigrate }
const lancer = (commande) => execSync(commande, { stdio: 'inherit', env })

console.log('\n[2/4] Migrations…')
lancer('npm run migrate')

console.log('\n[3/4] Catalogues…')
lancer('npm run import:catalogue')
lancer('npm run import:habilitations')
lancer('npm run import:autodiagnostic')

// ---- 4. Premier administrateur --------------------------------------
console.log('\n[4/4] Compte administrateur…')
const adminEmail = process.env.ADMIN_EMAIL || 'houngbonestor80@gmail.com'
const adminNom = process.env.ADMIN_NOM || 'Houngbo Nestor'
const mdpAdmin = randomBytes(12).toString('base64url')
let adminCree = false
{
  const c = new Client({ connectionString: urlMigrate })
  await c.connect()
  const interne = (await c.query('SELECT id FROM entreprise WHERE interne = true LIMIT 1')).rows[0]
  if (!interne) throw new Error('Entreprise interne IFECARM introuvable : les migrations ont-elles réussi ?')

  const deja = await c.query('SELECT id FROM utilisateur WHERE entreprise_id = $1 AND email = $2', [
    interne.id,
    adminEmail,
  ])
  if (deja.rowCount === 0) {
    const hash = await argon2.hash(mdpAdmin, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    })
    const u = await c.query(
      'INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [interne.id, adminEmail, adminNom, hash],
    )
    await c.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'admin_plateforme')", [
      u.rows[0].id,
    ])
    adminCree = true
  }
  await c.end()
}

// ---- Résumé ----------------------------------------------------------
const lignes = [
  '# À mettre dans Vercel (Settings > Environment Variables), en remplaçant les anciennes valeurs',
  `DATABASE_URL_APP=${urlApp}`,
  '',
  '# Garder ici pour les futures migrations depuis ton PC (NE PAS mettre dans Vercel)',
  `DATABASE_URL_MIGRATE=${urlMigrate}`,
  '',
  adminCree
    ? `# Compte administrateur : ${adminEmail} / mot de passe provisoire : ${mdpAdmin}`
    : `# Compte administrateur ${adminEmail} existait déjà : mot de passe inchangé`,
]
writeFileSync('secrets-mise-en-ligne.local', lignes.join('\n') + '\n', { mode: 0o600 })

console.log('\n==================== TERMINÉ ====================')
console.log(lignes.join('\n'))
console.log('=================================================')
console.log('Ces valeurs sont aussi dans secrets-mise-en-ligne.local (ignoré par git).')
