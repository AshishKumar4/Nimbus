#!/usr/bin/env bun
// A program's synchronous reads on the resident filesystem (VFS-9 B stage 3,
// spec rows R1-R3), on the engine Node runs on (`eager`: the resident
// filesystem over an enumerated store), given its program's residency
// (ResidentDelegation.residency):
//
//   - R1, the program's misses: a read of a file's bytes it was refused (not
//     resident) stays its miss until its own awaited read of that name's
//     bytes answers it, or the view knows the name absent; a refused stat or
//     listing is no miss. A background fill, a later
//     synchronous answer, an awaited stat after a refused content read: none
//     clears it. Each is told once, as it happens; misses() is what is left.
//   - R2, the fault-in: a refused content read fetches the file, one fetch
//     per file however often it is refused, joined by every read of it while
//     it is out, the misses of one turn fetched together; one that did not
//     land is asked again by the next miss. misses() and the run's end wait
//     for them.
//   - R3, speculation: a miss under the import prefetch's speculation is its
//     own, never the program's, and its fill is charged to its quota before
//     it is issued, or not issued.
//   - A file of any size reads whole for a caller that may wait: held where
//     the store has room, else through its pages.
//
// A WASI program (no residency) is refused as before, leaving nothing.
//
// Red before: the resident filesystem only counted a refusal (notResident),
// fetched nothing for it, and refused a file over 8 MiB to every read.

import assert from 'node:assert/strict';
import { runScenarios, sleep } from './lib/resident-body.mjs';
import { APP, bootEngine } from './lib/guest-engines.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../packages/core/src/constants.ts';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/platform/src/limits.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (bytes) => dec.decode(bytes);
const key = (path) => path.replace(/^\/+/, '');

/** The code a synchronous read was refused with, or what it answered. */
function syncRead(e, path) {
  try { const bytes = e.sync.readFile(path); return bytes === null ? null : text(bytes); } catch (error) { return error.code; }
}

/**
 * An eager engine given a program's residency: the misses it is told of
 * (`told`), and the speculation in force (`speculate`). `files` are made in
 * APP before it starts.
 */
async function boot({ files = {}, seed, ...options } = {}) {
  const told = [];
  let speculation = null;
  const e = await bootEngine('eager', {
    ...options,
    seed(authority) {
      for (const [name, body] of Object.entries(files)) authority.kfs.writeFile(`home/user/app/${name}`, body);
      seed?.(authority);
    },
    residency: { speculation: () => speculation, missed: (missed) => { told.push(missed); } },
  });
  /** `step` run under `record`, as the import prefetch runs a synchronous step. */
  const under = (record, step) => {
    speculation = record;
    try { return step(); } finally { speculation = null; }
  };
  return { e, told, under };
}

/** A speculation as the import prefetch keeps one: its misses, their fetches, and its quota. */
function speculationRecord({ files = Infinity, bytes = Infinity } = {}) {
  const record = {
    misses: [],
    fetches: new Map(),
    charged: { files: 0, bytes: 0 },
    missed(missed, fetch) {
      record.misses.push(missed);
      if (fetch !== null) record.fetches.set(missed, fetch);
    },
    charge(size) {
      if (record.charged.files + 1 > files || record.charged.bytes + size > bytes) return false;
      record.charged.files++;
      record.charged.bytes += size;
      return true;
    },
  };
  return record;
}

/** The paths each fsReadBatch asked for, as the session was asked. */
function readBatches() {
  const asked = [];
  return {
    asked,
    supervise: {
      fsReadBatch: async (call, args) => {
        asked.push([...new Set(args[0].map((request) => key(request.path)))]);
        return call(args);
      },
    },
  };
}

/** A call the session answers only once `release`d: each ask of it parks until then. */
function parked(name) {
  let gate = Promise.withResolvers();
  let waiting = 0;
  return {
    get waiting() { return waiting; },
    release: () => { gate.resolve(); gate = Promise.withResolvers(); },
    supervise: {
      [name]: async (call, args) => {
        waiting++;
        await gate.promise;
        waiting--;
        return call(args);
      },
    },
  };
}

