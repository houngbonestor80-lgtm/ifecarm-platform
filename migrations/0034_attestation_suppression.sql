-- =====================================================================
-- Annulation définitive d'une attestation (06/10/2026) : l'attestation
-- annulée DISPARAÎT (ligne supprimée), au lieu de rester avec le statut
-- « annulee ». Décision de l'utilisateur ; elle remplace la règle de 0004
-- (« jamais de DELETE sur attestation »).
-- - DELETE accordé à ifecarm_app ; la politique ecriture_attestation (0029,
--   FOR ALL) le limite déjà à l'équipe IFECARM de l'entreprise active : un
--   client ne peut pas supprimer.
-- - alerte_recyclage disparaît avec elle (ON DELETE CASCADE, exécuté par le
--   propriétaire de la table : aucun droit supplémentaire nécessaire).
-- - Le code de vérification cesse d'exister : la page publique répond
--   « aucune attestation ne correspond ».
-- - Trace conservée : le service écrit une ligne dans journal_audit (immuable)
--   AVANT la suppression, avec le motif — sans nom ni code.
-- - Le participant redevient éligible à une nouvelle attestation.
-- =====================================================================

GRANT DELETE ON attestation TO ifecarm_app;
