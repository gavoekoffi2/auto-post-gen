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

test('auto-generate-weekly splits the week into value posts and a chosen number of promo posts', () => {
  assert.match(source, /profile\.promo_posts_per_week/);
  assert.match(source, /const promoThisRun =/);
  assert.match(source, /const isPromo = i < promoThisRun/);
  // Promo posts get a distinct title so the dashboard/stats can tell them apart.
  assert.match(source, /isPromo \? "Post promotionnel" : "Contenu automatique"/);
});

test('value posts do not promote the company, promo posts carry a clear CTA', () => {
  // Value branch: explicitly no promotion / no price / no offer.
  assert.match(source, /aucune promotion, aucun prix, aucune offre/);
  // Promo branch: present the service and end on a call to action.
  assert.match(source, /OBJECTIF DE CE POST: présenter ce que propose/);
  assert.match(source, /appel à l'action clair/);
});
