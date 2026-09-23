-- =====================================================================
-- 0004 — Every generation job names its provider.
--
-- Production's generation_jobs carries `provider text NOT NULL`, and that is
-- the right rule: the resume path (GET /api/generations/:id) needs to know
-- which provider to ask about a job, and the only writer —
-- services/generation.ts recordJob() — always sets it ('graphiste', the one
-- poster engine). 0001, however, creates the column NULLABLE on a fresh
-- database, so a fresh install and production enforced different rules.
--
-- This makes the rule the same everywhere, without rewriting history:
--
--   * no job lacks a provider (fresh database, or production where it is
--     already NOT NULL)  → SET NOT NULL, a no-op where it already holds;
--   * some historical jobs lack one (a database migrated from a legacy shape
--     where 0000 had to ADD the column) → those rows are KEPT as they are,
--     and a CHECK added NOT VALID refuses a provider-less job from now on.
--     Inventing a provider for them would be guessing, so it is not done.
--
-- Nothing is dropped, deleted or rewritten. Idempotent.
-- =====================================================================

DO $provider$
DECLARE
  missing bigint;
  nullable boolean;
BEGIN
  IF to_regclass('public.generation_jobs') IS NULL THEN RETURN; END IF;

  SELECT is_nullable = 'YES' INTO nullable
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'generation_jobs' AND column_name = 'provider';
  IF NOT nullable THEN
    RAISE NOTICE '[0004] generation_jobs.provider is already NOT NULL.';
    RETURN;
  END IF;

  SELECT count(*) INTO missing FROM generation_jobs WHERE provider IS NULL;
  IF missing = 0 THEN
    ALTER TABLE generation_jobs ALTER COLUMN provider SET NOT NULL;
    RAISE NOTICE '[0004] generation_jobs.provider is now NOT NULL.';
  ELSE
    BEGIN
      ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_provider_present
        CHECK (provider IS NOT NULL) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    RAISE WARNING '[0004] % historical job(s) have no provider: kept unchanged; new jobs must name one.', missing;
  END IF;
END;
$provider$;
