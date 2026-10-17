#!/usr/bin/env bun
// Two publishers of the same runtime and version at once (bundle-runtime.mjs
// --npm-package, to two directories) each stage in a scratch directory of
// their own: both succeed, with the same manifest, and each removes only its
// own scratch when it ends.
//
// Red before: the scratch was named by the runtime and version alone, so the
// two shared it, each emptied it as it started and removed it as it ended,
// and one could lose the files the other was staging.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { npmRuntimeSpecs } from '../../packages/worker/scripts/runtime-specs.mjs';

const WORKER = fileURLToPath(new URL('../../packages/worker/', import.meta.url));
// The wasm is committed, but a worktree mid-rebuild has none of it.
if (!existsSync(join(WORKER, 'wasm/bash/bash.async.wasm'))) {
  console.log('bundle-runtime-scratch-per-run: SKIPPED (wasm/bash/bash.async.wasm not built)');
  process.exit(0);
}
const { runtime, version } = npmRuntimeSpecs().find((spec) => spec.runtime === 'bash');
const work = mkdtempSync(join(tmpdir(), 'nimbus-scratch-per-run-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

/** One publisher run into `out`: its exit, and the scratch directory it said it used. */
function publish(out) {
  const child = spawn('node', ['scripts/bundle-runtime.mjs', runtime, version, '--npm-package', out], { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => child.on('close', (code) => {
    resolve({ code, output, scratch: /\[bundle-runtime\] work dir: (\S+)/.exec(output)?.[1] });
  }));
}

const outs = [join(work, 'a'), join(work, 'b')];
const runs = await Promise.all(outs.map(publish));
for (const [index, run] of runs.entries()) assert.equal(run.code, 0, `publisher ${index}: ${run.output.slice(-1500)}`);
const [a, b] = runs.map((run) => run.scratch);
assert.ok(a && b, `each names its scratch: ${a}, ${b}`);
assert.notEqual(a, b, 'each publisher stages in a scratch directory of its own');
assert.ok(!existsSync(a) && !existsSync(b), 'each removed its scratch');
assert.deepEqual(readFileSync(join(outs[0], 'manifest.json')), readFileSync(join(outs[1], 'manifest.json')), 'both published the same manifest');
console.log(`bundle-runtime-scratch-per-run: ok (${runtime} ${version}, two publishers at once)`);
