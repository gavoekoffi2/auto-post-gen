-- =====================================================================
-- Senior audit (2026-08-18, second pass): finish locking the profile row.
--
-- `profiles.plan` was already pinned (20260623000000). Two more columns on the
-- same row are server-owned or safety-relevant and were still fully writable by
-- the browser:
--
--   1. `email` is copied from auth.users by the handle_new_user trigger and is
--      the address send-validation-email delivers to — with the post content
--      and the one-click approval links in the body. A user could point their
--      own profile's email at somebody else's inbox and have our domain mail
--      them unsolicited content, burning sender reputation.
--
--   2. `custom_image_urls` becomes `posts.image_url`, which server-side code
--      fetches. The fetch itself is SSRF-guarded (_shared/safeFetch.ts), and
--      the only supported way to fill this list is the uploader, which always
--      produces an https Supabase Storage URL. Rejecting anything that is not
--      https at write time keeps a hostile value out of the table in the first
--      place, rather than relying on every future reader to be careful.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.guard_profile_server_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  url text;
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    -- The account address belongs to auth.users, not to the profile editor.
    -- COALESCE so a row that somehow has no email can still receive the value
    -- the client already sends (SettingsDialog upserts session.user.email),
    -- while an address that is already set can never be changed from here.
    IF TG_OP = 'UPDATE' THEN
      NEW.email := COALESCE(OLD.email, NEW.email);
    END IF;

    -- Custom image library: https only, and a sane ceiling on the list.
    IF NEW.custom_image_urls IS NOT NULL THEN
      IF array_length(NEW.custom_image_urls, 1) > 200 THEN
        RAISE EXCEPTION 'Too many custom images (200 max)'
          USING ERRCODE = 'check_violation';
      END IF;
      FOREACH url IN ARRAY NEW.custom_image_urls LOOP
        IF url IS NOT NULL AND url <> '' AND url NOT LIKE 'https://%' THEN
          RAISE EXCEPTION 'Custom image URLs must be https'
            USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_server_columns_ins ON public.profiles;
CREATE TRIGGER guard_profile_server_columns_ins
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_server_columns();

DROP TRIGGER IF EXISTS guard_profile_server_columns_upd ON public.profiles;
CREATE TRIGGER guard_profile_server_columns_upd
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_server_columns();
