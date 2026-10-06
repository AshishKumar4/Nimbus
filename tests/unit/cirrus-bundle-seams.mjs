#!/usr/bin/env bun
// The cirrus-real bundlers' post-bundle seams (packages/worker/scripts):
// replaceSeam fails the build when an anchor's match count moves, the
// plugin-react rewrite inlines react-refresh's runtime byte for byte (a
// string replacement once read its `$$typeof` as a `$$` pattern and
// shipped `'$typeof'`; the staged bundle is checked against the pinned
// runtime), the shared __require polyfill resolves in its
// documented order, and the real-vite seam table applies every seam once
// and names the one whose anchor is gone.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePackageDir } from '../../packages/worker/scripts/resolve-package-dir.mjs';
import { replaceSeam, requirePolyfillSeam } from '../../packages/worker/scripts/cirrus-bundle-shared.mjs';
import { patchPluginReactIndex } from '../../packages/worker/scripts/plugin-react-bundle-patches.mjs';
import { patchRealViteBundle } from '../../packages/worker/scripts/real-vite-bundle-patches.mjs';

// ── replaceSeam ─────────────────────────────────────────────────────
assert.equal(replaceSeam('a-b-a', { label: 'x', find: /a/g, replace: 'c', count: 2 }), 'c-b-c');
assert.throws(() => replaceSeam('a-b', { label: 'two-a', find: /a/g, replace: 'c', count: 2 }), /two-a: expected exactly 2 match\(es\).*found 1/);
assert.throws(() => replaceSeam('b', { label: 'some-a', find: /a/g, replace: 'c', min: 1 }), /some-a: expected at least 1 .*found 0/);
assert.equal(replaceSeam('aaa', { label: 'x', find: /a/g, replace: 'b', min: 1 }), 'bbb');
assert.throws(() => replaceSeam('a', { label: 'x', find: /a/, replace: 'b', count: 1 }), /must be global/);
// A replacement is text, never a String.prototype.replace pattern.
assert.equal(replaceSeam('x', { label: 'x', find: /x/g, replace: "'$$typeof' $& $1", count: 1 }), "'$$typeof' $& $1");

// ── plugin-react: react-refresh's runtime inlined verbatim ──────────
const PLUGIN_INDEX = [
  'const reactRefreshDir = path.dirname(_require.resolve("react-refresh/package.json"));',
  'const runtimeFilePath = path.join(reactRefreshDir, "cjs/react-refresh-runtime.development.js");',
  'const runtimeCode = `${fs.readFileSync(runtimeFilePath, "utf-8")}`;',
  'const utilsCode = `${fs.readFileSync(_require.resolve("./refreshUtils.js"), "utf-8")}`;',
  'const loadedPlugin = new Map(); function loadPlugin(path) { const promise = import(path); return promise; }',
  'const plugins = [...babelOptions.plugins];',
].join('\n');
const refreshRuntime = "switch (getProperty(type, '$$typeof')) { case `x${y}`: return '\\n' + $&; }";
const refreshUtils = "export const marker = '$1 $$ ${not} `tick` \\\\';";
const patchedIndex = patchPluginReactIndex(PLUGIN_INDEX, { refreshRuntime, refreshUtils });
const literal = (name) => {
  const m = patchedIndex.match(new RegExp(`const ${name} = (\`[\\s\\S]*?[^\\\\]\`);\\n`));
  assert.ok(m, `${name} is still a template literal`);
  return new Function(`return ${m[1]};`)();
};
assert.equal(literal('runtimeCode'), refreshRuntime, 'react-refresh runtime inlined byte for byte');
assert.equal(literal('utilsCode'), refreshUtils, 'refreshUtils inlined byte for byte');
assert.match(patchedIndex, /String\("\/__cirrus_stub_react_refresh_dir__"\)/);
assert.match(patchedIndex, /case "react-refresh\/babel":/);
assert.match(patchedIndex, /loadPlugin\("@babel\/plugin-transform-react-jsx"\)/);
assert.throws(
  () => patchPluginReactIndex(PLUGIN_INDEX.replace('const plugins = [...babelOptions.plugins];', ''), { refreshRuntime, refreshUtils }),
  /plugin-react JSX\/TS transform injection: expected exactly 1/,
);

