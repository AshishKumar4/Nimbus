#!/usr/bin/env bun
// The resident filesystem's synchronous view (ResidentFilesystem.synchronous,
// VFS-9 B stage 3): every call answers now, from what the process holds, or
// is refused before it begins anything. A refusal is EAGAIN (not resident)
// or the name's own state where the view knows it; never a promise; and it
// leaves nothing: no session call made or begun, no wave, no log entry, no
// barrier, nothing held.
//
// Red before: the synchronous view was the session's own (the authority's),
// which reads past what this process holds, and a call that needed the
// session began it.

import assert from 'node:assert/strict';
import { runScenarios } from './lib/resident-body.mjs';
import { APP, bootEngine, stat as engineStat } from './lib/guest-engines.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A holder engine over a session that holds `APP/seed.txt` (not read yet) and `APP/dir/`. */
const boot = () => bootEngine('holder', {
  seed(authority) {
    authority.kfs.writeFile('home/user/app/seed.txt', 'SEED');
    authority.kfs.mkdir('home/user/app/dir', { mode: 0o755 });
    authority.kfs.writeFile('home/user/app/dir/inner.txt', 'INNER');
  },
});

/** What a refused call must leave as it was. */
async function footprint(e) {
  const stats = await e.fs.stats();
  return {
    calls: { ...e.log.calls },
    waves: e.waves(),
    logged: e.journal().entries().length,
    sessionCalls: stats.sessionCalls,
    barriers: stats.barriers,
    holding: await e.fs.holding(),
  };
}

/** `call` answers now: a value, or a refusal whose code is `code`, leaving nothing. */
async function answersNow(e, label, call, code) {
  const before = await footprint(e);
  let value;
  let refused;
  try { value = call(); } catch (error) { refused = error; }
  assert.ok(!(value instanceof Promise), `${label}: a promise`);
  if (code === undefined) assert.equal(refused, undefined, `${label}: refused ${refused?.code} ${refused?.message}`);
  else assert.equal(refused?.code, code, `${label}: ${refused === undefined ? 'answered' : `${refused.code} ${refused.message}`}`);
  // Nothing it began may finish after it either.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await footprint(e), before, `${label}: left something`);
  return value;
}

