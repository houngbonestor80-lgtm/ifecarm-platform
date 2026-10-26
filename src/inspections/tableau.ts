import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { DB } from '@/db/types.generated'

/**
 * Tableau de bord de l'entreprise active (module B6). Les indicateurs
 * viennent des vues v_indicateurs_* (security_invoker : RLS du tenant) ;
 * le filtre entreprise_id explicite n'est qu'une ceinture en plus.
 */
export async function tableauDeBord(trx: Transaction<DB>, entrepriseId: string) {
  const [indicateurs, compteurs, actions, nonConformites, evolution] = await Promise.all([
    sql<{
      inspections_terminees_90j: number, taux_conformite_90j: string | null,
      nc_ouvertes_mineure: number, nc_ouvertes_majeure: number, nc_ouvertes_critique: number,
      actions_en_retard: number, taux_traitement_delais: string | null,
    }>`
      select i.inspections_terminees_90j, i.taux_conformite_90j,
             i.nc_ouvertes_mineure, i.nc_ouvertes_majeure, i.nc_ouvertes_critique,
             a.actions_en_retard, a.taux_traitement_delais
      from v_indicateurs_inspections i
      join v_indicateurs_actions a using (entreprise_id)
      where i.entreprise_id = ${entrepriseId}
    `.execute(trx),
    sql<{ inspections_en_cours: number, actions_ouvertes: number }>`
      select
        (select count(*) from inspection where entreprise_id = ${entrepriseId} and statut in ('brouillon', 'en_cours'))::int as inspections_en_cours,
        (select count(*) from action_corrective where entreprise_id = ${entrepriseId} and statut in ('a_faire', 'en_cours'))::int as actions_ouvertes
    `.execute(trx),
    // Actions ouvertes, les plus urgentes d'abord (retard, puis échéance proche).
    sql<{
      id: string, libelle: string, responsable_nom: string | null, echeance: string | null, statut: string,
      en_retard: boolean, gravite: string | null, inspection_id: string | null, intitule_modele: string | null, declaration_id: string | null, autodiagnostic_id: string | null,
    }>`
      select ac.id, ac.libelle, ac.responsable_nom, to_char(ac.echeance, 'YYYY-MM-DD') as echeance, ac.statut,
             coalesce(ac.echeance < current_date, false) as en_retard,
             nc.gravite, i.id as inspection_id, i.intitule_modele,
             case when ac.origine_type = 'declaration' then ac.origine_id end as declaration_id,
             case when ac.origine_type = 'audit' then ac.origine_id end as autodiagnostic_id
      from action_corrective ac
      left join non_conformite nc on ac.origine_type = 'inspection' and nc.id = ac.origine_id
      left join inspection i on i.id = nc.inspection_id
      where ac.entreprise_id = ${entrepriseId} and ac.statut in ('a_faire', 'en_cours')
        and (i.id is null or i.statut <> 'annulee')
      order by ac.echeance nulls last, ac.cree_le
      limit 8
    `.execute(trx),
    // Non-conformités ouvertes (même définition que la vue), critiques d'abord.
    sql<{
      id: string, gravite: string, description: string, cree_le: string,
      inspection_id: string, intitule_modele: string, a_une_action: boolean,
    }>`
      select nc.id, nc.gravite, nc.description, to_char(nc.cree_le, 'YYYY-MM-DD') as cree_le,
             i.id as inspection_id, i.intitule_modele,
             exists (select 1 from action_corrective ac where ac.origine_type = 'inspection' and ac.origine_id = nc.id
                     and ac.statut in ('a_faire', 'en_cours')) as a_une_action
      from non_conformite nc
      join inspection i on i.id = nc.inspection_id
      where nc.entreprise_id = ${entrepriseId} and i.statut <> 'annulee'
        and not exists (select 1 from action_corrective ac where ac.origine_type = 'inspection' and ac.origine_id = nc.id
                        and ac.statut in ('realisee', 'verifiee'))
      order by case nc.gravite when 'critique' then 0 when 'majeure' then 1 else 2 end, nc.cree_le desc
      limit 8
    `.execute(trx),
    // Taux de conformité par mois de clôture, 6 derniers mois (mois vides inclus).
    sql<{ mois: string, inspections: number, conformes: number, non_conformes: number }>`
      select to_char(m.mois, 'YYYY-MM') as mois,
             count(distinct ins.id)::int as inspections,
             count(it.id) filter (where it.resultat = 'conforme')::int as conformes,
             count(it.id) filter (where it.resultat = 'non_conforme')::int as non_conformes
      from generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m(mois)
      left join inspection ins on ins.entreprise_id = ${entrepriseId} and ins.statut = 'terminee'
        and date_trunc('month', ins.terminee_le) = m.mois
      left join item_inspection it on it.inspection_id = ins.id
      group by m.mois
      order by m.mois
    `.execute(trx),
  ])

  const i = indicateurs.rows[0]
  const taux = (v: string | null | undefined) => (v == null ? null : Number(v))
  return {
    indicateurs: {
      inspectionsEnCours: compteurs.rows[0]?.inspections_en_cours ?? 0,
      inspectionsTerminees90j: i?.inspections_terminees_90j ?? 0,
      tauxConformite90j: taux(i?.taux_conformite_90j),
      ncOuvertes: { critique: i?.nc_ouvertes_critique ?? 0, majeure: i?.nc_ouvertes_majeure ?? 0, mineure: i?.nc_ouvertes_mineure ?? 0 },
      actionsOuvertes: compteurs.rows[0]?.actions_ouvertes ?? 0,
      actionsEnRetard: i?.actions_en_retard ?? 0,
      tauxTraitementDelais: taux(i?.taux_traitement_delais),
    },
    actions: actions.rows,
    nonConformites: nonConformites.rows,
    evolution: evolution.rows.map((m) => ({
      mois: m.mois,
      inspections: m.inspections,
      taux: m.conformes + m.non_conformes ? m.conformes / (m.conformes + m.non_conformes) : null,
    })),
  }
}

/** Vue d'ensemble IFECARM (consultant et administrateur) : périmètre et rôle contrôlés en base (migration 0020). */
export async function vueEnsemble(trx: Transaction<DB>) {
  const { rows } = await sql<{
    entreprise_id: string, nom: string, statut_relation: 'client' | 'prospect',
    inspections_en_cours: number, inspections_terminees_90j: number, taux_conformite_90j: string | null,
    nc_critique: number, nc_majeure: number, nc_mineure: number,
    actions_ouvertes: number, actions_en_retard: number, equipements_en_retard: number,
    comptes_actifs: number, noms_comptes: string | null, services_souhaites: string[], formations_souhaitees: string[], notes_nb: number, derniere_note: string | null, derniere_note_le: Date | null,
  }>`select * from vue_ensemble_ifecarm()`.execute(trx)
  return rows.map((r) => ({ ...r, taux_conformite_90j: r.taux_conformite_90j == null ? null : Number(r.taux_conformite_90j) }))
}
