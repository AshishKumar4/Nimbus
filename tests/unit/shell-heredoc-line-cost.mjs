#!/usr/bin/env bun
// The interactive shell takes a here-document's line in time that does not
// grow with how many here-documents the command opens: a body line is
// tested against the one here-document it is in.
//
// A command opens H empty here-documents (`true <<E <<E …`), and H lines of
// `E` end them. A line at H = 40,000 costs about what it costs at 4,000: a
// look at the 36,000 more here-documents would add tens of microseconds.
//
// Red before: each line asked every one of the command's here-documents
// whether it strips tabs, so a line cost H.
import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { HeredocHandler } from '../../packages/core/src/shell/features.ts';
import { memoryFiles } from './lib/test-box.mjs';

const { files: vfs, root } = memoryFiles();
root.mkdir('home/user', { recursive: true });
const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const shell = new Shell(terminal, vfs, createDefaultRegistry(), { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' }, new SessionProcessSupervisor());
HeredocHandler.install(shell, terminal);
await shell.start();

/** Microseconds a terminator line takes, the command opening `count` here-documents. */
const perLine = async (count) => {
  await shell.executeLine(`true ${'<<E '.repeat(count)}`);
  const start = performance.now();
  for (let i = 1; i < count; i++) await shell.executeLine('E');
  const each = ((performance.now() - start) / (count - 1)) * 1000;
  await shell.executeLine('E');
  return each;
};
await perLine(2_000);
const small = Math.min(await perLine(4_000), await perLine(4_000));
const large = await perLine(40_000);
assert.ok(large - small < 10, `a line costs ${large.toFixed(1)} us at 40,000 here-documents and ${small.toFixed(1)} us at 4,000`);
console.log(`  ✓ a here-document line costs the same however many the command opens (${small.toFixed(1)} us at 4,000, ${large.toFixed(1)} us at 40,000)`);
console.log('shell-heredoc-line-cost: ok');
