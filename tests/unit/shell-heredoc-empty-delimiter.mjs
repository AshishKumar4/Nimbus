#!/usr/bin/env bun
// The interactive shell reads a here-document's body as bash reads it, the
// lexer the one judge of where a body ends:
//
//   - `<<''` (an empty delimiter) collects lines until an empty line;
//   - `<<-` strips the leading tabs of the body and of its terminator;
//   - two here-documents on one line are collected in turn;
//   - a recalled command whose bodies are all there runs as it stands.
//
// Red before: the handler refused an empty delimiter, so `cat <<''` ran at
// once, before its body, and the parser found no body.
import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { HeredocHandler } from '../../packages/core/src/shell/features.ts';
import { memoryFiles } from './lib/test-box.mjs';

const { files: vfs, root } = memoryFiles();
root.mkdir('home/user', { recursive: true });
const registry = createDefaultRegistry();
const seen = [];
registry.register('show', async (ctx) => {
  let text = '';
  for (;;) { const chunk = await ctx.stdin?.read(); if (chunk === null || chunk === undefined) break; text += chunk; }
  seen.push(`${ctx.args.join(' ')}:${text}`);
  return 0;
});
const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const shell = new Shell(terminal, vfs, registry, { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' }, new SessionProcessSupervisor());
HeredocHandler.install(shell, terminal);
await shell.start();
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const enter = async (line) => {
  for (const ch of line) await shell.handleInput(ch);
  await shell.handleInput('\r');
  await settle();
};

await enter("show a <<''");
assert.deepEqual(seen, [], 'an empty delimiter waits for its body');
await enter('one');
await enter('two');
await enter('');
assert.deepEqual(seen, ['a:one\ntwo\n'], 'the body ends at the empty line');
console.log("  ✓ <<'' collects its body until an empty line");

await enter('show b <<-END');
await enter('\tindented');
await enter('\tEND');
await enter('show c <<X <<Y');
await enter('x');
await enter('X');
await enter('y');
await enter('Y');
assert.deepEqual(seen.slice(1), ['b:indented\n', 'c:y\n'], 'tabs are stripped; of two here-documents on one line the last is stdin');
console.log('  ✓ <<- strips tabs, and two here-documents on one line are collected in turn');

await shell.executeLine('show d <<E\nbody\nE');
await settle();
assert.deepEqual(seen.at(-1), 'd:body\n', 'a recalled command with its body runs as it stands');
console.log('  ✓ a recalled command whose bodies are there runs as it stands');
console.log('shell-heredoc-empty-delimiter: ok');
