#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.CompositePerm (FormalModelsLane 92ed252b,
// lean/fixtures/composite-perm.json). Each case builds its backends (SQLite
// where modes are kept, owners and modes as listed; MemoryVFS where not),
// mounts them on a CompositeVFS, and runs the steps as each principal. Every
// answer must be the model's, and every backend must end as the model's.
// The model: lookup needs search permission on each directory it leaves,
// structural ones and mount points included; a directory the root holds
// above a mount is the root's; every link resolves in the namespace, per hop.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { modelessBackend } from './lib/composite-backends.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/composite-perm.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();
const creds = new Map(fixture.principals.map((p) => [p.uid, { uid: p.uid, gid: p.gid, groups: p.groups, umask: 0o022 }]));

const aclBits = (acl) => (acl.user << 6) | (acl.group << 3) | acl.other;
const aclOf = (bits) => (bits === null ? null : { user: (bits >> 6) & 7, group: (bits >> 3) & 7, other: bits & 7 });

function build(spec) {
  const sqlite = spec.kind === 'sqlite';
  let vfs;
  if (sqlite) {
    const harness = createSqliteVfsTestHarness();
    vfs = sqliteFiles(new SqliteVFS(harness.sql, harness.ctx), CRED_KERNEL);
  } else {
    vfs = modelessBackend();
  }
  for (const entry of spec.entries) {
    if (entry.kind === 'directory') vfs.mkdir(entry.path);
    else if (entry.kind === 'file') vfs.writeFile(entry.path, enc.encode(entry.bytes ?? ''));
    else vfs.symlink(entry.target, entry.path);
  }
  if (sqlite) {
    // Deepest first: the kernel passes anyway, and a later chmod of a parent
    // never stands in the way of setting what is under it.
    for (const entry of [...spec.entries].reverse()) {
      if (entry.kind === 'symlink') continue;
      vfs.chown(entry.path, entry.uid, entry.gid);
      vfs.chmod(entry.path, entry.mode);
      if (entry.defaultAcl) vfs.credentialed.setDefaultAcl(entry.path, aclBits(entry.defaultAcl));
    }
  }
  return spec.kind === 'sqlite' ? vfs : vfs;
}

function treeOf(vfs, modes) {
  const out = [];
  const walk = (dir) => {
    for (const entry of vfs.readdir(dir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      const stat = vfs.stat(path, { follow: false });
      const row = { path, kind: stat.type };
      if (stat.type === 'file') row.bytes = dec.decode(vfs.readFile(path));
      if (stat.type === 'symlink') row.target = vfs.readlink(path);
      if (modes && stat.type !== 'symlink') Object.assign(row, { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid });
      if (modes && stat.type === 'directory') {
        const acl = aclOf(vfs.credentialed.getDefaultAcl(path));
        if (acl) row.defaultAcl = acl;
      }
      out.push(row);
      if (stat.type === 'directory') walk(path);
    }
  };
  walk('/');
  return out;
}

function comparable(rows, modes) {
  return rows.map((row) => {
    const out = { path: row.path, kind: row.kind };
    if (row.bytes !== undefined) out.bytes = row.bytes;
    if (row.target !== undefined) out.target = row.target;
    if (modes && row.kind !== 'symlink') Object.assign(out, { mode: row.mode, uid: row.uid, gid: row.gid });
    if (modes && row.defaultAcl) out.defaultAcl = row.defaultAcl;
    return out;
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function run(view, step) {
  try {
    switch (step.op) {
      case 'stat': {
        const stat = await view.stat(step.path);
        if (stat === null) return null;
        return {
          kind: stat.type,
          mode: stat.mode === undefined ? null : stat.mode & 0o7777,
          uid: stat.uid ?? null,
          gid: stat.gid ?? null,
        };
      }
      case 'readdir': return { names: (await view.readdir(step.path)).map((e) => e.name).sort() };
      case 'readFile': return { bytes: dec.decode(await view.readFile(step.path)) };
      case 'writeFile': await view.writeFile(step.path, enc.encode(step.bytes)); return 'ok';
      case 'unlink': await view.unlink(step.path); return 'ok';
      case 'mkdir': await view.mkdir(step.path); return 'ok';
      case 'rename': await view.rename(step.path, step.to); return 'ok';
      default: throw new Error(`unknown op ${step.op}`);
    }
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return { error: error.code };
  }
}

let failures = 0;
let steps = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  try {
    const backends = Object.fromEntries(Object.entries(testCase.backends).map(([name, spec]) => [name, build(spec)]));
    const vfs = new CompositeVFS(backends.b0);
    for (const mount of testCase.mounts) vfs.mount(mount.point, backends[mount.backend]);
    for (const [at, step] of testCase.steps.entries()) {
      steps++;
      const got = await run(vfs.as(creds.get(step.as)), step);
      assert.deepEqual(got, step.expect, `step ${at} ${JSON.stringify(step)}`);
    }
    for (const [name, spec] of Object.entries(testCase.backends)) {
      assert.deepEqual(
        comparable(treeOf(backends[name], spec.kind === 'sqlite'), spec.kind === 'sqlite'),
        comparable(testCase.final[name], spec.kind === 'sqlite'),
        `backend ${name} after the steps`,
      );
    }
  } catch (error) {
    failures++;
    if (failures <= 5) console.log(`FAIL case ${index}: ${error.message.split('\n')[0]} :: ${JSON.stringify(error.actual)} vs ${JSON.stringify(error.expected)}`);
  }
}
if (failures > 0) {
  console.log(`composite-perm-refinement: ${failures} of ${fixture.cases.length} cases disagree with the model`);
  process.exit(1);
}
console.log(`composite-perm-refinement: ${fixture.cases.length} cases (${steps} steps) of lean/fixtures/composite-perm.json agree with the model`);
