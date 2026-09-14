-- =====================================================================
-- 0000 — LEGACY PRODUCTION COMPATIBILITY
--
-- WHY THIS FILE RUNS FIRST (and is numbered 0000, not 0003)
--
-- 0001_core_schema.sql is idempotent for objects it OWNS: every table is
-- CREATE TABLE IF NOT EXISTS. But `IF NOT EXISTS` is all-or-nothing at the
-- TABLE level — when a table of that name already exists with an OLDER shape,
-- the CREATE is skipped entirely and nothing adds the missing columns. The
-- very next statement then fails:
--
--     CREATE UNIQUE INDEX ... ON profiles (email)
--     ERROR: column "email" does not exist
--
-- which is exactly what a production-copy migration reported. A repair placed
-- AFTER 0001 could never run, because 0001 aborts first. So the repair has to
-- come BEFORE it: hence 0000.
--
-- WHAT THIS FILE DOES
--
--   1. PREFLIGHT — read-only checks. If the legacy schema is ambiguous or
--      unsafe to convert, it raises a message naming the exact problem BEFORE
--      anything is written (and the runner's transaction rolls back anyway).
--   2. SHAPE — adds every column, index and constraint the new code needs to
--      tables that already exist, with ADD COLUMN IF NOT EXISTS only.
--   3. IDENTITY — backfills profiles.email (and password material when its
--      format is compatible) from the legacy accounts table.
--   4. TENANCY — gives child tables their profile_id and backfills it from
--      the legacy owner column.
--   5. REPORT — writes what it did into legacy_compat_report, so the result
--      can be checked after the fact instead of trusted.
--
-- WHAT IT NEVER DOES
--
--   No DROP TABLE. No DROP COLUMN. No TRUNCATE. No DELETE of user rows. No
--   renaming of an existing column. No overwriting of a non-NULL value. A
--   legacy column (users.email, posts.user_id, ...) is READ and left in
--   place: the new column is added beside it, so a rollback to the previous
--   image keeps working against the same database.
--
-- ON A FRESH DATABASE this file is a no-op: there is nothing to adapt, and
-- 0001 creates everything. On a database that already ran 0001 it is also a
-- no-op: every column it would add is already there.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- The report. Append-only; one row per migration step per run.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_compat_report (
  id         bigserial PRIMARY KEY,
  step       text NOT NULL,
  detail     text NOT NULL,
  row_count  bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE legacy_compat_report IS
  'What migration 0000 found and did on this database. Read it after migrating: SELECT * FROM legacy_compat_report ORDER BY id;';

-- ---------------------------------------------------------------------
-- Identity strategy discovery.
--
-- Kept as a permanent, READ-ONLY function so it can be run by hand for
-- diagnosis before a deploy:
--     SELECT legacy_compat_identity_strategy();
--
-- Returns one of:
--   'no_profiles'      — no profiles table yet (fresh database).
--   'modern'           — profiles.email already exists; nothing to map.
--   'profiles_user_id' — profiles.user_id → users.id.
--   'users_profile_id' — users.profile_id → profiles.id.
--   'shared_id'        — profiles.id and users.id are the same identifier.
--   'no_accounts'      — profiles has no rows; nothing to map.
--   'ambiguous'        — a link exists but cannot be determined; the caller
--                        must stop rather than guess.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legacy_compat_identity_strategy() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  profile_rows bigint;
  without_email bigint;
  matched      bigint;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RETURN 'no_profiles';
  END IF;

  -- No legacy accounts table: there is nothing to map FROM, whatever shape
  -- profiles has. (A fresh install, or a database already converted.)
  IF to_regclass('public.users') IS NULL THEN
    RETURN 'modern';
  END IF;

  EXECUTE 'SELECT count(*) FROM public.profiles' INTO profile_rows;
  IF profile_rows = 0 THEN
    RETURN 'no_accounts';
  END IF;

  -- Deliberately NOT "does profiles.email exist": section 2 of this very file
  -- adds that column, so an existence test would report 'modern' on the second
  -- half of the first run and silently skip the backfill — accounts would keep
  -- all their data and lose the identifier they sign in with.
  -- The question that actually matters is whether any profile still lacks an
  -- address. That is also what makes a re-run a no-op.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'email'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.profiles WHERE email IS NULL' INTO without_email;
    IF without_email = 0 THEN
      RETURN 'modern';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'user_id'
  ) THEN
    RETURN 'profiles_user_id';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'profile_id'
  ) THEN
    RETURN 'users_profile_id';
  END IF;

  -- Last possibility: the two tables share one identifier. Only accept it when
  -- EVERY profile row matches a user row — a partial match means the ids mean
  -- different things, and guessing would attach the wrong email to an account.
  EXECUTE 'SELECT count(*) FROM public.profiles p JOIN public.users u ON u.id::text = p.id::text'
    INTO matched;
  IF matched = profile_rows THEN
    RETURN 'shared_id';
  END IF;

  RETURN 'ambiguous';
