import test from 'node:test';
import assert from 'node:assert/strict';

// The weekly generator built its publish instants with Date#setHours, which
// resolves in the edge runtime's clock (UTC). A user in Abidjan asking for
// "Lundi 10:00" was published at 10:00 UTC, and one in Nairobi at 13:00 local.
// These tests exercise the real conversion, not the source text.
import {
  DAY_NAME_TO_INDEX,
  nextWeeklySlot,
  parsePreferredTime,
  safeTimeZone,
  weekdayInZone,
  zoneOffsetMinutes,
  zonedWallClockToInstant,
} from '../supabase/functions/_shared/schedule.ts';

test('zone offsets are read from the zone, not the runtime', () => {
  const midYear = new Date('2026-07-01T12:00:00Z');
  assert.equal(zoneOffsetMinutes(midYear, 'UTC'), 0);
  assert.equal(zoneOffsetMinutes(midYear, 'Africa/Abidjan'), 0);       // UTC+0
  assert.equal(zoneOffsetMinutes(midYear, 'Africa/Lagos'), 60);        // UTC+1
  assert.equal(zoneOffsetMinutes(midYear, 'Africa/Nairobi'), 180);     // UTC+3
  assert.equal(zoneOffsetMinutes(midYear, 'Asia/Kolkata'), 330);       // UTC+5:30
});

test('a wall-clock slot maps to the instant that shows that time locally', () => {
  // 10:00 in Lagos (UTC+1) is 09:00Z.
  const lagos = zonedWallClockToInstant(2026, 8, 17, 10, 0, 'Africa/Lagos');
  assert.equal(lagos.toISOString(), '2026-08-17T09:00:00.000Z');

  // 10:00 in Nairobi (UTC+3) is 07:00Z.
  const nairobi = zonedWallClockToInstant(2026, 8, 17, 10, 0, 'Africa/Nairobi');
  assert.equal(nairobi.toISOString(), '2026-08-17T07:00:00.000Z');

  // UTC users keep exactly the previous behaviour.
  const utc = zonedWallClockToInstant(2026, 8, 17, 10, 0, 'UTC');
  assert.equal(utc.toISOString(), '2026-08-17T10:00:00.000Z');
});

test('DST is resolved against the offset in effect at the target', () => {
  // Paris is UTC+1 in winter and UTC+2 in summer; both must render as 10:00.
  const winter = zonedWallClockToInstant(2026, 1, 15, 10, 0, 'Europe/Paris');
  const summer = zonedWallClockToInstant(2026, 7, 15, 10, 0, 'Europe/Paris');
  assert.equal(winter.toISOString(), '2026-01-15T09:00:00.000Z');
  assert.equal(summer.toISOString(), '2026-07-15T08:00:00.000Z');

  const localHour = (d) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false })
      .format(d);
  assert.equal(localHour(winter), '10');
  assert.equal(localHour(summer), '10');
});

test('the weekday is the one the user sees, not the server', () => {
  // 23:30Z on a Sunday is already Monday in Nairobi (+3).
  const instant = new Date('2026-08-16T23:30:00Z'); // Sunday in UTC
  assert.equal(weekdayInZone(instant, 'UTC'), 0, 'Sunday in UTC');
  assert.equal(weekdayInZone(instant, 'Africa/Nairobi'), 1, 'already Monday locally');
});

test('nextWeeklySlot lands on the requested local day and time', () => {
  const now = new Date('2026-08-17T06:00:00Z'); // Monday
  const slot = nextWeeklySlot({
    now,
    timeZone: 'Africa/Lagos',
    weekday: DAY_NAME_TO_INDEX.Mercredi,
    hour: 10,
    minute: 0,
  });
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(slot);
  assert.match(local, /Wednesday/);
  assert.match(local, /10:00/);
  assert.ok(slot.getTime() > now.getTime(), 'always in the future');
});

test('a same-day slot whose time has passed moves to next week', () => {
  // Monday 12:00 Lagos local (11:00Z); asking for Monday 10:00 must skip a week.
  const now = new Date('2026-08-17T11:00:00Z');
  const slot = nextWeeklySlot({
    now,
    timeZone: 'Africa/Lagos',
    weekday: DAY_NAME_TO_INDEX.Lundi,
    hour: 10,
    minute: 0,
  });
  assert.equal(slot.toISOString(), '2026-08-24T09:00:00.000Z');
});

test('a same-day slot still ahead keeps today', () => {
  const now = new Date('2026-08-17T06:00:00Z'); // 07:00 Lagos
  const slot = nextWeeklySlot({
    now,
    timeZone: 'Africa/Lagos',
    weekday: DAY_NAME_TO_INDEX.Lundi,
    hour: 10,
    minute: 0,
  });
  assert.equal(slot.toISOString(), '2026-08-17T09:00:00.000Z');
});

test('weeksAhead separates posts whose day rotation wrapped', () => {
  const now = new Date('2026-08-17T06:00:00Z');
  const base = { now, timeZone: 'UTC', weekday: DAY_NAME_TO_INDEX.Lundi, hour: 10, minute: 0 };
  const first = nextWeeklySlot(base);
  const second = nextWeeklySlot({ ...base, weeksAhead: 1 });
  assert.notEqual(first.toISOString(), second.toISOString());
  assert.equal(second.getTime() - first.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test('an unknown timezone degrades to UTC instead of throwing', () => {
  assert.equal(safeTimeZone('Mars/Olympus'), 'UTC');
  assert.equal(safeTimeZone(''), 'UTC');
  assert.equal(safeTimeZone(null), 'UTC');
  assert.equal(safeTimeZone('Africa/Abidjan'), 'Africa/Abidjan');
  // A whole batch must still generate for a profile with a corrupt zone.
  const slot = nextWeeklySlot({
    now: new Date('2026-08-17T06:00:00Z'),
    timeZone: 'Not/AZone',
    weekday: 1,
    hour: 10,
    minute: 0,
  });
  assert.equal(slot.toISOString(), '2026-08-17T10:00:00.000Z');
});

test('preferred_time parsing clamps and defaults', () => {
  assert.deepEqual(parsePreferredTime('10:00'), { hour: 10, minute: 0 });
  assert.deepEqual(parsePreferredTime('09:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parsePreferredTime('99:99'), { hour: 23, minute: 59 });
  assert.deepEqual(parsePreferredTime('garbage'), { hour: 10, minute: 0 });
  assert.deepEqual(parsePreferredTime(undefined), { hour: 10, minute: 0 });
  assert.deepEqual(parsePreferredTime('7'), { hour: 7, minute: 0 });
});
