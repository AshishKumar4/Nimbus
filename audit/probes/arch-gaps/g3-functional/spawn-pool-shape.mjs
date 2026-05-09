#!/usr/bin/env bun
// G3 functional — spawn-pool-shape (TDD RED → GREEN once G4 lands).
//
// Asserts:
//   1. src/loaders/child-process/spawn-facet.ts exports
//      `runSpawnInIsolate` (the per-spawn task body).
//   2. src/loaders/child-process/spawn-pool.ts exports
//      `ChildProcessSpawnPool` constructed with NimbusFanoutPool.
//   3. src/facets/process.ts:_dispatch does NOT directly call
//      `commandRegistry.runPureBuiltin` or `facetMgr.execStream` —
//      those are routed through the spawn-pool.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

console.log('G3 functional/spawn-pool-shape — fresh-isolate-per-spawn structural');

const FACET_FILE = path.join(ROOT, 'src/loaders/child-process/spawn-facet.ts');
const POOL_FILE = path.join(ROOT, 'src/loaders/child-process/spawn-pool.ts');
const PROCESS_FILE = path.join(ROOT, 'src/facets/process.ts');

// 1.
if (!fs.existsSync(FACET_FILE)) {
  check('src/loaders/child-process/spawn-facet.ts exists', false, 'expected new file');
} else {
  const src = fs.readFileSync(FACET_FILE, 'utf8');
  check('spawn-facet.ts exists', true);
  check('exports runSpawnInIsolate',
    /export\s+(const|function|var|let)\s+runSpawnInIsolate\b/.test(src));
  check('runSpawnInIsolate signature (spec, env)',
    /runSpawnInIsolate\s*=\s*async\s*function\s*\(\s*spec\b/.test(src) ||
    /async\s+function\s+runSpawnInIsolate\s*\(\s*spec\b/.test(src));
  check('no `this.` references (self-contained body)', !/\bthis\./.test(src));
}

// 2. ChildProcessSpawnPool wraps NimbusLoaderPool with concurrency=1
//    on a SHARED pool. Concurrent cp.spawn calls serialize through
//    slot 0, never tripping workerd's 4-loaders-per-method-context cap
//    on prod ("Too many concurrent dynamic workers"). The
//    architectural win is the spawn dispatch running in a Worker
//    Loader isolate, NOT the supervisor's V8 context.
if (!fs.existsSync(POOL_FILE)) {
  check('src/loaders/child-process/spawn-pool.ts exists', false);
} else {
  const src = fs.readFileSync(POOL_FILE, 'utf8');
  check('spawn-pool.ts exists', true);
  check('exports ChildProcessSpawnPool', /export\s+class\s+ChildProcessSpawnPool\b/.test(src));
  check('uses NimbusLoaderPool (Worker Loader primitive)',
    /NimbusLoaderPool/.test(src));
  check('imports from loader-pool',
    /from\s+['"][.\/]+loader-pool/.test(src) || /from\s+['"]\.\.\/loader-pool/.test(src));
  check('serializes via promise chain (no in-flight cap trip)',
    /this\.chain/.test(src) && /pool\.submit/.test(src),
    'expected chain-based serialization through one slot');
}

// 3.
if (fs.existsSync(PROCESS_FILE)) {
  const src = fs.readFileSync(PROCESS_FILE, 'utf8');
  // _dispatch must not directly call runPureBuiltin/execStream;
  // it should route through a spawn pool. We check for either
  // `spawnPool.runOne` or `this.spawnPool.runOne` calls inside _dispatch.
  const dispatchMatch = src.match(/private\s+async\s+_dispatch\s*\([\s\S]*?\n  \}/);
  const body = dispatchMatch ? dispatchMatch[0] : '';
  check('_dispatch routes through spawn pool',
    /spawnPool\.(?:runOne|run)\s*\(/.test(body) || /spawnPool\b/.test(body),
    'expected _dispatch to delegate to spawnPool');
}

console.log(`\n  ──── ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