END;
$$;

COMMENT ON FUNCTION legacy_compat_identity_strategy() IS
  'Read-only. How the account email maps from the legacy schema: no_profiles | modern | no_accounts | profiles_user_id | users_profile_id | shared_id | ambiguous.';

-- ---------------------------------------------------------------------
-- 1. PREFLIGHT — checks only. Raises before anything is written.
-- ---------------------------------------------------------------------
DO $preflight$
DECLARE
  strategy      text;
  bad_type      text;
  dup_count     bigint;
  dup_sample    text;
  tbl           text;
  owner_col     text;
BEGIN
  strategy := legacy_compat_identity_strategy();

  IF strategy = 'no_profiles' THEN
    RAISE NOTICE '[0000] fresh database: nothing to adapt.';
    RETURN;
  END IF;

  RAISE NOTICE '[0000] identity strategy: %', strategy;

  IF strategy = 'ambiguous' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Legacy compatibility: cannot determine where the account email lives.',
      DETAIL  = 'public.profiles has rows and no "email" column, and no usable link to public.users was found '
                '(no profiles.user_id, no users.profile_id, and the ids are not shared).',
      HINT    = 'Run server/scripts/inspect-legacy-schema.sql against a COPY of the database, then either '
                'add the mapping column or extend legacy_compat_identity_strategy(). Do not deploy until '
                'the mapping is known: guessing it would attach accounts to the wrong owner.';
  END IF;

  -- Identifier types. The API passes uuids; a legacy integer or text id would
  -- only fail later, at runtime, once real users are on the new build.
  SELECT string_agg(format('%s.%s is %s', table_name, column_name, data_type), ', ')
    INTO bad_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'id'
     AND table_name IN ('profiles', 'posts', 'media_assets', 'generation_jobs', 'social_connections')
     AND data_type <> 'uuid'
     AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public');
  IF bad_type IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Legacy compatibility: primary keys are not uuid.',
      DETAIL  = bad_type,
      HINT    = 'The API generates and passes uuids. Converting these ids is a data migration of its own '
                'and is deliberately not attempted here.';
  END IF;

  -- Email collisions. The new schema makes the address the login identifier
  -- and indexes it UNIQUE; two legacy accounts sharing one address would make
  -- that index fail mid-migration, so it is detected first and named.
  IF strategy IN ('profiles_user_id', 'users_profile_id', 'shared_id') THEN
    EXECUTE format($q$
      SELECT count(*), coalesce(string_agg(email, ', '), '')
        FROM (
          SELECT lower(u.email::text) AS email
            FROM public.profiles p
            JOIN public.users u ON %s
           WHERE u.email IS NOT NULL
           GROUP BY lower(u.email::text)
          HAVING count(*) > 1
           LIMIT 10
        ) dups $q$,
      CASE strategy
        WHEN 'profiles_user_id' THEN 'u.id = p.user_id'
        WHEN 'users_profile_id' THEN 'u.profile_id = p.id'
        ELSE 'u.id::text = p.id::text'
      END)
    INTO dup_count, dup_sample;

    IF dup_count > 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = format('Legacy compatibility: %s email address(es) are shared by more than one profile.', dup_count),
        DETAIL  = format('Affected addresses (up to 10): %s', dup_sample),
        HINT    = 'The new schema uses the address as the unique login identifier. Decide which profile keeps '
                  'each address (and what happens to the other) BEFORE migrating. Nothing has been modified.';
    END IF;
  END IF;

  -- Tenancy: every child table must be attachable to a profile.
  FOREACH tbl IN ARRAY ARRAY['posts', 'media_assets', 'generation_jobs', 'social_connections'] LOOP
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'profile_id'
    );

    SELECT column_name INTO owner_col
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = tbl AND column_name IN ('user_id', 'owner_id', 'account_id')
     ORDER BY array_position(ARRAY['user_id', 'owner_id'], column_name) NULLS LAST
     LIMIT 1;

    IF owner_col IS NULL OR owner_col = 'account_id' THEN
      -- social_connections.account_id is the PROVIDER's account handle, not an
      -- owner: it must never be used as one.
      RAISE EXCEPTION USING
        MESSAGE = format('Legacy compatibility: table "%s" has no profile_id and no recognisable owner column.', tbl),
        DETAIL  = 'Looked for profile_id, then user_id, then owner_id.',
        HINT    = format('Inspect "%s" with server/scripts/inspect-legacy-schema.sql. Rows must not be '
                         'attached to an account by guesswork.', tbl);
    END IF;
  END LOOP;

  RAISE NOTICE '[0000] preflight passed.';
