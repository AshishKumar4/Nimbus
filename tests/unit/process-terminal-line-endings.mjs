#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import {
  _emitExitDump,
  _rpcStderr,
  _rpcStdout,
} from '../../packages/worker/src/session/rpc.ts';

const bytes = (s) => new TextEncoder().encode(s);

function createHost() {
  const writes = [];
  const processes = new SessionProcessSupervisor();
  return {
    writes,
    host: {
      processes,
      terminal: { write: (data) => writes.push(data) },
      nimbusDebug: false,
    },
  };
}

{
  const { host, writes } = createHost();
  const entry = host.processes.spawn('plain-server', [], '/home/user', { longRunning: true });

  await _rpcStdout(host, entry.pid, bytes('a\nb\n'));
  await _rpcStderr(host, entry.pid, bytes('c\nd\n'));

  assert.deepEqual(writes, [
    'a\r\nb\r\n',
    '\x1b[31mc\r\nd\r\n\x1b[0m',
  ]);
  assert.deepEqual(
    host.processes.allLogs(entry.pid).map((chunk) => chunk.data),
    ['a\nb\n', 'c\nd\n'],
    'the process log store remains byte-identical to facet output',
  );
}

{
  const { host, writes } = createHost();
  const entry = host.processes.spawn('attached-tui', [], '/home/user', {
    longRunning: true,
    attachedTty: true,
  });

  await _rpcStdout(host, entry.pid, bytes('raw\nframe\n'));

  assert.deepEqual(writes, [], 'attached-TTY output is not mirrored into the shell terminal');
  assert.equal(host.processes.allLogs(entry.pid)[0].data, 'raw\nframe\n');
}

{
  const { host, writes } = createHost();
  const entry = host.processes.spawn('failed-server', [], '/home/user', { longRunning: true });
  host.processes.appendOutput(entry.pid, 'stdout', 'first\nsecond\n');

  _emitExitDump(host, entry.pid, 1);

  assert.ok(writes.includes('first\r\nsecond\r\n'), 'exit-dump chunks use terminal line endings');
  assert.equal(host.processes.allLogs(entry.pid)[0].data, 'first\nsecond\n');
}

// A process that has exited no longer owns the shell. Seen on staging: a
// one-shot's spinner interval kept firing after process.exit(1), and its
// frames reached the terminal after the prompt was drawn.
{
  const { host, writes } = createHost();
  const entry = host.processes.spawn('node cli.js', [], '/home/user');
  await _rpcStdout(host, entry.pid, bytes('Template copying...\n'));
  host.processes.exit(entry.pid, 1);
  await _rpcStdout(host, entry.pid, bytes('Template copying...\n'));
  await _rpcStderr(host, entry.pid, bytes('late\n'));
  assert.deepEqual(writes, ['Template copying...\r\n'], 'nothing after the exit reaches the shell');
}

console.log('process-terminal-line-endings: ok');
