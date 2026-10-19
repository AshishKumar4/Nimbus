#!/usr/bin/env bun
// fs.promises.watch is fs.watch's engine as an async iterator, as Node's is:
// - it yields a file's changes, not the identity of the buffer the resident
//   store hands back (a fresh copy of unchanged bytes is no change);
// - its signal ends it: the pending next() rejects with an AbortError, and
//   the watcher stops;
// - return() ends it and stops the watcher.
// Red before: it polled with its own timer and compared buffer identity, so
// unchanged bytes read as a change every 500 ms, and its signal was ignored.
// The signal case runs in the real one-shot runner over a 3 MiB file the
// resident store keeps in chunks.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import './lib/launch-captures.mjs';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

// The one-shot runner installs its own process global once it loads.
const realProcess = globalThis.process;

let bytes = new Uint8Array([1, 2, 3]);
const bundle = new Proxy({}, {
  has(_target, key) { return key === 'home/user/file.bin' && bytes !== null; },
  get(_target, key) { return key === 'home/user/file.bin' && bytes !== null ? bytes.slice() : undefined; },
});
/** The engine's interval timers, by id; a cleared one is gone. */
const timers = new Map();
let nextTimer = 1;
const fs = new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', 'setInterval', 'clearInterval',
  '"use strict";' + nodeFacetSources('').residentStore + generateShimsCode() + '\nreturn builtins.fs;')(
  bundle, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.js', '/home/user',
  (callback) => { timers.set(nextTimer, callback); return nextTimer++; }, (id) => { timers.delete(id); },
);
const tick = () => { for (const callback of [...timers.values()]) callback(); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** next(), or 'pending' if it has not settled within `ms` of real time. */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('pending'), ms))]);

// ── changes, not buffers ──────────────────────────────────────────────────
{
  const watching = fs.promises.watch('/home/user/file.bin')[Symbol.asyncIterator]();
  const first = watching.next();
  for (let n = 0; n < 3; n++) tick();
  await settle();
  bytes[0] = 9;
  tick();
  assert.deepEqual(await within(first, 2000), { value: { eventType: 'change', filename: 'file.bin' }, done: false }, 'a content edit is yielded');
  const second = watching.next();
  tick();
  tick();
  assert.equal(await within(second, 1200), 'pending', 'fresh buffers of unchanged bytes are not changes');
  bytes = null;
  tick();
  assert.deepEqual(await within(second, 2000), { value: { eventType: 'rename', filename: 'file.bin' }, done: false }, 'deletion is a rename');
  assert.deepEqual(await watching.return(), { value: undefined, done: true });
  assert.equal(timers.size, 0, 'return() stops the watcher');
  assert.deepEqual(await watching.next(), { value: undefined, done: true }, 'an ended iterator stays done');
  bytes = new Uint8Array([1]);
}

// ── nothing starts until the first next(); an end is final ────────────────
{
  const before = timers.size;
  const unread = fs.promises.watch('/home/user/file.bin')[Symbol.asyncIterator]();
  assert.equal(timers.size, before, 'a watcher no one reads polls nothing');
  assert.deepEqual(await unread.return(), { value: undefined, done: true });
  assert.equal(timers.size, before, 'and ending it starts nothing');
  bytes = new Uint8Array([1, 2, 3]);
  const backlog = fs.promises.watch('/home/user/file.bin')[Symbol.asyncIterator]();
  const first = backlog.next();
  for (let n = 0; n < 2; n++) tick();
  await settle();
  bytes[1] = 8;
  tick();
  assert.deepEqual(await within(first, 2000), { value: { eventType: 'change', filename: 'file.bin' }, done: false });
  bytes[2] = 8;
  tick();
  await settle();
  await backlog.return();
  assert.deepEqual(await within(backlog.next(), 1000), { value: undefined, done: true }, 'a change queued before return() is not yielded after it');
  assert.equal(timers.size, before, 'and its polling stopped');
}

