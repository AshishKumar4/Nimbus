#!/usr/bin/env bun
// The synchronous filesystem view is partial, and must say so.
//
// __vfsManifest is a walk of SELECTED roots — the working directory, its
// node_modules, the entry script's own package — not of the filesystem. Every
// synchronous call used to treat it as total, so a path the walk never reached
// was answered as though it had been looked for and not found:
//
//     readdirSync(dir)                    → []          (a populated directory)
//     readdirSync(dir, withFileTypes)     → []
//     existsSync(dir + '/meta.json')      → false
//     statSync(dir)                       → ENOENT
//     readFileSync(dir + '/meta.json')    → ENOENT
//
// while fs.promises.readdir on the same path in the same process returned the
// real six entries. That is the owner's invariant inverted: one process, two
// filesystems. And the empty array is the worst of them, because an array is a
// complete enumeration by definition — there is no error for a program to
// catch. A scaffolder read its template directory, was told it was empty,
// wrote nothing, and exited 0.
//
// The residency floor did not catch this: it fires on a KNOWN path with no
// resident content, and these paths are not known at all.
//
// What has to hold: never invent absence; converge the two views; and do not
// turn an ordinary missing file into a refusal, because absence inside a
// directory the walk DID enumerate is real knowledge and programs depend on it.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const enc = new TextEncoder();
const dec = new TextDecoder();

// The mapped world: the working directory the manifest walk covered.
const APP = '/home/user/app';
vfs.mkdir(APP, { recursive: true });
vfs.writeFile(`${APP}/entry.js`, enc.encode('module.exports = 1;\n'));

// The unmapped world: a real, populated tree the walk never reached. Shaped
// like the package cache a scaffolder reads its templates out of.
const TEMPLATES = '/tmp/cache/templates';
const MINIMAL = `${TEMPLATES}/minimal`;
vfs.mkdir(`${MINIMAL}/src`, { recursive: true });
vfs.writeFile(`${MINIMAL}/meta.json`, enc.encode('{"name":"minimal"}'));
vfs.writeFile(`${MINIMAL}/README.md`, enc.encode('# minimal\n'));
vfs.writeFile(`${MINIMAL}/src/main.js`, enc.encode('export default 1;\n'));
const MINIMAL_ENTRIES = ['README.md', 'meta.json', 'src'];

const supervisor = {
  readFile: async (path) => {
    const bytes = await bridge.readFile(path);
    return bytes ? dec.decode(bytes) : null;
  },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
};

// The facet's view: the app directory, and nothing else. Exactly what a walk
// rooted at the working directory produces.
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/app/entry.js': 'module.exports = 1;\n' },
  {
    'home/user/app': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    'home/user/app/entry.js': { type: 'file', size: 19, mode: 0o644, uid: 1000, gid: 1000 },
  },
  {},
  { 'home/user/app': ['entry.js'] },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  APP,
  [], {},
  `${APP}/entry.js`,
  APP,
);

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};
const refusal = (fn, what) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, `${what} must not answer for a path outside the staged view`);
  assert.equal(error.code, 'EAGAIN', `${what} answered ${error.code} instead of refusing`);
  return error;
};

// ── 1. A listing of an unmapped directory is never an empty array ───────────
{
  const error = refusal(() => fs.readdirSync(MINIMAL), 'readdirSync');
  assert.ok(error.message.includes(MINIMAL), `the refusal must name the directory: ${error.message}`);
  refusal(() => fs.readdirSync(MINIMAL, { withFileTypes: true }), 'readdirSync withFileTypes');
}

// ── 2. Existence, stat and content do not invent absence either ─────────────
refusal(() => fs.existsSync(`${MINIMAL}/meta.json`), 'existsSync');
refusal(() => fs.statSync(MINIMAL), 'statSync');
refusal(() => fs.statSync(MINIMAL, { throwIfNoEntry: false }), 'statSync throwIfNoEntry:false');
refusal(() => fs.readFileSync(`${MINIMAL}/meta.json`, 'utf8'), 'readFileSync');

// ── 3. Every refusal is recorded, so nothing ends quietly ───────────────────
assert.ok(
  [...globalThis.__nimbusVfsResidencyMisses].some((k) => ('/' + k).startsWith(TEMPLATES)),
  'a refusal the program swallows must still reach the exit report',
);
const stillMissed = () => [...globalThis.__nimbusVfsResidencyMisses];

// ── 4. The async view was always right, and the sync view converges on it ───
assert.deepEqual(
  (await fs.promises.readdir(MINIMAL)).sort(), MINIMAL_ENTRIES,
  'the async form reaches the authority',
);
await settle();
assert.deepEqual(
  fs.readdirSync(MINIMAL).sort(), MINIMAL_ENTRIES,
  'one process must not see two different filesystems',
);
assert.equal(fs.existsSync(`${MINIMAL}/meta.json`), true);
assert.equal(fs.statSync(MINIMAL).isDirectory(), true);
assert.equal(fs.readFileSync(`${MINIMAL}/meta.json`, 'utf8'), '{"name":"minimal"}');

// ── 5. A subdirectory that was listed but never walked is still a directory ─
// Reporting it as a file is the same lie in a different shape: a scaffolder
// filtering a template tree by isDirectory() finds nothing at all.
{
  const dirents = fs.readdirSync(MINIMAL, { withFileTypes: true });
  const src = dirents.find((entry) => entry.name === 'src');
  assert.ok(src, 'the listing must contain the subdirectory');
  assert.equal(src.isDirectory(), true, 'an unwalked subdirectory is still a directory');
  assert.equal(
    dirents.find((entry) => entry.name === 'meta.json').isDirectory(), false,
    'and a file is still a file',
  );
}

// ── 6. The refusal faults the listing in on its own ─────────────────────────
// Nothing above asked for `src`; the refusal for it must repair itself the way
// the parent's did, without the program having to know to call the async form.
{
  refusal(() => fs.readdirSync(`${MINIMAL}/src`), 'readdirSync of a nested unmapped directory');
  await settle();
  assert.deepEqual(
    fs.readdirSync(`${MINIMAL}/src`), ['main.js'],
    'the refusal must pull the listing in, so the next call is answered',
  );
}

// ── 6b. A refusal the program later gets an answer for is retired ───────────
// The ledger exists to fail a run whose result rests on a read that never
// happened. Once the same call comes back with the listing, the stat and the
// existence answer, nothing rests on a failure any more, and reporting one
// would fail every program that simply asked twice.
assert.deepEqual(
  stillMissed().filter((k) => ('/' + k) === MINIMAL), [],
  'a directory the program went on to read is not an unanswered read',
);

// ── 7. Absence inside a walked directory is real, and stays cheap ───────────
// The repair must not turn every missing file into a refusal. Where the walk
// enumerated the directory, a name that is not in it is genuinely not there,
// and programs branch on that constantly.
assert.equal(fs.existsSync(`${APP}/nope.txt`), false, 'a mapped directory answers absence');
assert.throws(
  () => fs.readFileSync(`${APP}/nope.txt`, 'utf8'),
  (error) => error.code === 'ENOENT',
  'a file missing from a walked directory is ENOENT, not a refusal',
);
assert.equal(
  fs.statSync(`${APP}/nope.txt`, { throwIfNoEntry: false }), undefined,
  'and throwIfNoEntry keeps working where absence is knowable',
);

process.stdout.write('node-shims-unmapped-paths: all tests passed\n');
