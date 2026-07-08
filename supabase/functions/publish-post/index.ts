// deno-lint-ignore-file no-explicit-any
//
// publish-post: publishes a single post (manual trigger from the dashboard)
// or a batch of due posts (cron trigger).
//
// Implements LinkedIn (UGC API with image upload via the assets API),
// Facebook Pages (feed/photos), Instagram (Graph API media + media_publish
// via the connected Facebook Page) and Twitter/X (v2 tweets, text-only in
// this version). TikTok is intentionally not implemented because the
// Content Posting API is in limited access.
//
// Concurrency: before doing any external API call, we atomically flip the
// post status from 'validated' to 'publishing' so concurrent cron + manual
// invocations can't double-publish.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import {
  postizCreatePost,
  postizListIntegrations,
  postizUploadFromUrl,
  toPostizIdentifier,
} from "../_shared/postiz.ts";
import { zernioCreatePost, zernioListAccounts } from "../_shared/zernio.ts";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildCorsHeaders(origin: string | null) {
  const allowed =
    allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin));
  return {
    "Access-Control-Allow-Origin":
      allowed && origin ? origin : allowedOrigins[0] === "*" ? "*" : allowedOrigins[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

interface SocialConnection {
  id: string;
  user_id: string;
  platform: string;
  account_id: string;
  account_username: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  meta: any;
}

type DbClient = SupabaseClient<any, "public", any>;

interface PostRow {
  id: string;
  user_id: string;
  content: string;
  platforms: string[] | null;
  image_url: string | null;
  video_url: string | null;
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

async function publishToLinkedIn(
  connection: SocialConnection,
  content: string,
  imageUrl: string | null,
): Promise<PublishResult> {
  try {
    const personUrn = `urn:li:person:${connection.account_id}`;

    // 1. If we have an image URL, register and upload it first.
    let mediaAsset: string | null = null;
    if (imageUrl) {
      const registerResp = await fetch(
        "https://api.linkedin.com/v2/assets?action=registerUpload",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.access_token}`,
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
          },
          body: JSON.stringify({
            registerUploadRequest: {
              owner: personUrn,
              recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
              serviceRelationships: [
                {
                  identifier: "urn:li:userGeneratedContent",
                  relationshipType: "OWNER",
                },
              ],
            },
          }),
        },
      );

      if (registerResp.ok) {
        const registerData = await registerResp.json();
        mediaAsset = registerData?.value?.asset || null;
        const uploadMech =
          registerData?.value?.uploadMechanism?.[
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
          ];
        const uploadUrl = uploadMech?.uploadUrl;
        // LinkedIn returns the http method in the upload mechanism. The
        // current API uses PUT for the binary upload, but read it back
        // defensively in case LinkedIn ever advertises a different one.
        const uploadMethod = (uploadMech?.method as string) || "PUT";
        if (uploadUrl) {
          const imgResp = await fetch(imageUrl);
          if (!imgResp.ok) {
            return {
              platform: "linkedin",
              status: "error",
              message: `Image download failed: ${imgResp.status}`,
            };
          }
          const blob = await imgResp.arrayBuffer();
          const uploadResp = await fetch(uploadUrl, {
            method: uploadMethod,
            headers: {
              Authorization: `Bearer ${connection.access_token}`,
              "Content-Type": imgResp.headers.get("content-type") || "application/octet-stream",
            },
            body: blob,
          });
          if (!uploadResp.ok) {
            return {
              platform: "linkedin",
              status: "error",
              message: `LinkedIn upload ${uploadResp.status}: ${(await uploadResp.text()).slice(0, 200)}`,
            };
          }
        } else {
          // Unable to obtain an upload URL — fall back to text-only post
          // rather than failing the whole publish.
          mediaAsset = null;
        }
      } else {
        // registerUpload failed — fall back to text-only post.
        console.error(
          "LinkedIn registerUpload failed:",
          registerResp.status,
          (await registerResp.text()).slice(0, 200),
        );
        mediaAsset = null;
      }
    }

    const ugcBody: Record<string, unknown> = {
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: content },
          shareMediaCategory: mediaAsset ? "IMAGE" : "NONE",
          ...(mediaAsset
            ? {
                media: [
                  {
                    status: "READY",
                    media: mediaAsset,
                  },
                ],
              }
            : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };

    const postResp = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(ugcBody),
    });

    if (!postResp.ok) {
      const text = await postResp.text();
      return { platform: "linkedin", status: "error", message: `LinkedIn ${postResp.status}: ${text}` };
    }

    const id = postResp.headers.get("x-restli-id") || undefined;
    return { platform: "linkedin", status: "ok", externalId: id };
  } catch (err) {
    return {
      platform: "linkedin",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function publishToFacebook(
  connection: SocialConnection,
  content: string,
  imageUrl: string | null,
): Promise<PublishResult> {
  // Facebook Pages: POST /{page-id}/feed or /{page-id}/photos
  // Requires the page-scoped access token stored in connection.access_token.
  try {
    const pageId = connection.account_id;
    const endpoint = imageUrl
      ? `https://graph.facebook.com/v19.0/${pageId}/photos`
      : `https://graph.facebook.com/v19.0/${pageId}/feed`;

    const body = new URLSearchParams();
    body.set("access_token", connection.access_token);
    body.set("message", content);
    if (imageUrl) body.set("url", imageUrl);

    const resp = await fetch(endpoint, { method: "POST", body });
    if (!resp.ok) {
      const text = await resp.text();
      return { platform: "facebook", status: "error", message: `FB ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { platform: "facebook", status: "ok", externalId: data.id || data.post_id };
  } catch (err) {
    return {
      platform: "facebook",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ensurePublicImage(
  supabase: DbClient,
  imageUrl: string,
  userId: string,
): Promise<string> {
  // If the URL already lives on our Supabase storage, return as-is.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (supabaseUrl && imageUrl.startsWith(supabaseUrl)) return imageUrl;

  let blob: Blob;
  let contentType = "image/jpeg";

  if (imageUrl.startsWith("data:")) {
    // Inline data URL ("data:image/png;base64,XXXX..."): decode in-place.
    const commaIdx = imageUrl.indexOf(",");
    if (commaIdx < 0) throw new Error("Invalid data URL");
    const meta = imageUrl.slice(5, commaIdx); // e.g. "image/png;base64"
    const payload = imageUrl.slice(commaIdx + 1);
    const isBase64 = meta.includes(";base64");
    contentType = meta.split(";")[0] || contentType;
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: contentType });
    } else {
      blob = new Blob([decodeURIComponent(payload)], { type: contentType });
    }
  } else {
    // Otherwise, fetch the image and re-upload to user-assets/<userId>/
    // so we control its lifetime.
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
    blob = await resp.blob();
    contentType = blob.type || contentType;
  }

  const ext = (contentType.split("/")[1] || "jpg").split(";")[0];
  const path = `${userId}/published-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("user-assets")
    .upload(path, blob, { contentType, upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("user-assets").getPublicUrl(path);
  return data.publicUrl;
}

async function publishToInstagram(
  connection: SocialConnection,
  content: string,
  imageUrl: string | null,
): Promise<PublishResult> {
  if (!imageUrl) {
    return { platform: "instagram", status: "error", message: "Instagram requires an image" };
  }
  try {
    const igUserId = connection.meta?.ig_user_id || connection.account_id;
    const createUrl = `https://graph.facebook.com/v19.0/${igUserId}/media`;
    const createBody = new URLSearchParams();
    createBody.set("image_url", imageUrl);
    createBody.set("caption", content);
    createBody.set("access_token", connection.access_token);
    const createResp = await fetch(createUrl, { method: "POST", body: createBody });
    if (!createResp.ok) {
      const text = await createResp.text();
      return { platform: "instagram", status: "error", message: `IG create ${createResp.status}: ${text}` };
    }
    const createData = await createResp.json();
    const creationId = createData.id;

    const publishUrl = `https://graph.facebook.com/v19.0/${igUserId}/media_publish`;
    const publishBody = new URLSearchParams();
    publishBody.set("creation_id", creationId);
    publishBody.set("access_token", connection.access_token);
    const publishResp = await fetch(publishUrl, { method: "POST", body: publishBody });
    if (!publishResp.ok) {
      const text = await publishResp.text();
      return { platform: "instagram", status: "error", message: `IG publish ${publishResp.status}: ${text}` };
    }
    const publishData = await publishResp.json();
    return { platform: "instagram", status: "ok", externalId: publishData.id };
  } catch (err) {
    return {
      platform: "instagram",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function publishToTwitter(
  connection: SocialConnection,
  content: string,
  _imageUrl: string | null,
): Promise<PublishResult> {
  try {
    const resp = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: content.slice(0, 280) }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { platform: "twitter", status: "error", message: `Twitter ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { platform: "twitter", status: "ok", externalId: data?.data?.id };
  } catch (err) {
    return {
      platform: "twitter",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function publishToTikTok(
  _connection: SocialConnection,
  _content: string,
  _imageUrl: string | null,
): Promise<PublishResult> {
  // TikTok Content Posting API requires app review + restricted scopes.
  return {
    platform: "tiktok",
    status: "not_implemented",
    message:
      "TikTok publishing requires the Content Posting API (limited access). Not yet implemented.",
  };
}

const PUBLISHERS: Record<
  string,
  (c: SocialConnection, t: string, i: string | null) => Promise<PublishResult>
> = {
  linkedin: publishToLinkedIn,
  facebook: publishToFacebook,
  instagram: publishToInstagram,
  twitter: publishToTwitter,
  tiktok: publishToTikTok,
};

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

// Ayrshare publish: a single API call posts to every social account
// the user has linked through their Ayrshare profile.
//
// When profileKey is null we're in "shared mode" (the operator's free
// or Premium plan doesn't support per-user profiles) — we omit the
// Profile-Key header and post via the API key owner's main account.
async function publishViaAyrshare(
  profileKey: string | null,
  content: string,
  imageUrl: string | null,
  platforms: string[],
): Promise<{ results: PublishResult[]; providerPostId: string | null }> {
  const apiKey = Deno.env.get("AYRSHARE_API_KEY");
  if (!apiKey) {
    return {
      results: platforms.map((p) => ({
        platform: p,
        status: "error" as const,
        message: "AYRSHARE_API_KEY not configured",
      })),
      providerPostId: null,
    };
  }
  try {
    const ayrPlatforms = platforms.map(normalisePlatform);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (profileKey) headers["Profile-Key"] = profileKey;
    const resp = await fetch("https://app.ayrshare.com/api/post", {
      method: "POST",
      headers,
      body: JSON.stringify({
        post: content,
        platforms: ayrPlatforms,
        mediaUrls: imageUrl ? [imageUrl] : undefined,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return {
        results: ayrPlatforms.map((p) => ({
          platform: p,
          status: "error" as const,
          message: `Ayrshare ${resp.status}: ${text.slice(0, 200)}`,
        })),
        providerPostId: null,
      };
    }
    const data = await resp.json();
    const postIds = data?.postIds || {};
    const errors = data?.errors || [];
    const results = ayrPlatforms.map((p) => {
      const err = errors.find((e: any) => e.platform === p);
      if (err) {
        return { platform: p, status: "error" as const, message: err.message || "Ayrshare error" };
      }
      return {
        platform: p,
        status: "ok" as const,
        externalId: postIds[p] || data?.id,
      };
    });
    // data.id is Ayrshare's umbrella post id — the handle the Comments API
    // (GET/POST /api/comments/:id) expects to read & reply to engagement.
    return { results, providerPostId: data?.id ?? null };
  } catch (err) {
    return {
      results: platforms.map((p) => ({
        platform: p,
        status: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      })),
      providerPostId: null,
    };
  }
}

// Postiz publish: fan out to every connected Postiz channel whose
// identifier matches a requested platform. Postiz holds the social tokens,
// so a single API call covers all of them.
async function publishViaPostiz(
  platforms: string[],
  content: string,
  imageUrl: string | null,
): Promise<{ results: PublishResult[]; providerPostId: string | null }> {
  const results: PublishResult[] = [];
  try {
    const integrations = await postizListIntegrations();
    const chosen: { id: string; platform: string }[] = [];
    for (const raw of platforms) {
      const platform = normalisePlatform(raw);
      const ident = toPostizIdentifier(platform);
      const match = integrations.find(
        (i) => (i.identifier || "").toLowerCase() === ident && !i.disabled,
      );
      if (match) chosen.push({ id: match.id, platform });
      else results.push({ platform, status: "not_connected" });
    }
    if (chosen.length === 0) return { results, providerPostId: null };

    // Best-effort image upload; degrades to text-only on failure.
    let imageId: string | null = null;
    if (imageUrl) imageId = await postizUploadFromUrl(imageUrl);

    const res = await postizCreatePost({
      integrationIds: chosen.map((c) => c.id),
      content,
      imageId,
    });
    for (const c of chosen) {
      results.push(
        res.ok
          ? { platform: c.platform, status: "ok", externalId: res.id }
          : { platform: c.platform, status: "error", message: res.error },
      );
    }
    return { results, providerPostId: res.ok ? (res.id ?? null) : null };
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

// Zernio publish: map requested platforms to the accounts connected under
// the user's Zernio profile, then publish to all of them in one call.
async function publishViaZernio(
  profileKey: string | null,
  platforms: string[],
  content: string,
  imageUrl: string | null,
  videoUrl: string | null,
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

    const res = await zernioCreatePost({ content, imageUrl, videoUrl, platforms: targets, requestId });
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
              message: result.error || res.error || "Zernio publish failed",
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

  // Generated videos already live at a public Supabase Storage URL
  // (user-assets), so they need no rehosting. A video takes precedence over
  // an image for the same post.
  const videoUrl: string | null = post.video_url || null;

  if (zernio?.profile_key) {
    const zr = await publishViaZernio(
      zernio.profile_key,
      platforms,
      post.content,
      videoUrl ? null : stableImageUrl,
      videoUrl,
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
      const result = await publishPost(supabase, body.postId);
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
    // runtime; remaining items are picked up on the next cron tick.
    const CRON_BATCH_SIZE = 50;
    const { data: due } = await supabase
      .from("posts")
      .select("id")
      .eq("status", "validated")
      .lte("scheduled_for", nowIso)
      .order("scheduled_for", { ascending: true })
      .limit(CRON_BATCH_SIZE);

    const results: any[] = [];
    for (const row of due || []) {
      try {
        const r = await publishPost(supabase, row.id);
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
