#!/usr/bin/env bun
/**
 * resident-view-eager — the store's one view (vfs/resident/view.ts) over a
 * namespace enumerated at boot, as the resident filesystem reads it (Node's,
 * once it runs on that filesystem), and the one barrier both kinds share:
 *
 * - a name the enumeration did not list is absent, both ways;
 * - while a directory's relist is on its way, nothing at or under it is
 *   answered: no row it held, no absence;
 * - every barrier waits on the refetches in flight when it began, so a call
 *   that cannot wait right after it reads a file's new bytes;
 * - an answer a delivery carried stands in only from a cursor the store has
 *   reached, and only if the process made no change at the session since
 *   its arguments were built;
 * - a fill a delta outdated while it was asked installs nothing;
 * - the arguments a delivery answers carry the process's own debt through
 *   the session's parse;
 * - a directory a mount left unlisted, and one a lookup or listing learned,
 *   is not whole until a listing of it named its entries;
 * - a barrier that cannot apply its answer repairs the store: from its
 *   floor, or by listing again and fetching only what changed; one that
 *   cannot list serves no old bytes, and stays owed;
 * - under a trusted read lease, input alone takes no barrier; the process's
 *   own change at the session, or a repair owed, does.
 */

import assert from 'node:assert/strict';
import * as rpc from '../../packages/worker/src/session/rpc.ts';
import { createAuthority, runScenarios, sleep } from './lib/resident-body.mjs';
import { ROOT, k, storeSession } from './lib/store-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What a call that cannot wait answers: its value (bytes as text), or its error's code. */
function synchronously(fs, path, op = 'stat') {
  try {
    const value = fs.synchronous[op](path);
    return op === 'readFile' && value ? dec.decode(value) : value;
  } catch (error) { return error?.code ?? String(error?.message ?? error); }
}
const landsWithin = (work, ms) => Promise.race([work.then(() => true), sleep(ms).then(() => false)]);

