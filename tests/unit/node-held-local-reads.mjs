#!/usr/bin/env bun
// In a subtree a node process holds, fs.promises.stat and lstat answer from
// the process's own view, with no session call, where that view is exactly
// the session's for everything the answer depends on: the grant's
// certificate (where the session stood when it recorded it) reached by the
// view's cursor in its epoch, every name the walk crosses vouched for by a
// fresh grant (the entry itself held), each the namespace's own row with
// every change of the process's own answered and in the view, no mount, no
// climbing link, and nothing admitted halfway. Anywhere else the session
// answers, as before.
//
// Red before: every async stat flushed the path and asked the session, held
// or not (the gain scenarios). The others hold before and after: what the
// local answer must never get wrong (held-local-reads-design.md T1–T16).

import assert from 'node:assert/strict';
import { positionOf, rootOf } from '../../packages/core/src/runtime/feed-position.ts';
import { createAuthority, facetSupervisor, launchResident, residentDataPlan, runScenarios, sleep, until } from './lib/resident-body.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const OUT = '/home/user/app/out';
const STAT_FIELDS = ['mode', 'size', 'ino', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs', 'atimeMs'];

/**
 * A process, its session's stat and lstat reads counted (`asked`), and a
 * held `out` (taken by writing there) unless `take` is false. `strip`: the
 * session's grants come without their certificate (a session before them).
 * `slow`: ms each write wave's answer is held back after it commits.
 * `counted.lose`: how many write waves' answers are lost after they commit
 * (the client sends them again). `counted.relistGate`: a gate the
 * namespace's relists wait on, when set.
 */
async function boot({ take = true, strip = false, slow = 0 } = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app/out', { recursive: true, mode: 0o755 });
  authority.kfs.mkdir('home/user/elsewhere', { mode: 0o755 });
  authority.kfs.writeFile('home/user/elsewhere/x.txt', 'x');
  authority.kfs.writeFile('home/user/app/out/seeded.txt', 'seeded');
  const root = authority.rawVfs.as(CRED_KERNEL);
  root.mkdir('home/user/app/locked', { mode: 0o700 });
  const counted = { asked: 0, relistGate: null, lose: 0 };
  let forward;
  const handle = facetSupervisor(authority, {
    fsAcquired: async (acquire, op, args) => {
      if (op === 'stat' || op === 'lstat') counted.asked++;
      return forward('fsAcquired', [acquire, op, args]);
    },
    fsList: async (...args) => {
      if (counted.relistGate !== null) await counted.relistGate.promise;
      return forward('fsList', args);
    },
    writeBatchStream: async (...args) => {
      const answer = await forward('writeBatchStream', args);
      if (counted.lose > 0) {
        counted.lose--;
        throw Object.assign(new Error('Network connection lost.'), { retryable: true });
      }
      if (slow > 0) await sleep(slow);
      return answer;
    },
    ...(strip ? {
      fsAcquireExclusiveMutation: async (...args) => {
        const { certificate, ...granted } = await forward('fsAcquireExclusiveMutation', args);
        return granted;
      },
    } : {}),
  });
  forward = handle.forward;
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user'),
    cursor: authority.cursor(),
  });
  const { fs } = globalThis.__probe;
  if (take) await takeOut(fs);
  return { authority, fs, root, counted, asked: () => counted.asked };
}

/** Take `out`: write there until the process holds it, then let what it wrote be answered. */
async function takeOut(fs, dir = OUT) {
  for (let i = 0; i < 16; i++) await fs.promises.writeFile(`${dir}/warm${i}`, 'w');
  await until(() => globalThis.__nimbusProcessFs?.client?.held(`${dir.slice(1)}/x`) !== undefined, 'the subtree held', 5_000);
  await globalThis.__nimbusProcessFs.flush();
}

/** The Stats fields a local and a session answer must agree on. */
const fieldsOf = (stats) => Object.fromEntries(STAT_FIELDS.map((field) => [field, stats[field]]));