await runScenarios(import.meta.path, {
  async 'a refused read is the program\'s miss until its own awaited read answers it, never a fill behind its back'() {
    const { e, told } = await boot({ files: { 'a.txt': 'A', 'b.txt': 'B' } });
    const a = `${APP}/a.txt`;
    const b = `${APP}/b.txt`;
    // What the process holds is answered, and is no miss; what is not there is absent, and is no miss either.
    assert.equal(text(await e.fs.readFile(a)), 'A');
    assert.equal(syncRead(e, a), 'A');
    assert.equal(syncRead(e, `${APP}/none.txt`), null);
    assert.deepEqual(await e.fs.misses(), [], 'nothing refused yet');

    assert.equal(syncRead(e, b), 'EAGAIN');
    assert.deepEqual(told, [key(b)], 'the miss is told as it happens');
    assert.deepEqual(await e.fs.misses(), [key(b)], 'its fault-in landed: still the program\'s miss');
    assert.equal(syncRead(e, b), 'B', 'the fault-in made it resident');
    assert.deepEqual(await e.fs.misses(), [key(b)], 'a later synchronous answer does not clear it');
    assert.deepEqual(told, [key(b)], 'told once');
    assert.equal(text(await e.fs.readFile(b)), 'B');
    assert.deepEqual(await e.fs.misses(), [], 'the program\'s awaited read answered it');
  },

  async 'an awaited stat after an ignored content miss does not clear it'() {
    const { e } = await boot({ files: { 'c.txt': 'C', 'd.txt': 'D' } });
    const c = `${APP}/c.txt`;
    assert.equal(syncRead(e, c), 'EAGAIN');
    assert.equal(syncRead(e, `${APP}/d.txt`), 'EAGAIN');
    assert.equal(Number((await e.fs.stat(c)).size), 1);
    await e.fs.access(c, 4);
    assert.deepEqual(await e.fs.misses(), [key(c), key(`${APP}/d.txt`)], 'in the order they were refused, the stat answered neither');
    // A descriptor's awaited read is the program's content read too.
    const opened = await e.fs.open(c, { read: true });
    assert.equal(text(await e.fs.read(opened.id, 0, 8)), 'C');
    await e.fs.close(opened.id);
    assert.deepEqual(await e.fs.misses(), [key(`${APP}/d.txt`)]);
  },

  async 'a refused stat is no miss; a refused read of the bytes on a mount the session answers is, until its awaited read'() {
    const plain = new MemoryVFS();
    plain.writeFile('/a', enc.encode('PLAIN'));
    // A mount that states no change model: only the session answers for it.
    const unfed = new Proxy(plain, { get: (target, name) => (name === 'changes' ? undefined : Reflect.get(target, name, target)) });
    const { e, told } = await boot({ seed(authority) { authority.files.vfs.mount('/mnt/plain', unfed); } });
    assert.throws(() => e.sync.stat('/mnt/plain/a'), { code: 'EAGAIN' });
    assert.throws(() => e.sync.stat('/mnt/plain/none'), { code: 'EAGAIN' });
    assert.deepEqual(await e.fs.misses(), [], 'what a name is, refused, reads no bytes');
    assert.throws(() => e.sync.readFile('/mnt/plain/a'), { code: 'EAGAIN' });
    assert.throws(() => e.sync.readFile('/mnt/plain/a'), { code: 'EAGAIN' });
    assert.deepEqual(told, ['mnt/plain/a'], 'a read refused twice is one miss');
    assert.deepEqual(await e.fs.misses(), ['mnt/plain/a']);
    assert.equal(Number((await e.fs.stat('/mnt/plain/a')).size), 5);
    assert.deepEqual(await e.fs.misses(), ['mnt/plain/a'], 'an awaited stat does not answer the read of its bytes');
    assert.equal(text(await e.fs.readFile('/mnt/plain/a')), 'PLAIN');
    assert.deepEqual(await e.fs.misses(), []);
  },

  async 'a miss the view comes to know absent is retired'() {
    const fetches = parked('fsReadBatch');
    const { e } = await boot({ files: { 'gone.txt': 'GONE' }, supervise: fetches.supervise });
    const gone = `${APP}/gone.txt`;
    assert.equal(syncRead(e, gone), 'EAGAIN');
    await sleep(0);
    assert.equal(fetches.waiting, 1, 'its fault-in is out');
    await e.authority.peer.unlink('home/user/app/gone.txt');
    fetches.release();
    await e.input();
    assert.equal(await e.fs.stat(gone), null, 'the view knows it is gone');
    assert.deepEqual(await e.fs.misses(), [], 'the authority proved it absent');
  },

  async 'one fault-in per file, and the misses of one turn fetched together'() {
    const NAMES = ['f0.js', 'f1.js', 'f2.js', 'f3.js', 'f4.js'];
    const batches = readBatches();
    const { e, told } = await boot({ files: Object.fromEntries(NAMES.map((name) => [name, `export default '${name}';`])), supervise: batches.supervise });
    batches.asked.length = 0;
    for (const name of NAMES) for (let i = 0; i < 3; i++) assert.equal(syncRead(e, `${APP}/${name}`), 'EAGAIN');
    assert.deepEqual(told, NAMES.map((name) => `home/user/app/${name}`), 'each told once');
    await e.fs.misses();
    assert.deepEqual(batches.asked, [NAMES.map((name) => `home/user/app/${name}`)], 'fifteen refusals, one fetch of the five files');
    for (const name of NAMES) assert.equal(syncRead(e, `${APP}/${name}`), `export default '${name}';`);
    assert.equal((await e.fs.stats()).faultIns, NAMES.length);
  },

  async 'a read of a file whose fault-in is out joins it'() {
    const fetches = parked('fsReadBatch');
    const batches = readBatches();
    const { e } = await boot({
      files: { 'j.txt': 'JOINED' },
      supervise: { fsReadBatch: (call, args) => fetches.supervise.fsReadBatch((asked) => batches.supervise.fsReadBatch(call, asked), args) },
    });
    batches.asked.length = 0;
    const j = `${APP}/j.txt`;
    assert.equal(syncRead(e, j), 'EAGAIN');
    await sleep(0);
    assert.equal(fetches.waiting, 1);
    const awaited = e.fs.readFile(j);
    assert.equal(syncRead(e, j), 'EAGAIN', 'refused again while it is out');
    await sleep(5);
    fetches.release();
    assert.equal(text(await awaited), 'JOINED');
    assert.deepEqual(batches.asked, [[key(j)]], 'one fetch: the awaited read and the second miss joined the first');
  },

  async 'a fault-in that did not land is asked again by the next miss'() {
    let failing = 1;
    const { e } = await boot({
      files: { 'r.txt': 'RETRIED' },
      supervise: {
        fsReadBatch: async (call, args) => {
          if (failing-- > 0) throw new Error('Network connection lost.');
          return call(args);
        },
      },
    });
    const r = `${APP}/r.txt`;
    assert.equal(syncRead(e, r), 'EAGAIN');
    await e.fs.misses();
    assert.equal(syncRead(e, r), 'EAGAIN', 'the first fetch did not land');
    await e.fs.misses();
    assert.equal(syncRead(e, r), 'RETRIED', 'the second miss asked again, and it landed');
  },

  async 'fault-ins land in a store at its cap, its room asked of the ledger together'() {
    const NAMES = Array.from({ length: 100 }, (_, i) => `locale-${i}.js`);
    const grants = [];
    const { e } = await boot({
      files: Object.fromEntries(NAMES.map((name) => [name, `export default ${JSON.stringify(name.repeat(40))};`])),
      ledger: true,
      supervise: {
        // The session's ledger: what is asked, after a turn.
        fsStorageGrant: async (_call, [, want]) => {
          await sleep(1);
          grants.push(want);
          return { granted: want };
        },
      },
    });
    for (const name of NAMES) assert.equal(syncRead(e, `${APP}/${name}`), 'EAGAIN');
    await e.fs.misses();
    const unread = NAMES.filter((name) => syncRead(e, `${APP}/${name}`) !== `export default ${JSON.stringify(name.repeat(40))};`);
    assert.deepEqual(unread, [], `every fault-in landed in the full store (${grants.length} grants)`);
    assert.ok(grants.length >= 1 && grants.length <= 4, `the batch's room took ${grants.length} asks of the ledger`);
  },

  async 'fault-ins a ledger refuses settle, and stay misses'() {
    const NAMES = Array.from({ length: 20 }, (_, i) => `refused-${i}.js`);
    const { e } = await boot({
      files: Object.fromEntries(NAMES.map((name) => [name, name.repeat(50)])),
      ledger: true,
      supervise: { fsStorageGrant: async () => ({ granted: 0 }) },
    });
    for (const name of NAMES) assert.equal(syncRead(e, `${APP}/${name}`), 'EAGAIN');
    const left = await Promise.race([e.fs.misses(), sleep(5_000).then(() => 'waiting')]);
    assert.deepEqual(left, NAMES.map((name) => `home/user/app/${name}`), 'nothing waits for room that will not come');
    for (const name of NAMES) assert.equal(syncRead(e, `${APP}/${name}`), 'EAGAIN');
  },

  async 'the run\'s end waits for the fault-ins in flight'() {
    const fetches = parked('fsReadBatch');
    const { e } = await boot({ files: { 'end.txt': 'END' }, supervise: fetches.supervise });
    assert.equal(syncRead(e, `${APP}/end.txt`), 'EAGAIN');
    await sleep(0);
    let settled = false;
    const ending = e.fs.settle().then((failures) => { settled = true; return failures; });
    await sleep(20);
    assert.equal(settled, false, 'settled with a fault-in out');
    fetches.release();
    assert.deepEqual(await ending, []);
    assert.equal(syncRead(e, `${APP}/end.txt`), 'END');
  },

  async 'a miss under a speculation is its own, its fill charged before it is issued'() {
    const { e, told, under } = await boot({ files: { 'mod.js': 'export {};', 'data.json': '{"a":1}' } });
    const mod = `${APP}/mod.js`;
    const record = speculationRecord();
    under(record, () => assert.equal(syncRead(e, mod), 'EAGAIN'));
    assert.deepEqual(record.misses, [key(mod)]);
    assert.deepEqual(record.charged, { files: 1, bytes: 'export {};'.length }, 'one file, its size, charged before it is read');
    assert.equal(await record.fetches.get(key(mod)), true, 'its fetch says it landed');
    assert.equal(syncRead(e, mod), 'export {};');
    assert.deepEqual(told, [], 'the program was told of nothing');
    assert.deepEqual(await e.fs.misses(), [], 'nor is it the program\'s miss');
    // The program's own miss is its own, speculation or not before it.
    assert.equal(syncRead(e, `${APP}/data.json`), 'EAGAIN');
    assert.deepEqual(await e.fs.misses(), [key(`${APP}/data.json`)]);
  },

  async 'past a speculation\'s quota nothing is issued, and the program\'s own miss still fetches'() {
    const NAMES = ['q0.js', 'q1.js', 'q2.js', 'q3.js', 'q4.js'];
    const batches = readBatches();
    const { e, under } = await boot({ files: Object.fromEntries(NAMES.map((name) => [name, `// ${name}`])), supervise: batches.supervise });
    batches.asked.length = 0;
    const record = speculationRecord({ files: 2 });
    under(record, () => { for (const name of NAMES) assert.equal(syncRead(e, `${APP}/${name}`), 'EAGAIN'); });
    assert.deepEqual(record.misses, NAMES.map((name) => `home/user/app/${name}`), 'each refusal is the speculation\'s');
    assert.deepEqual([...record.fetches.keys()], ['home/user/app/q0.js', 'home/user/app/q1.js'], 'two fetches within the quota');
    await Promise.all(record.fetches.values());
    await e.fs.misses();
    assert.deepEqual(batches.asked.flat().sort(), ['home/user/app/q0.js', 'home/user/app/q1.js'], 'none past it was asked for');
    assert.equal(syncRead(e, `${APP}/q2.js`), 'EAGAIN', 'the program\'s own read of one past it');
    await e.fs.misses();
    assert.equal(syncRead(e, `${APP}/q2.js`), '// q2.js', 'faults it in');
  },

  async 'a speculation\'s bytes are charged before they are read'() {
    const body = 'é'.repeat(2000);
    const batches = readBatches();
    const { e, under } = await boot({ files: { 'heavy-a.js': body, 'heavy-b.js': body, 'heavy-c.js': body }, supervise: batches.supervise });
    batches.asked.length = 0;
    const record = speculationRecord({ bytes: 10_000 });
    under(record, () => { for (const name of ['heavy-a.js', 'heavy-b.js', 'heavy-c.js']) syncRead(e, `${APP}/${name}`); });
    assert.deepEqual(record.charged, { files: 2, bytes: 8_000 }, 'raw bytes: 4,000 a file, the third past 10,000');
    await Promise.all(record.fetches.values());
    assert.ok(!batches.asked.flat().includes('home/user/app/heavy-c.js'), 'the third file\'s bytes were never read');
  },

  async 'a speculation joins a fault-in already out, uncharged'() {
    const fetches = parked('fsReadBatch');
    const { e, under } = await boot({ files: { 'shared.js': 'shared' }, supervise: fetches.supervise });
    const shared = `${APP}/shared.js`;
    assert.equal(syncRead(e, shared), 'EAGAIN');
    await sleep(0);
    const record = speculationRecord();
    under(record, () => assert.equal(syncRead(e, shared), 'EAGAIN'));
    assert.deepEqual(record.charged, { files: 0, bytes: 0 }, 'a joined fetch is not charged');
    assert.ok(record.fetches.has(key(shared)), 'it has the fetch it joined');
    fetches.release();
    assert.equal(await record.fetches.get(key(shared)), true);
    assert.equal(syncRead(e, shared), 'shared');
    assert.deepEqual(await e.fs.misses(), [key(shared)], 'the program\'s miss is still its own');
  },

  async 'a file over 8 MiB is read whole by an awaited read, and held'() {
    const big = Uint8Array.from({ length: WASI_RESIDENT_FILE_CAP_BYTES + 1024 * 1024 }, (_, i) => (i * 7) & 255);
    const { e } = await boot({ seed(authority) { authority.kfs.writeFile('home/user/app/big.bin', big); } });
    const path = `${APP}/big.bin`;
    assert.ok(Buffer.from(await e.fs.readFile(path)).equals(Buffer.from(big)), 'the awaited read answers it whole');
    const held = e.sync.readFile(path);
    assert.ok(Buffer.from(held).equals(Buffer.from(big)), 'a synchronous read after it answers from the store');
  },

  async 'a refused read of a file over 8 MiB faults it in'() {
    const big = Uint8Array.from({ length: WASI_RESIDENT_FILE_CAP_BYTES + 64 * 1024 }, (_, i) => (i * 13) & 255);
    const { e } = await boot({ seed(authority) { authority.kfs.writeFile('home/user/app/big.bin', big); } });
    const path = `${APP}/big.bin`;
    assert.throws(() => e.sync.readFile(path), { code: 'EAGAIN' });
    await e.fs.misses();
    assert.ok(Buffer.from(e.sync.readFile(path)).equals(Buffer.from(big)), 'the next synchronous read answers it');
  },

  async 'a file the store cannot hold, past what one RPC carries, is read whole by an awaited read'() {
    const huge = Uint8Array.from({ length: MAX_RPC_SAFE_PAYLOAD_BYTES + 1024 * 1024 }, (_, i) => (i * 31) & 255);
    const { e } = await boot({
      ledger: true,
      seed(authority) { authority.kfs.writeFile('home/user/app/huge.bin', huge); },
      supervise: { fsStorageGrant: async () => ({ granted: 0 }) },
    });
    const read = await e.fs.readFile(`${APP}/huge.bin`);
    assert.equal(read.byteLength, huge.byteLength);
    assert.ok(Buffer.from(read).equals(Buffer.from(huge)), 'its bytes, whole');
  },

  async 'without residency (a WASI program\'s), a refused read leaves nothing: no record, no fetch'() {
    const e = await bootEngine('eager', { seed(authority) { authority.kfs.writeFile('home/user/app/w.txt', 'W'); } });
    const before = await e.fs.stats();
    assert.equal(syncRead(e, `${APP}/w.txt`), 'EAGAIN');
    await sleep(20);
    const after = await e.fs.stats();
    assert.equal(after.sessionCalls, before.sessionCalls, 'nothing was asked of the session');
    assert.equal(after.faultIns, 0);
    assert.deepEqual(await e.fs.misses(), []);
  },
});