// ── the shared __require polyfill resolves in its documented order ──
const ESBUILD_POLYFILL = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});`;
{
  const seam = requirePolyfillSeam({
    base: 'file:///t.js',
    label: 'probe',
    stubs: "\n  _stubs['stubbed'] = { stub: true };",
  });
  const source = replaceSeam(ESBUILD_POLYFILL, seam);
  const saved = {};
  const globals = ['__cirrusNodeBuiltinTable', '__cirrusRealRequireShim', '__cirrusRealUserspaceRequire', '__cirrusNodeCreateRequire'];
  for (const g of globals) saved[g] = globalThis[g];
  try {
    const bases = [];
    globalThis.__cirrusNodeBuiltinTable = { builtin: 'from-table', stubbed: 'shadowed' };
    globalThis.__cirrusRealRequireShim = (name) => { if (name === 'bundled') return 'from-shim'; throw new Error('not bundled'); };
    globalThis.__cirrusRealUserspaceRequire = (name) => (name === 'user' ? 'from-vfs' : null);
    globalThis.__cirrusNodeCreateRequire = (base) => {
      bases.push(base);
      return (name) => { if (name === 'native') return 'from-createRequire'; throw new Error(`cannot find ${name}`); };
    };
    const req = new Function(`${source}\nreturn __require;`)();
    assert.deepEqual(req('stubbed'), { stub: true }, 'stubs come first');
    assert.equal(req('builtin'), 'from-table');
    assert.equal(req('bundled'), 'from-shim');
    assert.equal(req('user'), 'from-vfs');
    assert.equal(req('native'), 'from-createRequire');
    assert.throws(() => req('missing'), /\[probe __require\] failed resolving "missing": cannot find missing/);
    assert.deepEqual(bases, ['file:///t.js'], 'createRequire made once, lazily, from the bundle base');
  } finally {
    for (const g of globals) {
      if (saved[g] === undefined) delete globalThis[g];
      else globalThis[g] = saved[g];
    }
  }
}

// ── real-vite: every seam applies once; a moved anchor names itself ─
const VITE_SEAMS = {
  polyfill: ESBUILD_POLYFILL,
  factories: 'var require_picomatch = __commonJS({});\nvar require_postcss = __commonJS({});',
  require2: 'const pm = __require2("picomatch");',
  chokidarExports: 'chokidarExports = /* @__PURE__ */ requireChokidar();',
  chokidar2: 'chokidar2 = {};',
  chokidar2Overrides: 'chokidar2.watch = watch2;\nchokidar2.FSWatcher = FSWatcher;',
  wss: 'WebSocketServerRaw = process.versions.bun ? globalThis.WebSocketServer : WebSocketServerRaw_;',
  lexer: 'function k(A) { try { return (0, eval)(A); } catch (A) { } }',
  normalizeUrl: 'const normalizeUrl = /* @__PURE__ */ __name(async (url, pos, forceSkipImportAnalysis = false) => {',
  viteEsbuild: 'function esbuildPlugin() {\n  return {\n    name: "vite:esbuild",\n    async transform(code, id) {\n      return await transformWithEsbuild(code, id);\n    }\n  };\n}',
  replaceDefine: 'async function replaceDefine(environment, code, id, define) {\n  const result = await transform(code);\n  return {\n    code: result.code,\n    map: result.map || null\n  };\n}',
};
const viteBundle = Object.values(VITE_SEAMS).join('\n');
const patchedVite = patchRealViteBundle(viteBundle);
assert.ok(patchedVite.startsWith('\n// ── Cirrus real-vite bundler'), 'require shim prepended');
assert.match(patchedVite, /"picomatch": \(\) => require_picomatch\(\), "postcss": \(\) => require_postcss\(\)/);
assert.match(patchedVite, /__cirrusRealRequireShim\("picomatch"\)/);
assert.match(patchedVite, /globalThis\.__cirrusRealFsShim/, 'real-vite polyfill carries the cirrus-fs stubs');
assert.match(patchedVite, /chokidarExports = \(globalThis\.__cirrusChokidarModule/);
assert.match(patchedVite, /chokidar2 = \(globalThis\.__cirrusChokidarModule \|\| \{\}\);/);
assert.equal(patchedVite.match(/chokidar2 override suppressed/g)?.length, 2);
assert.match(patchedVite, /WebSocketServerRaw = \(globalThis\.__cirrusWsModule\?\.WebSocketServer\)/);
assert.match(patchedVite, /globalThis\.__cirrusNpmCjsMap\(id\)/);
assert.match(patchedVite, /pure-JS replacement for esbuild\.transform-based define injection/);
assert.doesNotMatch(patchedVite, /\(0, eval\)|Dynamic require of|transformWithEsbuild\(code, id\)|result\.map \|\| null/);
{
  // The eval-free lexer unescape reads every quote style.
  const k = new Function(`${patchedVite.match(/function k\(A\) \{[\s\S]*?\n  \}/)[0]}\nreturn k;`)();
  assert.equal(k('"react"'), 'react');
  assert.equal(k("'it\\'s'"), "it's");
  assert.equal(k("'say \"hi\"'"), 'say "hi"');
  assert.equal(k('`tpl`'), 'tpl');
}
for (const [name, label] of [
  ['chokidar2', /real-vite chokidar2 instance: expected exactly 1/],
  ['wss', /real-vite WebSocketServerRaw: expected exactly 1/],
  ['lexer', /real-vite es-module-lexer eval: expected exactly 1/],
  ['require2', /real-vite __require2 → __cirrusRealRequireShim: expected at least 1/],
]) {
  const moved = Object.entries(VITE_SEAMS).filter(([k]) => k !== name).map(([, v]) => v).join('\n');
  assert.throws(() => patchRealViteBundle(moved), label, `missing ${name} anchor fails loud`);
}
assert.throws(
  () => patchRealViteBundle(viteBundle.replace('var require_postcss = __commonJS({});', '')),
  /no bundled CJS factory require_postcss/,
);

// ── the staged plugin-react bundle serves react-refresh verbatim ────
// /@react-refresh is plugin-react's runtimeCode: the react-refresh runtime
// and refreshUtils.js between two fixed lines. Read it out of the staged
// bundle and compare it with the pinned packages it was built from.
{
  const worker = new URL('../../packages/worker/', import.meta.url).pathname;
  const staged = readFileSync(join(worker, 'public/_assets/cirrus-plugin-react.bundle.js'), 'utf8');
  const start = staged.indexOf('var runtimeCode = `');
  assert.ok(start >= 0, 'the staged bundle defines runtimeCode');
  let end = start + 'var runtimeCode = `'.length;
  while (staged[end] !== '`') end += staged[end] === '\\' ? 2 : 1;
  const runtimeCode = new Function(`return ${staged.slice(start + 'var runtimeCode = '.length, end + 1)};`)();
  const refreshRuntime = readFileSync(join(resolvePackageDir('react-refresh', { start: worker }), 'cjs/react-refresh-runtime.development.js'), 'utf8');
  const refreshUtils = readFileSync(join(resolvePackageDir('@vitejs/plugin-react', { start: worker }), 'dist/refreshUtils.js'), 'utf8');
  assert.ok(runtimeCode.includes("getProperty(type, '$$typeof')"), "react-refresh's `$$typeof` survives in the staged bundle");
  assert.equal(runtimeCode, `\nconst exports = {}\n${refreshRuntime}\n${refreshUtils}\nexport default exports\n`,
    'the staged /@react-refresh runtime is the pinned react-refresh + refreshUtils, byte for byte');
}

console.log('cirrus-bundle-seams: ok');
