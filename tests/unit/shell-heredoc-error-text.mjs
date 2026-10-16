#!/usr/bin/env bun
// The interactive shell reports a here-document whose line fails as every
// shell and runtime path reports a caught value (_shared/error-text.ts,
// audit SHI-12): an Error's message, a thrown object's message, a string as
// itself, and an Error with no message by its name rather than as nothing.
//
// Red before: the heredoc handler kept its own narrower report, which said
// `[object Object]` for a thrown { message } and nothing for `new Error('')`.
import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { HeredocHandler } from '../../packages/core/src/shell/features.ts';
import { memoryFiles } from './lib/test-box.mjs';

const { files: vfs, root } = memoryFiles();
root.mkdir('home/user', { recursive: true });
let written = '';
const terminal = { write(text) { written += text; }, writeln(text) { written += `${text}\n`; }, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const shell = new Shell(terminal, vfs, createDefaultRegistry(), { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' }, new SessionProcessSupervisor());
// What the line fails with: a here-document's line, run once its body is in, throws the value its marker names.
const THROWN = { object: { message: 'denied' }, empty: new Error(''), string: 'plain words', error: new Error('boom') };
const execute = shell.executeLine.bind(shell);
shell.executeLine = async (line, submission) => {
  const kind = /^cat <<(\w+)/.exec(line)?.[1];
  if (kind !== undefined && kind in THROWN) throw THROWN[kind];
  return await execute(line, submission);
};
HeredocHandler.install(shell, terminal);
await shell.start();
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const enter = async (line) => {
  for (const ch of line) await shell.handleInput(ch);
  await shell.handleInput('\r');
  await settle();
};

const reported = [];
for (const kind of Object.keys(THROWN)) {
  written = '';
  await enter(`cat <<${kind}`);
  await enter('body');
  await enter(kind);
  reported.push(/heredoc error: (.*?)\x1b\[0m/.exec(written)?.[1] ?? null);
}
assert.deepEqual(reported, ['denied', 'Error', 'plain words', 'boom'], 'each failure is reported as error-text reports it');
console.log('ok - shell-heredoc-error-text (a failed here-document is reported as every caught value is)');
