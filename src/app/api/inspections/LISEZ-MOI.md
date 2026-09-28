# ⚠️ Routes d'inspection : à lire AVANT d'ajouter un fichier ici

Il n'y a pas encore de route dans ce dossier. Quand elles arriveront (et pour
toute route ou Server Action qui touche à une entreprise cliente ou prospect),
la règle suivante n'est pas optionnelle :

> **Toute route qui touche aux inspections DOIT appeler
> `exigerAccesConsultant` (`src/auth/acces.ts`) AVANT `withTenant`, quand
> l'appelant est un consultant IFECARM.**

## Pourquoi

La RLS ne connaît que `app.entreprise_id`, que le code serveur pose lui-même.
Elle ne sait rien d'une date de fin de mandat, d'un accès en lecture seule ou
d'une entreprise désactivée. Sans cet appel, un consultant dont le mandat est
terminé (ou qui n'a jamais eu d'accès à cette entreprise) obtient tout de même
ses données dès que la route lui fait passer `withTenant(entrepriseId, …)`.

Ce n'est pas hypothétique : une fonction de contrôle correcte mais jamais
appelée en production ne protège personne — même classe de bug que la signature
de `withTenant` qu'on avait manqué de câbler partout.

## Ce que le contrôle vérifie (voir `tests/acces.test.ts`)

- un accès existe pour ce consultant et cette entreprise ;
- sa date de fin n'est pas dépassée ;
- l'entreprise n'est pas désactivée (`entreprise.desactive_le`) ;
- si la route écrit : l'accès est en écriture (`ecriture = true`).

## Modèle d'appel

```ts
// 1. Qui est l'appelant ? (session validée → utilisateurId)
// 2. Consultant IFECARM → contrôler l'accès AVANT d'entrer dans le tenant :
await withAuthenticatedUser(utilisateurId, (trx) =>
  exigerAccesConsultant(trx, { utilisateurId, entrepriseId, ecriture: true }),
)
// 3. Seulement ensuite :
await withTenant({ entrepriseId, utilisateurId }, async (trx) => {
  await exigerModuleActif(trx, { entrepriseId, module: 'inspections' })
  // …
})
```

Un utilisateur d'une entreprise cliente entre dans SA propre entreprise (celle
de sa session) : pas de `acces_consultant` pour lui.
