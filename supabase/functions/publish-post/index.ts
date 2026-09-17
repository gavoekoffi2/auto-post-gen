// deno-lint-ignore-file no-explicit-any
//
// publish-post: publishes a single post (manual trigger from the dashboard)
// or a batch of due posts (cron trigger).
//
// Publishing goes through Zernio ONLY: Zernio holds the social tokens and fans
// a post out to every account connected under the user's Zernio profile, so the
// product has a single, predictable social backend.
//
// The direct per-platform OAuth publishers (LinkedIn UGC, Facebook Pages,
// Instagram Graph, Twitter v2) and the Ayrshare / Postiz paths used to live
// here but had been UNREACHABLE since the switch to Zernio-only — dead weight
// that also made the file read as if four more providers were supported. They
// were removed; `git log` still has them if a second provider is ever
// reinstated, and any reinstated version MUST route image fetches through
// _shared/safeFetch.ts (the old LinkedIn path used a raw fetch(), bypassing the
// SSRF guard every other image path in this codebase goes through).
//
// Concurrency: before doing any external API call, we atomically flip the
// post status from 'validated' to 'publishing' so concurrent cron + manual
// invocations can't double-publish.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { zernioCreatePost, zernioListAccounts } from "../_shared/zernio.ts";
import { resumePosterJob } from "../_shared/graphiste.ts";
import { fetchImageBytes } from "../_shared/safeFetch.ts";


type DbClient = SupabaseClient<any, "public", any>;

interface PostRow {
  id: string;
  user_id: string;
  content: string;
  platforms: string[] | null;
  image_url: string | null;
  image_job_id: string | null;
  image_status_url: string | null;
  image_status: string | null;
}

interface SocialConnectionRow {
  id?: string;
  user_id?: string;
  provider?: string | null;
  profile_key?: string | null;
}

interface PublishResult {
  platform: string;
  status: "ok" | "pending" | "error" | "not_implemented" | "not_connected";
  externalId?: string;
  externalUrl?: string;
  message?: string;
}

