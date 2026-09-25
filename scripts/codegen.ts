/**
 * Wrapper cross-plateforme : le script npm d'origine interpolait
 * $DATABASE_URL_MIGRATE à la mode bash, invalide sous Windows (npm y exécute
 * les scripts via cmd.exe, pas un shell POSIX). On lit la variable ici,
 * côté Node, puis on l'interpole nous-mêmes dans la commande.
 *
 * execFileSync(npx.cmd, ...) sans shell échoue avec EINVAL sous Windows
 * (bug connu de Node.js pour spawn direct d'un .cmd) : on utilise execSync
 * (shell activé par défaut) à la place. L'URL vient de .env, pas d'une
 * entrée utilisateur, le risque d'injection shell est négligeable ici.
 */
import 'dotenv/config'
import { execSync } from 'node:child_process'

const url = process.env.DATABASE_URL_MIGRATE
if (!url) {
  throw new Error('DATABASE_URL_MIGRATE non définie (voir .env.example).')
}

execSync(
  `npx kysely-codegen --dialect postgres --url "${url}" --out-file src/db/types.generated.ts`,
  { stdio: 'inherit' },
)
