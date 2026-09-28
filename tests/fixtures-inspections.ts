import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { hacherMotDePasse } from '@/auth/password'
import type { Fixtures } from './fixtures'

export interface FixturesInspections {
  modeleCatalogue: string
  itemModeleCatalogue1: string
  siteA: string
  siteB: string
  equipementA: string
  inspectionA: string      // terminée il y a peu, sur le site de A
  inspectionA2: string     // brouillon de A (sert aux tests de clés composites)
  inspectionB: string
  itemA1: string           // conforme
  itemA2: string           // conforme
  itemA3: string           // non conforme
  itemA4: string           // non applicable
  itemA2Insp2: string      // item de inspectionA2
  itemB1: string
  ncA: string              // critique, rattachée à itemA3
  ncB: string
  actionA: string          // action d'inspection en retard sur ncA
  consultantSansAcces: string   // consultant IFECARM sans aucun accès
  consultantExpire: string      // accès à A expiré hier
  consultantLecture: string     // accès à A en lecture seule, valide
  suffixe: string
}

/**
 * Prépare le jeu de données B5/B6 avec ifecarm_migrate (propriétaire, sans
 * RLS) — comme fixtures.ts, ces fixtures préparent l'état ; les ASSERTIONS
 * passent par ifecarm_app via withTenant & co.
 */
