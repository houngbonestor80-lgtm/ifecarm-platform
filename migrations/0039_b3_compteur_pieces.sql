-- B3 : plafond de photos par déclaration appliqué même quand l'appelant ne peut pas relire la
-- déclaration (déclaration anonyme) : le compte passe par une fonction qui ne renvoie qu'un nombre,
-- limitée à l'entreprise active.
CREATE OR REPLACE FUNCTION compter_pieces_declaration(p_declaration uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::int FROM piece_jointe_declaration p
  WHERE p.declaration_id = p_declaration
    AND p.entreprise_id = NULLIF(current_setting('app.entreprise_id', true), '')::uuid
$$;
REVOKE EXECUTE ON FUNCTION compter_pieces_declaration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compter_pieces_declaration(uuid) TO ifecarm_app;
