#!/usr/bin/env bun
// The real exsolve resolver, walking a real node_modules tree entirely over
// the facet's `node:fs` / `node:url` / `node:path` shims.
//
// exsolve is what `@nuxt/cli` resolves `@nuxt/kit` and `nuxt` with, and it
// vendors Node's own ESM resolver: `_normalizeBase` → `moduleResolve` →
// `packageResolve` → `packageExportsResolve` → `finalizeResolution`. Under the
// shims that walk used to make exactly two syscalls —
//
//     statSync('/home/user/proj')  -> dir
//     statSync('/@nuxt/kit')       -> ENOENT
//
// — because the facet's URL constructor answered `file:///@nuxt/kit` where
// Node throws, so `moduleResolve` took the absolute-URL branch and
// `finalizeResolution` stat'd the FILESYSTEM ROOT instead of ever reaching
// `packageResolve`'s node_modules walk. The unit contract is in
// tests/unit/node-shims-url-constructor.mjs; this file is the consequence,
// proven with the actual dependency rather than a restatement of it.
//
// exsolve's dist is ESM. It is converted to CJS with esbuild — the same
// transform the runtime uses for facet modules — so it can be handed the
// shim's own builtins table as its `require`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const PROJ = 'home/user/proj';
const KIT_MAIN = `/${PROJ}/node_modules/@nuxt/kit/dist/index.mjs`;
const NUXT_MAIN = `/${PROJ}/node_modules/nuxt/dist/index.mjs`;

const pkg = (name, main) => JSON.stringify({
  name,
  version: '4.2.1',
  type: 'module',
  exports: { '.': { types: './dist/index.d.mts', import: main } },
  main,
});

// Files carry content; directories carry listings. Between them the shim's
// stat ladder answers isDirectory()/isFile() the way a real tree does.
const bundle = {
  [`${PROJ}/package.json`]: JSON.stringify({
    name: 'proj', private: true, type: 'module',
    dependencies: { '@nuxt/kit': '^4.2.1', nuxt: '^4.2.1' },
  }),
  [`${PROJ}/app/app.vue`]: '<template><div /></template>\n',
  [`${PROJ}/node_modules/@nuxt/kit/package.json`]: pkg('@nuxt/kit', './dist/index.mjs'),
  [`${PROJ}/node_modules/@nuxt/kit/dist/index.mjs`]: 'export const defineNuxtModule = () => {};\n',
  [`${PROJ}/node_modules/nuxt/package.json`]: pkg('nuxt', './dist/index.mjs'),
  [`${PROJ}/node_modules/nuxt/dist/index.mjs`]: 'export const version = "4.2.1";\n',
};
const manifest = {
  '': ['home'],
  home: ['user'],
  'home/user': ['proj'],
  [PROJ]: ['package.json', 'node_modules', 'app'],
  [`${PROJ}/app`]: ['app.vue'],
  [`${PROJ}/node_modules`]: ['@nuxt', 'nuxt'],
  [`${PROJ}/node_modules/@nuxt`]: ['kit'],
  [`${PROJ}/node_modules/@nuxt/kit`]: ['package.json', 'dist'],
  [`${PROJ}/node_modules/@nuxt/kit/dist`]: ['index.mjs'],
  [`${PROJ}/node_modules/nuxt`]: ['package.json', 'dist'],
  [`${PROJ}/node_modules/nuxt/dist`]: ['index.mjs'],
};

const NativeURL = globalThis.URL;
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
  '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();'
    + generateShimsCode() + '\n;return builtins;',
);
const builtins = factory(
  bundle, {}, {}, {}, manifest, null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  `/${PROJ}`, [], {}, `/${PROJ}/probe.mjs`, `/${PROJ}`,
);
const ShimURL = builtins.url.URL;
// Installing the shims took over the realm's URL. Give it back while this
// file does its own host-side work (reading and transforming exsolve), and
// reinstall it only around the resolver run, which is the state a facet is in.
globalThis.URL = NativeURL;

