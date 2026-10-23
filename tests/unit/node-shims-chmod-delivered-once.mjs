#!/usr/bin/env bun
// A sync chmod reaches the session on the next flush of its path, once. It
// used to be re-sent on EVERY flush, and every async read flushed first, so
// each read of the file was a chmod: a real mutation that bumped the path's
// revision, made the next ACQUIRE evict the process's own cell, and made the
// refetch chmod again. create-astro's readFileSync(README.md) landed in one of
// those evictions and failed EAGAIN.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { observeWaves, shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const dir = '/home/user/app';
const file = `${dir}/README.md`;
authority.kfs.mkdir(dir, { recursive: true });
authority.kfs.writeFile(file, '# app');

// The modes the session is sent: one per chmod delivered in a wave.
const modes = [];
const { fs } = shimsOnSession({
  authority,
  overrides: (forward) => ({
    writeBatchStream: observeWaves(forward, (record) => {
      if (record.type === 'setattr' && 'mode' in record.attrs) modes.push(record.attrs.mode & 0o777);
    }),
  }),
});
const flush = () => globalThis.__nimbusProcessFs.flush();

fs.chmodSync(file, 0o600);
assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the mode is visible to the process at once');

await fs.promises.readFile(file, 'utf8');
await flush();
assert.deepEqual(modes, [0o600], 'the next flush delivers the mode');
assert.equal((await authority.peer.stat(file)).mode & 0o777, 0o600, 'and the session has it');
const revisionAfterDelivery = authority.rawVfs.revision(file);

for (let i = 0; i < 5; i++) assert.equal(await fs.promises.readFile(file, 'utf8'), '# app');
await flush();
assert.deepEqual(modes, [0o600], `reads must not re-send the mode (sent ${modes.length})`);
assert.equal(authority.rawVfs.revision(file), revisionAfterDelivery, 'reads must not mutate the file');
assert.equal(fs.readFileSync(file, 'utf8'), '# app', 'the sync view still serves the file');
assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'and still shows the mode');

fs.chmodSync(file, 0o640);
await fs.promises.readFile(file, 'utf8');
await flush();
assert.deepEqual(modes, [0o600, 0o640], 'a later chmod is delivered too');
assert.equal((await authority.peer.stat(file)).mode & 0o777, 0o640);

console.log('node-shims-chmod-delivered-once: ok');
