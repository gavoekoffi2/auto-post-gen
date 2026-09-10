// Shared AI provider helper. Uses OpenRouter (OpenAI-compatible API)
// configured via Supabase secrets:
//   OPENROUTER_API_KEY        — required
//   OPENROUTER_TEXT_MODEL     — optional Claude override; non-Claude values are ignored
//   OPENROUTER_IMAGE_MODEL    — optional, defaults to google/gemini-2.5-flash-image
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
  return getTextModels()[0];
}

// Editorial text is intentionally Claude-only: the product promises Claude's
// writing quality, so an old Gemini/OpenAI secret must never silently
// downgrade it. But pinning a SINGLE slug meant that the day that slug is
// unavailable — renamed upstream, temporarily out of capacity, not enabled on
// the account — every generation fell through to the three canned fallback
// posts, and nothing in the product said so. The chain below stays entirely
// within Claude while giving the caller somewhere to go.
export function getTextModels(): string[] {
  const configured = Deno.env.get("OPENROUTER_TEXT_MODEL")?.trim() || "";
  if (configured && !configured.startsWith("anthropic/claude-")) {
    console.warn(`Ignoring non-Claude OPENROUTER_TEXT_MODEL: ${configured}`);
  }
  const chain = [
    configured.startsWith("anthropic/claude-") ? configured : "",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-3.7-sonnet",
  ].filter(Boolean);
  return Array.from(new Set(chain));
}

// HTTP statuses that mean "this particular model is not usable right now" as
// opposed to "the request or the account is bad". Only these are worth
// retrying on the next model in the chain: a 401 (bad key) or 402 (no credit)
// would fail identically on every model.
function isModelUnavailable(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 502 ||
    status === 503;
}

export function getImageModels(): string[] {
  const configured = Deno.env.get("OPENROUTER_IMAGE_MODEL");
  // Chain of image-OUTPUT-capable models (verified against OpenRouter's
  // catalogue). A single model failure (capacity, deprecation) falls through
  // to the next. Do not put text-only models here: they cannot return images
  // and would silently turn every generation into a branded fallback.
  // Production primary: Gemini Flash Image. GPT Image 2 is image-capable,
  // but in Supabase Edge Functions it can exceed the gateway timeout and
  // leave the dashboard spinning until a 504. Keep it as a fallback only.
  const chain = [
    configured,
    "google/gemini-2.5-flash-image",
    "openai/gpt-5.4-image-2",
    "google/gemini-3.1-flash-image-preview",
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

// Runs one completion, walking the Claude chain when a model is unavailable.
// Returns the raw Response of the attempt that answered, so callers that need
// the body themselves (generate-content) get the same resilience as chatText.
export async function chatCompletionWithFallback(
  opts: ChatCompletionOptions,
): Promise<Response> {
  // An explicit model pins the request; only the default path walks the chain.
  const chain = opts.model ? [opts.model] : getTextModels();
  let last: Response | null = null;
  for (const model of chain) {
    const resp = await chatCompletion({ ...opts, model });
    if (resp.ok || !isModelUnavailable(resp.status)) return resp;
    // Drain the body so the connection can be reused, and log why we moved on.
    const detail = (await resp.text()).slice(0, 200);
    console.warn(`Text model ${model} unavailable (${resp.status}): ${detail}`);
    last = new Response(detail, { status: resp.status });
  }
  return last ?? new Response("no text model configured", { status: 503 });
}

export async function chatText(opts: ChatCompletionOptions): Promise<string> {
  const resp = await chatCompletionWithFallback(opts);
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
  // Only accept data: image URLs or http(s) URLs that actually end in an image
  // extension. The previous catch-all `^https?://\S+` matched any URL, so a
  // model returning a text/citation link was mistaken for an image.
  return typeof value === "string" && (
    value.startsWith("data:image/") ||
    /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(value)
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
