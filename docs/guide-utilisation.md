# Plateforme QHSE IFECARM GROUP — Guide d'utilisation

Version du 29/10/2026. Ce guide décrit ce que fait la plateforme, écran par écran, pour chaque personne qui l'utilise.
Repérez votre profil dans le chapitre 1, lisez le chapitre 2 (connexion, commun à tous), puis le chapitre de votre profil.

---

## Sommaire

1. [À qui s'adresse quoi](#1-à-qui-sadresse-quoi)
2. [Se connecter, protéger son compte, installer l'application](#2-se-connecter-protéger-son-compte-installer-lapplication)
3. [Vous êtes une personne du client](#3-vous-êtes-une-personne-du-client)
4. [Vous êtes déclarant ou responsable de site](#4-vous-êtes-déclarant-ou-responsable-de-site)
5. [Vous êtes consultant IFECARM GROUP](#5-vous-êtes-consultant-ifecarm-group)
6. [Vous êtes administrateur](#6-vous-êtes-administrateur)
7. [Les e-mails et alertes automatiques](#7-les-e-mails-et-alertes-automatiques)
8. [Travailler sans réseau](#8-travailler-sans-réseau)
9. [Règles à connaître](#9-règles-à-connaître)
10. [Questions fréquentes](#10-questions-fréquentes)

---

## 1. À qui s'adresse quoi

La plateforme est un outil de travail : chaque entreprise cliente a son espace, cloisonné. Personne ne voit les données d'une autre entreprise. IFECARM GROUP voit l'ensemble de ses clients.

| Profil | Ce que vous faites | Ce que vous ne faites pas |
|---|---|---|
| **Administrateur d'entreprise / responsable QHSE** (client) | Consulter tout votre espace : tableau de bord, inspections, équipements, formations, habilitations, incidents, autodiagnostic ; télécharger les rapports ; déclarer un incident | Modifier les données (c'est le travail de votre consultant) |
| **Responsable de site** (client) | Consulter les déclarations non anonymes et les salariés de **votre** site ; déclarer un incident | Voir les autres sites |
| **Déclarant** (client) | Déclarer un incident ; relire vos déclarations non anonymes | Voir les déclarations des autres |
| **Consultant IFECARM GROUP** | Conduire les inspections, tenir les registres, planifier les formations, saisir les habilitations, mener les autodiagnostics, créer les comptes du client | Agir sur une entreprise dont vous n'avez pas le mandat ; réservé à l'administrateur : voir le chapitre 6 |
| **Administrateur de la plateforme** | Tout, y compris créer les clients, activer les modules, donner les mandats, gérer les catalogues | Intervenir dans l'entreprise interne IFECARM GROUP |
| **Prospect** | Même rôle qu'un client : consultation seule | |
| **Visiteur** (sans compte) | Faire le mini-audit gratuit sur la page publique et recevoir son résultat (voir 5.13) | Voir quoi que ce soit d'autre |

Un **prospect** est une entreprise pas encore cliente chez qui un consultant réalise une première inspection ou un premier autodiagnostic ; ces évaluations sont conservées quand il devient client.

**Les modules** (Inspections, Formations, Incidents, Habilitations, Autodiagnostic, Tableau de bord) sont activés entreprise par entreprise. Vous ne voyez dans le menu que ceux qui sont actifs pour votre entreprise.

---

## 2. Se connecter, protéger son compte, installer l'application

### 2.1 Première connexion

1. Ouvrez l'adresse de la plateforme et entrez votre adresse e-mail et le **mot de passe provisoire** remis par votre consultant (il ne vous a été montré qu'une seule fois).
2. Si votre rôle l'impose, la plateforme vous demande d'activer la double authentification (voir 2.2).
3. Changez ensuite votre mot de passe dans **Mon compte** (10 caractères minimum). Vos autres sessions sont alors fermées.

Votre session dure **12 heures**, puis il faut se reconnecter.

### 2.2 La double authentification (2FA)

Un code à 6 chiffres, généré par une application sur votre téléphone, s'ajoute à votre mot de passe.

- **Obligatoire** pour : consultants, administrateurs de la plateforme, administrateurs d'entreprise, responsables QHSE.
- **Facultative** pour les autres (activable dans Mon compte).

**Activer :**
1. Installez une application d'authentification (Google Authenticator, Microsoft Authenticator, Authy, FreeOTP…).
2. Sur l'écran « Activer la double authentification », cliquez **Commencer l'activation**.
3. Scannez le QR code (ou saisissez la clé indiquée si vous ne pouvez pas scanner).
4. Saisissez le code à 6 chiffres affiché par l'application, puis **Activer**.
5. **Conservez vos 10 codes de secours** : copiez-les ou téléchargez-les, puis cochez la case. Ils ne seront plus affichés. Chacun ne sert qu'une fois.

**À chaque connexion :** après le mot de passe, saisissez le code de l'application. Vous pouvez cocher « Ne plus demander sur cet appareil pendant 30 jours ».

**Téléphone perdu :** utilisez un code de secours (« Utiliser un code de secours »). S'il ne vous en reste plus, contactez l'administration IFECARM GROUP : elle peut réinitialiser votre double authentification, que vous réactiverez à la connexion suivante.

**À savoir :** après 5 codes faux, la connexion est annulée et il faut recommencer.

### 2.3 Mot de passe oublié

Sur la page de connexion, cliquez **Mot de passe oublié ?**, saisissez votre adresse e-mail. Vous recevez un lien, valable **60 minutes** et utilisable **une seule fois**. La réponse de la plateforme est toujours la même, que l'adresse existe ou non. Après le changement, vos sessions ouvertes sont fermées ; la double authentification reste active.

### 2.4 Mon compte

Le lien est dans l'en-tête. Vous y trouvez :
- **Changer mon mot de passe** (l'actuel, puis le nouveau deux fois).
- **Double authentification** : voir l'état, activer (si facultative), obtenir de **nouveaux codes de secours** (il faut saisir un code de l'application), **retirer mes appareils de confiance**, désactiver (impossible si elle est obligatoire pour votre rôle).

### 2.5 Installer l'application

La plateforme s'installe comme une application, sur ordinateur (icône « Installer » dans la barre d'adresse de Chrome ou Edge) et sur téléphone (« Ajouter à l'écran d'accueil »). Sur téléphone, cela suppose une adresse sécurisée (https). L'application installée s'ouvre sur l'accueil et vous propose d'**actualiser** quand une nouvelle version est disponible, sans interrompre ce que vous faites.

L'installation ne stocke aucune donnée de votre entreprise pour une lecture hors ligne. Seule la saisie d'une déclaration d'incident fonctionne sans réseau (chapitre 8).

---

## 3. Vous êtes une personne du client

Vous **consultez** votre espace. Vos données sont tenues à jour par votre consultant IFECARM GROUP.

### 3.1 Tableau de bord
Premier écran du menu. Il résume l'état de votre entreprise :
- inspections en cours, actions ouvertes ;
- taux de conformité des 90 derniers jours ;
- actions en retard et non-conformités ouvertes, avec un lien vers chaque élément ;
- selon vos modules : un volet **Incidents**, un volet **Habilitations** (titres valides, à renouveler, expirés, prochaines échéances) et un volet **Autodiagnostic** (dernier score par norme et évolution).

### 3.2 Inspections
**Inspections** liste les visites de sites et contrôles d'équipements (filtres par statut, historique).
- Ouvrez une inspection pour lire la **checklist** (chaque point : conforme, non conforme ou non applicable, avec commentaire et photos), les **non-conformités** (gravité mineure, majeure ou critique) et leurs **plans d'action** (action, responsable, échéance, statut).
- Le bouton **Rapport PDF** produit le rapport de l'inspection, à l'état du jour.

### 3.3 Équipements et EPI
Le registre de vos extincteurs, appareils de levage, EPI, etc. Chaque ligne montre le type, le numéro de série, le site, la personne ou le service concerné, la dernière et la prochaine vérification.
- **Rouge** : vérification en retard. **Orange** : à vérifier sous 30 jours. **Vert** : à jour. **Gris** : sans échéance.
- Les filtres Tous, En retard, Sous 30 jours, EPI, Retirés aident à trier.
- **Rapport PDF** : synthèse, points à traiter, registre complet (équipements puis EPI) avec les photos.

### 3.4 Formations
**Formations** liste les sessions (planifiée, confirmée, réalisée, annulée). Une session montre les dates, les horaires, le formateur, les participants, les présences par demi-journée et les **attestations** émises (PDF avec QR code). Toute personne peut vérifier une attestation en scannant son QR code : la page publique indique si elle est valide.

### 3.5 Incidents
**Incidents** liste les déclarations. Selon votre rôle, vous voyez :
- **Administrateur d'entreprise et responsable QHSE** : toutes les déclarations ;
- **Responsable de site** : celles, non anonymes, de son site ;
- **Déclarant** : les siennes, non anonymes.

Ouvrez une déclaration pour suivre sa qualification, l'analyse des causes, les actions et l'historique. Le bouton **Déclarer** (chapitre 4) est ouvert à tous.

### 3.6 Habilitations
La **matrice** montre, pour chaque salarié et chaque type d'habilitation, l'état du titre : **vert** valide, **orange** à renouveler (échéance dans 90 jours ou moins), **rouge** expiré, **bleu** suspendu. Ouvrez la fiche d'un salarié pour voir ses titres, l'historique et les justificatifs. Les filtres permettent de ne garder que « ceux qui demandent une action ».

### 3.7 Autodiagnostic
**Autodiagnostic** (administrateur d'entreprise et responsable QHSE) liste les évaluations **terminées** : score global, niveau de maturité et écart avec l'évaluation précédente. Ouvrez-en une pour voir les scores par thème, les points d'amélioration classés par priorité, les actions engagées et le détail des réponses. **Rapport PDF** pour le conserver. Une évaluation en cours n'apparaît pas encore.

---

## 4. Vous êtes déclarant ou responsable de site

### 4.1 Déclarer un incident

Menu **Incidents → Déclarer**. Une minute suffit.

1. **Que s'est-il passé ?** Choisissez le type :
   - Accident avec arrêt (blessure avec arrêt de travail) ;
   - Accident sans arrêt (blessure, soins, pas d'arrêt) ;
   - Presqu'accident (ça aurait pu mal tourner) ;
   - Situation dangereuse (un danger à corriger) ;
   - Incident matériel (panne, casse, dégât) ;
   - Incident environnemental (fuite, rejet, pollution).
2. **Quand ?** Date et heure.
3. **Site** : choisissez-le dans la liste ; s'il n'y figure pas, choisissez « Autre site » et écrivez-le dans **Lieu précis** (atelier, quai…).
4. **Service**, puis **Description** : ce qui s'est passé, comment, avec quoi.
5. Si une personne est concernée : cochez « Une personne est concernée (victime) », indiquez le salarié (ou saisissez son nom : intérimaire, sous-traitant, visiteur) et l'éventuel arrêt de travail.
6. **Photos** (facultatives).
7. Envoyez. Une **référence** s'affiche : conservez-la.

**Déclaration anonyme :** le bouton « Déclarer anonymement » enregistre la déclaration sans vous relier à elle. **Vous ne pourrez pas la relire**, mais le responsable la traitera.

### 4.2 Sans réseau
Une déclaration saisie sans réseau est gardée sur votre appareil et s'envoie toute seule au retour du réseau. Voir le chapitre 8.

### 4.3 Suivre vos déclarations
Dans **Incidents**, vous retrouvez vos déclarations non anonymes avec leur statut : À qualifier, En analyse, Actions en cours, Clôturée ou Sans suite. Vous pouvez ajouter un **commentaire** pour toute précision.

---

## 5. Vous êtes consultant IFECARM GROUP

Vous écrivez dans les entreprises dont vous avez le **mandat** (lecture seule ou écriture, avec ou sans date de fin). Sans accès en écriture, vous consultez seulement.

### 5.1 Choisir l'entreprise
Après la connexion et la double authentification, **Choisir une entreprise** liste vos clients et prospects. Votre choix s'applique à tous les écrans ; pour en changer, revenez à ce choix. Pas de mandat ? Contactez l'administration, ou créez un prospect.

### 5.2 Créer un prospect
**Nouveau prospect** : raison sociale, pays (s'il manque, ajoutez-le dans « Pays d'intervention »), secteur, **service souhaité** (inspection, formation, audit, conseil) et les formations du catalogue qui l'intéressent. Vous gardez l'accès en écriture à ce prospect, sans date de fin (l'administrateur peut le retirer). Un consultant ne peut pas avoir plus de 50 prospects actifs.

### 5.3 Inspections

**Démarrer.** **Nouvelle inspection**, puis deux façons de partir :
- **À partir d'un modèle** : sa checklist est copiée dans l'inspection (voir 5.4 pour les modèles).
- **Ma propre checklist** : écrivez un intitulé, choisissez ce qui est inspecté (un site ou un équipement) et saisissez vos points. **Entrée** passe au point suivant ; vous pouvez coller une liste (un point par ligne). Cochez « Garder cette checklist comme modèle de l'entreprise » pour la réutiliser.

Puis choisissez le site (de la liste, ou **Nouveau site**) ou l'équipement, la date, les heures de début et de fin (facultatives) et les intervenants (inspecteur, représentant du client ; votre nom est proposé par défaut).

**Conduire.** Pour chaque point : **Conforme**, **Non conforme** ou **Non applicable**, un commentaire, des photos (10 au plus par point, réduites automatiquement avant l'envoi). Sur tablette, les boutons sont grands pour la saisie rapide.

**Ajouter vos propres points.** En bas de la checklist, « Ajouter votre propre point de contrôle… » complète la liste, même pour une inspection issue d'un modèle. Un point que vous avez ajouté peut être **reformulé** ou **supprimé** (sauf s'il porte une non-conformité). Les points venant d'un modèle sont figés : écartez-les avec « Non applicable ».

**Non-conformités.** « Signaler une non-conformité » sur un point, ou « Non-conformité générale ». Indiquez la **gravité** (mineure, majeure, critique) et le constat, avec photos. Ajoutez ensuite un **plan d'action** : action à mener, responsable, échéance. Seul le consultant fait avancer le **statut** d'une action : À faire, En cours, Réalisée, Vérifiée (efficace), Abandonnée.

**Clôturer.** L'inspection clôturée ne se modifie plus (points, résultats, intervenants). Les plans d'action, eux, continuent d'évoluer. Le **Rapport PDF** peut être produit à tout moment, à l'état du jour.

**Supprimer ou annuler.** Une inspection non clôturée et sans non-conformité se supprime directement. Sinon, on l'annule (elle disparaît des listes et reste conservée), puis on peut la supprimer définitivement.

### 5.4 Modèles d'inspection
**Modèles** liste les checklists : celles du **catalogue IFECARM GROUP** (gérées par l'administrateur) et celles de **l'entreprise** (que vous créez). Un modèle a un intitulé, un domaine (saisie libre), une cible (site ou équipement) et une liste de points avec une gravité par défaut. Modifier un modèle ne change jamais les inspections déjà réalisées. Un modèle déjà utilisé s'archive plutôt que de se supprimer.

### 5.5 Équipements et EPI
**Ajouter** un équipement : type (saisie libre : EPI, extincteur…), désignation, numéro de série, personne ou service concerné, site (de la liste, ou « Autre site » pour en écrire un nouveau), date de mise en service, périodicité de vérification (en mois), dernière et prochaine vérification. Si vous ne donnez pas la prochaine vérification, elle se calcule à partir de la dernière et de la périodicité.
- **Vérifié aujourd'hui** enregistre la vérification et reprogramme la suivante.
- **Photos** : jusqu'à 10 par équipement (les 4 premières figurent dans le rapport PDF).
- **Retirer du service** garde l'équipement dans l'historique ; **Supprimer** n'est possible que s'il n'a jamais été inspecté.
- **Rapport PDF** du registre pour le client.

### 5.6 Formations

**Planifier une session.** **Nouvelle session**, puis :
1. Choisissez la **formation** en la cherchant dans le catalogue (SST, CACES, incendie…). Si elle n'y figure pas : « Ma formation n'est pas dans le catalogue : l'écrire moi-même » (intitulé, domaine, validité en mois). Elle devient une formation propre à l'entreprise.
2. Si le client avait fait une **demande de formation** (onglet Suivi), vous pouvez la planifier : participants, date et note sont repris.
3. Premier et dernier jour, heures de début et de fin (chaque jour), **durée totale en heures** (décidée par vous : la durée du catalogue n'est qu'indicative), lieu, formateur, nombre de places.

**Participants.** Cochez des salariés déjà connus, ou saisissez de nouveaux salariés (un par ligne). Pour chaque participant : présence et résultat.

**Émargement.** Présence par **demi-journée**. Tant que l'émargement n'est pas fait, l'attestation n'est pas possible.

**Attestations.** « Émettre les attestations » produit, pour les participants éligibles, un certificat PDF avec un code de vérification et un QR code. **Annuler** une attestation la supprime définitivement : son QR n'est plus vérifiable et le participant redevient éligible. Quand la formation a une durée de validité, l'échéance se calcule et alimente les alertes de recyclage (chapitre 7).

### 5.7 Incidents (registre de sécurité)
Vous traitez les déclarations de l'entreprise.

1. **Qualifier** : donnez la **gravité** (1 Légère à 4 Très grave) et la **fréquence** (1 Rare à 4 Très fréquente) ; la criticité en découle. Les faits sont ensuite figés : toute précision passe par un commentaire (vous pouvez corriger les faits tant que la déclaration n'est pas qualifiée).
2. **Étape suivante** : À qualifier → En analyse → Actions en cours → Clôturée, ou **Sans suite** (motif obligatoire). La clôture est définitive, et impossible tant qu'une action reste ouverte.
3. **Analyse des causes** : choisissez une méthode et décrivez les causes ; enregistrez l'analyse.
4. **Actions** : nature (de la plus efficace à la moins efficace : supprimer le danger, remplacer par moins dangereux, protection collective, protection individuelle, organisation, formation, consigne), responsable, échéance. Faites-les avancer : **Démarrer**, **Marquer réalisée**, puis **Vérifiée : efficace** ou **Vérifiée : inefficace**, ou **Abandonner**.
5. **Historique** et **commentaires** gardent la trace de tout.

Les photos de la déclaration, et le fait qu'elle ait été saisie hors ligne, restent visibles.

### 5.8 Habilitations
**Ajouter un salarié** (nom, prénom, poste, service, matricule, site), puis ouvrez sa fiche.
- **Ajouter une habilitation** : choisissez le type dans la liste, ou « Autre type (l'écrire moi-même) » (intitulé, domaine, référentiel, validité habituelle). Précisez niveau ou mention (B2V, catégorie 3…), référence du titre, organisme, date de délivrance. La **date de validité** se calcule seule (échéance d'une attestation liée, sinon date de délivrance + durée habituelle du type) ; vous pouvez la fixer ou la déclarer « sans échéance ».
- **Justificatif** : joignez le document.
- **Renouveler** : crée un nouveau titre et marque l'ancien « Remplacé ». **Corriger** : modifie les faits d'un titre en cours. **Suspendre** / **Réactiver** / **Retirer** demandent un motif. **Supprimer** retire une saisie erronée.
- Une attestation de formation (chapitre 5.6) peut être liée à un titre.

### 5.9 Autodiagnostic
**Autodiagnostic → Nouvelle évaluation.**
1. Choisissez le **référentiel** (ISO 9001, 14001, 45001, 22000, 50001, ou ceux ajoutés par l'administrateur).
2. Indiquez le **site** (de la liste ou nouveau), l'**interlocuteur** du client, la date.
3. **Répondez** question par question avec les boutons de l'échelle (par exemple : Oui, en place et documenté / Partiellement / Non / Je ne sais pas). Chaque réponse est enregistrée aussitôt. Ajoutez une **remarque** si utile. Appuyer de nouveau sur la réponse choisie l'efface.
4. Quand **toutes** les questions ont une réponse, **Terminer l'évaluation**. Le résultat est calculé : il ne pourra plus être modifié.
5. **Résultat** : score global, niveau de maturité et message, scores par thème, comparaison avec l'évaluation précédente du même référentiel, et **points d'amélioration prioritaires**.
6. **Plan d'action** : cochez des écarts, indiquez un responsable et une échéance, puis **Créer les actions**. Une seule action par question. Elles apparaissent dans le tableau de bord ; changez leur statut depuis l'évaluation.
7. **Rapport PDF** pour le client.

Une évaluation en cours peut être supprimée ; une évaluation terminée ne peut l'être que par l'administrateur, et jamais si des actions en dépendent.

### 5.10 Suivi interne et notes
**Suivi** est réservé à l'équipe IFECARM GROUP. Vous y notez comment l'entreprise se comporte (relances, intérêts, réactivité), ce qu'elle souhaite (services, formations) et ses **demandes de formation** à planifier. **Ces notes ne sont jamais visibles du client.**

Des blocs **Notes internes** existent aussi sur les inspections, les actions, les sessions de formation, les équipements et les déclarations : équipe IFECARM GROUP seulement, jamais le client. Une note ne se modifie pas ; son auteur ou l'administrateur peut la supprimer.

### 5.11 Comptes d'accès du client
**Accès** (consultant avec accès en écriture) crée les comptes des personnes du client : **Nouveau compte** (nom, prénom, adresse e-mail, rôle). Un **mot de passe provisoire** s'affiche **une seule fois** : copiez les identifiants et transmettez-les par un canal sûr (en main propre, par téléphone), puis cliquez « C'est transmis ». Vous pouvez ensuite générer un **nouveau mot de passe** (l'ancien cesse de fonctionner et les sessions sont fermées), **désactiver** ou **réactiver** un compte.

### 5.12 Vous n'êtes jamais limité aux listes par défaut
Partout où l'on choisit dans une liste, vous pouvez écrire votre propre valeur : site, checklist d'inspection, points ajoutés en cours d'inspection, formation hors catalogue, type d'habilitation, type d'équipement, participants non connus. Seules les échelles de métier (gravité, nature des mesures, types de déclaration, rôles) sont fixes.

### 5.13 Mini-audit gratuit : les demandes
Le **mini-audit gratuit** sert à trouver de nouveaux clients. Il est ouvert à tous, **sans compte**, sur la page publique `/mini-audit` : à vous de communiquer ce lien (site, WhatsApp, LinkedIn).

**Ce que fait le visiteur.** Il choisit le questionnaire (« Mini-audit QHSE gratuit » : 5 thèmes, 15 questions, environ 5 minutes), répond à toutes les questions, puis laisse ses coordonnées : nom et prénom, entreprise, e-mail professionnel, pays, et facultativement fonction, téléphone ou WhatsApp, secteur et effectif. Il doit cocher son accord pour être recontacté. Il voit aussitôt son **score sur 100**, son niveau et ses priorités, avec un **code de suivi** (`MA-XXXX-XXXX-XXXX`) qui rouvre son résultat. Il reçoit aussi son résultat par e-mail. Le diagnostic est **indicatif** : il le précise, il ne remplace pas un audit sur site.

**Ce que vous voyez.** Chaque demande arrive dans **Mini-audits** (menu de l'équipe, page « Demandes du mini-audit gratuit »), réservée aux consultants et aux administrateurs. **Les administrateurs reçoivent aussi un e-mail** à chaque nouvelle demande (entreprise, pays, score, contact). Les demandes sont classées : **À traiter**, **Convertis**, **Sans suite**, **Toutes**.

Pour chaque demande, vous voyez l'entreprise, le contact, le score et le statut, avec :
- **WhatsApp** : ouvre une conversation avec un message de rappel déjà écrit (absent si le numéro manque ou est inexploitable). Un clic passe la demande de **Nouveau** à **Contacté**.
- **Marquer contacté** : sans passer par WhatsApp (appel, e-mail).
- **Convertir en prospect** : crée le prospect, avec le nom de l'entreprise, et vous y emmène. L'entreprise suit les règles habituelles des prospects (voir 5.2 : plafond de 50 prospects actifs par consultant).
- **Sans suite** : classe la demande. C'est définitif, comme « Converti ».

**Règles à connaître.** Un visiteur ne peut envoyer que 5 demandes par heure depuis la même connexion et 3 par jour avec la même adresse e-mail. Ses réponses et coordonnées ne sont jamais visibles d'un client. Seul le questionnaire marqué « public » est proposé : il est installé à la mise en ligne ; il n'y a pas encore d'écran pour en changer.

### 5.14 Clients à relancer
La plateforme connaît déjà les échéances de vos clients. **À relancer** (menu de l'équipe, page « Clients à relancer ») les regroupe **par entreprise et par sujet** pour vous aider à proposer la bonne prestation au bon moment, par exemple : « 8 salariés : recyclage SST à partir du 12/12 ».

Trois sortes d'échéances y figurent :
- **Recyclages de formation** : attestations valides qui arrivent à échéance (la plus récente de chaque salarié présent) ;
- **Habilitations** actives à renouveler ;
- **Vérifications d'équipements** à faire.

Vous voyez les clients de vos mandats ; l'administrateur voit tous les clients. La fenêtre par défaut est de **90 jours** (au choix : 30, 60, 90, 180 ou 365 jours), et les échéances **dépassées depuis moins de 180 jours** y restent. Un badge indique « dans N jours » ou le nombre d'échéances **échues** ; le contact est le responsable du client (administrateur d'entreprise ou responsable QHSE).

Pour chaque ligne :
- **WhatsApp** : un message est déjà rédigé (le sujet, le nombre de salariés ou d'équipements, la date). Vous le **relisez et l'envoyez vous-même** : rien ne part tout seul. Un bouton **e-mail** ouvre le même texte dans votre messagerie. Le premier clic sur WhatsApp marque la ligne **Contacté**.
- **Marquer contacté**, **Gagné** (avec une note : montant, date de session), **Plus tard**, **Perdu** (avec la raison). Votre nom, la date et la note restent affichés.
- Si une échéance plus lointaine apparaît ensuite pour le même sujet, la ligne se **rouvre** automatiquement.

Les onglets sont : **À relancer**, **Contactés**, **Traités** (gagné, perdu, plus tard) et **Toutes**.

Chaque **lundi**, vous recevez un **e-mail récapitulatif** des opportunités à relancer (au plus un par semaine, seulement s'il y en a). Ces informations sont réservées à l'équipe IFECARM GROUP : **jamais visibles d'un client**.

---

## 6. Vous êtes administrateur

En plus de tout ce que fait un consultant (sans mandat nécessaire, sauf pour l'entreprise interne IFECARM GROUP) :

### 6.1 Clients et modules (page Administration)
- **Créer un client** : nom, pays, secteur, modules à activer.
- **Activer ou désactiver un module** par entreprise (Inspections, Tableau de bord, Formations, Incidents, Habilitations, Autodiagnostic). Un prospect a Inspections, Tableau de bord et Autodiagnostic (les autres modules sont réservés aux clients).
- **Convertir un prospect en client** (gratuit, l'historique est conservé).
- **Supprimer un client** : définitif, il faut retaper son nom.

### 6.2 Consultants
- **Créer un compte consultant** et lui donner des **mandats** : entreprise, lecture ou écriture, date de fin facultative.
- **Nouveau mot de passe** : un mot de passe provisoire s'affiche une fois, l'ancien n'est jamais lisible, le consultant est déconnecté.
- **Réinitialiser la 2FA** d'un compte consultant (perte de téléphone et de codes de secours) : ses codes de secours et appareils de confiance sont supprimés, il est déconnecté, il réactive la double authentification à la connexion suivante. Vous ne pouvez pas réinitialiser la vôtre.
- **Supprimer un compte consultant** : définitif, il faut retaper son adresse e-mail ; ses inspections et notes restent, sans lien vers lui.

### 6.3 Catalogues
- **Catalogue de formations** (`Administration → Catalogue`) : fiches proposées à tous les clients, durée de validité de la certification (qui déclenche les alertes de recyclage), activation. La durée du catalogue est indicative. Pour suivre les évolutions du site vitrine, voir la note ci-dessous.
- **Catalogue d'habilitations** (`Administration → Catalogue d'habilitations`) : types, domaines, durées de validité habituelles ; un type désactivé n'est plus proposé mais les titres existants restent.
- **Référentiels d'autodiagnostic** (`Administration → Référentiels d'autodiagnostic`) : créez, modifiez, dupliquez, désactivez ou supprimez un questionnaire (thèmes, questions, poids de 1 à 10, échelle de réponses, niveaux de maturité). Modifier un référentiel ne change jamais les évaluations déjà commencées. Un référentiel déjà utilisé se désactive plutôt que de se supprimer.
- **Modèles d'inspection du catalogue** : dans **Modèles**.
- **Pays d'intervention** : ajout par les consultants ; renommer, archiver ou supprimer est réservé à l'administrateur.

### 6.4 Supprimer une évaluation d'autodiagnostic terminée
Réservé à l'administrateur, impossible si des actions en dépendent.

> **Note technique (équipe IFECARM GROUP).** Les fiches du catalogue de formations viennent du site vitrine. Pour répercuter un changement du site : `npm run formations:light` côté site, puis `npm run catalogue:synchroniser` (comparaison), puis `npm run catalogue:synchroniser -- --ecrire --importer` côté plateforme. La durée de validité et l'activation ne sont jamais écrasées.

---

## 7. Les e-mails et alertes automatiques

Une tâche quotidienne prépare les messages ; ils partent par e-mail à l'adresse des destinataires indiqués. Seuls les messages du mini-audit partent immédiatement, à l'envoi de la demande.

| Alerte | Quand | Qui la reçoit |
|---|---|---|
| **Actions en retard** (inspections, incidents, autodiagnostic) | 7 jours avant l'échéance, le jour de l'échéance, 7 jours puis 30 jours après | Le responsable de l'action (s'il a un compte), l'administrateur d'entreprise et le responsable QHSE |
| **Recyclage d'une attestation de formation** | 90, 30 et 7 jours avant l'échéance, puis le jour de l'échéance | Administrateur d'entreprise, responsable QHSE, responsable du site du salarié |
| **Habilitation à renouveler** | 90, 30 et 7 jours avant l'échéance, puis le jour de l'échéance | Administrateur d'entreprise, responsable QHSE, responsable du site du salarié |
| **Résultat du mini-audit** | Dès que le visiteur a envoyé sa demande | Le visiteur |
| **Nouvelle demande de mini-audit** | Dès qu'une demande arrive | Les administrateurs de la plateforme |
| **Clients à relancer** (récapitulatif) | Le lundi, au plus une fois par semaine, s'il y a des opportunités | Chaque membre de l'équipe IFECARM GROUP concerné |
| **Mot de passe oublié** | À votre demande | Vous |

Pour chaque alerte, le message correspond au jalon le plus avancé atteint (pas de rafale si la tâche n'a pas tourné pendant un mois), et un même jalon n'est jamais envoyé deux fois. Les messages ne contiennent pas de détails sensibles.

---

## 8. Travailler sans réseau

Seule la **déclaration d'un incident** fonctionne sans réseau.

1. Ouvrez **Incidents → Déclarer** quand vous avez du réseau au moins une fois (la page et la liste des sites et salariés se préparent).
2. Sans réseau, saisissez normalement : la déclaration, ses photos et sa référence sont gardées **sur votre appareil**.
3. Au retour du réseau, l'envoi est automatique. Une déclaration refusée (droits, module) est signalée avec son motif.
4. Les données préparées (sites, salariés, nom de l'entreprise) restent **12 heures** sur l'appareil, comme une session, puis sont effacées.
5. En cas de déconnexion, la plateforme vous prévient s'il reste des déclarations non envoyées, qui partiront à votre prochaine connexion avec le même compte.

Les autres écrans demandent le réseau. Sans réseau, ils affichent une page « Pas de connexion » avec un lien vers la déclaration d'incident.

---

## 9. Règles à connaître

**Ce qui est définitif**
- Une **inspection clôturée** ne se modifie plus ; une inspection **supprimée définitivement** disparaît.
- Une **déclaration clôturée** ou **sans suite** est définitive ; ses faits sont figés dès la qualification.
- Une **évaluation d'autodiagnostic terminée** est définitive (le résultat est calculé par la plateforme).
- **Annuler une attestation** la supprime définitivement.
- Un titre d'habilitation **retiré** ou **remplacé** ne revient pas.

**Ce que le client ne voit jamais**
- Les notes internes et le suivi.
- Les déclarations anonymes (même leur auteur ne peut pas les relire) ; les déclarations non anonymes d'un autre déclarant.
- Les évaluations d'autodiagnostic en cours.
- Pour les habilitations : seuls les responsables (administrateur d'entreprise, responsable QHSE, responsable de site pour son site) voient les titres.

**Sécurité**
- Les mots de passe provisoires s'affichent une seule fois ; seuls leurs empreintes chiffrées sont conservées.
- Chaque entreprise est cloisonnée par la base de données elle-même, pas seulement par l'interface.
- Les actions sensibles de l'administrateur sont journalisées, et ce journal ne peut ni être modifié ni être effacé.

---

## 10. Questions fréquentes

**Je ne vois pas un module dans le menu.**
Il n'est pas activé pour votre entreprise. Demandez à votre consultant ou à l'administration IFECARM GROUP.

**Je ne peux pas modifier une donnée.**
Le client consulte seulement ; l'écriture est réservée à l'équipe IFECARM GROUP. Un consultant sans accès en écriture sur l'entreprise consulte aussi seulement.

**Je n'ai plus mon téléphone, je ne peux pas me connecter.**
Utilisez un code de secours. Sinon, contactez l'administration IFECARM GROUP pour réinitialiser la double authentification.

**J'ai oublié mon mot de passe et je ne reçois pas l'e-mail.**
Vérifiez vos courriers indésirables, et que l'adresse saisie est bien celle de votre compte. Les liens expirent au bout de 60 minutes. Après 3 demandes en une heure, attendez avant d'en refaire une.

**Ma déclaration d'incident anonyme a disparu de ma liste.**
C'est voulu : une déclaration anonyme n'est pas reliée à son auteur, qui ne peut donc pas la relire. Le responsable la traite.

**Mon rapport PDF affiche un état différent de celui d'hier.**
Les rapports sont produits à l'état du jour : les plans d'action continuent d'évoluer après la clôture d'une inspection.

**Une formation que je cherche n'est pas dans le catalogue.**
Écrivez-la vous-même au moment de planifier la session (consultant). Elle devient une formation propre à l'entreprise.

**Un équipement affiche « sans échéance ».**
Aucune périodicité ni date de prochaine vérification n'a été renseignée. Demandez à votre consultant de la compléter.

**L'application me propose « Actualiser ».**
Une nouvelle version est disponible. Terminez ce que vous faites, puis cliquez sur Actualiser.
