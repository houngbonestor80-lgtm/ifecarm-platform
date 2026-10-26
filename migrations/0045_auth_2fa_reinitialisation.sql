-- =====================================================================
-- Authentification : double authentification (TOTP) et réinitialisation du mot
-- de passe par e-mail (07/10/2026). Décisions de l'utilisateur :
--   2FA        Application d'authentification (TOTP). OBLIGATOIRE pour l'équipe
--              IFECARM (consultant, admin plateforme), l'admin d'entreprise et le
--              responsable QHSE ; facultative pour les autres rôles.
--   SECOURS    10 codes à usage unique remis une seule fois à l'activation ; sinon
--              l'administrateur de la plateforme réinitialise la 2FA d'un compte
--              (tracé au journal).
--   APPAREIL   « Se souvenir de cet appareil » 30 jours, révocable (cookie dédié,
--              seul son hash est en base ; révoqué au changement de mot de passe, à
--              la réinitialisation, à la désactivation et par la réinitialisation 2FA).
--   RESET      Lien à usage unique, valable 60 minutes, seul son hash est en base ;
--              toutes les sessions et tous les appareils de confiance sont révoqués.
--              Il ne désactive JAMAIS la 2FA (l'e-mail ne doit pas devenir la clé de tout).
-- Principe : une session créée après le mot de passe est « partielle » tant que le
-- deuxième facteur n'est pas validé ; validerSession la refuse partout sauf sur les
-- routes 2FA (fail-closed : la session naît partielle, c'est la connexion qui la libère).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Session partielle
-- ---------------------------------------------------------------------
ALTER TABLE session
  ADD COLUMN a2f_requise    boolean NOT NULL DEFAULT false,
  ADD COLUMN a2f_etape      text    CHECK (a2f_etape IS NULL OR a2f_etape IN ('code', 'activation')),
  ADD COLUMN a2f_validee_le timestamptz,
  ADD COLUMN a2f_tentatives integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- 2. Secret TOTP : activation en deux temps, anti-rejeu
-- ---------------------------------------------------------------------
ALTER TABLE utilisateur
  ADD COLUMN totp_secret_en_attente_chiffre text,
  ADD COLUMN totp_dernier_pas               bigint,
  ADD COLUMN totp_active_le                 timestamptz;

-- ---------------------------------------------------------------------
-- 3. Codes de secours, appareils de confiance, limite par adresse IP
-- ---------------------------------------------------------------------
-- Comme session et password_reset_token : pas de RLS (consultées avant tout contexte de tenant), toujours
-- filtrées par l'utilisateur de la session validée. Les codes de secours sont stockés en HMAC (clé serveur).
CREATE TABLE code_secours_2fa (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  code_hash      text        NOT NULL UNIQUE,
  utilise_le     timestamptz,
  cree_le        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_code_secours_utilisateur ON code_secours_2fa(utilisateur_id) WHERE utilise_le IS NULL;

CREATE TABLE appareil_confiance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id       uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  jeton_hash           text        NOT NULL UNIQUE,
  expire_le            timestamptz NOT NULL,
  derniere_utilisation timestamptz,
  user_agent           text,
  adresse_ip           inet,
  revoque_le           timestamptz,
  cree_le              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appareil_confiance_utilisateur ON appareil_confiance(utilisateur_id) WHERE revoque_le IS NULL;

CREATE TABLE demande_reinitialisation_ip (
  id         bigserial PRIMARY KEY,
  adresse_ip inet        NOT NULL,
  cree_le    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_demande_reinit_ip ON demande_reinitialisation_ip(adresse_ip, cree_le DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON code_secours_2fa TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE ON appareil_confiance          TO ifecarm_app;
GRANT SELECT, INSERT         ON demande_reinitialisation_ip TO ifecarm_app;
GRANT USAGE, SELECT ON SEQUENCE demande_reinitialisation_ip_id_seq TO ifecarm_app;

-- ---------------------------------------------------------------------
-- 4. Fonctions sur l'utilisateur COURANT (app.utilisateur_id, posé par withAuthenticatedUser)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION a2f_etat_courant()
RETURNS TABLE (email text, actif boolean, secret_chiffre text, secret_attente_chiffre text, dernier_pas bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.email::text, u.totp_actif, u.totp_secret_chiffre, u.totp_secret_en_attente_chiffre, u.totp_dernier_pas
  FROM utilisateur u WHERE u.id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid AND u.actif
$$;

CREATE OR REPLACE FUNCTION a2f_definir_attente(p_secret text) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE utilisateur SET totp_secret_en_attente_chiffre = p_secret
  WHERE id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid AND actif
$$;

-- Active la 2FA avec le secret en attente (le code a déjà été vérifié par l'application) et mémorise le pas utilisé.
CREATE OR REPLACE FUNCTION a2f_activer(p_pas bigint) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  UPDATE utilisateur
     SET totp_secret_chiffre = totp_secret_en_attente_chiffre, totp_secret_en_attente_chiffre = NULL,
         totp_actif = true, totp_active_le = now(), totp_dernier_pas = p_pas
   WHERE id = v_uid AND actif AND totp_secret_en_attente_chiffre IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune activation en cours.' USING ERRCODE = 'IF409';
  END IF;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id)
  SELECT u.id, u.entreprise_id, 'activation_2fa', 'utilisateur', u.id FROM utilisateur u WHERE u.id = v_uid;
END;
$$;

-- Garde anti-rejeu : un code (un pas de 30 s) ne s'utilise qu'une fois ; vrai si le pas est plus récent que le dernier accepté.
CREATE OR REPLACE FUNCTION a2f_marquer_pas(p_pas bigint) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE utilisateur SET totp_dernier_pas = p_pas
  WHERE id = NULLIF(current_setting('app.utilisateur_id', true), '')::uuid AND actif AND totp_actif
    AND (totp_dernier_pas IS NULL OR totp_dernier_pas < p_pas);
  RETURN FOUND;
END;
$$;

-- Désactivation par l'intéressé (l'application a vérifié mot de passe et code, et que son rôle ne l'impose pas).
CREATE OR REPLACE FUNCTION a2f_desactiver() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
BEGIN
  UPDATE utilisateur SET totp_actif = false, totp_secret_chiffre = NULL, totp_secret_en_attente_chiffre = NULL, totp_dernier_pas = NULL, totp_active_le = NULL
  WHERE id = v_uid AND actif;
  DELETE FROM code_secours_2fa WHERE utilisateur_id = v_uid;
  UPDATE appareil_confiance SET revoque_le = now() WHERE utilisateur_id = v_uid AND revoque_le IS NULL;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id)
  SELECT u.id, u.entreprise_id, 'desactivation_2fa', 'utilisateur', u.id FROM utilisateur u WHERE u.id = v_uid;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Réinitialisation de la 2FA par l'administrateur de la plateforme (compte perdu, téléphone perdu)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reinitialiser_2fa_utilisateur(p_cible uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := NULLIF(current_setting('app.utilisateur_id', true), '')::uuid;
  v_entreprise uuid;
BEGIN
  IF NOT est_admin_plateforme_courant() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur de la plateforme.' USING ERRCODE = 'IF403';
  END IF;
  IF p_cible = v_uid THEN
    RAISE EXCEPTION 'Pour votre propre compte, utilisez « Mon compte ».' USING ERRCODE = 'IF409';
  END IF;
  SELECT entreprise_id INTO v_entreprise FROM utilisateur WHERE id = p_cible;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Compte introuvable.' USING ERRCODE = 'IF404';
  END IF;
  UPDATE utilisateur SET totp_actif = false, totp_secret_chiffre = NULL, totp_secret_en_attente_chiffre = NULL, totp_dernier_pas = NULL, totp_active_le = NULL
  WHERE id = p_cible;
  DELETE FROM code_secours_2fa WHERE utilisateur_id = p_cible;
  UPDATE appareil_confiance SET revoque_le = now() WHERE utilisateur_id = p_cible AND revoque_le IS NULL;
  UPDATE session SET revoque_le = now() WHERE utilisateur_id = p_cible AND revoque_le IS NULL;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id, details)
  VALUES (v_uid, v_entreprise, 'reinitialisation_2fa', 'utilisateur', p_cible, NULL);
END;
$$;

-- ---------------------------------------------------------------------
-- 6. Réinitialisation du mot de passe par e-mail
-- ---------------------------------------------------------------------
-- Limite par adresse IP : 10 demandes par heure (au-delà, la demande est ignorée sans le dire).
CREATE OR REPLACE FUNCTION limite_reinitialisation_ip(p_ip inet) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (SELECT count(*) FROM demande_reinitialisation_ip WHERE adresse_ip = p_ip AND cree_le > now() - interval '1 hour') >= 10 THEN
    RETURN false;
  END IF;
  INSERT INTO demande_reinitialisation_ip (adresse_ip) VALUES (p_ip);
  DELETE FROM demande_reinitialisation_ip WHERE cree_le < now() - interval '1 day';
  RETURN true;
END;
$$;

-- Crée le jeton (déjà haché par l'application) pour un compte actif d'une entreprise active ; au plus 3 par compte et
-- par heure. Renvoie le compte pour que l'application envoie l'e-mail ; AUCUNE ligne si rien n'est créé (compte inconnu,
-- inactif ou limite atteinte) : l'application répond pareil dans tous les cas.
CREATE OR REPLACE FUNCTION demander_reinitialisation(p_email citext, p_jeton_hash text, p_validite_minutes integer)
RETURNS TABLE (utilisateur_id uuid, email text, nom text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_u record;
BEGIN
  SELECT u.id, u.email::text AS email, u.nom INTO v_u
  FROM utilisateur u JOIN entreprise e ON e.id = u.entreprise_id
  WHERE u.email = p_email AND u.actif AND e.desactive_le IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  IF (SELECT count(*) FROM password_reset_token t WHERE t.utilisateur_id = v_u.id AND t.cree_le > now() - interval '1 hour') >= 3 THEN
    RETURN;
  END IF;
  INSERT INTO password_reset_token (utilisateur_id, jeton_hash, expire_le)
  VALUES (v_u.id, p_jeton_hash, now() + make_interval(mins => p_validite_minutes));
  DELETE FROM password_reset_token WHERE cree_le < now() - interval '7 days';
  RETURN QUERY SELECT v_u.id, v_u.email, v_u.nom;
END;
$$;

-- Consomme le jeton ET change le mot de passe dans la même transaction. Révoque toutes les sessions et tous les
-- appareils de confiance, invalide les autres jetons du compte. La 2FA n'est pas touchée.
CREATE OR REPLACE FUNCTION reinitialiser_mot_de_passe(p_jeton_hash text, p_nouveau_hash text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_t record;
BEGIN
  IF p_nouveau_hash IS NULL OR p_nouveau_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'Hash de mot de passe invalide.';
  END IF;
  SELECT t.id, t.utilisateur_id INTO v_t
  FROM password_reset_token t
  JOIN utilisateur u ON u.id = t.utilisateur_id AND u.actif
  JOIN entreprise e ON e.id = u.entreprise_id AND e.desactive_le IS NULL
  WHERE t.jeton_hash = p_jeton_hash AND t.utilise_le IS NULL AND t.expire_le > now()
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lien invalide ou expiré.' USING ERRCODE = 'IF404';
  END IF;
  UPDATE utilisateur SET mot_de_passe_hash = p_nouveau_hash WHERE id = v_t.utilisateur_id;
  UPDATE password_reset_token SET utilise_le = now() WHERE utilisateur_id = v_t.utilisateur_id AND utilise_le IS NULL;
  UPDATE session SET revoque_le = now() WHERE utilisateur_id = v_t.utilisateur_id AND revoque_le IS NULL;
  UPDATE appareil_confiance SET revoque_le = now() WHERE utilisateur_id = v_t.utilisateur_id AND revoque_le IS NULL;
  INSERT INTO journal_audit (utilisateur_id, entreprise_id, action, objet_type, objet_id)
  SELECT u.id, u.entreprise_id, 'reinitialisation_mot_de_passe', 'utilisateur', u.id FROM utilisateur u WHERE u.id = v_t.utilisateur_id;
  RETURN v_t.utilisateur_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION a2f_etat_courant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION a2f_definir_attente(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION a2f_activer(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION a2f_marquer_pas(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION a2f_desactiver() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reinitialiser_2fa_utilisateur(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION limite_reinitialisation_ip(inet) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION demander_reinitialisation(citext, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reinitialiser_mot_de_passe(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION a2f_etat_courant() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION a2f_definir_attente(text) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION a2f_activer(bigint) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION a2f_marquer_pas(bigint) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION a2f_desactiver() TO ifecarm_app;
GRANT EXECUTE ON FUNCTION reinitialiser_2fa_utilisateur(uuid) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION limite_reinitialisation_ip(inet) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION demander_reinitialisation(citext, text, integer) TO ifecarm_app;
GRANT EXECUTE ON FUNCTION reinitialiser_mot_de_passe(text, text) TO ifecarm_app;
