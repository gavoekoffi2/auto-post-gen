-- =====================================================================
-- inspect-legacy-schema.sql — READ ONLY. Run this BEFORE migrating.
--
--   psql "$DATABASE_URL" -f server/scripts/inspect-legacy-schema.sql
--
-- Every statement is a SELECT. It creates nothing, changes nothing and locks
-- nothing beyond a catalogue read, so it is safe on the live database — but
-- the sensible habit is still to run it on the restored COPY you are about to
-- rehearse the migration against.
--
-- What it answers:
--   1. which tables exist, and how many rows each holds;
--   2. what shape the account tables have (the cause of the 0001 failure);
--   3. how child rows are attached to an owner;
--   4. whether anything would collide with the new unique constraints;
--   5. which migrations this database has already recorded.
--
-- Compare the output with server/tests/fixtures/legacy_production_schema.sql.
-- If they differ in a way 0000 does not handle, that difference belongs in
-- both files before anyone deploys.
-- =====================================================================

\echo '=== 1. Tables and row counts ==='
SELECT c.relname AS table_name,
       to_char(c.reltuples, 'FM999G999G999') AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

\echo ''
\echo '=== 2. Account tables: columns of users and profiles ==='
SELECT table_name, ordinal_position AS pos, column_name, data_type,
       is_nullable, coalesce(column_default, '-') AS default_value
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('users', 'profiles')
 ORDER BY table_name, ordinal_position;

\echo ''
\echo '=== 3. The three questions that decide the migration path ==='
SELECT
  to_regclass('public.users') IS NOT NULL AS has_users_table,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='profiles' AND column_name='email') AS profiles_has_email,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='profiles' AND column_name='user_id') AS profiles_has_user_id,
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='users' AND column_name='profile_id') AS users_has_profile_id;

\echo ''
\echo '=== 4. Owner column of every child table (profile_id is the target) ==='
SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name IN ('profile_id', 'user_id', 'owner_id')
   AND table_name IN ('posts', 'media_assets', 'generation_jobs', 'social_connections',
                      'social_comments', 'generation_usage', 'audit_log')
 ORDER BY table_name, column_name;

\echo ''
\echo '=== 5. Identifier types (the new API passes uuids) ==='
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'id'
   AND table_name IN ('profiles', 'users', 'posts', 'media_assets',
                      'generation_jobs', 'social_connections')
 ORDER BY table_name;

\echo ''
\echo '=== 6. Legacy NOT NULL columns with no default ==='
\echo '    (the new API never writes these; migration 0000 drops the NOT NULL'
\echo '     and keeps the column and its data)'
SELECT c.table_name, c.column_name, c.data_type
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.is_nullable = 'NO'
   AND c.column_default IS NULL
   AND c.table_name IN ('profiles', 'posts', 'media_assets', 'generation_jobs', 'social_connections')
   AND c.column_name NOT IN ('id', 'content')
 ORDER BY c.table_name, c.column_name;

\echo ''
\echo '=== 7. Would anything collide with the new unique constraints? ==='
\echo '    Each of these MUST return zero rows, or migration 0000 stops.'

-- Each query is generated only if the table exists: \gexec runs the SQL that
-- the SELECT returns, so a missing legacy table prints a line instead of an
-- error. (A plain WHERE cannot guard a FROM.)

-- 7a. Two accounts sharing one email address (case-insensitively).
SELECT CASE WHEN to_regclass('public.users') IS NULL
  THEN $g$SELECT 'users: table not present' AS duplicate_email_check$g$
  ELSE $g$SELECT lower(email::text) AS duplicate_email, count(*) AS occurrences
            FROM users WHERE email IS NOT NULL
           GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20$g$
  END \gexec

-- 7b. Duplicate media paths (media_assets.storage_path becomes UNIQUE).
SELECT CASE WHEN to_regclass('public.media_assets') IS NULL
  THEN $g$SELECT 'media_assets: table not present' AS duplicate_path_check$g$
  ELSE $g$SELECT storage_path AS duplicate_storage_path, count(*) AS occurrences
            FROM media_assets GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20$g$
  END \gexec

\echo ''
\echo '=== 8. Password formats (this build reads scrypt: 128 hex chars + salt) ==='
SELECT CASE WHEN to_regclass('public.users') IS NULL
  THEN $g$SELECT 'users: table not present' AS password_formats$g$
  ELSE $g$SELECT count(*) FILTER (WHERE password_hash IS NULL) AS no_password,
                  count(*) FILTER (WHERE password_hash ~ '^[0-9a-f]{128}$') AS scrypt_compatible,
                  count(*) FILTER (WHERE password_hash IS NOT NULL
                                     AND password_hash !~ '^[0-9a-f]{128}$') AS needs_password_reset
             FROM users$g$
  END \gexec

\echo ''
\echo '=== 9. Migrations already recorded on this database ==='
SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL
  THEN $g$SELECT 'schema_migrations: none yet (this database has never been migrated)' AS applied$g$
  ELSE $g$SELECT filename, applied_at FROM schema_migrations ORDER BY filename$g$
  END \gexec

\echo ''
\echo '=== 10. Previous compatibility runs (empty before the first migration) ==='
SELECT CASE WHEN to_regclass('public.legacy_compat_report') IS NULL
  THEN $g$SELECT 'legacy_compat_report: not present (migration 0000 has never run here)' AS report$g$
  ELSE $g$SELECT step, detail, row_count, created_at FROM legacy_compat_report ORDER BY id$g$
  END \gexec
