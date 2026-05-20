# Pro Social AI — Production readiness & deployment guide

This document captures what the platform actually does today, what is
missing for a real production launch, and the concrete steps required to
get from the current state to a first-user release.

It is the result of a full code audit performed on the
`claude/audit-code-quality-BwSCh` branch. Read it before you flip the
switch.

---

## 1. What works today

- Email/password authentication (Supabase Auth)
- 7-step onboarding (sector, tone, frequency, description, style example,
  platforms, preferred days, image-people-type)
- AI text generation (Google Gemini via Lovable AI Gateway)
- AI image generation (with custom-image-library fallback)
- Posts CRUD: create, edit, validate, publish (manual), delete
- Calendar view with per-day post scheduling
- Statistics dashboard (totals, weekly chart, platform pie)
- Custom image library with per-user storage (RLS-enforced)
- Logo upload (RLS-enforced)
- Password reset and account deletion (including storage cleanup)

## 2. What is wired but needs configuration before launch

The platform is split into edge functions; each one needs the right
environment variables in the Supabase dashboard before deploying.

### Required Supabase secrets

| Secret | Used by | Purpose |
| --- | --- | --- |
| `LOVABLE_API_KEY` | `generate-content`, `auto-generate-weekly` | AI Gateway access |
| `SUPABASE_URL` | all server functions | (auto-provided) |
| `SUPABASE_SERVICE_ROLE_KEY` | all server functions | (auto-provided) |
| `CRON_SECRET` | `auto-generate-weekly`, `send-validation-email`, `publish-post` (cron) | Shared secret between Supabase Scheduler and the functions. Also used as the OAuth state HMAC secret if `OAUTH_STATE_SECRET` is unset. |
| `OAUTH_STATE_SECRET` | all `oauth-*` functions | (Optional) Dedicated HMAC secret for OAuth state tokens; defaults to `CRON_SECRET`. |
| `ALLOWED_ORIGINS` | all functions | Comma-separated list of origins (e.g. `https://app.example.com`). Defaults to `*` (DO NOT ship `*` to prod). |
| `RESEND_API_KEY` | `send-validation-email` | Email delivery |
| `RESEND_FROM` | `send-validation-email` | Verified sender (`Pro Social AI <no-reply@yourdomain.com>`) |
| `APP_BASE_URL` | `send-validation-email`, validation links | Where to point the validation link (e.g. `https://app.example.com`) — should be the front-end origin, not the Supabase URL. |
| `OAUTH_LINKEDIN_CLIENT_ID` / `OAUTH_LINKEDIN_CLIENT_SECRET` | `oauth-*-linkedin` | LinkedIn app credentials |
| `OAUTH_META_APP_ID` / `OAUTH_META_APP_SECRET` | `oauth-*-meta` | Meta (Facebook + Instagram) app credentials |
| `OAUTH_TWITTER_CLIENT_ID` / `OAUTH_TWITTER_CLIENT_SECRET` | `oauth-*-twitter` | Twitter/X app credentials (PKCE; secret only for confidential clients) |

### Frontend env (`.env`)

`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`
must be set. A sample is already committed in `.env`.

### Cron jobs (Supabase Scheduler)

Configure these in the Supabase dashboard, sending the header
`x-cron-secret: $CRON_SECRET` so the functions accept the call:

| Cadence | Endpoint | What it does |
| --- | --- | --- |
| Mondays, 06:00 UTC | `POST /functions/v1/auto-generate-weekly` | For every profile with `auto_publish=true`, generates the weekly batch. Posts are inserted as `validated`. |
| Mondays, 08:00 UTC | `POST /functions/v1/send-validation-email` | Emails any user with `pending` posts so they can validate them. |
| Every 15 minutes | `POST /functions/v1/publish-post` (no body) | Publishes any `validated` post whose `scheduled_for` is in the past. |

## 3. Social network publishing — the truth

