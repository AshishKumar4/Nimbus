#!/usr/bin/env bun
// A resident node process never reports a stat the authority did not give.
//
// A uid-1000 process that stats a root-owned 0644 file sees uid 0 and 0644,
// wherever the sync view learned of the file: the namespace, its module map,
// its data plan, or bytes it holds under that name. It cannot write the
// file: writeFileSync throws EACCES synchronously and the authority's bytes
// are untouched. A file the process creates itself shows its real owner
// (the process's uid and gid) and the mode its umask leaves (0666 & ~umask).
//
// The shims used to fabricate the reader's own ownership and an invented
// mode for any path they had no metadata row for (bundle content, directories
// from the spawn-time manifest, capped-out files, pending own writes), so a
// root-owned file read as the reader's own and writable.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  CRED,
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  sleep,
} from './lib/resident-body.mjs';

const APP = 'home/user/app';
const ROOT_FILE = `${APP}/root-owned.json`;
const ROOT_DIR = `${APP}/etc-like`;

const PROGRAM = `
const fs = require("fs");
const t = (f) => { try { return f(); } catch (e) { return "ERR:" + e.code; } };
const own = (p) => t(() => { const s = fs.statSync(p); return { uid: s.uid, gid: s.gid, mode: (s.mode & 0o7777).toString(8), dir: s.isDirectory() }; });
globalThis.__probe = {
  fs, t, own,
  resume: (f) => new Promise((resolve) => setTimeout(() => resolve(t(f)), 0)),
  // process.exit unwinds by throwing in the facet; the exit report follows.
  exit: () => { try { process.exit(0); } catch {} },
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot({ inBundle = false, inPlan = true, tmp = false, overrides = {} } = {}) {
  const authority = createAuthority();
  const root = authority.rawVfs.as(CRED_KERNEL);
  if (tmp) {
    root.mkdir('tmp', { recursive: true });
    root.chown('tmp', 0, 0);
    root.chmod('tmp', 0o1777);
    root.writeFile('tmp/theirs', 'root secret');
    root.chmod('tmp/theirs', 0o644);
  }
  authority.kfs.mkdir(APP, { recursive: true, mode: 0o755 });
  root.writeFile(ROOT_FILE, '{"root":true}');
  root.chmod(ROOT_FILE, 0o644);
  root.mkdir(ROOT_DIR, { mode: 0o755 });
  root.chmod(ROOT_DIR, 0o755);
  root.writeFile(`${ROOT_DIR}/conf`, 'c');
  const { supervisor, log } = facetSupervisor(authority, overrides);
  // The spawn-time tables a launch ships without a metadata row: what the
  // shims used to fill in with the reader's own ownership.
  const bundle = inBundle ? { [ROOT_FILE]: '{"root":true}' } : {};
  const manifest = { [APP]: ['root-owned.json', 'etc-like'], [ROOT_DIR]: ['conf'] };
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: supervisor },
    bundle,
    manifest,
    dataPlan: inPlan ? [ROOT_FILE, `${ROOT_DIR}/conf`] : [],
    cursor: authority.cursor(),
  });
  return { authority, probe: globalThis.__probe, log };
}

const rootOwned = { uid: 0, gid: 0, mode: '644', dir: false };

await runScenarios(import.meta.path, {
  async 'a root-owned file in the data plan stats as root-owned 0644'() {
    const { probe } = await boot();
    assert.deepEqual(probe.own(`/${ROOT_FILE}`), rootOwned);
    assert.deepEqual(probe.own(`/${ROOT_DIR}`), { uid: 0, gid: 0, mode: '755', dir: true });
  },

  async 'a root-owned file in the module map stats as root-owned 0644'() {
    const { probe } = await boot({ inBundle: true, inPlan: false });
    assert.deepEqual(probe.own(`/${ROOT_FILE}`), rootOwned);
  },

  async 'the process cannot write a root-owned file, locally or at the authority'() {
    const { authority, probe } = await boot({ inBundle: true });
    assert.equal(probe.t(() => probe.fs.writeFileSync(`/${ROOT_FILE}`, 'pwned')), 'ERR:EACCES');
    assert.equal(probe.fs.readFileSync(`/${ROOT_FILE}`, 'utf8'), '{"root":true}', 'the local view kept the root bytes');
    assert.deepEqual(probe.own(`/${ROOT_FILE}`), rootOwned, 'and the root ownership');
    await probe.resume(() => null);
    await sleep(50);
    assert.equal(authority.read(ROOT_FILE), '{"root":true}', 'the authority was not written');
    assert.equal(probe.t(() => probe.fs.appendFileSync(`/${ROOT_FILE}`, 'x')), 'ERR:EACCES');
    assert.equal(probe.t(() => probe.fs.openSync(`/${ROOT_FILE}`, 'r+')), 'ERR:EACCES');
    assert.equal(probe.t(() => probe.fs.writeFileSync(`/${ROOT_DIR}/new`, 'x')), 'ERR:EACCES', 'nor create in a root-owned directory');
    assert.equal(probe.t(() => probe.fs.chmodSync(`/${ROOT_FILE}`, 0o777)), 'ERR:EPERM', 'nor chmod it');
    assert.equal(probe.t(() => probe.fs.chownSync(`/${ROOT_FILE}`, CRED.uid, CRED.gid)), 'ERR:EPERM', 'nor take it');
    assert.deepEqual(probe.own(`/${ROOT_FILE}`), rootOwned);
    assert.equal(probe.t(() => probe.fs.writeFileSync(`/${ROOT_FILE}`, 'pwned')), 'ERR:EACCES');
  },

  async 'a write the stale local view allowed is refused by the authority, and not read back'() {
    // The process's view says the file is its own; a peer (root) takes it
    // before the next barrier. The local check passes on the stale view; the
    // authority is the backstop, and the process must not go on reading
    // bytes the authority refused.
    const { authority, probe, log } = await boot();
    authority.kfs.writeFile(`${APP}/was-mine.txt`, 'original');
    await probe.resume(() => null);
    const root = authority.rawVfs.as(CRED_KERNEL);
    root.chown(`${APP}/was-mine.txt`, 0, 0);
    root.chmod(`${APP}/was-mine.txt`, 0o644);
    const accepted = probe.t(() => probe.fs.writeFileSync(`/${APP}/was-mine.txt`, 'pwned'));
    // Whatever the local answer, the write-back meets the authority.
    await probe.resume(() => null);
    await sleep(50);
    assert.equal(authority.read(`${APP}/was-mine.txt`), 'original', 'the authority refused it');
    const after = await probe.resume(() => probe.fs.readFileSync(`/${APP}/was-mine.txt`, 'utf8'));
    assert.notEqual(after, 'pwned', `the process reads the authority's bytes or the refusal, not its own (local: ${accepted})`);
    assert.deepEqual(await probe.resume(() => probe.own(`/${APP}/was-mine.txt`)), rootOwned, 'and the authority\'s owner');
    // The sync writer never saw the refusal, so it is retained for the next
    // durability boundary and the exit report, not dropped as a caught verdict.
    // The exit drain reports it: the process does not exit clean.
    probe.exit();
    for (let i = 0; i < 50 && log.exit === null; i++) await sleep(20);
    assert.ok(log.exit !== null && (log.exit.code !== 0 || /EACCES/.test(String(log.exit.reason) + log.stderr)),
      `the refusal reached the exit report: ${JSON.stringify(log.exit)} ${log.stderr.slice(-200)}`);
  },

  // /tmp, which the namespace manifest covers like any directory: a name
  // someone else owns is KNOWN, so the refusals are local and POSIX's, and a
  // genuinely new name is its creator's at once.
  async 'a foreign file in /tmp is known: writing, removing or changing it is refused locally'() {
    const { authority, probe } = await boot({ tmp: true });
    const theirs = '/tmp/theirs';
    assert.deepEqual(probe.own(theirs), rootOwned);
    assert.equal(probe.t(() => probe.fs.writeFileSync(theirs, 'pwned')), 'ERR:EACCES');
    assert.equal(probe.t(() => probe.fs.unlinkSync(theirs)), 'ERR:EPERM', 'sticky /tmp: only the owner removes it');
    assert.equal(probe.t(() => probe.fs.renameSync(theirs, '/tmp/stolen')), 'ERR:EPERM');
    assert.equal(probe.t(() => probe.fs.chmodSync(theirs, 0o777)), 'ERR:EPERM');
    assert.deepEqual(probe.own(theirs), rootOwned, 'the view is unchanged');
    await probe.resume(() => null);
    await sleep(50);
    assert.equal(authority.read('tmp/theirs'), 'root secret');
  },

  async 'a new name in /tmp is its creator\'s at once: chmod, rename and unlink in the same tick'() {
    const { authority, probe } = await boot({ tmp: true });
    assert.equal(probe.t(() => {
      probe.fs.writeFileSync('/tmp/mine', 'mine');
      probe.fs.chmodSync('/tmp/mine', 0o600);
      const st = probe.own('/tmp/mine');
      probe.fs.renameSync('/tmp/mine', '/tmp/mine2');
      probe.fs.writeFileSync('/tmp/gone', 'x');
      probe.fs.unlinkSync('/tmp/gone');
      return JSON.stringify(st);
    }), JSON.stringify({ uid: CRED.uid, gid: CRED.gid, mode: '600', dir: false }));
    await probe.resume(() => null);
    await sleep(50);
    assert.equal(authority.read('tmp/mine2'), 'mine');
    assert.equal(authority.rawVfs.as(CRED_KERNEL).exists('tmp/gone'), false);
  },

  async 'a directory the view learns of by a later delta is as known as one listed at launch'() {
    const { authority, probe } = await boot({ tmp: true });
    const root = authority.rawVfs.as(CRED_KERNEL);
    root.mkdir('tmp/late', { mode: 0o755 });
    root.chmod('tmp/late', 0o755);
    root.writeFile('tmp/late/theirs', 'late secret');
    root.chmod('tmp/late/theirs', 0o644);
    root.mkdir('tmp/shared', { mode: 0o1777 });
    root.chmod('tmp/shared', 0o1777);
    root.writeFile('tmp/shared/theirs', 'shared secret');
    root.chmod('tmp/shared/theirs', 0o644);
    await probe.resume(() => null);
    assert.deepEqual(probe.own('/tmp/late/theirs'), rootOwned);
    assert.equal(probe.t(() => probe.fs.writeFileSync('/tmp/late/theirs', 'pwned')), 'ERR:EACCES');
    assert.equal(probe.t(() => probe.fs.writeFileSync('/tmp/late/new', 'x')), 'ERR:EACCES', 'no create in a root 0755 directory');
    assert.equal(probe.t(() => probe.fs.unlinkSync('/tmp/shared/theirs')), 'ERR:EPERM');
    assert.equal(probe.t(() => probe.fs.chmodSync('/tmp/shared/theirs', 0o777)), 'ERR:EPERM');
    probe.fs.writeFileSync('/tmp/shared/mine', 'm');
    assert.equal(probe.t(() => probe.fs.chmodSync('/tmp/shared/mine', 0o600)), undefined);
  },

  async 'a name a peer creates after the last delta: the write is refused at write-back, reported, and not ours past the next barrier'() {
    const { authority, probe, log } = await boot({ tmp: true });
    await probe.resume(() => null);
    const root = authority.rawVfs.as(CRED_KERNEL);
    root.writeFile('tmp/raced', 'theirs');
    root.chmod('tmp/raced', 0o644);
    // No barrier since: the view still says the name is free, a creation.
    assert.equal(probe.t(() => probe.fs.writeFileSync('/tmp/raced', 'ours')), undefined);
    await probe.resume(() => null);
    await sleep(50);
    assert.equal(authority.read('tmp/raced'), 'theirs', 'the authority refused it');
    const after = await probe.resume(() => probe.fs.readFileSync('/tmp/raced', 'utf8'));
    assert.notEqual(after, 'ours', 'never served as ours past the barrier');
    assert.deepEqual(await probe.resume(() => probe.own('/tmp/raced')), rootOwned);
    assert.equal(await probe.resume(() => probe.t(() => probe.fs.unlinkSync('/tmp/raced'))), 'ERR:EPERM', 'nor removable as ours');
    probe.exit();
    for (let i = 0; i < 50 && log.exit === null; i++) await sleep(20);
    assert.ok(log.exit !== null && (log.exit.code !== 0 || /EACCES/.test(String(log.exit.reason) + log.stderr)),
      `the refusal reached the exit report: ${JSON.stringify(log.exit)}`);
  },

  async "rewriting an existing file keeps its owner and mode"() {
    const { authority, probe } = await boot();
    authority.kfs.writeFile(`${APP}/private.txt`, 'p');
    authority.kfs.chmod(`${APP}/private.txt`, 0o600);
    await probe.resume(() => null);
    probe.fs.writeFileSync(`/${APP}/private.txt`, 'rewritten');
    const kept = { uid: CRED.uid, gid: CRED.gid, mode: '600', dir: false };
    assert.deepEqual(probe.own(`/${APP}/private.txt`), kept, 'before the write-back');
    await probe.resume(() => null);
    await sleep(50);
    assert.deepEqual(await probe.resume(() => probe.own(`/${APP}/private.txt`)), kept, 'after it');
  },

  async 'a peer name the authority will not describe is asked for once, and the own write is not refused'() {
    // lstat answers without owner, group or mode for the peer's new name: the
    // view keeps no record of it, does not re-ask at every barrier, and does
    // not list it as a name without a record (which would refuse the
    // process's own write to it as a miss).
    let lstats = 0;
    const { authority, probe } = await boot({
      overrides: {
        lstat: async (path) => {
          if (String(path).endsWith('/peer.txt')) { lstats++; return { type: 'file', size: 1 }; }
          return authority.host.supervisorOp({ op: 'lstat', args: [path] });
        },
      },
    });
    authority.kfs.writeFile(`${APP}/peer.txt`, 'p');
    await probe.resume(() => null);
    await probe.resume(() => null);
    assert.ok(lstats <= 1, `asked ${lstats} times over two barriers`);
    assert.equal(probe.t(() => probe.fs.writeFileSync(`/${APP}/peer.txt`, 'mine')), undefined, 'its own write is not refused as a miss');
  },

  async 'a peer name whose lstat fails is not asked again at every barrier'() {
    let lstats = 0;
    const { authority, probe } = await boot({
      overrides: {
        lstat: async (path) => {
          if (String(path).endsWith('/peer.txt')) { lstats++; throw new Error('Network connection lost.'); }
          return authority.host.supervisorOp({ op: 'lstat', args: [path] });
        },
      },
    });
    authority.kfs.writeFile(`${APP}/peer.txt`, 'p');
    await probe.resume(() => null);
    await probe.resume(() => null);
    await probe.resume(() => null);
    assert.ok(lstats <= 1, `asked ${lstats} times over three barriers`);
    assert.equal(probe.t(() => probe.fs.writeFileSync(`/${APP}/peer.txt`, 'mine')), undefined);
  },

  async "the process's own new file and directory show its real ownership and umask"() {
    const { authority, probe } = await boot();
    probe.fs.writeFileSync(`/${APP}/mine.txt`, 'mine');
    probe.fs.mkdirSync(`/${APP}/mine-dir`);
    const umask = CRED.umask;
    const file = { uid: CRED.uid, gid: CRED.gid, mode: (0o666 & ~umask).toString(8), dir: false };
    const dir = { uid: CRED.uid, gid: CRED.gid, mode: (0o777 & ~umask).toString(8), dir: true };
    assert.deepEqual(probe.own(`/${APP}/mine.txt`), file, 'before the write-back');
    assert.deepEqual(probe.own(`/${APP}/mine-dir`), dir);
    await probe.resume(() => null);
    await sleep(50);
    assert.deepEqual(await probe.resume(() => probe.own(`/${APP}/mine.txt`)), file, 'after it, from the authority');
    const at = authority.rawVfs.as(CRED_KERNEL).stat(`${APP}/mine.txt`);
    assert.deepEqual([at.uid, at.gid, (at.mode & 0o7777).toString(8)], [CRED.uid, CRED.gid, file.mode]);
  },
});
