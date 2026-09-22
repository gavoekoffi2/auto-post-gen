-- =====================================================================
-- Keep public.profiles.email in step with the real account address.
--
-- profiles.email is written once by handle_new_user at signup, then only
-- refreshed as a side effect of saving the onboarding form or the quick
-- settings dialog. send-validation-email reads THAT copy to decide where to
-- send a user's weekly posts. So the moment an address changes anywhere else
-- — the admin API, a SQL fix, or the user changing it themselves — the
-- product keeps mailing the old address, silently, until the user happens to
-- re-save an unrelated form.
--
-- Syncing at the source makes the copy correct no matter who changes it.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only the confirmed address is propagated: GoTrue writes the pending one
  -- to email_change until the user clicks the confirmation link, and
  -- auth.users.email itself only moves once that happens.
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_profile_email_upd ON auth.users;
CREATE TRIGGER sync_profile_email_upd
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_email();

-- Repair rows that already drifted.
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE u.id = p.id
  AND p.email IS DISTINCT FROM u.email;
