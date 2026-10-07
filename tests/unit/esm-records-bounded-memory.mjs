#!/usr/bin/env bun
/**
 * readEsmRecords (async-module-lowering.ts) reads a module a statement at a
 * time and drops each function's body once it has analyzed it, so a
 * multi-MiB bundle reads in bounded memory: a tree of the whole module is
 * some 20 times its source (acorn's: 116 MB of heap for workerd's 4.7 MB
 * worker.mjs). This module is 4 MiB in one top-level statement of nested
 * functions, as worker.mjs has a 3.5 MB one; its records and every use of
 * its import are read under Node with a 48 MB heap.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const parts = [];
let uses = 0;
for (let i = 0; parts.join('\n').length < 4 * 1024 * 1024; i++) {
  // A use of the import, one shadowed by a parameter, and a block's own.
  parts.push(`function f${i}(a, b) { const local${i} = [a, b, ${i}]; return function inner${i}(hit) { return () => { { let x = hit; } return [local${i}, hit, ${i}]; }; }; }`);
  if (i % 100 === 0) {
    parts.push(`uses.push(() => (() => hit)());`);
    uses++;
  }
}
const SOURCE = [
  "import { hit } from './dep.mjs';",
  'const uses = [];',
  `var big = (() => {\n${parts.join('\n')}\nreturn uses;\n})();`,
  'export { big };',
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'esm-records-memory-'));
try {
  const reader = join(dir, 'reader.mjs');
  await esbuild.build({
    entryPoints: [new URL('../../packages/core/src/runtime/async-module-lowering.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'node', outfile: reader, logLevel: 'silent',
  });
  writeFileSync(join(dir, 'module.mjs'), SOURCE);
  writeFileSync(join(dir, 'run.mjs'), `
    import { readFileSync } from 'node:fs';
    import { readEsmRecords } from ${JSON.stringify(reader)};
    const records = readEsmRecords(readFileSync(${JSON.stringify(join(dir, 'module.mjs'))}, 'utf8'));
    const [binding] = records[0].bindings;
    process.stdout.write(JSON.stringify({ kinds: records.map((r) => r.kind), local: binding.local, uses: binding.references.length }));
  `);
  const run = spawnSync('node', ['--max-old-space-size=48', join(dir, 'run.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, `read in a 48 MB heap: ${run.stderr.slice(-400)}`);
  assert.deepEqual(JSON.parse(run.stdout), { kinds: ['import', 'export'], local: 'hit', uses },
    'every use of the import, and none a parameter shadows');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`esm-records-bounded-memory: a ${(SOURCE.length / 1048576).toFixed(1)} MB module's ${uses} uses, read in a 48 MB heap`);
