// generate-video: kicks off asynchronous AI video generation.
//
// Videos are rendered by the external MoneyPrinterTurbo microservice (Edge
// Functions can't run Python/ffmpeg). This function:
//   1. authenticates the user,
//   2. creates a video_jobs row (status=pending),
//   3. submits the render to MoneyPrinterTurbo (POST /api/v1/videos),
//   4. stores the returned task id (status=processing) and returns the job id.
// The dashboard then polls `video-status` until the video is ready.
//
// It never blocks waiting for the render to finish.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin, getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import {
  getMoneyPrinterBaseUrl,
  submitVideoJob,
  type VideoAspect,
} from "../_shared/moneyprinter.ts";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const SUBMIT_TIMEOUT_MS = 30_000;

function normaliseAspect(value: unknown): VideoAspect {
  const v = String(value || "").trim();
  if (v === "16:9" || v === "1:1" || v === "9:16") return v;
  // Friendly aliases from the UI.
  if (/landscape|paysage/i.test(v)) return "16:9";
  if (/square|carr/i.test(v)) return "1:1";
  return "9:16"; // default: vertical short (TikTok / Shorts / Reels)
}

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });

  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) return jsonResponse({ error: "Payload too large" }, { status: 413, cors });

  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  if (!getMoneyPrinterBaseUrl()) {
    return jsonResponse(
      {
        error: "Génération vidéo indisponible : le microservice n'est pas configuré. Définissez MONEYPRINTER_API_URL dans les secrets Supabase (Edge Functions → Secrets).",
        code: "missing_service_url",
      },
      { status: 503, cors },
    );
  }

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (_err) {
    return jsonResponse({ error: "Server misconfigured (missing Supabase server configuration)" }, { status: 500, cors });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = String(body.subject || body.topic || "").trim().slice(0, 500);
  const script = String(body.script || "").trim().slice(0, 4000);
  const aspect = normaliseAspect(body.aspect || body.format);
  const clipDurationSeconds = Number(body.clipDurationSeconds || body.duration || 5);
  const voiceName = body.voiceName ? String(body.voiceName).trim() : undefined;
  const subtitlesEnabled = body.subtitlesEnabled === undefined ? true : Boolean(body.subtitlesEnabled);
  const paragraphNumber = Number(body.paragraphNumber || 1);
  const postId = body.postId ? String(body.postId) : null;

  if (!subject && !script) {
    return jsonResponse({ error: "Un sujet ou un script est requis pour générer une vidéo." }, { status: 400, cors });
  }

  const generationInput = {
    subject: subject || script.slice(0, 200),
    script: script || undefined,
    aspect,
    clipDurationSeconds,
    voiceName,
    subtitlesEnabled,
    paragraphNumber,
  };

  // 1) Create the job row up-front so the frontend has an id even if the
  //    submit call is slow. status=pending.
  const { data: job, error: insertErr } = await admin
    .from("video_jobs")
    .insert({
      user_id: userId,
      post_id: postId,
      status: "pending",
      subject: generationInput.subject,
      aspect,
      params: generationInput,
    })
    .select("id")
    .single();

  if (insertErr || !job) {
    console.error("generate-video: failed to create job row:", insertErr);
    return jsonResponse({ error: "Impossible de créer le job vidéo." }, { status: 500, cors });
  }

  // 2) Submit to MoneyPrinterTurbo (short timeout — this only enqueues).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  let submit;
  try {
    submit = await submitVideoJob(generationInput, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (!submit.taskId) {
    await admin
      .from("video_jobs")
      .update({ status: "failed", error_message: submit.error || "Soumission au moteur vidéo échouée." })
      .eq("id", job.id)
      .eq("user_id", userId);
    console.warn("generate-video: submit failed:", submit.error);
    return jsonResponse(
      { error: submit.error || "La soumission au moteur vidéo a échoué.", code: "submit_failed", jobId: job.id },
      { status: 200, cors },
    );
  }

  // 3) Accepted — store the task id and mark processing.
  await admin
    .from("video_jobs")
    .update({ status: "processing", external_task_id: submit.taskId, progress: 1 })
    .eq("id", job.id)
    .eq("user_id", userId);

  return jsonResponse(
    { jobId: job.id, taskId: submit.taskId, status: "processing", aspect },
    { status: 200, cors },
  );
});
