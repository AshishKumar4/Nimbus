#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.CompositeBeneath (FormalModelsLane c108a812,
// lean/fixtures/beneath.json, VFS-COMP-006). Each case builds its backends as
// composite-perm-refinement does (b0 is the session's SQLite root; the rest
// are mounted where the case says), binds a process as each principal, and
// resolves `path` beneath `root` (RESOLVE_BENEATH, a WASI preopen) through the
// process bridge. The answer (the namespace path, or the errno) must be the
// model's, through both faces: the synchronous bridge over the mounts as they
// are, and a process's awaiting face with every mount asynchronous only.

import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

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
  // A backend that keeps no modes: its stats carry none.
  const memory = new MemoryVFS();
  populate(memory, spec.entries, false);
  const bare = (stat) => { if (stat === null) return null; const { mode, uid, gid, ...rest } = stat; return rest; };
  const vfs = Object.assign(Object.create(memory), {
    stat: (path, options) => bare(memory.stat(path, options)),
    readdir: (path) => memory.readdir(path).map((e) => ({ ...e, stat: e.stat && bare(e.stat) })),
  });
  vfs.sync = vfs;
  return vfs;
}

// What the process observes of the resolution: the stat it reaches (a
// missing last component reaches nothing, yet resolves), or the errno. A
// model path must be the same entry, by identity, as the kernel's own stat of
// that path; where it exists and the last link is followed, realpath beneath
// must also name it.
// A mount with no synchronous face: every call answers a promise.
const asyncOnly = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = target[key];
    if (typeof value !== 'function') return value;
    // A view as a principal is built at once, and is as asynchronous.
    if (key === 'as') return (...args) => asyncOnly(value.apply(target, args));
    return (...args) => Promise.resolve().then(() => value.apply(target, args));
  },
  has: (target, key) => key !== 'sync' && key in target,
});

const identity = (stat) => (stat === null ? null : `${stat.dev}:${stat.ino}:${stat.type}`);
async function answer(proc, kernel, step) {
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
    files.vfs.mount(mount.point, face === 'synchronous' ? source(mount.backend) : asyncOnly(source(mount.backend)), { resolvesPaths: mount.resolvesPaths === true });
  }
  const bind = (binding) => (face === 'synchronous' ? files.bind(binding).synchronous : files.bind(binding));
  const kernel = bind({ pid: 1, cred: CRED_KERNEL });
  let pid = 2;
  for (const [at, step] of testCase.steps.entries()) {
    steps++;
    const proc = bind({ pid: pid++, cred: creds.get(step.as) });
    const got = await answer(proc, kernel, step);
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
