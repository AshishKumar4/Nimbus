#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.Composite.exec
// (lean/fixtures/composite-vfs.json). Each case builds its backends as fresh
// in-memory filesystems, a CompositeVFS over the root one with each mount's
// source answering its backend only to the listed principals, runs every
// step as its principal, and requires the model's answer; then every
// backend's tree, read directly, must be the model's final tree. The rules it
// pins: absence through any null mount on a path, mount points and their
// ancestors covering root links, root links followed at the right
// components, and the refusal order ENXIO, EBUSY, EXDEV, backend.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = new URL('../../packages/core/src/vfs/', import.meta.url).pathname;
const { CompositeVFS } = await import(`${src}/composite.ts`);
const { MemoryVFS } = await import(`${src}/memory.ts`);
const { isVfsError, VfsError } = await import(`${src}/vfs-error.ts`);

const fixture = JSON.parse(readFileSync(
  new URL('../../lean/fixtures/composite-vfs.json', import.meta.url), 'utf8',
));
assert.equal(fixture.fixture, 'composite-vfs');
assert.ok(fixture.cases.length > 0);
const enc = new TextEncoder();
const dec = new TextDecoder();
const credOf = (uid) => {
  const p = fixture.principals.find((q) => q.uid === uid);
  return { uid: p.uid, gid: p.gid, groups: [p.gid], umask: 0o022 };
};

/**
 * A backend with the case's capabilities: a missing one is absent from the
 * VFS (cas is both revision ops), rootMode null reports no modes, and a
 * pinned entry refuses unlink/rmdir with EBUSY (only on backends without
 * removeRecursive, so the walked removal has something to keep).
 */
function withCaps(vfs, caps) {
  if (!caps) return vfs;
  const pins = new Set((caps.pins ?? []).map((p) => `/${p}`));
  const busy = (op) => (path) => {
    if (pins.has(path)) throw new VfsError('EBUSY', 'pinned', path);
    return vfs[op](path);
  };
  const noModes = (stat) => {
    if (stat === null || caps.rootMode !== null) return stat;
    const { mode, ...rest } = stat;
    return rest;
  };
  const wrapped = {
    stat: (path, options) => noModes(vfs.stat(path, options)),
    readFile: (path) => vfs.readFile(path),
    writeFile: (path, data, options) => vfs.writeFile(path, data, options),
    readdir: (path) => vfs.readdir(path).map((entry) => ({ ...entry, stat: entry.stat && noModes(entry.stat) })),
    mkdir: (path, options) => vfs.mkdir(path, options),
    unlink: busy('unlink'),
    rmdir: busy('rmdir'),
    rename: (from, to) => vfs.rename(from, to),
    symlink: (target, path) => vfs.symlink(target, path),
    readlink: (path) => vfs.readlink(path),
    chmod: (path, mode) => vfs.chmod(path, mode),
    utimes: (path, a, m) => vfs.utimes(path, a, m),
    truncate: (path, size) => vfs.truncate(path, size),
    writeRange: (path, offset, bytes) => vfs.writeRange(path, offset, bytes),
  };
  if (caps.removeRecursive) wrapped.removeRecursive = (path) => vfs.removeRecursive(path);
  if (caps.readRange) wrapped.readRange = (path, offset, length) => vfs.readRange(path, offset, length);
  if (caps.cas) {
    // The model's CAS changes nothing: reaching the capability is the answer.
    wrapped.writeFileIfRevision = () => ({ ok: true, revision: 0 });
    wrapped.readFileAtRevision = () => new Uint8Array();
  }
  wrapped.sync = wrapped;
  if (caps.rootMode !== null) vfs.chmod('/', caps.rootMode);
  return wrapped;
}

function build(entries) {
  const vfs = new MemoryVFS();
  for (const entry of entries) {
    const path = `/${entry.path}`;
    if (entry.type === 'directory') vfs.mkdir(path);
    else if (entry.type === 'file') vfs.writeFile(path, enc.encode(entry.bytes));
    else vfs.symlink(entry.target, path);
  }
  return vfs;
}

