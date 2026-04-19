// Cron entrypoint. Finds all "validated" / "scheduled" posts whose
// scheduled_for is in the past, then publishes them on Postiz.
//
// Recommended trigger: Supabase cron every 5 minutes.
// This endpoint is intentionally service-role only (verify_jwt = false
// in config.toml, but protected by the CRON_SECRET header).

import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/auth.ts';
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

  // Simple shared-secret check for the cron trigger.
  const expected = Deno.env.get('CRON_SECRET');
  if (expected) {
    const provided =
      req.headers.get('x-cron-secret') ??
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (provided !== expected) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
  }

  const supabase = getServiceClient();
  const { data: duePosts, error } = await supabase.rpc('claim_due_posts', {
    p_limit: 25,
  });
  if (error) {
    console.error('claim_due_posts error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const post of duePosts || []) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('postiz_api_key, postiz_base_url, platforms')
        .eq('id', post.user_id)
        .maybeSingle();

      if (!profile?.postiz_api_key) {
        await supabase
          .from('posts')
          .update({
            status: 'validated',
            publish_error: 'Aucune clé API Postiz configurée.',
            publish_attempts: (post.publish_attempts ?? 0) + 1,
          })
          .eq('id', post.id);
        results.push({ id: post.id, skipped: 'no-key' });
        continue;
      }

      const client = new PostizClient(
        profile.postiz_api_key,
        profile.postiz_base_url || DEFAULT_POSTIZ_BASE_URL,
      );
      const integrations = await client.listIntegrations();

      const targetPlatforms: string[] =
        (post.platforms && post.platforms.length
          ? post.platforms
          : profile.platforms) || [];

      const subPosts: Array<{
        integration: { id: string };
        value: Array<{ content: string; image?: Array<{ path: string }> }>;
        settings: Record<string, unknown>;
      }> = [];
      const missing: string[] = [];

      let imagePath: string | null = null;
      if (post.image_url) {
        imagePath = await client.uploadImageFromUrl(post.image_url);
      }

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
            status: 'validated',
            publish_error: `Aucune intégration Postiz pour: ${missing.join(', ')}`,
            publish_attempts: (post.publish_attempts ?? 0) + 1,
          })
          .eq('id', post.id);
        results.push({ id: post.id, skipped: 'no-integration', missing });
        continue;
      }

      const r = await client.createPost({
        type: 'now',
        date: new Date(Date.now() + 60_000).toISOString(),
        posts: subPosts,
      });
      const postizPostId =
        (r as { id?: string })?.id ??
        (r as { posts?: Array<{ id?: string }> })?.posts?.[0]?.id ??
        null;

      await supabase
        .from('posts')
        .update({
          status: 'published',
          postiz_post_id: postizPostId,
          postiz_integration_ids: subPosts.map((s) => s.integration.id),
          published_at: new Date().toISOString(),
          publish_error: missing.length
            ? `Partiellement publié — manquant: ${missing.join(', ')}`
            : null,
          publish_attempts: (post.publish_attempts ?? 0) + 1,
        })
        .eq('id', post.id);

      results.push({ id: post.id, success: true, postizPostId });
    } catch (err) {
      const message =
        err instanceof PostizError
          ? `Postiz: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      console.error('Publish failed for', post.id, message);
      await supabase
        .from('posts')
        .update({
          status: 'validated',
          publish_error: message,
          publish_attempts: (post.publish_attempts ?? 0) + 1,
        })
        .eq('id', post.id);
      results.push({ id: post.id, error: message });
    }
  }

  return jsonResponse({ processed: results.length, results });
});
