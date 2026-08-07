#!/usr/bin/env bun
// Behavior test: `wait` reaps one of the CALLER's children.
//
// The scheduler recorded exit statuses as pid -> status with no record of whose
// child the pid was, so `wait` with no argument could only take the first entry
// in the map. With two subshells that have each had a child exit, one consumes
// the other's status and then blocks forever on a child that has already been
// reaped elsewhere. Measured before the fix, the whole script dies:
//
//   ( (exit 3) & wait; echo A=$? ) ; ( (exit 7) & wait; echo B=$? )
//     -> stdout "", state "error", exit 1
//
// The status record now carries the parent, and both the reap and the wake are
// filtered by it.
//
// Driven through REAL bash on the REAL staged wasm.

import { runScript } from './lib/bash-preamble.mjs';

let pass = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed.push(name); }
};
const show = (r) => JSON.stringify({ stdout: r.stdout, stderr: r.stderr, state: r.state, exit: r.exitCode });

// ── Two subshells, each with its own exited child, each waiting ─────────────
{
  const r = runScript('( (exit 3) & wait; echo A=$? ) ; ( (exit 7) & wait; echo B=$? )');
  const out = r.stdout || '';
  check('two subshells can each wait for their own child',
    out.includes('A=') && out.includes('B='), show(r));
  check('neither subshell is left wedged waiting for a child another one reaped',
    r.state === 'exited', show(r));
}

// ── A single background child is still reaped ──────────────────────────────
{
  const r = runScript('(exit 5) & wait; echo SINGLE_DONE');
  check('a single background child is still reaped by wait',
    (r.stdout || '').includes('SINGLE_DONE'), show(r));
}

// ── Waiting by explicit pid still works ────────────────────────────────────
{
  const r = runScript('sleep 0 & p=$!; wait $p; echo BYPID_DONE');
  check('wait <pid> still works',
    (r.stdout || '').includes('BYPID_DONE'), show(r));
}

// ── Sequential children in one shell ───────────────────────────────────────
{
  const r = runScript('for i in 1 2 3; do (exit 0) & wait; done; echo LOOP_DONE');
  check('a loop of background children all get reaped',
    (r.stdout || '').includes('LOOP_DONE'), show(r));
}

console.log(`\n  ──── bash-wait-reaps-own-children: ${pass} pass / ${failed.length} fail`);
process.exit(failed.length > 0 ? 1 : 0);
