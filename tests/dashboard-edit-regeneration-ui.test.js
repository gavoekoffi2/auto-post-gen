import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'src/pages/Dashboard.tsx'), 'utf8');

test('dashboard exposes regenerate image and regenerate content actions on cards and edit dialog', () => {
  assert.match(source, /handleRegenerateImage/);
  assert.match(source, /handleRegenerateContent/);
  assert.match(source, /Régénérer l(?:’|')affiche/);
  assert.match(source, /Régénérer le contenu/);
  assert.match(source, /current\?\.id === post\.id \? \{ \.\.\.current, image_url: url \} : current/);
});

test('edit dialog is large, scrollable, and uses a tall readable content editor', () => {
  assert.match(source, /DialogContent className="glass-card max-w-5xl max-h-\[92vh\] overflow-hidden/);
  assert.match(source, /ScrollArea className="max-h-\[74vh\] pr-4/);
  assert.match(source, /className="glass-card min-h-\[320px\] text-base leading-relaxed/);
});
