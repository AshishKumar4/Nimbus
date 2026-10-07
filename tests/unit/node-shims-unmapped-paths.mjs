// The synchronous filesystem view is the whole filesystem the credential can
// see, never a walk of selected roots.
//
// It used to be partial: __vfsManifest was a walk of the working directory,
// its node_modules and the entry script's own package, and every synchronous
// call treated it as total. A path the walk never reached was answered as
// though it had been looked for and not found:
//
//     readdirSync(dir)                    → []          (a populated directory)
//     existsSync(dir + '/meta.json')      → false
//     statSync(dir)                       → ENOENT
//
// while fs.promises.readdir on the same path returned the real entries: one
// process, two filesystems. A scaffolder read its template directory, was told
// it was empty, wrote nothing, and exited 0; create-next-app died on EAGAIN
// for a config file under $HOME/.config that had never existed.
//
// The namespace (vfs/facet-resident-store.ts, CUTOVER #13) is listed before
// user code runs, so there is no unmapped world. This pins the invariant from
// the first call: every answer is the authority's, sync and async alike, for
// a tree outside the working directory, under $HOME/.config, and for a path
// that is simply absent (plain ENOENT, which the config idiom depends on).

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SHIMS_STORE_PRELUDE, listAuthority } from './lib/shims-namespace.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = processBridge(rawVfs, rawVfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }));
const enc = new TextEncoder();
const dec = new TextDecoder();

const APP = '/home/user/example-app';
vfs.mkdir(APP, { recursive: true });
vfs.writeFile(`${APP}/entry.js`, enc.encode('module.exports = 1;\n'));
// What no walk of the working directory reaches: a template cache, and a
// tool's config directory under $HOME.
const MINIMAL = '/tmp/cache/templates/minimal';
vfs.mkdir(`${MINIMAL}/src`, { recursive: true });
vfs.writeFile(`${MINIMAL}/meta.json`, enc.encode('{"name":"minimal"}'));
vfs.writeFile(`${MINIMAL}/README.md`, enc.encode('# minimal\n'));
vfs.writeFile(`${MINIMAL}/src/main.js`, enc.encode('export default 1;\n'));
const CFG = '/home/user/.config';
vfs.mkdir(`${CFG}/present-tool`, { recursive: true });
vfs.writeFile(`${CFG}/present-tool/state.json`, enc.encode('{"real":true}'));
function ownTree(path = '') {
  for (const entry of vfs.readdir(path)) {
    const at = path ? `${path}/${entry.name}` : entry.name;
    vfs.chown(at, 1000, 1000);
    if (entry.type === 'directory') ownTree(at);
  }
}
ownTree();

const supervisor = {
  readFile: async (path) => { const bytes = await bridge.readFile(path); return bytes ? dec.decode(bytes) : null; },
  stat: (path) => bridge.stat(path),
  lstat: (path) => bridge.stat(path, { followSymlinks: false }),
  readdir: (path) => bridge.readdir(path),
  exists: async (path) => (await bridge.stat(path)) !== null,
  fsReadRange: (path, offset, length) => bridge.readRange(path, offset, length),
  fsAcquire: (epoch, cursor, options) => bridge.acquire(epoch, cursor, options),
};

listAuthority(rawVfs);
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };
const factory = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);
const { fs } = factory(
  { 'home/user/example-app/entry.js': 'module.exports = 1;\n' },
  {},
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  APP,
  [],
  {},
  `${APP}/entry.js`,
  APP,
);

// A tree outside the working directory: the same answers sync and async.
assert.deepEqual(fs.readdirSync(MINIMAL).sort(), ['README.md', 'meta.json', 'src'], 'a listing is the directory, never []');
assert.deepEqual((await fs.promises.readdir(MINIMAL)).sort(), fs.readdirSync(MINIMAL).sort(), 'one process sees one filesystem');
{
  const dirents = fs.readdirSync(MINIMAL, { withFileTypes: true });
  assert.equal(dirents.find((d) => d.name === 'src').isDirectory(), true, 'a subdirectory is a directory');
  assert.equal(dirents.find((d) => d.name === 'meta.json').isDirectory(), false, 'and a file a file');
}
assert.equal(fs.existsSync(`${MINIMAL}/meta.json`), true);
assert.equal(fs.statSync(MINIMAL).isDirectory(), true);
assert.deepEqual(fs.readdirSync(`${MINIMAL}/src`), ['main.js'], 'a nested directory answers from the first call');

// The config idiom: read a config, treat ENOENT as "none yet". Absence is
// plain ENOENT, never a refusal, under $HOME/.config as anywhere.
assert.throws(() => fs.readFileSync(`${CFG}/new-tool/config.json`, 'utf8'), (e) => e.code === 'ENOENT');
assert.throws(() => fs.readFileSync('/home/user/.absent-tool/config.json', 'utf8'), (e) => e.code === 'ENOENT');
assert.equal(fs.existsSync(`${APP}/nope.txt`), false);
assert.equal(fs.statSync(`${APP}/nope.txt`, { throwIfNoEntry: false }), undefined);
assert.equal(fs.existsSync(`${CFG}/present-tool/state.json`), true, 'a present config is there, sync');
assert.equal(await fs.promises.readFile(`${CFG}/present-tool/state.json`, 'utf8'), '{"real":true}');

// Nothing answered for a path that was there was ever an absence: no misses.
assert.deepEqual([...(globalThis.__nimbusVfsResidencyMisses ?? [])].filter((k) => k.includes('templates') || k.includes('.config')), []);

process.stdout.write('node-shims-unmapped-paths: all tests passed\n');
