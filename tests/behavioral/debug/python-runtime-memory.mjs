#!/usr/bin/env bun
import { mintSession, Terminal, BASE, AUTH_TOKEN, sleep, deleteSession, makeAsserter } from '../_driver.mjs';
import { diagMemory } from '../heap-correctness/_diag.mjs';
import { Nimbus } from '../../../packages/sdk/src/index.ts';

const a = makeAsserter('debug/python-runtime-memory');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, token: AUTH_TOKEN }).sandbox(sid);
const terminal = new Terminal(sid);
console.log(`SID: ${sid}`);
const snapshot = async (stage) => {
  const memory = await diagMemory(sid);
  console.log(JSON.stringify({
    stage, sid, at: new Date().toISOString(), heap: memory.heap, alloc: memory.alloc,
    lru: memory.vfsDetail, hib: memory.hib, lastFailures: memory.lastFailures,
  }));
};
try {
  await box.ready();
  await snapshot('before install');
  const installed = await box.runtimes.install('python');
  console.log(`installed through SDK without CLI warmup: ${JSON.stringify(installed)}`);
  await snapshot('after streamed install, before warmup');
  await terminal.connect();
  await terminal.waitForPrompt(30_000);
  const warmed = await terminal.run('nimbus install python', 180_000);
  console.log(`CLI warmup: ${JSON.stringify(warmed)}`);
  a.check('the CLI warms the already-installed runtime', warmed.exitCode === 0 && warmed.output.includes('[python] ready'));
  await snapshot('after warmup');
  const warmed = await diagMemory(sid);
  // The 10.6 MiB interpreter image plus the stdlib are read once for the
  // facet's module map; neither may stay pinned in the session's LRU.
  a.check('warm-up holds no runtime image in the session LRU',
    (warmed.vfsDetail?.lruBytes ?? 0) < 5_000_000,
    `lruBytes=${warmed.vfsDetail?.lruBytes}`);
  for (let index = 1; index <= 3; index++) {
    await sleep(30_000);
    await snapshot(`idle ${index * 30}s`);
  }
} finally {
  await terminal.close();
  const cleanup = await deleteSession(sid);
  console.log(`cleanup: ${JSON.stringify(cleanup)}`);
}
const result = a.summary();
process.exit(result.fail > 0 ? 1 : 0);
