#!/usr/bin/env bun
// A barrier that could not ask the authority what changed has learned
// nothing, and "nothing" is not the same answer as "nothing changed".
//
// Every resumption of a node process runs behind an ACQUIRE: the
// authority's list of what changed since the process's cursor. When that
// call fails — a supervisor call dropped after its retries, a host that
// cannot answer it, a reply with no cursor — the process still resumes, and
// its synchronous reads are answered from whatever it holds. A failed
// barrier that is read as an empty delta serves every one of those rows,
// each written before a change the process was never told about.
//
// A failed barrier is handled as a poison instead: the delta channel cannot
// describe the distance from the cursor to now. The rows are reconciled
// against the authority's absolute listing when it can give one, and dropped
// when it cannot. A later barrier that succeeds brings the dropped rows back.
// Each scenario ends on a peer's change that the next resumption must see,
// or at least must not see as the old bytes.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import {
  coherenceStats,
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  sleep,
  until,
} from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';
const G = '/home/user/app/g.txt';
const DROPPED = () => Promise.reject(new Error('Network connection lost.'));

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = {
  read,
  // One resumption, then synchronous reads of every path named.
  resume: (...paths) => new Promise((resolve) => setTimeout(() => resolve(paths.map(read).join(",")), 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/**
 * A resident process holding f.txt at 'v1' and g.txt at 'g1', whose
 * supervisor answers each op `fault` names through that function while it is
 * set, and as the session does otherwise. `forward` is the session's answer.
 */
async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  authority.kfs.writeFile('home/user/app/g.txt', 'g1');
  const fault = { fsAcquire: null, fsList: null, fsReadBatch: null };
  const overrides = {};
  let forward;
  for (const op of Object.keys(fault)) {
    overrides[op] = (...args) => (fault[op] ? fault[op](...args) : forward(op, args));
  }
  const handle = facetSupervisor(authority, overrides);
  forward = handle.forward;
  await launchResident({ program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor() });
  const probe = globalThis.__probe;
  assert.equal(probe.read(F), 'v1', 'the boot fill holds the file');
  return { authority, fault, probe, log: handle.log, forward };
}

await runScenarios(import.meta.path, {
  async 'a barrier whose ACQUIRE is dropped'() {
    const { authority, fault, probe } = await boot();
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    fault.fsAcquire = DROPPED;
    assert.equal(
      await probe.resume(F),
      'v2',
      'a dropped ACQUIRE is not an empty delta: the rows are reconciled against the listing',
    );
    assert.ok(coherenceStats().barrierFailures >= 1, 'and the failure is counted where the coherence stats are read');
  },

  async 'a barrier whose ACQUIRE answers with no cursor'() {
    const { authority, fault, probe } = await boot();
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    fault.fsAcquire = async () => ({ poison: false, paths: [] });
    assert.equal(await probe.resume(F), 'v2', 'an answer with no cursor dates nothing and is not an empty delta');
  },

  async 'a barrier that cannot reach the authority at all'() {
    const { authority, fault, probe } = await boot();
    fault.fsAcquire = DROPPED;
    fault.fsList = DROPPED;
    fault.fsReadBatch = DROPPED;
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    const during = await probe.resume(F);
    assert.notEqual(during, 'v1', 'with nothing to validate it against, the old row must not be served');
    assert.match(during, /^ERR:/, 'the read fails instead');
    // The refused read put a live read in flight, and its own barrier a
    // repair; both are let fail against the outage before it ends, so what
    // follows is the next barrier's doing alone.
    await sleep(50);

    // The authority is back. The rows the failed barrier dropped come back
    // with the next resumption: g.txt never changed and no delta will ever
    // name it, so only the repair the failure left owed can restore it.
    fault.fsAcquire = null;
    fault.fsList = null;
    fault.fsReadBatch = null;
    authority.kfs.writeFile('home/user/app/f.txt', 'v3');
    assert.equal(await probe.resume(F, G), 'v3,g1', 'the next barrier restores what the failed one dropped');
  },

  async 'a barrier that joins a repair already in flight'() {
    // An outage leaves a repair owed. The next barrier (A) starts it; its
    // batch read serves f.txt at v1 and is answered late. A peer writes v2,
    // and the barrier after that (B) is answered after the write, so the
    // delta it holds names f.txt. B joins A's repair rather than start its
    // own. The repair's rows predate B's ACQUIRE, so B may not resume on them.
    const { authority, fault, probe, log, forward } = await boot();
    fault.fsAcquire = DROPPED;
    fault.fsList = DROPPED;
    fault.fsReadBatch = DROPPED;
    await probe.resume(F);
    await sleep(50);
    fault.fsAcquire = null;
    fault.fsList = null;

    const gate = Promise.withResolvers();
    const served = Promise.withResolvers();
    fault.fsReadBatch = async (requests) => {
      fault.fsReadBatch = null;
      const entries = await forward('fsReadBatch', [requests]);
      served.resolve();
      await gate.promise;
      return entries;
    };
    const a = probe.resume(F);
    await served.promise;
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    const acquired = log.calls.fsAcquire ?? 0;
    const b = probe.resume(F);
    await until(() => (log.calls.fsAcquire ?? 0) > acquired, "B's ACQUIRE");
    await sleep(20);
    gate.resolve();

    assert.match(await a, /^v[12]$/, 'A was answered before the write, so either version is its to see');
    assert.equal(await b, 'v2', 'B was told f.txt changed, so it must not resume on the repair that predates that');
  },

  async 'a barrier answered while another barrier repairs'() {
    // A's ACQUIRE is dropped, so A repairs the store: the listing drops
    // f.txt's outdated row, and the batch that refills it serves x1 and is
    // answered late. A peer writes x2. B's ACQUIRE is answered normally, so B
    // needs no repair of its own, but the store is half repaired: f.txt is
    // not held, and the repair will install x1 at its listing revision and
    // publish the listing's cursor. A delta admitted now consumes the report
    // of x2 with nothing to evict. E asks after B and is answered after the
    // repair lands, so its delta never names x2 again.
    const { authority, fault, probe, log, forward } = await boot();
    authority.kfs.writeFile('home/user/app/f.txt', 'x1');
    fault.fsAcquire = () => { fault.fsAcquire = null; return DROPPED(); };
    const batch = { served: Promise.withResolvers(), gate: Promise.withResolvers() };
    fault.fsReadBatch = async (requests) => {
      fault.fsReadBatch = null;
      const entries = await forward('fsReadBatch', [requests]);
      batch.served.resolve();
      await batch.gate.promise;
      return entries;
    };
    const a = probe.resume(F);
    await batch.served.promise;
    authority.kfs.writeFile('home/user/app/f.txt', 'x2');

    const acquired = log.calls.fsAcquire ?? 0;
    const b = probe.resume(F);
    await until(() => (log.calls.fsAcquire ?? 0) > acquired, "B's ACQUIRE");
    await sleep(20);

    const e = { issued: Promise.withResolvers(), gate: Promise.withResolvers() };
    fault.fsAcquire = async (...args) => {
      fault.fsAcquire = null;
      const answer = await forward('fsAcquire', args);
      e.issued.resolve();
      await e.gate.promise;
      return answer;
    };
    const eRead = probe.resume(F);
    await e.issued.promise;

    batch.gate.resolve();
    await a;
    e.gate.resolve();
    assert.equal(await b, 'x2', 'B was told f.txt changed, so it may not resume on a repair that predates that');
    assert.equal(await eRead, 'x2', 'E asked after the change, so it may not read the repair either');
    assert.equal(await probe.resume(F), 'x2', "and no later resumption serves the repair's x1");
  },

  async 'a heap-held cell whose barrier ACQUIRE is dropped'() {
    // The one-shot body and the opencode runner hold the resident set on the
    // heap rather than in facet SQLite; the same barrier guards it.
    const authority = createAuthority();
    const { rawVfs, kfs } = authority;
    kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
    kfs.writeFile('home/user/app/f.txt', 'V1');
    const bridge = new SqliteRuntimeFsBridge(kfs, rawVfs);
    const dec = new TextDecoder();
    let dropped = false;
    const supervisor = {
      readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
      writeFile: (p, c) => bridge.writeFile(p, c),
      stat: (p) => bridge.stat(p),
      lstat: (p) => bridge.stat(p, { followSymlinks: false }),
      readdir: (p) => bridge.readdir(p),
      exists: async (p) => (await bridge.stat(p)) !== null,
      fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
      fsAcquire: (epoch, cursor) => (dropped ? DROPPED() : bridge.acquire(epoch, cursor)),
    };
    globalThis.__nimbusVfsCursor = authority.cursor();
    const shims = new Function(
      '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
      'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
      '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode()
      + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };',
    )(
      { 'home/user/app/f.txt': 'V1' },
      { 'home/user/app/f.txt': { type: 'file', size: 2, mode: 0o644, uid: 1000, gid: 1000 } },
      {}, { 'home/user': ['app'], 'home/user/app': ['f.txt'] }, supervisor,
      { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user/app', [], {}, `/home/user/app/s.js`, '/home/user/app',
    );
    assert.equal(shims.fs.readFileSync(F, 'utf8'), 'V1');
    kfs.writeFile('home/user/app/f.txt', 'V2');
    dropped = true;
    const seen = Promise.withResolvers();
    shims.setTimeout(() => {
      try { seen.resolve(shims.fs.readFileSync(F, 'utf8')); } catch (error) { seen.resolve('ERR:' + error.code); }
    }, 0);
    assert.equal(await seen.promise, 'V2', 'the cells the failed barrier could not vouch for are refetched live');
  },
}, { barrierFailures: true });

console.log('resident-barrier-failure: ok');