export async function creerFixturesInspections(base: Fixtures): Promise<FixturesInspections> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  const suffixe = randomUUID().slice(0, 8)
  const q = async <T>(text: string, values: unknown[] = []) => (await client.query<T & { id: string }>(text, values)).rows[0]!

  const modele = await q(
    `INSERT INTO modele_inspection (entreprise_id, slug, intitule, domaine, cible_type)
     VALUES (NULL, $1, 'Modèle catalogue (test)', 'qhse', 'site') RETURNING id`,
    [`catalogue-test-${suffixe}`],
  )
  const itemModele1 = await q(
    `INSERT INTO item_modele_inspection (modele_id, ordre, libelle) VALUES ($1, 1, 'Issues de secours dégagées') RETURNING id`,
    [modele.id],
  )
  await client.query(
    `INSERT INTO item_modele_inspection (modele_id, ordre, libelle, gravite_defaut) VALUES ($1, 2, 'Extincteurs vérifiés', 'majeure')`,
    [modele.id],
  )

  const siteA = await q(`INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site A') RETURNING id`, [base.entrepriseA])
  const siteB = await q(`INSERT INTO site (entreprise_id, nom) VALUES ($1, 'Site B') RETURNING id`, [base.entrepriseB])
  const equipementA = await q(
    `INSERT INTO equipement (entreprise_id, site_id, type, designation) VALUES ($1, $2, 'extincteur', 'Extincteur A') RETURNING id`,
    [base.entrepriseA, siteA.id],
  )

  const nouvelleInspection = (entreprise: string, site: string, statut: string) =>
    q(
      `INSERT INTO inspection (entreprise_id, modele_id, intitule_modele, cible_type, site_id, consultant_id, statut, terminee_le)
       VALUES ($1, $2, 'Modèle catalogue (test)', 'site', $3, $4, $5, CASE WHEN $5 = 'terminee' THEN now() END) RETURNING id`,
      [entreprise, modele.id, site, base.consultantC1, statut],
    )
  const inspectionA = await nouvelleInspection(base.entrepriseA, siteA.id, 'terminee')
  const inspectionA2 = await nouvelleInspection(base.entrepriseA, siteA.id, 'brouillon')
  const inspectionB = await nouvelleInspection(base.entrepriseB, siteB.id, 'terminee')

  const nouvelItem = (entreprise: string, inspection: string, ordre: number, libelle: string, resultat: string | null) =>
    q(
      `INSERT INTO item_inspection (entreprise_id, inspection_id, ordre, libelle, resultat) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [entreprise, inspection, ordre, libelle, resultat],
    )
  const itemA1 = await nouvelItem(base.entrepriseA, inspectionA.id, 1, 'Issues de secours dégagées', 'conforme')
  const itemA2 = await nouvelItem(base.entrepriseA, inspectionA.id, 2, 'Extincteurs vérifiés', 'conforme')
  const itemA3 = await nouvelItem(base.entrepriseA, inspectionA.id, 3, 'Registre à jour', 'non_conforme')
  const itemA4 = await nouvelItem(base.entrepriseA, inspectionA.id, 4, 'Groupe électrogène', 'non_applicable')
  const itemA2Insp2 = await nouvelItem(base.entrepriseA, inspectionA2.id, 1, 'Item du brouillon', null)
  const itemB1 = await nouvelItem(base.entrepriseB, inspectionB.id, 1, 'Issues de secours dégagées', 'non_conforme')

  const ncA = await q(
    `INSERT INTO non_conformite (entreprise_id, inspection_id, item_inspection_id, gravite, description)
     VALUES ($1, $2, $3, 'critique', 'Registre non tenu') RETURNING id`,
    [base.entrepriseA, inspectionA.id, itemA3.id],
  )
  const ncB = await q(
    `INSERT INTO non_conformite (entreprise_id, inspection_id, item_inspection_id, gravite, description)
     VALUES ($1, $2, $3, 'mineure', 'Issue encombrée') RETURNING id`,
    [base.entrepriseB, inspectionB.id, itemB1.id],
  )

  const actionA = await q(
    `INSERT INTO action_corrective (entreprise_id, reference, origine_type, origine_id, libelle, echeance, statut)
     VALUES ($1, $2, 'inspection', $3, 'Mettre à jour le registre', CURRENT_DATE - 1, 'a_faire') RETURNING id`,
    [base.entrepriseA, `ACT-TEST-${suffixe}`, ncA.id],
  )

  // Consultants supplémentaires, rattachés à l'entreprise interne IFECARM.
  const motDePasseHash = await hacherMotDePasse('mot-de-passe-de-test-jamais-utilise')
  const creerConsultant = async (label: string) => {
    const u = await q(
      'INSERT INTO utilisateur (entreprise_id, email, nom, mot_de_passe_hash) VALUES ($1, $2, $3, $4) RETURNING id',
      [base.ifecarmInterne, `${label}-${suffixe}@test.local`, `Consultant ${label}`, motDePasseHash],
    )
    await client.query("INSERT INTO role_utilisateur (utilisateur_id, role) VALUES ($1, 'consultant_ifecarm')", [u.id])
    return u.id
  }
  const consultantSansAcces = await creerConsultant('sans-acces')
  const consultantExpire = await creerConsultant('expire')
  const consultantLecture = await creerConsultant('lecture')
  await client.query(
    'INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le) VALUES ($1, $2, true, CURRENT_DATE - 1)',
    [consultantExpire, base.entrepriseA],
  )
  await client.query(
    'INSERT INTO acces_consultant (utilisateur_id, entreprise_id, ecriture, fin_le) VALUES ($1, $2, false, CURRENT_DATE + 30)',
    [consultantLecture, base.entrepriseA],
  )

  await client.end()

  return {
    modeleCatalogue: modele.id,
    itemModeleCatalogue1: itemModele1.id,
    siteA: siteA.id,
    siteB: siteB.id,
    equipementA: equipementA.id,
    inspectionA: inspectionA.id,
    inspectionA2: inspectionA2.id,
    inspectionB: inspectionB.id,
    itemA1: itemA1.id,
    itemA2: itemA2.id,
    itemA3: itemA3.id,
    itemA4: itemA4.id,
    itemA2Insp2: itemA2Insp2.id,
    itemB1: itemB1.id,
    ncA: ncA.id,
    ncB: ncB.id,
    actionA: actionA.id,
    consultantSansAcces,
    consultantExpire,
    consultantLecture,
    suffixe,
  }
}

/**
 * À appeler APRÈS nettoyerFixtures : les entreprises de test (donc leurs
 * inspections, par cascade) ont déjà disparu, ce qui libère le modèle du
 * catalogue (inspection.modele_id est RESTRICT).
 */
export async function nettoyerFixturesInspections(f: FixturesInspections): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE })
  await client.connect()
  await client.query('DELETE FROM modele_inspection WHERE id = $1', [f.modeleCatalogue])
  await client.query('DELETE FROM utilisateur WHERE id = ANY($1)', [
    [f.consultantSansAcces, f.consultantExpire, f.consultantLecture],
  ])
  await client.end()
}
