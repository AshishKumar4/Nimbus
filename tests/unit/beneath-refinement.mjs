#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.CompositeBeneath (FormalModelsLane c108a812,
// lean/fixtures/beneath.json, VFS-COMP-006). Each case builds its backends as
// composite-perm-refinement does (b0 is the session's SQLite root; the rest
// are mounted where the case says), binds a process as each principal, and
// resolves `path` beneath `root` (RESOLVE_BENEATH, a WASI preopen) through the
// process bridge. The answer (the namespace path, or the errno) must be the
// model's, through both faces: the synchronous bridge over the mounts as they
// are, and a process's awaiting face with every mount asynchronous only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { modelessBackend } from './lib/composite-backends.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/beneath.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();
const creds = new Map(fixture.principals.map((p) => [p.uid, { uid: p.uid, gid: p.gid, groups: p.groups, umask: 0o022 }]));

function populate(vfs, entries, owned) {
  for (const entry of entries) {
    if (entry.kind === 'directory') vfs.mkdir(entry.path);
    else if (entry.kind === 'file') vfs.writeFile(entry.path, enc.encode(entry.bytes ?? ''));
    else vfs.symlink(entry.target, entry.path);
  }
  if (!owned) return;
  // Deepest first, so a parent's chmod never stands in the way of its children.
  for (const entry of [...entries].reverse()) {
    if (entry.kind === 'symlink') continue;
    vfs.chown(entry.path, entry.uid, entry.gid);
    vfs.chmod(entry.path, entry.mode);
  }
}

function backend(spec) {
  if (spec.kind === 'sqlite') {
    const harness = createSqliteVfsTestHarness();
    const engine = new SqliteVFS(harness.sql, harness.ctx);
    const root = engine.as(CRED_KERNEL);
    const rel = (p) => p.replace(/^\/+/, '');
    populate({
      mkdir: (p) => root.mkdir(rel(p)),
      writeFile: (p, b) => root.writeFile(rel(p), b),
      symlink: (t, p) => root.symlink(t, rel(p)),
      chown: (p, u, g) => root.chown(rel(p), u, g),
      chmod: (p, m) => root.chmod(rel(p), m),
    }, spec.entries, true);
    return engine;
  }
  const memory = new MemoryVFS();
  populate(memory, spec.entries, false);
  return modelessBackend(memory);
}

// A model path must reach the same identity as the kernel's stat. A missing
// leaf is distinguished by briefly creating it through the kernel, then
// repeating the original principal's lookup before removing the marker.
const identity = (stat) => (stat === null ? null : `${stat.dev}:${stat.ino}:${stat.type}`);
async function answer(proc, kernel, step, namespace, face) {
  const beneath = { root: step.root, path: step.path, beneath: true };
  let reached;
  try {
    reached = await proc.stat(beneath, { followSymlinks: step.follow });
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    return { error: error.code };
  }
  // stat's contract: a resolution that finds a component missing (the
  // model's ENOENT) answers null, as a string path does.
  if (step.expect.error === 'ENOENT') return reached === null ? step.expect : { reached: identity(reached) };
  if ('error' in step.expect) return { reached: identity(reached) };
  // Followed as the step follows: a model path the walk handed to a backend
  // that resolves its own paths (resolvesPaths) may end in a link the
  // backend follows; anywhere else a followed model path is no link.
  const expected = await kernel.stat(step.expect.path, { followSymlinks: step.follow });
  if (identity(reached) !== identity(expected)) return { reached: identity(reached), model: identity(expected) };
  if (reached === null) {
    assert.equal(await kernel.stat(step.expect.path, { followSymlinks: false }), null, 'the marker must not replace a leaf');
    let marker;
    let overlay;
    try {
      try { marker = await kernel.open(step.expect.path, { write: true, create: true, exclusive: true }); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = step.expect.path.slice(0, step.expect.path.lastIndexOf('/')) || '/';
        if (!namespace.isAboveMount(parent)) throw error;
        const directory = await kernel.stat(parent);
        assert.equal(directory?.type, 'directory');
        // This directory exists only to hold descendant mounts. Give its
        // marker a temporary backend with the same search permissions.
        const memory = new MemoryVFS({ uid: directory.uid, gid: directory.gid });
        memory.chmod('/', directory.mode);
        namespace.mount(parent, face === 'awaiting' ? asyncOnly(memory, { deep: true }) : memory);
        overlay = parent;
        marker = await kernel.open(step.expect.path, { write: true, create: true, exclusive: true });
      }
      const observed = await proc.stat(beneath, { followSymlinks: step.follow });
      if (identity(observed) !== identity(marker.stat)) return { reached: identity(observed), marker: identity(marker.stat) };
    } finally {
      try {
        if (marker) {
          try { await kernel.close(marker.id); }
          finally { await kernel.unlink(step.expect.path); }
        }
      } finally { if (overlay) namespace.unmount(overlay); }
    }
  }
  if (reached !== null && step.follow && reached.type !== 'symlink') {
    const path = await proc.realpath(beneath);
    if (path !== step.expect.path) return { realpath: path };
  }
  return step.expect;
}

