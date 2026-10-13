#!/usr/bin/env bun
// What a program made answers from its own record only until the session has
// it: then the session's stat does, a peer's later change included. A rename
// moves the name the record is kept under, never how long it lasts.
//
// Red before: a rename re-made the records beneath the name, unsettled, so a
// file whose write the session had already acknowledged kept its own mode
// past every later barrier, and statSync answered it over a peer's chmod
// that promises.stat reported.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan } from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs, resume: () => new Promise((resolve) => setTimeout(resolve, 0)) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const handle = facetSupervisor(authority, {});
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/app'),
    cursor: authority.cursor(),
  });
  return { authority, probe: globalThis.__probe };
}

/** A peer's chmod of `path`, then a barrier: what statSync and promises.stat each say of its mode. */
async function afterPeerChmod({ authority, probe }, path) {
  await authority.peerAs(CRED_KERNEL).chmod(path.slice(1), 0o640);
  await probe.resume();
  const mode = (stat) => (stat.mode & 0o777).toString(8);
  return [mode(probe.fs.statSync(path)), mode(await probe.fs.promises.stat(path))];
}

await runScenarios(import.meta.path, {
  async 'a file acknowledged, then its directory renamed: a peer chmod shows'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.mkdirSync('/home/user/app/tree');
    fs.writeFileSync('/home/user/app/tree/f', 'f', { mode: 0o600 });
    await fs.promises.realpath('/home/user/app/tree/f');
    fs.renameSync('/home/user/app/tree', '/home/user/app/moved');
    await fs.promises.realpath('/home/user/app/moved/f');
    assert.deepEqual(await afterPeerChmod(box, '/home/user/app/moved/f'), ['640', '640']);
  },

  async 'a file acknowledged, then renamed: a peer chmod shows'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.writeFileSync('/home/user/app/g', 'g', { mode: 0o600 });
    await fs.promises.realpath('/home/user/app/g');
    fs.renameSync('/home/user/app/g', '/home/user/app/h');
    await fs.promises.realpath('/home/user/app/h');
    assert.deepEqual(await afterPeerChmod(box, '/home/user/app/h'), ['640', '640']);
  },

  async 'a file renamed with its directory before its write is acknowledged: a peer chmod shows'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.mkdirSync('/home/user/app/early');
    fs.writeFileSync('/home/user/app/early/f', 'f', { mode: 0o600 });
    fs.renameSync('/home/user/app/early', '/home/user/app/later');
    assert.equal((fs.statSync('/home/user/app/later/f').mode & 0o777).toString(8), '600', 'its own mode until then');
    await fs.promises.realpath('/home/user/app/later/f');
    assert.deepEqual(await afterPeerChmod(box, '/home/user/app/later/f'), ['640', '640']);
  },

  async 'a tree removed and made again: a peer chmod shows'() {
    const box = await boot();
    const { fs } = box.probe;
    fs.mkdirSync('/home/user/app/again');
    fs.writeFileSync('/home/user/app/again/f', 'f', { mode: 0o600 });
    await fs.promises.realpath('/home/user/app/again/f');
    fs.rmSync('/home/user/app/again', { recursive: true });
    fs.mkdirSync('/home/user/app/again');
    fs.writeFileSync('/home/user/app/again/f', 'f2', { mode: 0o600 });
    await fs.promises.realpath('/home/user/app/again/f');
    assert.deepEqual(await afterPeerChmod(box, '/home/user/app/again/f'), ['640', '640']);
  },
});