**The previous codebase did NOT publish to social networks.** The old
`SocialMediaConnect.tsx` just stored usernames in a column and showed
"connected" — nothing was ever sent to Instagram/Facebook/etc. The
warning at the bottom of that dialog confirmed it ("vous devrez les
publier manuellement").

### What the audit changed

- New table `social_connections` stores per-user OAuth tokens, refresh
  tokens, scopes and metadata, isolated by RLS.
- New edge function `publish-post` implements actual publishing for
  LinkedIn (UGC API), Facebook Pages, Instagram (via the connected
  Facebook Page), Twitter/X. TikTok is stubbed because the Content
  Posting API is in limited access.
- The `SocialMediaConnect` dialog now opens a real OAuth flow per
  platform (a placeholder URL — see below).

### What you still need to do

The full OAuth start + callback edge functions are now implemented for
LinkedIn, Meta (Facebook + Instagram) and Twitter/X. To turn them on:

1. Create a developer app on each platform:
   - **LinkedIn**: https://www.linkedin.com/developers/apps — enable
     "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn".
   - **Meta** (Facebook + Instagram): https://developers.facebook.com/apps —
     add the Pages and Instagram Graph products. Request the
     `pages_manage_posts`, `instagram_content_publish`, etc. permissions
     via App Review (mandatory before launch).
   - **Twitter/X**: https://developer.twitter.com/en/portal — create an
     OAuth 2.0 app with PKCE, request `tweet.write`.
2. Set the OAuth redirect URI in each app to:
   - LinkedIn: `https://<project>.supabase.co/functions/v1/oauth-callback-linkedin`
   - Meta: `https://<project>.supabase.co/functions/v1/oauth-callback-meta`
   - Twitter: `https://<project>.supabase.co/functions/v1/oauth-callback-twitter`
3. Set the `OAUTH_*` secrets listed in §2 in the Supabase dashboard.
4. The `SocialMediaConnect` dialog will now open the correct OAuth flow
   when users click "Connecter".

### Can we use "private" APIs to avoid OAuth?

Yes, technically — projects like `instagrapi`, `tweepy` (scraping),
`facebook-scraper` interact with the platforms without their official
APIs. **We strongly recommend against it for a real product**:

- Violates every platform's Terms of Service → user accounts get banned.
- Requires storing user passwords in plaintext or near-plaintext →
  GDPR/CNIL violation and reputational disaster.
- Breaks on every UI/auth change shipped by the platform (sometimes
  weekly).
- All serious open-source schedulers (Postiz, Mixpost, Buffer-clone,
  Postybirb) use the official OAuth APIs.

If you choose to go down that road regardless, isolate the scraping
worker in a separate service and keep credentials in a dedicated vault
— do not put them in this codebase.

## 4. Critical issues fixed in this audit

| Severity | Issue | Status |
| --- | --- | --- |
| Critical | Preferred days saved as English IDs (`monday`) but auto-generator expected French names (`Lundi`) → scheduling always used default | Fixed (migration backfills existing rows; UI now stores French IDs) |
| Critical | `SettingsDialog` uploaded to `logos/<userid>-...` but storage RLS required `<userid>/...` → 403 on every upload | Fixed |
| Critical | All edge functions had `verify_jwt = false` and `CORS = *` → anyone could call them and burn AI credits | Fixed (`generate-content` now validates JWT in-function, others gated by `CRON_SECRET`, CORS driven by `ALLOWED_ORIGINS`) |
| Critical | Account deletion left storage files orphaned | Fixed (best-effort cleanup of `user-assets/<userid>/`) |
| Critical | `auto-generate-weekly` always inserted `status='pending'`, so even with `auto_publish=true` posts were never published | Fixed (auto-generated posts now go straight to `status='validated'`) |
| Critical | No validation token endpoint — the "Valider" links in emails went nowhere | Fixed (new `validate-post` function with TTL + single-use) |
| High | `send-validation-email` never sent emails | Fixed (Resend integration; falls back to dry-run logs if `RESEND_API_KEY` not set) |
| High | No real publish endpoint | Fixed (`publish-post` function — LinkedIn implemented, Meta/Twitter wired, TikTok stubbed) |
| High | Duplicate storage policies between migrations would create redundancy | Fixed (new migration cleans up) |
| Medium | Statistics showed "Publiés" but nothing set `status='published'` | Fixed |
| Medium | Auto-publish was a one-click toggle with no warning | Fixed (confirmation dialog) |
| Medium | No rate limiting on AI generation | Fixed (20 req/hour/user via `generation_usage` table) |
| Medium | Week-number calculations diverged between auto-generator and stats | Fixed (ISO 8601 in auto-generate-weekly) |
| Medium | Many `error: any` blocks | Cleaned up (`unknown` + `instanceof Error`) |

## 5. Remaining risks before launch

Things you should still address but that are out of scope of a pure
audit fix:

1. **TikTok**: the Content Posting API is in limited access. Either
   request a TikTok partnership or remove TikTok from the platform
   options shown to users.
2. **Email deliverability**: configure SPF/DKIM/DMARC for the Resend
   sending domain. Otherwise validation emails will go to spam.
3. **Image hosting**: when publishing to Instagram, the image URL must
   be publicly fetchable for hours. Supabase storage signed URLs are
   short-lived. Ensure custom-image URLs are stored with sufficient
   expiry, or upload images through the Graph API instead of URL-link
   posting.
4. **Bundle size**: the main bundle is 1.16 MB. Consider code-splitting
   the dashboard from the landing page (`React.lazy`) before serving
   real traffic.
5. **Account deletion**: handled by the `delete-account` edge function
   which uses the admin API to remove the `auth.users` row in addition
   to all app data and storage objects.
6. **Audit logging**: no audit table is present. If you need GDPR
   compliance, add an `audit_logs` table written on every mutation.
7. **Image moderation**: the AI image generator produces user-facing
   content. Add a moderation pass (Lovable or external) before posting
   if your terms of service require it.

## 6. Pre-launch checklist

- [ ] All Supabase secrets above are set (production project).
- [ ] `ALLOWED_ORIGINS` is your real domain, not `*`.
- [ ] `verify_jwt = true` on `generate-content`. The other functions
      keep `verify_jwt = false` because the gateway will refuse calls
      without a session token from your client, but they require
      `CRON_SECRET` for scheduled invocations.
- [ ] Supabase Scheduler is configured per §2.
- [ ] At least one of LinkedIn/Meta OAuth is fully implemented (start +
      callback) and produces a row in `social_connections`.
- [ ] Resend domain is verified, DKIM/SPF/DMARC set up.
- [ ] DNS for the app domain points at the hosting solution (Lovable,
      Vercel, Cloudflare Pages, etc.).
- [ ] Privacy policy and Terms updated to reflect what you actually
      collect (OAuth tokens, AI usage) — RGPD requirement.
- [ ] Backups: confirm the Supabase project has Point-in-Time Recovery
      or daily backups enabled.
- [ ] Smoke test: full flow (signup → onboarding → connect at least one
      OAuth → generate → validate → publish) on staging.

## 7. Local development

```sh
npm install
npm run dev
```

Lint and build before pushing:

```sh
npm run lint
npm run build
```

To run the Supabase migrations locally, you need the Supabase CLI:

```sh
supabase db reset
supabase functions serve generate-content --env-file .env.local
```