END;
$preflight$;

-- ---------------------------------------------------------------------
-- 2. SHAPE — bring pre-existing tables up to what 0001 and the API expect.
--
-- ALTER TABLE IF EXISTS + ADD COLUMN IF NOT EXISTS: a no-op on a fresh
-- database (table absent) and on an already-migrated one (column present).
-- Defaults mirror 0001 exactly. NOT NULL is only ever paired with a DEFAULT,
-- so adding a column to a populated table cannot fail.
-- ---------------------------------------------------------------------

-- profiles -------------------------------------------------------------
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS email citext;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS password_salt text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'starter';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS sector text DEFAULT '';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS tone text DEFAULT '';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS content_types text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS post_frequency integer NOT NULL DEFAULT 2;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS preferred_days text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS preferred_time text NOT NULL DEFAULT '10:00';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS promo_posts_per_week integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS research_posts_per_week integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS style_example text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS style_examples jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS image_people_type text DEFAULT 'african';
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS image_style text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS use_custom_images boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS custom_image_urls text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS brand_primary_color text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS brand_secondary_color text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS brand_accent_color text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS brand_font text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS poster_footer_text text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS audience_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS audiences_confirmed_at timestamptz;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS auto_reply_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS auto_reply_instructions text;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS leader_photo_consent_at timestamptz;
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- posts ----------------------------------------------------------------
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS title text DEFAULT '';
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS content_category text;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS week_number integer;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS image_job_id uuid;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS image_status text;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS publish_error text;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS next_publish_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS publishing_started_at timestamptz;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS provider_post_id text;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS external_post_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS validation_email_sent_at timestamptz;
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE IF EXISTS posts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- media_assets ---------------------------------------------------------
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'other';
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS mime_type text NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS size_bytes bigint NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS public_token text;
ALTER TABLE IF EXISTS media_assets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- generation_jobs ------------------------------------------------------
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS post_id uuid;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'image';
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'processing';
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS provider_job_id text;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS provider_status_url text;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS result_url text;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS format jsonb;
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE IF EXISTS generation_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- social_connections ---------------------------------------------------
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'zernio';
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'linkedin';
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS account_name text;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS provider_profile_key text;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS access_token text;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS refresh_token text;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS social_connections ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------
-- 3. IDENTITY — carry the account email (and password, when its format is
--    the one this code reads) from the legacy accounts table.
--
-- COALESCE everywhere: a value already present in profiles always wins, so
-- re-running can never overwrite something the new app has since written.
-- ---------------------------------------------------------------------
DO $identity$
DECLARE
  strategy   text;
  join_cond  text;
  moved      bigint := 0;
  pwd_moved  bigint := 0;
  pwd_skipped bigint := 0;
  no_email   bigint := 0;
  has_pwd_hash boolean;
  has_pwd_salt boolean;
