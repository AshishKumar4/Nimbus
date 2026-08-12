#!/usr/bin/env bun
//
// A facet-hosted runtime (node, bun) streams its output to the session
// terminal over the supervisor RPC and returns an empty string to the shell.
// That shortcut is only sound while the process's stdout IS the terminal, so
// `buildRuntimeHandler` asks `ctx.isFdTerminal(1)` before taking it.
//
// This test pins the answer that question gives in every shape that matters.
// When a redirect, a pipe, a command substitution, or a programmatic
// `shell.execute` capture stopped being distinguishable from the interactive
// terminal, the runtime kept streaming past the shell: `node -e "..." > f`
// wrote an empty file and the SDK's `exec()` returned an empty string with a
// correct exit code.

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/core/src/substrate/lifo/sandbox/Sandbox.ts';

function makeTerminal() {
  let buf = '';
  return {
    write: (d) => { buf += String(d); },
    writeln: (d) => { buf += String(d) + '\n'; },
    clear: () => { buf = ''; },
    onData: () => {},
    focus: () => {},
    cols: 80,
    rows: 24,
    get text() { return buf; },
  };
}

const box = await Sandbox.create({ persist: false, terminal: makeTerminal() });

try {
  // Stands in for the runtime handler: records what it was told about its own
  // fds, and writes through ctx.stdout so the shell's plumbing is exercised.
  const seen = [];
  box.commands.registry.register('fdprobe', async (ctx) => {
    seen.push({
      stdout: ctx.isFdTerminal?.(1),
      stderr: ctx.isFdTerminal?.(2),
    });
    ctx.stdout.write('probe-output\n');
    return 0;
  });

  const lastSeen = async (line) => {
    seen.length = 0;
    await box.shell.executeLine(line);
    return seen.at(-1);
  };

  assert.deepEqual(
    await lastSeen('fdprobe'),
    { stdout: true, stderr: true },
    'an interactive command owns the terminal — streaming past the shell is sound',
  );

  assert.deepEqual(
    await lastSeen('fdprobe > /tmp-fd-probe.txt'),
    { stdout: false, stderr: true },
    'a redirect takes fd 1 off the terminal',
  );
  const readBack = await box.shell.execute('cat /tmp-fd-probe.txt', { onStdout: () => {} });
  assert.equal(
    readBack.stdout,
    'probe-output\n',
    'the redirect receives what the command wrote',
  );

  assert.deepEqual(
    await lastSeen('fdprobe | cat'),
    { stdout: false, stderr: true },
    'a pipe takes fd 1 off the terminal',
  );

  assert.deepEqual(
    await lastSeen('fdprobe 2> /tmp-fd-probe-err.txt'),
    { stdout: true, stderr: false },
    'a stderr redirect is reported independently of stdout',
  );

  // The programmatic shape: `sandbox.exec()` runs the line through
  // `Shell.execute` with capture sinks and no terminal behind them at all.
  seen.length = 0;
  const captured = await box.shell.execute('fdprobe', {
    onStdout: () => {},
    onStderr: () => {},
  });
  assert.deepEqual(
    seen.at(-1),
    { stdout: false, stderr: false },
    'a captured execution owns neither fd — its result IS the output',
  );
  assert.equal(captured.stdout, 'probe-output\n');
} finally {
  await box.destroy?.();
}

console.log('runtime stdout fd disposition: ok');
