import test from 'node:test';
import assert from 'node:assert/strict';

// The dashboard's date/time round-trip mixed clocks: the date came from
// toISOString() (UTC) while the time came from toTimeString() (local), and the
// save joined them without an offset. Saving an untouched post shifted it by
// the user's UTC offset every time, and near midnight the date jumped a day.
// These tests exercise the extracted helpers directly.
import {
  combineDateAndTime,
  localDateTimeToIso,
  toLocalDateInput,
  toLocalTimeInput,
} from '../src/lib/schedule.ts';

test('reading and writing back an unchanged instant is lossless', () => {
  // The regression: read → write must be a fixed point, in ANY timezone.
  for (const iso of [
    '2026-08-17T09:00:00.000Z',
    '2026-01-01T23:45:00.000Z',
    '2026-06-30T00:15:00.000Z',
    '2026-12-31T22:30:00.000Z',
  ]) {
    const date = toLocalDateInput(iso);
    const time = toLocalTimeInput(iso);
    assert.equal(
      localDateTimeToIso(date, time),
      iso,
      `${iso} changed on a no-op save (TZ=${process.env.TZ || 'system'})`,
    );
  }
});

test('the date and the time are read from the same clock', () => {
  // An instant that falls on a different calendar day in UTC than locally is
  // exactly where the old split produced a one-day jump.
  const instant = new Date('2026-08-17T23:30:00Z');
  const date = toLocalDateInput(instant);
  const time = toLocalTimeInput(instant);
  const rebuilt = new Date(localDateTimeToIso(date, time));
  assert.equal(rebuilt.getTime(), instant.getTime());
  assert.equal(rebuilt.getDate(), instant.getDate(), 'same local day');
  assert.equal(rebuilt.getHours(), instant.getHours(), 'same local hour');
});

test('an incomplete form clears the schedule instead of storing garbage', () => {
  assert.equal(localDateTimeToIso('', '10:00'), null);
  assert.equal(localDateTimeToIso('2026-08-17', ''), null);
  assert.equal(localDateTimeToIso(undefined, undefined), null);
  assert.equal(localDateTimeToIso(null, null), null);
});

test('impossible dates and times are rejected, not silently rolled over', () => {
  // new Date(2026, 3, 31) silently becomes 1 May — that must not be stored.
  assert.equal(localDateTimeToIso('2026-04-31', '10:00'), null);
  assert.equal(localDateTimeToIso('2026-13-01', '10:00'), null);
  assert.equal(localDateTimeToIso('2026-02-30', '10:00'), null);
  assert.equal(localDateTimeToIso('2026-08-17', '25:00'), null);
  assert.equal(localDateTimeToIso('2026-08-17', '10:75'), null);
  assert.equal(localDateTimeToIso('not-a-date', 'nope'), null);
});

test('a real leap day is accepted', () => {
  assert.notEqual(localDateTimeToIso('2028-02-29', '10:00'), null);
  assert.equal(localDateTimeToIso('2027-02-29', '10:00'), null, '2027 is not a leap year');
});

test('an unparseable instant yields empty inputs rather than "NaN"', () => {
  assert.equal(toLocalDateInput('nonsense'), '');
  assert.equal(toLocalTimeInput('nonsense'), '');
});

test('combineDateAndTime matches the two-step conversion', () => {
  const day = new Date('2026-08-17T12:00:00Z');
  assert.equal(
    combineDateAndTime(day, '14:30'),
    localDateTimeToIso(toLocalDateInput(day), '14:30'),
  );
  assert.equal(combineDateAndTime(day, 'bad'), null);
});

test('values are zero-padded so the inputs are valid HTML', () => {
  const jan = new Date(2026, 0, 5, 9, 7);
  assert.equal(toLocalDateInput(jan), '2026-01-05');
  assert.equal(toLocalTimeInput(jan), '09:07');
});
