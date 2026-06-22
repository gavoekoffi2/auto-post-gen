// Shared CORS helpers for all edge functions.
//
// Fail CLOSED: ALLOWED_ORIGINS must be configured (comma-separated list of
// exact origins, e.g. "https://app.example.com,https://example.com"). When it
// is unset we emit NO Access-Control-Allow-Origin header, so browsers block
// cross-origin calls instead of the previous wildcard "*" that exposed every
// JWT-authenticated function to any website. Set ALLOWED_ORIGINS="*" explicitly
// only for local development.
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function buildCorsHeaders(origin: string | null): Record<string, string> {
  const wildcard = allowedOrigins.includes("*");
  const allowed = wildcard || (!!origin && allowedOrigins.includes(origin));

  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    Vary: "Origin",
  };
  if (allowed && origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else if (wildcard) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  // Otherwise omit ACAO entirely → cross-origin requests are blocked.
  return headers;
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
