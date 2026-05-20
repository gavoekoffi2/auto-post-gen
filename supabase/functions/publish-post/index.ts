// deno-lint-ignore-file no-explicit-any
//
// publish-post: publishes a single post (manual trigger from the dashboard)
// or a batch of due posts (cron trigger).
//
// Currently implements LinkedIn (UGC API). Stubs for Facebook (Pages),
// Instagram (Graph API via FB Page), and Twitter/X are included with the
// API contract so they can be filled in once the corresponding OAuth apps
// are registered. TikTok requires the Content Posting API which is in
// limited access — the stub returns a "not_implemented" error rather
// than failing silently.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

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

interface PublishResult {
  platform: string;
  status: "ok" | "error" | "not_implemented" | "not_connected";
  externalId?: string;
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
        const uploadUrl =
          registerData?.value?.uploadMechanism?.[
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
          ]?.uploadUrl;
        if (uploadUrl) {
          const imgResp = await fetch(imageUrl);
          const blob = await imgResp.arrayBuffer();
          await fetch(uploadUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${connection.access_token}` },
            body: blob,
          });
        }
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

async function publishToInstagram(
  connection: SocialConnection,
  content: string,
  imageUrl: string | null,
): Promise<PublishResult> {
  // Instagram Graph API via a connected Facebook Page. The connection
  // must store the IG business account id in meta.ig_user_id and the
  // long-lived page token in access_token.
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

async function publishPost(
  supabase: ReturnType<typeof createClient>,
  postId: string,
): Promise<{ post_id: string; results: PublishResult[] }> {
  const { data: post, error } = await supabase
    .from("posts")
    .select("*")
    .eq("id", postId)
    .single();

  if (error || !post) throw new Error(`Post ${postId} not found`);
  if (post.status === "published") return { post_id: postId, results: [] };

  const { data: connections } = await supabase
    .from("social_connections")
    .select("*")
    .eq("user_id", post.user_id);

  const platforms: string[] = post.platforms || [];
  const results: PublishResult[] = [];

  for (const rawPlatform of platforms) {
    const platform = normalisePlatform(rawPlatform);
    const publisher = PUBLISHERS[platform];
    if (!publisher) {
      results.push({ platform, status: "error", message: "Unknown platform" });
      continue;
    }
    const connection = (connections || []).find(
      (c: any) => c.platform === platform,
    ) as SocialConnection | undefined;
    if (!connection) {
      results.push({ platform, status: "not_connected" });
      continue;
    }
    const result = await publisher(connection, post.content, post.image_url || null);
    results.push(result);
  }

  const anyOk = results.some((r) => r.status === "ok");
  const allErrors = results.length > 0 && results.every((r) => r.status === "error");

  await supabase
    .from("posts")
    .update({
      status: anyOk ? "published" : allErrors ? "failed" : post.status,
      published_at: anyOk ? new Date().toISOString() : null,
      auto_publish_attempted_at: new Date().toISOString(),
      publish_error: allErrors ? JSON.stringify(results) : null,
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
  let body: any = {};

  try {
    body = await req.json().catch(() => ({}));
  } catch (_) {
    body = {};
  }

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

    const nowIso = new Date().toISOString();
    const { data: due } = await supabase
      .from("posts")
      .select("id")
      .eq("status", "validated")
      .lte("scheduled_for", nowIso);

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
