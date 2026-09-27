#!/usr/bin/env bun

// One session's shell runs commands from several callers at once: the
// interactive terminal, the programmatic SDK, the child-process broker.
// A programmatic command finishing must not take Ctrl+C away from the
// interactive command that is still running.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();
const shell = box.shell;

// The programmatic command starts first, so at its end the controller it
// saved predates the interactive command's own. Each command runs until the
// test releases it (or it is aborted), so the order is the test's, not a race
// between sleeps.
let releaseFirst;
let interactiveAborted = false;
shell.getRegistry().register('first-programmatic', async () => {
  await new Promise((resolve) => { releaseFirst = resolve; });
  return 0;
});
shell.getRegistry().register('then-interactive', async (ctx) => {
  await new Promise((resolve) => ctx.signal.addEventListener('abort', () => { interactiveAborted = true; resolve(); }, { once: true }));
  return 130;
});
const programmatic = shell.execute('first-programmatic');
await new Promise((resolve) => setTimeout(resolve, 0));
const interactive = shell.executeLine('then-interactive');
await new Promise((resolve) => setTimeout(resolve, 0));

releaseFirst();
await programmatic;
assert.ok(shell.running, 'the interactive command is still running');

shell.handleInput('\x03');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  interactiveAborted, true,
  'Ctrl+C did not reach the running command: a finished concurrent execution restored a stale abort controller over it',
);
await interactive;

console.log('shell concurrent abort controller: ok');

// The inverse ordering is the production terminal case: an interactive
// command already owns Ctrl+C, then a programmatic caller starts work on the
// same Shell. A single mutable controller slot makes the later programmatic
// command steal the terminal's signal.
{
  const inverse = await testBox();
  const inverseShell = inverse.shell;
  let interactiveAborted = false;
  let programmaticAborted = false;
  let releaseInteractive;
  let releaseProgrammatic;

  inverseShell.getRegistry().register('hold-interactive', async (ctx) => {
    await new Promise((resolve) => {
      releaseInteractive = resolve;
      ctx.signal.addEventListener('abort', () => {
        interactiveAborted = true;
        resolve();
      }, { once: true });
    });
    return ctx.signal.aborted ? 130 : 0;
  });
  inverseShell.getRegistry().register('hold-programmatic', async (ctx) => {
    await new Promise((resolve) => {
      releaseProgrammatic = resolve;
      ctx.signal.addEventListener('abort', () => {
        programmaticAborted = true;
        resolve();
      }, { once: true });
    });
    return ctx.signal.aborted ? 130 : 0;
  });

  const inverseInteractive = inverseShell.executeLine('hold-interactive');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const inverseProgrammatic = inverseShell.execute('hold-programmatic');
  await new Promise((resolve) => setTimeout(resolve, 0));

  inverseShell.handleInput('\x03');
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    assert.equal(interactiveAborted, true, 'Ctrl+C remains owned by the interactive command');
    assert.equal(programmaticAborted, false, 'terminal Ctrl+C does not cancel a programmatic caller');
  } finally {
    releaseInteractive?.();
    releaseProgrammatic?.();
    await Promise.all([inverseInteractive, inverseProgrammatic]);
  }
}

console.log('shell concurrent inverse abort ownership: ok');
