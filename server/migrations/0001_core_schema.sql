-- =====================================================================
-- Core schema for the self-hosted Pro Social AI API.
--
-- IDEMPOTENT BY CONSTRUCTION. This file is written to be safe to run:
--   * on an empty database (a fresh VPS), and
--   * on a database that already carries some of these objects (the
--     existing /opt/pro-social-ai deployment).
--
-- Every statement is CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- or CREATE OR REPLACE. Nothing here drops a column or a table, and
-- nothing rewrites data that is already present: re-running it must never
-- destroy anything. Follow that rule in every later migration too.
--
-- TENANCY. Every user-owned table carries `profile_id` referencing
-- profiles(id). The API resolves that id from the verified session cookie
-- on each request; it is never read from the request body or the query
-- string. There is no row-level-security layer standing behind the API
-- here, so the scoping in the query builder IS the boundary — see
-- server/src/lib/tenant.ts.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     citext,
  -- scrypt output and its per-user salt. Never a plaintext or reversible
  -- value; see server/src/lib/password.ts for the parameters used.
  password_hash             text,
  password_salt             text,
  role                      text NOT NULL DEFAULT 'user',
  -- The plan drives paid features. Only the server writes it (a payment
  -- webhook or an admin action); no user-facing route may set it.
  plan                      text NOT NULL DEFAULT 'starter',
  blocked_at                timestamptz,

  company_name              text,
  sector                    text DEFAULT '',
  description               text,
  tone                      text DEFAULT '',
  content_types             text[] NOT NULL DEFAULT ARRAY[]::text[],
  post_frequency            integer NOT NULL DEFAULT 2,
  platforms                 text[] NOT NULL DEFAULT ARRAY[]::text[],
  preferred_days            text[] NOT NULL DEFAULT ARRAY[]::text[],
  preferred_time            text NOT NULL DEFAULT '10:00',
  promo_posts_per_week      integer NOT NULL DEFAULT 1,
  research_posts_per_week   integer NOT NULL DEFAULT 1,
  auto_publish              boolean NOT NULL DEFAULT false,

  style_example             text,
  style_examples            jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_people_type         text DEFAULT 'african',
  image_style               text,
  use_custom_images         boolean NOT NULL DEFAULT false,
  custom_image_urls         text[] NOT NULL DEFAULT ARRAY[]::text[],

  brand_primary_color       text,
  brand_secondary_color     text,
  brand_accent_color        text,
  brand_font                text,
  logo_url                  text,
  poster_footer_text        text,

  audience_suggestions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_audiences          jsonb NOT NULL DEFAULT '[]'::jsonb,
  audiences_confirmed_at    timestamptz,

  auto_reply_enabled        boolean NOT NULL DEFAULT false,
  auto_reply_instructions   text,

  -- Explicit, revocable consent before any photograph of a real person may
  -- be sent to the image provider. NULL means "not given" — the generation
  -- route refuses a leader photo without it, and never infers it.
  leader_photo_consent_at   timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- The email is the login identifier, so it must be unique. citext makes the
