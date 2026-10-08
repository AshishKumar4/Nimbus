#!/usr/bin/env bun
// A file whose read a chmod or a chown revoked is refused to a synchronous
// read, whatever bytes the process already holds for it.
//
// The resident store keeps a row whose bytes did not change when only its
// revision moved, by its content key: the delta a barrier admits ("a chmod,
// a touch, a rewrite with identical content"), the reconcile of a store kept
// from an earlier launch, and a one-shot's manifest copies. Equal keys prove
// the bytes are the file's; they say nothing about who may read them. And
// readFileSync served a held row after checking only that the directories
// above it are searchable, never the file's own mode, so a running process
// went on reading a file it had just been locked out of, and so did the next
// launch over the same store.
//
// Each scenario boots the REAL resident body (tests/unit/lib/resident-body.mjs)
// as uid 1000, revokes its read of a file it holds, and reads it.

import assert from 'node:assert/strict';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  createAuthority,
  facetSql,
  facetSupervisor,
  launchResident,
  residentDataPlan,
  runScenarios,
  until,
} from './lib/resident-body.mjs';

const APP = '/home/user/app';
const SECRET = `${APP}/secret.txt`;
const KEY = SECRET.slice(1);

// Its first instructions read the file; `resume` is a timer, whose resumption
// takes a barrier before it runs.
const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const open = (p) => { try { fs.closeSync(fs.openSync(p, "r")); return "opened"; } catch (e) { return "ERR:" + e.code; } };
const resume = () => new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__probe = { fs, read, open, resume };
globalThis.__first = { read: read(${JSON.stringify(SECRET)}), open: open(${JSON.stringify(SECRET)}) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

function session() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  // Group-readable, so taking the file from its owner (chown) is what revokes it.
  authority.kfs.writeFile(KEY, 'secret', { mode: 0o640 });
  authority.kfs.writeFile('home/user/app/f.txt', 'f');
  return authority;
}

/** Each revocation, done by whoever may do it: the owner's chmod, the kernel's chown. */
const REVOKE = {
  chmod: (authority) => authority.kfs.chmod(KEY, 0o000),
  chown: (authority) => authority.rawVfs.as(CRED_KERNEL).chown(KEY, 0, 0),
};

/** A running process holding the file is refused it once a barrier reports the revocation. */
async function running(revoke) {
  const authority = session();
  const { supervisor } = facetSupervisor(authority);
  await launchResident({
    authority, program: PROGRAM, env: { SUPERVISOR: supervisor },
    dataPlan: await residentDataPlan(authority, APP), cursor: authority.cursor(),
  });
  const probe = globalThis.__probe;
  assert.deepEqual(globalThis.__first, { read: 'secret', open: 'opened' }, 'the premise: the boot fill holds the file');
  // A change that leaves it readable keeps serving it.
  authority.kfs.chmod(KEY, 0o600);
  let changed = authority.rawVfs.revision();
  await probe.resume();
  await until(() => globalThis.__nimbusVfsCursor.rev >= changed, 'the barrier reported the chmod');
  assert.equal(probe.read(SECRET), 'secret', 'a chmod that keeps the owner reading is no refusal');
  revoke(authority);
  changed = authority.rawVfs.revision();
  await probe.resume();
  await until(() => globalThis.__nimbusVfsCursor.rev >= changed, 'the barrier reported the revocation');
  assert.throws(() => probe.fs.accessSync(SECRET, probe.fs.constants.R_OK), { code: 'EACCES' },
    'the premise: the namespace says the process may no longer read it');
  assert.equal(probe.read(SECRET), 'ERR:EACCES', 'readFileSync of a file whose read was revoked');
  assert.equal(probe.open(SECRET), 'ERR:EACCES', 'openSync for reading of a file whose read was revoked');
}

/** A store kept from an earlier launch, which held the file, is reconciled before the program reads it. */
async function kept(revoke) {
  const authority = session();
  const sql = facetSql();
  const previous = new Function(
    `${FACET_RESIDENT_STORE_SOURCE}\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor, __residentSetPlan, __nsSetCred };`,
  )();
  previous.__residentBind({ storage: { sql } });
  previous.__nsSetCred({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
  previous.__residentSetPlan(await residentDataPlan(authority, APP));
  previous.__residentAdoptModuleBundle({}, authority.cursor());
  const filled = await previous.__residentSynchronizeFromSupervisor(facetSupervisor(authority).supervisor);
  assert.ok(filled.filled >= 2, 'the premise: the earlier launch held the file');
  revoke(authority);
  const { supervisor } = facetSupervisor(authority);
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: supervisor }, sql, cursor: authority.cursor() });
  assert.deepEqual(globalThis.__first, { read: 'ERR:EACCES', open: 'ERR:EACCES' }, 'the first reads, over the kept store');
}

await runScenarios(import.meta.path, {
  'a running process holding a file is refused it after a chmod revokes its read': () => running(REVOKE.chmod),
  'a running process holding a file is refused it after a chown revokes its read': () => running(REVOKE.chown),
  'a kept store holding a file does not serve it after a chmod revoked its read': () => kept(REVOKE.chmod),
  'a kept store holding a file does not serve it after a chown revoked its read': () => kept(REVOKE.chown),
});
console.log('resident-revoked-read: all tests passed');
