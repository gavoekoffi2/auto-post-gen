import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, '..', 'supabase/functions/auto-generate-weekly/index.ts'),
  'utf8',
);

test('auto-generate-weekly schedules at the user-chosen time, not a hard-coded 10:00', () => {
  assert.equal(
    source.includes('setHours(10, 0, 0, 0)'),
    false,
    'the publish time must come from the profile, not be hard-coded to 10:00',
  );
  assert.match(source, /profile\.preferred_time/);
  assert.match(source, /setHours\(hour, minute, 0, 0\)/);
});

test('auto-generate-weekly preserves the chosen value/research/promo mix across retries', () => {
  assert.match(source, /profile\.promo_posts_per_week/);
  assert.match(source, /profile\.research_posts_per_week/);
  assert.match(source, /const editorialPlan = buildEditorialPlan/);
  assert.match(source, /const contentCategory = editorialPlan\[i\]/);
  // Category is persisted so a retry can count what already exists.
  assert.match(source, /content_category: contentCategory/);
});

test('value posts do not promote the company, promo posts carry a clear CTA', () => {
  // Value branch: explicitly no promotion / no price / no offer.
  assert.match(source, /aucune promotion, aucun prix, aucune offre/);
  // Promo branch: present the service and end on a call to action.
  assert.match(source, /OBJECTIF DE CE POST: présenter ce que propose/);
  assert.match(source, /appel à l'action clair/);
});

test('the run is bounded and reports what it could not reach', () => {
  // Each post costs an AI call. Past enough accounts the edge runtime kills
  // the function mid-batch, and the accounts at the end of the list silently
  // get nothing that week with nothing in the response to say so.
  assert.match(source, /const runDeadline = Date\.now\(\)/);
  assert.match(source, /if \(Date\.now\(\) > runDeadline\)/);
  assert.match(source, /deferred \+= 1/);
  assert.match(source, /JSON\.stringify\(\{ success: true, results, deferred \}\)/);
});

test('the weekly volume is capped by the plan, not by what the client asked for', () => {
  // post_frequency is written by the browser; it is a request, not an
  // entitlement. Without the clamp a Starter account received the
  // Enterprise volume just by picking a bigger number.
  assert.match(source, /planLimits\(profile\.plan\)/);
  assert.match(source, /limits\.postsPerWeek/);
});
