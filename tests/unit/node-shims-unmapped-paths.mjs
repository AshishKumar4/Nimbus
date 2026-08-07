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
// What has to hold: never invent absence SILENTLY; converge the two views; and
// do not turn an ordinary missing file into a refusal, because absence inside a
// directory the walk DID enumerate is real knowledge and programs depend on it.
//
// Refusing every unmapped access was the first repair and it went too far.
// EAGAIN cannot arise from a real POSIX filesystem, so nothing branches on it:
// the catch block that receives it was written for a missing file and rethrows.
// Measured, create-next-app reads $HOME/.config/<tool>/config.json through the
// conf package — read a config, treat ENOENT as "no config yet", rethrow
// anything else — was handed EAGAIN for a file that had never existed, and died
// before writing one template file.
//
// So a read, a stat and an existence check answer the not-found the program was
// written for, PROVISIONALLY: the miss is recorded, the listing that settles it
// is pulled in, and the exit report fails the run by name if the path turns out
// to have been there. Silence is still unavailable — it just is not bought with
// an errno no program can handle. A LISTING is the exception and keeps refusing:
// "no config yet, write one" is an idiom, and there is no counterpart for a
// directory, so ENOENT would send a scaffolder down the same wrong branch the
// empty array did.

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
const provisional = (fn, what) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, `${what} must not succeed for a path outside the staged view`);
  assert.equal(
    error.code, 'ENOENT',
    `${what} answered ${error.code}; a program branches on ENOENT and on nothing else`,
  );
  return error;
};

// ── 1. A listing of an unmapped directory is never an empty array ───────────
{
  const error = refusal(() => fs.readdirSync(MINIMAL), 'readdirSync');
  assert.ok(error.message.includes(MINIMAL), `the refusal must name the directory: ${error.message}`);
  refusal(() => fs.readdirSync(MINIMAL, { withFileTypes: true }), 'readdirSync withFileTypes');
}

// ── 2. Existence, stat and content answer, and the answer is on the record ──
// The answer they give is the one a program can act on. What makes it honest is
// section 3: none of them is allowed to be the last word.
assert.equal(
  fs.existsSync(`${MINIMAL}/meta.json`), false,
  'existsSync never throws in node, and must not start here',
);
provisional(() => fs.statSync(MINIMAL), 'statSync');
assert.equal(
  fs.statSync(MINIMAL, { throwIfNoEntry: false }), undefined,
  'throwIfNoEntry:false is honoured for an unmapped path too',
);
provisional(() => fs.readFileSync(`${MINIMAL}/meta.json`, 'utf8'), 'readFileSync');

// ── 3. Every unmapped access is recorded, so nothing ends quietly ───────────
// This is what pays for the provisional answers above: the ledger, not the
// errno, is what keeps silence unavailable.
for (const path of [MINIMAL, `${MINIMAL}/meta.json`]) {
  assert.ok(
    globalThis.__nimbusVfsResidencyMisses.has(path.replace(/^\/+/, '')),
    `${path} was answered out of ignorance and must reach the exit report`,
  );
}
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

// ── 8. The config-lookup idiom, end to end ──────────────────────────────────
// The shape that killed create-next-app, and the reason the answers above are
// provisional rather than refusals. $HOME is enumerated, so a dotfile
// directory that is NOT there is answered from knowledge. But $HOME/.config IS
// there — seeded, empty, and never walked — so everything under it falls off
// the edge of the view, and that is where every conf/env-paths/xdg CLI looks.
{
  const HOME = '/home/user';
  const CFG = `${HOME}/.config`;
  vfs.mkdir(`${HOME}/work`, { recursive: true });
  vfs.mkdir(`${CFG}/present-tool`, { recursive: true });
  vfs.writeFile(`${CFG}/present-tool/state.json`, enc.encode('{"real":true}'));

  const { fs: cfs } = factory(
    {},
    {
      'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
      'home/user/work': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 },
    },
    {},
    // The manifest walk lists the root-to-cwd chain one level each, which is
    // what makes a missing dotfile directory answerable — and is exactly one
    // level short of the directory the lookup actually lands in.
    { '': ['home', 'tmp'], home: ['user'], 'home/user': ['.config', 'work'], 'home/user/work': [] },
    supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    `${HOME}/work`, [], {}, `${HOME}/work/cli.js`, `${HOME}/work`,
  );
  const ledger = () => [...globalThis.__nimbusVfsResidencyMisses];
  const settleLedger = () => globalThis.__nimbusVfsResidencySettle();
  globalThis.__nimbusVfsResidencyMisses.clear();

  // A dotfile directory that is not there at all: answered from the chain
  // listing, no repair, no ledger entry. This already worked and must keep
  // working — it is most of what a config lookup asks for.
  assert.throws(
    () => cfs.readFileSync(`${HOME}/.absent-tool/config.json`, 'utf8'),
    (error) => error.code === 'ENOENT',
    'a dotfile directory absent from an enumerated $HOME is knowledge, not ignorance',
  );
  assert.deepEqual(ledger(), [], 'and knowledge costs no ledger entry');

  // The regression: one level deeper, under a directory that exists and was
  // never walked. conf reads this, treats ENOENT as "no config yet", and
  // rethrows anything else.
  assert.throws(
    () => cfs.readFileSync(`${CFG}/new-tool/config.json`, 'utf8'),
    (error) => error.code === 'ENOENT',
    'a config read under an unwalked directory must reach the program not-found branch',
  );
  assert.deepEqual(
    ledger(), ['home/user/.config/new-tool/config.json'],
    'the provisional answer is on the record until something proves it',
  );

  // And the record is settled by a repair aimed at the directory that can
  // answer. The immediate parent cannot: `.config/new-tool` is not there, its
  // listing fails, and the ledger keeps an entry no repair could ever retire —
  // the run failed over a file that was simply absent.
  await settleLedger();
  assert.deepEqual(
    ledger(), [],
    'the boundary listing proves the absence, so the run is not failed for it',
  );
  assert.equal(
    cfs.existsSync(`${CFG}/another-tool/config.json`), false,
    'and every later lookup under it is answered from the listing that was pulled in',
  );
  assert.deepEqual(ledger(), [], 'from knowledge, so nothing new is recorded');

  // The other half, and the reason the answer above is provisional and not a
  // fabrication: a path that WAS there keeps its entry through the settle, so
  // the exit report still fails the run by name.
  assert.throws(
    () => cfs.readFileSync(`${CFG}/present-tool/state.json`, 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  await settleLedger();
  assert.deepEqual(
    ledger(), ['home/user/.config/present-tool/state.json'],
    'a file that existed and was answered not-found must still fail the run',
  );

  // And the program's own answer to the not-found is not evidence against it.
  // Read a config, find none, write one: by the time the run ends the file is
  // there, authored out of the very branch the answer sent the program down.
  // Judging the ledger on what exists at exit failed create-next-app over
  // /tmp/update-check and c3 over its wrangler metrics file — paths nothing
  // had ever withheld.
  globalThis.__nimbusVfsResidencyMisses.clear();
  const STAMP = '/tmp/update-check';
  assert.throws(
    () => cfs.readFileSync(STAMP, 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  // Written and never read back — an update notifier writes its stamp and
  // moves on — so nothing clears the record the way a satisfied read would,
  // and at exit the path exists because the program put it there.
  cfs.writeFileSync(STAMP, String(Date.now()));
  await settleLedger();
  assert.deepEqual(
    ledger(), [],
    'a file the program itself supplied was never withheld from it',
  );
}

process.stdout.write('node-shims-unmapped-paths: all tests passed\n');