BEGIN
  strategy := legacy_compat_identity_strategy();
  IF strategy IN ('no_profiles', 'modern', 'no_accounts', 'ambiguous') THEN
    -- 'modern' here means profiles.email existed BEFORE this migration, or was
    -- just added by section 2 on a database that has no legacy users table.
    -- 'ambiguous' cannot be reached: preflight already raised.
    INSERT INTO legacy_compat_report (step, detail)
    VALUES ('identity', format('no email backfill needed (strategy=%s)', strategy));
    RETURN;
  END IF;

  join_cond := CASE strategy
    WHEN 'profiles_user_id' THEN 'u.id = p.user_id'
    WHEN 'users_profile_id' THEN 'u.profile_id = p.id'
    ELSE 'u.id::text = p.id::text'
  END;

  -- Email. Only rows that have none.
  EXECUTE format($q$
    UPDATE public.profiles p
       SET email = u.email::citext
      FROM public.users u
     WHERE %s
       AND p.email IS NULL
       AND u.email IS NOT NULL
       AND btrim(u.email::text) <> ''
  $q$, join_cond);
  GET DIAGNOSTICS moved = ROW_COUNT;
  INSERT INTO legacy_compat_report (step, detail, row_count)
  VALUES ('identity.email', format('email copied from users (strategy=%s)', strategy), moved);

  EXECUTE 'SELECT count(*) FROM public.profiles WHERE email IS NULL' INTO no_email;
  IF no_email > 0 THEN
    -- Not fatal, and deliberately not invented: the rows keep all their data,
    -- but nobody can sign in to them until an operator sets an address.
    RAISE WARNING '[0000] % profile(s) still have no email and cannot be signed into.', no_email;
    INSERT INTO legacy_compat_report (step, detail, row_count)
    VALUES ('identity.email', 'profiles left without an email (cannot sign in until one is set)', no_email);
  END IF;

  -- Password material. Copied ONLY when it is the scheme this code verifies
  -- (scrypt: a 64-byte hash and its salt, both hex). A bcrypt/argon hash from
  -- the old stack is left where it is: copying it would produce an account
  -- that looks usable and rejects every password.
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='users' AND column_name='password_hash'),
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='users' AND column_name='password_salt')
    INTO has_pwd_hash, has_pwd_salt;

  IF has_pwd_hash AND has_pwd_salt THEN
    EXECUTE format($q$
      UPDATE public.profiles p
         SET password_hash = u.password_hash,
             password_salt = u.password_salt
        FROM public.users u
       WHERE %s
         AND p.password_hash IS NULL
         AND u.password_hash ~ '^[0-9a-f]{128}$'
         AND u.password_salt ~ '^[0-9a-f]+$'
    $q$, join_cond);
    GET DIAGNOSTICS pwd_moved = ROW_COUNT;
  END IF;

  IF has_pwd_hash THEN
    EXECUTE format($q$
      SELECT count(*)
        FROM public.profiles p
        JOIN public.users u ON %s
       WHERE p.password_hash IS NULL
         AND u.password_hash IS NOT NULL
         AND u.password_hash !~ '^[0-9a-f]{128}$'
    $q$, join_cond) INTO pwd_skipped;
  END IF;

  INSERT INTO legacy_compat_report (step, detail, row_count)
  VALUES ('identity.password', 'scrypt password material carried over', pwd_moved);

  IF pwd_skipped > 0 THEN
    RAISE WARNING '[0000] % account(s) use an incompatible password format and must reset their password.', pwd_skipped;
    INSERT INTO legacy_compat_report (step, detail, row_count)
    VALUES ('identity.password',
            'accounts whose legacy password hash is not readable by this build — they must use "mot de passe oublié"',
            pwd_skipped);
  END IF;
END;
$identity$;

