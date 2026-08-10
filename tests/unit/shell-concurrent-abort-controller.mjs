#!/usr/bin/env bun

// One session's shell runs commands from several callers at once: the
// interactive terminal, the programmatic SDK, the child-process broker.
// A programmatic command finishing must not take Ctrl+C away from the
// interactive command that is still running.

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

const box = await Sandbox.create({ persist: false });
const shell = box.shell;

// The programmatic command starts first, so at its end the controller it
// saved predates the interactive command's own.
const programmatic = shell.execute('sleep 0.2');
await new Promise((resolve) => setTimeout(resolve, 20));

const interactiveStarted = Date.now();
const interactive = shell.executeLine('sleep 5');

await programmatic;
assert.ok(shell.running, 'the interactive command is still running');

shell.handleInput('\x03');
await Promise.race([
  interactive,
  new Promise((_, reject) => setTimeout(() => reject(new Error(
    'Ctrl+C did not reach the running command: a finished concurrent execution '
    + 'restored a stale abort controller over it',
  )), 1000)),
]);

assert.ok(
  Date.now() - interactiveStarted < 2000,
  'the interrupted command ended early rather than sleeping out its 5s',
);

console.log('shell concurrent abort controller: ok');

// The inverse ordering is the production terminal case: an interactive
// command already owns Ctrl+C, then a programmatic caller starts work on the
// same Shell. A single mutable controller slot makes the later programmatic
// command steal the terminal's signal.
{
  const inverse = await Sandbox.create({ persist: false });
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
