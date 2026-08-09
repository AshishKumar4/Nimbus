#!/usr/bin/env bun
// wasi-manifest-dir-filetype — a directory must stat as a directory, however it
// got into the filesystem.
//
// os.makedirs(path, exist_ok=True) is mkdir followed by, on EEXIST, a check
// that the path is a directory after all. If stat disagrees, makedirs re-raises
// and the caller sees FileExistsError for a directory that plainly exists —
// which is how `pip install` died against this layer while every other Python
// operation worked.
//
// The layer is shared: ruby and clang stat manifest-backed directories through
// the same classify(), so this is not a Python test that happens to live here.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { assertGeneratedSourcesAreCurrent } from './lib/generated-freshness.mjs';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

assertGeneratedSourcesAreCurrent();

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`;
const preamblePath = path.join(os.tmpdir(), `wasi-dirtype-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const ESUCCESS = 0, EEXIST = 20;
const FT_DIRECTORY = 3, FT_REGULAR_FILE = 4;
const encoder = new TextEncoder();

/** A manifest-shaped filesystem: sizes and modes, no content. */
function host() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  P.__wasiInitFS({
    root: '',
    preopens: [{ wasiPath: '/', vfsPath: '' }],
    files: {},
    // The shape manifestVfs produces for an existing subtree.
    sizes: { 'home/user/pkg/marker.txt': 12 },
    dirs: ['home', 'home/user', 'home/user/pkg', 'home/user/empty'],
    modes: {
      '': 7, home: 7, 'home/user': 7, 'home/user/pkg': 7, 'home/user/empty': 7,
      'home/user/marker.txt': 7, 'home/user/pkg/marker.txt': 7,
    },
    revision: 1,
  });
  const { wasiImport } = makeImportsWithoutJSPI(P, {
    argv: ['prog'], env: {}, getMemory: () => memory,
    stdoutWrite: () => {}, stderrWrite: () => {},
  });
  const view = () => new DataView(memory.buffer);
  const writePath = (s) => {
    const bytes = encoder.encode(s);
    new Uint8Array(memory.buffer).set(bytes, 0x100);
    return bytes.length;
  };
  return {
    wasiImport,
    view,
    /** filetype byte of path_filestat_get, or the errno if it failed. */
    filetype(p) {
      const len = writePath(p);
      const rc = wasiImport.path_filestat_get(3, 1, 0x100, len, 0x2000);
      return rc === ESUCCESS ? view().getUint8(0x2000 + 16) : `errno=${rc}`;
    },
    mkdir(p) {
      const len = writePath(p);
      return wasiImport.path_create_directory(3, 0x100, len);
    },
  };
}

// ── A directory from the manifest stats as a directory ─────────────────────
{
  const h = host();
  assert.equal(h.filetype('home/user/pkg'), FT_DIRECTORY, 'a manifest directory is a directory');
  assert.equal(h.filetype('home/user/empty'), FT_DIRECTORY, 'including one with no children');
  assert.equal(h.filetype('home/user'), FT_DIRECTORY, 'and an ancestor of one');
  assert.equal(h.filetype('home/user/pkg/marker.txt'), FT_REGULAR_FILE,
    'while a manifest file is still a regular file');
  console.log('  ok  manifest-backed directories stat as directories');
}

// ── makedirs(exist_ok=True) over an existing directory ─────────────────────
// mkdir must say EEXIST, and the stat that follows must agree it is a
// directory. Disagreement is what turns exist_ok into FileExistsError.
{
  const h = host();
  assert.equal(h.mkdir('home/user/pkg'), EEXIST, 'mkdir on an existing directory is EEXIST');
  assert.equal(h.filetype('home/user/pkg'), FT_DIRECTORY,
    'and the isdir check that follows must agree — otherwise exist_ok re-raises');
  console.log('  ok  mkdir/EEXIST and the isdir that follows agree');
}

// ── A directory created by the guest keeps its type ────────────────────────
{
  const h = host();
  assert.equal(h.mkdir('home/user/fresh'), ESUCCESS);
  assert.equal(h.filetype('home/user/fresh'), FT_DIRECTORY,
    'a directory the guest just created is a directory');
  assert.equal(h.mkdir('home/user/fresh'), EEXIST, 'and creating it again is EEXIST');
  assert.equal(h.filetype('home/user/fresh'), FT_DIRECTORY, 'still a directory afterwards');
  console.log('  ok  guest-created directories keep their filetype');
}

// ── manifestVfs must not emit a directory it gave no mode ──────────────────
// It adds every extraRoot and its ancestors to `dirs` before checking whether
// they exist, but records a mode only where vfs.stat answers. A root that does
// not exist yet — site-packages before the first install — used to arrive
// listed but modeless, and the consumer's deny-by-default (correctly) reads a
// listed-but-modeless path as mode 0. Traversal then fails, os.path.isdir
// swallows the error and answers False, and makedirs(exist_ok=True) re-raises
// FileExistsError for a directory it just created. That is the whole of why
// `pip install` could not create its target.
//
// The fix belongs to the producer: deny-by-default in the consumer is a
// security property and must not be loosened to paper over a bad manifest.
{
  const { manifestVfs } = await import('../../packages/worker/src/runtime/vfs-manifest.ts');
  const enoent = () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
  const eacces = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  const present = new Map([
    ['home', { mode: 0o755, uid: 1000, gid: 1000, type: 'dir' }],
    ['home/user', { mode: 0o755, uid: 1000, gid: 1000, type: 'dir' }],
  ]);
  const vfs = {
    cred: { uid: 1000, gid: 1000, groups: [] },
    exists: (p) => present.has(p),
    stat: (p) => {
      if (present.has(p)) return present.get(p);
      if (p.startsWith('home/user/secret')) return eacces();
      return enoent();
    },
    readdir: () => [],
    revision: () => 1,
  };
  const built = manifestVfs(vfs, 'home/user', {
    extraRoots: ['home/user/.pkgs/site-packages', 'home/user/secret/inner'],
  });
  assert.ok(!('error' in built), 'the walk should succeed');
  const { dirs, modes } = built.snapshot;

  // A root that does not exist yet is listed, so it must also be traversable.
  assert.ok(dirs.includes('home/user/.pkgs/site-packages'), 'the missing root is listed');
  for (const d of ['home/user/.pkgs', 'home/user/.pkgs/site-packages']) {
    assert.notEqual(modes[d], undefined, `${d} is listed and so must carry a mode`);
    assert.equal(modes[d] & 1, 1, `${d} must be traversable`);
  }

  // A root the caller may not read stays denied: that is the property being
  // preserved, and confusing the two is what made this a bug in the first place.
  assert.equal(modes['home/user/secret'], undefined,
    'an unreadable ancestor must stay denied by default');
  console.log('  ok  manifestVfs gives listed directories a mode, and still denies unreadable ones');
}

console.log('wasi-manifest-dir-filetype: all cases passed');
