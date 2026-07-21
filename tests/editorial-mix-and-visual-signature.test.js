import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');

const weekly = read('supabase/functions/auto-generate-weekly/index.ts');
const manual = read('supabase/functions/generate-content/index.ts');
const image = read('supabase/functions/generate-image/index.ts');
const graphiste = read('supabase/functions/_shared/graphiste.ts');
const profile = read('src/pages/Profile.tsx');
const dashboard = read('src/pages/Dashboard.tsx');
const migration = read('supabase/migrations/20260721000000_editorial_mix.sql');

test('weekly generation supports a user-selected number of current research posts', () => {
  assert.match(migration, /research_posts_per_week integer NOT NULL DEFAULT 1/);
  assert.match(profile, /research_posts_per_week/);
  assert.match(profile, /Posts d’actualité et de recherche par semaine/);
  assert.match(weekly, /profile\.research_posts_per_week/);
  assert.match(weekly, /contentCategory === "research"/);
  assert.match(weekly, /ACTUALITÉ\/RECHERCHE/);
  assert.match(weekly, /faits trouvés dans la matière web/);
});

test('weekly mix is persisted so retries preserve the chosen promo/research/value quotas', () => {
  assert.match(migration, /content_category text/);
  assert.match(migration, /CHECK \(content_category IN \('value', 'research', 'promo'\)\)/);
  assert.match(weekly, /\.select\("id, content_category, title"\)/);
  assert.match(weekly, /content_category: contentCategory/);
  assert.match(weekly, /existingCategoryCounts/);
});

test('non-promotional text never mentions or promotes the company name', () => {
  assert.match(weekly, /N'écris JAMAIS le nom de l'entreprise/);
  assert.match(manual, /N'écris JAMAIS le nom de l'entreprise/);
  assert.doesNotMatch(weekly, /Tu peux mentionner "\$\{companyName\}" une seule fois maximum/);
  assert.doesNotMatch(manual, /Mentionne \$\{companyName\} subtilement/);
  assert.doesNotMatch(manual, /Positionne \$\{companyName\} comme expert/);
});

test('generated images complement the post and use a fixed discreet brand signature', () => {
  for (const source of [image, graphiste]) {
    assert.match(source, /complémentaire au texte/);
    assert.match(source, /angle inférieur droit/);
    assert.match(source, /signature de marque discrète/);
    assert.match(source, /ne transforme pas le visuel en publicité/);
    assert.match(source, /contentCategory/);
  }
  assert.match(dashboard, /contentCategory: data\.postType/);
  assert.match(dashboard, /content_category: data\.postType/);
});

test('only promotional visuals request a sales CTA', () => {
  assert.match(image, /params\.contentCategory === "promo"/);
  assert.match(graphiste, /params\.contentCategory === "promo"/);
});
