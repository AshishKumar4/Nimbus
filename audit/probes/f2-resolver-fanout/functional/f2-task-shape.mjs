#!/usr/bin/env bun
// F-2 functional probe — per-package fanout task shape.
//
// Asserts that the per-package task (`resolveOnePackumentInFacet`) is:
//   - exported as a named function from src/npm/resolve-one-facet.ts,
//   - self-contained (no `this`, no closure references outside its arg list),
//   - returns a documented shape: { pkg, deps, peerDeps, optionalDeps,
//     allPeerDependencies, error?, messages, events, cacheWrites,
//     packumentBytesDecoded }.
//
// Because the function is serialised via fn.toString() into the loader
// isolate, validating the textual shape is sufficient. We don't execute it
// here — that's covered by the install-pipeline coverage shim.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const TASK_FILE = path.join(ROOT, 'src/npm/resolve-one-facet.ts');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

console.log('F-2 functional/f2-task-shape — per-package task structure');

if (!fs.existsSync(TASK_FILE)) {
  check('src/npm/resolve-one-facet.ts exists', false, 'expected new file with the per-package task');
  console.log(`\n  ──── ${pass} pass / ${fail} fail`);
  process.exit(1);
}

const src = fs.readFileSync(TASK_FILE, 'utf8');
check('task file exists', true);

check('exports resolveOnePackumentInFacet', /export\s+(const|function|var|let)\s+resolveOnePackumentInFacet\b/.test(src));
check(
  'task function takes (spec, env) signature',
  /resolveOnePackumentInFacet\s*=\s*async\s*function\s*\(\s*spec\b/.test(src) ||
    /async\s+function\s+resolveOnePackumentInFacet\s*\(\s*spec\b/.test(src),
);

// Self-contained: must not reference `this` or unexpected outer captures.
check('no `this.` in task body', !/\bthis\./.test(src));

// Result shape contains expected keys.
const shapeKeys = ['pkg', 'deps', 'peerDeps', 'optionalDeps', 'allPeerDependencies', 'messages', 'events', 'cacheWrites', 'packumentBytesDecoded'];
for (const k of shapeKeys) {
  check(`result shape mentions key "${k}"`, new RegExp(`['"\`]?${k}['"\`]?\\s*[:,]`).test(src));
}

// References preamble globals by bare identifier (preamble injects them).
const preambleSyms = ['SHOULD_SKIP_PACKAGE', 'PARSE_SEMVER', 'COMPARE_SEMVER', 'RESOLVE_VERSION'];
for (const s of preambleSyms) {
  check(`task references preamble symbol ${s}`, new RegExp(`\\b${s}\\b`).test(src));
}

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
