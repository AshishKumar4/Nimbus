#!/usr/bin/env bun
// X.5-26b e2e — `npm install @tailwindcss/vite` must transitively reject
// because it depends on `tailwindcss@^4` which depends on `@tailwindcss/oxide`,
// and the latter is in REJECT_INSTALL with transitive='fail'.
//
// PRE-FIX: install succeeds (232 files), runtime fails with native binding gap.
// POST-FIX: install rejected at the transitive @tailwindcss/oxide layer.
//
// This is the bonus +1 healthy cohort flip beyond the direct oxide flip.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'tailwindcss-vite-transitive-e2e.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
const r = await runProbe('x526b tailwindcss-vite-transitive', [
  { kind: 'cmd', cmd: 'cd app && npm install @tailwindcss/vite', timeoutMs: 180_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else      { failed++; console.log(`  NOT OK  ${label}`); }
}

ok('probe ran (POST /new succeeded)', r.ok);
// Transitive reject path in src/npm-resolve-facet.ts:525 throws:
//   `npm install rejected: ${__fail.from} — ${__fail.reason}`
// (single-line; no ❌ prefix — that prefix only appears in
// formatRejectError's multi-line head, used on top-level rejects.)
ok('install output mentions transitive reject of @tailwindcss/oxide',
  txt.includes('npm install rejected: @tailwindcss/oxide'));
ok('install output mentions "npm install rejected" (any form)',
  /npm install rejected/i.test(txt));
ok('install output mentions "resolver-facet failed" (transitive bubble path)',
  /resolver-facet failed/i.test(txt));

console.log('');
console.log(`# x526b tailwindcss-vite-transitive-e2e: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
