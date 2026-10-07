#!/usr/bin/env bun
// A failed clone's cleanup in the DO (git/clone-job.ts), on a session's
// SqliteVFS as the session user, its record in the DO's storage:
//   - transport (git's JUNK_LEAVE_NONE): everything the clone wrote goes,
//     in slices (a few entries each), the destination with it; one that
//     existed is kept, emptied; the record goes;
//   - checkout (JUNK_LEAVE_REPO): only the staging directory, temporary
//     packs and the marker go; the repository and worktree stay;
//   - a destination whose marker names another job: untouched, the record
//     goes; one with no marker (nothing written yet, or a cleanup that got
//     past it): only its empty .git and root go;
//   - a cleanup cut short between slices (the session reset) leaves its
//     record, and the next generation finishes it: the records of earlier
//     generations listed (listInterruptedClones; one of this generation, a
//     clone still running, is not), each destination reserved before the
//     first write (a write there is refused until its cleanup is done, then
//     lands and stays), one another lease holds left for later;
//   - slices of one entry over targets that are partly gone: absent ones
//     cost nothing, done ones are not walked again, and it ends;
//   - a generation that cannot list the records (CloneRecovery) serves no
//     write on a guess: every write is refused, named, nothing is lost, and
//     once a retry lists them the hold goes, the destinations are reserved
//     and cleaned up, and writes are served; a listing that keeps failing
//     keeps the hold;
//   - a clone on a mount: reserved at the root its record names, cleaned up
//     through the namespace, nothing else on the mount touched;
//   - as the record's credential: what it may not remove refuses, and the
//     record stays.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import {
  CloneRecovery, RECOVERY_FENCE_REASON, bridgeCleanupFs, cleanUpClone, finishReservedClones, listCloneJobs, listInterruptedClones, reserveInterruptedClones, writeCloneJob,
} from '../../packages/worker/src/git/clone-job.ts';
import { memoryStorage } from './lib/do-storage.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

function session() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  return { vfs, user: vfs.as(CRED_SESSION_USER), storage: memoryStorage() };
}

/** A clone part way through: a worktree, its .git with packs, staging and the job's marker. */
function cloneTree(user, dir, jobId, { files = 30 } = {}) {
  user.mkdir(dir + '/.git/objects/pack', { recursive: true });
  user.mkdir(dir + '/.git/nimbus-clone', { recursive: true });
  user.mkdir(dir + '/src/deep/er', { recursive: true });
  user.writeFile(dir + '/.git/nimbus-clone-job', JSON.stringify({ version: 1, jobId, optionsHash: 'h' }));
  user.writeFile(dir + '/.git/HEAD', 'ref: refs/heads/main\n');
  user.writeFile(dir + '/.git/config', '[core]\n');
  user.writeFile(dir + '/.git/objects/pack/pack-1.pack', 'p');
  user.writeFile(dir + '/.git/objects/pack/pack-1.idx', 'i');
  user.writeFile(dir + '/.git/objects/pack/tmp_pack_' + jobId + '_3.pack', 't');
  user.writeFile(dir + '/.git/nimbus-clone/batch-0', 'b');
  user.writeFile(dir + '/.git/nimbus-clone/index-gitlinks', 'g');
  for (let i = 0; i < files; i++) user.writeFile(`${dir}/${i % 3 === 0 ? 'src/deep/er' : 'src'}/f${i}.txt`, `${i}\n`);
  user.symlink('src/f1.txt', dir + '/link');
}

const record = (dir, jobId, extra = {}) => ({
  version: 1, jobId, dir, cred: CRED_SESSION_USER, rootExisted: false, phase: 'transport', generation: 1, startedAt: 1000, ...extra,
});
const list = (user, dir) => user.readdir(dir).map(({ name }) => name).sort();

