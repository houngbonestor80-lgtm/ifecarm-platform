-- Exécuté automatiquement par l'image Postgres au tout premier démarrage
-- (en tant que superutilisateur POSTGRES_USER défini dans docker-compose.yml).
-- Ne s'exécute qu'une seule fois : après une modification, il faut recréer le
-- volume (`docker compose down -v`) pour qu'il soit rejoué.
--
-- Deux rôles, jamais un seul, conformément à la revue de sécurité :
--   - ifecarm_migrate : propriétaire des objets, seul rôle utilisé pour les
--     migrations (node-pg-migrate). Le RLS ne s'applique JAMAIS au
--     propriétaire d'une table, quelles que soient les politiques -> ce rôle
--     ne doit donc jamais servir aux requêtes applicatives.
--   - ifecarm_app : rôle de l'application Next.js. NOSUPERUSER, NOBYPASSRLS
--     (valeurs par défaut, répétées ici pour être explicite) : c'est ce qui
--     rend le RLS réellement opposable à ce rôle.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ifecarm_migrate') THEN
    CREATE ROLE ifecarm_migrate WITH LOGIN PASSWORD 'changeme_migrate_dev_only' CREATEDB;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ifecarm_app') THEN
    CREATE ROLE ifecarm_app WITH LOGIN PASSWORD 'changeme_app_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE ifecarm TO ifecarm_migrate;

\connect ifecarm

-- Depuis PostgreSQL 15, CREATE sur le schéma public n'est plus accordé à
-- PUBLIC par défaut : il faut l'accorder explicitement au rôle de migration.
GRANT ALL ON SCHEMA public TO ifecarm_migrate;
GRANT USAGE ON SCHEMA public TO ifecarm_app;

-- Les GRANT table-par-table pour ifecarm_app vivent dans les migrations
-- elles-mêmes (migrations/0001_socle.sql), juste après chaque CREATE TABLE :
-- le socle décrit intégralement les droits de son propre rôle applicatif,
-- pas d'étape manuelle séparée à ne pas oublier.
