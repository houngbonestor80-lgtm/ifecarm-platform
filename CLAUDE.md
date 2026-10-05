@AGENTS.md

# CLAUDE.md — ifecarm-platform

Plateforme QHSE multi-tenant d'IFECARM GROUP (cabinet de conseil QHSE, Cotonou + Paris).
Développeur : Houngbo Nestor (DCOM). Réponses en français, courtes, code modifié uniquement.

> Le dépôt fait foi. Si ce fichier contredit le code, signale l'écart et mets ce fichier à jour.

## À quoi sert l'outil

Outil de travail interne, pas une vitrine (le site vitrine `ifecarm` est un dépôt séparé).
- Chaque entreprise cliente a son espace cloisonné ; IFECARM a une vue transverse sur tous ses clients.
- Les consultants IFECARM l'utilisent sur le terrain (tablette, connexion parfois limitée) ; les clients et prospects consultent seulement.
- Design : « outil de terrain » avant « tableau de bord d'analyse ». Priorité à la rapidité de saisie et à la lisibilité des états (conforme / non conforme, gravité, statut). Rendu professionnel, car le client le voit.
- Thème sombre, en-tête blanc (`src/app/globals.css`). Rapport PDF volontairement blanc (impression).

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript. Lire `node_modules/next/dist/docs/` avant de coder (voir AGENTS.md).
- PostgreSQL 15+, Row Level Security
- Kysely + migrations SQL brutes dans `migrations/` (dernière : `0027_notes_suivi.sql`), jouées par `npm run migrate`. Types : `npm run codegen`. Pas de Prisma (incompatible avec `SET LOCAL` sur le pool).
- Sessions maison (pas de fournisseur d'auth externe)
- Stockage fichiers S3, SeaweedFS en local (port 9000, bucket `ifecarm-platform-dev`). Région du bucket configurable (non arbitrée : UE ou Afrique de l'Ouest).
- Local via Docker : `npm run db:up` (Postgres + stockage). Tests : `npm test` (vitest, vraie base). Types : `npx tsc --noEmit`.
- PDF : pdf-lib + polices dans `assets/pdf/`. Applications terrain en PWA (pas de natif)

## Structure `src/`

- `auth/` connexion, sessions, contexte, accès consultant · `db/` wrappers tenant, journal, types générés
- `inspections/` service, routes, photos, rapport PDF, tableau de bord, vue d'ensemble, prospect
- `equipements/` · `modeles/` · `acces/` (comptes) · `administration/` · `pays/` · `suivi/` (notes) · `formations/` (catalogue JSON)
- `registre/`, `tableau-bord/`, `storage/` (S3), `ui/` (composants), `app/` (pages et routes API)
- Convention : `service.ts` (logique, reçoit `trx`) + `routes.ts` (Request → Response, testable) ; `src/app/api/**` ne fait que réexporter.

## Modules

| Module | Contenu | État |
|---|---|---|
| Socle | comptes, entreprises, sites, salariés, équipements, rôles, notifications, fichiers, journal d'audit | fait |
| Auth | connexion, sessions, sélecteur d'entreprise, mot de passe changeable (`/mon-compte`) | fait (2FA et réinitialisation par email : non branchés) |
| B1 | autodiagnostic | prévu |
| B2 | formations : sessions, participants, émargement, attestations avec QR code | SQL fait, pas d'écrans |
| B3 | registre de sécurité : déclarations (anonymat possible), hors ligne via IndexedDB | SQL fait, pas d'écrans |
| B4 | habilitations | SQL fait, pas d'écrans |
| B5 | inspections : checklist, photos, non-conformités, plans d'action, rapport PDF, suppression/annulation, intervenants | fait |
| B6 | tableau de bord par entreprise (`/tableau-de-bord`) + Vue d'ensemble commune consultant/admin (`/vue-ensemble`) | fait |
| Équipements | registre des équipements et EPI, échéances de vérification (`/equipements`) | fait |
| Modèles | catalogue IFECARM (admin) + modèles par entreprise (consultant) (`/modeles`) | fait |
| Accès | comptes des personnes du client, mot de passe provisoire (`/acces`) | fait |
| Administration | création de client, modules, accès des consultants (`/administration`) | fait |
| Pays | pays d'intervention, gérés en base (`/pays`) | fait |
| Suivi | notes internes par entreprise, jamais visibles du client (`/suivi`) | fait |

## Règles de sécurité — à ne jamais casser

- **Tout accès base passe par `src/db/tenant.ts`** : `withTenant({ entrepriseId, utilisateurId }, cb)`, `withAuthenticatedUser`, `withPlatformAdmin`, `withoutTenant`. Aucune requête hors de ces wrappers.
- `app.entreprise_id` et `app.utilisateur_id` viennent de la session serveur, jamais de l'URL, d'un en-tête ou du navigateur. Posés par `SET LOCAL` dans la même transaction que la requête.
- Deux rôles : `ifecarm_migrate` (propriétaire) et `ifecarm_app` (NOSUPERUSER, NOBYPASSRLS, propriétaire d'aucune table). Voir `docker/init-roles.sql`.
- Politiques RLS : `NULLIF(current_setting('app.xxx', true), '')::uuid` partout, échappatoire `app.platform_admin`, `USING` + `WITH CHECK`. `ENABLE` sans `FORCE`.
- Vues : toujours `WITH (security_invoker = true)`, sinon elles contournent la RLS.
- Fonctions `SECURITY DEFINER` : toujours `SET search_path = pg_catalog, public`. Exemple : `verifier_attestation(text, inet)`, qui journalise elle-même dans `verification_attestation` (aucun droit direct d'`ifecarm_app` sur cette table — ne pas ajouter de GRANT).
- `withPlatformAdmin` : liste d'opérations en dur, journalisation dans `journal_audit` avant tout effet.
- `journal_audit` immuable (trigger interdit UPDATE/DELETE).
- Tests de cloisonnement exécutés avec `ifecarm_app`, jamais avec le rôle de migration.

## Rôles et droits (décisions de l'utilisateur)

- **Client et prospect : consultation seule**, même rôle. Seule écriture : changer son propre mot de passe.
- **Consultant** : ses mandats (`acces_consultant`), inspections, équipements, comptes d'accès, modèles de l'entreprise, notes de suivi, création de prospect, ajout d'un pays.
- **Admin (`admin_plateforme`)** : accès à tout, en écriture, sans mandat (`entreprise_accessible_admin()`), sauf l'entreprise interne IFECARM GROUP.
- Réservé à l'admin : supprimer un client, catalogue de modèles, créer un client, modules, accès des consultants, convertir prospect → client, renommer/archiver/supprimer un pays.
- Les rôles `consultant_ifecarm` et `admin_plateforme` sont impossibles hors entreprise interne (trigger `0017`).

## Décisions prises

- Écriture sur `acces_consultant` réservée à `platform_admin` (via `/administration`).
- Une attestation hérite toujours de l'entreprise du client, jamais d'IFECARM (FK composite sur `attestation.entreprise_id`).
- Prospects : `entreprise.statut_relation` (pas de second concept de tenant) ; `creer_prospect()` permet à un consultant d'ouvrir une inspection sur site. Plus de délai d'accès (`0024`). Plafond 50 prospects actifs par consultant. Conversion prospect → client gratuite, historique conservé.
- Prospect : service souhaité (inspection, formation, audit, conseil) + formations du catalogue du site (`src/formations/catalogue.json`, copie à régénérer si le catalogue du site change).
- **Suppression définitive autorisée** (revient sur l'ancienne règle « désactivation seule ») : `supprimer_entreprise()` (prospect par consultant en écriture, client par admin, nom à retaper), `purger_inspection_annulee()`. Inspection : suppression directe si non clôturée et sans NC, sinon annulation puis purge.
- `journal_audit` reste immuable ; seule exception (`0015`) : `entreprise_id` / `utilisateur_id` passent à NULL quand l'entité est supprimée.
- Plans d'action B5 : réutiliser `action_corrective`, pas de nouvelle table `plan_action`. Seul le consultant fait avancer leur statut.
- B6 : vues `security_invoker` pour les clients ; fonctions `SECURITY DEFINER` en comptages purs pour IFECARM (`indicateurs_plateforme()`, `resume_plateforme()`, `vue_ensemble_ifecarm()`).
- Notes de suivi : RLS réservée aux consultants/admin, jamais visibles du client.
- Email **globalement unique** ; une personne = une identité, accès aux autres tenants via `acces_consultant`. Recherche à la connexion par fonction `SECURITY DEFINER`.
- Mot de passe provisoire affiché une seule fois à la création d'un compte ; hash argon2id seulement en base.
- Photos d'inspection : passent par le serveur (pas d'URL présignée), magic bytes JPEG/PNG/WebP, 8 Mo et 10 par objet, ré-encodées par canvas côté navigateur.
- B3 : référence séquentielle par entreprise via compteur verrouillé (pas de `max()+1`) ; photos ré-encodées par canvas (EXIF supprimé, orientation appliquée) ; `navigator.storage.persist()` demandé.

## Pièges

- Le serveur `next dev` lancé par Claude s'arrête après ~10 min : l'utilisateur le lance lui-même (`npx next dev -p 3001`).
- `ffmpeg` sans `-nostdin` dans une boucle `while read` avale l'entrée.
- Les tests créent des entreprises de test : `nettoyerFixtures` désactive celles que le journal empêche de supprimer.

## Prochaines étapes

1. Écran de création d'un compte **consultant** (aujourd'hui seulement en base).
2. Écrans de B2, B3, B4 (le SQL existe).
3. 2FA et réinitialisation de mot de passe par email.
4. Relier le catalogue de formations du site à la table `formation` de B2 — chantier séparé.
5. Rien n'est commité ni en ligne : l'utilisateur décide de chaque mise en ligne.

## À trancher (hors technique)

- Région d'hébergement : UE (RGPD) ou Afrique de l'Ouest (latence).
- Notes par formation demandée (évoqué, non précisé).

## Habitudes de travail

- Lire seulement le nécessaire (Grep avant Read), modifier par petits Edit, sorties de commandes filtrées.
- Montrer migrations et tests de cloisonnement avant d'attaquer les écrans.
- En fin de session, mettre à jour ce fichier (état des modules, décisions, prochaines étapes) en restant court.
