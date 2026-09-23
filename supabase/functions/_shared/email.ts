// Transactional email through Resend, for the functions that notify a person
// as a side effect of their real job (a subscription request, a trial
// reminder). Sending never throws: the caller decides whether a failed email
// matters, and most of the time the database write it accompanies does not
// depend on it.
//
//   RESEND_API_KEY / RESEND_FROM — required to send anything
//   CONTACT_TO                   — the operator inbox (defaults to RESEND_FROM)
//   APP_BASE_URL                 — used to build links back into the app

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface EmailConfig {
  apiKey: string;
  from: string;
  operatorTo: string;
  appUrl: string;
}

/** null when email is not configured — callers log and carry on. */
export function getEmailConfig(): EmailConfig | null {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    operatorTo: Deno.env.get("CONTACT_TO") || (from.match(/<([^>]+)>/)?.[1] ?? from),
    appUrl: (Deno.env.get("APP_BASE_URL") || "").replace(/\/+$/, ""),
  };
}

export async function sendEmail(
  config: EmailConfig,
  message: { to: string; subject: string; html: string; replyTo?: string },
): Promise<boolean> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      console.error("sendEmail: Resend failed:", resp.status, (await resp.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendEmail: could not send:", err);
    return false;
  }
}

/** Minimal branded wrapper so every transactional email looks the same. */
export function emailLayout(title: string, bodyHtml: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111827;">
      <h2 style="color:#1e3a8a;margin-bottom:16px;">${escapeHtml(title)}</h2>
      ${bodyHtml}
      <p style="color:#6b7280;font-size:12px;margin-top:32px;">Pro Social AI</p>
    </div>
  `;
}

export function formatFcfa(amount: number): string {
  return `${amount.toLocaleString("fr-FR").replace(/ | /g, " ")} FCFA`;
}
