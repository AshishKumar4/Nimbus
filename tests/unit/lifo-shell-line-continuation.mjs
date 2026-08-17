#!/usr/bin/env bun
// Behavior test: a line that leaves the parser open is not a command yet.
//
// RED on the pre-fix build: Enter executed the line buffer unconditionally,
// so `node -e "const s='x` + Enter ran node with a truncated program and the
// user got an inscrutable SyntaxError from deep inside the runner. Real bash
// shows the PS2 continuation prompt and keeps reading until the quote closes
// (or the trailing-backslash continuation is satisfied).
//
// The contract asserted here, for the interactive line-accept path:
//   - unterminated double quote  → buffer, prompt `> `, join with a newline
//   - unterminated single quote  → same
//   - trailing backslash         → buffer, prompt `> `, join WITHOUT the
//                                  newline, backslash removed
//   - Ctrl+C in continuation     → cancel the pending buffer, primary prompt
//   - a complete line still executes immediately

import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/index.ts';

function makeShell() {
  const vfs = new VFS();
  vfs.mkdir('/home/user', { recursive: true });
  const registry = createDefaultRegistry();

  let output = '';
  const ran = [];
  registry.register('mark', async (ctx) => { ran.push(ctx.args.join(',')); return 0; });

  const shell = new Shell(
    {
      write(data) { output += data; },
      writeln(data) { output += `${data}\n`; },
      onData() {},
      cols: 80,
      rows: 24,
      focus() {},
      clear() {},
    },
    vfs,
    registry,
    { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' },
    new ProcessRegistry(),
  );
  return { shell, ran, output: () => output };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const type = (shell, text) => { for (const ch of text) shell.handleInput(ch); };

// ── an unterminated double quote waits instead of executing ───────────────
{
  const { shell, ran, output } = makeShell();
  type(shell, 'mark "abc');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, [], 'the open quote held the command back');
  assert.ok(output().endsWith('> '), `continuation prompt shown, got: ${JSON.stringify(output().slice(-20))}`);

  type(shell, 'def"');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['abc\ndef'], 'the joined string carries the literal newline');
}

// ── an unterminated single quote behaves the same ─────────────────────────
{
  const { shell, ran, output } = makeShell();
  type(shell, "mark 'a");
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, [], 'the open single quote held the command back');
  assert.ok(output().endsWith('> '), 'continuation prompt shown');

  type(shell, "b'");
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['a\nb'], 'single-quoted join keeps the newline');
}

// ── a trailing backslash joins without the newline ────────────────────────
{
  const { shell, ran, output } = makeShell();
  type(shell, 'mark ab\\');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, [], 'the line continuation held the command back');
  assert.ok(output().endsWith('> '), 'continuation prompt shown');

  type(shell, 'cd');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['abcd'], 'backslash and newline are both removed');
}

// ── a string spanning three lines reaches the command intact ──────────────
{
  const { shell, ran, output } = makeShell();
  type(shell, 'mark "l1');
  shell.handleInput('\r');
  await settle();
  type(shell, 'l2');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, [], 'still open after the second line');
  assert.ok(output().endsWith('> '), 'prompts again for every open line');

  type(shell, 'l3"');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['l1\nl2\nl3'], 'every embedded newline survives');
}

// ── typing on a continuation line repaints PS2, not the primary prompt ────
{
  const { shell, output } = makeShell();
  type(shell, 'mark "abc');
  shell.handleInput('\r');
  await settle();

  const before = output().length;
  type(shell, 'de');
  assert.ok(
    !output().slice(before).includes('user@nimbus'),
    'the line editor redraws the continuation prompt, not the primary one',
  );
}

// ── Ctrl+C cancels the pending buffer and returns to the primary prompt ───
{
  const { shell, ran, output } = makeShell();
  type(shell, 'mark "open');
  shell.handleInput('\r');
  await settle();
  assert.ok(output().endsWith('> '), 'in continuation mode');

  shell.handleInput('\x03');
  assert.ok(output().includes('^C'), 'the cancel is acknowledged');
  assert.ok(output().endsWith('$ '), 'back at the primary prompt');

  type(shell, 'mark clean');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['clean'], 'the cancelled buffer never leaks into the next command');
}

// ── the degenerate lone quote also waits, and cancels cleanly ─────────────
{
  const { shell, ran, output } = makeShell();
  shell.handleInput('"');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, [], 'a lone quote is not a command');
  assert.ok(output().endsWith('> '), 'it waits like any other open quote');
  assert.equal(shell.running, false, 'nothing is executing');

  shell.handleInput('\x03');
  assert.ok(output().endsWith('$ '), 'Ctrl+C recovers the primary prompt');
}

// ── the reported repro: a WS chunk ending in \r takes the paste path ──────
{
  const { shell, ran, output } = makeShell();
  shell.handleInput('mark "const s=\'x\r');
  await settle();

  assert.deepEqual(ran, [], 'the truncated paste is held, not executed');
  assert.ok(output().endsWith('> '), 'continuation prompt shown');

  shell.handleInput('y"\r');
  await settle();

  assert.deepEqual(ran, ["const s='x\ny"], 'the later chunk completes the same command');
}

// ── a pasted block closes its own quote, blank line included ──────────────
{
  const { shell, ran } = makeShell();
  shell.handleInput('mark "a\n\nb"\n');
  await settle();

  assert.deepEqual(ran, ['a\n\nb'], 'the blank pasted line is a newline inside the string');
}

// ── complete lines are untouched: they execute immediately ────────────────
{
  const { shell, ran } = makeShell();
  type(shell, 'mark solo');
  shell.handleInput('\r');
  await settle();
  assert.deepEqual(ran, ['solo'], 'a closed line runs at once');

  type(shell, 'mark a\\\\');
  shell.handleInput('\r');
  await settle();
  assert.deepEqual(ran, ['solo', 'a\\'], 'an escaped backslash is not a continuation');
}

console.log('lifo-shell-line-continuation: PASS');
