#!/usr/bin/env bun

// The terminal's two signal keys. Ctrl+C (0x03) raises SIGINT and Ctrl+\
// (0x1c) raises SIGQUIT on the foreground command; with no foreground job
// Ctrl+C cancels the line and Ctrl+\ is absorbed, leaving the line intact.
// `sleep` is the probe: it is the one builtin whose whole body is a wait on
// ctx.signal, so an abort that never arrives shows up as a full-length sleep.

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';

async function interrupt(key) {
  const box = await Sandbox.create({ persist: false });
  const shell = box.shell;
  const started = Date.now();
  const line = shell.executeLine('sleep 10');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(shell.running, 'the foreground command is running');

  shell.handleInput(key);
  await Promise.race([
    line,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${JSON.stringify(key)} never reached the foreground command`)), 2000)),
  ]);
  return Date.now() - started;
}

assert.ok(await interrupt('\x03') < 2000, 'Ctrl+C ends the foreground command early');
assert.ok(await interrupt('\x1c') < 2000, 'Ctrl+\\ ends the foreground command early');

// SIGQUIT is not SIGINT: the shell reports 131 (128+3), not 130.
{
  const box = await Sandbox.create({ persist: false });
  const shell = box.shell;
  shell.executeLine('sleep 10');
  await new Promise((resolve) => setTimeout(resolve, 50));
  shell.handleInput('\x1c');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { stdout } = await shell.execute('echo $?');
  assert.equal(stdout.trim(), '131', 'Ctrl+\\ reports SIGQUIT status');
}

// With no foreground job, Ctrl+\ is absorbed — unlike Ctrl+C it must not
// discard what the user has typed.
{
  const box = await Sandbox.create({ persist: false });
  const shell = box.shell;
  shell.handleInput('echo kept');
  shell.handleInput('\x1c');
  assert.equal(shell.lineBuffer, 'echo kept', 'Ctrl+\\ leaves the line intact');

  shell.handleInput('\x03');
  assert.equal(shell.lineBuffer, '', 'Ctrl+C cancels the line');
}

console.log('shell terminal signal keys: ok');
