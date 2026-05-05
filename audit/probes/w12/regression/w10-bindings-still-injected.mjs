#!/usr/bin/env bun
// W12 regression: W10's KV / D1 / R2 emulators still wire into
// nimbus-wrangler buildInnerEnv. Drift detector.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const KV = path.join(ROOT, 'src', 'binding-kv.ts');
const D1 = path.join(ROOT, 'src', 'binding-d1.ts');
const R2 = path.join(ROOT, 'src', 'binding-r2.ts');
const WRANGLER = path.join(ROOT, 'src', 'nimbus-wrangler.ts');

await group('W10 binding sources still present', () => {
  ok('binding-kv.ts exists', fs.existsSync(KV));
  ok('binding-d1.ts exists', fs.existsSync(D1));
  ok('binding-r2.ts exists', fs.existsSync(R2));
  ok('nimbus-wrangler.ts exists', fs.existsSync(WRANGLER));
});

await group('nimbus-wrangler still injects KV / D1 / R2 emulators', () => {
  const txt = fs.readFileSync(WRANGLER, 'utf8');
  ok('imports binding-kv', /from\s+['"]\.\/binding-kv\.js['"]/.test(txt) || txt.includes("'./binding-kv"));
  ok('imports binding-d1', /from\s+['"]\.\/binding-d1\.js['"]/.test(txt) || txt.includes("'./binding-d1"));
  ok('imports binding-r2', /from\s+['"]\.\/binding-r2\.js['"]/.test(txt) || txt.includes("'./binding-r2"));
});

summary('w12/regression/w10-bindings-still-injected');