await runScenarios(import.meta.path, {
  async 'a call that needs the session is refused before it begins anything'(e = undefined) {
    e = await boot();
    const sync = e.sync;
    const seed = `${APP}/seed.txt`;
    // The view knows nothing of these yet: each is the session's to answer.
    await answersNow(e, 'stat of an unknown name', () => sync.stat(`${APP}/nowhere.txt`), 'EAGAIN');
    await answersNow(e, 'readFile of an unknown name', () => sync.readFile(seed), 'EAGAIN');
    await answersNow(e, 'readdir of an unlisted directory', () => sync.readdir(`${APP}/dir`), 'EAGAIN');
    await answersNow(e, 'readlink', () => sync.readlink(seed), 'EAGAIN');
    await answersNow(e, 'realpath', () => sync.realpath(seed), 'EAGAIN');
    await answersNow(e, 'access', () => sync.access(seed, 4), 'EAGAIN');
    await answersNow(e, 'a read-only open of an unknown name', () => sync.open(seed, { read: true }), 'EAGAIN');
    // A change in a directory the view has not listed: the session's to judge, before anything is decided.
    const dir = `${APP}/dir`;
    await answersNow(e, 'writeFile', () => sync.writeFile(`${dir}/new.txt`, enc.encode('N')), 'EAGAIN');
    await answersNow(e, 'mkdir', () => sync.mkdir(`${dir}/sub`), 'EAGAIN');
    await answersNow(e, 'mkdir -p', () => sync.mkdir(`${dir}/a/b`, { recursive: true }), 'EAGAIN');
    await answersNow(e, 'unlink', () => sync.unlink(`${dir}/inner.txt`), 'EAGAIN');
    await answersNow(e, 'rename', () => sync.rename(`${dir}/inner.txt`, `${dir}/moved.txt`), 'EAGAIN');
    await answersNow(e, 'chmod', () => sync.chmod(`${dir}/inner.txt`, 0o600), 'EAGAIN');
    await answersNow(e, 'symlink', () => sync.symlink('inner.txt', `${dir}/link`), 'EAGAIN');
    await answersNow(e, 'rmdir', () => sync.rmdir(`${dir}/sub`), 'EAGAIN');
    await answersNow(e, 'copyFile', () => sync.copyFile(`${dir}/inner.txt`, `${dir}/copy.txt`), 'EAGAIN');
    await answersNow(e, 'a write open', () => sync.open(`${dir}/new.txt`, { write: true, create: true, truncate: true, mode: 0o644 }), 'EAGAIN');
    // Known (listed), its bytes not: the name answers, its content is not resident.
    assert.ok((await e.fs.readdir(APP)).some((entry) => entry.name === 'seed.txt'));
    assert.equal(stat(await answersNow(e, 'stat of a known name', () => sync.stat(seed))), 4);
    await answersNow(e, 'readFile of bytes not resident', () => sync.readFile(seed), 'EAGAIN');
    // An open by its number reads nothing: the read needs the bytes, an awaited read fetches them.
    const fd = (await answersNow(e, 'a read-only open of a known name', () => sync.open(seed, { read: true }))).id;
    await answersNow(e, 'a read of bytes not resident', () => sync.read(fd, 0, 16), 'EAGAIN');
    assert.equal(dec.decode(await e.fs.read(fd, 0, 16)), 'SEED');
    assert.equal(dec.decode(await answersNow(e, 'a read of bytes fetched', () => sync.read(fd, 0, 16))), 'SEED');
    sync.close(fd);
    // A directory is the name's own state where the view knows it.
    assert.equal((await e.fs.stat(`${APP}/dir`)).type, 'directory');
    await answersNow(e, 'readFile of a directory', () => sync.readFile(`${APP}/dir`), 'EISDIR');
  },

  async 'mkdir -p is planned whole: one that reaches a name the view cannot place makes nothing'(e = undefined) {
    e = await bootEngine('holder', {
      seed(authority) {
        authority.kfs.mkdir('home/user/elsewhere', { mode: 0o755 });
        authority.kfs.symlink('/home/user/elsewhere', 'home/user/app/link');
      },
    });
    const sync = e.sync;
    // APP listed: `new` may be made there; `..` after it leads back into APP, and its link into a directory the view has not listed.
    await e.fs.readdir(APP);
    await answersNow(e, 'mkdir -p through .. into a directory the view cannot place', () => sync.mkdir(`${APP}/new/../link/child`, { recursive: true }), 'EAGAIN');
    assert.equal(sync.stat(`${APP}/new`), null, 'a refused mkdir -p made a directory');
  },
  async 'what the process holds is answered now, the barrier it owes not taken'(e = undefined) {
    e = await boot();
    const sync = e.sync;
    const seed = `${APP}/seed.txt`;
    assert.equal(dec.decode(await e.fs.readFile(seed)), 'SEED');
    await e.fs.readdir(`${APP}/dir`);
    assert.equal(dec.decode(await answersNow(e, 'readFile of resident bytes', () => sync.readFile(seed))), 'SEED');
    assert.deepEqual((await answersNow(e, 'readdir of a listed directory', () => sync.readdir(`${APP}/dir`))).map((entry) => entry.name), ['inner.txt']);
    // Input arrived, so a barrier is owed: a call that answers now answers
    // from the view as it stands, and the next awaited one takes it.
    e.fs.inbound();
    assert.equal(stat(await answersNow(e, 'stat with a barrier owed', () => sync.stat(seed))), 4);
    const { barriers } = await e.fs.stats();
    await e.fs.stat(seed);
    assert.equal((await e.fs.stats()).barriers, barriers + 1, 'the awaited call did not take the barrier owed');
  },

  async 'an awaited change outside a grant is what the next call that cannot wait reads'() {
    const OLD = Date.UTC(2001, 1, 3, 4, 5, 6);
    const seed = `${APP}/seed.txt`;
    const changes = {
      chmod: [(fs) => fs.chmod(seed, 0o600), (sync) => engineStat(sync.stat(seed)).mode, 0o600],
      utimes: [(fs) => fs.utimes(seed, OLD, OLD), (sync) => engineStat(sync.stat(seed)).mtimeMs, OLD],
      mkdir: [(fs) => fs.mkdir(`${APP}/made`, { mode: 0o755 }), (sync) => engineStat(sync.stat(`${APP}/made`))?.type, 'directory'],
      unlink: [(fs) => fs.unlink(seed), (sync) => sync.stat(seed), null],
      rename: [(fs) => fs.rename(seed, `${APP}/moved.txt`), (sync) => [sync.stat(seed), stat(sync.stat(`${APP}/moved.txt`))], [null, 4]],
      rmdir: [(fs) => fs.rmdir(`${APP}/empty`), (sync) => sync.stat(`${APP}/empty`), null],
      symlink: [(fs) => fs.symlink('seed.txt', `${APP}/link`), (sync) => sync.readlink(`${APP}/link`), 'seed.txt'],
    };
    for (const [name, [change, read, expected]] of Object.entries(changes)) {
      // Each on an engine of its own, so no change counts toward taking the subtree another is made in.
      const e = await bootEngine('holder', {
        seed(authority) {
          authority.kfs.writeFile('home/user/app/seed.txt', 'SEED');
          authority.kfs.mkdir('home/user/app/empty', { mode: 0o755 });
        },
      });
      await e.fs.readdir(APP);
      await e.fs.readdir(`${APP}/empty`);
      await change(e.fs);
      assert.ok(!e.held(`${APP}/x`), `${name}: decided under a grant`);
      assert.deepEqual(read(e.sync), expected, name);
    }
  },

  async 'an awaited change the session refuses rejects, and leaves nothing shown'(e = undefined) {
    e = await boot();
    await e.fs.readdir(`${APP}/dir`);
    // Behind the process's back: its view has the directory writable still.
    await e.authority.peer.chmod('home/user/app/dir', 0o555);
    await assert.rejects(Promise.resolve().then(() => e.fs.mkdir(`${APP}/dir/sub`, { mode: 0o755 })), (error) => error?.code === 'EACCES');
    assert.equal(e.sync.stat(`${APP}/dir/sub`), null);
    assert.deepEqual(e.sync.readdir(`${APP}/dir`).map((entry) => entry.name), ['inner.txt']);
  },

  async 'the root is answered now, as the session holds it'(e = undefined) {
    e = await boot();
    // What the session's own filesystem says of / (its SQLite root's stat).
    const facts = (raw) => { const { type, mode, uid, gid, ino } = engineStat(raw); return { type, mode, uid, gid, ino, dev: Number(raw.dev) }; };
    const sessionRoot = async () => facts(await e.authority.files.vfs.stat('/'));
    assert.deepEqual(facts(await answersNow(e, 'stat of /', () => e.sync.stat('/'))), await sessionRoot());
    assert.equal(await answersNow(e, 'realpath of /', () => e.sync.realpath('/')), '/');
    // A name made at the top: the root's own row moves with it, once the input's barrier lands.
    await e.authority.peerAs(CRED_KERNEL).mkdir('newtop', { mode: 0o755 });
    await e.input();
    assert.deepEqual(facts(e.sync.stat('/')), await sessionRoot());
  },

  async 'an awaited change only the session decides is shown once it returns'(e = undefined) {
    e = await boot();
    await e.fs.readdir(APP);
    // A set-group-id directory: the session's to make.
    await e.fs.mkdir(`${APP}/shared`, { mode: 0o2775 });
    assert.equal(engineStat(e.sync.stat(`${APP}/shared`))?.type, 'directory');
  },
});

function stat(value) {
  return value === null ? null : Number(value.size);
}
