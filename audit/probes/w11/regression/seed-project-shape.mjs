// W11 regression: src/seed-project.ts surface unchanged.
// We allow README content to grow (plan §6 may add a "Supported frameworks"
// section) but the SEED_FILES list must still contain the canonical files
// and the public exports must remain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, '..', '..', '..', '..', 'src', 'seed-project.ts');

await group('seed-project surface', () => {
  const txt = fs.readFileSync(SEED, 'utf8');
  ok('exports SEED_PROJECT_DIR', /export\s+const\s+SEED_PROJECT_DIR\s*=/.test(txt));
  ok('exports SEED_SENTINEL_PATH', /export\s+const\s+SEED_SENTINEL_PATH\s*=/.test(txt));
  ok('exports SEED_FILES', /export\s+const\s+SEED_FILES\s*:\s*SeedFile\[\]/.test(txt));
  ok('exports seedProject', /export\s+function\s+seedProject\s*\(/.test(txt));
  ok('exports shouldSeedProject', /export\s+function\s+shouldSeedProject\s*\(/.test(txt));

  // Canonical files still present
  for (const f of [
    'package.json',
    'index.html',
    'vite.config.ts',
    'tailwind.config.js',
    'tsconfig.json',
    'README.md',
    'src/index.css',
    'src/main.tsx',
    'src/App.tsx',
  ]) {
    ok(`SEED_FILES includes ${f}`, txt.includes(`'/${f}'`) || txt.includes(`"/${f}"`));
  }
});

await summary('w11/regression/seed-project-shape');
