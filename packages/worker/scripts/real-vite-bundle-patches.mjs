/**
 * real-vite-bundle-patches.mjs — the post-bundle source patches
 * bundle-real-vite.mjs applies to esbuild's output of Vite 6.
 *
 * Each patch is a named seam applied through replaceSeam, which fails
 * the build when its anchor's match count differs from what the pinned
 * Vite major produces. Vite 6 is the only supported major (Vite 7/8
 * make rolldown mandatory), so there are no alternative anchors for
 * other majors: a Vite upgrade that moves a seam stops the build here
 * instead of shipping a bundle that runs the unpatched code.
 *
 * Order matters and is preserved: the __require polyfill must be
 * replaced before the __require2 call sites are rewritten.
 */

import { replaceSeam, requirePolyfillSeam } from './cirrus-bundle-shared.mjs';

// Bundled CJS modules the injected shim resolves by bare name: chokidar's
// readdirp asks for picomatch, and Vite's CSS pipeline for postcss.
const BUNDLED_CJS = ['picomatch', 'postcss'];
// Optional deps that resolve to an empty stub module.
const STUBBED_CJS = ['bufferutil', 'utf-8-validate', 'fsevents', 'sugarss'];

/**
 * esbuild leaves `createRequire("file:///vite.bundle.js")` in the bundle
 * (Vite's code uses it deliberately), and inside bundled CJS wrappers it
 * is called as `__require2("picomatch")`. workerd's createRequire throws
 * on bare names it can't find in node_modules, uncatchably from inside
 * module-init blocks. The shim consults the bundled `require_*` factories
 * first, then the stubs.
 */
function bundledFactories(bundle) {
  const factoryNames = new Set();
  for (const m of bundle.matchAll(/\b(require_[a-zA-Z0-9_$]+)\s*=\s*__commonJS/g)) {
    factoryNames.add(m[1]);
  }
  const nameToFactory = {};
  for (const want of BUNDLED_CJS) {
    const factory = 'require_' + want;
    if (!factoryNames.has(factory)) {
      throw new Error(`real-vite: no bundled CJS factory ${factory} — the bundled Vite changed; re-derive BUNDLED_CJS`);
    }
    nameToFactory[want] = factory;
  }
  return nameToFactory;
}

function shimInjection(nameToFactory) {
  return `
// ── Cirrus real-vite bundler: __require2 + __require shim ───────
// Injected by scripts/bundle-real-vite.mjs.
//
// 1. __cirrusRealRequireShim resolves a small whitelist of bundled
//    CJS factories (picomatch/postcss inside readdirp/chokidar) —
//    consumed by the post-patched __require2 call sites.
// 2. __cirrusRealCjsRequire is a general CJS require polyfill that
//    works inside workerd. esbuild's built-in __require polyfill
//    uses \`typeof require !== "undefined" ? require : throw\`, which
//    always throws in workerd because the global \`require\` doesn't
//    exist in ESM contexts. We replace the polyfill below.
;(() => {
  const _origCreateRequire = globalThis.__origCreateRequire || null;
  const _bundledFactories = { ${Object.entries(nameToFactory)
    .map(([k, v]) => `${JSON.stringify(k)}: () => ${v}()`)
    .join(', ')} };
  const _stubModule = { __stubbed: true };
  const _stubsFor = new Set([${STUBBED_CJS.map((s) => `'${s}'`).join(', ')}]);
  globalThis.__cirrusRealRequireShim = function(name) {
    if (_bundledFactories[name]) return _bundledFactories[name]();
    if (_stubsFor.has(name)) return _stubModule;
    throw new Error('[cirrus-real] __require2("' + name + '") — not bundled');
  };

  // CJS require polyfill. Build a createRequire-backed fallback for
  // node:* builtins. Non-builtin specifiers throw loudly so we see
  // which deps still need bundling.
  let _cjsRequire = null;
  globalThis.__cirrusRealCjsRequire = function(name) {
    if (_bundledFactories[name]) return _bundledFactories[name]();
    if (_stubsFor.has(name)) return _stubModule;
    if (!_cjsRequire) {
      try {
        const { createRequire } = globalThis.require
          ? { createRequire: globalThis.require('node:module').createRequire }
          : (() => {
              // ESM-only path: import node:module statically up top? No,
              // we can't do that from injected JS. Use a synchronous
              // createRequire workaround: workerd DOES populate a
              // top-level createRequire for certain contexts.
              try { return require('node:module'); } catch { return null; }
            })();
        _cjsRequire = createRequire ? createRequire('file:///vite.bundle.js') : null;
      } catch { _cjsRequire = null; }
    }
    if (_cjsRequire) {
      try { return _cjsRequire(name); } catch (e) {
        throw new Error('[cirrus-real] __require("' + name + '") failed: ' + (e?.message || e));
      }
    }
    throw new Error('[cirrus-real] __require("' + name + '") — no CJS require available');
  };
})();
`;
}

