import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

const zernio = read('supabase/functions/_shared/zernio.ts');
const publish = read('supabase/functions/publish-post/index.ts');
const migration = read('supabase/migrations/20260707010000_posts_video_url.sql');
const videosPage = read('src/pages/Videos.tsx');
const types = read('src/integrations/supabase/types.ts');

test('Zernio client publishes video as a video media item (type=video)', () => {
  assert.match(zernio, /videoUrl\?:/);
  assert.match(zernio, /thumbnailUrl\?:/);
  assert.match(zernio, /url:\s*input\.videoUrl,\s*type:\s*"video"/);
  // video takes precedence over image
  assert.match(zernio, /if \(input\.videoUrl\)/);
  assert.match(zernio, /else if \(input\.imageUrl\)/);
  // image path is preserved
  assert.match(zernio, /url:\s*input\.imageUrl,\s*type:\s*"image"/);
});

test('publish-post carries a post video through Zernio, preferring it over the image', () => {
  assert.match(publish, /video_url:\s*string \| null/);
  assert.match(publish, /const videoUrl:\s*string \| null = post\.video_url/);
  // video takes precedence: image is nulled when a video is present
  assert.match(publish, /videoUrl \? null : stableImageUrl/);
  // publishViaZernio receives and forwards the video url
  assert.match(publish, /zernioCreatePost\(\{ content, imageUrl, videoUrl, platforms: targets, requestId \}\)/);
});

test('posts.video_url migration adds the column', () => {
  assert.match(migration, /ALTER TABLE public\.posts/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS video_url TEXT/);
  assert.match(types, /image_url: string \| null\n\s+video_url: string \| null/);
});

test('finished videos flow into the existing publish pipeline via a posts row', () => {
  // A done video becomes a normal post (video_url set) so it uses the same
  // validate → publish → status flow as image/text posts.
  assert.match(videosPage, /\.from\("posts"\)\s*\.insert\(/);
  assert.match(videosPage, /video_url:\s*job\.video_url/);
  assert.match(videosPage, /createPostFromVideo/);
  // user picks the networks (TikTok / YouTube Shorts default)
  assert.match(videosPage, /VIDEO_PLATFORMS/);
  assert.match(videosPage, /DEFAULT_VIDEO_PLATFORMS\s*=\s*\["TikTok",\s*"YouTube"\]/);
  assert.match(videosPage, /togglePlatform/);
});