-- ---------------------------------------------------------------------
-- 4. TENANCY — every child row must name the profile that owns it.
--
-- The legacy owner column is READ and kept. profile_id is filled beside it,
-- so the previous build still works against this database if Hermes rolls
-- back to the previous image.
-- ---------------------------------------------------------------------
DO $tenancy$
DECLARE
  strategy    text;
  profile_src text;
  tbl         text;
  owner_col   text;
  moved       bigint;
  orphans     bigint;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN RETURN; END IF;
  strategy := legacy_compat_identity_strategy();

  -- How to get from a legacy owner id to a profile id.
  profile_src := CASE
    WHEN to_regclass('public.users') IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles' AND column_name='user_id')
      THEN 'SELECT id FROM public.profiles WHERE user_id = %1$s.%2$I'
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='users' AND column_name='profile_id')
      THEN 'SELECT u.profile_id FROM public.users u WHERE u.id = %1$s.%2$I'
    ELSE 'SELECT id FROM public.profiles WHERE id::text = %1$s.%2$I::text'
  END;

  FOREACH tbl IN ARRAY ARRAY['posts', 'media_assets', 'generation_jobs', 'social_connections'] LOOP
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;

    -- Nothing to do when the table is already keyed by profile and filled.
    EXECUTE format('SELECT count(*) FROM public.%I WHERE profile_id IS NULL', tbl) INTO orphans;
    CONTINUE WHEN orphans = 0;

    SELECT column_name INTO owner_col
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = tbl AND column_name IN ('user_id', 'owner_id')
     ORDER BY array_position(ARRAY['user_id', 'owner_id'], column_name)
     LIMIT 1;

    IF owner_col IS NULL OR profile_src IS NULL THEN
      -- Preflight allows this only when the rows are already attached; if we
      -- get here there is nothing to map them with.
      INSERT INTO legacy_compat_report (step, detail, row_count)
      VALUES ('tenancy.' || tbl, 'rows without profile_id and no owner column to map from', orphans);
      RAISE WARNING '[0000] % row(s) in % have no profile_id and could not be mapped.', orphans, tbl;
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE public.%1$I t SET profile_id = (' || format(profile_src, 't', owner_col) || ')
        WHERE t.profile_id IS NULL',
      tbl);
    GET DIAGNOSTICS moved = ROW_COUNT;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE profile_id IS NULL', tbl) INTO orphans;
    INSERT INTO legacy_compat_report (step, detail, row_count)
    VALUES ('tenancy.' || tbl, format('profile_id backfilled from %s', owner_col), moved);

    IF orphans > 0 THEN
      -- Kept, never deleted. They belong to no profile, so the API will not
      -- show them; an operator can attach them by hand afterwards.
      RAISE WARNING '[0000] % row(s) in % still have no owner and stay hidden from the app.', orphans, tbl;
      INSERT INTO legacy_compat_report (step, detail, row_count)
      VALUES ('tenancy.' || tbl, 'rows kept but unattached (owner not found)', orphans);
    END IF;
  END LOOP;
END;
$tenancy$;

-- ---------------------------------------------------------------------
-- 5. CONSTRAINTS AND INDEXES the API depends on, added only when the table
--    already existed (0001 creates them inline for new tables).
--
-- Each one is guarded: a duplicate is skipped, and a constraint that legacy
-- DATA would violate is reported instead of being forced — NOT VALID keeps
-- the old rows and still enforces the rule on everything written from now on.
-- ---------------------------------------------------------------------
DO $constraints$
DECLARE
  dups bigint;
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    -- The login lookup. Partial, so rows without an address stay legal.
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_key ON profiles (email) WHERE email IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Legacy compatibility: duplicate email addresses in profiles.',
        HINT    = 'SELECT lower(email::text), count(*) FROM profiles GROUP BY 1 HAVING count(*) > 1; '
                  'resolve the duplicates, then migrate again. Nothing was written.';
    END;

    -- Foreign keys to profiles, added NOT VALID: new and updated rows are
    -- checked, existing rows are left exactly as they are.
    IF to_regclass('public.posts') IS NOT NULL THEN
      BEGIN
        ALTER TABLE posts ADD CONSTRAINT posts_profile_fk
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
    IF to_regclass('public.media_assets') IS NOT NULL THEN
      BEGIN
        ALTER TABLE media_assets ADD CONSTRAINT media_assets_profile_fk
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
    IF to_regclass('public.generation_jobs') IS NOT NULL THEN
      BEGIN
        ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_profile_fk
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
    IF to_regclass('public.social_connections') IS NOT NULL THEN
      BEGIN
        ALTER TABLE social_connections ADD CONSTRAINT social_connections_profile_fk
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
  END IF;

  -- media_assets.storage_path is the key the upload path upserts on.
  IF to_regclass('public.media_assets') IS NOT NULL THEN
    SELECT count(*) INTO dups FROM (
      SELECT storage_path FROM media_assets WHERE storage_path IS NOT NULL
       GROUP BY storage_path HAVING count(*) > 1
    ) d;
    IF dups > 0 THEN
      RAISE WARNING '[0000] % duplicate storage_path value(s): the unique index was not created.', dups;
      INSERT INTO legacy_compat_report (step, detail, row_count)
      VALUES ('index.media_storage_path', 'duplicate storage_path values; unique index skipped', dups);
    ELSE
      CREATE UNIQUE INDEX IF NOT EXISTS media_assets_storage_path_key
        ON media_assets (storage_path) WHERE storage_path IS NOT NULL;
    END IF;
  END IF;

  -- social_connections: the ON CONFLICT target the connect route writes to.
  IF to_regclass('public.social_connections') IS NOT NULL THEN
    SELECT count(*) INTO dups FROM (
      SELECT profile_id, platform, account_id FROM social_connections
       WHERE profile_id IS NOT NULL
       GROUP BY 1, 2, 3 HAVING count(*) > 1
    ) d;
    IF dups > 0 THEN
      RAISE WARNING '[0000] % duplicate (profile, platform, account) connection(s): unique index skipped.', dups;
      INSERT INTO legacy_compat_report (step, detail, row_count)
      VALUES ('index.social_connections', 'duplicate (profile_id, platform, account_id); unique index skipped', dups);
    ELSE
      CREATE UNIQUE INDEX IF NOT EXISTS social_connections_profile_platform_account_key
        ON social_connections (profile_id, platform, account_id)
        WHERE profile_id IS NOT NULL;
    END IF;
  END IF;
