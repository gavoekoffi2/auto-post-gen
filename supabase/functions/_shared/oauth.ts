// Shared OAuth state helpers. The state stores the authenticated user id
// so the callback can re-attach the connection to the right user, plus
// random entropy for CSRF protection.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

export function getSupabaseAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfigured");
  return createClient(url, key);
}

export function getAppBaseUrl(): string {
  return Deno.env.get("APP_BASE_URL") || "";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getHmacKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("OAUTH_STATE_SECRET") || Deno.env.get("CRON_SECRET");
  if (!secret) throw new Error("OAUTH_STATE_SECRET is not configured");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signState(payload: Record<string, unknown>): Promise<string> {
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ ...payload, ts: Date.now() })),
  );
  const key = await getHmacKey();
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `${body}.${base64UrlEncode(sig)}`;
}

export async function verifyState(
  token: string,
  maxAgeMs = 15 * 60 * 1000,
): Promise<Record<string, unknown>> {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Invalid state");
  const key = await getHmacKey();
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) throw new Error("Invalid state signature");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as
    Record<string, unknown> & { ts: number };
  if (Date.now() - payload.ts > maxAgeMs) throw new Error("State expired");
  return payload;
}

export async function getUserIdFromAuthHeader(
  authHeader: string | null,
): Promise<string | null> {
  if (!authHeader) return null;
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}

export interface OAuthConnectionPayload {
  userId: string;
  platform: "linkedin" | "facebook" | "instagram" | "twitter";
  accountId: string;
  accountUsername?: string | null;
  accountName?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string[];
  meta?: Record<string, unknown>;
}

export async function upsertConnection(payload: OAuthConnectionPayload) {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from("social_connections")
    .upsert(
      {
        user_id: payload.userId,
        platform: payload.platform,
        account_id: payload.accountId,
        account_username: payload.accountUsername ?? null,
        account_name: payload.accountName ?? null,
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken ?? null,
        token_expires_at: payload.tokenExpiresAt ?? null,
        scopes: payload.scopes ?? null,
        meta: payload.meta ?? {},
      },
      { onConflict: "user_id,platform,account_id" },
    );
  if (error) throw error;
}

export function htmlSuccessPage(platform: string): Response {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${platform} connecté</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a1a;color:#fff}
.card{background:#111133;border-radius:16px;padding:32px;text-align:center;max-width:420px}
h1{margin:0 0 12px 0;font-size:22px}
button{background:linear-gradient(135deg,#8B5CF6,#3B82F6);color:#fff;border:0;padding:10px 20px;border-radius:8px;font-size:14px;cursor:pointer}</style>
</head><body><div class="card"><h1>${platform} connecté ✓</h1>
<p>Vous pouvez fermer cet onglet et revenir à l'application.</p>
<button onclick="window.close()">Fermer</button>
<script>setTimeout(() => { try { window.close(); } catch(e){} }, 2500);</script>
</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function htmlErrorPage(message: string): Response {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Erreur</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a1a;color:#fff}
.card{background:#1a0a1a;border:1px solid #5a1a3a;border-radius:16px;padding:32px;text-align:center;max-width:520px}</style>
</head><body><div class="card"><h1>Connexion impossible</h1>
<p>${escapeForHtml(message)}</p>
<p>Vous pouvez fermer cet onglet et réessayer.</p>
</div></body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeForHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
