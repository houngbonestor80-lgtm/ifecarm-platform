-- =====================================================================
-- Correctif : NULLIF(current_setting(...), '')::uuid partout, au lieu de
-- current_setting(...)::uuid directement.
--
-- Bug constaté à l'exécution des tests de cloisonnement : avec un pool de
-- connexions, une variable de session personnalisée jamais définie DANS LA
-- TRANSACTION COURANTE mais déjà positionnée par une transaction PRÉCÉDENTE
-- sur la MÊME connexion physique réutilisée par le pool revient comme une
-- chaîne VIDE (pas NULL) une fois SET LOCAL sorti de portée — ''::uuid lève
-- une erreur là où NULL::uuid ne lève rien. Sans ce correctif, toute requête
-- sous withAuthenticatedUser/withPlatformAdmin/withoutTenant plantait dès
-- que la connexion physique avait déjà servi une transaction withTenant.
--
-- PostgreSQL n'a pas de CREATE OR REPLACE POLICY : chaque politique est
-- supprimée puis recréée à l'identique de migrations/0001_socle.sql (déjà
-- corrigé là-bas pour les futures installations neuves).
-- =====================================================================

DROP POLICY cloisonnement_entreprise ON entreprise;
CREATE POLICY cloisonnement_entreprise ON entreprise
  USING (
    id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_abonnement_module ON abonnement_module;
CREATE POLICY cloisonnement_abonnement_module ON abonnement_module
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_site ON site;
CREATE POLICY cloisonnement_site ON site
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_utilisateur ON utilisateur;
CREATE POLICY cloisonnement_utilisateur ON utilisateur
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_role_utilisateur ON role_utilisateur;
CREATE POLICY cloisonnement_role_utilisateur ON role_utilisateur
  USING (
    EXISTS (
      SELECT 1 FROM utilisateur u
      WHERE u.id = role_utilisateur.utilisateur_id
        AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    )
    OR utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM utilisateur u
      WHERE u.id = role_utilisateur.utilisateur_id
        AND u.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    )
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_acces_consultant ON acces_consultant;
CREATE POLICY cloisonnement_acces_consultant ON acces_consultant
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR utilisateur_id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_salarie ON salarie;
CREATE POLICY cloisonnement_salarie ON salarie
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_equipement ON equipement;
CREATE POLICY cloisonnement_equipement ON equipement
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_fichier ON fichier;
CREATE POLICY cloisonnement_fichier ON fichier
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_notification ON notification;
CREATE POLICY cloisonnement_notification ON notification
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

DROP POLICY cloisonnement_journal_audit ON journal_audit;
CREATE POLICY cloisonnement_journal_audit ON journal_audit
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );
