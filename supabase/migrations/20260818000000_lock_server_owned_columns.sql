-- =====================================================================
-- Senior audit (2026-08-18): lock down the remaining user-writable
-- server-owned state.
--
-- The browser talks to Postgres with the public anon key, so RLS + column
-- privileges are the only controls. RLS answers "which ROWS?" — it never
-- answers "which COLUMNS?". Two gaps remained after the previous passes:
--
--   1. social_connections still granted INSERT to `authenticated`. Nothing in
--      the frontend inserts (it only SELECTs status columns and DELETEs to
--      disconnect) — every real insert goes through an edge function using the
--      service role. Meanwhile `profile_key` decides WHICH provider profile a
--      post is published through, so a user could insert
--        { user_id: <self>, provider: 'zernio', profile_key: <victim profile> }
--      and have publish-post push their content out of somebody else's
--      connected social accounts.
--
--   2. posts granted UPDATE on every column. The publisher's own bookkeeping
--      lives there: image_job_id / image_status_url (polled server-side with
--      the Graphiste API key), provider_post_id (drives stuck-publish
--      recovery), the validation-token columns (the emailed one-click
--      approval) and published_at. A user could rewrite any of it on their own
--      row, and could roll a row out of 'publishing' mid-flight — the exact
--      state the atomic claim in publish-post exists to protect.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. social_connections: writes are server-side only.
-- ---------------------------------------------------------------------
REVOKE INSERT ON public.social_connections FROM authenticated, anon;

-- The INSERT policy is now unreachable for these roles, but drop it so the
-- intent is readable from \dp and a future GRANT does not silently re-open the
-- hole.
DROP POLICY IF EXISTS "Users can insert their own social connections" ON public.social_connections;

-- ---------------------------------------------------------------------
-- 2. posts: keep server-owned columns server-owned.
--
--    A trigger rather than column grants, because the app legitimately writes
--    most of the row (title, content, platforms, scheduled_for, image_url,
--    status, content_category, publish_error) and only a handful of columns
--    must be pinned. Same shape as guard_profile_plan: the guard applies to the
--    PostgREST roles only, so edge functions (service_role) are unaffected.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_post_server_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A freshly created post carries no publishing history. validation_token is
    -- regenerated server-side rather than taken from the client, so an emailed
    -- approval link can never be pre-chosen by whoever created the row.
    NEW.validation_token          := gen_random_uuid();
    NEW.validation_token_created_at := NULL;
    NEW.validation_token_used_at  := NULL;
    NEW.validation_email_sent_at  := NULL;
    NEW.image_job_id              := NULL;
    NEW.image_status_url          := NULL;
    NEW.image_status              := NULL;
    NEW.provider_post_id          := NULL;
    NEW.external_post_ids         := '{}'::jsonb;
    NEW.published_at              := NULL;
    NEW.auto_publish_attempted_at := NULL;
    -- Client-created posts start as drafts awaiting review.
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      NEW.status := 'pending';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: pin every server-owned column to its stored value.
  NEW.validation_token          := OLD.validation_token;
  NEW.validation_token_created_at := OLD.validation_token_created_at;
  NEW.validation_token_used_at  := OLD.validation_token_used_at;
  NEW.validation_email_sent_at  := OLD.validation_email_sent_at;
  NEW.image_job_id              := OLD.image_job_id;
  NEW.image_status_url          := OLD.image_status_url;
  NEW.image_status              := OLD.image_status;
  NEW.provider_post_id          := OLD.provider_post_id;
  NEW.external_post_ids         := OLD.external_post_ids;
  NEW.published_at              := OLD.published_at;
  NEW.auto_publish_attempted_at := OLD.auto_publish_attempted_at;

  -- A post being published is owned by the publisher until it settles.
  -- Without this, a client could flip 'publishing' back to 'validated' while
  -- the external API call is still in flight and get the post sent twice.
  IF OLD.status = 'publishing' THEN
    RAISE EXCEPTION 'Post is being published and cannot be modified right now'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The UI only ever sets 'pending' (draft) or 'validated' (approved, queued
  -- for the publisher). 'publishing' / 'published' are publisher-owned states.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('pending', 'validated') THEN
    NEW.status := OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_post_server_columns_ins ON public.posts;
CREATE TRIGGER guard_post_server_columns_ins
  BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.guard_post_server_columns();

DROP TRIGGER IF EXISTS guard_post_server_columns_upd ON public.posts;
CREATE TRIGGER guard_post_server_columns_upd
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.guard_post_server_columns();

-- ---------------------------------------------------------------------
-- 3. Pin the search_path of the existing plan guard too. It runs as the
--    invoker (not SECURITY DEFINER), but an unqualified `plan` reference
--    resolving through a caller-controlled search_path is the classic way
--    these guards get bypassed. Cheap to make explicit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.plan := 'starter';
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.plan := OLD.plan;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
