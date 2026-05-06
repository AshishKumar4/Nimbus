#!/usr/bin/env bun
// X.5-drizzle e2e — `npm install drizzle-orm` inside the seeded starter
// must INSTALL CLEANLY (no REJECT) post-fix.
//
// PRE-FIX: install rejected with `npm install rejected: lightningcss`
// (verify-9d4b61d/packages-local/drizzle-orm.out.txt:24-28).
// POST-FIX: install succeeds; "added N packages" line present;
// no "npm install rejected" anywhere in output.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'drizzle-orm-installs.out.txt');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8789');
  process.exit(2);
}

fs.writeFileSync(ARTIFACT, '');
const r = await runProbe('x5-drizzle drizzle-orm-installs', [
  { kind: 'cmd', cmd: 'cd app && npm install drizzle-orm', timeoutMs: 240_000 },
], { artifactPath: ARTIFACT, settleMs: 3000 });

const txt = fs.readFileSync(ARTIFACT, 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else      { failed++; console.log(`  NOT OK  ${label}` + (detail ? ` — ${detail}` : '')); }
}

ok('probe ran (POST /new succeeded)', r.ok);
ok('install output contains "added N packages"', /added \d+ packages?/.test(txt),
   `last 200 chars: ${txt.slice(-200)}`);
// Post-fix: lightningcss is soft-skipped via the X.5-drizzle best-effort
// path; the [skip] notice quotes the original error message verbatim so
// "npm install rejected" appears INSIDE a `[skip]` line. We assert the
// outcome instead: NO top-level "npm install failed" / "resolver-facet
// failed" line, AND a `[skip] lightningcss` notice IS present.
ok('install output does NOT contain "npm install failed"', !/npm install failed/.test(txt),
   `if RED: install was rejected at top level`);
ok('install output does NOT contain "❌ lightningcss"', !/❌ lightningcss/.test(txt));
ok('drizzle-orm finished without "resolver-facet failed"', !/resolver-facet failed:/.test(txt),
   `pre-fix this said "resolver-facet failed: npm install rejected: lightningcss"`);
ok('lightningcss soft-skipped (X.5-drizzle)',
   /\[skip\]\s+lightningcss\s+—\s+inside best-effort optional-peer subtree \(X\.5-drizzle\)/.test(txt));

console.log('');
console.log(`# x5-drizzle drizzle-orm-installs: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
