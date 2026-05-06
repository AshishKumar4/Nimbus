// X.5-L regression probe — re-runs every X.5-C probe via the X.5-C
// run-all script. Asserts the full X.5-C suite is still green after
// the X.5-L change.
//
// Why a wrapper instead of duplicating: the X.5-C suite is the
// authoritative test for the ESM walker behaviour. Forking would
// drift; this wrapper guarantees parity.
//
// Pre-fix and post-fix: PASS (X.5-L is additive over X.5-C).

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-L regression/r3-x5c-fixes-still-green — X.5-C suite still PASS');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const X5C_RUN = path.resolve(HERE, '..', '..', 'x5c', 'run-all.mjs');

let exit = 0;
let out = '';
try {
  out = execSync(`bun ${X5C_RUN}`, { encoding: 'utf8', timeout: 240_000 });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
  exit = e.status || 1;
}

// Print the last 30 lines for visibility (full X.5-C suite is verbose).
const lines = out.split('\n');
const tail = lines.slice(Math.max(0, lines.length - 30)).join('\n');
console.log('  --- X.5-C run-all tail ---');
console.log(tail.split('\n').map(l => '  ' + l).join('\n'));
console.log('  --- end tail ---');

check(
  'X.5-C run-all exits 0',
  exit === 0,
  `exit=${exit}; see _results/run-all.json`,
);

// Also check the last summary line for `0 fail`.
const sumLine = lines.find(l => l.includes('pass /') && l.includes('fail'));
check(
  'X.5-C summary line reports 0 failures',
  sumLine && /0 fail/.test(sumLine),
  sumLine || '(no summary line found)',
);

const ok = summary();
process.exit(ok ? 0 : 1);
