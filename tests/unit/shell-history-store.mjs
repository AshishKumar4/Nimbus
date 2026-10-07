#!/usr/bin/env bun
// The interactive shell keeps one history (HistoryManager, saved in
// ~/.bash_history). Up/Down, reverse search, Alt+. and the history builtin
// read it; a line is recorded once, as it ran (after `!` expansion); the
// saved history is recalled after a restart; a heredoc is one entry, the
// whole command, which runs again as it stands. ~/.bash_history is a line a
// command, as bash writes it without timestamps: a multi-line command comes
// back after a restart as its lines, as it does in bash. There were two stores: the
// arrows read a second array that held the typed spelling, the opener of a
// heredoc alone, and nothing from before a restart.
import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { HeredocHandler } from '../../packages/core/src/shell/features.ts';
import { memoryFiles } from './lib/test-box.mjs';

const { files: vfs, root } = memoryFiles();
root.mkdir('home/user', { recursive: true });

async function startShell() {
  const registry = createDefaultRegistry();
  const ran = [];
  registry.register('mark', async (ctx) => { ran.push(ctx.args.join(' ')); return 0; });
  const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
  const shell = new Shell(terminal, vfs, registry, { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' }, new ProcessRegistry());
  HeredocHandler.install(shell, terminal);
  await shell.start();
  return { shell, ran };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
async function enter(shell, line) {
  for (const ch of line) await shell.handleInput(ch);
  await shell.handleInput('\r');
  await settle();
}

{
  const { shell, ran } = await startShell();
  await enter(shell, 'mark one');
  await enter(shell, 'mark two');
  await enter(shell, '!!');
  assert.deepEqual(ran, ['one', 'two', 'two']);
  assert.deepEqual([...shell.history], ['mark one', 'mark two'], 'the expanded line, recorded once');
  await shell.handleInput('\x1b[A');
  assert.equal(shell.lineBuffer, 'mark two', 'Up recalls the same store');
  await shell.handleInput('\x1b[A');
  assert.equal(shell.lineBuffer, 'mark one');
  await shell.handleInput('\x1b[B');
  await shell.handleInput('\x1b[B');
  assert.equal(shell.lineBuffer, '');

  await enter(shell, 'mark <<EOF');
  await enter(shell, 'body');
  await enter(shell, 'EOF');
  assert.equal(shell.history.at(-1), 'mark <<EOF\nbody\nEOF', 'a heredoc is one entry, the whole command');
  assert.deepEqual(ran, ['one', 'two', 'two', '']);
  await shell.executeLine(shell.history.at(-1));
  await settle();
  assert.deepEqual(ran, ['one', 'two', 'two', '', ''], 'a recalled heredoc runs as it stands');
}

{
  const { shell } = await startShell();
  assert.deepEqual([...shell.history], ['mark one', 'mark two', 'mark <<EOF', 'body', 'EOF'], 'the saved history, line by line');
  await shell.handleInput('\x1b[A');
  await shell.handleInput('\x1b[A');
  await shell.handleInput('\x1b[A');
  await shell.handleInput('\x1b[A');
  assert.equal(shell.lineBuffer, 'mark two', 'Up after a restart walks the saved history');
}
console.log('shell-history-store: ok');
