// Shared client for the external MoneyPrinterTurbo microservice.
//
// MoneyPrinterTurbo (https://github.com/harry0703/MoneyPrinterTurbo) renders
// short videos (script → TTS → subtitles → music → montage). It CANNOT run
// inside a Supabase Edge Function (Python + ffmpeg + moviepy), so it is
// deployed as a separate container (Railway / Fly.io). These helpers talk to
// its REST API (FastAPI, prefix /api/v1):
//   POST /api/v1/videos          → { data: { task_id } }
//   GET  /api/v1/tasks/{task_id} → { data: { state, progress, videos, combined_videos } }
//   GET  /api/v1/download/{path} → the rendered file bytes
//
// Config (Supabase secrets):
//   MONEYPRINTER_API_URL  — base URL of the microservice, e.g.
//                           https://my-mpt.up.railway.app  (required)
//   MONEYPRINTER_API_KEY  — optional shared secret sent as a Bearer token
//                           when the microservice is put behind an auth proxy.

export function getMoneyPrinterBaseUrl(): string | null {
  const url = (Deno.env.get("MONEYPRINTER_API_URL") || "").trim().replace(/\/+$/, "");
  return url || null;
}

function moneyPrinterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = (Deno.env.get("MONEYPRINTER_API_KEY") || "").trim();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// MoneyPrinterTurbo task states (see app/models/const.py). We normalise them
// to our own video_jobs.status values.
const MPT_STATE = {
  FAILED: -1,
  COMPLETE: 1,
  PROCESSING: 4,
} as const;

export type VideoAspect = "9:16" | "16:9" | "1:1";

export interface GenerateVideoInput {
  subject: string;
  script?: string;
  aspect: VideoAspect;
  clipDurationSeconds?: number;
  voiceName?: string;
  subtitlesEnabled?: boolean;
  paragraphNumber?: number;
  videoSource?: string; // "pexels" (default) | "pixabay"
}

// Build the MoneyPrinterTurbo VideoParams body from our simplified input.
// Only well-documented fields are sent; everything else uses MPT defaults
// (which read the microservice's own config.toml — LLM key, Pexels key, TTS).
export function buildVideoParams(input: GenerateVideoInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    video_subject: input.subject.slice(0, 500),
    video_aspect: input.aspect,
    video_concat_mode: "random",
    video_clip_duration: Math.min(Math.max(input.clipDurationSeconds ?? 5, 2), 10),
    video_count: 1,
    video_source: input.videoSource || "pexels",
    subtitle_enabled: input.subtitlesEnabled ?? true,
    paragraph_number: Math.min(Math.max(input.paragraphNumber ?? 1, 1), 10),
  };
  // Let MoneyPrinterTurbo write the script from the subject when none is given.
  if (input.script && input.script.trim()) params.video_script = input.script.slice(0, 4000);
  if (input.voiceName && input.voiceName.trim()) params.voice_name = input.voiceName.trim();
  return params;
}

export interface SubmitVideoResult {
  taskId: string | null;
  error: string | null;
  status: number;
}

// POST /api/v1/videos — submit a render job. Returns the MPT task id.
export async function submitVideoJob(
  input: GenerateVideoInput,
  signal?: AbortSignal,
): Promise<SubmitVideoResult> {
  const base = getMoneyPrinterBaseUrl();
  if (!base) return { taskId: null, error: "MONEYPRINTER_API_URL not configured", status: 0 };
  try {
    const resp = await fetch(`${base}/api/v1/videos`, {
      method: "POST",
      headers: moneyPrinterHeaders(),
      body: JSON.stringify(buildVideoParams(input)),
      signal,
    });
    const text = await resp.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!resp.ok) {
      return { taskId: null, error: moneyPrinterError(resp.status, data, text), status: resp.status };
    }
    const taskId = extractTaskId(data);
    if (!taskId) {
      return { taskId: null, error: `MoneyPrinterTurbo returned no task_id: ${text.slice(0, 160)}`, status: resp.status };
    }
    return { taskId, error: null, status: resp.status };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      taskId: null,
      error: isAbort ? "MoneyPrinterTurbo a mis trop de temps à accepter la demande." : `MoneyPrinterTurbo inaccessible: ${err instanceof Error ? err.message : String(err)}`,
      status: 0,
    };
  }
}

