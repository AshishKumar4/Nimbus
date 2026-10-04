#!/usr/bin/env bun
// What a parent writes to a child's stdin reaches the child as it is written,
// whichever way the broker runs the child.
//
// The broker ran a registry command (a pure builtin), a shell, and a program
// found by name or path (a script, through the registry) on a stdin it fixed
// beforehand: the text queued once the parent ended stdin or half a second
// passed, or none at all. So a child that answers each line its parent writes
// (a script's `cat`) never answered the first before the parent ended, or saw
// nothing. What has to hold, for each kind: the child reads the first chunk
// while stdin is still open, then the second, and its stdin ends when the
// parent ends it.

import assert from 'node:assert/strict';
import { FacetProcessManager } from '../../packages/worker/src/facets/process.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { staticStdinReader } from '../../packages/core/src/shell/stdin-adapter.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const processes = new SessionProcessSupervisor();
const parent = processes.spawn('node', ['parent.js'], '/home/user');

/** `cat`: each piece of stdin, as it arrives, to stdout. */
async function cat(stdin, hooks) {
  for (let piece = await stdin.readBytes(65536); piece !== null; piece = await stdin.readBytes(65536)) hooks.onStdout(piece);
  return 0;
}

const manager = new FacetProcessManager({
  processes,
  vfsForProcess: () => ({ exists: async () => true, isDirectory: async () => false, readFileString: async () => 'cat\n' }),
  commandRegistry: {
    async resolve(name) { return { kind: name === 'cat' ? 'pure-builtin' : 'facet-direct' }; },
    runPureBuiltin: (_pid, _name, _args, _env, _cwd, stdin, hooks) => cat(stdin, hooks),
  },
  shellExecutor: { execute: (_pid, _line, _env, _cwd, stdin, hooks) => cat(stdin, hooks) },
  facetMgr: {
    // A program by name or path runs through the registry: a script's shell, here its `cat`.
    execStream: (payload, opts, hooks) => cat(opts.stdin ?? staticStdinReader(JSON.parse(payload).stdin), hooks),
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The child's stdout from where the last read of it stopped, until `until` holds (or 5 s pass). */
function reader(childPid) {
  let since = 0;
  return async (until) => {
    let text = '';
    const deadline = Date.now() + 5000;
    while (!until(text) && Date.now() < deadline) {
      const { chunks, maxSeq } = await manager.readOutput(childPid, 1, since, 200);
      for (const chunk of chunks) text += decoder.decode(chunk.data);
      since = maxSeq;
    }
    return text;
  };
}

for (const [kind, command, args] of [['pure builtin', 'cat', []], ['shell', 'sh', ['s.sh']], ['program by path', './s.sh', []]]) {
  const { childPid } = await manager.spawn({ parentPid: parent.pid, command, args, cwd: '/home/user', env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const outputOf = reader(childPid);
  assert.equal(manager.stdinWrite(childPid, encoder.encode('one\n')).ok, true);
  assert.equal(await outputOf((text) => text === 'one\n'), 'one\n', `${kind}: the first line is read while stdin is open`);
  await sleep(600);
  assert.equal(manager.stdinWrite(childPid, encoder.encode('two\n')).ok, true, `${kind}: the child is still reading`);
  assert.equal(await outputOf((text) => text === 'two\n'), 'two\n', `${kind}: and the second, when it is written`);
  manager.stdinEnd(childPid);
  const exit = await manager.wait(childPid, 5000);
  assert.deepEqual([exit.done, exit.exitCode], [true, 0], `${kind}: the child exits when its stdin ends`);
}

console.log('ok - cp-stdin-live (a pure builtin, a shell and a program by path read their stdin as the parent writes it)');
