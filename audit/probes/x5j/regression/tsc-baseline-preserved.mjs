#!/usr/bin/env bun
// X5J regression: tsc --noEmit produces the same baseline (2 errors)
// as f4357a04 / eb316dc. The X.5-J fix MUST NOT introduce new tsc
// errors.
//
// VERIFY-EB316DC.md §0 confirms the eb316dc baseline is "2 errors,
// identical to f4357a04". This probe re-asserts that bound after the
// X.5-J edits land.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const ARTIFACT = path.join(HERE, 'tsc-baseline-preserved.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5J tsc-baseline-preserved ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

// Use `bun x` (NimbusFacetPool sandboxes don't always have bunx in PATH).
const r = spawnSync('bun', ['x', 'tsc', '--noEmit'], { cwd: ROOT, encoding: 'utf8' });
const out = (r.stdout || '') + '\n' + (r.stderr || '');
log('tsc exit: ' + r.status);
log('tsc output:');
log(out);

// Count error lines (tsc format: "<file>(<line>,<col>): error TS<code>: <message>")
const errorLines = out.split(/\n+/).filter(l => /error TS\d+:/.test(l));
const errorCount = errorLines.length;
log('error lines: ' + errorCount);
for (const e of errorLines) log('  ' + e);

// Baseline is 2 errors, byte-identical to f4357a04 / eb316dc.
const BASELINE = 2;
const t1 = errorCount <= BASELINE; // must not INCREASE; equal is OK; less is fine.
log('');
log('t1 tsc errors <= ' + BASELINE + ' (no new errors): ' + (t1 ? 'PASS' : 'FAIL'));

if (!t1) {
  log('FAIL: X5J introduced new tsc errors. Review diff.');
}

const allOK = t1;
log('OVERALL: ' + (allOK ? 'PASS' : 'FAIL'));
process.exit(allOK ? 0 : 1);
