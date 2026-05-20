// Shared CORS helpers for all edge functions.
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function buildCorsHeaders(origin: string | null): Record<string, string> {
  const wildcard = allowedOrigins.includes("*");
  const allowed = wildcard || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : wildcard ? "*" : allowedOrigins[0] || "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    Vary: "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; cors?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      ...(init.cors || {}),
      "Content-Type": "application/json",
    },
  });
}
