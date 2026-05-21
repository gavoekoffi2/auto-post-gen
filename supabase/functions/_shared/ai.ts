// Shared AI provider helper. Uses OpenRouter (OpenAI-compatible API)
// configured via Supabase secrets:
//   OPENROUTER_API_KEY        — required
//   OPENROUTER_TEXT_MODEL     — optional, defaults to google/gemini-2.5-flash
//   OPENROUTER_IMAGE_MODEL    — optional, defaults to google/gemini-2.5-flash-image-preview
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
  return Deno.env.get("OPENROUTER_TEXT_MODEL") || "google/gemini-2.5-flash";
}

export function getImageModels(): string[] {
  const configured = Deno.env.get("OPENROUTER_IMAGE_MODEL");
  // We always try a chain so a single model failure doesn't kill image gen.
  const chain = [
    configured,
    "google/gemini-2.5-flash-image-preview",
    "google/gemini-2.5-flash",
  ].filter(Boolean) as string[];
  // De-dupe while preserving order.
  return Array.from(new Set(chain));
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
  modalities?: string[];
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
  if (opts.modalities) body.modalities = opts.modalities;

  const envTimeout = parseInt(Deno.env.get("IMAGE_GENERATION_TIMEOUT_MS") || "0", 10);
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

// Tries each model in the chain until one returns an image URL or data: URL.
export async function generateImageUrl(
  promptText: string,
  models?: string[],
): Promise<{ imageUrl: string | null; lastError: string | null }> {
  const chain = models && models.length > 0 ? models : getImageModels();
  let lastError: string | null = null;
  for (const model of chain) {
    try {
      const resp = await chatCompletion({
        model,
        messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
        modalities: ["image", "text"],
      });
      if (!resp.ok) {
        lastError = `${model} ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
        continue;
      }
      const data = await resp.json();
      const candidate =
        data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
        data?.choices?.[0]?.message?.image_url?.url ||
        null;
      if (candidate) return { imageUrl: candidate, lastError: null };
      lastError = `${model} returned no image`;
    } catch (err) {
      lastError = `${model} threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { imageUrl: null, lastError };
}
