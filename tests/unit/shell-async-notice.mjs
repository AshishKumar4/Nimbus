#!/usr/bin/env bun
// An asynchronous session notice (a resident launch reporting after the
// command that started it has already returned) must not leave the terminal
// without a prompt. Seen live: `pi` returned, the prompt was drawn, and then
// "[nimbus: second instance of … is not the durable one …]" was written
// after it, so the screen ended on the notice and anything waiting for the
// prompt (a user, the probe driver) saw none.

import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { VFS } from '../../packages/core/src/substrate/lifo/kernel/vfs/index.ts';

const vfs = new VFS();
vfs.mkdir('/home/user', { recursive: true });
const registry = createDefaultRegistry();
let output = '';
let releaseGate;
const gate = new Promise((resolve) => { releaseGate = resolve; });
registry.register('hold', async () => { await gate; return 0; });

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const PROMPT = 'user@nimbus:~$ ';
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r$/, '');

shell.printPrompt();
for (const ch of 'ec') shell.handleInput(ch);
await settle();

// At an idle prompt: the notice goes above, the prompt and the half-typed
// line are redrawn below it.
output = '';
shell.writeNotice('[nimbus: late notice]\r\n');
assert.ok(plain(output).includes('[nimbus: late notice]\r\n'), JSON.stringify(output));
assert.ok(plain(output).endsWith(`${PROMPT}ec`), `prompt and edit line are last: ${JSON.stringify(output)}`);

// The redrawn line is still the line being edited.
for (const ch of 'ho X\r') shell.handleInput(ch);
await settle();
assert.ok(plain(output).includes('X\n') || plain(output).includes('X\r\n'), JSON.stringify(output));

// While a command runs, a notice is ordinary output: no prompt is drawn.
for (const ch of 'hold\r') shell.handleInput(ch);
await settle();
output = '';
shell.writeNotice('[nimbus: during]\r\n');
assert.equal(output, '[nimbus: during]\r\n');
releaseGate();
await settle();
await settle();
assert.ok(plain(output).endsWith(PROMPT));

console.log('shell-async-notice: ok');
process.exit(0);
