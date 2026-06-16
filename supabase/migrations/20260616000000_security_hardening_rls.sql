-- =====================================================================
-- Security hardening (senior audit, 2026-06-16)
--
-- The browser talks to Postgres with the public anon key, so RLS +
-- column privileges are the ONLY controls protecting user data. This
-- migration closes three gaps found in the audit:
--   1. OAuth tokens / provider keys were SELECTable by the logged-in
--      client (access_token, refresh_token, profile_key).
--   2. UPDATE policies had no WITH CHECK, letting a user reassign their
--      own row to another user_id (cross-user row hijacking).
--   3. The due_validated_posts view ran with owner rights, so a future
--      grant could leak every user's posts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Never expose social tokens to the browser.
--    The frontend reads connection status through the zernio-status edge
--    function (service_role) and only ever DELETEs its own rows, so it
--    never needs to SELECT the secret columns. Revoke the blanket SELECT
--    and grant back only the non-secret display columns. service_role
--    keeps full access (it bypasses RLS + has its own grants), so all
--    edge functions continue to read tokens normally.
-- ---------------------------------------------------------------------
REVOKE SELECT ON public.social_connections FROM anon, authenticated;
GRANT SELECT (
  id,
  user_id,
  platform,
  provider,
  account_id,
  account_username,
  account_name,
  token_expires_at,
  scopes,
  created_at,
  updated_at
) ON public.social_connections TO authenticated;

-- ---------------------------------------------------------------------
-- 2. Add WITH CHECK to every UPDATE policy so the row that results from
--    an UPDATE must still belong to the caller. Without it, a user can
--    `update ... set user_id = '<victim>'` and move their row into
--    another account. Drop + recreate to stay idempotent.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;
CREATE POLICY "Users can update their own posts"
  ON public.posts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update their own social connections" ON public.social_connections;
CREATE POLICY "Users can update their own social connections"
  ON public.social_connections FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own comments" ON public.social_comments;
CREATE POLICY "Users can update their own comments"
  ON public.social_comments FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 3. Make the publisher's helper view respect the caller's RLS. It stays
--    granted to service_role only (which bypasses RLS, so the cron keeps
--    seeing every due post), but if it is ever exposed to authenticated
--    by mistake, security_invoker ensures users see only their own posts.
-- ---------------------------------------------------------------------
ALTER VIEW public.due_validated_posts SET (security_invoker = true);
