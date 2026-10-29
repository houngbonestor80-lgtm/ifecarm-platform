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
- Kysely + migrations SQL brutes dans `migrations/` (dernière : `0053_opportunites_vente.sql`), jouées par `npm run migrate`. Types : `npm run codegen`. Pas de Prisma (incompatible avec `SET LOCAL` sur le pool).
- Sessions maison (pas de fournisseur d'auth externe)
- Stockage fichiers S3, SeaweedFS en local (port 9000, bucket `ifecarm-platform-dev`). En production : Backblaze B2 (compatible S3).
- **Production (mise en ligne fin octobre 2026)** : Vercel (https://ifecarm-platform.vercel.app, projet `ifecarm-platform`, plan Hobby, fonctions en `fra1` Francfort) ; base Neon `ifecarm-platform-eu` (AWS eu-central-1 Francfort, plan gratuit, Postgres 18, connexions directes, base mise en veille si inactive) ; e-mails Brevo ; relances quotidiennes par GitHub Actions (`.github/workflows/relances.yml`, cron 06:00 UTC, secrets `DATABASE_URL_APP` et `DATABASE_URL_MIGRATE`). Dépôt : https://github.com/houngbonestor80-lgtm/ifecarm-platform. Mise en ligne rejouable : `node scripts/mise-en-ligne.mjs` avec `OWNER_URL` (rôle propriétaire, adresse directe) ; il crée les rôles, applique les migrations, importe les catalogues, crée l'admin et écrit `secrets-mise-en-ligne.local` (ignoré par Git). Une base Neon ne change pas de région : en créer une nouvelle et rejouer le script, puis mettre à jour `DATABASE_URL_APP` (Vercel + GitHub) et `DATABASE_URL_MIGRATE` (GitHub), et redéployer.
- Local via Docker : `npm run db:up` (Postgres + stockage). Tests : `npm test` (vitest, vraie base). Types : `npx tsc --noEmit`.
- PDF : pdf-lib + polices dans `assets/pdf/`. Applications terrain en PWA (pas de natif)


## Structure `src/`

- `auth/` connexion, sessions, contexte, accès consultant · `db/` wrappers tenant, journal, types générés
- `inspections/` service, routes, photos, rapport PDF, tableau de bord, vue d'ensemble, prospect
- `equipements/` · `modeles/` · `acces/` (comptes) · `administration/` · `pays/` · `suivi/` (notes) · `formations/` (catalogue JSON)
- `registre/`, `tableau-bord/`, `storage/` (S3), `ui/` (composants), `app/` (pages et routes API)
- `mini-audit/` (mini-audit gratuit public, 0052) · `opportunites/` (relances de vente, 0053) · `ui/whatsapp.ts` (liens wa.me prérédigés)
- Convention : `service.ts` (logique, reçoit `trx`) + `routes.ts` (Request → Response, testable) ; `src/app/api/**` ne fait que réexporter.

## Modules

| Module | Contenu | État |
|---|---|---|
| Socle | comptes, entreprises, sites, salariés, équipements, rôles, notifications, fichiers, journal d'audit | fait |
| Auth | connexion, sessions, sélecteur d'entreprise, mot de passe changeable (`/mon-compte`) | 2FA (TOTP) et mot de passe oublié faits 07/10/2026 (0045 + écrans `/connexion/2fa`, `/mot-de-passe-oublie`, `/reinitialiser`, section « Double authentification » de `/mon-compte`, bouton « Réinitialiser la 2FA » dans `/administration`), à tester en local |
| B1 | autodiagnostic : migration 0047 (+0049), services, routes, écrans, rapport PDF, historique et comparaison, plan d'action depuis les écarts, volet du tableau de bord, éditeur de référentiels admin (`/administration/autodiagnostic`) faits 08/10/2026 ; écrans : `/autodiagnostic` (liste, nouvelle évaluation), `/autodiagnostic/[id]` (conduite sur tablette, résultat) ; 5 référentiels ISO du site IMPORTÉS (`npm run import:autodiagnostic`) ; module activé sur « Entreprise Démo » | fait 08/10/2026, à tester en local |
| B2 | formations : sessions, participants (`/formations`), catalogue admin (`/administration/catalogue`, `npm run import:catalogue`) ; émargement par demi-journée et attestations (PDF + QR, page publique `/verifier/[code]`) faits 06/10/2026, à tester en local ; alertes de recyclage 90/30/7 jours puis échéance (jalon 0) faites 07/10/2026 (`alerter_recyclages()`, 0044 + 0046, lancée par `npm run relances`) | en cours |
| B3 | registre de sécurité (module `incidents` ; incidents/accidents, pas les équipements) : saisie rapide hors ligne (`/registre/nouvelle`, IndexedDB + service worker `public/sw.js`), liste, qualification, analyse des causes, actions, relances (`npm run relances`), historique, photos (`/registre/[id]`), volet du tableau de bord | fait 06/10/2026, à tester en local ; reste : envoi réel des e-mails de relance (fournisseur à choisir) |
| B4 | habilitations : matrice (`/habilitations`), fiche salarié avec titres, historique, renouvellement, justificatif (`/habilitations/salaries/[id]`), catalogue admin (`/administration/habilitations`), volet du tableau de bord, alertes 90/30/7 jours/échéance (`alerter_habilitations()`, lancée par `npm run relances`) ; catalogue IFECARM de 14 types IMPORTÉ le 07/10/2026 (`npm run import:habilitations`, rejouable ; HAUTEUR 12 mois, ECHAF 36, INCENDIE-EPI 12) | fait 07/10/2026, à tester en local |
| B5 | inspections : checklist, photos, non-conformités, plans d'action, rapport PDF, suppression/annulation, intervenants | fait |
| B6 | tableau de bord par entreprise (`/tableau-de-bord`) + Vue d'ensemble commune consultant/admin (`/vue-ensemble`) | fait |
| Équipements | registre des équipements et EPI, échéances de vérification (`/equipements`), photos par équipement (`fichier`, objet_type `equipement`, 10 max, écriture consultant, `/api/equipements/[id]/photos`) reprises en vignettes (4 max) dans le rapport PDF du registre (`/api/equipements/rapport`, bouton « Rapport PDF », 07/10/2026, mise en page non vérifiée à l'œil) | fait |
| Modèles | catalogue IFECARM (admin) + modèles par entreprise (consultant) (`/modeles`) | fait |
| Accès | comptes des personnes du client, mot de passe provisoire (`/acces`) | fait |
| Administration | création de client, modules, accès des consultants (`/administration`) | fait |
| Pays | pays d'intervention, gérés en base (`/pays`) | fait |
| Notes internes | bloc « Notes internes » sur inspection, action, session de formation, équipement, déclaration (`note_objet`, `src/ui/NotesInternes.tsx`), équipe IFECARM seulement | fait 06/10/2026 |
| Suivi | notes internes et demandes de formation (participants, date, note) par entreprise, jamais visibles du client (`/suivi`) | fait |
| Mini-audit | page PUBLIQUE `/mini-audit` (sans compte, indexable) : questionnaire court (`mini-audit-qhse.json`, `public`), coordonnées, résultat immédiat `/mini-audit/[code]` (code de suivi MA-XXXX-XXXX-XXXX), e-mail au prospect + alerte aux admins ; écran équipe `/mini-audits` (WhatsApp/e-mail prérédigés, contacté, sans suite, conversion en prospect) | fait 29/10/2026 (0052), à tester en local |
| Opportunités | `/opportunites` « Clients à relancer » : recyclages B2, habilitations B4, vérifications d'équipements regroupés par entreprise et objet, message WhatsApp prérédigé, suivi (contacté, gagné, perdu, plus tard) ; résumé e-mail du lundi à l'équipe (`npm run relances`) | fait 29/10/2026 (0053), à tester en local |

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
- Réservé à l’admin : supprimer un client, supprimer un compte consultant (`0033`, email à ressaisir), réinitialiser son mot de passe (provisoire affiché une fois ; l’ancien n’est jamais lisible), catalogue de modèles, créer un client, modules, accès des consultants, convertir prospect → client, renommer/archiver/supprimer un pays.
- Les rôles `consultant_ifecarm` et `admin_plateforme` sont impossibles hors entreprise interne (trigger `0017`).

## Décisions prises

- Écriture sur `acces_consultant` réservée à `platform_admin` (via `/administration`).
- Une attestation hérite toujours de l'entreprise du client, jamais d'IFECARM (FK composite sur `attestation.entreprise_id`).
- B4 (0043) : écriture = équipe IFECARM ; lecture = équipe, admin d'entreprise, responsable QHSE, responsable de site (salariés de son site) ; aucun autre utilisateur du client ; aucune échappatoire platform_admin sur `habilitation` ni sur ses fichiers (justificatif suit la visibilité de l'habilitation). Une ligne = un titre ; renouveler = nouvelle ligne + ancien titre `remplacee` dans la même transaction (contrôlé à la validation) ; `retiree` et `remplacee` définitifs ; salarié/type/création figés ; état (valide/à renouveler/expirée) CALCULÉ, jamais stocké. Attestation B2 liée facultativement (même salarié, valide), validité reprise à la saisie. Catalogue géré par l'admin (`gerer_catalogue_habilitation`).
- B4 écrans : le responsable de site ne voit dans la matrice que les salariés de SON site (la liste des salariés est lisible de tout le tenant par la RLS de `salarie`, donc filtrée côté service). Le volet du tableau de bord (`/api/habilitations/resume`) est réservé aux responsables d'entreprise et à l'équipe.
- Relances d'actions en retard (`0041`) : fonction SQL idempotente `relancer_actions_en_retard()` (jalons J-7, échéance, J+7, J+30 ; le jalon le plus avancé seulement), lancée chaque jour par `npm run relances` (Planificateur de tâches / cron) ; met les e-mails en file (`notification`, en_attente) — AUCUN envoi tant que le fournisseur d'e-mail n'est pas choisi. Notes internes sur les objets (`0042`, table `note_objet`) : équipe IFECARM seulement, jamais le client ; immuables ; suppression par l'auteur ou l'admin.
- Annuler une attestation = la supprimer définitivement (`0034`, DELETE accordé ; remplace « l'attestation reste en base ») : elle disparaît, son QR n'est plus vérifiable, le participant redevient éligible ; trace du motif dans `journal_audit` seulement.
- B3 (0035) : le client DÉCLARE seulement (exception à « consultation seule », limitée à l'insertion) ; qualification, analyse, actions, vérification, commentaires = équipe IFECARM. Lecture par rôle : IFECARM, responsable_qhse, admin_entreprise voient tout ; un déclarant ne lit que ses déclarations non anonymes (même l'auteur d'une anonyme ne la relit pas). Faits figés dès la qualification ; anonymat/référence/déclarant jamais modifiables ; cloturee et sans_suite définitifs ; historique des statuts écrit par déclencheur ; qualifieur posé par le serveur. Actions d'origine déclaration invisibles du déclarant ; actions d'inspection (B5) restent visibles du client. Responsable de site (`0037`, `0040`) : lit les déclarations, analyses et actions d'origine déclaration NON anonymes de son site (pas l'historique ni les relances). Photos de déclaration (`0038`) : `fichier` suit la visibilité de la déclaration, `televerse_par` NULL, pas de journal. Piège : `INSERT ... ON CONFLICT` et `RETURNING` exigent le droit de LIRE la ligne insérée (rejeu hors ligne via `chercher_declaration_par_cle`).
- Prospects : `entreprise.statut_relation` (pas de second concept de tenant) ; `creer_prospect()` permet à un consultant d'ouvrir une inspection sur site. Plus de délai d'accès (`0024`). Plafond 50 prospects actifs par consultant. Conversion prospect → client gratuite, historique conservé.
- Prospect : service souhaité (inspection, formation, audit, conseil) + formations du catalogue du site (`src/formations/catalogue.json`).
- Catalogue du site (08/10/2026, option B) : `npm run catalogue:synchroniser` compare la copie à `../ifecarm/app/data/formations.light.json` (ou `SITE_VITRINE_DIR`), `-- --ecrire` la met à jour, `-- --ecrire --importer` met aussi à jour la table `formation`. Seuls titre, durée et famille (français) sont repris ; rien n'est supprimé en base. Le site n'a pas de base pour son catalogue (fichiers de code). Option C (le site publie un JSON) possible plus tard ; option D (objectifs, programme) non faite.
- **Suppression définitive autorisée** (revient sur l'ancienne règle « désactivation seule ») : `supprimer_entreprise()` (prospect par consultant en écriture, client par admin, nom à retaper), `purger_inspection_annulee()`. Inspection : suppression directe si non clôturée et sans NC, sinon annulation puis purge.
- `journal_audit` reste immuable ; seule exception (`0015`) : `entreprise_id` / `utilisateur_id` passent à NULL quand l'entité est supprimée.
- Plans d'action B5 : réutiliser `action_corrective`, pas de nouvelle table `plan_action`. Seul le consultant fait avancer leur statut.
- B6 : vues `security_invoker` pour les clients ; fonctions `SECURITY DEFINER` en comptages purs pour IFECARM (`indicateurs_plateforme()`, `resume_plateforme()`, `vue_ensemble_ifecarm()`).
- Notes de suivi : RLS réservée aux consultants/admin, jamais visibles du client.
- Durées et horaires décidés par le consultant/admin (05/10/2026) : inspection = jour + heure de début/fin (`0030`) ; session de formation = heures de début/fin et `duree_heures` propres à la session ; la durée du catalogue du site n’est qu’indicative (`formation.duree_jours` facultative, texte du site dans `duree_libelle`). B2 : RLS d’écriture réservée à l’équipe IFECARM (`0029`).
- Email **globalement unique** ; une personne = une identité, accès aux autres tenants via `acces_consultant`. Recherche à la connexion par fonction `SECURITY DEFINER`.
- Mot de passe provisoire affiché une seule fois à la création d'un compte ; hash argon2id seulement en base.
- PDF (rapport d'inspection, attestation) : charte graphique IFECARM v1.0 (`Téléchargements/IFECARM_Charte_Graphique_Complete.pdf`, §2.2, §3, §4 p. 16). Poppins seule (Montserrat interdite pour titres et textes longs), noir #1A1A1A, un seul vert, pas de slogan ajouté ; rapport = couverture LOGO-01 (`assets/pdf/logo-prestige.png`) + en-tête technique `INS-AAAA-xxxxxxxx · Page n / N` + pied légal en page 1 seulement ; attestation = « Certificat de formation » reprenant les proportions du modèle p. 16 (fond ivoire, cadre à coins arrondis, logo horizontal centré, Montserrat Regular pour titre, libellés et pied, Poppins pour le corps), code de vérification à la place du N° séquentiel.
- Photos d'inspection : passent par le serveur (pas d'URL présignée), magic bytes JPEG/PNG/WebP, 8 Mo et 10 par objet, ré-encodées par canvas côté navigateur.
- B3 : référence séquentielle par entreprise via compteur verrouillé (pas de `max()+1`) ; photos ré-encodées par canvas (EXIF supprimé, orientation appliquée) ; `navigator.storage.persist()` demandé.

- 2FA (0045) : obligatoire pour consultant, admin_plateforme, admin_entreprise, responsable_qhse ; facultative pour les autres. La session naît PARTIELLE (`a2f_requise`) et n'est libérée que par la saisie du code ; `validerSession` refuse les sessions partielles, `validerSessionPartielle` sert aux routes 2FA. Secret TOTP chiffré AES-256-GCM (`TOTP_ENCRYPTION_KEY`, 32 octets base64), anti-rejeu par `totp_dernier_pas`, 10 codes de secours hachés en HMAC, appareil de confiance 30 jours (cookie `ifecarm_appareil`, hash en base, révocable), 5 échecs = session révoquée. Réinitialisation de la 2FA par l'admin seulement (`reinitialiser_2fa_utilisateur`, journalisée, jamais pour soi-même). Mot de passe oublié : réponse toujours identique, lien 60 min à usage unique (hash en base), 3/h par compte et 10/h par IP ; révoque sessions et appareils, ne touche pas à la 2FA.
- B1 (0047) : le consultant conduit l'évaluation, le client (admin d'entreprise, responsable QHSE) lit les TERMINÉES seulement ; aucun autre rôle du client. Catalogue `referentiel_autodiagnostic` lu par l'équipe, écrit par l'admin (`gerer_catalogue_autodiagnostic`), `definition` jsonb validée en base. Évaluation = questionnaire COPIÉ à la création (déclencheur), résultat calculé EN BASE par `terminer_autodiagnostic()` (même formule que le site, comparée dans les tests), toutes les questions répondues, terminée = définitive, suppression d'une terminée = admin seulement et jamais si des actions en dépendent. Actions issues des écarts : `action_corrective` origine `audit` + lien `autodiagnostic_action` ; vue `v_autodiagnostic_dernier` (dernier score et précédent) pour le tableau de bord. Module `autodiagnostic` ajouté à `abonnement_module`.
- Principe (décision de l'utilisateur 08/10/2026) : le consultant et l'admin ne sont JAMAIS limités aux listes par défaut ; partout où l'on choisit dans une liste, il doit pouvoir écrire sa propre valeur. Déjà fait : site (`ChoixSite`), checklist d'inspection libre, points ajoutés en cours d'inspection, formation hors catalogue, type d'habilitation écrit, équipement (type en saisie libre), participants non connus. Audit complet fait le 26/10/2026 (0051) : s'ajoutent équipement écrit à l'inspection, « autre service » et formation hors catalogue d'un prospect (`entreprise.service_autre`, `demande_formation.intitule`, slug `libre-…`, planifiable avec une formation sur mesure). Pas faits, à décider : autodiagnostic libre pour le consultant, création de site depuis une déclaration. À vérifier à chaque nouvel écran. Restent volontairement fermés (échelles métier) : gravité, nature de mesure, type de déclaration, rôles.
- Checklist libre (0048) : `inspection.modele_id` facultatif ; points écrits par l'inspecteur = `item_inspection.personnalise` ; ajout / reformulation / suppression seulement tant que l'inspection est ouverte (déclencheur), jamais pour un point issu d'un modèle (figé, « non applicable » existe) ni portant une non-conformité ; 200 points max ; option « garder comme modèle de l'entreprise » (`creerModele`). Les fixtures de test créent les inspections ouvertes puis les clôturent.
- B1 écrans : `src/autodiagnostic/` (service, routes, rapport PDF, VoletAutodiagnostic, classes). Le client (admin d'entreprise, responsable QHSE) lit les évaluations terminées, leur PDF et leurs actions ; le consultant conduit, termine, crée les actions (`changerStatutAction` accepte maintenant les origines `inspection` ET `audit`) ; l'admin gère les référentiels, supprime une évaluation terminée. `nombre_evaluations_autodiagnostic()` (0049) : l'admin ne voit pas les évaluations des clients (RLS), seulement leur nombre. Prospects (0050, 08/10/2026) : `creer_prospect()` active aussi `autodiagnostic`, le déclencheur `verifier_modules_prospect()` l'accepte (les autres modules de client restent interdits à un prospect), les prospects existants ont reçu le module ; l'évaluation suit la conversion en client. Pas encore : notes internes sur une évaluation.
- Site écrit librement (07/10/2026) : liste des sites OU « Autre site (saisir son nom) » (`src/ui/ChoixSite.tsx`, `resoudreSite()` dans `inspections/service.ts`, nom déjà connu = site réutilisé) dans équipements, nouveau salarié (habilitations) et inspections ; registre de sécurité : « Autre site » à écrire dans « Lieu précis » (le client ne crée pas de site, RLS).
- PWA (07/10/2026) : plateforme installable (`src/app/manifest.ts`, icônes `public/icons/`, start_url `/`). `public/sw.js` (v3) : statiques en cache d'abord, `/registre*` réseau d'abord, toute autre page = réseau seulement, sinon `/hors-ligne.html` (statique, sans donnée) ; JAMAIS d'`/api/*` en cache, aucun cache de données de B2/B4/tableau de bord. Enregistré pour tous par `src/ui/ServiceWorker.tsx` (production seulement) ; nouvelle version = bandeau « Actualiser » (pas de skipWaiting automatique). Décisions de l'utilisateur : hors ligne = saisie B3 seulement ; pas de lecture de données hors ligne. Contexte gardé sur l'appareil (localStorage `ifecarm.contexte` + cache IndexedDB sites/salariés) limité à 12 h comme la session (`DUREE_CONTEXTE_MS`) ; la boîte d'envoi des déclarations n'expire pas.
- Mini-audit (0052) : le public n'a aucun droit direct sur `mini_audit` (fonctions SECURITY DEFINER `questionnaires_mini_audit`, `soumettre_mini_audit`, `lire_mini_audit`) ; score calculé en base (`calculer_resultat_autodiagnostic`, même formule que B1) ; 5 envois par heure et par IP, 3 par jour et par e-mail ; champ piège `siteWeb` ; consentement obligatoire. Lecture des demandes : toute l'équipe IFECARM (consultants et admins, pas de mandat requis). Conversion = `creer_prospect` (plafond, modules, accès) + coordonnées + service « audit » ; converti et sans suite définitifs. Un référentiel est proposé au public si `referentiel_autodiagnostic.public` (import : clé `public` du JSON). Le site vitrine n'y renvoie pas encore (lien à ajouter dans le dépôt `ifecarm`).
- Opportunités (0053) : calculées à la volée (`opportunites_pour`, interne), mêmes critères que les alertes 0043/0044 ; fenêtre = horizon (7 à 365 j, 90 par défaut) + échues depuis 180 j ; consultant = mandats en cours, admin = tous ; seul le suivi est stocké (`suivi_opportunite`, couvre jusqu'à la dernière échéance connue, une échéance plus lointaine rouvre l'opportunité). WhatsApp par lien wa.me (envoi manuel, pas d'API Meta) ; indicatif selon le pays, 0 initial retiré pour la France seulement.
- Fournisseur d'e-mail : Brevo (décision 07/10/2026), relais SMTP `smtp-relay.brevo.com:587` STARTTLS exigé quand `SMTP_USER` est défini ; identifiants saisis en production (variables `SMTP_*` sur Vercel) ; l'expéditeur validé dans Brevo reste l'ancienne adresse de Nestor : valider `ifecarmgroup@gmail.com` si on veut envoyer depuis elle. Jalons de recyclage B2 alignés sur B3/B4 : 90, 30, 7, échéance.
- E-mail : SMTP générique (`src/notifications/email.ts`, variables `SMTP_*`, `APP_URL`), Mailpit en local (`npm run db:up`, interface sur le port 8025) ; fournisseur de production à choisir. `npm run relances` met en file puis ENVOIE la file (`file.ts`, rôle de migration) si `SMTP_HOST` est défini.

## Pièges

- Local rapide : la machine n'a que ~1 Go de RAM libre ; `next dev` met 20-50 s par page. Utiliser le build de production : `npx next build` puis `npx next start -p 3005` (3001 est pris par un autre site). Après une modification : rebuild + redémarrage.
- Tests : les comptes à 2FA obligatoire ont une session partielle ; les tests hors 2FA appellent `libererA2f(jeton)` (`tests/aide-a2f.ts`, directement en base). `tsc` manque de mémoire sur cette machine : `NODE_OPTIONS=--max-old-space-size=3072`.
- Hors ligne (B3) : tester sur un BUILD de production (`npx next build` puis `npx next start -p 3002`), pas sur `next dev` (son client de développement empêche l'hydratation sans réseau). `public/sw.js` : statiques en cache d'abord, pages en réseau d'abord, jamais d'`/api/*` en cache. Boîte d'envoi IndexedDB liée au compte (`moi`), vidée de son cache de contexte à la déconnexion.

- `ffmpeg` sans `-nostdin` dans une boucle `while read` avale l'entrée.
- Les tests créent des entreprises de test : `nettoyerFixtures` désactive celles que le journal empêche de supprimer (~20 par exécution complète). `npm run nettoyer:tests` (`-- --dry-run` pour un essai) les supprime avec leurs comptes de test (`@test.local`) ; ne touche ni les entreprises actives ni les comptes `@demo.ifecarm.local`.

## Prochaines étapes

1. (fait 05/10/2026, à tester en local) Écran de création d’un compte consultant dans `/administration`, demandes de formation par prospect (`/prospects/nouveau` et `/suivi`).
2. B2, B3, B4 : faits (catalogue B4 importé), à tester en local.
3. Tester en bloc en local (2FA, mot de passe oublié, B2, B3, B4, rapport équipements, photos d'équipement, PWA sur téléphone en HTTPS).
4. Catalogue du site : synchronisation faite (option B) ; à relancer quand le site change.
5. Guide d'utilisation rédigé le 08/10/2026 : `docs/guide-utilisation.md` (un guide, par profil, en français). PDF aux couleurs de la charte : `npm run guide:pdf` régénère `docs/guide-utilisation.pdf` depuis le Markdown (sommaire et pagination calculés). À relire contre les écrans après les tests de l'utilisateur ; à mettre à jour quand un écran change.
6. En ligne depuis fin octobre 2026 (voir Stack). L'utilisateur décide de chaque mise en ligne ; `scripts/mise-en-ligne.mjs` n'est pas encore commité.
7. Compte administrateur de production : `ifecarmgroup@gmail.com` (nom « Ifecarm Group »), changé par UPDATE direct en base le 29/10/2026 (aucun écran de changement d'e-mail ; ce changement n'a pas de trace dans `journal_audit`). 2FA active. À faire : tester en bloc en production (2FA, mot de passe oublié, B2, B3, B4, photos, PWA en HTTPS) et valider l'expéditeur Brevo.
8. Catalogue d'habilitations : durées de départ HAUTEUR 12 mois, ECHAF 36, INCENDIE-EPI 12 (hypothèses de Nestor, modifiables par l'admin dans `/administration/habilitations`) ; déjà importé en production par `mise-en-ligne.mjs`.
9. Mini-audit et opportunités (29/10/2026, branche `feat/mini-audit-et-relances`) : le build Vercel ne joue pas les migrations ; au déploiement, appliquer 0052-0053 et `npm run import:autodiagnostic` sur Neon (avec `DATABASE_URL_MIGRATE`), puis ajouter le lien « Mini-audit gratuit » sur le site vitrine.

## À trancher (hors technique)

- (tranché 05/10/2026 : région UE, France, Scaleway ou OVH ; déclarer le transfert côté Bénin si exigé ; client à hébergement local = cas particulier.)
- (tranché 05/10/2026 : table `demande_formation`, 0028, interne.)

## Habitudes de travail
- Ne jamais commiter, pousser ni déployer sans ordre explicite de l'utilisateur, à ce moment précis. Tout travail reste local tant qu'il n'a pas dit « pousse-le ».
- Lire seulement le nécessaire (Grep avant Read), modifier par petits Edit, sorties de commandes filtrées.
- Montrer migrations et tests de cloisonnement avant d'attaquer les écrans.
- En fin de session, mettre à jour ce fichier (état des modules, décisions, prochaines étapes) en restant court.
