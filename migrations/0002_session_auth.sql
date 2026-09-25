-- =====================================================================
-- Session, mot de passe, 2FA, limitation des tentatives de connexion.
--
-- Ces tables sont volontairement SANS RLS, contrairement à tout le reste du
-- socle — et c'est une exception délibérée, pas un oubli : elles sont
-- interrogées AVANT qu'un contexte tenant (app.entreprise_id) ou même
-- utilisateur (app.utilisateur_id) n'existe. Une connexion commence par
-- chercher une session ou un utilisateur par jeton/e-mail, ce qui précède
-- toute notion de "quelle entreprise". Leur protection vient d'ailleurs :
--   - jeton_hash / jeton de reset : valeur aléatoire 256 bits, hachée avant
--     stockage (SHA-256) — même une fuite de la table ne permet pas de
--     rejouer une session ou un reset.
--   - tentative_connexion : lecture/écriture seules, jamais de donnée
--     personnelle sensible au-delà de l'e-mail déjà connu du visiteur.
-- =====================================================================

-- --- Mot de passe et 2FA sur l'utilisateur existant ---
-- auth_ref (schéma d'origine) supposait un fournisseur d'auth externe ; on
-- gère l'authentification nous-mêmes (cf. revue de sécurité, point 3), donc
-- on ajoute les colonnes nécessaires plutôt que de le réécrire. auth_ref
-- reste en place, inutilisé pour l'instant : possible bascule SSO plus tard
-- sans nouvelle migration destructive.
ALTER TABLE utilisateur
  ADD COLUMN mot_de_passe_hash   text,
  -- Secret TOTP chiffré au repos (AES-256-GCM, cf. src/auth/totp.ts) :
  -- format "iv_base64:tag_base64:ciphertext_base64". Jamais en clair en base.
  ADD COLUMN totp_secret_chiffre text,
  ADD COLUMN totp_actif          boolean NOT NULL DEFAULT false;

-- --- Sessions ---
CREATE TABLE session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id     uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  -- Entreprise "active" de cette session. Un consultant peut la changer
  -- (nouvelle entreprise choisie) sans se reconnecter, cf. src/auth/session.ts.
  entreprise_id      uuid        REFERENCES entreprise(id) ON DELETE SET NULL,
  jeton_hash         text        NOT NULL UNIQUE,
  adresse_ip         inet,
  user_agent         text,
  cree_le            timestamptz NOT NULL DEFAULT now(),
  derniere_activite  timestamptz NOT NULL DEFAULT now(),
  expire_le          timestamptz NOT NULL,
  -- Révocation immédiate (déconnexion, changement de mot de passe,
  -- suspicion) : distinct de expire_le pour pouvoir couper une session
  -- encore valide sans attendre son expiration naturelle.
  revoque_le         timestamptz
);

CREATE INDEX idx_session_utilisateur ON session(utilisateur_id);
CREATE INDEX idx_session_active ON session(expire_le) WHERE revoque_le IS NULL;

-- --- Réinitialisation de mot de passe ---
CREATE TABLE password_reset_token (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  jeton_hash      text        NOT NULL UNIQUE,
  expire_le       timestamptz NOT NULL,
  utilise_le      timestamptz,
  cree_le         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_utilisateur ON password_reset_token(utilisateur_id);

-- --- Limitation des tentatives de connexion (par compte ET par IP) ---
CREATE TABLE tentative_connexion (
  id          bigserial PRIMARY KEY,
  -- L'e-mail peut ne correspondre à aucun compte : on limite quand même,
  -- sinon un attaquant énumère les comptes existants sans jamais être freiné.
  email       citext      NOT NULL,
  adresse_ip  inet        NOT NULL,
  reussie     boolean     NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tentative_email_date ON tentative_connexion(email, cree_le DESC);
CREATE INDEX idx_tentative_ip_date ON tentative_connexion(adresse_ip, cree_le DESC);

-- --- Droits ifecarm_app ---
GRANT SELECT, INSERT, UPDATE ON session                TO ifecarm_app;
GRANT SELECT, INSERT, UPDATE ON password_reset_token    TO ifecarm_app;
GRANT SELECT, INSERT         ON tentative_connexion     TO ifecarm_app;
GRANT USAGE, SELECT ON SEQUENCE tentative_connexion_id_seq TO ifecarm_app;
