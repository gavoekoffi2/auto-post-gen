-- =====================================================================
-- A RECONSTRUCTION of the legacy production schema, for tests only.
--
-- This is NOT a dump of the real production database — nobody with access to
-- this repository has that. It reproduces the facts that are known about it
-- and that broke the migration:
--
--   * the seven tables reported present: audit_log, generation_jobs,
--     media_assets, posts, profiles, social_connections, users;
--   * accounts live in `users`, business data in `profiles`, linked by
--     profiles.user_id — so `profiles` has NO `email` column, which is the
--     exact cause of `FAILED 0001_core_schema.sql: column "email" does not
--     exist`;
--   * child tables are keyed by `user_id`, not `profile_id`;
--   * legacy NOT NULL constraints on those owner columns (the second
--     blocker: the new API never writes them, so the first signup after a
--     migration would fail);
--   * one account with a bcrypt-style password (unreadable by this build)
--     and one with this build's own scrypt format (must be carried over).
--
-- If the real schema turns out to differ, the fix belongs in 0000 and the
-- difference belongs here, so the case stays covered.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text,
  password_salt text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name text,
  sector       text,
  tone         text,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text,
  content       text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  scheduled_for timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE generation_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'image',
  status     text NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_connections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL,
  account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  action     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- --- Data that must survive the migration untouched ---------------------

INSERT INTO users (id, email, password_hash, password_salt) VALUES
  -- bcrypt: this build cannot read it, so it must NOT be copied over.
  ('11111111-1111-1111-1111-111111111111', 'legacy-one@example.test',
   '$2b$10$legacybcrypthashvalue0000000000000000000000000000000000', NULL),
  -- this build's own scrypt format (64-byte hash + hex salt): must be kept,
  -- so the account keeps working without a password reset.
  ('22222222-2222-2222-2222-222222222222', 'Legacy-Two@Example.test',
   repeat('ab', 64), repeat('cd', 16));

INSERT INTO profiles (id, user_id, company_name, sector, tone, description) VALUES
  ('aaaaaaaa-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'Boulangerie Legacy', 'Restauration', 'chaleureux', 'Pains et viennoiseries à Abidjan'),
  ('aaaaaaaa-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   'Coiffure Legacy', 'Beauté', 'direct', 'Salon de coiffure afro');

INSERT INTO posts (id, user_id, title, content, status, scheduled_for) VALUES
  ('bbbbbbbb-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'Ancien post publié', 'Contenu historique à préserver', 'published', now() - interval '3 days'),
  ('bbbbbbbb-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   NULL, 'Post sans titre, programmé', 'pending', now() + interval '2 days');

INSERT INTO media_assets (id, user_id, storage_path, mime_type, size_bytes) VALUES
  ('cccccccc-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111/legacy-affiche.png', 'image/png', 204800);

INSERT INTO generation_jobs (id, user_id, kind, status) VALUES
  ('dddddddd-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'image', 'completed');

INSERT INTO social_connections (id, user_id, platform, account_id) VALUES
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'linkedin', 'urn:li:person:legacy');

INSERT INTO audit_log (user_id, action) VALUES
  ('11111111-1111-1111-1111-111111111111', 'legacy.login'),
  ('22222222-2222-2222-2222-222222222222', 'legacy.post.created');
