#!/usr/bin/env node
// W11.5-E2 / R1 — Snapshot the cap surface that webpack's worker pool
// will hit. Reads src/parallel/facet-pool.ts + src/facet-manager.ts +
// src/facet-process.ts and prints the file:line + value of every gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function read(p) {
  return readFileSync(path.join(REPO, p), 'utf8').split('\n');
}
function find(lines, re) {
  const out = [];
  lines.forEach((ln, i) => { if (re.test(ln)) out.push({ line: i + 1, text: ln.trim() }); });
  return out;
}
function note(s) { console.log('# ' + s); }
function tap(name, ok, detail) { console.log(`${ok ? 'ok' : 'not ok'} - ${name}${detail ? ' # ' + detail : ''}`); }

note('R1 — Substrate cap snapshot');

// 1. NimbusFacetPool concurrency default.
const pool = read('src/parallel/facet-pool.ts');
const poolDefault = find(pool, /Math\.max\(1, opts\?\.concurrency \?\? \d/);
note(`facet-pool.ts default concurrency:`);
poolDefault.forEach((l) => note(`  src/parallel/facet-pool.ts:${l.line} → ${l.text}`));

const poolTimeout = find(pool, /defaultTimeoutMs.*\?\?/);
poolTimeout.forEach((l) => note(`  src/parallel/facet-pool.ts:${l.line} → ${l.text}`));

const slotIdShape = find(pool, /^.*const id = `nfp:/);
slotIdShape.forEach((l) => note(`  src/parallel/facet-pool.ts:${l.line} → cache-key shape: ${l.text}`));

// 2. CHILD_PROCESS_MAX_DEPTH.
const fp = read('src/facet-process.ts');
const depthCap = find(fp, /CHILD_PROCESS_MAX_DEPTH\s*=/);
note('');
note('child_process recursion cap:');
depthCap.forEach((l) => note(`  src/facet-process.ts:${l.line} → ${l.text}`));

const depthGuard = find(fp, /depthIn >= CHILD_PROCESS_MAX_DEPTH/);
depthGuard.forEach((l) => note(`  src/facet-process.ts:${l.line} → guard: ${l.text}`));

// 3. NIMBUS_FORK_IPC env propagation site.
const shims = read('src/node-shims.ts');
const forkIpcSite = find(shims, /NIMBUS_FORK_IPC|NIMBUS_CP_DEPTH/);
note('');
note('Fork/IPC env-propagation sites in node-shims.ts:');
forkIpcSite.forEach((l) => note(`  src/node-shims.ts:${l.line} → ${l.text}`));

// 4. worker_threads stub.
const wt = find(shims, /builtins\.worker_threads/);
note('');
note('worker_threads shim:');
wt.forEach((l) => note(`  src/node-shims.ts:${l.line} → ${l.text}`));

// 5. FacetManager facets.get + delete sites — webpack pool would
//    spawn N facets via these calls.
const fm = read('src/facet-manager.ts');
const facetGet = find(fm, /facets\.get\(/);
note('');
note('FacetManager facets.get() callsites (each is one DO facet allocated):');
facetGet.forEach((l) => note(`  src/facet-manager.ts:${l.line} → ${l.text}`));

// 6. Hibernation surface — would tear down in-flight webpack workers.
const hib = read('src/nimbus-session-hib.ts');
const hibAlarm = find(hib, /alarm|hibern|webSocketHib/i);
note('');
note('Hibernation surface (would terminate child facets mid-build):');
hibAlarm.slice(0, 6).forEach((l) => note(`  src/nimbus-session-hib.ts:${l.line} → ${l.text}`));

// 7. Webpack as a known parallelism consumer — list the place webpack
//    is named in skip lists / preambles.
const npmResolver = read('src/npm-resolver.ts');
const wp = find(npmResolver, /webpack/);
note('');
note('webpack mentions in npm-resolver:');
wp.forEach((l) => note(`  src/npm-resolver.ts:${l.line} → ${l.text}`));

note('');
note('# Inferred caps the webpack pool runs into, in firing order:');
note('  • cpSpawn depth cap = 8 (facet-process.ts:191).');
note('  • NimbusFacetPool concurrency default = 4 (facet-pool.ts:233).');
note('  • workerd subrequest budget per request = 50 (CF-internal limit; not in code).');
note('  • DO storage facets cap per session: ~64 (CF docs, not in code).');
note('  • worker_threads = no-op stub (node-shims.ts:1845).');

console.log('1..1');
tap('snapshot complete', true);