// Every stat the resolver performs, in order — the trace the bug was found in.
const stats = [];
const realStatSync = builtins.fs.statSync;
builtins.fs.statSync = (p, opts) => {
  stats.push(String(p));
  return realStatSync(p, opts);
};

const require_ = createRequire(import.meta.url);
const exsolveEsm = readFileSync(require_.resolve('exsolve'), 'utf8');
const { code } = transformSync(exsolveEsm, {
  loader: 'js', format: 'cjs', platform: 'node', target: 'es2022',
  sourcefile: 'exsolve/dist/index.mjs',
});

const mod = { exports: {} };
const shimRequire = (id) => {
  const bare = id.startsWith('node:') ? id.slice(5) : id;
  const m = builtins[bare];
  if (!m) throw new Error(`exsolve required ${id}, which the shims do not provide`);
  return m;
};

let exsolve;
globalThis.URL = ShimURL;
try {
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, shimRequire, mod,
    `/${PROJ}/node_modules/exsolve/dist/index.mjs`,
    `/${PROJ}/node_modules/exsolve/dist`,
  );
  exsolve = mod.exports;
  assert.equal(typeof exsolve.resolveModulePath, 'function', 'exsolve loaded through the shims');

  const resolve = (id, from) =>
    exsolve.resolveModulePath(id, { from, try: true, cache: new Map() });

  // ── 1. scoped package, resolved from the project root ──────────────────
  stats.length = 0;
  assert.equal(resolve('@nuxt/kit', `/${PROJ}`), KIT_MAIN);
  assert.ok(
    !stats.includes('/@nuxt/kit'),
    `the walk must never probe the filesystem root; stats=${JSON.stringify(stats)}`,
  );
  assert.ok(
    stats.includes(`/${PROJ}/node_modules/@nuxt/kit`),
    `the walk must probe <from>/node_modules/@nuxt/kit; stats=${JSON.stringify(stats)}`,
  );

  // ── 2. unscoped package, resolved from a subdirectory ──────────────────
  // The hop count differs for scoped vs unscoped names, so both shapes of
  // packageResolve's `../…/node_modules/` climb are exercised.
  stats.length = 0;
  assert.equal(resolve('nuxt', `/${PROJ}/app`), NUXT_MAIN);
  assert.ok(!stats.includes('/nuxt'), `stats=${JSON.stringify(stats)}`);
  assert.deepEqual(
    stats.filter((p) => p.endsWith('/node_modules/nuxt')),
    [`/${PROJ}/app/node_modules/nuxt`, `/${PROJ}/node_modules/nuxt`],
    'packageResolve must climb from <from> toward the root, one node_modules at a time',
  );

  // ── 3. scoped package from the subdirectory too ────────────────────────
  assert.equal(resolve('@nuxt/kit', `/${PROJ}/app`), KIT_MAIN);

  // ── 4. a name that is genuinely absent still answers undefined ─────────
  stats.length = 0;
  assert.equal(resolve('@nuxt/not-installed', `/${PROJ}`), undefined);
  assert.ok(
    stats.includes(`/${PROJ}/node_modules/@nuxt/not-installed`),
    `a miss must still have walked the tree; stats=${JSON.stringify(stats)}`,
  );

  // ── 5. explicit paths and file: URLs keep working ──────────────────────
  assert.equal(resolve(KIT_MAIN, `/${PROJ}`), KIT_MAIN);
  assert.equal(resolve(`file://${KIT_MAIN}`, `/${PROJ}`), KIT_MAIN);
  assert.equal(resolve('./node_modules/nuxt/dist/index.mjs', `/${PROJ}`), NUXT_MAIN);
  assert.equal(exsolve.resolveModuleURL('node:fs', { from: `/${PROJ}`, try: true }), 'node:fs');
} finally {
  globalThis.URL = NativeURL;
  builtins.fs.statSync = realStatSync;
}

console.log('node-shims-exsolve-resolution: ok');
