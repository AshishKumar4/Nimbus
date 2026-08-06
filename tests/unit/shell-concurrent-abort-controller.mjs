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