-- comparison case-insensitive, which is what users expect of an address.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_key ON profiles (email) WHERE email IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_role_known
    CHECK (role IN ('user', 'admin', 'super_admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_poster_footer_len
    CHECK (poster_footer_text IS NULL OR char_length(poster_footer_text) <= 120);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Sessions — the HttpOnly cookie carries only this opaque id.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- The cookie holds a random secret; only its hash is stored, so a dump of
  -- this table cannot be replayed as a live session.
  token_hash  text NOT NULL UNIQUE,
  user_agent  text,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_profile_idx ON sessions (profile_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- One-time tokens for password reset and emailed post validation. Both are
-- single-use and expiring; `used_at` is what makes replay impossible.
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  -- Optional subject the token acts on (e.g. the post being validated).
  subject_id  uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS one_time_tokens_profile_idx ON one_time_tokens (profile_id, purpose);

DO $$ BEGIN
  ALTER TABLE one_time_tokens ADD CONSTRAINT one_time_tokens_purpose_known
    CHECK (purpose IN ('password_reset', 'post_validation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS posts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title                    text NOT NULL DEFAULT '',
  content                  text NOT NULL,
  content_category         text,
  platforms                text[] NOT NULL DEFAULT ARRAY[]::text[],
  status                   text NOT NULL DEFAULT 'pending',
  week_number              integer,
  scheduled_for            timestamptz,
  published_at             timestamptz,

  image_url                text,
  image_job_id             uuid,
  image_status             text,

  publish_error            text,
  publish_attempts         integer NOT NULL DEFAULT 0,
  -- The cron must not re-attempt before this instant. NOT NULL with a now()
  -- default keeps the queue predicate a single plain comparison.
  next_publish_attempt_at  timestamptz NOT NULL DEFAULT now(),
  publishing_started_at    timestamptz,
  provider_post_id         text,
  external_post_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_email_sent_at timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_profile_created_idx ON posts (profile_id, created_at DESC);

-- The publish queue's selection index. It must cover the backoff predicate,
-- or the added filter degrades the scan as posts accumulate.
CREATE INDEX IF NOT EXISTS posts_due_idx
  ON posts (status, scheduled_for, next_publish_attempt_at)
  WHERE status = 'validated';

DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_status_known
    CHECK (status IN ('pending', 'validated', 'publishing', 'published', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_category_known
    CHECK (content_category IS NULL OR content_category IN ('value', 'research', 'promo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_image_status_known
    CHECK (image_status IS NULL OR image_status IN ('processing', 'done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_attempts_nonneg CHECK (publish_attempts >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_content_len CHECK (char_length(content) <= 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Only the networks a post can actually be addressed to. Adding one here
-- means adding it to the connect dialog and the profile picker in the same
-- change — otherwise a user can connect an account they can never publish to.
DO $$ BEGIN
  ALTER TABLE posts ADD CONSTRAINT posts_platforms_known CHECK (
    platforms <@ ARRAY[
      'Instagram','Facebook','Twitter','Twitter (X)','LinkedIn',
      'instagram','facebook','twitter','linkedin'
    ]::text[]
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Media — files live in the API's local volume, rows describe them.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'other',
  -- Path RELATIVE to MEDIA_ROOT. Never an absolute path and never supplied
  -- by the browser: the API composes it from the profile id and a random
  -- name, so an upload cannot escape its own directory.
  storage_path text NOT NULL UNIQUE,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_profile_idx ON media_assets (profile_id, created_at DESC);

DO $$ BEGIN
  ALTER TABLE media_assets ADD CONSTRAINT media_kind_known
    CHECK (kind IN ('logo', 'custom_image', 'poster', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE media_assets ADD CONSTRAINT media_size_positive
    CHECK (size_bytes > 0 AND size_bytes <= 20971520);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Generation jobs — the contract behind "processing + job id".
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS generation_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id        uuid REFERENCES posts(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  status         text NOT NULL DEFAULT 'processing',
  -- The provider's own job handle, so a job can be resumed across restarts.
  provider       text,
  provider_job_id text,
  provider_status_url text,
  -- Set only on success: the local media URL of the finished render.
  result_url     text,
  -- Set only on failure: the provider's real reason, surfaced to the user.
  error          text,
  format         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_jobs_profile_idx ON generation_jobs (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_jobs_open_idx ON generation_jobs (status) WHERE status = 'processing';

DO $$ BEGIN
  ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_kind_known
    CHECK (kind IN ('image', 'video'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_known
    CHECK (status IN ('processing', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Usage accounting — the quota ledger.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS generation_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  status        text NOT NULL DEFAULT 'reserved',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_usage_window_idx
  ON generation_usage (profile_id, function_name, created_at DESC);

-- ---------------------------------------------------------------------
-- Social connections and the comment inbox
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_connections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  platform     text NOT NULL,
  account_id   text NOT NULL,
  account_name text,
  username     text,
  -- The provider-side tenant handle. Publishing and inbox reads are scoped
  -- by it; a missing value means the account is NOT isolated and must not
  -- be used, rather than silently falling back to a shared profile.
  provider_profile_key text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, platform, account_id)
);
CREATE INDEX IF NOT EXISTS social_connections_profile_idx ON social_connections (profile_id);

CREATE TABLE IF NOT EXISTS social_comments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id             uuid REFERENCES posts(id) ON DELETE SET NULL,
  provider            text,
  platform            text NOT NULL,
  external_comment_id text NOT NULL,
  parent_comment_id   text,
  author_name         text,
  author_handle       text,
  author_avatar_url   text,
  message             text,
  status              text NOT NULL DEFAULT 'new',
  reply_text          text,
  reply_external_id   text,
  replied_at          timestamptz,
  replied_by          text,
  comment_created_at  timestamptz,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, platform, external_comment_id)
);
CREATE INDEX IF NOT EXISTS social_comments_inbox_idx
  ON social_comments (profile_id, comment_created_at DESC NULLS LAST, created_at DESC);

DO $$ BEGIN
  ALTER TABLE social_comments ADD CONSTRAINT social_comments_status_known
    CHECK (status IN ('new', 'replied', 'ignored', 'hidden'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE social_comments ADD CONSTRAINT social_comments_replied_by_known
    CHECK (replied_by IS NULL OR replied_by IN ('manual', 'auto'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- Abuse control for the unauthenticated endpoints (contact form, the
-- emailed validation link).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ip_rate_events (
  id         bigserial PRIMARY KEY,
  bucket     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ip_rate_events_bucket_idx ON ip_rate_events (bucket, created_at DESC);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Atomic quota reservation. The advisory lock is what makes it a real cap:
-- without it, parallel requests all read the same count and all pass.
CREATE OR REPLACE FUNCTION consume_generation_quota(
  p_profile uuid,
  p_function text,
  p_max integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_profile::text || ':' || p_function, 0));
  SELECT count(*) INTO used
    FROM generation_usage
   WHERE profile_id = p_profile
     AND function_name = p_function
     AND created_at >= now() - make_interval(secs => p_window_seconds);
  IF used >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO generation_usage (profile_id, function_name, status)
  VALUES (p_profile, p_function, 'reserved');
  RETURN true;
END;
$$;

-- Releases the most recent reservation, for a provider failure that happened
-- before any billable work. Deletes exactly one row so the usage history is
-- preserved.
CREATE OR REPLACE FUNCTION release_generation_quota(
  p_profile uuid,
  p_function text
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  SELECT id INTO target
    FROM generation_usage
   WHERE profile_id = p_profile
     AND function_name = p_function
     AND status = 'reserved'
   ORDER BY created_at DESC
   LIMIT 1;
  IF target IS NULL THEN RETURN false; END IF;
  DELETE FROM generation_usage WHERE id = target;
  RETURN true;
END;
$$;

-- Per-bucket IP rate limit for public endpoints.
CREATE OR REPLACE FUNCTION hit_ip_rate_limit(
  p_bucket text,
  p_max integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE used integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket, 0));
  SELECT count(*) INTO used
    FROM ip_rate_events
   WHERE bucket = p_bucket
     AND created_at >= now() - make_interval(secs => p_window_seconds);
  IF used >= p_max THEN RETURN false; END IF;
  INSERT INTO ip_rate_events (bucket) VALUES (p_bucket);
  RETURN true;
END;
$$;

-- Recovers posts left in 'publishing' by a crashed run.
--
-- A run that already reached the provider is marked published rather than
-- retried: re-queueing it would post the same content twice. One that never
-- got that far goes back to the queue with its attempt counted and a backoff
-- applied, so a post that repeatedly kills the worker eventually leaves the
-- queue instead of blocking it forever.
CREATE OR REPLACE FUNCTION recover_stuck_publishing() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  UPDATE posts
     SET status = 'published',
         published_at = COALESCE(published_at, now())
   WHERE status = 'publishing'
     AND publishing_started_at IS NOT NULL
     AND publishing_started_at < now() - interval '10 minutes'
     AND provider_post_id IS NOT NULL;

  UPDATE posts
     SET status = 'validated',
         publish_attempts = publish_attempts + 1,
         next_publish_attempt_at = now() + interval '15 minutes',
         publish_error = COALESCE(publish_error, 'recovered_from_publishing_timeout')
   WHERE status = 'publishing'
     AND publishing_started_at IS NOT NULL
     AND publishing_started_at < now() - interval '10 minutes'
     AND provider_post_id IS NULL;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Keeps updated_at honest without every query having to remember it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_touch_updated_at ON profiles;
CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS posts_touch_updated_at ON posts;
CREATE TRIGGER posts_touch_updated_at
  BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS generation_jobs_touch_updated_at ON generation_jobs;
CREATE TRIGGER generation_jobs_touch_updated_at
  BEFORE UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