const failures = [];
let steps = 0;
for (const face of ['synchronous', 'awaiting']) for (const [index, testCase] of fixture.cases.entries()) {
  const backends = Object.fromEntries(Object.entries(testCase.backends).map(([name, spec]) => [name, backend(spec)]));
  const files = new ProcessFiles(backends.b0);
  // A mounted SQLite backend is its files as the kernel, as in composite-perm.
  const source = (name) => (backends[name] instanceof SqliteVFS ? sqliteFiles(backends[name], CRED_KERNEL) : backends[name]);
  files.vfs.unmount('/proc');
  files.vfs.unmount('/dev');
  for (const mount of testCase.mounts) {
    files.vfs.mount(mount.point, face === 'synchronous' ? source(mount.backend) : asyncOnly(source(mount.backend), { deep: true }), { resolvesPaths: mount.resolvesPaths === true });
  }
  const bind = (binding) => (face === 'synchronous' ? files.bind(binding).synchronous : files.bind(binding));
  const kernel = bind({ pid: 1, cred: CRED_KERNEL });
  let pid = 2;
  if (index === 0) {
    const proc = bind({ pid: pid++, cred: creds.get(2) });
    const child = new MemoryVFS();
    files.vfs.mount('/marker-parent/m', face === 'awaiting' ? asyncOnly(child, { deep: true }) : child);
    try {
      const parent = await kernel.stat('/marker-parent');
      const descendant = await kernel.stat('/marker-parent/m');
      for (const step of [
        { root: '/a', path: 'm/gone', follow: true, expect: { path: '/a/none' } },
        { root: '/marker-parent', path: 'none', follow: false, expect: { path: '/marker-parent/none' } },
      ]) {
        const wrong = { ...step, expect: { path: `${step.root}/other-absent-leaf` } };
        const beneath = { root: step.root, path: step.path, beneath: true };
        assert.equal(await proc.stat(beneath), null, `${face}: the leaf starts absent`);
        for (const probe of [step, wrong]) {
          assert.equal(await kernel.stat(probe.expect.path, { followSymlinks: false }), null);
          const got = await answer(proc, kernel, probe, files.vfs, face);
          if (probe === step) assert.deepEqual(got, probe.expect, `${face}: the correct absent leaf agrees`);
          else assert.notDeepEqual(got, probe.expect, `${face}: a wrong absent leaf must be rejected`);
          assert.equal(await kernel.stat(probe.expect.path, { followSymlinks: false }), null, `${face}: the marker is removed`);
          assert.equal(await proc.stat(beneath), null, `${face}: probing leaves the leaf absent`);
          assert.deepEqual(await kernel.stat('/marker-parent'), parent, `${face}: the synthesized parent is restored`);
          assert.deepEqual(await kernel.stat('/marker-parent/m'), descendant, `${face}: a descendant mount is unchanged`);
        }
      }
    } finally { files.vfs.unmount('/marker-parent/m'); }
  }
  for (const [at, step] of testCase.steps.entries()) {
    steps++;
    const proc = bind({ pid: pid++, cred: creds.get(step.as) });
    let got;
    try { got = await answer(proc, kernel, step, files.vfs, face); }
    catch (error) { throw new Error(`${face} case ${index} step ${at}: ${JSON.stringify(step)}`, { cause: error }); }
    if (JSON.stringify(got) !== JSON.stringify(step.expect)) {
      failures.push(`${face} case ${index} step ${at}: uid ${step.as} beneath ${step.root} ${JSON.stringify(step.path)} follow=${step.follow}: got ${JSON.stringify(got)}, model ${JSON.stringify(step.expect)}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, 20)) console.log(`FAIL ${failure}`);
  console.log(`beneath-refinement: ${failures.length} of ${steps} steps disagree with the model`);
  process.exit(1);
}
console.log(`beneath-refinement: ${steps} steps in ${fixture.cases.length} cases agree with the model, through both faces`);
