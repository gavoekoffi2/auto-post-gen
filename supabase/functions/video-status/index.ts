// video-status: refreshes the state of AI video jobs.
//
// Two modes (auth checked in-function; config.toml sets verify_jwt = false):
//   • User mode  — Authorization: Bearer <user JWT>, body { jobId }. Polls a
//                  single job owned by that user. Used by the dashboard.
//   • Cron mode  — x-cron-secret: <CRON_SECRET>. Batch-refreshes every active
//                  job. Lets you drive progress without an open browser tab
//                  (pair with Supabase Realtime on video_jobs for live UI).
//
// For each active job it queries MoneyPrinterTurbo (GET /api/v1/tasks/{id}).
// When the render is done it downloads the file, uploads it to Supabase
// Storage (user-assets) and sets status=done + video_url. On failure it
// records error_message. Never blocks on the render itself.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin, getUserIdFromAuthHeader } from "../_shared/oauth.ts";
import { downloadVideo, getVideoJobStatus } from "../_shared/moneyprinter.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const STATUS_TIMEOUT_MS = 30_000;
const CRON_BATCH_LIMIT = 20;

interface VideoJobRow {
  id: string;
  user_id: string;
  status: string;
  external_task_id: string | null;
  video_url: string | null;
  progress: number;
}

// Refresh one job against MoneyPrinterTurbo and persist the new state.
// Returns the updated public shape for the dashboard.
async function refreshJob(admin: SupabaseClient, job: VideoJobRow) {
  // Terminal states never change.
  if (job.status === "done" || job.status === "failed") {
    return { id: job.id, status: job.status, progress: job.progress, video_url: job.video_url };
  }
  if (!job.external_task_id) {
    return { id: job.id, status: job.status, progress: job.progress, video_url: job.video_url };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const status = await getVideoJobStatus(job.external_task_id, controller.signal);

    if (status.state === "failed") {
      await admin
        .from("video_jobs")
        .update({ status: "failed", error_message: status.error || "Rendu vidéo échoué." })
        .eq("id", job.id);
      return { id: job.id, status: "failed", progress: job.progress, video_url: null, error: status.error };
    }

    if (status.state === "done" && status.filePath) {
      const file = await downloadVideo(status.filePath, controller.signal);
      if (!file) {
        await admin
          .from("video_jobs")
          .update({ status: "failed", error_message: "Vidéo générée mais téléchargement depuis le moteur impossible." })
          .eq("id", job.id);
        return { id: job.id, status: "failed", progress: 99, video_url: null };
      }
      const ext = file.contentType.includes("webm") ? "webm" : "mp4";
      const path = `${job.user_id}/video-${job.id}-${Date.now()}.${ext}`;
      const { error: upErr } = await admin.storage
        .from("user-assets")
        .upload(path, file.bytes, { contentType: file.contentType, upsert: true });
      if (upErr) {
        console.error("video-status: upload failed:", upErr);
        // Not terminal: keep processing so the next poll can retry the upload.
        return { id: job.id, status: "processing", progress: 99, video_url: null };
      }
      const { data: pub } = admin.storage.from("user-assets").getPublicUrl(path);
      await admin
        .from("video_jobs")
        .update({ status: "done", progress: 100, video_url: pub.publicUrl, error_message: null })
        .eq("id", job.id);
      return { id: job.id, status: "done", progress: 100, video_url: pub.publicUrl };
    }

    // Still rendering — persist progress (monotonic) so the UI can advance.
    const progress = Math.max(job.progress, Math.min(status.progress || 0, 99));
    await admin.from("video_jobs").update({ status: "processing", progress }).eq("id", job.id);
    return { id: job.id, status: "processing", progress, video_url: null };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405, cors });

  let admin: SupabaseClient;
  try {
    admin = getSupabaseAdmin();
  } catch (_err) {
    return jsonResponse({ error: "Server misconfigured" }, { status: 500, cors });
  }

  // Cron batch mode: x-cron-secret authorises a sweep of all active jobs.
  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedCron = req.headers.get("x-cron-secret");
  const isCron = Boolean(cronSecret && providedCron && providedCron === cronSecret);

  if (isCron) {
    const { data: jobs } = await admin
      .from("video_jobs")
      .select("id, user_id, status, external_task_id, video_url, progress")
      .in("status", ["pending", "processing"])
      .not("external_task_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(CRON_BATCH_LIMIT);
    const results = [];
    for (const job of (jobs || []) as VideoJobRow[]) {
      try {
        results.push(await refreshJob(admin, job));
      } catch (err) {
        console.error("video-status cron: job refresh failed", job.id, err);
      }
    }
    return jsonResponse({ refreshed: results.length, jobs: results }, { status: 200, cors });
  }

  // User mode: refresh a single job the caller owns.
  const userId = await getUserIdFromAuthHeader(req.headers.get("Authorization"));
  if (!userId) return jsonResponse({ error: "Not authenticated" }, { status: 401, cors });

  const body = (await req.json().catch(() => ({}))) as { jobId?: string };
  const jobId = (body.jobId || "").trim();
  if (!jobId) return jsonResponse({ error: "jobId is required" }, { status: 400, cors });

  const { data: job, error } = await admin
    .from("video_jobs")
    .select("id, user_id, status, external_task_id, video_url, progress")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !job) return jsonResponse({ error: "Job introuvable." }, { status: 404, cors });

  try {
    const result = await refreshJob(admin, job as VideoJobRow);
    return jsonResponse(result, { status: 200, cors });
  } catch (err) {
    console.error("video-status: refresh error:", err);
    return jsonResponse({ id: jobId, status: "processing", error: "Statut temporairement indisponible." }, { status: 200, cors });
  }
});