function tree(vfs, dir = '/', out = []) {
  for (const entry of vfs.readdir(dir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
    const rel = path.slice(1);
    if (entry.type === 'directory') { out.push({ path: rel, type: 'directory' }); tree(vfs, path, out); }
    else if (entry.type === 'file') out.push({ path: rel, type: 'file', bytes: dec.decode(vfs.readFile(path)) });
    else out.push({ path: rel, type: 'symlink', target: vfs.readlink(path) });
  }
  return out;
}
const byPath = (entries) => [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

async function outcome(run) {
  try { return { value: await run() }; } catch (error) {
    if (!isVfsError(error)) throw error;
    return { error: error.code };
  }
}

function answer(step, got) {
  if (got.error !== undefined) return { error: got.error };
  const value = got.value;
  switch (step.op) {
    case 'stat': return value === null ? null : { type: value.type };
    case 'readdir': return { names: value.map((e) => e.name).sort() };
    case 'readFile':
    case 'readRange': return { bytes: dec.decode(value) };
    case 'removeRecursive': return { removed: value.removed, kept: value.kept };
    case 'copy': return { count: value };
    case 'writeFileIfRevision':
    case 'readFileAtRevision': return { supported: true };
    case 'statMode':
      // The model states a mode at `/`, mount points and made directories
      // only; elsewhere its stat carries none, so none is compared.
      if (value === null) return null;
      if (value.type !== 'directory' || step.expect?.mode === undefined) return { type: value.type };
      return { type: 'directory', mode: value.mode & 0o7777 };
    default: return 'ok';
  }
}

let steps = 0;
let failures = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  const backends = Object.fromEntries(Object.entries(testCase.backends).map(([name, entries]) => [name, build(entries)]));
  const views = Object.fromEntries(Object.entries(backends).map(([name, vfs]) => [name, withCaps(vfs, testCase.caps?.[name])]));
  const composite = new CompositeVFS(views.root);
  for (const mount of testCase.mounts) {
    const backend = views[mount.backend];
    composite.mount(mount.point, ({ cred }) => (mount.only === null || (cred !== null && mount.only.includes(cred.uid)) ? backend : null));
  }
  try {
    for (const [s, step] of testCase.steps.entries()) {
      steps++;
      const view = composite.as(credOf(step.as));
      const got = await outcome(() => {
        switch (step.op) {
          case 'stat': return view.stat(step.path);
          case 'readdir': return view.readdir(step.path);
          case 'readFile': return view.readFile(step.path);
          case 'writeFile': return view.writeFile(step.path, enc.encode(step.bytes));
          case 'mkdirp': return view.mkdir(step.path, { recursive: true });
          case 'mkdir': return view.mkdir(step.path);
          case 'unlink': return view.unlink(step.path);
          case 'rmdir': return view.rmdir(step.path);
          case 'rename': return view.rename(step.path, step.to);
          case 'removeRecursive': return view.removeRecursive(step.path);
          case 'readRange': return view.readRange(step.path, step.offset, step.length);
          case 'copy': return view.copy(step.path, step.to, { recursive: step.recursive });
          case 'statMode': return view.stat(step.path);
          case 'writeFileIfRevision': return view.writeFileIfRevision(step.path, enc.encode('cas'), 0);
          case 'readFileAtRevision': return view.readFileAtRevision(step.path, 0);
          default: throw new Error(`unknown op ${step.op}`);
        }
      });
      assert.deepEqual(answer(step, got), step.expect, `case ${index} step ${s} ${JSON.stringify(step)}`);
    }
    for (const [name, backend] of Object.entries(backends)) {
      if (testCase.caps?.[name]?.rootMode === null) void 0;
      assert.deepEqual(byPath(tree(backend)), byPath(testCase.final[name] ?? []), `case ${index}: backend ${name} after the steps`);
    }
  } catch (error) {
    failures++;
    if (failures <= 3) console.log(`FAIL ${error.message}`);
  }
}
if (failures > 0) { console.log(`composite-vfs-refinement: ${failures} of ${fixture.cases.length} cases disagree with the model`); process.exit(1); }
console.log(`composite-vfs-refinement: ${fixture.cases.length} cases (${steps} steps) of lean/fixtures/composite-vfs.json agree with the model`);
