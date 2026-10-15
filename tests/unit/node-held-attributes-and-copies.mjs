#!/usr/bin/env bun
// In a subtree a node process holds, an awaited chmod, utimes or chown is
// its sync form's change, answered once logged, as mkdir, unlink and a
// file's rename are; elsewhere the session answers it. A copy with both names
// held is answered once logged too when its source's bytes are known under
// the grant (the program's own unanswered write, or a read of it under the
// grant), the copy reading as those bytes at once. What the process answered
// lingers: it goes with the next change someone awaits, in one wave, and what
// sees the session without recalling the subtree hears it within LINGER_MS.
//
// Red before: each async form was a second implementation that sent the path
// and waited for the session's answer, held or not, so Node's cp (copyFile,
// then chmod of each file) waited out the session's durable commit twice a
// file; every copy waited for its own; and an answered change went alone,
// ahead of the awaited one after it.
//
// What is decided here is judged by the session's own rules (core
// posix-access: the walk's search permission, chmod, chown and utimes), on
// the one entry each call changes (a link's own, for lchown and lutimes; the
// followed target, held or not, for chown), and what this view cannot judge
// (the namespace unavailable) is the session's to answer. Red before: a
// decided copy skipped the search of its source's directories, lchown judged
// the link's target, chown was decided for a target outside the subtree,
// utimes of another's file was answered, a chown left the set-id bits the
// session clears, and with the namespace unavailable each async form
// refused EAGAIN instead of asking the session.

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, residentDataPlan, runScenarios, sleep, until } from './lib/resident-body.mjs';
import { drainProcessFsJournal, journalSource, LINGER_MS, sqlJournal } from '../../packages/core/src/_shared/process-fs-client.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { journalDrainSession } from '../../packages/core/src/workspace/supervisor-op.ts';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const OUT = '/home/user/app/out';

/**
 * A process holding `out`, a switch that stops the session answering its
 * waves, and one that makes its listings fail. Root owns `out/rootfile` and
 * the unsearchable `/home/user/app/locked`.
 */
