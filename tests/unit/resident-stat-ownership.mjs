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
globalThis.__probe = { fs, t, own, resume: (f) => new Promise((resolve) => setTimeout(() => resolve(t(f)), 0)) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot({ inBundle = false, inPlan = true } = {}) {
  const authority = createAuthority();
  const root = authority.rawVfs.as(CRED_KERNEL);
  authority.kfs.mkdir(APP, { recursive: true, mode: 0o755 });
  root.writeFile(ROOT_FILE, '{"root":true}');
  root.chmod(ROOT_FILE, 0o644);
  root.mkdir(ROOT_DIR, { mode: 0o755 });
  root.chmod(ROOT_DIR, 0o755);
  root.writeFile(`${ROOT_DIR}/conf`, 'c');
  const { supervisor } = facetSupervisor(authority);
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
  return { authority, probe: globalThis.__probe };
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
