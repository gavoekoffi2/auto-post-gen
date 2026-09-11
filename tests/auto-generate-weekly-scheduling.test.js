import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The weekly generator's scheduling arithmetic, exercised directly rather than
// asserted on its source. This is where it has gone wrong before: a same-day
// target pushed a full week out, and two posts written with the exact same
// scheduled_for that then went out back-to-back in one publish tick.
import { buildEditorialPlan, slotInstant } from '../server/src/shared/weeklyPlan.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'server/src/services/weekly.ts'), 'utf8');

const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const at = (iso) => new Date(iso);

test('posts are scheduled at the user-chosen time, not a hard-coded 10:00', () => {
  // Monday 2026-09-07, 08:00 local.
  const now = at('2026-09-07T08:00:00');
  const slot = slotInstant(now, 0, ['Mercredi'], 18, 30);
  assert.equal(DAYS[slot.getDay()], 'Mercredi');
  assert.equal(slot.getHours(), 18);
  assert.equal(slot.getMinutes(), 30);
});

test('a target day that is today is kept when its time is still ahead', () => {
  const now = at('2026-09-07T08:00:00'); // a Monday
  const slot = slotInstant(now, 0, ['Lundi'], 18, 0);
  assert.equal(slot.getDate(), now.getDate(), 'this week\'s post must not be pushed out a week');
  assert.equal(slot.getHours(), 18);
});

test('a target day that is today but already past moves to next week', () => {
  const now = at('2026-09-07T20:00:00'); // Monday evening
  const slot = slotInstant(now, 0, ['Lundi'], 9, 0);
  assert.equal(DAYS[slot.getDay()], 'Lundi');
  assert.ok(slot.getTime() > now.getTime(), 'a post must never be scheduled in the past');
});

test('two generated posts never land on the exact same instant', () => {
  const now = at('2026-09-07T08:00:00');
  // More posts than preferred days: the same day comes round again.
  const instants = [0, 1, 2, 3, 4].map(
    (i) => slotInstant(now, i, ['Mardi', 'Jeudi'], 9, 0).getTime(),
  );
  assert.equal(new Set(instants).size, instants.length, 'duplicate slots publish back-to-back');
});

test('the staggered hour stays inside the day', () => {
  const now = at('2026-09-07T08:00:00');
  for (let i = 0; i < 12; i++) {
    const slot = slotInstant(now, i, ['Mardi'], 20, 0);
    assert.ok(slot.getHours() <= 21, `slot ${i} rolled past a sensible posting hour`);
    assert.ok(slot.getTime() > now.getTime(), `slot ${i} is in the past`);
  }
});

test('the editorial mix honours the quotas the user chose', () => {
  const plan = buildEditorialPlan(1, 1, 5);
  assert.equal(plan.length, 5);
  assert.equal(plan.filter((c) => c === 'promo').length, 1);
  assert.equal(plan.filter((c) => c === 'research').length, 1);
  assert.equal(plan.filter((c) => c === 'value').length, 3);
});

test('quotas larger than the available slots do not overflow the week', () => {
  const plan = buildEditorialPlan(5, 5, 2);
  assert.equal(plan.length, 2);
  for (const category of plan) {
    assert.ok(['value', 'research', 'promo'].includes(category));
  }
});

test('a week with no promo quota gets no promotional post', () => {
  const plan = buildEditorialPlan(0, 0, 3);
  assert.deepEqual(plan, ['value', 'value', 'value']);
});

test('the quotas count what is already queued, so a top-up cannot exceed them', () => {
  // Otherwise a second run in the same week adds a third promo to a week the
  // user capped at two.
  assert.match(source, /alreadyPromo/);
  assert.match(source, /promo_posts_per_week \?\? 1\) - alreadyPromo/);
  assert.match(source, /research_posts_per_week \?\? 1\) - alreadyResearch/);
});

test('a week that is already full generates nothing at all', () => {
  assert.match(source, /week_already_full/);
  assert.match(source, /scheduled_for < now\(\) \+ interval '7 days'/);
  assert.match(source, /status IN \('pending', 'validated'\)/);
});

test('value and research posts never promote the company; promo posts carry a CTA', () => {
  assert.match(source, /N'écris JAMAIS le nom de l'entreprise[\s\S]{0,200}aucune promotion/);
  assert.match(source, /Termine par un appel à l'action clair/);
  // A research post must not invent facts it cannot support.
  assert.match(source, /N'invente JAMAIS de chiffre/);
});

test('posts only enter the publish queue when the user asked for auto-publish', () => {
  assert.match(source, /profile\.auto_publish \? "validated" : "pending"/);
});