// Rollup's native + wasm-node bindings require 'fs' / 'cirrus-fs.js' for
// a handful of read paths at module-init. Return the actual fs shim (via
// the global seeded by synthetic.js) so they get a working module, not
// an empty stub.
const FS_SHIM_STUBS = `
  Object.defineProperty(_stubs, 'cirrus-fs.js', {
    get() { return globalThis.__cirrusRealFsShim || { existsSync: () => false }; },
  });
  Object.defineProperty(_stubs, 'cirrus-fs-promises.js', {
    get() { return (globalThis.__cirrusRealFsShim || {}).promises || {}; },
  });`;

function seams() {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    requirePolyfillSeam({ base: 'file:///vite.bundle.js', label: 'cirrus-real', stubs: FS_SHIM_STUBS }),
    {
      label: 'real-vite __require2 → __cirrusRealRequireShim',
      find: new RegExp(`__require2\\("(${[...BUNDLED_CJS, ...STUBBED_CJS].map(escapeRe).join('|')})"\\)`, 'g'),
      replace: (_m, name) => `__cirrusRealRequireShim(${JSON.stringify(name)})`,
      min: 1,
    },
    // Vite inlines chokidar as CJS, so it can't be externalized; the
    // facet seeds globalThis.__cirrusChokidarModule from cirrus-chokidar.js
    // before the bundle evaluates. `chokidarExports = requireChokidar();`
    // feeds `chokidar = getDefaultExportFromCjs2(chokidarExports)`, which
    // then consumes the shim.
    {
      label: 'real-vite chokidar exports',
      find: /chokidarExports\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*requireChokidar\(\);/g,
      replace: () => `chokidarExports = (globalThis.__cirrusChokidarModule || (() => { throw new Error('cirrus-chokidar not seeded'); })());`,
      count: 1,
    },
    // Vite 6's second, inline chokidar instance (`chokidar2 = {}` plus its
    // own FSWatcher class and watch factory) is pre-seeded with the shim...
    {
      label: 'real-vite chokidar2 instance',
      find: /(\bchokidar2)\s*=\s*\{\s*\};/g,
      replace: () => `chokidar2 = (globalThis.__cirrusChokidarModule || {});`,
      count: 1,
    },
    // ...and its `chokidar2.watch = watch2; chokidar2.FSWatcher = FSWatcher;`
    // assignments, which would put the in-bundle classes back, are dropped.
    {
      label: 'real-vite chokidar2 overrides',
      find: /\bchokidar2\.(watch|FSWatcher)\s*=\s*\w+;/g,
      replace: () => `/* cirrus: chokidar2 override suppressed */;`,
      count: 2,
    },
    // ws is inlined too. `WebSocketServerRaw = process.versions.bun ? … :
    // WebSocketServerRaw_` is the one binding every `new
    // WebSocketServerRaw({noServer: true})` reads; it becomes the facet's
    // CirrusWsServer, seeded from cirrus-ws.js as __cirrusWsModule.
    {
      label: 'real-vite WebSocketServerRaw',
      find: /WebSocketServerRaw\s*=\s*process\.versions\.bun\s*\?[\s\S]*?:\s*WebSocketServerRaw_;/g,
      replace: () => `WebSocketServerRaw = (globalThis.__cirrusWsModule?.WebSocketServer) || (function(){ throw new Error('cirrus-ws not seeded'); })();`,
      count: 1,
    },
    // es-module-lexer unescapes import specifier strings with
    // `function k(A){try{return (0, eval)(A)}catch(A){}}`. workerd allows
    // eval only during startup, so at transform time it returns undefined
    // through the catch: every parsed import gets `.n = undefined`, and
    // vite:import-analysis wraps every specifier in __vite__injectQuery,
    // breaking `import X from 'react'`. Unescape the literal (double-,
    // single- or back-quoted) without eval.
    {
      label: 'real-vite es-module-lexer eval',
      find: /function k\((\w+)\) \{\s*try \{\s*return \(0, eval\)\(\1\);\s*\} catch \(\w+\) \{\s*\}\s*\}/g,
      replace: (_, arg) => `function k(${arg}) {
    try {
      const q = ${arg}[0];
      if (q === '"') return JSON.parse(${arg});
      if (q === "'") return JSON.parse('"' + ${arg}.slice(1, -1).replace(/"/g, '\\\\"').replace(/\\\\'/g, "'") + '"');
      if (q === '\`') return ${arg}.slice(1, -1);
      return ${arg};
    } catch (_e) {
      return undefined;
    }
  }`,
      count: 1,
    },
    // Debug hook: with globalThis.__cirrusResolveDebug set, log every URL
    // import analysis asks to resolve.
    {
      label: 'real-vite normalizeUrl debug hook',
      find: /const normalizeUrl = \/\* @__PURE__ \*\/ __name\(async \((\w+), (\w+), forceSkipImportAnalysis = false\) => \{/g,
      replace: (_, url, pos) =>
        `const normalizeUrl = /* @__PURE__ */ __name(async (${url}, ${pos}, forceSkipImportAnalysis = false) => {
        if (globalThis.__cirrusResolveDebug) console.log('[normalizeUrl]', ${url}, 'importer=', importer);
`,
      count: 1,
    },
    // vite:esbuild's transform calls esbuild, which the facet stubs out.
    // ESM passes through (plugin-react already lowered JSX); CJS packages
    // with a pre-built ESM bundle (bundle-npm-cjs.mjs) are served from
    // globalThis.__cirrusNpmCjsMap, since browsers can't load CJS.
    {
      label: 'real-vite vite:esbuild transform',
      find: /(name:\s*"vite:esbuild",[\s\S]{0,200}?async transform\(code,\s*)(id\d*)(\)\s*\{)[\s\S]{0,1500}?(\}\s*\}\s*;\s*\})/g,
      replace: (_, head, idArg, openBrace, tail) => head + idArg + openBrace + `
      /* cirrus-real: intercept CJS packages with pre-built ESM bundles. */
      if (globalThis.__cirrusNpmCjsMap) {
        const prebuilt = globalThis.__cirrusNpmCjsMap(${idArg});
        if (prebuilt) return { code: prebuilt, map: null };
      }
      return { code, map: null };
    ` + tail,
      count: 1,
    },
    // replaceDefine (the define plugin and client-inject) also calls
    // esbuild.transform. Substitute literal identifiers by string
    // replacement and skip sourcemaps: the only defines real-vite sets
    // are NODE_ENV and Vite's client-inject variables.
    {
      label: 'real-vite replaceDefine',
      find: /async function replaceDefine\((\w+), (\w+), (\w+), (\w+)\) \{[\s\S]{0,1500}?return \{\s*code: result\.code,\s*map: result\.map \|\| null\s*\};\s*\}/g,
      replace: (_, env, codeArg, idArg, defineArg) => `async function replaceDefine(${env}, ${codeArg}, ${idArg}, ${defineArg}) {
    /* cirrus-real: pure-JS replacement for esbuild.transform-based define injection */
    let out = ${codeArg};
    for (const key of Object.keys(${defineArg})) {
      const value = ${defineArg}[key];
      const escaped = key.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const re = new RegExp('(?<![\\\\w$])' + escaped + '(?![\\\\w$])', 'g');
      out = out.replace(re, String(value));
    }
    return { code: out, map: null };
  }`,
      count: 1,
    },
  ];
}

/**
 * Apply every real-vite seam to esbuild's output, in order, and prepend
 * the require shim. Throws on the first seam whose anchor moved.
 *
 * @param {string} bundle
 * @returns {string}
 */
export function patchRealViteBundle(bundle) {
  const nameToFactory = bundledFactories(bundle);
  for (const seam of seams()) bundle = replaceSeam(bundle, seam);
  return shimInjection(nameToFactory) + '\n' + bundle;
}
