// W11 regression: BUNDLER_BIN_PREFIXES (nimbus-session.ts:211) keeps
// recognizing all 5 framework CLIs. If any goes missing, `npm run dev`
// guards (line 3856 detectBundlerBin) won't hard-fail on missing
// node_modules, leading to silent "command not found" for the user.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(HERE, '..', '..', '..', '..', 'src', 'nimbus-session.ts');

await group('BUNDLER_BIN_PREFIXES includes framework CLIs', () => {
  const txt = fs.readFileSync(SESSION, 'utf8');
  // Locate the array literal.
  const m = txt.match(/const\s+BUNDLER_BIN_PREFIXES\s*=\s*\[([\s\S]*?)\];/);
  ok('BUNDLER_BIN_PREFIXES array found', !!m);
  const body = (m && m[1]) || '';
  for (const bin of ['vite', 'next', 'nuxt', 'remix', 'astro', 'svelte-kit']) {
    ok(`includes '${bin}'`, body.includes(`'${bin}'`));
  }
});

await summary('w11/regression/bundler-bin-prefixes-include-frameworks');
