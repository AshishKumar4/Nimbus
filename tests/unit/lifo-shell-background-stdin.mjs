#!/usr/bin/env bun
// A job started with `&` does not read the terminal: its stdin, before any
// redirection of its own, is the empty file /dev/null, as POSIX has an
// asynchronous list's stdin (bash's for a job of a shell without job
// control). So only the foreground job owns the terminal and its modes: a
// background REPL (`node &`) that turned the terminal's signal keys off
// used to take the Ctrl-C meant for the foreground job.
//
// Each case starts `probe &` beside a foreground job: probe records what it
// was given for stdin and, given the terminal, turns its signal keys off as
// the REPL does.
import assert from 'node:assert/strict';
import { Shell } from '../../packages/core/src/substrate/lifo/shell/Shell.ts';
import { ProcessRegistry } from '../../packages/core/src/substrate/lifo/shell/ProcessRegistry.ts';
import { createDefaultRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { memoryFiles } from './lib/test-box.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeShell() {
  const { files: vfs, root } = memoryFiles();
  root.mkdir('home/user', { recursive: true });
  root.writeFile('home/user/in.txt', 'from the file\n');
  const registry = createDefaultRegistry();
  const seen = [];
  registry.register('probe', async (ctx) => {
    const record = { terminal: ctx.terminalStdin !== undefined, fd0Terminal: ctx.isFdTerminal?.(0) ?? null };
    if (ctx.terminalStdin) ctx.terminalStdin.signalKeys = false;
    record.read = ctx.stdin ? await ctx.stdin.read() : undefined;
    seen.push(record);
    return 0;
  });
  // The foreground job: runs until it is interrupted.
  registry.register('fg-job', (ctx) => new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve(130), { once: true });
  }));
  const shell = new Shell(
    { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} },
    vfs,
    registry,
    { HOME: '/home/user', USER: 'user', HOSTNAME: 'nimbus' },
    new ProcessRegistry(),
  );
  return { shell, seen };
}

// ── a background job's stdin is /dev/null, and Ctrl-C reaches the foreground ──
{
  const { shell, seen } = makeShell();
  const line = shell.executeLine('probe & fg-job');
  await settle();
  assert.deepEqual(seen, [{ terminal: false, fd0Terminal: false, read: null }], 'the background job reads end of file, not the terminal');
  assert.equal(shell.running, true, 'the foreground job runs');
  shell.handleInput('\x03');
  await line;
  await settle();
  assert.equal(shell.running, false, 'Ctrl-C interrupted the foreground job');
}

// ── its own redirection still applies ──────────────────────────────────────
{
  const { shell, seen } = makeShell();
  await shell.executeLine('probe < in.txt &');
  await settle();
  assert.equal(seen[0].read, 'from the file\n', 'a redirection of the job is its stdin');
}

// ── a foreground job still has the terminal ────────────────────────────────
{
  const { shell, seen } = makeShell();
  const line = shell.executeLine('probe');
  await settle();
  assert.deepEqual([seen.length, shell.running], [0, true], 'the foreground probe waits on the terminal');
  shell.handleInput('typed');
  shell.handleInput('\r');
  await line;
  assert.deepEqual(seen, [{ terminal: true, fd0Terminal: true, read: 'typed\n' }]);
}

console.log('lifo-shell-background-stdin: ok');
