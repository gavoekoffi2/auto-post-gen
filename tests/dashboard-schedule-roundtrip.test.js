import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { joinLocalDateTime, splitLocalDateTime } from '../src/lib/timezone.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the date and the time come from the same clock', () => {
  // 2026-09-09T22:30Z is already 2026-09-10 00:30 in Paris. Reading the date
  // via toISOString() (UTC) and the time via toTimeString() (local) produced
  // "2026-09-09" + "00:30" — an instant that never existed.
  const parts = splitLocalDateTime('2026-09-09T22:30:00.000Z');
  assert.equal(typeof parts.date, 'string');
  assert.equal(typeof parts.time, 'string');
  // Whatever the test machine's zone, the pair must round-trip exactly.
  assert.equal(joinLocalDateTime(parts.date, parts.time), '2026-09-09T22:30:00.000Z');
});

test('editing and re-saving a post does not move it', () => {
  // The regression: the form rebuilt a zone-less "YYYY-MM-DDTHH:mm:00", which
  // Postgres reads as UTC, shifting the post by the user's offset every save.
  for (const iso of [
    '2026-01-15T09:00:00.000Z',
    '2026-07-15T08:00:00.000Z',
    '2026-09-09T22:30:00.000Z',
    '2026-12-31T23:45:00.000Z',
    '2026-03-01T00:15:00.000Z',
  ]) {
    const { date, time } = splitLocalDateTime(iso);
    assert.equal(joinLocalDateTime(date, time), iso, `round-trip lost ${iso}`);
  }
});

test('missing or malformed values yield empty fields, never "NaN" or "Invalid Date"', () => {
  assert.deepEqual(splitLocalDateTime(null), { date: '', time: '' });
  assert.deepEqual(splitLocalDateTime(undefined), { date: '', time: '' });
  assert.deepEqual(splitLocalDateTime(''), { date: '', time: '' });
  assert.deepEqual(splitLocalDateTime('not a date'), { date: '', time: '' });
  assert.equal(joinLocalDateTime('', ''), null);
  assert.equal(joinLocalDateTime('2026-09-09', ''), null);
  assert.equal(joinLocalDateTime('bogus', 'bogus'), null);
});

test('the dashboard uses the shared helpers rather than mixing clocks', () => {
  const dashboard = read('src/pages/Dashboard.tsx');
  assert.match(dashboard, /splitLocalDateTime\(/);
  assert.match(dashboard, /joinLocalDateTime\(/);
  assert.doesNotMatch(dashboard, /toISOString\(\)\.split\('T'\)\[0\]/);
  assert.doesNotMatch(dashboard, /toTimeString\(\)\.substring/);
  assert.doesNotMatch(dashboard, /\$\{editingPost\.date\}T\$\{editingPost\.time\}/);
});

test('statistics weeks start on Monday, as they do in France', () => {
  const stats = read('src/pages/Statistics.tsx');
  // `now.getDate() - now.getDay()` starts the week on Sunday.
  assert.match(stats, /const daysSinceMonday = \(now\.getDay\(\) \+ 6\) % 7/);
  assert.doesNotMatch(stats, /setDate\(now\.getDate\(\) - now\.getDay\(\)\)/);
});

test('the validation rate does not fall as posts get published', () => {
  const stats = read('src/pages/Statistics.tsx');
  // A published post was validated first but no longer carries that status,
  // so counting only 'validated' reached 0% for a user who published all.
  assert.match(stats, /stats\.validatedPosts \+ stats\.publishedPosts/);
});