async function ensurePublicImage(
  supabase: DbClient,
  imageUrl: string,
  userId: string,
): Promise<string> {
  // If the URL already lives on our Supabase storage, return as-is.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (supabaseUrl && imageUrl.startsWith(supabaseUrl)) return imageUrl;

  let bytes: Uint8Array;
  let contentType = "image/jpeg";

  if (imageUrl.startsWith("data:")) {
    // Inline data URL ("data:image/png;base64,XXXX..."): decode in-place.
    const commaIdx = imageUrl.indexOf(",");
    if (commaIdx < 0) throw new Error("Invalid data URL");
    const meta = imageUrl.slice(5, commaIdx); // e.g. "image/png;base64"
    const payload = imageUrl.slice(commaIdx + 1);
    const isBase64 = meta.includes(";base64");
    contentType = (meta.split(";")[0] || contentType).toLowerCase();
    if (contentType.includes("svg")) throw new Error("Refusing SVG image");
    if (isBase64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Image too large");
  } else {
    // posts.image_url is user-writable, so this fetch is SSRF-guarded
    // (https-only, blocks private/metadata hosts, content-type + size cap).
    const fetched = await fetchImageBytes(imageUrl);
    bytes = fetched.bytes;
    contentType = fetched.contentType;
  }

  const ext = (contentType.split("/")[1] || "jpg").split(";")[0].replace(/[^a-z0-9]/gi, "") || "jpg";
  const path = `${userId}/published-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("user-assets")
    .upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
  return data.publicUrl;
}

function normalisePlatform(label: string): string {
  const map: Record<string, string> = {
    Instagram: "instagram",
    Facebook: "facebook",
    Twitter: "twitter",
    "Twitter (X)": "twitter",
    X: "twitter",
    LinkedIn: "linkedin",
    TikTok: "tiktok",
  };
  return map[label] || label.toLowerCase();
}

// Zernio publish: map requested platforms to the accounts connected under
// the user's Zernio profile, then publish to all of them in one call.
async function publishViaZernio(
  profileKey: string | null,
  platforms: string[],
  content: string,
  imageUrl: string | null,
  requestId: string,
): Promise<{ results: PublishResult[]; providerPostId: string | null }> {
  const results: PublishResult[] = [];
  try {
    const accounts = await zernioListAccounts(profileKey);
    const targets: Array<{ platform: string; accountId: string }> = [];
    for (const raw of platforms) {
      const platform = normalisePlatform(raw);
      const match = accounts.find(
        (a) => (a.platform || "").toLowerCase() === platform && a.isActive !== false,
      );
      if (match) targets.push({ platform, accountId: match._id });
      else results.push({ platform, status: "not_connected" });
    }
    if (targets.length === 0) return { results, providerPostId: null };

    const res = await zernioCreatePost({ content, imageUrl, platforms: targets, requestId });
    for (const result of res.results) {
      results.push(
        result.status === "ok"
          ? {
              platform: result.platform,
              status: "ok",
              externalId: result.externalId || result.id || res.id,
              externalUrl: result.externalUrl,
            }
          : result.status === "pending"
          ? {
              platform: result.platform,
              status: "pending",
              externalId: result.externalId || result.id || res.id,
              externalUrl: result.externalUrl,
              message: "Zernio a accepté la publication mais LinkedIn ne la marque pas encore comme publiée.",
            }
          : {
              platform: result.platform,
              status: "error",
              // Bounded: persisted on the post row and rendered to the user.
              message: (result.error || res.error || "Zernio publish failed").slice(0, 300),
            },
      );
    }
    return { results, providerPostId: res.id ?? null };
  } catch (err) {
    return {
      results: platforms.map((p) => ({
        platform: normalisePlatform(p),
        status: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      })),
      providerPostId: null,
    };
  }
}

async function publishPost(
  supabase: DbClient,
  postId: string,
  resumeDeadlineMs?: number,
): Promise<{ post_id: string; results: PublishResult[]; skipped?: string }> {
  // Atomically claim the post: only succeed if it is still in the
  // 'validated' state, transitioning it to 'publishing'. This prevents
  // a concurrent cron run and a manual click from both posting.
  const { data: claimed, error: claimError } = await supabase
    .from("posts")
    .update({
      status: "publishing",
      auto_publish_attempted_at: new Date().toISOString(),
    })
    .eq("id", postId)
    .eq("status", "validated")
    .select("*")
    .maybeSingle();

  if (claimError) throw claimError;
  if (!claimed) {
    // Someone else is publishing this post (or it's not in a publishable
    // state). Skip silently.
    return { post_id: postId, results: [], skipped: "not_in_validated_state" };
  }

  const post = claimed as PostRow;

  // Automatic posts may carry a Graphiste GPT poster job that was started at
  // generation time (auto-generate-weekly). By the time the post is due the
  // job has long finished, so resume it now and attach the poster before
  // publishing — this is what lets image-only networks (Instagram) work.
  // Skipped once the batch's shared resume budget is spent, so a rare stuck
  // job can't stall the whole publish run.
  if (
    !post.image_url &&
    post.image_job_id &&
    post.image_status !== "failed" &&
    (resumeDeadlineMs === undefined || Date.now() < resumeDeadlineMs)
  ) {
    try {
      // Normally finished long ago, so the first status poll returns instantly;
      // the small ceiling only bites if a job is genuinely stuck.
      const poster = await resumePosterJob(post.image_job_id, post.image_status_url ?? null, 15_000);
      if (poster.imageUrl) {
        // Persist a permanent copy (the source URL may expire) so the saved
        // image_url stays valid for the dashboard and any re-publish.
        let stable = poster.imageUrl;
        try {
          stable = await ensurePublicImage(supabase, poster.imageUrl, post.user_id);
        } catch (rehostErr) {
          console.error("rehost resumed poster failed:", rehostErr);
        }
        post.image_url = stable;
        await supabase
          .from("posts")
          .update({ image_url: stable, image_status: "done" })
          .eq("id", post.id);
      } else if (poster.status === "failed") {
        await supabase.from("posts").update({ image_status: "failed" }).eq("id", post.id);
      }
    } catch (err) {
      console.error("resume poster job failed:", err);
    }
  }

  const { data: connectionsRaw } = await supabase
    .from("social_connections")
    .select("*")
    .eq("user_id", post.user_id);
  const connections = (connectionsRaw || []) as SocialConnectionRow[];

  // Zernio-only mode: legacy Lovable/direct OAuth, Postiz and Ayrshare
  // connections are intentionally ignored. The product now has a single
  // social backend to avoid confusing first users and to keep publishing
  // behavior predictable.
  const zernio = connections.find((c) => c.provider === "zernio");

  const platforms: string[] = post.platforms || [];
  const results: PublishResult[] = [];
  let providerPostId: string | null = null;

  // For platforms that require a long-lived public image URL (Instagram,
  // Facebook URL-link posting), rehost the image on our own storage.
  let stableImageUrl: string | null = post.image_url || null;
  if (stableImageUrl) {
    try {
      stableImageUrl = await ensurePublicImage(supabase, stableImageUrl, post.user_id);
    } catch (err) {
      console.error("ensurePublicImage failed:", err);
      stableImageUrl = post.image_url || null;
    }
  }

  if (zernio?.profile_key) {
    const zr = await publishViaZernio(
      zernio.profile_key,
      platforms,
      post.content,
      stableImageUrl,
      post.id,
    );
    results.push(...zr.results);
    providerPostId = zr.providerPostId;
  } else {
    for (const rawPlatform of platforms) {
      results.push({
        platform: normalisePlatform(rawPlatform),
        status: "not_connected",
        message: zernio
          ? "Zernio account connected but missing profile key"
          : "Zernio account not connected",
      });
    }
  }

  const anyOk = results.some((r) => r.status === "ok");
  const anyPending = results.some((r) => r.status === "pending");
  const allErrors = results.length > 0 && results.every((r) => r.status === "error");

  // Decide the resulting state. Only a confirmed per-platform publish from
  // Zernio counts as 'published'. A queued/processing response stays
  // validated with publish_error details so the dashboard doesn't claim a
  // LinkedIn post exists before LinkedIn/Zernio confirms it.
  const finalStatus = anyOk ? "published" : allErrors ? "failed" : "validated";

  // Persist external post ids so the engagement/comments sync can later
  // map a published post back to its per-platform social post.
  const externalPostIds: Record<string, string> = {};
  for (const r of results) {
    if (r.status === "ok" && r.externalId) externalPostIds[r.platform] = r.externalId;
    if (r.status === "ok" && r.externalUrl) externalPostIds[`${r.platform}_url`] = r.externalUrl;
  }

  await supabase
    .from("posts")
    .update({
      status: finalStatus,
      published_at: anyOk ? new Date().toISOString() : null,
      publish_error: allErrors || anyPending || finalStatus === "validated" ? JSON.stringify(results) : null,
      provider_post_id: providerPostId,
      external_post_ids: externalPostIds,
    })
    .eq("id", postId);

  return { post_id: postId, results };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Server misconfigured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const headerCron = req.headers.get("x-cron-secret");
  const isCron = cronSecret && headerCron && headerCron === cronSecret;

  let userId: string | null = null;
  // The body is optional (cron mode sends none). `.catch(() => ({}))`
  // covers the empty-body case where req.json() would throw.
  const body: { postId?: string } = await req.json().catch(() => ({}));

  if (!isCron) {
    // Require a logged-in user for manual publishes.
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    if (!jwt) {
      return new Response(
        JSON.stringify({ error: "Not authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const authClient = createClient(supabaseUrl, serviceKey);
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    userId = userData.user.id;
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    if (body?.postId) {
      // Manual publish: verify ownership.
      if (userId) {
        const { data: post } = await supabase
          .from("posts")
          .select("user_id,status")
          .eq("id", body.postId)
          .single();
        if (!post) {
          return new Response(
            JSON.stringify({ error: "Post not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (post.user_id !== userId) {
          return new Response(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (post.status !== "validated") {
          return new Response(
            JSON.stringify({ error: "Post must be validated before publishing" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
      const result = await publishPost(supabase, body.postId, Date.now() + 20_000);
      return new Response(
        JSON.stringify({ success: true, ...result }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // No postId provided: cron mode. Process all validated posts whose
    // scheduled_for has passed.
    if (!isCron) {
      return new Response(
        JSON.stringify({ error: "postId is required for manual publish" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Recover any post that's been stuck in 'publishing' for >10min
    // (function timed out or crashed mid-batch). Non-fatal if the
    // function isn't yet deployed.
    const { error: recoverError } = await supabase.rpc("recover_stuck_publishing");
    if (recoverError) console.error("recover_stuck_publishing:", recoverError);

    const nowIso = new Date().toISOString();
    // Cap the per-run batch so a stuck queue can't exhaust the function
    // runtime; remaining items are picked up on the next cron tick. Kept small
    // because each post can also resume a poster job + make a publish call, all
    // sequential, and the edge runtime limit is ~150s.
    const CRON_BATCH_SIZE = 12;
    const { data: due } = await supabase
      .from("posts")
      .select("id")
      .eq("status", "validated")
      .lte("scheduled_for", nowIso)
      .order("scheduled_for", { ascending: true })
      .limit(CRON_BATCH_SIZE);

    // Shared budget for resuming pending poster jobs across the whole batch,
    // so even many unresolved jobs can't push the run past the edge limit.
    const resumeDeadlineMs = Date.now() + 90_000;
    const results: any[] = [];
    for (const row of due || []) {
      try {
        const r = await publishPost(supabase, row.id, resumeDeadlineMs);
        results.push(r);
      } catch (err) {
        results.push({ post_id: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("publish-post error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
