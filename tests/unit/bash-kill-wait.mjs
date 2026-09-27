#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runScript } from './lib/bash-preamble.mjs';

// Compile the source preamble rather than editing or trusting generated JS.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../../packages/core/src/runtime/bash/preamble.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'esnext', treeShaking: false,
});
const preambleSource = bundled.outputFiles[0].text;
const cases = [
  ['sleep 1 & wait %1; sleep 5 & kill %1; wait %1; echo w=$?; sleep 1 & p=$!; wait $p; sleep 5 & kill %1; wait; echo end', 'w=143\nend\n'],
  ['sleep 5 & p=$!; kill -0 "$p"; echo live=$?; kill -KILL "$p"; wait "$p"; echo killed=$?', 'live=0\nkilled=137\n'],
];
for (const remote of [false, true]) {
  for (const [script, want] of cases) {
    const result = await runScript(script, { remote, preambleSource });
    assert.equal(result.exitCode, 0, result.error ?? result.stderr);
    assert.equal(result.stdout, want, `${remote ? 'RPC' : 'local'}: ${script}`);
  }
}
// The JSPI child already entered its clock wait before another foreground
// child finishes. Killing it must unwind pending work without a second exit.
const active = await runScript('sleep 30 & p=$!; sleep 1; kill "$p"; wait "$p"; echo active=$?; sleep 1; echo later=$?', { remote: true, preambleSource });
assert.equal(active.exitCode, 0, active.error ?? active.stderr);
assert.equal(active.stdout, 'active=143\nlater=0\n');
console.log('bash-kill-wait: virtual signal delivery reaches wait status on both transports');
