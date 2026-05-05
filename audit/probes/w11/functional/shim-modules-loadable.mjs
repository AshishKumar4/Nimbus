// W11 functional: each src/frameworks/<name>.ts module exists and exports
// a `description` string + a no-throw module top level. We don't import
// (they may pull in DO-only deps); we read+lex.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FW_DIR = path.resolve(HERE, '..', '..', '..', '..', 'src', 'frameworks');

const expected = ['next', 'astro', 'nuxt', 'remix', 'sveltekit'];

await group('framework shim files exist', () => {
  ok(`directory exists: ${FW_DIR}`, fs.existsSync(FW_DIR));
  for (const name of expected) {
    const f = path.join(FW_DIR, `${name}.ts`);
    ok(`src/frameworks/${name}.ts exists`, fs.existsSync(f));
  }
});

await group('each shim exports a description', () => {
  for (const name of expected) {
    const f = path.join(FW_DIR, `${name}.ts`);
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { /* RED phase */ }
    ok(
      `${name}.ts exports description`,
      /export\s+const\s+description\s*[:=]/.test(txt) ||
        /export\s+function\s+description\s*\(/.test(txt),
    );
  }
});

await summary('w11/functional/shim-modules-loadable');
