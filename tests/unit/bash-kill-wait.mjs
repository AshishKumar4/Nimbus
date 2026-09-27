#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { loadPreamble, runScript } from './lib/bash-preamble.mjs';

// Compile the source preamble rather than editing or trusting generated JS.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../../packages/core/src/runtime/bash/preamble.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'esnext', treeShaking: false,
});
const preambleSource = bundled.outputFiles[0].text;
const cases = [
  ['sleep 1 & wait %1; sleep 5 & kill %1; wait %1; echo w=$?; sleep 1 & p=$!; wait $p; sleep 5 & kill %1; wait; echo end', 'w=143\nend\n'],
  ['sleep 5 & p=$!; kill -0 "$p"; echo live=$?; kill -KILL "$p"; wait "$p"; echo killed=$?', 'live=0\nkilled=137\n'],
  ['trap "" TERM; kill -TERM $$; echo alive', 'alive\n'],
  ['trap "" TERM; (kill -TERM "$BASHPID"; echo child); echo parent', 'child\nparent\n'],
  ['trap "echo caught" TERM; kill -TERM $$; echo refused=$?; echo alive', 'refused=1\nalive\n'],
];
for (const remote of [false, true]) {
  for (const [script, want] of cases) {
    const result = await runScript(script, { remote, preambleSource });
    assert.equal(result.exitCode, 0, result.error ?? result.stderr);
    assert.equal(result.stdout, want, `${remote ? 'RPC' : 'local'}: ${script}`);
  }
}
for (const remote of [false, true]) {
  const session = loadPreamble({ remote, preambleSource });
  try {
    const result = await session.boot({ argv: ['bash', '-c', 'kill -TERM $$; echo forbidden > /tmp/after-signal'], environ: ['PATH=/bin:/usr/bin'], stdinClosed: true, busyboxApplets: session.applets });
    assert.equal(result.exitCode, 143);
    assert.equal(session.root.exists('tmp/after-signal'), false, 'default self-kill prevents later filesystem side effects');
  } finally { await session.dispose(); }
  const uncatchable = await runScript('trap "" KILL; kill -KILL $$; echo forbidden', { remote, preambleSource });
  assert.equal(uncatchable.exitCode, 137);
  assert.equal(uncatchable.stdout, '', 'SIGKILL cannot be ignored');
}
// The JSPI child already entered its clock wait before another foreground
// child finishes. Killing it must unwind pending work without a second exit.
const active = await runScript('sleep 30 & p=$!; sleep 1; kill "$p"; wait "$p"; echo active=$?; sleep 1; echo later=$?', { remote: true, preambleSource });
assert.equal(active.exitCode, 0, active.error ?? active.stderr);
assert.equal(active.stdout, 'active=143\nlater=0\n');
const ignoredExec = await runScript('trap "" TERM; sleep 2 & p=$!; trap - TERM; sleep 1; kill -TERM "$p"; wait "$p"; echo ignored=$?', { remote: true, preambleSource });
assert.equal(ignoredExec.exitCode, 0, ignoredExec.error ?? ignoredExec.stderr);
assert.equal(ignoredExec.stdout, 'ignored=0\n', 'exec preserves ignored disposition even when caller restored default');
const resetExec = await runScript('trap "echo caught" TERM; sleep 30 & p=$!; sleep 1; kill -TERM "$p"; wait "$p"; echo reset=$?', { remote: true, preambleSource });
assert.equal(resetExec.exitCode, 0, resetExec.error ?? resetExec.stderr);
assert.equal(resetExec.stdout, 'reset=143\n', 'exec resets a caught handler instead of reading the active caller\'s handler');
console.log('bash-kill-wait: virtual signal delivery reaches wait status on both transports');
