#!/usr/bin/env bun
/**
 * resident-store-learned-names — what a process's store learned of the
 * session's names stays what the session holds, when the session's replies
 * land late or a peer changes what the store already learned:
 *
 * - a lookup's reply, asked before a peer removed the file and landing after
 *   a barrier admitted the removal, never brings the file back; nor does a
 *   listing's;
 * - nor does either stand in for what a peer's rename put at the name, or
 *   hide a name a rename brought into the directory; nor a tree listing's;
 *   nor one asked before the namespace started again;
 * - a listing is of a directory as it was at one moment: one whose names and
 *   stats straddle a peer's rename is not installed, nor is a directory a
 *   peer moved away listed as an empty one;
 * - a name the store learned under a directory a peer replaced is not
 *   served once the barrier admitted the replacement, on either engine.
 *
 * The first ones run the resident filesystem (core
 * runtime/wasi/resident-filesystem.ts) over a store listed on demand, as a
 * WASI process has it (lib/store-session.mjs).
 */

import assert from 'node:assert/strict';
import { runScenarios, sleep } from './lib/resident-body.mjs';
import { APP, ENGINES, bootEngine } from './lib/guest-engines.mjs';
import { ROOT, k, storeSession } from './lib/store-session.mjs';


/** What a call that cannot wait reads of `path`: its stat, null where nothing is, or 'EAGAIN' where the view cannot say (one listed on demand may refuse a name it does not know). */
function synchronously(fs, path) {
  try { return fs.synchronous.stat(path); }
  catch (error) { if (error?.code === 'EAGAIN') return 'EAGAIN'; throw error; }
}
function notServed(fs, path, what) {
  const seen = synchronously(fs, path);
  assert.ok(seen === null || seen === 'EAGAIN', `${what}: served ${JSON.stringify(seen)}`);
}

/** `path` is the file the peer's rename put there, and nothing answers with the one it replaced. */
async function renamedOnto(s, path) {
  const moved = (await s.kernel.stat(k(path))).ino;
  const seen = synchronously(s.fs, k(path));
  assert.ok(seen === 'EAGAIN' || seen?.ino === moved, `what a call that cannot wait reads of it: ${JSON.stringify(seen)}`);
  assert.equal((await s.fs.stat(k(path))).ino, moved, 'what an awaited stat reads of it');
  assert.equal(new TextDecoder().decode(await s.fs.readFile(k(path))), 'new', 'its bytes');
}

/** A barrier admits a peer's `change` (by default, removing `d/f`) while `learning` (begun before it, `d` known) waits on its parked `reply` (by default, its lstat batch); then it lands. */
async function lateLearning(tree, learning, { change = (kernel) => kernel.unlink(k('d/f')), reply = 'fsReadBatch' } = {}) {
  const s = await storeSession(tree);
  assert.equal((await s.fs.stat(k('d'))).type, 'directory');
  const asked = s.hold(reply);
  const first = learning(s);
  await asked();
  await change(s.kernel);
  s.fs.inbound();
  const barrier = s.fs.stat(k('other'));
  const landed = await Promise.race([barrier.then(() => true), sleep(1_000).then(() => false)]);
  s.release(reply);
  await first;
  await barrier;
  assert.ok(landed, 'the barrier landed while the learning waited on its reply');
  return s;
}