END;
$constraints$;

-- ---------------------------------------------------------------------
-- 6. LEGACY NOT NULL COLUMNS the new code never writes.
--
-- The legacy schema keeps its own required columns — profiles.user_id,
-- posts.user_id, ... — declared NOT NULL with no default. The new API does
-- not know they exist, so the FIRST signup and the FIRST post would fail with
-- "null value in column \"user_id\" violates not-null constraint": the schema
-- would be migrated and the application still unusable.
--
-- The requirement is dropped, the COLUMN AND ITS DATA ARE KEPT. Nothing is
-- deleted or renamed, every legacy row keeps its value, and the previous build
-- still reads them if Hermes rolls back the image.
--
-- Only columns the new schema does not own are touched: a modern column like
-- posts.content stays NOT NULL, because the API always writes it.
-- ---------------------------------------------------------------------
DO $relax$
DECLARE
  modern jsonb := jsonb_build_object(
    'profiles', to_jsonb(ARRAY[
      'id','email','password_hash','password_salt','role','plan','blocked_at','company_name','sector',
      'description','tone','content_types','post_frequency','platforms','preferred_days','preferred_time',
      'promo_posts_per_week','research_posts_per_week','auto_publish','style_example','style_examples',
      'image_people_type','image_style','use_custom_images','custom_image_urls','brand_primary_color',
      'brand_secondary_color','brand_accent_color','brand_font','logo_url','poster_footer_text',
      'audience_suggestions','target_audiences','audiences_confirmed_at','auto_reply_enabled',
      'auto_reply_instructions','leader_photo_consent_at','created_at','updated_at']),
    'posts', to_jsonb(ARRAY[
      'id','profile_id','title','content','content_category','platforms','status','week_number',
      'scheduled_for','published_at','image_url','image_job_id','image_status','publish_error',
      'publish_attempts','next_publish_attempt_at','publishing_started_at','provider_post_id',
      'external_post_ids','validation_email_sent_at','created_at','updated_at']),
    'media_assets', to_jsonb(ARRAY[
      'id','profile_id','kind','storage_path','mime_type','size_bytes','public_token','created_at']),
    'generation_jobs', to_jsonb(ARRAY[
      'id','profile_id','post_id','kind','status','provider','provider_job_id','provider_status_url',
      'result_url','error','format','created_at','updated_at']),
    'social_connections', to_jsonb(ARRAY[
      'id','profile_id','provider','platform','account_id','account_name','username',
      'provider_profile_key','access_token','refresh_token','token_expires_at','is_active','meta',
      'created_at'])
  );
  tbl   text;
  col   record;
  relaxed bigint := 0;
