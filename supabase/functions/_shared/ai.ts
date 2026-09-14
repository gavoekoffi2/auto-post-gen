// Shared AI provider helper. Uses OpenRouter (OpenAI-compatible API)
// configured via Supabase secrets:
//   OPENROUTER_API_KEY        — required
//   OPENROUTER_TEXT_MODEL     — optional Claude override; non-Claude values are ignored
//   (no image model here: posters come exclusively from Graphiste GPT, see
//    supabase/functions/_shared/graphiste.ts)
//   APP_PUBLIC_URL / APP_NAME — optional, sent as HTTP-Referer and X-Title
//                               so OpenRouter's dashboard shows your usage cleanly
//
// The functions return raw OpenAI-style choices[0].message so callers can
// keep their existing extraction logic.

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function getOpenRouterKey(): string | null {
  return Deno.env.get("OPENROUTER_API_KEY") || null;
}

export function getTextModel(): string {
  const configured = Deno.env.get("OPENROUTER_TEXT_MODEL")?.trim() || "";
  // Editorial text is intentionally Claude-only: the product promises Claude's
  // writing quality. An old Gemini/OpenAI secret must not silently downgrade it.
  if (configured.startsWith("anthropic/claude-")) return configured;
  if (configured) console.warn(`Ignoring non-Claude OPENROUTER_TEXT_MODEL: ${configured}`);
  return "anthropic/claude-sonnet-5";
}

function attribution() {
  const url = Deno.env.get("APP_PUBLIC_URL") || Deno.env.get("APP_BASE_URL") || "";
  const name = Deno.env.get("APP_NAME") || "Pro Social AI";
  const headers: Record<string, string> = {};
  if (url) headers["HTTP-Referer"] = url;
  if (name) headers["X-Title"] = name;
  return headers;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<Response> {
  const key = getOpenRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");

  const body: Record<string, unknown> = {
    model: opts.model || getTextModel(),
    messages: opts.messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.top_p !== undefined) body.top_p = opts.top_p;

  // This client only does TEXT now (posters go through Graphiste GPT), so the
  // timeout knob is named for what it controls. IMAGE_GENERATION_TIMEOUT_MS is
  // still honoured for backward compatibility with existing deployments.
  const envTimeout = parseInt(
    Deno.env.get("AI_TEXT_TIMEOUT_MS") || Deno.env.get("IMAGE_GENERATION_TIMEOUT_MS") || "0",
    10,
  );
  const timeout = opts.timeoutMs ?? (envTimeout > 0 ? envTimeout : 60_000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...attribution(),
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Convenience: returns the assistant text or null. Handles common error
// codes (402 credit, 429 rate) by throwing typed errors the caller can
// catch and surface.
export class AIQuotaError extends Error {
  constructor(public code: "rate" | "credit") {
    super(code === "rate" ? "AI rate limit reached" : "AI credit exhausted");
    this.name = "AIQuotaError";
  }
}

export async function chatText(opts: ChatCompletionOptions): Promise<string> {
  const resp = await chatCompletion(opts);
  if (!resp.ok) {
    if (resp.status === 429) throw new AIQuotaError("rate");
    if (resp.status === 402) throw new AIQuotaError("credit");
    const text = await resp.text();
    throw new Error(`AI ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}
