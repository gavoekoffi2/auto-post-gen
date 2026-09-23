// Small helpers for the transactional emails. Every value interpolated into
// an email body goes through escapeHtml: company names, notes and payment
// references are user-supplied.

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** One visual frame for every transactional email. `bodyHtml` is trusted markup. */
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
  return `${amount.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ")} FCFA`;
}

/** Dates in emails are read in West Africa; Abidjan is UTC all year. */
export function formatDateFr(value: Date | string): string {
  return new Date(value).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Abidjan",
  });
}
