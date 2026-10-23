#!/usr/bin/env bun
// One fixture and Node 22.23.4 oracle for the core sync/async algorithm,
// lifo loader and emitted guest. Covers selection, exact map targets,
// main/index/extensions, scope boundaries and canonical symlink identity.
// Nimbus's intentional policies are asserted separately below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { prefetchForRequire } from '../../packages/core/src/runtime/require-resolver.ts';
import { createRequireResolver, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, NODE_REQUIRE_POLICY } from '../../packages/core/src/runtime/require-resolution.ts';
import { createCjsLoader } from '../../packages/core/src/substrate/lifo/node-compat/cjs-loader.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START, declareNamespace } from './lib/shims-namespace.mjs';

const pkg = (json) => JSON.stringify(json) + '\n';
const W = 'home/user/app';
const NM = W + '/node_modules';
const FILES = {
  [W + '/package.json']: pkg({ name: 'app', type: 'commonjs', exports: { '.': './self.cjs', './open': './self.cjs' }, imports: {
    '#x': './self.cjs', '#dep': 'dual', '#fs': 'fs', '#null': null,
    '#conditional-null': { require: null, default: './self.cjs' },
    '#pat/*': './lib/*.js', '#exact': './lib/one', '#invalid': '../outside.js',
    '#bare-sub': 'legacy/sub', '#array-missing': ['not-installed-nimbus-fixture', './self.cjs'],
  } }),
  [W + '/main.cjs']: '',
  [W + '/self.cjs']: 'module.exports = 1;',
  [W + '/lib/one.js']: 'module.exports = 1;',
  [W + '/index.js']: 'module.exports = 1;',
  [W + '/only-m.mjs']: 'export default 1;',
  [W + '/only-c.cjs']: 'module.exports = 1;',
  [W + '/only-node.node']: '',
  [W + '/data.json']: '{"x":1}',
  [W + '/append.cjs.js']: 'module.exports = 1;',
  [W + '/pick.js']: 'module.exports = 1;',
  [W + '/pick.json']: '{"x":1}',
  [W + '/pick.node']: '',
  [W + '/suffix-dir.js/index.js']: 'module.exports = 1;',
  [W + '/dir/package.json']: pkg({ main: 'inner' }),
  [W + '/dir/inner/package.json']: pkg({ main: '../hidden.js' }),
  [W + '/dir/inner/index.json']: '{"x":1}',
  [W + '/dir/hidden.js']: 'module.exports = 1;',
  [W + '/main-dot/package.json']: pkg({ main: '.' }),
  [W + '/main-dot/index.js']: 'module.exports = 1;',
  [W + '/main-fallback/package.json']: pkg({ main: 'missing' }),
  [W + '/main-fallback/index.json']: '{"x":1}',
  [W + '/main-broken/package.json']: pkg({ main: 'missing' }),
  [W + '/nearer/package.json']: '{}',
  [W + '/nearer/plain.js']: 'module.exports = 1;',
  [W + '/typed/package.json']: pkg({ type: 'module' }),
  [W + '/typed/file.js']: 'export default 1;',
  [W + '/typescript.ts']: 'const x: number = 1;',
  [W + '/tsdir/index.ts']: 'export const x = 1;',
  [W + '/tsmain/package.json']: pkg({ main: './source.js' }),
  [W + '/tsmain/source.ts']: 'export const x = 1;',
  [W + '/real/linked/package.json']: pkg({ name: 'linked', main: 'entry.cjs' }),
  [W + '/real/linked/entry.cjs']: 'module.exports = 1;',
  [W + '/real/linked/sub.cjs']: 'module.exports = 1;',
  [W + '/real/source.cjs']: 'module.exports = 1;',
  [NM + '/tinydate/package.json']: pkg({ name: 'tinydate', main: 'dist/tinydate.js', module: 'dist/tinydate.mjs' }),
  [NM + '/tinydate/dist/tinydate.js']: 'module.exports = function (s) { return () => s; };',
  [NM + '/tinydate/dist/tinydate.mjs']: 'export default 1;',
  [NM + '/module-only/package.json']: pkg({ name: 'module-only', module: 'esm.mjs' }),
  [NM + '/module-only/esm.mjs']: 'export default 1;',
  [NM + '/module-only/index.js']: 'module.exports = 1;',
  [NM + '/legacy/package.json']: pkg({ name: 'legacy', main: 'index.js' }),
  [NM + '/legacy/index.js']: 'module.exports = 0;',
  [NM + '/legacy/sub/package.json']: pkg({ main: '../dist/sub.cjs.js', module: '../dist/sub.esm.js' }),
  [NM + '/legacy/dist/sub.cjs.js']: 'module.exports = 2;',
  [NM + '/legacy/dist/sub.esm.js']: 'export default 2;',
  [NM + '/dual/package.json']: pkg({ name: 'dual', exports: {
    '.': { 'module-sync': './sync.mjs', require: './r.cjs', default: './d.js' },
    './require-first': { require: './r.cjs', 'module-sync': './sync.mjs' },
    './default-first': { default: './d.js', require: './r.cjs' },
    './null': null, './conditional-null': { require: null, default: './d.js' },
    './private/*': null, './*': './*.js',
    './array-invalid': ['../escape.js', 7, { browser: './d.js' }, './r.cjs'],
    './array-null': [null, './r.cjs'],
    './array-invalid-null': ['../escape.js', null],
    './array-null-invalid': [null, '../escape.js'],
    './array-missing': ['./missing.js', './r.cjs'],
    './no-extension': './raw', './directory': './folder',
    './dev': { development: './d.js', require: './r.cjs' },
    './addons': { 'node-addons': './r.cjs', default: './d.js' },
    './bad': './node_modules/hidden.js', './encoded': './%2e%2e/escape.js',
    './repeat/*': './star/*/*.js',
  } }),
  [NM + '/dual/sync.mjs']: 'export default 1;',
  [NM + '/dual/r.cjs']: 'module.exports = 1;',
  [NM + '/dual/d.js']: 'module.exports = 1;',
  [NM + '/dual/raw.js']: 'module.exports = 1;',
  [NM + '/dual/folder/index.js']: 'module.exports = 1;',
  [NM + '/dual/private/hidden.js']: 'module.exports = 1;',
  [NM + '/dual/star/a/a.js']: 'module.exports = 1;',
  [NM + '/patterns/package.json']: pkg({ exports: { './*/long-suffix': './generic.js', './a/*': './specific/*.js' } }),
  [NM + '/patterns/generic.js']: 'module.exports = 1;',
  [NM + '/patterns/specific/x/long-suffix.js']: 'module.exports = 1;',
  [NM + '/import-only/package.json']: pkg({ exports: { import: './esm.mjs' }, main: 'index.js' }),
  [NM + '/import-only/esm.mjs']: 'export default 1;',
  [NM + '/import-only/index.js']: 'module.exports = 1;',
  [NM + '/numeric/package.json']: pkg({ exports: { '.': { '0': './index.js', default: './index.js' } } }),
  [NM + '/numeric/index.js']: 'module.exports = 1;',
  [NM + '/mixed/package.json']: pkg({ exports: { '.': './index.js', require: './index.js' } }),
  [NM + '/mixed/index.js']: 'module.exports = 1;',
  [NM + '/root-null/package.json']: pkg({ exports: null, main: 'index.js' }),
  [NM + '/root-null/index.js']: 'module.exports = 1;',
  [NM + '/app/package.json']: pkg({ main: 'index.js' }),
  [NM + '/app/index.js']: 'module.exports = 2;',
  [NM + '/app/private.js']: 'module.exports = 2;',
  [NM + '/direct.cjs']: '',
  'usr/share/pkg/node_modules/nimbus-product-global/index.js': 'module.exports = 1;',
};
const LINKS = { [NM + '/linked']: '../real/linked', [W + '/source-link.cjs']: './real/source.cjs' };
const CASES = [
  ...['tinydate', 'module-only', 'legacy/sub', 'root-null', 'linked', 'linked/sub.cjs', 'app', 'app/open', 'app/private',
    'dual', 'dual/require-first', 'dual/default-first', 'dual/null', 'dual/conditional-null', 'dual/private/hidden',
    'dual/array-invalid', 'dual/array-null', 'dual/array-invalid-null', 'dual/array-null-invalid', 'dual/array-missing',
    'dual/no-extension', 'dual/directory', 'dual/repeat/a', 'dual/dev', 'dual/addons', 'dual/bad', 'dual/encoded',
    'patterns/a/x/long-suffix', 'import-only', 'numeric', 'mixed', 'not-installed-nimbus-fixture',
    '#x', '#dep', '#fs', '#null', '#conditional-null', '#pat/one', '#exact', '#invalid', '#bare-sub', '#array-missing',
    '#missing', '#', '#/bad', 'fs', 'node:fs', 'node:not-a-builtin',
    './only-m.mjs', './only-c.cjs', './only-node', './only-node.node', './data', './data.json',
    './only-m', './only-c', './append.cjs', './pick', './pick/', './suffix-dir',
    './dir', './main-dot', './main-fallback', './main-broken', './typed/file.js', './source-link.cjs',
    '.', '..', './missing', 'file:///home/user/app/self.cjs',
  ].map((id) => ({ id })),
  { id: '#x', from: W + '/nearer' }, { id: '#x', from: W + '/node_modules' },
  { id: 'app', paths: [] }, { id: 'tinydate', paths: [] },
  { id: 'tinydate', paths: [W + '/nearer', W] }, { id: './self.cjs', paths: [W + '/nearer', W] },
  { id: '/' + W + '/self.cjs', paths: [] },
  { id: './self.cjs', paths: [W, null], boundaryOnly: true },
  { id: 'tinydate', paths: [W, null], boundaryOnly: true },
];
const root = realpathSync(mkdtempSync(join(tmpdir(), 'nimbus-require-main-')));
const disk = (path) => join(root, path);
const diskId = (id) => id.startsWith('/') ? disk(id) : id;
const kind = (path) => {
  try { const st = statSync(path); return st.isFile() ? 'file' : st.isDirectory() ? 'directory' : null; }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
};
const normalize = (path) => path.startsWith(root + '/') ? relative(root, path) : path.replace(/^\/+/, '');
const answer = (run) => {
  try { return { path: normalize(run()) }; } catch (e) { return { code: e.code }; }
};
const resultPath = (result) => {
  if (result?.builtin) return 'node:' + result.builtin;
  if (!result?.path) throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
  return result.path;
};
const HostURL = globalThis.URL;
try {
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(disk(path)), { recursive: true });
    writeFileSync(disk(path), content);
  }
  for (const [path, target] of Object.entries(LINKS)) symlinkSync(target, disk(path));
  const host = { kind, realpath: realpathSync, readText: (path) => readFileSync(path, 'utf8'), isBuiltin };
  const virtualFs = {
    exists: (path) => existsSync(disk(path)),
    isFile: (path) => kind(disk(path)) === 'file', isDirectory: (path) => kind(disk(path)) === 'directory',
    readFileString: (path) => readFileSync(disk(path), 'utf8'),
    realpath: (path) => '/' + normalize(realpathSync(disk(path))),
  };
  const context = { filesystem: () => virtualFs, cwd: '/' + W, env: {}, stdout: { write() {} }, stderr: { write() {} },
    argv: [], filename: '/' + W + '/main.cjs', dirname: '/' + W, signal: new AbortController().signal };
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', 'nodeCommandLine',
    '"use strict";' + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START + '\n;return builtins.module.createRequire(filename);',
  );
  for (const conditions of [[], ['development']]) {
    // Each guest boot gets a fresh host constructor, as in its own realm;
    // do not wrap the previous standalone guest's URL a second time.
    globalThis.URL = HostURL;
    const driver = disk(W + '/__oracle.cjs');
    writeFileSync(driver, [
      'const { createRequire } = require("module");',
      'const root = ' + JSON.stringify(root) + ';',
      'const cwd = ' + JSON.stringify(W) + ';',
      'const out = ' + JSON.stringify(CASES) + '.map(({id,from,paths}) => {',
      'const r = createRequire(root + "/" + (from || cwd) + "/main.cjs");',
      'try { const p = r.resolve(id.startsWith("/") ? root + id : id, paths === undefined ? undefined : { paths: paths.map(p => typeof p === "string" ? root + "/" + p : p) });',
      'return { path: p.startsWith(root + "/") ? p.slice(root.length + 1) : p }; } catch(e) { return {code:e.code}; } });',
      'console.log(JSON.stringify(out));',
    ].join('\n'));
    const node = spawnSync('node', [...conditions.map((c) => '--conditions=' + c), driver], { cwd: disk(W), encoding: 'utf8' });
    assert.equal(node.status, 0, node.stderr);
    const expected = JSON.parse(node.stdout);
    const sync = createRequireResolver(host, { conditions });
    const async_ = createRequireResolver(Object.fromEntries(Object.entries(host).map(([key, value]) =>
      [key, key === 'isBuiltin' ? value : async (...args) => value(...args)])), { conditions });
    const lifo = createCjsLoader(context, { console, process }, { conditions, policy: NODE_REQUIRE_POLICY });
    declareNamespace({ metadata: Object.fromEntries(Object.entries(LINKS).map(([path, target]) =>
      [path, { type: 'symlink', target, mode: 0o120777, uid: 1000, gid: 1000 }])) });
    const guest = factory(FILES, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
      '/' + W, [], {}, '/' + W + '/main.cjs', '/' + W, { conditions });
    const differences = [];
    const same = (actual, expected, label) => {
      try { assert.deepEqual(actual, expected); } catch { differences.push({ label, actual, expected }); }
    };
    for (let i = 0; i < CASES.length; i++) {
      const { id, from = W, paths, boundaryOnly } = CASES[i];
      const label = JSON.stringify({ id, from, paths, conditions });
      const request = boundaryOnly || paths === undefined ? undefined : { paths: paths.map(disk) };
      const coreAnswer = answer(() => {
        const found = sync.resolveSync(diskId(id), disk(from), request);
        return found?.builtin && !id.startsWith('#') ? id : resultPath(found);
      });
      if (!boundaryOnly) same(coreAnswer, expected[i], 'core sync: ' + label);
      let asyncAnswer;
      try {
        const found = await async_.resolve(diskId(id), disk(from), request);
        asyncAnswer = { path: normalize(found?.builtin && !id.startsWith('#') ? id : resultPath(found)) };
      } catch (e) { asyncAnswer = { code: e.code }; }
      if (!boundaryOnly) same(asyncAnswer, expected[i], 'core async: ' + label);
      same(answer(() => lifo.requireFrom('/' + from).resolve(id,
        paths === undefined ? undefined : { paths: paths.map((p) => typeof p === 'string' ? '/' + p : p) })), expected[i], 'lifo: ' + label);
      const runtime = from === W ? guest : guest('module').createRequire('/' + from + '/main.cjs');
      same(answer(() => runtime.resolve(id, paths === undefined ? undefined : { paths: paths.map((p) => typeof p === 'string' ? '/' + p : p) })),
        expected[i], 'guest: ' + label);
    }
    assert.deepEqual(differences, [], 'all hosts agree with Node under ' + JSON.stringify(conditions));
    // An imports refusal names the requiring file, as Node's does (not its directory).
    const refusal = (resolveId) => { try { resolveId(); } catch (e) { return { code: e.code, message: e.message }; } return null; };
    const nodeRefusal = spawnSync('node', ['-e', 'try { require("module").createRequire(' + JSON.stringify(disk(W) + '/main.cjs')
      + ').resolve("#missing"); } catch (e) { console.log(JSON.stringify({ code: e.code, message: e.message })); }'], { encoding: 'utf8' });
    assert.deepEqual(refusal(() => guest.resolve('#missing')), JSON.parse(nodeRefusal.stdout.split(root).join('')), 'the guest names the requiring file, as Node');
    const typed = sync.resolveSync('./typed/file.js', disk(W));
    assert.equal(typed.packageType, 'module');
    assert.equal(typed.scope.packageJsonPath, disk(W + '/typed/package.json'));
    console.log('  sync/async/lifo/guest agree with Node: ' + CASES.length + ' cases, conditions ' + JSON.stringify(conditions));
  }

  // Intentional divergence: source fallback is opt-in, and never changes a
  // valid Node resolution or turns a package-map target into a probe.
  const strict = createRequireResolver(host);
  const source = createRequireResolver(host, { policy: NIMBUS_TYPESCRIPT_REQUIRE_POLICY });
  assert.equal(strict.resolveSync('./typescript', disk(W)), null);
  assert.equal(strict.resolveSync('./tsdir', disk(W)), null);
  assert.equal(normalize(source.resolveSync('./typescript', disk(W)).path), W + '/typescript.ts');
  assert.equal(normalize(source.resolveSync('./tsdir', disk(W)).path), W + '/tsdir/index.ts');
  assert.throws(() => strict.resolveSync('./tsmain', disk(W)), (e) => e.code === 'MODULE_NOT_FOUND');
  assert.equal(normalize(source.resolveSync('./tsmain', disk(W)).path), W + '/tsmain/source.ts');
  assert.equal(normalize(source.resolveSync('./pick', disk(W)).path), W + '/pick.js');
  assert.throws(() => source.resolveSync('dual/no-extension', disk(W)), (e) => e.code === 'MODULE_NOT_FOUND');
  const product = createCjsLoader(context, { console, process });
  assert.equal(product.requireFrom('/' + W).resolve('./typescript'), '/' + W + '/typescript.ts');
  // Intentional divergence: existing lifo product folders are not NODE_PATH.
  assert.equal(strict.resolveSync('nimbus-product-global', disk(W)), null);
  assert.equal(product.requireFrom('/' + W).resolve('nimbus-product-global'), '/usr/share/pkg/node_modules/nimbus-product-global/index.js');

  // Classification is delivered by resolution, so lifo needn't rediscover it.
  let reads = 0;
  const counting = { ...virtualFs, readFileString(path) { if (path.endsWith('/package.json')) reads++; return virtualFs.readFileString(path); } };
  const classified = createCjsLoader({ ...context, filesystem: () => counting }, { console, process }, { policy: NODE_REQUIRE_POLICY });
  for (const id of ['./index.js', './nearer/plain.js']) {
    const filename = classified.requireFrom('/' + W).resolve(id);
    const before = reads;
    classified.load(filename);
    assert.equal(reads, before, 'lifo loading reuses the classified package scope: ' + id);
  }
  const failed = createRequireResolver({ ...host, async kind() { throw Object.assign(new Error('host failure'), { code: 'EIO' }); } });
  await assert.rejects(failed.resolve('./self.cjs', disk(W)), (e) => e.code === 'EIO', 'async driver delivers host rejection into the generator');

  // The launch walker still stages main entries and consulted metadata.
  const vfs = {
    exists: (path) => existsSync(disk(path)), isDirectory: (path) => kind(disk(path)) === 'directory',
    readFileString: (path) => readFileSync(disk(path), 'utf8'), realpath: (path) => normalize(realpathSync(disk(path))),
    readBytes: (path) => (existsSync(disk(path)) ? readFileSync(disk(path)) : null),
  };
  for (const id of ['tinydate', 'module-only', 'legacy/sub']) {
    const entry = 'require(' + JSON.stringify(id) + ');';
    const expected = normalize(createRequireResolver(host).resolveSync(id, disk(W)).path);
    const { bundle } = await prefetchForRequire(vfs, entry, W, W + '/main.cjs');
    assert.ok(expected in bundle, 'prefetch stages ' + expected);
  }
} finally {
  globalThis.URL = HostURL;
  rmSync(root, { recursive: true, force: true });
}
console.log('require-package-main: Node CommonJS resolution and named product policies');