// ── its signal ends it (the real one-shot runner, whose AbortError is Node's) ──
{
  const authority = createAuthority();
  authority.kfs.mkdir('home/user', { recursive: true });
  authority.kfs.writeFile('home/user/file.bin', new Uint8Array(3 * 1024 * 1024).fill(7));
  const program = `
const fs = require('fs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outcome = async (iterable) => {
  try { for await (const event of iterable) return { event }; return { done: true }; }
  catch (error) { return { name: error.name, code: error.code, cause: String(error.cause) }; }
};
(async () => {
  const controller = new AbortController();
  const watching = outcome(fs.promises.watch('/home/user/file.bin', { signal: controller.signal }));
  setTimeout(() => controller.abort('stop'), 1300);
  const aborted = await Promise.race([watching, sleep(4000).then(() => ({ timeout: true }))]);
  const already = await Promise.race([outcome(fs.promises.watch('/home/user/file.bin', { signal: controller.signal })), sleep(1000).then(() => ({ timeout: true }))]);
  // After its abort, a watcher is done.
  const second = new AbortController();
  const aborting = fs.promises.watch('/home/user/file.bin', { signal: second.signal })[Symbol.asyncIterator]();
  const waitingNext = aborting.next().then(() => 'resolved', (error) => error.name);
  second.abort('again');
  const afterAbort = [await waitingNext, await aborting.next()];
  // A signal that is not one: its first next() rejects with Node's error, then it is done; return() first ends it.
  const invalid = fs.promises.watch('/home/user/file.bin', { signal: {} })[Symbol.asyncIterator]();
  const refusal = await new Promise((resolve) => resolve(invalid.next())).then(() => 'resolved', (error) => error.code);
  const invalidSignal = [refusal, await invalid.next()];
  const unread = fs.promises.watch('/home/user/file.bin', { signal: {} })[Symbol.asyncIterator]();
  invalidSignal.push(await new Promise((resolve) => resolve(unread.return())), await unread.next());
  // return() while a next() waits on an unchanged file ends both at once.
  const iterator = fs.promises.watch('/home/user/file.bin')[Symbol.asyncIterator]();
  const pending = iterator.next();
  await sleep(700);
  const returned = await Promise.race([iterator.return(), sleep(2000).then(() => 'timeout')]);
  const settled = await Promise.race([pending, sleep(2000).then(() => 'timeout')]);
  console.log(JSON.stringify({ aborted, already, returned, settled, afterAbort, invalidSignal }));
  process.exit(0);
})();
`;
  const dir = mkdtempSync(join(tmpdir(), 'node-promises-watch-'));
  try {
    const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
    const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
    const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    const instance = processInstanceSupervisor(authority, cred);
    let body;
    try {
      const response = await mod.default.fetch(new Request('http://facet/', {
        method: 'POST',
        body: JSON.stringify({
          argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
          stdin: '', captureOutput: true, cred, pid: instance.pid,
        }),
      }), { SUPERVISOR: instance.supervisor });
      body = await response.json();
    } finally {
      await instance.close();
    }
    assert.equal(body.exitCode, 0, JSON.stringify(body));
    const seen = JSON.parse(body.stdout);
    assert.deepEqual(seen.aborted, { name: 'AbortError', code: 'ABORT_ERR', cause: 'stop' },
      'an unchanged 3 MiB file yields nothing, and the signal ends the iterator with an AbortError');
    assert.deepEqual(seen.afterAbort, ['AbortError', { done: true }], 'its abort rejects the waiting next(), and after it, it is done');
    assert.deepEqual(seen.invalidSignal, ['ERR_INVALID_ARG_TYPE', { done: true }, { done: true }, { done: true }],
      'a signal that is not an AbortSignal is one rejection of the first next(), then done; return() before any next() ends it');
    assert.deepEqual([seen.returned, seen.settled], [{ done: true }, { done: true }],
      'return() while a next() waits ends the iterator and settles the waiting next()');
    assert.deepEqual(seen.already, { name: 'AbortError', code: 'ABORT_ERR', cause: 'stop' }, 'an already-aborted signal refuses it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('node-shims-promises-watch: ok');
realProcess.exit(0);
