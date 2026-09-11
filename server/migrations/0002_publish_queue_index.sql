-- Publish queue: the index the runner's selection actually needs.
--
-- The runner selects due posts with
--   status = 'validated' AND scheduled_for <= now() AND next_publish_attempt_at <= now()
--   ORDER BY scheduled_for ASC LIMIT 12
-- on every tick. Without next_publish_attempt_at in the index, that predicate
-- is applied after the scan, so the queue degrades to a sequential scan over
-- the whole posts table as posts accumulate — on a schedule, forever.
--
-- Idempotent, and safe on a database that already carries the 0001 schema.

CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled
  ON posts (status, scheduled_for, next_publish_attempt_at)
  WHERE status = 'validated';

-- The dashboard's own listing (`WHERE profile_id = $1 ORDER BY created_at DESC`).
CREATE INDEX IF NOT EXISTS idx_posts_profile_created
  ON posts (profile_id, created_at DESC);
