// health-alert: runs the platform self-diagnosis on a schedule and emails the
// operator when something is actually broken.
//
// The admin control plane can already show the diagnosis, but someone has to
// open it. This is the half that matters when nobody is looking: an expired
// API key, an exhausted credit balance or a cron that stopped firing reaches
// the operator's inbox instead of waiting for a customer to complain.
//
// Cron-only, protected by CRON_SECRET like the other scheduled entry points.
// Recommended cadence: hourly.
//
// Secrets:
//   CRON_SECRET        — required (shared with the Supabase Scheduler)
//   RESEND_API_KEY     — required to actually send; without it the run still
//                        reports, it just cannot notify (logged as a dry run)
//   RESEND_FROM        — verified sender
//   HEALTH_ALERT_TO    — recipient; defaults to CONTACT_TO, then RESEND_FROM
//   APP_BASE_URL       — used to link straight to /admin in the email
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { runHealthChecks, type HealthCheck } from "../_shared/health.ts";

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderRows(checks: HealthCheck[]): string {
  return checks
    .map(
      (check) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">
            ${escapeHtml(check.label)}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">
            ${escapeHtml(check.detail)}
            ${check.remedy ? `<br/><span style="color:#b45309;">→ ${escapeHtml(check.remedy)}</span>` : ""}
          </td>
        </tr>`,
    )
    .join("");
}

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });
  }

  // Fail CLOSED: verify_jwt is off, so a missing secret must deny everything.
  // This endpoint reveals which secrets are configured — never leave it open.
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const report = await runHealthChecks(admin);
  const failing = report.checks.filter((c) => c.status === "error");

  // Only a real failure is worth an email. Warnings are visible in /admin;
  // paging someone for them trains them to ignore the alerts that matter.
  if (failing.length === 0) {
    return jsonResponse({ status: report.status, alerted: false, checkedAt: report.checkedAt }, { cors });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const fromAddress = Deno.env.get("RESEND_FROM");
  if (!resendApiKey || !fromAddress) {
    console.error(
      `[DRY-RUN] ${failing.length} failing check(s) and no email configured: ` +
        failing.map((c) => `${c.label}: ${c.detail}`).join(" | "),
    );
    return jsonResponse(
      { status: report.status, alerted: false, reason: "email_not_configured", failing: failing.length },
      { cors },
    );
  }

  const toAddress =
    Deno.env.get("HEALTH_ALERT_TO") ||
    Deno.env.get("CONTACT_TO") ||
    (fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress);
  const appUrl = Deno.env.get("APP_BASE_URL") || "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="color:#b91c1c;">Pro Social AI — ${failing.length} point(s) bloquant(s)</h2>
      <p>Le diagnostic automatique a détecté des éléments qui empêchent la
      plateforme de fonctionner normalement pour vos utilisateurs.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${renderRows(failing)}
      </table>
      ${
        report.checks.some((c) => c.status === "warn")
          ? `<p style="color:#92400e;font-size:13px;">Des avertissements non bloquants sont également remontés — voir le centre de contrôle.</p>`
          : ""
      }
      ${appUrl ? `<p><a href="${escapeHtml(appUrl)}/admin">Ouvrir le centre de contrôle</a></p>` : ""}
      <p style="color:#6b7280;font-size:12px;">Diagnostic du ${escapeHtml(report.checkedAt)}.</p>
    </div>
  `;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toAddress],
        subject: `[Alerte] Pro Social AI — ${failing.length} point(s) bloquant(s)`,
        html,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error("health-alert: Resend failed:", resp.status, text.slice(0, 300));
      return jsonResponse(
        { status: report.status, alerted: false, reason: "email_failed", failing: failing.length },
        { status: 502, cors },
      );
    }
  } catch (err) {
    console.error("health-alert: could not send:", err);
    return jsonResponse(
      { status: report.status, alerted: false, reason: "email_error", failing: failing.length },
      { status: 502, cors },
    );
  }

  return jsonResponse(
    { status: report.status, alerted: true, failing: failing.map((c) => c.id), checkedAt: report.checkedAt },
    { cors },
  );
});
