#!/usr/bin/env bun
// Behavior test: input typed while a command runs is never silently dropped.
//
// RED on the pre-fix build: Shell.handleInput ended with a bare
// `if (this.running) return;`. Anything typed while a foreground command held
// the terminal — and was neither in raw mode nor waiting on stdin — was
// discarded with no echo and no record. A dispatch that never settles then
// wedges that connection completely silently, which is why a wedged terminal
// showed not even a command echo.
//
// A real tty echoes type-ahead and replays it to the shell when the foreground
// job exits. That is the contract asserted here.

import assert from 'node:assert/strict';
import { Shell } from '../../packages/worker/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/worker/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/worker/src/substrate/lifo/commands/registry.ts';
import { VFS } from '../../packages/worker/src/substrate/lifo/kernel/vfs/index.ts';

function makeShell() {
  const vfs = new VFS();
  vfs.mkdir('/home/user', { recursive: true });
  const registry = createDefaultRegistry();

  let output = '';
  const ran = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });

  // A command that holds the terminal until the test releases it — the shape
  // of every long dispatch, including one that never settles.
  registry.register('hold', async () => { ran.push('hold'); await gate; return 0; });
  registry.register('mark', async (ctx) => { ran.push(`mark:${ctx.args.join(',')}`); return 0; });
  // A prompt-driven command: it owns the keyboard while it waits for a line.
  registry.register('ask', async (ctx) => {
    ran.push(`answer:${await ctx.stdin.readLine()}`);
    return 0;
  });

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
  return { shell, ran, releaseGate, output: () => output };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const type = (shell, text) => { for (const ch of text) shell.handleInput(ch); };

// ── a command typed while another runs executes when the shell frees up ────
{
  const { shell, ran, releaseGate } = makeShell();
  shell.executeLine('hold');
  await settle();
  assert.equal(shell.running, true, 'the gated command holds the shell');

  type(shell, 'mark one');
  shell.handleInput('\r');

  releaseGate();
  await settle();
  await settle();

  assert.deepEqual(ran, ['hold', 'mark:one'], 'type-ahead runs once the shell is free');
}

// ── the keystrokes are echoed while the command holds the terminal ────────
// Zero feedback is the reported symptom: a wedged terminal showed not even a
// command echo. A tty echoes what you type even while a job owns it.
{
  const { shell, releaseGate, output } = makeShell();
  shell.executeLine('hold');
  await settle();
  const before = output().length;
  type(shell, 'whoami');
  assert.equal(
    output().slice(before),
    'whoami',
    'keystrokes typed during a command are echoed back to the terminal',
  );
  releaseGate();
  await settle();
}

// ── a command that never settles keeps the input instead of dropping it ───
{
  const { shell, ran } = makeShell();
  shell.executeLine('hold');
  await settle();

  type(shell, 'mark wedged');
  shell.handleInput('\r');
  await settle();

  assert.deepEqual(ran, ['hold'], 'the wedged command still holds the shell');
  assert.deepEqual(
    shell.typeAhead,
    [...'mark wedged', '\r'],
    'input to a wedged shell is held, not discarded',
  );
}

// ── escape sequences survive the round trip as whole chunks ───────────────
// Replaying byte by byte would split \x1b[A into three keystrokes the line
// editor cannot recognise.
{
  const { shell, ran, releaseGate } = makeShell();
  shell.executeLine('hold');
  await settle();

  shell.handleInput('mark first');
  shell.handleInput('\r');
  shell.handleInput('\x1b[A');

  releaseGate();
  await settle();
  await settle();
  await settle();

  assert.deepEqual(ran, ['hold', 'mark:first'], 'the buffered line ran');
  assert.equal(shell.lineBuffer, 'mark first', 'history-up replayed as one escape sequence');
}

// ── escape sequences are buffered but not echoed as raw bytes ─────────────
{
  const { shell, releaseGate, output } = makeShell();
  shell.executeLine('hold');
  await settle();
  const before = output().length;
  shell.handleInput('\x1b[A');
  assert.equal(output().slice(before), '', 'a control sequence is not echoed into the screen');
  assert.deepEqual(shell.typeAhead, ['\x1b[A'], 'but it is still held for replay');
  releaseGate();
  await settle();
}

// ── a command reading stdin still owns the keyboard ──────────────────────
// The type-ahead buffer must sit BELOW the stdin handoff, or a prompt-driven
// command would never see what the user answered.
{
  const { shell, ran } = makeShell();
  shell.executeLine('ask');
  await settle();
  await settle();

  type(shell, 'yes');
  assert.deepEqual(shell.typeAhead, [], 'keystrokes go to the waiting reader, not the buffer');
  shell.handleInput('\r');
  await settle();
  await settle();

  assert.deepEqual(ran, ['answer:yes'], 'the command received the typed line');
}

// ── a stdin reader also owns the cursor keys ─────────────────────────────
// Line editing while a command owns the line belongs to that command's own
// cursor, which terminal-stdin already implements.
{
  const { shell } = makeShell();
  shell.executeLine('ask');
  await settle();
  await settle();

  type(shell, 'abc');
  shell.handleInput('\x1b[D');
  shell.handleInput('X');
  assert.deepEqual(shell.typeAhead, [], 'cursor keys are not stolen by the shell line editor');
  assert.equal(shell.lineBuffer, '', 'the shell line buffer stays untouched while a command reads');
}

// ── a pasted block echoes with CRLF and replays as one chunk ─────────────
{
  const { shell, ran, releaseGate, output } = makeShell();
  shell.executeLine('hold');
  await settle();
  const before = output().length;
  shell.handleInput('mark a\nmark b\n');
  assert.equal(
    output().slice(before),
    'mark a\r\nmark b\r\n',
    'a pasted block echoes with terminal newlines, never a bare LF',
  );
  releaseGate();
  for (let i = 0; i < 6; i++) await settle();
  assert.deepEqual(ran, ['hold', 'mark:a', 'mark:b'], 'both pasted lines ran, in order');
}

// ── a backspace is held but not echoed as a raw DEL byte ─────────────────
{
  const { shell, releaseGate, output } = makeShell();
  shell.executeLine('hold');
  await settle();
  type(shell, 'lsx');
  const before = output().length;
  shell.handleInput('\x7f');
  assert.equal(output().slice(before), '', 'DEL is not written into the terminal');
  assert.deepEqual(shell.typeAhead, [...'lsx', '\x7f'], 'the edit is still held');
  releaseGate();
  await settle();
  await settle();
  assert.equal(shell.lineBuffer, 'ls', 'the held backspace applied on replay');
}

console.log('lifo-shell-type-ahead: PASS');
