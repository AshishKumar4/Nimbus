#!/usr/bin/env bun
// Same user-visible failure as the shipped coherence probe, on local workerd.
import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
const probe = await startLocalProbe({ runtimes: ['bash', 'cpython'] });
try {
  const terminal = await localTerminal(probe, { install: ['cpython'] });
  try {
    await terminal.run('echo one > watch.txt');
    const launched = await terminal.run(`python3 -c "import time\nfor i in range(16):\n  print('saw', open('watch.txt').read().strip(), flush=True)\n  time.sleep(0.5)" > watch.log 2>&1 &`);
    assert.equal(launched.status, 0, launched.stdout);
    await terminal.run('sleep 2; echo two > watch.txt; sleep 4; cat watch.log');
    const log = await terminal.run('sleep 3; cat watch.log');
    console.log(JSON.stringify({ log: log.stdout }));
    assert.match(log.stdout, /saw one/);
    assert.match(log.stdout, /saw two/, 'a sleeping WASI process sees the peer rewrite after wake');
  } finally { await terminal.close(); }
} finally { await probe.stop(); }
console.log('wasi-sleep-coherence-workerd: peer rewrite visible');
