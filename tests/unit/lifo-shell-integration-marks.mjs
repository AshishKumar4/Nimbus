#!/usr/bin/env bun
// The shell writes the FinalTerm shell-integration marks (OSC 133) that
// VS Code, iTerm2 and WezTerm read from bash and zsh: A where a fresh prompt
// starts, B where it ends and input begins, C when an accepted command starts
// executing, D;<status> when it ends. A client (the probe driver, a terminal
// attached through the CLI) learns that a command returned, and how, from the
// shell itself rather than from text that looks like a prompt.
//
// Marks only fresh prompts and real commands: an empty line gets a prompt and
// no command; PS2 is no prompt; a redraw of the line being edited (a
// keystroke, a background job's notice, a completion listing) finishes no
// command, so none writes D.

import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { memoryFiles } from './lib/test-box.mjs';

function makeShell() {
  const { files: vfs, root } = memoryFiles();
  root.mkdir('home/user', { recursive: true });
  const registry = createDefaultRegistry();
  let output = '';
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  registry.register('ok', async (ctx) => { await ctx.stdout.write('ran\n'); return 0; });
  registry.register('fail3', async () => 3);
  registry.register('hold', async () => { await gate; return 0; });
  const shell = new Shell(
    { write(data) { output += data; }, writeln(data) { output += `${data}\n`; }, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} },
    vfs,
    registry,
    { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' },
    new ProcessRegistry(),
  );
  return {
    shell,
    releaseGate,
    output: () => output,
    /** The marks written since the last call, in order: 'A', 'B', 'C', 'D;0'… */
    take() {
      const marks = [...output.matchAll(/\x1b\]133;([ABCD](?:;\d+)?)\x07/g)].map((m) => m[1]);
      output = '';
      return marks;
    },
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const type = (shell, text) => { for (const ch of text) shell.handleInput(ch); };

// ── a fresh prompt is marked, A before the prompt and B after it ─────────────
{
  const t = makeShell();
  t.shell.printPrompt();
  const out = t.output();
  assert.match(out, /^\x1b\]133;A\x07[^\x1b]*\x1b\[[^\x07]*nimbus[\s\S]*\$ \x1b\]133;B\x07$/, JSON.stringify(out));
  assert.deepEqual(t.take(), ['A', 'B']);
}

// ── a command: C before its output, D;<status> after it, then a fresh prompt ─
{
  const t = makeShell();
  t.shell.printPrompt();
  t.take();
  type(t.shell, 'ok');
  t.shell.handleInput('\r');
  await settle();
  const out = t.output();
  assert.ok(out.indexOf('\x1b]133;C\x07') < out.indexOf('ran'), 'C comes before the command\'s output');
  assert.ok(out.indexOf('ran') < out.indexOf('\x1b]133;D;0\x07'), 'D comes after it');
  assert.deepEqual(t.take(), ['C', 'D;0', 'A', 'B']);

  type(t.shell, 'fail3');
  t.shell.handleInput('\r');
  await settle();
  assert.deepEqual(t.take(), ['C', 'D;3', 'A', 'B'], 'D carries the command\'s status');

  // A pasted line (one chunk with its Enter) is the same command.
  t.shell.handleInput('ok\r');
  await settle();
  assert.deepEqual(t.take(), ['C', 'D;0', 'A', 'B']);
}

// ── an empty line is a new prompt, no command ────────────────────────────────
{
  const t = makeShell();
  t.shell.printPrompt();
  t.take();
  t.shell.handleInput('\r');
  await settle();
  assert.deepEqual(t.take(), ['A', 'B']);
}

// ── PS2 is no prompt: the command runs once its line closes ──────────────────
{
  const t = makeShell();
  t.shell.printPrompt();
  t.take();
  type(t.shell, 'echo "open');
  t.shell.handleInput('\r');
  await settle();
  assert.deepEqual(t.take(), [], 'an open quote shows PS2, unmarked');
  type(t.shell, 'close"');
  t.shell.handleInput('\r');
  await settle();
  assert.deepEqual(t.take(), ['C', 'D;0', 'A', 'B']);
}

// ── a redraw finishes no command: no D, and no prompt marks ──────────────────
{
  const t = makeShell();
  t.shell.printPrompt();
  t.take();
  type(t.shell, 'ec');
  t.shell.writeNotice('[1] Done    sleep 1\n');
  t.shell.handleInput('\x7f');
  assert.deepEqual(t.take(), [], 'keystrokes and a notice redraw the line without marks');
  t.shell.handleInput('\t');
  t.shell.handleInput('\t');
  await settle();
  assert.ok(!t.take().some((mark) => mark.startsWith('C') || mark.startsWith('D')), 'a completion listing finishes no command');
}

// ── type-ahead: the running command's D, its prompt, then the next command ───
{
  const t = makeShell();
  t.shell.printPrompt();
  t.take();
  t.shell.handleInput('hold\r');
  await settle();
  assert.deepEqual(t.take(), ['C'], 'the held command started and has not ended');
  t.shell.handleInput('ok\r');
  await settle();
  assert.deepEqual(t.take(), [], 'type-ahead runs nothing while the command holds the terminal');
  t.releaseGate();
  await settle();
  assert.deepEqual(t.take(), ['D;0', 'A', 'B', 'C', 'D;0', 'A', 'B']);
}

console.log('lifo-shell-integration-marks: OK');
