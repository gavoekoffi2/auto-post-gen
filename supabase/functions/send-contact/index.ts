// deno-lint-ignore-file no-explicit-any
//
// send-contact: delivers the public contact form to the operator's inbox
// via Resend. Public endpoint (verify_jwt = false) so anonymous visitors
// can reach it; protected by strict input validation + a honeypot field.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY  — required to actually send.
//   RESEND_FROM     — verified sender, e.g. "Pro Social AI <no-reply@domain>".
//   CONTACT_TO      — where messages land (defaults to RESEND_FROM address).
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const wildcard = allowedOrigins.includes("*");
  const allowed = wildcard || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : wildcard ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body: any = await req.json().catch(() => ({}));

    // Honeypot: real users never fill this hidden field. Pretend success.
    if (typeof body.company === "string" && body.company.trim() !== "") {
      return json({ ok: true });
    }

    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim();
    const subject = String(body.subject ?? "").trim();
    const message = String(body.message ?? "").trim();

    if (!name || name.length > 100) {
      return json({ error: "Nom invalide." }, 400);
    }
    if (!email || email.length > 200 || !EMAIL_RE.test(email)) {
      return json({ error: "Email invalide." }, 400);
    }
    if (!message || message.length > 5000) {
      return json({ error: "Message invalide (1–5000 caractères)." }, 400);
    }
    if (subject.length > 200) {
      return json({ error: "Sujet trop long." }, 400);
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromAddress = Deno.env.get("RESEND_FROM");
    if (!resendApiKey || !fromAddress) {
      // Not configured yet: tell the client so it can show the support email.
      return json(
        { error: "Service de messagerie non configuré.", code: "not_configured" },
        503,
      );
    }
    const toAddress =
      Deno.env.get("CONTACT_TO") ||
      // Extract the address from a "Name <addr>" RESEND_FROM if present.
      (fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress);

    const safeSubject = subject || "Sans sujet";
    const html = `
      <h2>Nouveau message de contact — Pro Social AI</h2>
      <p><strong>Nom :</strong> ${escapeHtml(name)}</p>
      <p><strong>Email :</strong> ${escapeHtml(email)}</p>
      <p><strong>Sujet :</strong> ${escapeHtml(safeSubject)}</p>
      <hr />
      <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    `;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toAddress],
        reply_to: email,
        subject: `[Contact] ${safeSubject}`,
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Resend send failed:", resp.status, text.slice(0, 300));
      return json({ error: "Échec de l'envoi du message." }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error("send-contact error:", err);
    return json({ error: "Erreur serveur." }, 500);
  }
});
