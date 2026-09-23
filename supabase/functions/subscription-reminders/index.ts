// subscription-reminders: emails each account once before its free trial or
// paid period ends, so nobody discovers the end by finding generation paused.
//
// There is no automatic debit (payments are Mobile Money transfers declared
// by the customer), so a paid month simply runs out. Without this reminder
// every renewal would depend on the customer remembering the date.
//
// Cron-only, protected by CRON_SECRET. Recommended cadence: daily (hourly is
// harmless — each end date is reminded at most once).
//
// Secrets: CRON_SECRET, RESEND_API_KEY, RESEND_FROM, APP_BASE_URL.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { emailLayout, escapeHtml, getEmailConfig, sendEmail } from "../_shared/email.ts";
import { ENTITLEMENT_COLUMNS, resolveEntitlement } from "../_shared/plans.ts";

// How far ahead each kind of end date is announced.
const TRIAL_NOTICE_MS = 2 * 24 * 60 * 60 * 1000;
const PERIOD_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;
const BATCH = 200;

type Row = {
  id: string;
  email: string | null;
  company_name: string | null;
  plan: string | null;
  subscription_status: string | null;
  trial_plan: string | null;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Africa/Abidjan",
  });
}

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });
  }

  // Fail CLOSED: verify_jwt is off, so a missing secret must deny everything.
  const expectedSecret = Deno.env.get("CRON_SECRET");
  if (!expectedSecret) {
    console.error("CRON_SECRET is not configured; refusing to run.");
    return jsonResponse({ error: "Service unavailable" }, { status: 503, cors });
  }
  const provided =
    req.headers.get("x-cron-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, cors });
  }

  const email = getEmailConfig();
  if (!email) {
    // Nothing is marked as sent, so every reminder goes out once email works.
    console.error("subscription-reminders: email not configured; nothing sent");
    return jsonResponse({ sent: 0, reason: "email_not_configured" }, { cors });
  }

  const admin = getSupabaseAdmin();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const columns = `id, email, company_name, ${ENTITLEMENT_COLUMNS}`;

  const [trials, periods] = await Promise.all([
    admin
      .from("profiles")
      .select(columns)
      .eq("subscription_status", "trialing")
      .is("expiry_reminder_sent_at", null)
      .gt("trial_ends_at", nowIso)
      .lte("trial_ends_at", new Date(now + TRIAL_NOTICE_MS).toISOString())
      .limit(BATCH),
    admin
      .from("profiles")
      .select(columns)
      .eq("subscription_status", "active")
      .is("expiry_reminder_sent_at", null)
      .gt("current_period_ends_at", nowIso)
      .lte("current_period_ends_at", new Date(now + PERIOD_NOTICE_MS).toISOString())
      .limit(BATCH),
  ]);
  if (trials.error || periods.error) {
    console.error("subscription-reminders query:", trials.error || periods.error);
    return jsonResponse({ error: "Query failed" }, { status: 500, cors });
  }

  const link = email.appUrl ? `${email.appUrl}/abonnement` : "";
  let sent = 0;
  let failed = 0;

  for (const row of [...(trials.data || []), ...(periods.data || [])] as Row[]) {
    if (!row.email) continue;
    const entitlement = resolveEntitlement(row, now);
    if (entitlement.state === "expired" || !entitlement.endsAt) continue;

    const isTrial = entitlement.state === "trialing";
    const when = formatDate(entitlement.endsAt);
    const subject = isTrial
      ? `Votre essai gratuit Pro Social AI se termine ${when}`
      : `Votre abonnement Pro Social AI arrive à échéance ${when}`;
    const intro = isTrial
      ? `Votre essai gratuit du forfait <strong>${escapeHtml(entitlement.limits.label)}</strong> se termine
         <strong>${escapeHtml(when)}</strong>. Pour continuer à générer vos posts et affiches sans
         interruption, choisissez votre forfait dès maintenant — le paiement se fait par Wave,
         Orange Money ou MTN Mobile Money.`
      : `Votre abonnement <strong>${escapeHtml(entitlement.limits.label)}</strong> arrive à échéance
         <strong>${escapeHtml(when)}</strong>. Renouvelez-le pour que la génération de vos posts
         continue sans interruption.`;

    const ok = await sendEmail(email, {
      to: row.email,
      subject,
      html: emailLayout(
        isTrial ? "Votre essai se termine bientôt" : "Votre abonnement arrive à échéance",
        `<p>Bonjour${row.company_name ? ` ${escapeHtml(row.company_name)}` : ""},</p>
         <p>${intro}</p>
         <p>Sans renouvellement, vos posts déjà programmés seront quand même publiés ;
         seule la création de nouveaux contenus est mise en pause.</p>
         ${
           link
             ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1e3a8a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Choisir mon forfait</a></p>`
             : ""
         }`,
      ),
    });

    if (ok) {
      // Marked only after a successful send, and only for the end date that
      // was announced: if an approval moved it meanwhile, the next date gets
      // its own reminder.
      const endColumn = isTrial ? "trial_ends_at" : "current_period_ends_at";
      await admin
        .from("profiles")
        .update({ expiry_reminder_sent_at: nowIso })
        .eq("id", row.id)
        .eq(endColumn, entitlement.endsAt);
      sent += 1;
    } else {
      failed += 1;
    }
  }

  return jsonResponse({ sent, failed }, { status: failed > 0 && sent === 0 ? 502 : 200, cors });
});