await runScenarios(import.meta.path, {
  async 'an enumerated namespace answers a name it did not list as absent, both ways'() {
    const s = await storeSession({ d: null, 'd/f': 'f' }, { eager: true });
    assert.equal(s.view.ready(), true);
    assert.equal(synchronously(s.fs, k('d/nope')), null);
    assert.equal(await s.fs.stat(k('d/nope')), null);
    assert.equal(synchronously(s.fs, k('d/f')).size, 1);
    assert.deepEqual(s.fs.synchronous.readdir(k('d')).map((entry) => entry.name), ['f']);
  },
  async 'while a directory is relisted, nothing under it is answered'() {
    const s = await storeSession({ d: null, 'd/f': 'f' }, { eager: true });
    assert.equal(synchronously(s.fs, k('d/f')).size, 1);
    // Closed to the process, then opened again: the barrier relists it.
    await s.kernel.chown(k('d'), 0, 0);
    await s.kernel.chmod(k('d'), 0o700);
    await s.fs.catchUp();
    assert.equal(synchronously(s.fs, k('d/f')), 'EACCES');
    await s.kernel.chmod(k('d'), 0o755);
    const asked = s.hold('fsList');
    const barrier = s.fs.catchUp();
    await asked();
    assert.equal(synchronously(s.fs, k('d/f')), 'EAGAIN', 'a name the directory holds, while its relist is on its way');
    assert.equal(synchronously(s.fs, k('d/nope')), 'EAGAIN', 'nor is an absence answered there');
    s.release('fsList');
    await barrier;
    assert.equal(synchronously(s.fs, k('d/f')).size, 1, 'once the relist landed');
  },
  async 'every barrier waits on the refetches in flight when it began'() {
    const s = await storeSession({ f: 'one', other: 'o' }, { eager: true });
    assert.equal(dec.decode(await s.fs.readFile(k('f'))), 'one');
    assert.equal(synchronously(s.fs, k('f'), 'readFile'), 'one', 'held');
    await s.kernel.writeFile(k('f'), enc.encode('two!'));
    const asked = s.hold('fsReadBatch');
    const first = s.fs.catchUp();
    await asked();
    // A second barrier whose delta drops nothing still waits for the first's refetch.
    const second = s.fs.catchUp();
    assert.equal(await landsWithin(second, 300), false, 'the second barrier waits on the refetch in flight');
    s.release('fsReadBatch');
    await Promise.all([first, second]);
    assert.equal(synchronously(s.fs, k('f'), 'readFile'), 'two!', 'the new bytes, at once');
  },
  async 'an answer a delivery carried stands in only from a cursor the store has reached'() {
    const s = await storeSession({ f: 'one' }, { eager: true });
    const reached = s.fs.acquireArgs();
    await s.kernel.writeFile(k('g'), enc.encode('g'));
    const ahead = { ...reached, cursor: reached.cursor + 1_000 };
    const fromAhead = await s.authority.acquire(reached.epoch, reached.cursor, { namespace: true });
    let asked = s.calls.fsAcquire ?? 0;
    await s.fs.catchUp({ delivered: { args: ahead, answer: fromAhead } });
    assert.equal(s.calls.fsAcquire, asked + 1, 'one from ahead of the store asks again');
    assert.notEqual(synchronously(s.fs, k('g')), null);
    const args = s.fs.acquireArgs();
    await s.kernel.writeFile(k('h'), enc.encode('h'));
    const answer = await s.authority.acquire(args.epoch, args.cursor, { namespace: true });
    asked = s.calls.fsAcquire;
    await s.fs.catchUp({ delivered: { args, answer } });
    assert.equal(s.calls.fsAcquire, asked, 'one from the store\'s own cursor stands in');
    assert.notEqual(synchronously(s.fs, k('h')), null);
  },
  async 'an answer a delivery carried does not stand in for a change the process made since'() {
    const s = await storeSession({ f: 'one' }, { eager: true });
    const args = s.fs.acquireArgs();
    const answer = await s.authority.acquire(args.epoch, args.cursor, { namespace: true });
    await s.fs.chmod(k('f'), 0o600);
    const asked = s.calls.fsAcquire ?? 0;
    await s.fs.catchUp({ delivered: { args, answer } });
    assert.equal(s.calls.fsAcquire, asked + 1, 'the barrier asks again');
    assert.equal(synchronously(s.fs, k('f')).mode & 0o777, 0o600);
  },
  async 'a fill a delta outdated while it was asked installs nothing'() {
    const s = await storeSession({ f: 'one!', other: 'o' }, { eager: true });
    const asked = s.hold('fsReadBatch');
    const read = s.fs.readFile(k('f'));
    await asked();
    await s.kernel.writeFile(k('f'), enc.encode('two!!'));
    await s.fs.catchUp();
    s.release('fsReadBatch');
    await read;
    assert.notEqual(synchronously(s.fs, k('f'), 'readFile'), 'one!', 'never the bytes the delta outdated');
  },
  async 'a name under a directory a mount left unlisted is unknown until the directory is listed'() {
    const s = await storeSession({ m: null, 'm/f': 'f', 'm/d': null, 'm/d/x': 'x' }, { eager: true, unlisted: ['m'] });
    assert.equal(synchronously(s.fs, k('m/f')), 'EAGAIN', 'a name the mount holds');
    assert.equal(synchronously(s.fs, k('m/nope')), 'EAGAIN', 'nor an absence there');
    assert.equal((await s.fs.stat(k('m/f'))).size, 1, 'an awaited stat looks it up');
    assert.equal(synchronously(s.fs, k('m/nope')), 'EAGAIN', 'a lookup lists nothing');
    // Its own entries named (a directory's listing, not a tree's).
    assert.equal(await s.view.list(`${ROOT}/m`), true);
    assert.equal(synchronously(s.fs, k('m/nope')), null, 'once listed, a name it did not name is absent');
    assert.equal(synchronously(s.fs, k('m/d/x')), 'EAGAIN', 'a directory its listing learned is not whole');
    assert.equal(await s.view.list(`${ROOT}/m`), true);
    assert.equal(synchronously(s.fs, k('m/d/x')), 'EAGAIN', 'nor after another listing of its parent');
    assert.equal(await s.view.list(`${ROOT}/m/d`), true);
    assert.equal(synchronously(s.fs, k('m/d/nope')), null, 'until it is listed itself');
    assert.equal(synchronously(s.fs, k('m/d/x')).size, 1);
  },
  async 'a tree listing under a mount is whole'() {
    const s = await storeSession({ m: null, 'm/d': null, 'm/d/x': 'x' }, { eager: true, unlisted: ['m'] });
    assert.equal(await s.view.listTree(`${ROOT}/m`), true);
    assert.equal(synchronously(s.fs, k('m/d/nope')), null);
    assert.equal(synchronously(s.fs, k('m/d/x')).size, 1);
  },
  async 'a directory a lookup learned under a mount is not whole'() {
    const s = await storeSession({ m: null, 'm/d': null, 'm/d/x': 'x' }, { eager: true, unlisted: ['m'] });
    assert.equal((await s.fs.stat(k('m/d/x'))).size, 1);
    assert.equal(synchronously(s.fs, k('m/d/nope')), 'EAGAIN');
    assert.equal(synchronously(s.fs, k('m/nope')), 'EAGAIN');
  },
  async 'a barrier with no answer repairs from the store\'s floor, listing nothing'() {
    const s = await storeSession({ f: 'one' }, { eager: true });
    await s.kernel.writeFile(k('g'), enc.encode('g'));
    const listings = s.calls.fsList ?? 0;
    s.fail('fsAcquire');
    await s.fs.catchUp();
    assert.equal(s.calls.fsList ?? 0, listings, 'no listing');
    assert.equal(s.view.repairOwed(), false);
    assert.equal(synchronously(s.fs, k('g')).size, 1);
  },
  async 'a poison repairs by listing again, fetching only what changed'() {
    const s = await storeSession({ f: 'one', g: 'two' }, { eager: true });
    assert.equal(dec.decode(await s.fs.readFile(k('f'))), 'one');
    assert.equal(dec.decode(await s.fs.readFile(k('g'))), 'two');
    await s.kernel.writeFile(k('g'), enc.encode('TWO'));
    const before = s.reads.length;
    s.poison();
    await s.fs.catchUp();
    const read = s.reads.slice(before).flat();
    const named = (name) => read.some((path) => path.replace(/^\//, '') === `${ROOT}/${name}`);
    assert.ok(named('g'), `the changed file is fetched: ${JSON.stringify(s.reads.slice(before))}`);
    assert.ok(!named('f'), 'the unchanged one is not');
    assert.equal(synchronously(s.fs, k('g'), 'readFile'), 'TWO');
    assert.equal(synchronously(s.fs, k('f'), 'readFile'), 'one');
  },
  async 'a repair that cannot list serves no old bytes, and stays owed until one can'() {
    const s = await storeSession({ f: 'one' }, { eager: true });
    assert.equal(dec.decode(await s.fs.readFile(k('f'))), 'one');
    await s.kernel.writeFile(k('f'), enc.encode('two'));
    s.poison();
    // The repair lists, and lists once more: both fail.
    s.fail('fsList', 2);
    await s.fs.catchUp();
    assert.notEqual(synchronously(s.fs, k('f'), 'readFile'), 'one', 'never the old bytes');
    assert.equal(s.view.repairOwed(), true);
    await s.fs.catchUp();
    assert.equal(s.view.repairOwed(), false);
    assert.notEqual(synchronously(s.fs, k('f'), 'readFile'), 'one', 'a colder cache, never a stale byte');
    assert.equal(dec.decode(await s.fs.readFile(k('f'))), 'two');
  },
  async 'a barrier that joined a repair asks again'() {
    const s = await storeSession({ f: 'one' }, { eager: true });
    s.poison();
    const listing = s.hold('fsList');
    const first = s.fs.catchUp();
    await listing();
    await s.kernel.writeFile(k('g'), enc.encode('g'));
    s.fs.inbound();
    const asked = s.calls.fsAcquire;
    const second = s.view.barrier();
    await sleep(20);
    s.release('fsList');
    await Promise.all([first, second]);
    assert.ok(s.calls.fsAcquire > asked, 'the joiner asked after the repair');
    assert.equal(synchronously(s.fs, k('g')).size, 1);
  },
  async 'a fill asked before a poison installs nothing'() {
    const s = await storeSession({ f: 'one!', other: 'o' }, { eager: true });
    const asked = s.hold('fsReadBatch');
    const read = s.fs.readFile(k('f'));
    await asked();
    await s.kernel.writeFile(k('f'), enc.encode('two!!'));
    s.poison();
    await s.fs.catchUp();
    s.release('fsReadBatch');
    await read;
    assert.notEqual(synchronously(s.fs, k('f'), 'readFile'), 'one!', 'never the bytes from before the repair');
  },
  async 'a fill asked before a repair began installs nothing, landing while the repair lists'() {
    const enc = new TextEncoder();
    const s = await storeSession({ f: 'one!', other: 'o' }, { eager: true });
    for (let i = 0; i < 40; i++) await s.kernel.writeFile(k('other'), enc.encode(`o${i}`));
    await s.kernel.writeFile(k('f'), enc.encode('two!'));
    await s.fs.catchUp();
    const fill = s.hold('fsReadBatch');
    const read = s.fs.readFile(k('f'));
    await fill();
    // The session starts again: its revisions far below the first incarnation's.
    await s.incarnate({ f: 'new!', other: 'o' });
    const listing = s.hold('fsList');
    const barrier = s.fs.catchUp();
    await listing();
    s.release('fsReadBatch');
    await read.catch(() => undefined);
    s.release('fsList');
    await barrier;
    assert.notEqual(synchronously(s.fs, k('f'), 'readFile'), 'two!', 'never the first incarnation\'s bytes');
    assert.equal(dec.decode(await s.fs.readFile(k('f'))), 'new!');
  },
  async 'under a trusted read lease, input alone takes no barrier'() {
    const s = await storeSession({ f: 'one' }, { eager: true, delegated: true });
    await s.fs.catchUp();
    const asked = s.calls.fsAcquire;
    await s.fs.catchUp({ viaIo: true });
    assert.equal(s.calls.fsAcquire, asked, 'no ACQUIRE');
    assert.equal(s.fs.stats().leasedBarriers, 1);
  },
  async 'under a trusted read lease, the process\'s own change at the session takes the barrier'() {
    const s = await storeSession({ f: 'one' }, { eager: true, delegated: true });
    await s.fs.catchUp();
    await s.fs.chmod(k('f'), 0o600);
    const asked = s.calls.fsAcquire;
    await s.fs.catchUp({ viaIo: true });
    assert.equal(s.calls.fsAcquire, asked + 1, 'an ACQUIRE');
    assert.equal(synchronously(s.fs, k('f')).mode & 0o777, 0o600);
  },
  async 'under a trusted read lease, a repair owed takes the barrier'() {
    const s = await storeSession({ f: 'one' }, { eager: true, delegated: true });
    await s.fs.catchUp();
    s.poison();
    // The repair lists, and lists once more: both fail.
    s.fail('fsList', 2);
    await s.fs.catchUp();
    assert.equal(s.view.repairOwed(), true);
    const asked = s.calls.fsAcquire;
    await s.fs.catchUp({ viaIo: true });
    assert.ok(s.calls.fsAcquire > asked, 'the repair asks');
    assert.equal(s.view.repairOwed(), false);
  },
  async 'a delivery\'s arguments keep the process\'s own debt through the session\'s parse'() {
    const authority = createAuthority();
    const acquired = await rpc._acquireOnDelivery(authority.host, { epoch: authority.rawVfs.epoch, cursor: authority.rawVfs.revision(), begin: 4, own: 3 });
    assert.equal(acquired.args.begin, 4);
    assert.equal(acquired.args.own, 3);
  },
});
