// W11 regression: _CP_FACET_DIRECT (nimbus-session.ts ~line 413) extended
// to include framework bins (astro, nuxt, nuxi, remix, svelte-kit, next).
// Without this, `npm run dev` running `astro` (bare name) returns a lookup
// miss in _classifyCommand and exits 127. Reviewer comment 2 on the W11 plan.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(HERE, '..', '..', '..', '..', 'src', 'nimbus-session.ts');

await group('_CP_FACET_DIRECT includes framework bins', () => {
  const txt = fs.readFileSync(SESSION, 'utf8');
  const m = txt.match(/const\s+_CP_FACET_DIRECT\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  ok('_CP_FACET_DIRECT set found', !!m);
  const body = (m && m[1]) || '';
  for (const bin of ['astro', 'nuxt', 'nuxi', 'remix', 'svelte-kit', 'next']) {
    ok(`includes '${bin}'`, body.includes(`'${bin}'`));
  }
});

await summary('w11/regression/cp-facet-direct-includes-frameworks');