async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app/out', { recursive: true, mode: 0o755 });
  authority.kfs.mkdir('home/user/elsewhere', { mode: 0o755 });
  authority.kfs.writeFile('home/user/elsewhere/x.txt', 'x');
  authority.kfs.writeFile('home/user/app/out/seeded.txt', 'seeded');
  const root = authority.rawVfs.as(CRED_KERNEL);
  root.writeFile('home/user/app/out/rootfile', 'R');
  root.mkdir('home/user/app/locked', { mode: 0o700 });
  root.writeFile('home/user/app/locked/inside.txt', 'inside');
  let stalled = null;
  let listingFails = false;
  let waves = 0;
  let forward;
  const handle = facetSupervisor(authority, {
    writeBatchStream: async (...args) => {
      waves++;
      if (stalled !== null) await stalled.promise;
      return forward('writeBatchStream', args);
    },
    fsList: async (...args) => {
      if (listingFails) throw new Error('Network connection lost.');
      return forward('fsList', args);
    },
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
  for (let i = 0; i < 16; i++) await fs.promises.writeFile(`${OUT}/warm${i}`, 'w');
  await until(() => globalThis.__nimbusProcessFs?.held('home/user/app/out/x') !== undefined, 'the subtree held', 5_000);
  await globalThis.__nimbusProcessFs.flush();
  return {
    authority,
    fs,
    waves: () => waves,
    failListings: (fails) => { listingFails = fails; },
    stall: () => { stalled = Promise.withResolvers(); },
    release: async () => {
      stalled.resolve();
      stalled = null;
      await globalThis.__nimbusProcessFs.flush();
    },
  };
}

/** What the session holds at `path`, read as a peer reads it (recalling the process's subtree). */
const peerRead = async (authority, path) => new TextDecoder().decode(await authority.peer.readFile(path));

/** Whether `work` settles while the session answers nothing (a timer of the host's, which no barrier holds). */
const answeredAtOnce = (work) => Promise.race([work.then(() => 'answered'), sleep(50).then(() => 'waiting')]);

await runScenarios(import.meta.path, {
  async 'an awaited chmod, utimes and chown in a held subtree are answered once logged'() {
    const { authority, fs, stall, release } = await boot();
    stall();
    assert.equal(await answeredAtOnce(fs.promises.chmod(`${OUT}/warm0`, 0o600)), 'answered', 'chmod');
    assert.equal(fs.statSync(`${OUT}/warm0`).mode & 0o7777, 0o600);
    assert.equal(await answeredAtOnce(fs.promises.utimes(`${OUT}/warm0`, 1, 1)), 'answered', 'utimes');
    assert.equal(fs.statSync(`${OUT}/warm0`).mtimeMs, 1000);
    assert.equal(await answeredAtOnce(fs.promises.chown(`${OUT}/warm0`, 1000, 1000)), 'answered', 'chown');
    await release();
    const stat = await authority.peer.stat('home/user/app/out/warm0');
    assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(Number(stat.mtime), 1000);
    // What the session would refuse is refused as the sync form refuses it.
    await assert.rejects(fs.promises.chown(`${OUT}/warm1`, 0, 0), { code: 'EPERM' });
  },

  async 'an awaited chmod outside a held subtree waits for the session'() {
    const { authority, fs, stall, release } = await boot();
    stall();
    const chmod = fs.promises.chmod('/home/user/elsewhere/x.txt', 0o600);
    assert.equal(await answeredAtOnce(chmod), 'waiting');
    await release();
    await chmod;
    assert.equal((await authority.peer.stat('home/user/elsewhere/x.txt')).mode & 0o7777, 0o600);
  },

  async 'a copy of the program\'s own unanswered write, both names held, is answered once logged'() {
    const { authority, fs, stall, release } = await boot();
    stall();
    fs.writeFileSync(`${OUT}/src.txt`, 'SOURCE');
    fs.chmodSync(`${OUT}/src.txt`, 0o640);
    assert.equal(await answeredAtOnce(fs.promises.copyFile(`${OUT}/src.txt`, `${OUT}/dst.txt`)), 'answered');
    assert.equal(fs.readFileSync(`${OUT}/dst.txt`, 'utf8'), 'SOURCE');
    const copied = fs.statSync(`${OUT}/dst.txt`);
    assert.equal(copied.mode & 0o7777, 0o640);
    assert.equal(copied.size, 6);
    // Over a file of its own already there: the copy replaces its bytes and mode.
    fs.writeFileSync(`${OUT}/src.txt`, 'AGAIN');
    assert.equal(await answeredAtOnce(fs.promises.copyFile(`${OUT}/src.txt`, `${OUT}/warm2`)), 'answered');
    assert.equal(fs.readFileSync(`${OUT}/warm2`, 'utf8'), 'AGAIN');
    assert.equal(fs.statSync(`${OUT}/warm2`).mode & 0o7777, 0o640);
    await release();
    assert.equal(fs.readFileSync(`${OUT}/dst.txt`, 'utf8'), 'SOURCE');
    assert.equal(await peerRead(authority, 'home/user/app/out/dst.txt'), 'SOURCE');
    assert.equal((await authority.peer.stat('home/user/app/out/dst.txt')).mode & 0o7777, 0o640);
    assert.equal(await peerRead(authority, 'home/user/app/out/warm2'), 'AGAIN');
  },

  async 'a copy of a held file the program did not write is answered once logged, after a read of it under the grant'() {
    const { authority, fs, stall, release } = await boot();
    stall();
    assert.equal(await answeredAtOnce(fs.promises.copyFile(`${OUT}/seeded.txt`, `${OUT}/from-seeded.txt`)), 'answered');
    assert.equal(fs.readFileSync(`${OUT}/from-seeded.txt`, 'utf8'), 'seeded');
    assert.equal(fs.statSync(`${OUT}/from-seeded.txt`).mode & 0o7777, fs.statSync(`${OUT}/seeded.txt`).mode & 0o7777);
    await release();
    assert.equal(await peerRead(authority, 'home/user/app/out/from-seeded.txt'), 'seeded');
  },

  async 'copies alone take the subtree they copy into, and are decided there from then'() {
    const { fs, stall, release } = await boot();
    const CO = '/home/user/app/co';
    fs.mkdirSync(CO);
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(`${CO}/s${i}`, `S${i}`);
      await fs.promises.copyFile(`${CO}/s${i}`, `${CO}/d${i}`);
    }
    await until(() => globalThis.__nimbusProcessFs.held('home/user/app/co/x') !== undefined, 'the copies took their subtree', 5_000);
    stall();
    fs.writeFileSync(`${CO}/last`, 'LAST');
    assert.equal(await answeredAtOnce(fs.promises.copyFile(`${CO}/last`, `${CO}/last-copy`)), 'answered');
    assert.equal(fs.readFileSync(`${CO}/last-copy`, 'utf8'), 'LAST');
    await release();
  },

  async 'a copy from outside any held subtree, or of a set-id file, is the session\'s to answer'() {
    const { authority, fs, stall, release } = await boot();
    stall();
    const outside = fs.promises.copyFile('/home/user/elsewhere/x.txt', `${OUT}/from-elsewhere.txt`);
    assert.equal(await answeredAtOnce(outside), 'waiting', 'a source outside the subtree');
    fs.writeFileSync(`${OUT}/tool`, 'TOOL');
    fs.chmodSync(`${OUT}/tool`, 0o4755);
    const setuid = fs.promises.copyFile(`${OUT}/tool`, `${OUT}/tool-copy`);
    assert.equal(await answeredAtOnce(setuid), 'waiting', 'a set-id source');
    await release();
    await Promise.all([outside, setuid]);
    assert.equal(await peerRead(authority, 'home/user/app/out/from-elsewhere.txt'), 'x');
    assert.equal(await peerRead(authority, 'home/user/app/out/tool-copy'), 'TOOL');
  },

  async 'what the log holds of an answered copy lands the bytes it answered, whatever the source becomes'() {
    const { fs, stall } = await boot();
    // The facet's own store, where the process logs what it changes (process-fs-journal).
    const journalSql = globalThis.__nimbusFsJournalSql;
    const sourceMode = fs.statSync(`${OUT}/seeded.txt`).mode & 0o7777;
    stall();
    assert.equal(await answeredAtOnce(fs.promises.copyFile(`${OUT}/seeded.txt`, `${OUT}/answered.txt`)), 'answered');
    assert.equal(fs.readFileSync(`${OUT}/answered.txt`, 'utf8'), 'seeded');
    // The process ends here with its log unanswered, and a peer changes the
    // source before the log is drained: the session it drains into.
    const after = createAuthority();
    after.kfs.mkdir('home/user/app/out', { recursive: true, mode: 0o755 });
    after.kfs.writeFile('home/user/app/out/seeded.txt', 'CHANGED');
    const lease = after.files.openHost(CRED_SESSION_USER);
    const drained = await drainProcessFsJournal({ journal: journalSource(sqlJournal(journalSql)), session: journalDrainSession(lease.fs, 1000002) })
      .finally(() => lease.dispose());
    assert.deepEqual(drained.failures, []);
    assert.equal(after.read('home/user/app/out/answered.txt'), 'seeded', 'the drain copied what the source became');
    assert.equal(after.kfs.stat('home/user/app/out/answered.txt').mode & 0o7777, sourceMode);
  },

  async 'a decided copy is refused where the session\'s walk to its source is (EACCES)'() {
    const { authority, fs } = await boot();
    fs.mkdirSync(`${OUT}/shut`);
    fs.writeFileSync(`${OUT}/shut/s`, 'S');
    fs.chmodSync(`${OUT}/shut`, 0o600);
    await assert.rejects(fs.promises.copyFile(`${OUT}/shut/s`, `${OUT}/from-shut`), { code: 'EACCES' });
    assert.equal(fs.existsSync(`${OUT}/from-shut`), false);
    await globalThis.__nimbusProcessFs.flush();
    await assert.rejects(authority.peer.stat('home/user/app/out/from-shut'), { code: 'ENOENT' });
  },

  async 'lchown and lutimes judge the link itself, chown and utimes what it names, as the session does'() {
    const { authority, fs, stall, release } = await boot();
    fs.symlinkSync(`${OUT}/rootfile`, `${OUT}/mylink`);
    stall();
    assert.equal(await answeredAtOnce(fs.promises.lchown(`${OUT}/mylink`, 1000, 1000)), 'answered', 'the link is the caller\'s own');
    assert.equal(await answeredAtOnce(fs.promises.lutimes(`${OUT}/mylink`, 3, 3)), 'answered');
    await release();
    assert.equal((await authority.peer.lstat('home/user/app/out/mylink')).uid, 1000);
    await assert.rejects(fs.promises.chown(`${OUT}/mylink`, 1000, 1000), { code: 'EPERM' }, 'chown follows it to root\'s file');
    await assert.rejects(fs.promises.utimes(`${OUT}/mylink`, 3, 3), { code: 'EPERM' }, 'and so does utimes');
  },

  async 'chown through a link to a file outside the held subtree waits for the session'() {
    const { authority, fs, stall, release } = await boot();
    fs.symlinkSync('/home/user/elsewhere/x.txt', `${OUT}/outward`);
    stall();
    const chown = fs.promises.chown(`${OUT}/outward`, 1000, 1000);
    assert.equal(await answeredAtOnce(chown), 'waiting');
    await release();
    await chown;
    assert.equal((await authority.peer.stat('home/user/elsewhere/x.txt')).uid, 1000);
  },

  async 'utimes of another\'s file is refused as the session refuses it (EPERM)'() {
    const { fs } = await boot();
    assert.throws(() => fs.utimesSync(`${OUT}/rootfile`, 1, 1), { code: 'EPERM' });
    await assert.rejects(fs.promises.utimes(`${OUT}/rootfile`, 1, 1), { code: 'EPERM' });
    assert.notEqual(fs.statSync(`${OUT}/rootfile`).mtimeMs, 1000);
  },

  async 'a chown clears the set-id bits in this view as the session does'() {
    const { authority, fs, stall, release } = await boot();
    fs.writeFileSync(`${OUT}/setid`, 'x');
    fs.chmodSync(`${OUT}/setid`, 0o4755);
    stall();
    assert.equal(await answeredAtOnce(fs.promises.chown(`${OUT}/setid`, 1000, 1000)), 'answered');
    assert.equal(fs.statSync(`${OUT}/setid`).mode & 0o7777, 0o755);
    await release();
    assert.equal((await authority.peer.stat('home/user/app/out/setid')).mode & 0o7777, 0o755);
  },

  async 'with the namespace unavailable, chmod, utimes and chown go to the session'() {
    const { authority, fs, failListings } = await boot();
    // A directory becomes searchable; the barrier that reports it relists it, and that relist fails.
    await authority.peerAs(CRED_KERNEL).chmod('home/user/app/locked', 0o755);
    failListings(true);
    await fs.promises.stat('/home/user/app');
    assert.throws(() => fs.existsSync(`${OUT}/warm4`), { code: 'EAGAIN' }, 'the namespace is unavailable');
    await fs.promises.chmod(`${OUT}/warm4`, 0o640);
    await fs.promises.utimes(`${OUT}/warm4`, 7, 7);
    await fs.promises.chown(`${OUT}/warm4`, 1000, 1000);
    failListings(false);
    await globalThis.__nimbusProcessFs.flush();
    const stat = await authority.peer.stat('home/user/app/out/warm4');
    assert.equal(stat.mode & 0o7777, 0o640);
    assert.equal(Number(stat.mtime), 7000);
  },

  async 'an answered change in a held subtree goes with the next change someone awaits, in one wave'() {
    const { authority, fs, waves } = await boot();
    const before = waves();
    await fs.promises.chmod(`${OUT}/warm3`, 0o600);
    await fs.promises.chmod('/home/user/elsewhere/x.txt', 0o640);
    assert.equal(waves() - before, 1, 'the answered chmod went alone, ahead of the awaited one');
    assert.equal((await authority.peer.stat('home/user/app/out/warm3')).mode & 0o7777, 0o600);
  },

  async 'the file tree hears an answered change in a held subtree within LINGER_MS, unasked'() {
    const { authority, fs } = await boot();
    const heard = [];
    const stop = authority.files.vfs.watchChanges('/home/user/app/out', (events) => { for (const event of events) heard.push(event.path); });
    await fs.promises.writeFile(`${OUT}/told.txt`, 'told');
    await until(() => heard.some((path) => path.endsWith('/told.txt')), 'the tree heard the write', LINGER_MS + 500);
    stop();
  },
});
