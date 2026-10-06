/**
 * cirrus-bundle-shared.mjs — what the three cirrus-real bundlers
 * (bundle-real-vite, bundle-plugin-react, bundle-npm-cjs) share.
 *
 *   - NODE_BUILTINS: the native Node specifiers each bundle keeps
 *     external, because workerd provides them through nodejs_compat.
 *   - replaceSeam: a post-bundle source rewrite that fails the build
 *     when its anchor matches a different number of times than the
 *     pinned dependency is known to produce, so an upstream change can
 *     never silently no-op a patch.
 *   - requirePolyfillSeam: the replacement for esbuild's `__require`
 *     polyfill, which always throws in workerd's ESM context.
 *   - withoutStorePaths: module paths as `node_modules/<pkg>/…`, whatever
 *     the install layout.
 */

/**
 * Native Node builtins, `node:`-prefixed and bare. Only real builtins
 * belong here: a bundler-specific virtual module (real-vite's LOADER
 * shims) is appended by that bundler, never shared.
 */
export const NODE_BUILTINS = [
  'node:assert', 'node:buffer', 'node:child_process', 'node:crypto',
  'node:dns', 'node:events', 'node:fs', 'node:fs/promises', 'node:http',
  'node:https', 'node:module', 'node:net', 'node:os', 'node:path',
  'node:perf_hooks', 'node:process', 'node:querystring', 'node:readline',
  'node:stream', 'node:string_decoder', 'node:timers', 'node:timers/promises',
  'node:tls', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:worker_threads', 'node:zlib', 'node:http2', 'node:stream/web',
  'node:stream/promises', 'node:async_hooks', 'node:vm', 'node:diagnostics_channel',
  'node:inspector', 'node:constants',
  'fs', 'path', 'url', 'util', 'os', 'net', 'crypto', 'child_process',
  'dns', 'tty', 'worker_threads', 'assert', 'process', 'v8', 'events',
  'http', 'https', 'zlib', 'stream', 'buffer', 'readline', 'module',
  'string_decoder', 'timers', 'querystring', 'perf_hooks', 'http2',
  'tls', 'async_hooks',
];

/**
 * Rewrite every match of `find` (a global RegExp) and throw unless it
 * matched exactly `count` times (or at least `min` times, for a rewrite
 * whose number of call sites is not part of the contract).
 *
 * @param {string} source
 * @param {{ label: string, find: RegExp, replace: string | ((...m: string[]) => string), count?: number, min?: number }} seam
 */
export function replaceSeam(source, { label, find, replace, count, min }) {
  if (!find.global) throw new Error(`${label}: seam pattern must be global`);
  if ((count === undefined) === (min === undefined)) {
    throw new Error(`${label}: give exactly one of count or min`);
  }
  let matched = 0;
  const out = source.replace(find, (...m) => {
    matched++;
    return typeof replace === 'function' ? replace(...m) : replace;
  });
  if (count !== undefined ? matched !== count : matched < min) {
    const want = count !== undefined ? `exactly ${count}` : `at least ${min}`;
    throw new Error(
      `${label}: expected ${want} match(es) for ${find}, found ${matched} — `
      + 'the bundled dependency changed; re-derive the seam',
    );
  }
  return out;
}

/**
 * esbuild's `__require` polyfill does `typeof require !== "undefined" ?
 * require : throw`, which always throws in workerd's ESM context. The
 * replacement resolves, in order: `stubs` (a source fragment defining
 * extra `_stubs` entries), the facet's node builtin table, the bundled
 * CJS factories, the VFS userspace require, and finally a lazily created
 * `createRequire(base)`.
 *
 * @param {{ base: string, label: string, stubs?: string }} options
 *   `base` is the synthetic file URL the bundle defines for
 *   import.meta.url; `label` prefixes every diagnostic.
 */
export function requirePolyfillSeam({ base, label, stubs = '' }) {
  const replacement = `var __require = /* @__PURE__ */ (function() {
  // Lazy-init: __cirrusNodeCreateRequire is set by main.js BEFORE
  // the bundle evaluates, but we defer the createRequire() call
  // until first use so module-init order doesn't matter.
  let _cjsRequire = null;
  function _getRequire() {
    if (_cjsRequire) return _cjsRequire;
    const cr = globalThis.__cirrusNodeCreateRequire;
    if (cr) {
      try { _cjsRequire = cr(${JSON.stringify(base)}); } catch (e) {
        console.warn('[${label} __require] createRequire failed:', e?.message);
      }
    }
    return _cjsRequire;
  }
  const _stubs = {};${stubs}
  return function __require(name) {
    if (_stubs[name]) return _stubs[name];
    if (globalThis.__cirrusNodeBuiltinTable && globalThis.__cirrusNodeBuiltinTable[name]) {
      return globalThis.__cirrusNodeBuiltinTable[name];
    }
    if (globalThis.__cirrusRealRequireShim) {
      try { return globalThis.__cirrusRealRequireShim(name); }
      catch (_e) { /* fall through */ }
    }
    // VFS-backed userspace modules (e.g. react-refresh/babel loaded
    // dynamically by @vitejs/plugin-react at transform time). Lives
    // in cirrus-real.ts' main.js synthetic init.
    if (globalThis.__cirrusRealUserspaceRequire) {
      try {
        const mod = globalThis.__cirrusRealUserspaceRequire(name);
        if (mod) return mod;
      } catch (_e) { /* fall through */ }
    }
    const req = _getRequire();
    if (req) {
      try { return req(name); }
      catch (e) { throw Error('[${label} __require] failed resolving "' + name + '": ' + (e?.message || e)); }
    }
    throw Error('[${label} __require] no createRequire available for "' + name + '"');
  };
})();`;
  return {
    label: `${label} __require polyfill`,
    find: /var __require = [\s\S]*?throw Error\('Dynamic require of "' \+ x \+ '" is not supported'\);\s*\}\);/g,
    replace: () => replacement,
    count: 1,
  };
}

/**
 * esbuild names every bundled module by its path from the working
 * directory, in a comment and as its __commonJS / __esm key. Under bun's
 * isolated linker that path runs through the store
 * (`../../node_modules/.bun/<pkg>@<version>+<peer hash>/node_modules/<pkg>/…`),
 * and the peer hash moves whenever an unrelated package changes a peer's
 * resolution. Naming modules `node_modules/<pkg>/…` keeps a staged bundle a
 * function of its own inputs. The paths are names only: nothing resolves
 * them at runtime.
 *
 * @param {string} text
 */
export function withoutStorePaths(text) {
  return text.replace(/(?:\.\.\/)*node_modules\/\.bun\/[^/"\s]+\/node_modules\//g, () => 'node_modules/');
}
