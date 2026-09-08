import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  nextOccurrenceInZone,
  partsInZone,
  safeTimeZone,
  zonedTimeToUtc,
} from '../supabase/functions/_shared/timezone.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Read an instant back as a wall clock in a zone, so assertions read like the
// user's own calendar rather than a UTC offset.
const wallClock = (date, timeZone) =>
  date.toLocaleString('sv-SE', { timeZone }).replace(' ', 'T');

test('a chosen local time survives DST in both directions', () => {
  // The whole point: 10:00 must be 10:00 for the user in July AND in January,
  // even though the UTC instant differs by an hour.
  const summer = zonedTimeToUtc(2026, 7, 15, 10, 0, 'Europe/Paris');
  const winter = zonedTimeToUtc(2026, 1, 15, 10, 0, 'Europe/Paris');
  assert.equal(wallClock(summer, 'Europe/Paris'), '2026-07-15T10:00:00');
  assert.equal(wallClock(winter, 'Europe/Paris'), '2026-01-15T10:00:00');
  // ...and they are genuinely different offsets from UTC.
  assert.equal(summer.toISOString(), '2026-07-15T08:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-01-15T09:00:00.000Z');
});

test('zones west of UTC and half-hour zones are handled', () => {
  const montreal = zonedTimeToUtc(2026, 7, 15, 10, 0, 'America/Montreal');
  assert.equal(wallClock(montreal, 'America/Montreal'), '2026-07-15T10:00:00');
  const kathmandu = zonedTimeToUtc(2026, 7, 15, 10, 0, 'Asia/Kathmandu');
  assert.equal(wallClock(kathmandu, 'Asia/Kathmandu'), '2026-07-15T10:00:00');
  assert.equal(kathmandu.toISOString(), '2026-07-15T04:15:00.000Z');
});

test('a local time that does not exist (spring forward) resolves after the jump', () => {
  // 2026-03-29 02:30 never happens in Paris. A scheduler must still produce a
  // real instant rather than NaN or a silent day shift.
  const gap = zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Paris');
  assert.ok(!Number.isNaN(gap.getTime()));
  assert.equal(wallClock(gap, 'Europe/Paris'), '2026-03-29T03:30:00');
});

test('an ambiguous local time (fall back) resolves deterministically', () => {
  // 2026-10-25 02:30 happens twice in Paris; either is defensible, but it must
  // be stable and must still be that wall clock.
  const first = zonedTimeToUtc(2026, 10, 25, 2, 30, 'Europe/Paris');
  const second = zonedTimeToUtc(2026, 10, 25, 2, 30, 'Europe/Paris');
  assert.equal(first.getTime(), second.getTime());
  assert.equal(wallClock(first, 'Europe/Paris'), '2026-10-25T02:30:00');
});

test('the weekday comes from the user calendar, not the runtime UTC one', () => {
  // 2026-09-09T23:30Z is Wednesday in UTC but already Thursday in Tokyo.
  const now = new Date('2026-09-09T23:30:00Z');
  assert.equal(partsInZone(now, 'UTC').weekday, 3, 'Wednesday in UTC');
  assert.equal(partsInZone(now, 'Asia/Tokyo').weekday, 4, 'Thursday in Tokyo');

  // Asking for "Thursday 09:00" must therefore mean the very next morning in
  // Tokyo, not a week later.
  const thursday = nextOccurrenceInZone(now, 4, 9, 0, 'Asia/Tokyo');
  assert.equal(wallClock(thursday, 'Asia/Tokyo'), '2026-09-10T09:00:00');
});

test('a same-day slot is kept when still ahead and rolled over once passed', () => {
  // Wednesday 08:00 Paris — the 10:00 slot is still ahead, so keep today.
  const stillAhead = nextOccurrenceInZone(new Date('2026-09-09T06:00:00Z'), 3, 10, 0, 'Europe/Paris');
  assert.equal(wallClock(stillAhead, 'Europe/Paris'), '2026-09-09T10:00:00');

  // Wednesday 14:00 Paris — 10:00 has passed, so next Wednesday.
  const passed = nextOccurrenceInZone(new Date('2026-09-09T12:00:00Z'), 3, 10, 0, 'Europe/Paris');
  assert.equal(wallClock(passed, 'Europe/Paris'), '2026-09-16T10:00:00');
});

test('the result is always in the future and on the requested weekday', () => {
  const now = new Date('2026-09-09T08:00:00Z');
  for (const tz of ['UTC', 'Europe/Paris', 'Africa/Lome', 'America/Montreal', 'Asia/Tokyo']) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const next = nextOccurrenceInZone(now, weekday, 10, 0, tz);
      assert.ok(next.getTime() > now.getTime(), `${tz} weekday ${weekday} must be in the future`);
      assert.equal(partsInZone(next, tz).weekday, weekday, `${tz} landed on the wrong weekday`);
      assert.equal(partsInZone(next, tz).hour, 10);
      // Never more than a week out.
      assert.ok(next.getTime() - now.getTime() <= 8 * 24 * 3600 * 1000);
    }
  }
});

test('an unknown or missing timezone degrades to UTC instead of throwing', () => {
  assert.equal(safeTimeZone('Not/AZone'), 'UTC');
  assert.equal(safeTimeZone(''), 'UTC');
  assert.equal(safeTimeZone(null), 'UTC');
  assert.equal(safeTimeZone(undefined), 'UTC');
  assert.equal(safeTimeZone(42), 'UTC');
  assert.equal(safeTimeZone('  Europe/Paris  '), 'Europe/Paris');
});

test('the weekly scheduler uses the zone-aware helpers, not runtime local time', () => {
  const weekly = read('supabase/functions/auto-generate-weekly/index.ts');
  assert.match(weekly, /nextOccurrenceInZone\(/);
  assert.match(weekly, /safeTimeZone\(profile\.timezone\)/);
  // The UTC-bound calls this replaced must be gone.
  assert.doesNotMatch(weekly, /setHours\(hour, minute, 0, 0\)/);
  assert.doesNotMatch(weekly, /scheduledDate\.getDay\(\)/);
});

test('the timezone column exists and the app persists it', () => {
  const migration = read('supabase/migrations/20260724000000_profile_timezone.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC'/);
  // Existing rows must keep today's behaviour.
  assert.match(migration, /DEFAULT 'UTC'/);

  assert.match(read('src/pages/Onboarding.tsx'), /timezone: browserTimeZone\(\)/);
  assert.match(read('src/pages/Profile.tsx'), /timezone: profile\.timezone/);

  // A new migration is worthless if the deploy pipeline never applies it.
  assert.match(
    read('.github/workflows/deploy-functions.yml'),
    /20260724000000_profile_timezone\.sql/,
    'the deploy workflow must apply the timezone migration',
  );
});
