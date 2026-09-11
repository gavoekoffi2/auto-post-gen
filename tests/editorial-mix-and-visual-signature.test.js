import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');

const weekly = read('server/src/services/weekly.ts');
const manual = read('server/src/services/text.ts');
const generation = read('server/src/services/generation.ts');
const profile = read('src/pages/Profile.tsx');
const dashboard = read('src/pages/Dashboard.tsx');
const schema = read('server/migrations/0001_core_schema.sql');

test('weekly generation supports a user-selected number of current research posts', () => {
  assert.match(schema, /research_posts_per_week\s+integer NOT NULL DEFAULT 1/);
  assert.match(profile, /research_posts_per_week/);
  assert.match(profile, /Posts d’actualité et de recherche par semaine/);
  assert.match(weekly, /research_posts_per_week/);
  assert.match(weekly, /category === "research"/);
  assert.match(weekly, /ACTUALITÉ\/RECHERCHE/);
});

test('the weekly mix is persisted so a top-up preserves the chosen quotas', () => {
  assert.match(schema, /content_category\s+text/);
  assert.match(schema, /content_category IN \('value', 'research', 'promo'\)/);
  // The category is written on the row, and read back to count what the week
  // already carries — otherwise a second run adds promos on top of the cap.
  assert.match(weekly, /SELECT content_category FROM posts/);
  assert.match(weekly, /content_category === "promo"/);
  assert.match(weekly, /content_category === "research"/);
});

test('non-promotional text never mentions or promotes the company name', () => {
  // A "value" post that names the business is an advert the user did not ask
  // for, spent against their value quota.
  assert.match(weekly, /N'écris JAMAIS le nom de l'entreprise/);
  assert.match(manual, /N'écris JAMAIS le nom de l'entreprise/);
  assert.doesNotMatch(weekly, /Mentionne \$\{companyName\} subtilement/);
  assert.doesNotMatch(manual, /Positionne \$\{companyName\} comme expert/);
});

test('generated images complement the post and use a fixed discreet brand signature', () => {
  assert.match(generation, /complémentaire au texte/);
  assert.match(generation, /signature de marque discrète dans l'angle inférieur droit/);
  assert.match(generation, /ne transforme pas le visuel en publicité/);
  assert.match(generation, /contentCategory/);
  // The dashboard passes the post's editorial category when it creates the
  // post and when it asks for the poster, so the visual matches the intent.
  assert.match(dashboard, /contentCategory: data\.postType/);
});

test('only promotional visuals request a sales CTA', () => {
  assert.match(generation, /input\.contentCategory === "promo"/);
  assert.match(generation, /Appel à l'action commercial clair/);
});

test('the weekly and manual generators share one renderer and one engagement guard', () => {
  // Two copies of the poster brief, or two engagement guards, is how the
  // automatic path quietly stops honouring what the manual path promises.
  for (const [name, source] of [['weekly', weekly], ['manual', manual]]) {
    assert.match(source, /ensurePostEngagement\(/, `${name} must pass through the guard`);
    assert.match(source, /maxChars: textLimit\.maxChars/, `${name} must cap the final text`);
  }
  assert.match(weekly, /startPosterJob\(/);
  assert.match(read('server/src/routes/generations.ts'), /startPosterJob\(/);
  // Exactly one place builds the brief.
  assert.match(generation, /function buildSubject/);
});
