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
  // The hour written on the row derives from the profile's preferred_time
  // (slotHour is `hour` plus the same-day stagger below, never a literal).
  assert.match(source, /const slotHour = Math\.min\(21, hour \+ passOverDays \* SLOT_SPACING_HOURS\)/);
  assert.match(source, /setHours\(slotHour, minute, 0, 0\)/);
});

test('two generated posts never land on the exact same scheduled_for', () => {
  // With more posts per week than preferred days, `i % preferredDays.length`
  // reused the same day AND the same hour, so posts 4 and 5 were written with
  // an identical scheduled_for and went out back-to-back in one publish tick.
  assert.equal(
    source.includes('preferredDays[i % preferredDays.length]'),
    false,
    'the day index must account for posts already queued and for repeat passes',
  );
  // Continue past whatever is already queued, so a top-up run does not reuse
  // the days the existing posts sit on.
  assert.match(source, /const slotIndex = \(existingPosts\?\.length \|\| 0\) \+ i/);
  assert.match(source, /preferredDays\[slotIndex % preferredDays\.length\]/);
  // Repeat passes over the same day are staggered by whole hours.
  assert.match(source, /const passOverDays = Math\.floor\(slotIndex \/ preferredDays\.length\)/);
  assert.match(source, /const SLOT_SPACING_HOURS = \d+/);
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
