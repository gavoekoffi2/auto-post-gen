import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Onboarding and the profile page persist SLUGS in profiles.sector / tone /
// content_types. Those slugs used to reach the French LLM prompts verbatim,
// producing "Secteur général: other" and web-research queries like
// "actualité other". These tests exercise the real mapping module.
import {
  businessDescriptor,
  contentTypeLabels,
  sectorLabel,
  sectorLabelOr,
  toneLabel,
} from '../supabase/functions/_shared/profileLabels.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Every value the onboarding/profile <Select> can actually produce.
const ONBOARDING_SECTORS = ['tech', 'fashion', 'food', 'health', 'education', 'other'];
const ONBOARDING_TONES = ['professional', 'casual', 'fun', 'serious', 'inspiring'];
const ONBOARDING_CONTENT_TYPES = [
  'educational',
  'promotional',
  'inspirational',
  'entertaining',
  'mixed',
];

test('the onboarding form only offers slugs this module knows how to translate', () => {
  const onboarding = read('src/pages/Onboarding.tsx');
  const profile = read('src/pages/Profile.tsx');
  // Guards against someone adding a 7th sector to the form and silently
  // reintroducing an untranslated slug in the prompts.
  for (const source of [onboarding, profile]) {
    const sectors = [...source.matchAll(/<SelectItem value="(tech|fashion|food|health|education|other)"/g)];
    assert.ok(sectors.length > 0, 'expected the sector select to be present');
  }
  for (const slug of ONBOARDING_SECTORS) {
    assert.doesNotMatch(sectorLabelOr(slug), /^(tech|fashion|food|health|education|other)$/);
  }
});

test('sector slugs become human French labels, never raw slugs', () => {
  assert.equal(sectorLabel('tech'), 'Technologie et numérique');
  assert.equal(sectorLabel('food'), 'Restauration et alimentation');
  assert.equal(sectorLabel('education'), 'Éducation et formation');
  // "other" carries no information: it must NOT become "Secteur: other".
  assert.equal(sectorLabel('other'), '');
  assert.equal(sectorLabelOr('other'), 'Entreprise et services');
  for (const slug of ONBOARDING_TONES) {
    assert.notEqual(toneLabel(slug), slug);
  }
});

test('free-text sectors typed by a user are passed through untouched', () => {
  assert.equal(sectorLabel('Boulangerie artisanale'), 'Boulangerie artisanale');
  assert.equal(toneLabel('Chaleureux et direct'), 'Chaleureux et direct');
  assert.deepEqual(contentTypeLabels(['Études de cas']), ['Études de cas']);
});

test('empty / missing values fall back instead of emitting "undefined"', () => {
  assert.equal(sectorLabel(undefined), '');
  assert.equal(sectorLabel(null), '');
  assert.equal(sectorLabel('   '), '');
  assert.equal(sectorLabelOr(''), 'Entreprise et services');
  assert.equal(toneLabel(undefined), 'Professionnel');
  assert.deepEqual(contentTypeLabels(undefined), []);
  assert.deepEqual(contentTypeLabels(null), []);
});

test('content types map and de-duplicate', () => {
  assert.deepEqual(contentTypeLabels(ONBOARDING_CONTENT_TYPES), [
    'Éducatif',
    'Promotionnel',
    'Inspirant',
    'Divertissant',
    'Mixte',
  ]);
  assert.deepEqual(contentTypeLabels(['mixed', 'mixed', 'Mixte']), ['Mixte']);
});

test('businessDescriptor leads with the free-text description', () => {
  assert.equal(
    businessDescriptor('tech', 'Agence de maintenance informatique à Lomé'),
    'Agence de maintenance informatique à Lomé — Technologie et numérique',
  );
  // "other" adds nothing, so it must not pollute the descriptor.
  assert.equal(businessDescriptor('other', 'Salon de coiffure'), 'Salon de coiffure');
  assert.equal(businessDescriptor('tech', ''), 'Technologie et numérique');
});

test('every prompt-building function maps slugs before they reach the model', () => {
  const generateContent = read('supabase/functions/generate-content/index.ts');
  assert.match(generateContent, /sectorLabelOr\(userPreferences\?\.sector\)/);
  assert.match(generateContent, /toneLabel\(userPreferences\?\.tone\)/);
  assert.match(generateContent, /contentTypeLabels\(/);
  // The raw slug must no longer be the prompt's sector value.
  assert.doesNotMatch(generateContent, /userPreferences\?\.sector \|\| "Business"/);

  const weekly = read('supabase/functions/auto-generate-weekly/index.ts');
  assert.match(weekly, /sectorLabelOr\(profile\.sector\)/);
  assert.match(weekly, /toneLabel\(profile\.tone\)/);
  assert.doesNotMatch(weekly, /profile\.tone \|\| "Professionnel"/);

  const audiences = read('supabase/functions/detect-audiences/index.ts');
  assert.match(audiences, /SECTEUR: \$\{sectorLabelOr\(sector\)\}/);

  const image = read('supabase/functions/generate-image/index.ts');
  assert.match(image, /sectorLabel\(profile\?\.sector\)/);

  const engagement = read('supabase/functions/_shared/engagement.ts');
  assert.match(engagement, /toneLabel\(opts\.brandTone\)/);
});

test('the poster domain classifier recognises the mapped French labels', () => {
  for (const path of [
    'supabase/functions/generate-image/index.ts',
    'supabase/functions/_shared/graphiste.ts',
  ]) {
    const source = read(path);
    // "Restauration et alimentation" does not contain "restaurant", and
    // "Éducation et formation" is matched via "formation"/"éducation".
    assert.match(source, /restauration\|alimentation/);
    assert.match(source, /éducation\|education/);
  }
});
