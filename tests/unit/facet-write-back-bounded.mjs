#!/usr/bin/env bun
// A program that writes a tree synchronously parks every file, and the
// write-back carries them all to the authority at once. Unbounded, a
// 10-directory, 250-file seed issued ~250 concurrent writeFile RPCs; live,
// some never reached the session DO and never settled, so the process printed
// its last line and never exited. The write-back keeps at most 6 waves in
// flight, and every file still lands.

import assert from 'node:assert/strict';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { processBridge } from './lib/process-bridge.mjs';
import { observed, sessionShims } from './lib/session-shims.mjs';

const dec = new TextDecoder();
const cwd = '/home/user/app';
const authority = createAuthority();
authority.kfs.mkdir(cwd.slice(1), { recursive: true, mode: 0o755 });
const bridge = observed(processBridge(authority.rawVfs, authority.rawVfs.as(CRED_KERNEL)));

// The raw timer: the latency is the authority's, not a resumption of the program.
const rawSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((resolve) => rawSetTimeout(resolve, ms));
const slow = (fn) => async (...args) => { await wait(5); return fn(...args); };

let wavesInFlight = 0;
let maxWavesInFlight = 0;
globalThis.__nimbusProcessExitPromise = new Promise(() => {});

const { fs, runToExit, rf } = sessionShims(authority, {
  cwd,
  overrides: (call) => ({
    fsAcquire: slow((...args) => call('fsAcquire', args)),
    fsReadBatch: slow((...args) => call('fsReadBatch', args)),
    writeBatchStream: async (...args) => {
      wavesInFlight++;
      maxWavesInFlight = Math.max(maxWavesInFlight, wavesInFlight);
      try { await wait(5); return await call('writeBatchStream', args); } finally { wavesInFlight--; }
    },
  }),
  tail: `\n${ENTRYPOINT_EVENT_LOOP}\n;return { fs: __fsMod, runToExit: __nimbusRunEntrypointToExit };`,
});

const DIRS = 'abcdefghij'.split('');
const PER_DIR = 25;
for (const d of DIRS) {
  fs.mkdirSync(`${cwd}/seed/${d}`, { recursive: true });
  for (let i = 0; i < PER_DIR; i++) fs.writeFileSync(`${cwd}/seed/${d}/f${i}.txt`, `${d}${i}`);
}

// The run's end: what the process holds is sent and answered (the exit's settle).
const loop = await runToExit(undefined, 20_000);
assert.equal(loop.pending, 0, 'the loop must end because the work is done');
assert.deepEqual(await rf.settle(), [], 'everything the program wrote was sent, and none was refused');
assert.ok(maxWavesInFlight <= 6, `at most 6 write-back waves in flight (saw ${maxWavesInFlight})`);

for (const d of DIRS) {
  const names = (await bridge.readdir(`${cwd}/seed/${d}`)).map((e) => e.name);
  assert.equal(names.length, PER_DIR, `every file of ${d} reached the authority (got ${names.length})`);
}
assert.equal(dec.decode(await bridge.readFile(`${cwd}/seed/j/f24.txt`)), 'j24', 'with its bytes');

console.log('ok - facet-write-back-bounded');
