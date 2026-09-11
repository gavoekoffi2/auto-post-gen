import { env } from "./env.js";
import { notConfigured } from "./errors.js";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/** True when outbound email is configured. Callers that can degrade check this. */
export function mailEnabled(): boolean {
  return Boolean(env.resendKey && env.resendFrom);
}

/**
 * Sends one transactional email.
 *
 * The subject is stripped of CR/LF before it reaches the provider: a line
 * break in a header field is the classic injection primitive, and the subject
 * is the one header that carries user-influenced text.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (!mailEnabled()) {
    throw notConfigured(
      "L'envoi d'email n'est pas configuré sur ce serveur (RESEND_API_KEY / RESEND_FROM).",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.resendFrom,
      to: [mail.to],
      subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 200),
      html: mail.html,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    // The provider's response goes to the logs, never to the user: it can
    // quote the recipient address and the API key's account.
    console.error("[mail] send failed:", response.status, detail);
    throw new Error(`mail send failed: ${response.status}`);
  }
}
