-- =====================================================================
-- salarie : écriture réservée à l'équipe IFECARM GROUP (05/10/2026), comme les
-- tables de B2 depuis 0029. Client et prospect = consultation seule (décision
-- de l'utilisateur) : 0001 laissait tout utilisateur du tenant créer ou
-- modifier un salarié (fiche nominative : naissance, email, téléphone).
-- Lecture inchangée (le client voit ses propres salariés). L'échappatoire
-- platform_admin de 0001 est conservée. GRANT inchangés (pas de DELETE).
-- =====================================================================

DROP POLICY cloisonnement_salarie ON salarie;

CREATE POLICY lecture_salarie ON salarie FOR SELECT
  USING (
    entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
    OR current_setting('app.platform_admin', true) = 'true'
  );

CREATE POLICY ecriture_salarie ON salarie FOR ALL
  USING (
    (est_consultant_ou_admin_courant()
     AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
    OR current_setting('app.platform_admin', true) = 'true'
  )
  WITH CHECK (
    (est_consultant_ou_admin_courant()
     AND entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid)
    OR current_setting('app.platform_admin', true) = 'true'
  );