export interface VideoJobStatus {
  state: "processing" | "done" | "failed" | "unknown";
  progress: number;
  // Relative file path(s) on the microservice, used with GET /download/{path}.
  filePath: string | null;
  raw: unknown;
  error: string | null;
}

// GET /api/v1/tasks/{task_id} — read the current render state.
export async function getVideoJobStatus(taskId: string, signal?: AbortSignal): Promise<VideoJobStatus> {
  const base = getMoneyPrinterBaseUrl();
  if (!base) return { state: "failed", progress: 0, filePath: null, raw: null, error: "MONEYPRINTER_API_URL not configured" };
  try {
    const resp = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: moneyPrinterHeaders(),
      signal,
    });
    const text = await resp.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (resp.status === 404) {
      return { state: "failed", progress: 0, filePath: null, raw: data, error: "Tâche introuvable sur MoneyPrinterTurbo (expirée ou supprimée)." };
    }
    if (!resp.ok) {
      return { state: "processing", progress: 0, filePath: null, raw: data, error: moneyPrinterError(resp.status, data, text) };
    }
    const payload = (data && typeof data === "object" ? (data as Record<string, unknown>).data : null) as Record<string, unknown> | null;
    const stateNum = typeof payload?.state === "number" ? payload.state : undefined;
    const progress = typeof payload?.progress === "number" ? payload.progress : 0;
    const filePath = extractVideoFilePath(payload);
    let state: VideoJobStatus["state"] = "processing";
    if (stateNum === MPT_STATE.FAILED) state = "failed";
    else if (stateNum === MPT_STATE.COMPLETE || filePath) state = "done";
    else if (stateNum === MPT_STATE.PROCESSING) state = "processing";
    else if (stateNum === undefined) state = "unknown";
    return { state, progress, filePath, raw: data, error: state === "failed" ? "Le rendu vidéo a échoué côté MoneyPrinterTurbo." : null };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      state: "processing",
      progress: 0,
      filePath: null,
      raw: null,
      error: isAbort ? "Statut MoneyPrinterTurbo: délai dépassé." : `MoneyPrinterTurbo inaccessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Download the finished video bytes from the microservice.
export async function downloadVideo(filePath: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const base = getMoneyPrinterBaseUrl();
  if (!base) return null;
  // MPT returns absolute-ish paths; normalise to the download route.
  const clean = filePath.replace(/^\/+/, "");
  const candidates = [
    /^https?:\/\//i.test(filePath) ? filePath : null,
    `${base}/api/v1/download/${clean}`,
    `${base}/api/v1/stream/${clean}`,
  ].filter(Boolean) as string[];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: moneyPrinterHeaders(), signal });
      if (!resp.ok) continue;
      const contentType = (resp.headers.get("content-type") || "video/mp4").toLowerCase();
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length > 0) return { bytes, contentType };
    } catch (_err) {
      // try next candidate
    }
  }
  return null;
}

function extractTaskId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = obj.task_id || obj.taskId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const data = obj.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).task_id || (data as Record<string, unknown>).taskId;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

// MoneyPrinterTurbo stores the finished file under data.videos /
// data.combined_videos (arrays of paths). Prefer the combined (final) video.
function extractVideoFilePath(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const pick = (v: unknown): string | null => {
    if (Array.isArray(v) && v.length) {
      const first = v[v.length - 1];
      return typeof first === "string" && first.trim() ? first.trim() : null;
    }
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  return pick(payload.combined_videos) || pick(payload.videos) || null;
}

function moneyPrinterError(status: number, body: unknown, text: string): string {
  let detail = text.slice(0, 160);
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message) detail = message;
  }
  if (status === 429) return `MoneyPrinterTurbo saturé (429), file d'attente pleine. Réessayez dans un instant. ${detail}`;
  if (status === 400) return `Requête vidéo refusée par MoneyPrinterTurbo (400): ${detail}`;
  if (status === 401 || status === 403) return `Accès au microservice vidéo refusé (${status}). Vérifiez MONEYPRINTER_API_KEY. ${detail}`;
  return `MoneyPrinterTurbo a échoué (${status}). ${detail}`;
}