// ── transport: everything goes, in slices ──
{
  const { user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-1');
  const job = record('home/user/repo', 'job-1');
  await writeCloneJob(storage, job);
  let yields = 0;
  const done = await cleanUpClone(user, storage, job, { sliceEntries: 7, yieldBetween: async () => { yields++; } });
  assert.equal(done.outcome, 'removed');
  assert.ok(done.slices > 3 && yields === done.slices - 1, JSON.stringify({ done, yields }));
  assert.equal(user.exists('home/user/repo'), false, 'the destination it made is gone');
  assert.deepEqual(await listCloneJobs(storage), [], 'the record went');
  console.log(`  ok  transport: the destination removed in ${done.slices} slices (${done.removed} entries); the record went`);
}

// ── transport, into a destination that existed: kept, emptied ──
{
  const { user, storage } = session();
  user.mkdir('home/user/empty');
  cloneTree(user, 'home/user/empty', 'job-2');
  const job = record('home/user/empty', 'job-2', { rootExisted: true });
  await writeCloneJob(storage, job);
  await cleanUpClone(user, storage, job, { sliceEntries: 5, yieldBetween: async () => {} });
  assert.deepEqual(list(user, 'home/user/empty'), [], 'kept, empty');
  console.log('  ok  transport into a destination that existed: kept, empty');
}

// ── checkout: only the clone's own leftovers go ──
{
  const { user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-3');
  const job = record('home/user/repo', 'job-3', { phase: 'checkout' });
  await writeCloneJob(storage, job);
  const done = await cleanUpClone(user, storage, job, { sliceEntries: 2, yieldBetween: async () => {} });
  assert.equal(done.outcome, 'kept-repo');
  assert.deepEqual(list(user, 'home/user/repo'), ['.git', 'link', 'src'], 'the worktree stays');
  assert.deepEqual(list(user, 'home/user/repo/.git'), ['HEAD', 'config', 'objects'], 'the repository stays; staging and marker went');
  assert.deepEqual(list(user, 'home/user/repo/.git/objects/pack'), ['pack-1.idx', 'pack-1.pack'], 'temporary packs went');
  assert.deepEqual(await listCloneJobs(storage), []);
  console.log('  ok  checkout: the repository and worktree kept; staging, temporary packs and marker removed');
}

// ── another job's marker: untouched; no marker: only empty dirs go ──
{
  const { user, storage } = session();
  cloneTree(user, 'home/user/repo', 'someone-else');
  const job = record('home/user/repo', 'job-4');
  await writeCloneJob(storage, job);
  const done = await cleanUpClone(user, storage, job);
  assert.equal(done.outcome, 'not-ours');
  assert.ok(user.exists('home/user/repo/.git/nimbus-clone-job') && user.exists('home/user/repo/src/f1.txt'), 'nothing touched');
  assert.deepEqual(await listCloneJobs(storage), [], 'the record went');

  user.mkdir('home/user/bare/.git', { recursive: true });
  user.mkdir('home/user/kept', { recursive: true });
  user.writeFile('home/user/kept/notes.txt', 'mine');
  for (const [dir, id] of [['home/user/bare', 'job-5'], ['home/user/kept', 'job-6']]) {
    const unmarked = record(dir, id);
    await writeCloneJob(storage, unmarked);
    await cleanUpClone(user, storage, unmarked);
  }
  assert.equal(user.exists('home/user/bare'), false, 'no marker: its empty .git and root go');
  assert.equal(user.readFileString('home/user/kept/notes.txt'), 'mine', 'no marker: what is not empty stays');
  console.log('  ok  another job\'s marker: untouched; no marker: only empty directories go');
}

// ── cut short, then finished by the next generation ──
{
  const { vfs, user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-7');
  const job = record('home/user/repo', 'job-7', { generation: 1 });
  await writeCloneJob(storage, job);
  await assert.rejects(cleanUpClone(user, storage, job, { sliceEntries: 4, yieldBetween: async () => { throw new Error('reset'); } }), /reset/);
  assert.ok(user.exists('home/user/repo/.git/nimbus-clone-job'), 'the marker outlives a cleanup cut short');
  assert.equal((await listCloneJobs(storage)).length, 1, 'and so does the record');
  // A clone of this generation (2) is running: not listed.
  cloneTree(user, 'home/user/live', 'job-8');
  await writeCloneJob(storage, record('home/user/live', 'job-8', { generation: 2 }));
  // A record written before records carried a generation is an earlier one's.
  cloneTree(user, 'home/user/old', 'job-11');
  const { generation: _generation, ...unnumbered } = record('home/user/old', 'job-11');
  await writeCloneJob(storage, unnumbered);
  // A destination whose lease another holds is left for the next generation.
  cloneTree(user, 'home/user/held', 'job-9');
  await writeCloneJob(storage, record('home/user/held', 'job-9', { generation: 1 }));
  const held = user.acquireExclusiveMutation('home/user/held', { includeMissingAncestors: true });
  const interrupted = await listInterruptedClones(storage, 2);
  assert.deepEqual(interrupted.map((r) => r.jobId).sort(), ['job-11', 'job-7', 'job-9'], 'earlier generations\' records');
  const reserved = reserveInterruptedClones(vfs, interrupted);
  assert.deepEqual(reserved.map(({ record: r }) => r.jobId).sort(), ['job-11', 'job-7'], 'the leased destination is not reserved');
  // The first write after the reset: refused while the cleanup holds the destination.
  assert.throws(() => user.writeFile('home/user/repo/first.txt', 'first'), (error) => error?.code === 'EBUSY', 'a write into a reserved destination');
  let slices = 0;
  const outcomes = await finishReservedClones(vfs, storage, reserved, { sliceEntries: 4, yieldBetween: async () => { slices++; } });
  assert.deepEqual(outcomes.map((o) => o.outcome), ['removed', 'removed']);
  assert.ok(slices > 2, `in slices (${slices})`);
  assert.equal(user.exists('home/user/repo'), false, 'the next generation finished it');
  user.mkdir('home/user/repo');
  user.writeFile('home/user/repo/first.txt', 'first');
  assert.equal(user.readFileString('home/user/repo/first.txt'), 'first', 'then the write lands, and stays');
  assert.ok(user.exists('home/user/live/.git/nimbus-clone-job') && user.exists('home/user/held/.git/nimbus-clone-job'));
  assert.deepEqual((await listCloneJobs(storage)).map((r) => r.jobId).sort(), ['job-8', 'job-9']);
  vfs.releaseExclusiveMutation(held.owner);
  console.log('  ok  a cleanup cut short: reserved and finished by the next generation, the first write refused until then; a running clone and a leased destination left');
}

// ── slices of one entry over targets partly gone ──
{
  const { user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-12', { files: 3 });
  // Staging already gone (an earlier cleanup got past it); five temporary packs left.
  for (const name of ['batch-0', 'index-gitlinks']) user.unlink('home/user/repo/.git/nimbus-clone/' + name);
  user.rmdir('home/user/repo/.git/nimbus-clone');
  for (let i = 0; i < 4; i++) user.writeFile(`home/user/repo/.git/objects/pack/tmp_pack_job-12_x${i}.pack`, 't');
  const job = record('home/user/repo', 'job-12', { phase: 'checkout' });
  await writeCloneJob(storage, job);
  let yields = 0;
  const done = await cleanUpClone(user, storage, job, {
    sliceEntries: 1,
    // Bounded: a cleanup that spends its slices on what is gone never ends.
    yieldBetween: async () => { if (++yields > 20) throw new Error('the cleanup does not end'); },
  });
  assert.equal(done.outcome, 'kept-repo');
  assert.equal(done.slices, 5, `one slice per removal (${JSON.stringify(done)})`);
  assert.deepEqual(list(user, 'home/user/repo/.git/objects/pack'), ['pack-1.idx', 'pack-1.pack'], 'every temporary pack went');
  console.log(`  ok  slices of one entry over targets partly gone: ${done.slices} slices, absent ones free`);
}

// ── a listing that fails: every write held, named, until a retry lists the records ──
{
  const { vfs, user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-20');
  user.writeFile('home/user/notes.txt', 'mine');
  await writeCloneJob(storage, record('home/user/repo', 'job-20', { generation: 1 }));
  const list = storage.list;
  // The three attempts as the session starts fail, and the first background retry; the next succeeds.
  let failures = 4;
  storage.list = async (options) => {
    if (failures-- > 0) throw new Error('storage unavailable');
    return await list.call(storage, options);
  };
  const recovery = new CloneRecovery(storage, 2, { attempts: 3, delayMs: 1, maxDelayMs: 1, backgroundMs: 10_000 });
  assert.equal(await recovery.discover(), false, 'no listing: discovery says so');
  const tasks = [];
  recovery.start(vfs, (task) => tasks.push(task));
  assert.throws(() => user.writeFile('home/user/new.txt', 'x'),
    (error) => error?.code === 'EBUSY' && error.message.includes(RECOVERY_FENCE_REASON), 'a public write is refused, named');
  assert.throws(() => user.unlink('home/user/notes.txt'), (error) => error?.code === 'EBUSY', 'and a removal');
  assert.equal(user.readFileString('home/user/notes.txt'), 'mine', 'nothing is lost');
  await Promise.all(tasks);
  assert.equal(failures, -1, 'the retry listed the records');
  assert.equal(user.exists('home/user/repo'), false, 'and the cut-short clone was cleaned up');
  user.writeFile('home/user/new.txt', 'x');
  assert.equal(user.readFileString('home/user/new.txt'), 'x', 'writes are served again');
  assert.deepEqual(await listCloneJobs(storage), []);

  // A listing that keeps failing past the background retries: the hold stays.
  storage.list = async () => { throw new Error('storage unavailable'); };
  const { vfs: vfs2, user: user2 } = session();
  const stuck = new CloneRecovery(storage, 3, { attempts: 2, delayMs: 1, maxDelayMs: 1, backgroundMs: 5 });
  assert.equal(await stuck.discover(), false);
  const stuckTasks = [];
  stuck.start(vfs2, (task) => stuckTasks.push(task));
  await Promise.all(stuckTasks);
  assert.throws(() => user2.writeFile('home/user/late.txt', 'x'), (error) => error?.code === 'EBUSY', 'still held');
  console.log('  ok  a listing that fails: every write refused (named), nothing lost; served again once a retry lists the records, held while none does');
}

// ── a clone on a mount: reserved at its recorded root, cleaned up through the namespace ──
{
  const { vfs, storage } = session();
  const files = new ProcessFiles(vfs);
  const mount = new MemoryVFS({ uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid });
  files.vfs.mount('/mnt/data', mount);
  const ns = files.view({ pid: 9, cred: CRED_SESSION_USER });
  for (const path of ['/mnt/data/repo/.git/objects/pack', '/mnt/data/repo/src/deep']) await ns.mkdir(path, { recursive: true });
  await ns.writeFile('/mnt/data/repo/.git/nimbus-clone-job', JSON.stringify({ version: 1, jobId: 'job-30', optionsHash: 'h' }));
  for (let i = 0; i < 9; i++) await ns.writeFile(`/mnt/data/repo/src/deep/f${i}`, String(i));
  await ns.writeFile('/mnt/data/mine.txt', 'mine');
  await writeCloneJob(storage, record('/mnt/data/repo', 'job-30', { generation: 1, root: '/mnt/data/repo', mount: true }));
  const recovery = {
    as: (cred, options) => vfs.as(cred, options),
    releaseExclusiveMutation: (owner) => vfs.releaseExclusiveMutation(owner),
    namespace: (cred, owner) => {
      const host = files.openHost(cred);
      return { fs: bridgeCleanupFs(host.fs.synchronous, owner), dispose: () => host.dispose() };
    },
  };
  const reserved = reserveInterruptedClones(recovery, await listInterruptedClones(storage, 2));
  assert.equal(reserved.length, 1);
  await assert.rejects(ns.writeFile('/mnt/data/repo/late.txt', 'x'), /EBUSY/, 'a write there is refused while it is reserved');
  await ns.writeFile('/mnt/data/mine.txt', 'still mine');
  const outcomes = await finishReservedClones(recovery, storage, reserved, { sliceEntries: 3, yieldBetween: async () => {} });
  assert.deepEqual(outcomes.map((o) => o.outcome), ['removed']);
  assert.equal(await ns.stat('/mnt/data/repo'), null, 'the clone on the mount is gone');
  assert.equal(new TextDecoder().decode(await ns.readFile('/mnt/data/mine.txt')), 'still mine', 'and nothing else on it');
  assert.deepEqual(await listCloneJobs(storage), []);
  console.log('  ok  a clone on a mount: reserved at its recorded root, cleaned up through the namespace, nothing else touched');
}

// ── a recovery whose namespace fails: its lease released, its record kept, the rest done ──
// (Red before: a namespace that could not be made threw before the protected
// block, and a disposal that failed threw before the release: either left
// the destination reserved, and the records after it undone.)
{
  const { vfs, storage } = session();
  const files = new ProcessFiles(vfs);
  const mount = new MemoryVFS({ uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid });
  files.vfs.mount('/mnt/data', mount);
  const ns = files.view({ pid: 10, cred: CRED_SESSION_USER });
  for (const name of ['unmade', 'undisposed', 'fine']) {
    await ns.mkdir(`/mnt/data/${name}/.git`, { recursive: true });
    await ns.writeFile(`/mnt/data/${name}/.git/nimbus-clone-job`, JSON.stringify({ version: 1, jobId: name, optionsHash: 'h' }));
    await ns.writeFile(`/mnt/data/${name}/f`, 'x');
    await writeCloneJob(storage, record(`/mnt/data/${name}`, name, { generation: 1, root: `/mnt/data/${name}`, mount: true }));
  }
  const recovery = {
    as: (cred, options) => vfs.as(cred, options),
    releaseExclusiveMutation: (owner) => vfs.releaseExclusiveMutation(owner),
    namespace: (cred, owner) => {
      // Asked in record order: the first cannot be made, the second's disposal fails.
      const asked = ++recovery.asked;
      if (asked === 1) throw new Error('no host bridge');
      const host = files.openHost(cred);
      return {
        fs: bridgeCleanupFs(host.fs.synchronous, owner),
        dispose: async () => { await host.dispose(); if (asked === 2) throw new Error('dispose failed'); },
      };
    },
    asked: 0,
  };
  const records = (await listInterruptedClones(storage, 2)).sort((a, b) => ['unmade', 'undisposed', 'fine'].indexOf(a.jobId) - ['unmade', 'undisposed', 'fine'].indexOf(b.jobId));
  const reserved = reserveInterruptedClones(recovery, records);
  assert.equal(reserved.length, 3);
  await assert.rejects(finishReservedClones(recovery, storage, reserved, { yieldBetween: async () => {} }), /no host bridge/, 'the first failure is reported');
  // Every lease released: a write in each destination goes through.
  for (const name of ['unmade', 'undisposed', 'fine']) {
    await ns.mkdir(`/mnt/data/${name}`, { recursive: true });
    await ns.writeFile(`/mnt/data/${name}/after.txt`, 'x');
  }
  assert.equal(await ns.stat('/mnt/data/fine/f'), null, 'the record after the failures was cleaned up');
  assert.equal(await ns.stat('/mnt/data/undisposed/f'), null, 'and the one whose disposal failed');
  assert.notEqual(await ns.stat('/mnt/data/unmade/.git/nimbus-clone-job'), null, 'the one whose namespace was not made is as it was');
  assert.deepEqual((await listCloneJobs(storage)).map((r) => r.jobId).sort(), ['unmade'], 'its record stays; the disposed one\'s cleanup was done');
  console.log('  ok  a recovery whose namespace cannot be made, or whose disposal fails: every lease released, the rest cleaned up');
}

// ── as the record's credential ──
{
  const { vfs, user, storage } = session();
  cloneTree(user, 'home/user/repo', 'job-10');
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo/src/root-owned');
  kernel.writeFile('home/user/repo/src/root-owned/x', 'x');
  kernel.chmod('home/user/repo/src/root-owned', 0o755);
  const job = record('home/user/repo', 'job-10');
  await writeCloneJob(storage, job);
  await assert.rejects(cleanUpClone(user, storage, job, { yieldBetween: async () => {} }), (error) => error?.code === 'EACCES');
  assert.equal((await listCloneJobs(storage)).length, 1, 'the record stays');
  console.log('  ok  as the record\'s credential: what it may not remove refuses (EACCES); the record stays');
}

console.log('git-clone-job: ok');
