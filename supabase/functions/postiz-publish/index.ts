// Publishes (or schedules) a post on the connected Postiz accounts.
//
// Request body: { postId: string, publishNow?: boolean }
// - publishNow=true -> sends Postiz `type: 'now'`
// - otherwise -> sends `type: 'schedule'` using posts.scheduled_for
//
// The function:
//   1. Loads the post (ensures it belongs to the caller).
//   2. Loads the caller profile for Postiz key + target platforms.
//   3. Fetches current Postiz integrations.
//   4. Uploads the image (if any) to Postiz.
//   5. Builds one sub-post per platform requested in posts.platforms.
//   6. Calls Postiz /posts.
//   7. Updates the post in DB (status=published, postiz_post_id, etc.).

import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient, getUserFromRequest } from '../_shared/auth.ts';
import {
  DEFAULT_POSTIZ_BASE_URL,
  PostizClient,
  PostizError,
  defaultSettingsForProvider,
  findIntegrationForPlatform,
} from '../_shared/postiz.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const postId = body?.postId;
    const publishNow = Boolean(body?.publishNow);
    if (!postId) return jsonResponse({ error: 'postId required' }, 400);

    const supabase = getServiceClient();

    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (postErr) throw postErr;
    if (!post) return jsonResponse({ error: 'Post not found' }, 404);

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('postiz_api_key, postiz_base_url, platforms')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile?.postiz_api_key) {
      return jsonResponse(
        { error: 'Configure votre clé API Postiz dans le profil.' },
        400,
      );
    }

    const client = new PostizClient(
      profile.postiz_api_key,
      profile.postiz_base_url || DEFAULT_POSTIZ_BASE_URL,
    );
    const integrations = await client.listIntegrations();

    const targetPlatforms: string[] =
      (post.platforms && post.platforms.length ? post.platforms : profile.platforms) ||
      [];
    if (targetPlatforms.length === 0) {
      return jsonResponse({ error: 'Aucune plateforme sélectionnée.' }, 400);
    }

    let imagePath: string | null = null;
    if (post.image_url) {
      imagePath = await client.uploadImageFromUrl(post.image_url);
    }

    const subPosts: Array<{
      integration: { id: string };
      value: Array<{ content: string; image?: Array<{ path: string }> }>;
      settings: Record<string, unknown>;
    }> = [];
    const missing: string[] = [];

    for (const platform of targetPlatforms) {
      const integration = findIntegrationForPlatform(platform, integrations);
      if (!integration) {
        missing.push(platform);
        continue;
      }
      subPosts.push({
        integration: { id: integration.id },
        value: [
          {
            content: post.content ?? '',
            image: imagePath ? [{ path: imagePath }] : [],
          },
        ],
        settings: defaultSettingsForProvider(integration.providerIdentifier),
      });
    }

    if (subPosts.length === 0) {
      await supabase
        .from('posts')
        .update({
          publish_error:
            `Aucun compte Postiz connecté pour: ${missing.join(', ')}`,
          publish_attempts: (post.publish_attempts ?? 0) + 1,
        })
        .eq('id', post.id);
      return jsonResponse(
        {
          error: `Aucun compte Postiz connecté pour: ${missing.join(', ')}`,
          missing,
        },
        400,
      );
    }

    const scheduledAt =
      !publishNow && post.scheduled_for
        ? new Date(post.scheduled_for).toISOString()
        : new Date(Date.now() + 60_000).toISOString();

    const result = await client.createPost({
      type: publishNow ? 'now' : 'schedule',
      date: scheduledAt,
      posts: subPosts,
    });

    const postizPostId =
      (result as { id?: string })?.id ??
      (result as { posts?: Array<{ id?: string }> })?.posts?.[0]?.id ??
      null;

    const nextStatus = publishNow ? 'published' : 'scheduled';
    await supabase
      .from('posts')
      .update({
        status: nextStatus,
        postiz_post_id: postizPostId,
        postiz_integration_ids: subPosts.map((s) => s.integration.id),
        published_at: publishNow ? new Date().toISOString() : null,
        scheduled_for: scheduledAt,
        publish_error: missing.length
          ? `Non publié (pas d'intégration): ${missing.join(', ')}`
          : null,
        publish_attempts: (post.publish_attempts ?? 0) + 1,
      })
      .eq('id', post.id);

    return jsonResponse({
      success: true,
      postizPostId,
      status: nextStatus,
      publishedOn: subPosts.length,
      missing,
    });
  } catch (err) {
    console.error('postiz-publish error:', err);
    if (err instanceof PostizError) {
      return jsonResponse({ error: `Postiz: ${err.message}` }, 502);
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return jsonResponse({ error: message }, 500);
  }
});