await runScenarios(import.meta.path, {
  async 'in a held subtree the view is fresh for, stat and lstat ask the session nothing (T5, T12)'() {
    const { fs, asked } = await boot();
    // The first read's barrier brings the view to the grant's certificate.
    const first = await fs.promises.stat(`${OUT}/seeded.txt`);
    const before = asked();
    const again = await fs.promises.stat(`${OUT}/seeded.txt`);
    const link = await fs.promises.lstat(`${OUT}/seeded.txt`);
    assert.equal(asked() - before, 0, 'a held, fresh stat asked the session');
    assert.deepEqual(fieldsOf(again), fieldsOf(first));
    assert.deepEqual(fieldsOf(link), fieldsOf(first));
    await fs.promises.stat('/home/user/elsewhere/x.txt');
    assert.equal(asked() - before, 1, 'a stat outside held subtrees did not ask the session once');
  },

  async 'what a peer wrote before the grant, after the last barrier, is what a stat answers (T1)'() {
    const { authority, fs, asked } = await boot({ take: false });
    await fs.promises.stat(`${OUT}/seeded.txt`);
    await authority.peer.writeFile('home/user/app/out/seeded.txt', 'the peer wrote this, longer');
    await takeOut(fs);
    const stat = await fs.promises.stat(`${OUT}/seeded.txt`);
    assert.equal(stat.size, 'the peer wrote this, longer'.length);
    const before = asked();
    assert.equal((await fs.promises.stat(`${OUT}/seeded.txt`)).size, 'the peer wrote this, longer'.length);
    assert.equal(asked() - before, 0, 'once the view reached the certificate, it answered');
  },

  async 'a link out of the held subtree is the session\'s to follow; the link itself is the view\'s (T2, T8)'() {
    const { authority, fs, asked } = await boot();
    await authority.peer.writeFile('home/user/elsewhere/t1', 'one');
    await fs.promises.writeFile(`${OUT}/t2`, 'two!');
    await authority.peer.symlink('/home/user/elsewhere/t1', 'home/user/elsewhere/b');
    await fs.promises.symlink('/home/user/elsewhere/b', `${OUT}/a`);
    await fs.promises.stat(`${OUT}/a`);
    await globalThis.__nimbusProcessFs.flush();
    // The peer retargets the link outside: nothing held is recalled.
    await authority.peer.unlink('home/user/elsewhere/b');
    await authority.peer.symlink('/home/user/app/out/t2', 'home/user/elsewhere/b');
    assert.equal((await fs.promises.stat(`${OUT}/a`)).size, 4, 'the stat followed a stale link');
    await fs.promises.lstat(`${OUT}/a`);
    const before = asked();
    assert.equal((await fs.promises.lstat(`${OUT}/a`)).isSymbolicLink(), true);
    assert.equal(asked() - before, 0, 'the held link itself asked the session');
  },

  async 'after a peer change recalls the grant, the stat asks the session (T3)'() {
    const { authority, fs, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    await authority.peer.chmod('home/user/app/out/seeded.txt', 0o600);
    const before = asked();
    assert.equal((await fs.promises.stat(`${OUT}/seeded.txt`)).mode & 0o777, 0o600);
    assert.equal(asked() - before, 1);
  },

  async 'after the process\'s own create, rewrite, chmod and utimes, the stat is the session\'s, whole (T6)'() {
    const { authority, fs } = await boot();
    await fs.promises.writeFile(`${OUT}/own.txt`, 'made');
    await fs.promises.writeFile(`${OUT}/own.txt`, 'made again, longer');
    await fs.promises.chmod(`${OUT}/own.txt`, 0o640);
    await fs.promises.utimes(`${OUT}/own.txt`, 7, 8);
    for (let i = 0; i < 2; i++) {
      const local = await fs.promises.stat(`${OUT}/own.txt`);
      await globalThis.__nimbusProcessFs.flush();
      const session = await authority.peer.stat('home/user/app/out/own.txt');
      assert.deepEqual(
        [local.mode, local.size, local.ino, local.uid, local.gid, local.mtimeMs, local.atimeMs],
        [session.mode, Number(session.size), session.ino, session.uid, session.gid, Number(session.mtime), Number(session.atime)],
      );
    }
  },

  async 'a rewrite written back without a barrier after it: the stat is the session\'s, its times too, not the view\'s guess at them (T6)'() {
    for (const rewrite of [
      (fs) => fs.writeFileSync(`${OUT}/seeded.txt`, 'rewritten, and longer'),
      (fs) => fs.appendFileSync(`${OUT}/seeded.txt`, ', and then some'),
    ]) {
      const { authority, fs } = await boot({ slow: 40 });
      await fs.promises.stat(`${OUT}/seeded.txt`);
      rewrite(fs);
      // A listing's barrier comes before it writes back what is under it.
      await fs.promises.readdir(OUT);
      const local = await fs.promises.stat(`${OUT}/seeded.txt`);
      const session = await authority.peer.stat('home/user/app/out/seeded.txt');
      assert.deepEqual(
        [local.size, local.mtimeMs, local.ctimeMs],
        [Number(session.size), Number(session.mtime), Number(session.ctime)],
        String(rewrite),
      );
    }
  },

  async 'an entry the process made, moved or removed, answered: its directory\'s stat is the session\'s (T6)'() {
    for (const change of [
      (fs) => fs.promises.writeFile(`${OUT}/child.txt`, 'c'),
      (fs) => fs.promises.mkdir(`${OUT}/made`),
      (fs) => fs.promises.rename(`${OUT}/seeded.txt`, `${OUT}/moved.txt`),
      (fs) => fs.promises.unlink(`${OUT}/seeded.txt`),
      (fs) => fs.promises.rmdir(`${OUT}/sub`),
      (fs, counted) => { counted.lose = 1; return fs.promises.writeFile(`${OUT}/answered-again.txt`, 'a'); },
    ]) {
      const { authority, fs, counted } = await boot();
      await fs.promises.mkdir(`${OUT}/sub`).catch(() => {});
      await globalThis.__nimbusProcessFs.flush();
      await fs.promises.stat(OUT);
      await sleep(5);
      await change(fs, counted);
      await globalThis.__nimbusProcessFs.flush();
      assert.equal(counted.lose, 0, 'the answer to lose was never sent');
      const local = await fs.promises.stat(OUT);
      const session = await authority.peer.stat('home/user/app/out');
      assert.deepEqual(
        [local.mtimeMs, local.ctimeMs, local.nlink],
        [Number(session.mtime), Number(session.ctime), Number(session.nlink)],
        String(change),
      );
    }
  },

  async 'the process\'s own chmod denying search, answered: a stat beneath it is EACCES, as the session says (T6)'() {
    const { fs } = await boot();
    await fs.promises.mkdir(`${OUT}/shut`);
    await fs.promises.writeFile(`${OUT}/shut/f`, 'f');
    await globalThis.__nimbusProcessFs.flush();
    await fs.promises.stat(`${OUT}/shut/f`);
    await fs.promises.chmod(`${OUT}/shut`, 0o600);
    await globalThis.__nimbusProcessFs.flush();
    await assert.rejects(fs.promises.stat(`${OUT}/shut/f`), { code: 'EACCES' });
  },

  async 'a peer\'s chmod of an ancestor that denies search: the stat is EACCES, as the session says (T7)'() {
    const { authority, fs } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    await authority.peerAs(CRED_KERNEL).chmod('home/user/app', 0o600);
    await assert.rejects(fs.promises.stat(`${OUT}/seeded.txt`), { code: 'EACCES' });
  },

  async 'a mount beneath the held subtree recalls it before the table moves, and the stat asks the session (T10)'() {
    const { authority, fs, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    const recalls = globalThis.__nimbusProcessFs.client.stats().recalls;
    await withRecall(() => authority.files.vfs.mount('/home/user/app/out/m', new MemoryVFS()));
    await until(() => globalThis.__nimbusProcessFs.client.stats().recalls > recalls, 'the recall', 5_000);
    const before = asked();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    assert.equal(asked() - before, 1, 'the stat answered from a view a mount had moved');
  },

  async 'what the process made and the session has not answered is the session\'s to stat; once answered, the view\'s (T11)'() {
    const { fs, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    fs.mkdirSync(`${OUT}/d`);
    fs.writeFileSync(`${OUT}/d/f`, 'f');
    let before = asked();
    await fs.promises.stat(`${OUT}/d/f`);
    assert.equal(asked() - before, 1, 'an unanswered make was answered from the view');
    await globalThis.__nimbusProcessFs.flush();
    await fs.promises.stat(`${OUT}/d/f`);
    before = asked();
    await fs.promises.stat(`${OUT}/d/f`);
    assert.equal(asked() - before, 0, 'once answered, the view did not answer');
  },

  async 'a grant without a certificate, or a cursor in another epoch, asks the session (T13, T15)'() {
    const stripped = await boot({ strip: true });
    await stripped.fs.promises.stat(`${OUT}/seeded.txt`);
    let before = stripped.asked();
    await stripped.fs.promises.stat(`${OUT}/seeded.txt`);
    assert.equal(stripped.asked() - before, 1, 'a grant without a certificate answered');
    const { fs, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    const cursor = globalThis.__nimbusVfsCursor;
    const position = cursor.position;
    cursor.position = positionOf(position.table, { ...position.feeds, '/': { epoch: 'another', cursor: rootOf(position).cursor } });
    before = asked();
    await fs.promises.stat(`${OUT}/seeded.txt`).finally(() => { if (rootOf(cursor.position).epoch === 'another') cursor.position = position; });
    assert.equal(asked() - before, 1, 'a cursor in another epoch answered');
  },

  async 'a route across two held roots asks until the view has reached both certificates (T14)'() {
    const { authority, fs, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    await authority.peer.mkdir('home/user/app2', { mode: 0o755 });
    await fs.promises.stat('/home/user/app2');
    await fs.promises.writeFile('/home/user/app2/t', 'there');
    await fs.promises.symlink('/home/user/app2/t', `${OUT}/across`);
    await takeOut(fs, '/home/user/app2');
    let before = asked();
    await fs.promises.stat(`${OUT}/across`);
    assert.equal(asked() - before, 1, 'the second grant\'s certificate was not reached');
    await fs.promises.stat(`${OUT}/across`);
    before = asked();
    await fs.promises.stat(`${OUT}/across`);
    assert.equal(asked() - before, 0, 'with both reached, the route was not answered locally');
  },

  async 'while a directory the barrier made searchable is relisted, the stat asks the session (T16)'() {
    const { authority, fs, counted, asked } = await boot();
    await fs.promises.stat(`${OUT}/seeded.txt`);
    await authority.peerAs(CRED_KERNEL).chmod('home/user/app/locked', 0o755);
    counted.relistGate = Promise.withResolvers();
    const barrier = fs.promises.stat('/home/user/elsewhere/x.txt');
    await sleep(50);
    const before = asked();
    const held = fs.promises.stat(`${OUT}/seeded.txt`);
    await sleep(20);
    assert.equal(asked() - before, 1, 'a stat answered from the view while its admission was half done');
    counted.relistGate.resolve();
    counted.relistGate = null;
    await Promise.all([barrier, held]);
  },
});