BEGIN
  FOR tbl IN SELECT jsonb_object_keys(modern) LOOP
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;

    FOR col IN
      SELECT c.column_name
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = tbl
         AND c.is_nullable = 'NO'
         AND c.column_default IS NULL
         -- Never a primary key: Postgres refuses, and the API supplies it.
         AND NOT EXISTS (
           SELECT 1
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k
               ON k.constraint_name = tc.constraint_name
              AND k.table_schema = tc.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = tbl
              AND tc.constraint_type = 'PRIMARY KEY'
              AND k.column_name = c.column_name
         )
         AND NOT (modern -> tbl ? c.column_name)
    LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', tbl, col.column_name);
      relaxed := relaxed + 1;
      INSERT INTO legacy_compat_report (step, detail)
      VALUES ('relax_not_null',
              format('%s.%s: NOT NULL dropped so the new API can insert; the column and its data are kept',
                     tbl, col.column_name));
      RAISE NOTICE '[0000] relaxed NOT NULL on %.% (legacy-only column)', tbl, col.column_name;
    END LOOP;
  END LOOP;

  IF relaxed = 0 THEN
    INSERT INTO legacy_compat_report (step, detail)
    VALUES ('relax_not_null', 'no legacy-only NOT NULL column to relax');
  END IF;
END;
$relax$;

-- ---------------------------------------------------------------------
-- 7. WRITE PROBE — can the new code actually write to this database?
--
-- A migration that only changes the schema can still leave the product
-- unusable: a legacy NOT NULL, a legacy CHECK with a different value set, a
-- legacy trigger. The probe answers the question directly by performing the
-- inserts the API performs, then unwinding them.
--
-- The whole probe runs in a subtransaction that is ALWAYS rolled back: the
-- canary rows never exist outside this block. If an insert is rejected, the
-- migration fails here — with the database untouched — rather than at the
-- first real signup.
-- ---------------------------------------------------------------------
DO $probe$
DECLARE
  probe_profile uuid;
  failure       text;
  failure_state text;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN RETURN; END IF;

  BEGIN
    INSERT INTO profiles (email, password_hash, password_salt)
    VALUES (('legacy-compat-probe+' || gen_random_uuid() || '@invalid.test')::citext, 'probe', 'probe')
    RETURNING id INTO probe_profile;

    IF to_regclass('public.posts') IS NOT NULL THEN
      INSERT INTO posts (profile_id, title, content, status, platforms)
      VALUES (probe_profile, 'probe', 'probe', 'pending', ARRAY[]::text[]);
    END IF;

    IF to_regclass('public.media_assets') IS NOT NULL THEN
      INSERT INTO media_assets (profile_id, kind, storage_path, mime_type, size_bytes)
      VALUES (probe_profile, 'other', 'probe/' || gen_random_uuid(), 'image/png', 1);
    END IF;

    IF to_regclass('public.generation_jobs') IS NOT NULL THEN
      INSERT INTO generation_jobs (profile_id, kind, status)
      VALUES (probe_profile, 'image', 'processing');
    END IF;

    IF to_regclass('public.social_connections') IS NOT NULL THEN
      INSERT INTO social_connections (profile_id, provider, platform, account_id)
      VALUES (probe_profile, 'zernio', 'linkedin', 'probe-' || gen_random_uuid());
    END IF;

    -- Unwind: this marker is the ONLY successful exit.
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'legacy-compat-probe-rollback';

  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      IF SQLERRM <> 'legacy-compat-probe-rollback' THEN
        failure := SQLERRM;
        failure_state := SQLSTATE;
      END IF;
    WHEN others THEN
      failure := SQLERRM;
      failure_state := SQLSTATE;
  END;

  IF failure IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Legacy compatibility: the migrated schema still rejects a normal write from the API.',
      DETAIL  = format('%s (SQLSTATE %s)', failure, failure_state),
      HINT    = 'The probe performs the same inserts as signup / post creation / upload. Fix what it names '
                '(a legacy NOT NULL, CHECK or trigger the new code does not satisfy) before deploying. '
                'Nothing was written: this migration rolled back.';
  END IF;

  INSERT INTO legacy_compat_report (step, detail)
  VALUES ('write_probe', 'signup, post, media, job and connection inserts accepted (probe rows rolled back)');
  RAISE NOTICE '[0000] write probe passed.';
END;
$probe$;

-- ---------------------------------------------------------------------
-- 8. Close the run.
-- ---------------------------------------------------------------------
INSERT INTO legacy_compat_report (step, detail)
SELECT 'run', format('0000 legacy compatibility completed (strategy=%s)', legacy_compat_identity_strategy())
WHERE to_regclass('public.profiles') IS NOT NULL;
