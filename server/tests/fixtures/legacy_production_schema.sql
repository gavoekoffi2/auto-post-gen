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
--   * child tables are keyed by `user_id`, not `profile_id` — EXCEPT
--     generation_jobs, which production already keys by profile_id;
--   * legacy NOT NULL constraints on those owner columns (the second
--     blocker: the new API never writes them, so the first signup after a
--     migration would fail);
--   * the exact CHECK constraint production carries on posts.status —
--       CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
--     — which knows none of the statuses this build writes ('pending',
--     'validated', 'publishing'). This is the third blocker, found by the
--     rehearsal on a copy of the real database;
--   * generation_jobs EXACTLY as production defines it, confirmed column by
--     column on the restored copy — notably `provider text NOT NULL`. The
--     fourth blocker: the write probe inserted a job without a provider,
--     which the API itself never does (it always writes 'graphiste');
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
  status        text NOT NULL DEFAULT 'draft',
  scheduled_for timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Production's own vocabulary. The new engine writes 'pending',
  -- 'validated' and 'publishing', none of which this constraint allows.
  CONSTRAINT posts_status_check
    CHECK (status IN ('draft', 'scheduled', 'published', 'failed'))
);

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- generation_jobs: the REAL production definition, confirmed column by
-- column by the rehearsal on a restored copy. Unlike the other child tables it
-- is already keyed by profile_id, and it requires a provider: the fourth
-- blocker was the write probe inserting a job without one.
CREATE TABLE generation_jobs (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id    uuid NOT NULL,
  provider      text NOT NULL,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'queued',
  input         jsonb NOT NULL DEFAULT '{}',
  output        jsonb NULL,
  error_message text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz NULL
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

-- One row per legacy status, so nothing may quietly invalidate them.
INSERT INTO posts (id, user_id, title, content, status, scheduled_for) VALUES
  ('bbbbbbbb-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'Ancien post publié', 'Contenu historique à préserver', 'published', now() - interval '3 days'),
  ('bbbbbbbb-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   NULL, 'Post sans titre, programmé', 'scheduled', now() + interval '2 days'),
  ('bbbbbbbb-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'Brouillon', 'Brouillon jamais envoyé', 'draft', NULL),
  ('bbbbbbbb-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222',
   'Échec', 'Publication qui avait échoué', 'failed', now() - interval '1 day');

INSERT INTO media_assets (id, user_id, storage_path, mime_type, size_bytes) VALUES
  ('cccccccc-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111/legacy-affiche.png', 'image/png', 204800);

-- Two historical jobs in production's own vocabulary (a finished one and one
-- still queued), which the migration must keep exactly as they are.
INSERT INTO generation_jobs (id, profile_id, provider, kind, status, input, output, finished_at) VALUES
  ('dddddddd-1111-1111-1111-111111111111', 'aaaaaaaa-1111-1111-1111-111111111111', 'graphiste', 'image',
   'completed', '{"prompt": "affiche historique"}', '{"url": "https://example.invalid/affiche.png"}', now()),
  ('dddddddd-2222-2222-2222-222222222222', 'aaaaaaaa-2222-2222-2222-222222222222', 'openrouter', 'image',
   'queued', '{}', NULL, NULL);

INSERT INTO social_connections (id, user_id, platform, account_id) VALUES
  ('eeeeeeee-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'linkedin', 'urn:li:person:legacy');

INSERT INTO audit_log (user_id, action) VALUES
  ('11111111-1111-1111-1111-111111111111', 'legacy.login'),
  ('22222222-2222-2222-2222-222222222222', 'legacy.post.created');
