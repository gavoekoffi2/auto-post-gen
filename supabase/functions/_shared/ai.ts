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

function isImageUrl(value: unknown): value is string {
  return typeof value === "string" && (
    value.startsWith("data:image/") ||
    /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(value) ||
    /^https?:\/\/\S+/i.test(value)
  );
}

function extractImageUrlFromUnknown(value: unknown): string | null {
  if (!value) return null;
  if (isImageUrl(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImageUrlFromUnknown(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Common OpenAI/OpenRouter style shapes:
    // - { image_url: { url: "..." } }
    // - { image_url: "..." }
    // - { url: "..." }
    // - { b64_json: "..." }
    // - { data: "..." }
    const direct =
      extractImageUrlFromUnknown(obj.image_url) ||
      extractImageUrlFromUnknown(obj.url) ||
      extractImageUrlFromUnknown(obj.data) ||
      extractImageUrlFromUnknown(obj.output) ||
      extractImageUrlFromUnknown(obj.images) ||
      extractImageUrlFromUnknown(obj.content);
    if (direct) return direct;

    if (typeof obj.b64_json === "string" && obj.b64_json.length > 100) {
      return `data:image/png;base64,${obj.b64_json}`;
    }
    return null;
  }

  if (typeof value === "string") {
    // Some providers return markdown/text containing a URL or inline data URL.
    const dataMatch = value.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataMatch?.[0]) return dataMatch[0];
    const urlMatch = value.match(/https?:\/\/[^\s)"']+/);
    if (urlMatch?.[0]) return urlMatch[0];
  }

  return null;
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
        lastError = `${model} ${resp.status}: ${(await resp.text()).slice(0, 500)}`;
        continue;
      }
      const data = await resp.json();
      const message = data?.choices?.[0]?.message;
      const candidate =
        extractImageUrlFromUnknown(message?.images) ||
        extractImageUrlFromUnknown(message?.image_url) ||
        extractImageUrlFromUnknown(message?.content) ||
        extractImageUrlFromUnknown(data?.images) ||
        extractImageUrlFromUnknown(data?.data) ||
        extractImageUrlFromUnknown(data);
      if (candidate) return { imageUrl: candidate, lastError: null };
      lastError = `${model} returned no image. Response keys: ${Object.keys(data || {}).join(", ")}`;
    } catch (err) {
      lastError = `${model} threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { imageUrl: null, lastError };
}