const scenarios = {
  async 'a late lookup reply never brings back a file a barrier saw removed'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', other: 'o' }, (s) => s.fs.stat(k('d/f')));
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
  },
  async 'a late listing never brings back a file a barrier saw removed'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', 'd/g': 'g', other: 'o' }, (s) => s.view.list(`${ROOT}/d`));
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
    assert.deepEqual((await s.fs.readdir(k('d'))).map((entry) => entry.name).sort(), ['g'], 'the directory');
  },
  async 'a late lookup never stands in for the file a peer renamed onto its name'() {
    const s = await lateLearning({ d: null, 'd/f': 'old', 'd/n': 'new', other: 'o' }, (s) => s.fs.stat(k('d/f')),
      { change: (kernel) => kernel.rename(k('d/n'), k('d/f')) });
    await renamedOnto(s, 'd/f');
  },
  async 'a late lookup never stands in for what a peer renamed onto the directory above it'() {
    const s = await lateLearning({ d: null, 'd/f': 'old', x: null, 'x/f': 'new', other: 'o' }, (s) => s.fs.stat(k('d/f')),
      { change: async (kernel) => { await kernel.rename(k('d'), k('d-old')); await kernel.rename(k('x'), k('d')); } });
    await renamedOnto(s, 'd/f');
  },
  async 'a late listing never hides a name a peer renamed into the directory'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', 'd/n': 'n', other: 'o' }, (s) => s.view.list(`${ROOT}/d`),
      { change: (kernel) => kernel.rename(k('d/n'), k('d/e')) });
    const moved = (await s.kernel.stat(k('d/e'))).ino;
    const seen = synchronously(s.fs, k('d/e'));
    assert.ok(seen === 'EAGAIN' || seen?.ino === moved, `what a call that cannot wait reads of the name the rename brought: ${JSON.stringify(seen)}`);
    notServed(s.fs, k('d/n'), 'what a call that cannot wait reads of the name the rename took away');
    assert.equal((await s.fs.stat(k('d/e'))).ino, moved, 'the name the rename brought');
    assert.equal(await s.fs.stat(k('d/n')), null, 'the name the rename took away');
    assert.deepEqual((await s.fs.readdir(k('d'))).map((entry) => entry.name).sort(), ['e', 'f'], 'the directory');
  },
  async 'a late tree listing never brings back a file a barrier saw removed'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', 'd/g': 'g', other: 'o' }, (s) => s.view.listTree(`${ROOT}/d`), { reply: 'fsListTree' });
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
    assert.deepEqual((await s.fs.readdir(k('d'))).map((entry) => entry.name).sort(), ['g'], 'the directory');
  },
  async 'a lookup asked before the namespace started again installs nothing'() {
    const s = await storeSession({ d: null, 'd/f': 'f', other: 'o' });
    assert.equal((await s.fs.stat(k('d'))).type, 'directory');
    const asked = s.hold('fsReadBatch');
    const first = s.fs.stat(k('d/f'));
    await asked();
    await s.kernel.unlink(k('d/f'));
    // A poison: the namespace starts again from nothing at the authority's cursor.
    s.poison();
    assert.equal((await s.view.barrier()).landed, true);
    s.release('fsReadBatch');
    await first;
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
  },
  async 'a listing whose names and stats straddle a peer\'s rename installs nothing'() {
    const s = await storeSession({ d: null, 'd/f': 'f', 'd/g': 'g' });
    assert.equal((await s.fs.stat(k('d'))).type, 'directory');
    const asked = s.hold('readdir');
    const listing = s.view.list(`${ROOT}/d`);
    await asked();
    await s.kernel.rename(k('d/g'), k('d/h'));
    s.release('readdir');
    assert.equal(await listing, false, 'its names were the directory\'s before the rename, its stats after');
    assert.deepEqual((await s.fs.readdir(k('d'))).map((entry) => entry.name).sort(), ['f', 'h'], 'the directory');
  },
  async 'a tree listing of a directory a peer moved away is not an empty directory'() {
    const s = await storeSession({ d: null, 'd/f': 'f' });
    assert.equal((await s.fs.stat(k('d'))).type, 'directory');
    await s.kernel.rename(k('d'), k('z'));
    assert.equal(await s.view.listTree(`${ROOT}/d`), false, 'nothing is listed at a name that is not there');
    await assert.rejects(async () => s.fs.readdir(k('d')), (error) => error.code === 'ENOENT', 'the directory');
  },
  async 'a learned name under a directory a peer made unsearchable is refused after the barrier'() {
    const s = await storeSession({ d: null, 'd/f': 'f', other: 'o' });
    assert.notEqual(await s.fs.stat(k('d/f')), null);
    await s.kernel.chown(k('d'), 2000, 2000);
    await s.kernel.chmod(k('d'), 0o700);
    s.fs.inbound();
    await s.fs.stat(k('other'));
    await assert.rejects(async () => s.fs.stat(k('d/f')), (error) => error.code === 'EACCES');
  },
};
for (const kind of ENGINES) {
  scenarios[`a learned name under a directory a peer replaced is gone after the barrier [${kind}]`] = async () => {
    const engine = await bootEngine(kind, {
      seed: (authority) => {
        for (const dir of ['d', 'x']) authority.kfs.mkdir(`home/user/app/${dir}`, { mode: 0o755 });
        authority.kfs.writeFile('home/user/app/d/f', 'f');
        authority.kfs.writeFile('home/user/app/x/g', 'g');
      },
    });
    assert.notEqual(await engine.stat(`${APP}/d/f`), null);
    await engine.authority.peer.rename('home/user/app/d', 'home/user/app/d-old');
    await engine.authority.peer.rename('home/user/app/x', 'home/user/app/d');
    await engine.input();
    let seen;
    try { seen = engine.sync.stat(`${APP}/d/f`); } catch (error) { seen = error?.code; }
    assert.ok(seen === null || (kind === 'holder' && seen === 'EAGAIN'), `what a call that cannot wait reads of the old directory's file: ${JSON.stringify(seen)}`);
    assert.equal(await engine.stat(`${APP}/d/f`), null, 'the old directory\'s file, under the new one');
    assert.notEqual(await engine.stat(`${APP}/d/g`), null, 'the new directory\'s file');
  };
}

await runScenarios(import.meta.path, scenarios);
