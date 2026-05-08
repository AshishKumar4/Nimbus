/**
 * ViteDevServer v2.0 — lightweight Vite-compatible dev server for Nimbus.
 *
 * Not actual Vite (which is 200+ packages). This is a purpose-built dev server
 * that implements the subset of Vite's behavior needed for serving modern
 * web apps: TS/TSX/JSX transform, bare import rewriting, HMR full-reload,
 * path alias resolution, TailwindCSS Play CDN, CSS-as-JS modules.
 *
 * Architecture:
 *   Browser iframe → /preview/* → DO fetch() → ViteDevServer.handleRequest()
 *     ├── /                    → serves index.html (injects HMR, Tailwind CDN, <base>)
 *     ├── /*.ts,*.tsx,*.jsx    → esbuild transform → JS with import rewrites + alias resolution
 *     ├── /*.css               → serve as text/css (with @import inlining, @tailwind stripping, @apply expansion)
 *     ├── /*.css?import        → wrap CSS in JS that injects <style> tag
 *     ├── /@modules/<pkg>      → resolve from node_modules, bundle via esbuild facet (synthetic-entry for barrels)
 *     ├── /@vite/client        → HMR client script
 *     ├── /*.json (as module)  → export default { ... }
 *     ├── /*.svg,*.png,... (as module) → export default "/preview/path/to/asset"
 *     └── /*                   → serve from VFS as-is (static assets)
 *
 * HMR: VFS events → ViteDevServer detects changes → sends {type:'hmr'}
 *       messages through the DO WebSocket → frontend dispatches to iframe.
 */

import type { SqliteVFS } from './sqlite-vfs.js';
import type { VfsEventEmitter, VfsEvent } from './vfs-events.js';
import type { EsbuildService } from './esbuild-service.js';
import { getSharedRuntimeExternals, BUNDLER_VERSION } from './esbuild-service.js';
import { NpmCache } from './npm-cache.js';
import { countPackageFiles, BARREL_PKG_FILE_THRESHOLD, packageNameFromSpecifier } from './barrel-detect.js';
import {
  scanNamedImports,
  buildSyntheticEntry,
  buildScopedSliceForSynthetic,
  syntheticEntryPath,
} from './barrel-synthesizer.js';
import type { SliceEntry } from './pre-bundle-facet.js';
import { resolvePackageEntry } from './_shared/exports-resolver.js';
import { injectRouterBasename, shouldProcessForRouter } from './router-basename.js';
import {
  TAILWIND_PLAY_BUNDLE,
  TAILWIND_PLAY_VERSION,
} from './tailwind-play.generated.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ViteDevServerOptions {
  vfs: SqliteVFS;
  esbuild: EsbuildService;
  /** Root directory in VFS (e.g. "home/user/projects") */
  root: string;
  /** Callback to send HMR messages to the browser */
  onHmrMessage: (msg: any) => void;
  /** Port the virtual server "listens" on */
  port?: number;
  /** URL prefix the server is mounted at (e.g. "/preview"). Default: "/preview" */
  basePath?: string;
  /** Path aliases from vite.config.ts resolve.alias (e.g. { "@": "./src" }) */
  aliases?: Record<string, string>;
  /** Define replacements from vite.config.ts define (e.g. { "global": "globalThis" }) */
  define?: Record<string, string>;
  /** SqlStorage for pkg_esm_bundles cache (optional — enables local module serving) */
  sql?: SqlStorage;
  /**
   * Auto-inject React Router `basename` into entry files so <NavLink to="/x">
   * lands at `${basePath}/x`. Default: true. Set to false via
   * vite.config.ts `nimbusInjectBasename: false` to disable globally, or use
   * the `// nimbus-no-basename` comment for per-file opt-out.
   */
  injectBasename?: boolean;
  /**
   * Worker bindings env. Required for the on-demand-bundle facet path
   * (LOADER + ctx-exports). When provided, /preview/@modules/<spec>
   * misses bundle in a NimbusLoaderPool isolate instead of the
   * supervisor's EsbuildService — same architecture as the
   * pre-bundle path. Without this option, the supervisor falls back
   * to in-process esbuild (legacy behaviour).
   */
  env?: any;
  /** Durable Object state — needed alongside `env` for the facet pool. */
  ctx?: DurableObjectState;
}

// ── HMR client code ─────────────────────────────────────────────────────
// Injected into index.html. Listens for HMR messages from parent window
// (forwarded by the main Nimbus frontend from the WebSocket).

const HMR_CLIENT = `<script type="module">
// Nimbus HMR Client — listens for reload messages from parent
(function() {
  window.__NIMBUS_HMR = true;
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'nimbus-hmr') {
      if (e.data.event === 'full-reload') {
        console.log('[nimbus-hmr] full reload');
        location.reload();
      } else if (e.data.event === 'css-update') {
        // Reload all stylesheets
        document.querySelectorAll('link[rel="stylesheet"]').forEach(function(l) {
          var href = l.href;
          l.href = '';
          l.href = href + (href.includes('?') ? '&' : '?') + 't=' + Date.now();
        });
        // Re-fetch injected style tags
        document.querySelectorAll('style[data-vite-dev-id]').forEach(function(s) {
          var id = s.getAttribute('data-vite-dev-id');
          if (id) {
            fetch(id + '?import&t=' + Date.now())
              .then(function(r) { return r.text(); })
              .then(function(js) { try { new Function(js)(); } catch(e) {} });
          }
        });
      }
    }
  });
  console.log('[nimbus-hmr] connected');
})();
</script>`;

/**
 * Runtime-error overlay injected into the served index.html.
 *
 * Catches:
 *   - window 'error' events (uncaught synchronous throws + <script type="module"> load failures)
 *   - window 'unhandledrejection' events (promise rejections)
 *
 * Renders a red banner at the top of the page with:
 *   - the error message
 *   - a hint to run `npm install` when the message looks like a module-resolution error
 *   - a Reload button
 *
 * Self-contained, classic <script> (runs synchronously before modules load
 * so listeners are attached before user code begins). Uses a stable overlay
 * id so repeated errors replace the previous banner instead of stacking.
 *
 * Cleared automatically on HMR reload because the whole page is re-rendered
 * (HMR_CLIENT calls location.reload() on 'full-reload' events).
 */
const ERROR_OVERLAY_CLIENT = `<script>(()=>{const s=(m)=>{let o=document.getElementById('nimbus-error-overlay');if(!o){o=document.createElement('div');o.id='nimbus-error-overlay';o.style.cssText='position:fixed;top:0;left:0;right:0;background:#b91c1c;color:white;padding:16px;font-family:monospace;font-size:13px;z-index:999999;max-height:50vh;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,.3)';document.body&&document.body.appendChild(o)}o.innerHTML='<strong>Preview crashed</strong><pre style="white-space:pre-wrap;margin:8px 0 0">'+String(m||'').replace(/</g,'&lt;')+'</pre>'+(/does not provide an export|Failed to resolve/.test(m||'')?'<div style="margin-top:8px;font-size:12px">Hint: run <code>npm install</code> in your project.</div>':'')+'<button onclick="location.reload()" style="margin-top:8px;padding:4px 12px;background:white;color:#b91c1c;border:0;border-radius:4px;cursor:pointer">Reload</button>'};window.addEventListener('error',e=>s((e.message||'')+' @ '+String(e.filename||'').replace(location.origin,'')+':'+e.lineno));window.addEventListener('unhandledrejection',e=>s(String(e.reason?.message||e.reason||'(rejection)').substring(0,500)))})();</script>`;

// ── MIME types ───────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.mts': 'application/javascript; charset=utf-8',
  '.cts': 'application/javascript; charset=utf-8',
  // SFC formats — served as JS so a future framework plugin can transform them.
  // Without a compiler plugin, the raw source would be served and the browser
  // would fail to parse it — that's a framework integration problem, not a
  // resolver correctness problem. At least the MIME is right.
  '.vue': 'application/javascript; charset=utf-8',
  '.svelte': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

/** File extensions that should be treated as static assets when imported from JS */
const ASSET_EXTS = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.mp3', '.pdf',
]);

// ── CJS external-require → ESM import rewriting ─────────────────────────

/**
 * esbuild, when bundling CJS source with `external` specifiers, leaves the
 * `require("pkg")` calls in the output wrapped in a `__require()` helper that
 * falls back to the global `require`. In the browser there is no global
 * `require`, so every such call throws.
 *
 * The fix: detect all distinct `__require("X")` specifiers in the output,
 * emit a top-level ESM `import * as __ns_X from "X"` for each, and replace
 * every `__require("X")` call with a reference to that namespace (with
 * default-export interop — `__ns_X.default ?? __ns_X`).
 *
 * Before:
 *   var __require = ((x) => typeof require !== "undefined" ? require : ...);
 *   var React = __require("react");
 *
 * After:
 *   import * as __nimbus_ext__react from "react";
 *   const __nimbus_req = (id) => {
 *     if (id === "react") return __nimbus_ext__react.default ?? __nimbus_ext__react;
 *     throw new Error("require: " + id);
 *   };
 *   var __require = ((x) => typeof require !== "undefined" ? require : ...);
 *   var React = __nimbus_req("react");
 *
 * We inject `__nimbus_req` but keep esbuild's `__require` definition so we
 * don't have to rewrite its declaration — we just replace the call-sites.
 */
function rewriteExternalRequires(code: string, basePath: string): string {
  // Find all `__require("specifier")` calls where the specifier is bare
  // (not a relative/absolute path). Bare specifiers are the only ones that
  // can be external.
  const specifiers = new Set<string>();
  for (const m of code.matchAll(/__require\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
    specifiers.add(m[1]);
  }
  if (specifiers.size === 0) return code;

  // Generate namespace variable names — sanitize specifier for use in identifier.
  const specMap = new Map<string, string>(); // specifier → namespace var name
  for (const spec of specifiers) {
    const safe = spec.replace(/[^A-Za-z0-9_]/g, '_');
    specMap.set(spec, '__nimbus_ext__' + safe);
  }

  // Build the import banner + dispatch function.
  const imports: string[] = [];
  const cases: string[] = [];
  for (const [spec, ns] of specMap) {
    // Build URL with base prefix (makeModuleUrl handles edge cases)
    const url = makeModuleUrl(basePath, spec);
    imports.push(`import * as ${ns} from ${JSON.stringify(url)};`);
    cases.push(`  if (id === ${JSON.stringify(spec)}) return ${ns}.default ?? ${ns};`);
  }
  const banner =
    imports.join('\n') + '\n' +
    'function __nimbus_req(id) {\n' +
    cases.join('\n') + '\n' +
    '  throw new Error("Cannot require external: " + id);\n' +
    '}\n';

  // Replace all `__require("specifier")` call-sites with `__nimbus_req("specifier")`.
  // The replacement preserves the specifier string so the dispatch function
  // looks up the correct namespace.
  const rewritten = code.replace(
    /__require\s*\(\s*(["'])([^"'.][^"']*)\1\s*\)/g,
    (_m, q, s) => `__nimbus_req(${q}${s}${q})`,
  );

  return banner + rewritten;
}

// ── CJS → ESM named-exports synthesis ───────────────────────────────────

/**
 * esbuild bundles CJS packages by wrapping them in __commonJS helpers.
 * The resulting ESM bundle only has `export default require_X()` — no named
 * exports. This breaks `import { createRoot } from "react-dom/client"`.
 *
 * We fix this by STATICALLY analyzing the bundled source to find CJS export
 * patterns, then emitting named exports for each found name. We cannot use
 * `new Function()` or `eval()` to get runtime export keys because the
 * Cloudflare Workers runtime disallows string-to-code generation outside of
 * module initialization.
 *
 * Patterns we detect (scanning the entire bundled text, not just the top level):
 *   - `exports.NAME = ...`
 *   - `exports["NAME"] = ...`
 *   - `Object.defineProperty(exports, "NAME", ...)`
 *   - `module.exports.NAME = ...`
 *   - `module.exports = { NAME, NAME2, ... }` (object literal)
 *
 * Input  (esbuild output):
 *   var require_X = __commonJS({ "...": function(exports) { exports.jsx = ...; exports.jsxs = ...; } });
 *   export default require_X();
 *
 * Output (synthesized):
 *   var require_X = __commonJS({...});
 *   const __nimbus_ns = require_X();
 *   export default __nimbus_ns;
 *   export const jsx = __nimbus_ns.jsx;
 *   export const jsxs = __nimbus_ns.jsxs;
 *
 * Note: we emit `export const NAME = __nimbus_ns.NAME` per key rather than
 * `export const { NAME, ... } = __nimbus_ns` destructuring. The former
 * preserves live binding semantics slightly better and avoids issues when
 * a key name happens to shadow a keyword or identifier.
 *
 * Returns the original code unchanged if:
 *   - The bundle already has named exports (not a CJS-only bundle)
 *   - No `export default` pattern found
 *   - No CJS export patterns found in the bundle source
 */
function synthesizeCjsNamedExports(code: string): string {
  // Quick check: does the bundle already have named exports?
  if (/(^|\n)\s*export\s+(?:const|let|var|function|class|\{|\*)\b/.test(code)) {
    return code;
  }

  // Confirm we have `export default ...` pattern.
  const defaultMatch = code.match(/(^|\n)\s*export\s+default\s+([^;]+);?\s*(?:\/\/[^\n]*)?$/m);
  if (!defaultMatch) return code;

  // Extract named exports by scanning the bundled source for CJS patterns.
  const names = extractCjsExportNames(code);
  if (names.length === 0) return code;

  // Build the synthesized bundle. Replace `export default X` with:
  //   const __nimbus_ns = X;
  //   export default __nimbus_ns;
  //   export const NAME1 = __nimbus_ns.NAME1;
  //   export const NAME2 = __nimbus_ns.NAME2;
  //   ...
  const namedExportLines = names
    .map(n => `export const ${n} = __nimbus_ns.${n};`)
    .join('\n');

  const rewritten = code.replace(
    /(^|\n)\s*export\s+default\s+([^;]+);?\s*$/m,
    `$1const __nimbus_ns = ($2);\nexport default __nimbus_ns;\n${namedExportLines}\n`,
  );

  return rewritten;
}

/**
 * Statically extract named export names from a CJS bundle source. Scans the
 * entire text (not scoped — CJS exports appear throughout __commonJS wrappers)
 * for `exports.X =`, `exports["X"] =`, `Object.defineProperty(exports, "X", ...)`,
 * and `module.exports = { X, Y }` patterns.
 *
 * Returns a deduplicated array of valid ES identifier names, filtered to
 * exclude reserved keywords and `default` (which is already the default export).
 */
function extractCjsExportNames(code: string): string[] {
  const names = new Set<string>();

  // Pattern 1: exports.NAME = ...
  // Matches `exports.createRoot = ...`, `exports . hydrateRoot = ...`
  for (const m of code.matchAll(/(?:^|[^.\w$])exports\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    names.add(m[1]);
  }

  // Pattern 2: exports["NAME"] = ... or exports['NAME'] = ...
  for (const m of code.matchAll(/(?:^|[^.\w$])exports\s*\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]\s*=/g)) {
    names.add(m[1]);
  }

  // Pattern 3: Object.defineProperty(exports, "NAME", ...)
  for (const m of code.matchAll(/Object\.defineProperty\s*\(\s*exports\s*,\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']/g)) {
    names.add(m[1]);
  }

  // Pattern 4: module.exports.NAME = ...
  for (const m of code.matchAll(/module\s*\.\s*exports\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    names.add(m[1]);
  }

  // Pattern 5: module.exports = { NAME, NAME2: value, ... }
  // Find `module.exports = {` then scan the balanced braces for keys.
  const moduleExportsMatch = code.match(/module\s*\.\s*exports\s*=\s*\{/);
  if (moduleExportsMatch) {
    const startIdx = moduleExportsMatch.index! + moduleExportsMatch[0].length;
    // Find matching closing brace (simple depth tracking, ignoring strings/comments).
    let depth = 1;
    let i = startIdx;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' || ch === "'" || ch === '`') {
        // Skip string literal
        const quote = ch;
        i++;
        while (i < code.length && code[i] !== quote) {
          if (code[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    if (depth === 0) {
      const objBody = code.substring(startIdx, i - 1);
      // Extract keys from object literal (identifier before `:` or `,`/`}`).
      for (const m of objBody.matchAll(/(?:^|[,{])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,:}])/g)) {
        names.add(m[1]);
      }
      // Also: quoted keys like "name": value
      for (const m of objBody.matchAll(/(?:^|[,{])\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*:/g)) {
        names.add(m[1]);
      }
    }
  }

  // Filter: exclude `default` (already the default export), reserved words,
  // and anything that's not a valid ES identifier.
  return Array.from(names).filter(n =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) &&
    n !== 'default' &&
    !RESERVED_ES_KEYWORDS.has(n),
  );
}

/** ES reserved keywords that can't be used as destructured variable names. */
const RESERVED_ES_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'super', 'switch', 'static', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

// ── Import rewriting ────────────────────────────────────────────────────

/**
 * Resolve a specifier against path aliases.
 * Uses longest-match semantics (e.g. "@/lib" takes priority over "@").
 * Returns the rewritten path (e.g. "/preview/src/components/Foo") or null.
 *
 * basePath must be the dev server's mount point without trailing slash
 * (e.g. "/preview"). If basePath is "/" or empty, output is origin-rooted.
 */
/**
 * Collapse `..` and `.` segments in a VFS path.
 *
 * Essential for entries coming from package.json `main`/`module` that point
 * OUTSIDE their own directory — e.g. react-remove-scroll-bar's nested
 * `constants/package.json` has `"module": "../dist/es2015/constants.js"`,
 * which when naively joined produces `constants/../dist/es2015/constants.js`.
 * The VFS doesn't interpret `..` at lookup time — it treats it as a literal
 * path component that doesn't exist, so resolution fails and we fall through
 * to a bogus CDN wrapper.
 *
 * Leading slashes are preserved. Trailing slashes are stripped.
 * Returns the empty string for a pure-dot path like "." or "./.".
 */
function normalizePath(p: string): string {
  const leadingSlash = p.startsWith('/');
  const segments = p.split('/').reduce<string[]>((acc, seg) => {
    if (seg === '..') {
      // Pop the previous segment if there is one (don't pop past root).
      if (acc.length > 0 && acc[acc.length - 1] !== '..') acc.pop();
      else if (!leadingSlash) acc.push('..'); // preserve leading .. for relative paths
    } else if (seg !== '.' && seg !== '') {
      acc.push(seg);
    }
    return acc;
  }, []);
  return (leadingSlash ? '/' : '') + segments.join('/');
}

function resolveAliasSpecifier(specifier: string, aliases: Record<string, string>, basePath: string): string | null {
  // Sort by alias length descending for longest-match-first
  const sorted = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, target] of sorted) {
    // Match exact alias or alias followed by /
    if (specifier === alias || specifier.startsWith(alias + '/')) {
      const rest = specifier.slice(alias.length); // e.g. "/components/Foo" or ""
      const resolvedTarget = target.replace(/^\.\//, '').replace(/^\//, '');
      // Normalize basePath: strip trailing slash so we always emit exactly one
      // slash between base and target. Handle root ("/" or "") specially.
      const base = basePath === '/' || basePath === '' ? '' : basePath.replace(/\/+$/, '');
      return `${base}/${resolvedTarget}${rest}`;
    }
  }
  return null;
}

/**
 * Build an absolute URL for a /@modules/ endpoint, properly prefixed with the
 * dev server's base path so the browser's origin-relative fetch hits the route.
 *
 * Examples:
 *   makeModuleUrl('/preview', 'react')      → '/preview/@modules/react'
 *   makeModuleUrl('/preview/', 'react')     → '/preview/@modules/react'   (no double slash)
 *   makeModuleUrl('/', 'react')             → '/@modules/react'           (root base)
 *   makeModuleUrl('', 'react')              → '/@modules/react'           (empty/undefined)
 *   makeModuleUrl(undefined, 'react')       → '/@modules/react'           (undefined)
 *
 * This matters because the browser resolves `/@modules/...` against the origin
 * (NOT against <base>), so without the prefix the request misses the
 * `/preview/*` route and 404s.
 */
function makeModuleUrl(basePath: string | undefined, specifier: string): string {
  if (!basePath || basePath === '/' || basePath === '') {
    return `/@modules/${specifier}`;
  }
  // Strip trailing slash from basePath so we get exactly one slash before @modules
  const base = basePath.replace(/\/+$/, '');
  return `${base}/@modules/${specifier}`;
}

/**
 * Node.js core builtins. Bare imports of these names should be rewritten to
 * `node:<name>` rather than treated as bare npm specifiers — otherwise the
 * browser dev server tries to fetch them from `/preview/@modules/crypto` and
 * 404s. See audit/sections/03-resolver-gaps.md §3.6.
 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'fs/promises', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
  'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events',
  'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
]);

/**
 * Resolve a bare specifier: alias → resolved path, or bare → /<base>/@modules/pkg.
 * Returns null if specifier should not be rewritten.
 */
function resolveBareSpecifier(specifier: string, aliases?: Record<string, string>, basePath?: string): string | null {
  // Skip already-rewritten or absolute URLs
  if (specifier.startsWith('@modules/')) return null;
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) return null;
  // Skip protocol-like specifiers: data:, blob:, virtual:, node:, etc.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  // Bare-builtin handling: a bare `crypto` (no protocol prefix) that names
  // a Node core builtin must NOT be served from /@modules/ (which 404s in
  // the browser — verified Mossaic regression). Returning null here leaves
  // the literal `import 'crypto'` in place — matching the behaviour for
  // already-prefixed `node:crypto` (skipped by the protocol regex above).
  // Both surface a clear "Failed to resolve module 'crypto'" rather than a
  // misleading 404. Browser-side shim wiring is the W7 deliverable per
  // audit/sections/03-resolver-gaps.md §3.6.
  if (NODE_BUILTINS.has(specifier)) {
    return null; // leave the bare specifier untouched
  }
  // Check aliases (works for CSS specifiers too — alias takes priority)
  if (aliases) {
    const resolved = resolveAliasSpecifier(specifier, aliases, basePath || '/preview');
    if (resolved) return resolved;
  }
  // Don't rewrite CSS bare imports to /@modules/ (they should be file paths)
  if (specifier.endsWith('.css') || specifier.includes('.css?')) return null;
  return makeModuleUrl(basePath, specifier);
}

/**
 * Rewrite all bare import/export specifiers in JS code.
 *
 * Handles ALL import forms including multi-line:
 *   1. import "specifier"                       (side-effect)
 *   2. import defaultExport from "specifier"     (default)
 *   3. import { named } from "specifier"         (named, possibly multi-line)
 *   4. import * as ns from "specifier"           (namespace)
 *   5. export { named } from "specifier"         (re-export)
 *   6. export * from "specifier"                 (re-export all)
 *   7. import("specifier")                       (dynamic)
 *
 * Strategy: Three separate passes to avoid cross-statement regex issues.
 *   Pass 1: CSS side-effect imports (append ?import)
 *   Pass 2: Side-effect bare imports (import "specifier";)
 *   Pass 3: All "from" clause specifiers (works with multi-line imports)
 *   Pass 4: Dynamic imports (import("specifier"))
 */
// Valid npm specifier character class. Allows package names (letters, digits,
// hyphens, underscores, dots), scoped packages (@scope/name), subpaths
// (slashes), and query strings (?v=123 for HMR invalidation). Crucially,
// it EXCLUDES spaces, operators (+, *, (, )), and other punctuation that
// would never appear in a real import specifier. Before this restriction,
// regexes like `/from "([^"]*)"/` matched inside string literals such as:
//
//   throw new Error("called from " + fn.name + " here");
//
// treating "` + fn.name + `" as a specifier and corrupting the source code.
// After: only character sequences that look like valid specifiers match.
const SPECIFIER_WITH_QUERY = '[A-Za-z0-9_@][A-Za-z0-9_@./?=&-]*';

function rewriteAllImports(code: string, aliases?: Record<string, string>, basePath?: string): string {
  // Pass 1: CSS side-effect imports: import "./foo.css" → import "./foo.css?import"
  //         import "@/index.css" → import "/preview/src/index.css?import"
  code = code.replace(
    /import\s+(["'])([^"']+\.css)\1\s*;/g,
    (_match: string, quote: string, path: string) => {
      if (aliases && !path.startsWith('.') && !path.startsWith('/')) {
        const resolved = resolveAliasSpecifier(path, aliases, basePath || '/preview');
        if (resolved) return `import ${quote}${resolved}?import${quote};`;
      }
      return `import ${quote}${path}?import${quote};`;
    }
  );

  // Pass 2: Side-effect bare imports: import "specifier";
  code = code.replace(
    new RegExp(`import\\s+(["'])(${SPECIFIER_WITH_QUERY})\\1\\s*;`, 'g'),
    (match: string, quote: string, specifier: string) => {
      const resolved = resolveBareSpecifier(specifier, aliases, basePath);
      return resolved ? `import ${quote}${resolved}${quote};` : match;
    }
  );

  // Pass 3: All "from" clause specifiers — handles single AND multi-line imports.
  // Matches: import X from "pkg", import { X } from "pkg", export { X } from "pkg",
  // import * as X from "pkg", export * from "pkg" — even multi-line.
  code = code.replace(
    new RegExp(`(\\bfrom\\s+)(["'])(${SPECIFIER_WITH_QUERY})\\2`, 'g'),
    (match: string, fromPart: string, quote: string, specifier: string) => {
      const resolved = resolveBareSpecifier(specifier, aliases, basePath);
      return resolved ? `${fromPart}${quote}${resolved}${quote}` : match;
    }
  );

  // Pass 4: Dynamic imports: import("specifier")
  code = code.replace(
    new RegExp(`import\\(\\s*(["'])(${SPECIFIER_WITH_QUERY})\\1\\s*\\)`, 'g'),
    (match: string, quote: string, specifier: string) => {
      const resolved = resolveBareSpecifier(specifier, aliases, basePath);
      return resolved ? `import(${quote}${resolved}${quote})` : match;
    }
  );

  return code;
}

// ── Tailwind @apply expander ────────────────────────────────────────────

/** Responsive breakpoints for Tailwind prefixes */
const TW_BREAKPOINTS: Record<string, string> = {
  'sm': '640px', 'md': '768px', 'lg': '1024px', 'xl': '1280px', '2xl': '1536px',
};

/** Standard Tailwind utility → CSS property map */
const TW_UTILITIES: Record<string, string> = {
  // Display
  'block': 'display: block',
  'inline-block': 'display: inline-block',
  'inline': 'display: inline',
  'flex': 'display: flex',
  'inline-flex': 'display: inline-flex',
  'grid': 'display: grid',
  'hidden': 'display: none',
  'contents': 'display: contents',
  // Position
  'static': 'position: static',
  'fixed': 'position: fixed',
  'absolute': 'position: absolute',
  'relative': 'position: relative',
  'sticky': 'position: sticky',
  // Inset
  'inset-0': 'inset: 0px',
  'top-0': 'top: 0px',
  'right-0': 'right: 0px',
  'bottom-0': 'bottom: 0px',
  'left-0': 'left: 0px',
  // Flex
  'flex-row': 'flex-direction: row',
  'flex-col': 'flex-direction: column',
  'flex-wrap': 'flex-wrap: wrap',
  'flex-nowrap': 'flex-wrap: nowrap',
  'flex-1': 'flex: 1 1 0%',
  'flex-auto': 'flex: 1 1 auto',
  'flex-initial': 'flex: 0 1 auto',
  'flex-none': 'flex: none',
  'flex-grow': 'flex-grow: 1',
  'flex-shrink': 'flex-shrink: 1',
  'grow': 'flex-grow: 1',
  'shrink': 'flex-shrink: 1',
  'shrink-0': 'flex-shrink: 0',
  // Align / Justify
  'items-start': 'align-items: flex-start',
  'items-end': 'align-items: flex-end',
  'items-center': 'align-items: center',
  'items-baseline': 'align-items: baseline',
  'items-stretch': 'align-items: stretch',
  'justify-start': 'justify-content: flex-start',
  'justify-end': 'justify-content: flex-end',
  'justify-center': 'justify-content: center',
  'justify-between': 'justify-content: space-between',
  'justify-around': 'justify-content: space-around',
  'justify-evenly': 'justify-content: space-evenly',
  'self-auto': 'align-self: auto',
  'self-start': 'align-self: flex-start',
  'self-end': 'align-self: flex-end',
  'self-center': 'align-self: center',
  'self-stretch': 'align-self: stretch',
  // Sizing
  'w-full': 'width: 100%',
  'w-screen': 'width: 100vw',
  'w-auto': 'width: auto',
  'w-fit': 'width: fit-content',
  'w-min': 'width: min-content',
  'w-max': 'width: max-content',
  'min-w-0': 'min-width: 0px',
  'min-w-full': 'min-width: 100%',
  'max-w-none': 'max-width: none',
  'max-w-full': 'max-width: 100%',
  'h-full': 'height: 100%',
  'h-screen': 'height: 100vh',
  'h-auto': 'height: auto',
  'h-fit': 'height: fit-content',
  'min-h-0': 'min-height: 0px',
  'min-h-full': 'min-height: 100%',
  'min-h-screen': 'min-height: 100vh',
  // Overflow
  'overflow-auto': 'overflow: auto',
  'overflow-hidden': 'overflow: hidden',
  'overflow-visible': 'overflow: visible',
  'overflow-scroll': 'overflow: scroll',
  'overflow-x-auto': 'overflow-x: auto',
  'overflow-x-hidden': 'overflow-x: hidden',
  'overflow-y-auto': 'overflow-y: auto',
  'overflow-y-hidden': 'overflow-y: hidden',
  // Typography
  'text-left': 'text-align: left',
  'text-center': 'text-align: center',
  'text-right': 'text-align: right',
  'text-justify': 'text-align: justify',
  'text-xs': 'font-size: 0.75rem; line-height: 1rem',
  'text-sm': 'font-size: 0.875rem; line-height: 1.25rem',
  'text-base': 'font-size: 1rem; line-height: 1.5rem',
  'text-lg': 'font-size: 1.125rem; line-height: 1.75rem',
  'text-xl': 'font-size: 1.25rem; line-height: 1.75rem',
  'text-2xl': 'font-size: 1.5rem; line-height: 2rem',
  'text-3xl': 'font-size: 1.875rem; line-height: 2.25rem',
  'text-4xl': 'font-size: 2.25rem; line-height: 2.5rem',
  'text-5xl': 'font-size: 3rem; line-height: 1.1',
  'text-6xl': 'font-size: 3.75rem; line-height: 1.1',
  'text-7xl': 'font-size: 4.5rem; line-height: 1.1',
  'text-8xl': 'font-size: 6rem; line-height: 1',
  'text-9xl': 'font-size: 8rem; line-height: 1',
  'font-thin': 'font-weight: 100',
  'font-extralight': 'font-weight: 200',
  'font-light': 'font-weight: 300',
  'font-normal': 'font-weight: 400',
  'font-medium': 'font-weight: 500',
  'font-semibold': 'font-weight: 600',
  'font-bold': 'font-weight: 700',
  'font-extrabold': 'font-weight: 800',
  'font-black': 'font-weight: 900',
  'italic': 'font-style: italic',
  'not-italic': 'font-style: normal',
  'underline': 'text-decoration-line: underline',
  'overline': 'text-decoration-line: overline',
  'line-through': 'text-decoration-line: line-through',
  'no-underline': 'text-decoration-line: none',
  'uppercase': 'text-transform: uppercase',
  'lowercase': 'text-transform: lowercase',
  'capitalize': 'text-transform: capitalize',
  'normal-case': 'text-transform: none',
  'truncate': 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap',
  'whitespace-normal': 'white-space: normal',
  'whitespace-nowrap': 'white-space: nowrap',
  'whitespace-pre': 'white-space: pre',
  'whitespace-pre-line': 'white-space: pre-line',
  'whitespace-pre-wrap': 'white-space: pre-wrap',
  'break-words': 'overflow-wrap: break-word',
  'break-all': 'word-break: break-all',
  'leading-none': 'line-height: 1',
  'leading-tight': 'line-height: 1.25',
  'leading-snug': 'line-height: 1.375',
  'leading-normal': 'line-height: 1.5',
  'leading-relaxed': 'line-height: 1.625',
  'leading-loose': 'line-height: 2',
  'tracking-tighter': 'letter-spacing: -0.05em',
  'tracking-tight': 'letter-spacing: -0.025em',
  'tracking-normal': 'letter-spacing: 0em',
  'tracking-wide': 'letter-spacing: 0.025em',
  'tracking-wider': 'letter-spacing: 0.05em',
  'tracking-widest': 'letter-spacing: 0.1em',
  'antialiased': '-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale',
  'subpixel-antialiased': '-webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto',
  // Font family (common)
  'font-sans': "font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  'font-serif': "font-family: ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
  'font-mono': "font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  // Border
  'border': 'border-width: 1px',
  'border-0': 'border-width: 0px',
  'border-2': 'border-width: 2px',
  'border-4': 'border-width: 4px',
  'border-8': 'border-width: 8px',
  'border-t': 'border-top-width: 1px',
  'border-r': 'border-right-width: 1px',
  'border-b': 'border-bottom-width: 1px',
  'border-l': 'border-left-width: 1px',
  'border-l-4': 'border-left-width: 4px',
  'border-solid': 'border-style: solid',
  'border-dashed': 'border-style: dashed',
  'border-dotted': 'border-style: dotted',
  'border-none': 'border-style: none',
  'border-transparent': 'border-color: transparent',
  'border-current': 'border-color: currentColor',
  // Border radius
  'rounded-none': 'border-radius: 0px',
  'rounded': 'border-radius: 0.25rem',
  'rounded-xl': 'border-radius: 0.75rem',
  'rounded-2xl': 'border-radius: 1rem',
  'rounded-3xl': 'border-radius: 1.5rem',
  'rounded-full': 'border-radius: 9999px',
  // Note: rounded-sm, rounded-md, rounded-lg use CSS variables for shadcn/ui compatibility
  // They are resolved in resolveTwUtility() with var(--radius)
  // Background
  'bg-transparent': 'background-color: transparent',
  'bg-current': 'background-color: currentColor',
  'bg-white': 'background-color: #ffffff',
  'bg-black': 'background-color: #000000',
  // Opacity
  'opacity-0': 'opacity: 0',
  'opacity-5': 'opacity: 0.05',
  'opacity-10': 'opacity: 0.1',
  'opacity-25': 'opacity: 0.25',
  'opacity-50': 'opacity: 0.5',
  'opacity-75': 'opacity: 0.75',
  'opacity-100': 'opacity: 1',
  // Shadow
  'shadow-sm': 'box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  'shadow': 'box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  'shadow-md': 'box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  'shadow-lg': 'box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  'shadow-xl': 'box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  'shadow-none': 'box-shadow: 0 0 #0000',
  // Transition
  'transition': 'transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-all': 'transition-property: all; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-colors': 'transition-property: color, background-color, border-color, text-decoration-color, fill, stroke; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-opacity': 'transition-property: opacity; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-shadow': 'transition-property: box-shadow; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-transform': 'transition-property: transform; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms',
  'transition-none': 'transition-property: none',
  'ease-linear': 'transition-timing-function: linear',
  'ease-in': 'transition-timing-function: cubic-bezier(0.4, 0, 1, 1)',
  'ease-out': 'transition-timing-function: cubic-bezier(0, 0, 0.2, 1)',
  'ease-in-out': 'transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)',
  // Transform
  'transform': 'transform: translateX(var(--tw-translate-x)) translateY(var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))',
  'transform-none': 'transform: none',
  // Cursor
  'cursor-auto': 'cursor: auto',
  'cursor-default': 'cursor: default',
  'cursor-pointer': 'cursor: pointer',
  'cursor-wait': 'cursor: wait',
  'cursor-text': 'cursor: text',
  'cursor-move': 'cursor: move',
  'cursor-not-allowed': 'cursor: not-allowed',
  // Pointer events
  'pointer-events-none': 'pointer-events: none',
  'pointer-events-auto': 'pointer-events: auto',
  // User select
  'select-none': 'user-select: none',
  'select-text': 'user-select: text',
  'select-all': 'user-select: all',
  'select-auto': 'user-select: auto',
  // Z-index
  'z-0': 'z-index: 0',
  'z-10': 'z-index: 10',
  'z-20': 'z-index: 20',
  'z-30': 'z-index: 30',
  'z-40': 'z-index: 40',
  'z-50': 'z-index: 50',
  'z-auto': 'z-index: auto',
  // List style
  'list-none': 'list-style-type: none',
  'list-disc': 'list-style-type: disc',
  'list-decimal': 'list-style-type: decimal',
  'list-inside': 'list-style-position: inside',
  'list-outside': 'list-style-position: outside',
  // Visibility
  'visible': 'visibility: visible',
  'invisible': 'visibility: hidden',
  // Scroll
  'scroll-smooth': 'scroll-behavior: smooth',
  'scroll-auto': 'scroll-behavior: auto',
  // Object fit
  'object-contain': 'object-fit: contain',
  'object-cover': 'object-fit: cover',
  'object-fill': 'object-fit: fill',
  'object-none': 'object-fit: none',
  // Aspect ratio
  'aspect-auto': 'aspect-ratio: auto',
  'aspect-square': 'aspect-ratio: 1 / 1',
  'aspect-video': 'aspect-ratio: 16 / 9',
  // Outline
  'outline-none': 'outline: 2px solid transparent; outline-offset: 2px',
  'outline': 'outline-style: solid',
  // Ring (common)
  'ring-0': 'box-shadow: var(--tw-ring-inset) 0 0 0 calc(0px + var(--tw-ring-offset-width)) var(--tw-ring-color)',
  // Appearance
  'appearance-none': 'appearance: none',
  // Resize
  'resize-none': 'resize: none',
  'resize': 'resize: both',
  'resize-x': 'resize: horizontal',
  'resize-y': 'resize: vertical',
  // Text decoration
  'hover\\:underline': 'text-decoration-line: underline',
};

/**
 * Resolve a single Tailwind utility class to CSS.
 * Handles standard utilities, spacing (p-4, m-2, gap-4), colors (text-*, bg-*),
 * and custom theme colors (bg-dark-navy → rgb(var(--color-dark-navy))).
 */
function resolveTwUtility(cls: string): string | null {
  // Direct lookup
  if (TW_UTILITIES[cls]) return TW_UTILITIES[cls];

  // Duration: duration-150, duration-300, etc.
  let m = cls.match(/^duration-(\d+)$/);
  if (m) return `transition-duration: ${m[1]}ms`;

  // Delay: delay-150, delay-300, etc.
  m = cls.match(/^delay-(\d+)$/);
  if (m) return `transition-delay: ${m[1]}ms`;

  // Spacing: p-{n}, px-{n}, py-{n}, pt-{n}, m-{n}, mx-{n}, my-{n}, mt-{n}, gap-{n}, space-x-{n}
  m = cls.match(/^([pm])([xytblr])?-(\d+(?:\.\d+)?)$/);
  if (m) {
    const prop = m[1] === 'p' ? 'padding' : 'margin';
    const value = `${parseFloat(m[3]) * 0.25}rem`;
    const side = m[2];
    if (!side) return `${prop}: ${value}`;
    if (side === 'x') return `${prop}-left: ${value}; ${prop}-right: ${value}`;
    if (side === 'y') return `${prop}-top: ${value}; ${prop}-bottom: ${value}`;
    const sideMap: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };
    return `${prop}-${sideMap[side]}: ${value}`;
  }
  // mx-auto, my-auto
  if (cls === 'mx-auto') return 'margin-left: auto; margin-right: auto';
  if (cls === 'my-auto') return 'margin-top: auto; margin-bottom: auto';
  if (cls === 'ml-auto') return 'margin-left: auto';
  if (cls === 'mr-auto') return 'margin-right: auto';

  // Negative spacing: -m-{n}, -mt-{n}, etc.
  m = cls.match(/^-([pm])([xytblr])?-(\d+(?:\.\d+)?)$/);
  if (m) {
    const prop = m[1] === 'p' ? 'padding' : 'margin';
    const value = `-${parseFloat(m[3]) * 0.25}rem`;
    const side = m[2];
    if (!side) return `${prop}: ${value}`;
    if (side === 'x') return `${prop}-left: ${value}; ${prop}-right: ${value}`;
    if (side === 'y') return `${prop}-top: ${value}; ${prop}-bottom: ${value}`;
    const sideMap: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };
    return `${prop}-${sideMap[side]}: ${value}`;
  }

  // Gap: gap-{n}
  m = cls.match(/^gap-(\d+(?:\.\d+)?)$/);
  if (m) return `gap: ${parseFloat(m[1]) * 0.25}rem`;
  m = cls.match(/^gap-x-(\d+(?:\.\d+)?)$/);
  if (m) return `column-gap: ${parseFloat(m[1]) * 0.25}rem`;
  m = cls.match(/^gap-y-(\d+(?:\.\d+)?)$/);
  if (m) return `row-gap: ${parseFloat(m[1]) * 0.25}rem`;

  // Width/Height with numbers: w-{n}, h-{n}
  m = cls.match(/^w-(\d+(?:\.\d+)?)$/);
  if (m) return `width: ${parseFloat(m[1]) * 0.25}rem`;
  m = cls.match(/^h-(\d+(?:\.\d+)?)$/);
  if (m) return `height: ${parseFloat(m[1]) * 0.25}rem`;
  m = cls.match(/^max-w-(\d+)xl$/);
  if (m) return `max-width: ${parseInt(m[1]) * 36}rem`;
  if (cls === 'max-w-xs') return 'max-width: 20rem';
  if (cls === 'max-w-sm') return 'max-width: 24rem';
  if (cls === 'max-w-md') return 'max-width: 28rem';
  if (cls === 'max-w-lg') return 'max-width: 32rem';
  if (cls === 'max-w-xl') return 'max-width: 36rem';
  if (cls === 'max-w-2xl') return 'max-width: 42rem';
  if (cls === 'max-w-3xl') return 'max-width: 48rem';
  if (cls === 'max-w-4xl') return 'max-width: 56rem';
  if (cls === 'max-w-5xl') return 'max-width: 64rem';
  if (cls === 'max-w-6xl') return 'max-width: 72rem';
  if (cls === 'max-w-7xl') return 'max-width: 80rem';
  if (cls === 'max-w-screen-sm') return 'max-width: 640px';
  if (cls === 'max-w-screen-md') return 'max-width: 768px';
  if (cls === 'max-w-screen-lg') return 'max-width: 1024px';
  if (cls === 'max-w-screen-xl') return 'max-width: 1280px';
  if (cls === 'max-w-screen-2xl') return 'max-width: 1536px';
  if (cls === 'max-w-prose') return 'max-width: 65ch';

  // Top/right/bottom/left: top-{n}, inset-x-{n}, etc.
  m = cls.match(/^(top|right|bottom|left)-(\d+(?:\.\d+)?)$/);
  if (m) return `${m[1]}: ${parseFloat(m[2]) * 0.25}rem`;

  // Fractional width: w-1/2, w-1/3, etc.
  m = cls.match(/^w-(\d+)\/(\d+)$/);
  if (m) return `width: ${(parseInt(m[1]) / parseInt(m[2]) * 100).toFixed(6)}%`;

  // Line height with numbers
  m = cls.match(/^leading-(\d+)$/);
  if (m) return `line-height: ${parseFloat(m[1]) * 0.25}rem`;

  // Z-index dynamic
  m = cls.match(/^z-(\d+)$/);
  if (m) return `z-index: ${m[1]}`;

  // Min-height with numbers
  m = cls.match(/^min-h-\[([^\]]+)\]$/);
  if (m) return `min-height: ${m[1]}`;

  // Arbitrary values: w-[200px], p-[10px], text-[14px], bg-[#ff0000]
  m = cls.match(/^([a-z-]+)-\[([^\]]+)\]$/);
  if (m) {
    const propMap: Record<string, string> = {
      'w': 'width', 'h': 'height', 'p': 'padding', 'm': 'margin',
      'top': 'top', 'right': 'right', 'bottom': 'bottom', 'left': 'left',
      'text': 'font-size', 'bg': 'background-color', 'border': 'border-color',
      'rounded': 'border-radius', 'gap': 'gap', 'max-w': 'max-width',
      'min-w': 'min-width', 'max-h': 'max-height', 'min-h': 'min-height',
      'opacity': 'opacity', 'z': 'z-index', 'leading': 'line-height',
    };
    if (propMap[m[1]]) return `${propMap[m[1]]}: ${m[2]}`;
  }

  // Grid columns
  m = cls.match(/^grid-cols-(\d+)$/);
  if (m) return `grid-template-columns: repeat(${m[1]}, minmax(0, 1fr))`;
  m = cls.match(/^col-span-(\d+)$/);
  if (m) return `grid-column: span ${m[1]} / span ${m[1]}`;

  // Text colors — theme-aware custom colors (rgb-based CSS vars)
  // bg-dark-navy, text-slate, text-lightest-slate, border-lightest-navy, etc.
  const themeColors = [
    'dark-navy', 'navy', 'light-navy', 'lightest-navy',
    'slate', 'light-slate', 'lightest-slate',
    'accent', 'accent-tint', 'green', 'green-tint',
  ];
  for (const tc of themeColors) {
    if (cls === `text-${tc}`) return `color: rgb(var(--color-${tc}))`;
    if (cls === `bg-${tc}`) return `background-color: rgb(var(--color-${tc}))`;
    if (cls === `border-${tc}`) return `border-color: rgb(var(--color-${tc}))`;
  }

  // shadcn/ui HSL-based CSS variable colors
  const hslColors: Record<string, string> = {
    'background': '--background', 'foreground': '--foreground',
    'primary': '--primary', 'primary-foreground': '--primary-foreground',
    'secondary': '--secondary', 'secondary-foreground': '--secondary-foreground',
    'muted': '--muted', 'muted-foreground': '--muted-foreground',
    'accent': '--accent', 'accent-foreground': '--accent-foreground',
    'destructive': '--destructive', 'destructive-foreground': '--destructive-foreground',
    'border': '--border', 'input': '--input', 'ring': '--ring',
    'card': '--card', 'card-foreground': '--card-foreground',
    'popover': '--popover', 'popover-foreground': '--popover-foreground',
  };
  for (const [name, cssVar] of Object.entries(hslColors)) {
    if (cls === `text-${name}`) return `color: hsl(var(${cssVar}))`;
    if (cls === `bg-${name}`) return `background-color: hsl(var(${cssVar}))`;
    if (cls === `border-${name}`) return `border-color: hsl(var(${cssVar}))`;
    if (cls === `ring-${name}`) return `--tw-ring-color: hsl(var(${cssVar}))`;
  }

  // Standard Tailwind color palette (bg-red-500, text-blue-600, etc.)
  const twColorPalette: Record<string, Record<string, string>> = {
    'white': { DEFAULT: '#ffffff' }, 'black': { DEFAULT: '#000000' },
    'red': { '50': '#fef2f2', '100': '#fee2e2', '200': '#fecaca', '300': '#fca5a5', '400': '#f87171', '500': '#ef4444', '600': '#dc2626', '700': '#b91c1c', '800': '#991b1b', '900': '#7f1d1d' },
    'orange': { '50': '#fff7ed', '100': '#ffedd5', '200': '#fed7aa', '300': '#fdba74', '400': '#fb923c', '500': '#f97316', '600': '#ea580c', '700': '#c2410c', '800': '#9a3412', '900': '#7c2d12' },
    'yellow': { '50': '#fefce8', '100': '#fef9c3', '200': '#fef08a', '300': '#fde047', '400': '#facc15', '500': '#eab308', '600': '#ca8a04', '700': '#a16207', '800': '#854d0e', '900': '#713f12' },
    'green': { '50': '#f0fdf4', '100': '#dcfce7', '200': '#bbf7d0', '300': '#86efac', '400': '#4ade80', '500': '#22c55e', '600': '#16a34a', '700': '#15803d', '800': '#166534', '900': '#14532d' },
    'blue': { '50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe', '300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb', '700': '#1d4ed8', '800': '#1e40af', '900': '#1e3a8a' },
    'gray': { '50': '#f9fafb', '100': '#f3f4f6', '200': '#e5e7eb', '300': '#d1d5db', '400': '#9ca3af', '500': '#6b7280', '600': '#4b5563', '700': '#374151', '800': '#1f2937', '900': '#111827' },
    'zinc': { '50': '#fafafa', '100': '#f4f4f5', '200': '#e4e4e7', '300': '#d4d4d8', '400': '#a1a1aa', '500': '#71717a', '600': '#52525b', '700': '#3f3f46', '800': '#27272a', '900': '#18181b' },
    'neutral': { '50': '#fafafa', '100': '#f5f5f5', '200': '#e5e5e5', '300': '#d4d4d4', '400': '#a3a3a3', '500': '#737373', '600': '#525252', '700': '#404040', '800': '#262626', '900': '#171717' },
  };
  m = cls.match(/^(text|bg|border)-([a-z]+)-(\d{2,3})$/);
  if (m && twColorPalette[m[2]] && twColorPalette[m[2]][m[3]]) {
    const propMap: Record<string, string> = { text: 'color', bg: 'background-color', border: 'border-color' };
    return `${propMap[m[1]]}: ${twColorPalette[m[2]][m[3]]}`;
  }

  // Rounded with CSS variable (shadcn pattern): rounded-lg → var(--radius)
  if (cls === 'rounded-lg') return 'border-radius: var(--radius)';
  if (cls === 'rounded-md') return 'border-radius: calc(var(--radius) - 2px)';
  if (cls === 'rounded-sm') return 'border-radius: calc(var(--radius) - 4px)';

  return null;
}

/**
 * Expand @apply directives in CSS.
 * Handles responsive prefixes (md:, lg:, etc.) and pseudo-class prefixes (hover:, focus:).
 */
function expandApplyDirectives(css: string): string {
  return css.replace(/@apply\s+([^;]+);/g, (_match, classList: string) => {
    const classes = classList.trim().split(/\s+/);
    const baseCss: string[] = [];
    const mediaQueries: Record<string, string[]> = {};

    for (const cls of classes) {
      // Check for responsive prefix: md:text-3xl, lg:flex, etc.
      let actualCls = cls;
      let breakpoint: string | null = null;
      const bpMatch = cls.match(/^(sm|md|lg|xl|2xl):(.+)$/);
      if (bpMatch) {
        breakpoint = bpMatch[1];
        actualCls = bpMatch[2];
      }

      // Check for pseudo-class prefix: hover:underline, focus:ring, etc. — skip for now
      if (actualCls.includes(':')) {
        baseCss.push(`/* @apply: pseudo "${cls}" skipped */`);
        continue;
      }

      const resolved = resolveTwUtility(actualCls);
      if (resolved) {
        if (breakpoint && TW_BREAKPOINTS[breakpoint]) {
          if (!mediaQueries[breakpoint]) mediaQueries[breakpoint] = [];
          mediaQueries[breakpoint].push(resolved);
        } else {
          baseCss.push(resolved);
        }
      } else {
        baseCss.push(`/* @apply: unknown "${cls}" */`);
      }
    }

    let result = baseCss.map(p => p + ';').join(' ');

    // Note: media queries inside @apply can't properly be emitted inline inside
    // a rule. We emit them as comments with the CSS so users can see what's intended.
    // The Tailwind Play CDN handles responsive classes in HTML class attributes.
    for (const [bp, props] of Object.entries(mediaQueries)) {
      result += ` /* @media(min-width:${TW_BREAKPOINTS[bp]}) { ${props.join('; ')} } */`;
    }

    return result;
  });
}

/**
 * Process CSS for Tailwind: strip @tailwind directives, expand @apply, strip @layer wrappers.
 */
function processTailwindCss(css: string): string {
  // Strip @tailwind directives (Play CDN handles them)
  css = css.replace(/@tailwind\s+(base|components|utilities)\s*;/g,
    '/* $& — handled by Tailwind Play CDN */');

  // Expand @apply directives
  css = expandApplyDirectives(css);

  // Unwrap @layer blocks — keep the inner CSS
  css = css.replace(/@layer\s+(base|components|utilities)\s*\{/g, '/* @layer $1 { */');
  // Fix matching closing braces — this is tricky for nested braces.
  // Simple approach: just replace the @layer opening, the browser will handle extra }
  // Actually, let's use a balanced brace approach
  css = unwrapLayerBlocks(css);

  return css;
}

/**
 * Unwrap @layer blocks: @layer base { ...css... } → ...css...
 */
function unwrapLayerBlocks(css: string): string {
  const layerRegex = /@layer\s+(?:base|components|utilities)\s*\{/g;
  let result = '';
  let lastIdx = 0;
  let match;
  while ((match = layerRegex.exec(css)) !== null) {
    result += css.slice(lastIdx, match.index);
    // Find matching closing brace
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    // Extract inner content (between { and matching })
    result += css.slice(match.index + match[0].length, i - 1);
    lastIdx = i;
  }
  result += css.slice(lastIdx);
  return result;
}

// ── ViteDevServer ───────────────────────────────────────────────────────

export class ViteDevServer {
  private vfs: SqliteVFS;
  private esbuild: EsbuildService;
  private root: string;
  private onHmrMessage: (msg: any) => void;
  private port: number;
  private basePath: string;
  private running = false;
  private moduleCache = new Map<string, { code: string; timestamp: number }>();
  private unsubVfs: (() => void) | null = null;
  /** True if index.html has an importmap (browser handles bare specifiers) */
  private hasImportmap = false;
  /** Path aliases from vite.config.ts (e.g. { "@": "./src" }) */
  private aliases: Record<string, string>;
  /** Define replacements for esbuild (e.g. { "global": "globalThis" }) */
  private define: Record<string, string>;
  /** Whether this project uses TailwindCSS */
  private hasTailwind = false;
  /** Parsed tailwind config JS (for CDN injection) */
  private tailwindConfigJs: string | null = null;
  /** NPM cache for pre-bundled ESM modules (optional). */
  private npmCache: NpmCache | null = null;
  /** Inject React Router basename into entry files? Default: true. */
  private injectBasename: boolean;
  /** Worker env (LOADER, ctx-exports) for the on-demand-bundle facet path.
   *  Null = legacy in-supervisor esbuild fallback. */
  private env: any;
  private ctx: DurableObjectState | null = null;
  /** Lazily-constructed pool for on-demand bundling. Mirrors the
   *  pre-bundle pool's wasm-modules-map shape. Created on first
   *  cold-path /preview/@modules/<spec> request. */
  private onDemandPool: any = null;
  private onDemandPoolPromise: Promise<any> | null = null;
  /**
   * In-flight on-demand-bundle coalescing map. When the browser fires
   * multiple parallel requests for the same /preview/@modules/<spec>
   * (which happens on first preview load — every imported module
   * resolves concurrently), we want exactly ONE bundle attempt per
   * spec. The map holds the in-flight Promise<Response> keyed by
   * cacheKey; subsequent fetches return the same promise. Entry is
   * deleted when the promise settles so repeat-after-cache-expiry
   * goes through the cold path again.
   *
   * Without coalescing, N parallel requests each build a slice
   * (~28 MiB) and submit N facet RPCs in parallel. With a shared DO
   * isolate (Mini-PRD: DO shared isolate issues), the supervisor's
   * peak heap during page-load = N × slice_size + baseline, which
   * crashes the supervisor for N≥3 on a busy isolate.
   */
  private pendingBundles = new Map<string, Promise<Response>>();
  /**
   * Single-slot semaphore for the on-demand bundle slow path. Serializes
   * slice-walk + facet-dispatch ACROSS DIFFERENT specs so the
   * supervisor holds at most ONE 28 MiB slice in memory at any time
   * during a flurry of /preview/@modules/* requests. Coupled with
   * pendingBundles (same-spec coalescing) this caps peak supervisor
   * slice memory at 28 MiB regardless of browser parallelism.
   *
   * Implementation: a chain of Promise<void> — each waiter awaits the
   * previous, runs its critical section, then releases. Latency
   * impact is bounded by per-spec bundle wall time (typically <1 s
   * for non-barrel packages); the browser's module-fetch parallelism
   * just becomes serialized at the bundler boundary, not at the wire.
   */
  private onDemandQueue: Promise<void> = Promise.resolve();

  constructor(opts: ViteDevServerOptions) {
    this.vfs = opts.vfs;
    this.esbuild = opts.esbuild;
    this.injectBasename = opts.injectBasename !== false;
    // Normalize root: resolve ./, collapse //, strip leading/trailing slashes
    this.root = opts.root
      .replace(/\/\.\//g, '/')     // /./ → /
      .replace(/\/\.$/,  '')       // trailing /.
      .replace(/\/+/g,   '/')      // collapse //
      .replace(/^\/+/,   '')       // leading /
      .replace(/\/+$/,   '');      // trailing /
    this.onHmrMessage = opts.onHmrMessage;
    this.port = opts.port || 5173;
    this.basePath = (opts.basePath || '/preview').replace(/\/+$/, '');
    this.aliases = opts.aliases || {};
    this.env = opts.env;
    this.ctx = opts.ctx ?? null;
    if (opts.sql) {
      this.npmCache = new NpmCache(opts.sql);
    }
    // Merge user defines with standard Vite defines.
    // process.env.NODE_ENV is set explicitly so bundled CJS packages (like React's
    // `if (process.env.NODE_ENV !== "production")` guards) get the correct branch.
    // Without this, many packages emit warnings or fail when evaluated in the browser.
    // BASE_URL reflects the actual URL prefix we're mounted at. With
    // per-session routing this becomes e.g. `/s/nimble-otter-4271/preview/`,
    // which user code that does `new URL(path, import.meta.env.BASE_URL)`
    // or `<img src={import.meta.env.BASE_URL + 'logo.png'}>` needs to work.
    const baseUrlValue = JSON.stringify(
      (this.basePath === '' || this.basePath === '/') ? '/' : this.basePath + '/'
    );
    this.define = {
      'import.meta.env.DEV': 'true',
      'import.meta.env.PROD': 'false',
      'import.meta.env.MODE': '"development"',
      'import.meta.env.SSR': 'false',
      'import.meta.env.BASE_URL': baseUrlValue,
      'process.env.NODE_ENV': '"development"',
      'global': 'globalThis',
      ...(opts.define || {}),
    };
    this.detectTailwind();
  }

  /**
   * Lazily construct the NimbusLoaderPool used for on-demand bundling
   * of /preview/@modules/<spec> requests that miss both the in-memory
   * and pkg_esm_bundles caches. Mirrors the pre-bundle pool's
   * configuration: 1 worker, internal pLimit not needed (one bundle
   * per request), wasm shipped via wasmModules.
   *
   * Returns null when env/ctx aren't available (legacy fallback used).
   */
  private async ensureOnDemandPool(): Promise<any | null> {
    if (this.onDemandPool) return this.onDemandPool;
    if (this.onDemandPoolPromise) return this.onDemandPoolPromise;
    if (!this.env || !this.ctx) return null;
    this.onDemandPoolPromise = (async () => {
      const { NimbusLoaderPool } = await import('./parallel/loader-pool.js');
      const { PRE_BUNDLE_PREAMBLE } = await import('./parallel/pre-bundle-preamble.js');
      const { fetchEsbuildWasmBytes } = await import('./esbuild-wasm-bytes.js');
      const wasmBytes = await fetchEsbuildWasmBytes(this.env as any);
      const pool = new NimbusLoaderPool(this.env, this.ctx!, {
        concurrency: 1,
        timeoutMs: 60_000,
        retries: 0,
        // Use a distinct tag so the on-demand pool's cached worker
        // doesn't collide with the install-time pre-bundle pool.
        // Sharing fnHash + preamble + wasm fingerprint between pools
        // would otherwise alias them in workerd's loader cache.
        tag: 'on-demand-bundle',
        preamble: PRE_BUNDLE_PREAMBLE,
        wasmModules: { 'esbuild.wasm': wasmBytes },
      });
      this.onDemandPool = pool;
      return pool;
    })();
    try {
      return await this.onDemandPoolPromise;
    } catch (e) {
      this.onDemandPoolPromise = null;
      throw e;
    }
  }

  /** Detect TailwindCSS usage in the project */
  private detectTailwind(): void {
    // Check for tailwind config files
    const configFiles = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'];
    for (const cfg of configFiles) {
      const cfgPath = this.root + '/' + cfg;
      if (this.vfs.exists(cfgPath)) {
        this.hasTailwind = true;
        try {
          let code = this.vfs.readFileString(cfgPath);
          // Strip require() calls and module.exports, convert to plain object
          code = code.replace(/require\s*\(\s*["'][^"']*["']\s*\)/g, '[]');
          code = code.replace(/import\s+.*?from\s+["'][^"']*["']\s*;?/g, '');
          // Extract the config object — look for export default or module.exports
          const exportMatch = code.match(/(?:export\s+default|module\.exports\s*=)\s*(\{[\s\S]*\})\s*;?\s*$/);
          if (exportMatch) {
            this.tailwindConfigJs = exportMatch[1];
          }
        } catch {}
        break;
      }
    }
    // Also check package.json for tailwindcss dependency
    if (!this.hasTailwind) {
      try {
        const pkgPath = this.root + '/package.json';
        if (this.vfs.exists(pkgPath)) {
          const pkg = JSON.parse(this.vfs.readFileString(pkgPath));
          if (pkg.dependencies?.tailwindcss || pkg.devDependencies?.tailwindcss) {
            this.hasTailwind = true;
          }
        }
      } catch {}
    }
  }

  /**
   * Rewrite absolute paths in HTML so they resolve under the basePath.
   */
  private rewriteHtmlPaths(html: string): string {
    if (!this.basePath || this.basePath === '/') return html;

    const base = this.basePath;
    html = html.replace(
      /(\s(?:src|href|action)=)(["'])(\/(?!\/)[^"']*)\2/gi,
      (match, attr, quote, path) => {
        if (path.startsWith(base + '/') || path === base) return match;
        return `${attr}${quote}${base}${path}${quote}`;
      }
    );
    return html;
  }

  /** Start the dev server (subscribe to VFS events for HMR). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.moduleCache.clear();

    // Subscribe to VFS events for HMR
    this.unsubVfs = this.vfs.events.on((events) => {
      this.handleVfsEvents(events);
    });
  }

  /** Stop the dev server. */
  stop(): void {
    this.running = false;
    if (this.unsubVfs) { this.unsubVfs(); this.unsubVfs = null; }
    this.moduleCache.clear();
  }

  get isRunning() { return this.running; }

  /** Handle VFS change events → trigger HMR. */
  private handleVfsEvents(events: VfsEvent[]): void {
    if (!this.running) return;

    let needsReload = false;
    let cssOnly = true;
    let nodeModulesChanged = false;

    for (const event of events) {
      if (event.type === 'addDir' || event.type === 'unlinkDir') continue;
      const path = event.path;

      this.moduleCache.delete(path);
      this.moduleCache.delete(this.root + '/' + path);
      if (path.startsWith(this.root + '/')) {
        this.moduleCache.delete(path.substring(this.root.length + 1));
      }

      if (path.includes('node_modules/')) {
        nodeModulesChanged = true;
      }

      if (path.startsWith(this.root + '/') || path.startsWith(this.root)) {
        needsReload = true;
        if (!path.endsWith('.css')) cssOnly = false;
      }
    }

    if (nodeModulesChanged) {
      const toDelete: string[] = [];
      for (const key of this.moduleCache.keys()) {
        if (key.startsWith('@modules/')) toDelete.push(key);
      }
      for (const k of toDelete) this.moduleCache.delete(k);
    }

    if (needsReload) {
      if (cssOnly) {
        this.onHmrMessage({ type: 'nimbus-hmr', event: 'css-update' });
      } else {
        this.onHmrMessage({ type: 'nimbus-hmr', event: 'full-reload' });
      }
    }
  }

  /** Normalize and sanitize a preview pathname to prevent traversal. */
  private sanitizePath(pathname: string): string | null {
    const segments = pathname.split('/').reduce((acc: string[], seg) => {
      if (seg === '..') acc.pop();
      else if (seg !== '.' && seg !== '') acc.push(seg);
      return acc;
    }, []);
    return '/' + segments.join('/');
  }

  /**
   * Resolve a URL pathname through aliases.
   * E.g. /src/components/Foo.tsx stays as-is (already resolved).
   * This is for cases where alias resolution produced a path like /preview/src/...
   * and we need to strip the basePath to get the VFS path.
   */
  private resolveAliasPath(pathname: string): string {
    // Aliases are resolved during import rewriting (in JS), not in URL paths.
    // URL paths should already be correct after rewriting.
    return pathname;
  }

  /**
   * Handle an HTTP request to the dev server.
   * Called from the DO's fetch() handler for /preview/* paths.
   */
  async handleRequest(request: Request, pathname: string): Promise<Response> {
    const safePath = this.sanitizePath(pathname);
    if (!safePath) {
      return new Response('400 Bad Request', { status: 400 });
    }
    pathname = safePath;

    // Strip query parameters for path resolution, keep for logic
    const queryIdx = pathname.indexOf('?');
    const query = queryIdx >= 0 ? pathname.substring(queryIdx) : '';
    if (queryIdx >= 0) pathname = pathname.substring(0, queryIdx);

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };

    try {
      // /@vite/client → HMR client script
      if (pathname === '/@vite/client' || pathname === '/@vite/client.js') {
        return new Response('// Nimbus HMR — connected via postMessage\nconsole.log("[nimbus-hmr] client loaded");\n', {
          headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }

      // /__nimbus_assets/tailwind-play.js → vendored Tailwind Play CDN
      // Served INSTEAD of cdn.tailwindcss.com so preview pages stay
      // 100% on edge (no third-party CDN fetch from the browser).
      // Bundle is embedded at build time via scripts/bundle-tailwind-play.mjs;
      // see src/tailwind-play.generated.ts for the source URL + integrity.
      if (pathname === '/__nimbus_assets/tailwind-play.js') {
        return new Response(TAILWIND_PLAY_BUNDLE, {
          headers: {
            ...headers,
            'Content-Type': 'application/javascript; charset=utf-8',
            // Immutable: the bundle is version-pinned at build time.
            // Override the default no-store so browsers cache it
            // across preview reloads.
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Tailwind-Play-Version': TAILWIND_PLAY_VERSION,
          },
        });
      }

      // /@modules/<pkg> → resolve from node_modules, transform
      if (pathname.startsWith('/@modules/')) {
        const specifier = pathname.substring('/@modules/'.length);
        // Check if this is actually an alias that got misrouted
        if (this.aliases) {
          const resolved = resolveAliasSpecifier(specifier, this.aliases, this.basePath);
          if (resolved) {
            // Redirect to the correct path
            return new Response(null, { status: 302, headers: { ...headers, 'Location': resolved } });
          }
        }
        return this.serveModule(specifier, headers);
      }

      // / → serve index.html
      if (pathname === '/' || pathname === '/index.html') {
        return this.serveIndexHtml(headers);
      }

      // public/ directory — serve static assets as-is
      const publicPath = this.root + '/public' + pathname;
      if (this.vfs.exists(publicPath) && !this.vfs.isDirectory(publicPath)) {
        const ext = pathname.includes('.') ? '.' + pathname.split('.').pop()!.toLowerCase() : '';
        const data = this.vfs.readFile(publicPath);
        return new Response(data, {
          headers: { ...headers, 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
        });
      }

      // Serve from VFS (with transforms for TS/TSX/JSX)
      return this.serveFile(request, pathname, query, headers);
    } catch (e: any) {
      return new Response(`500 Internal Server Error: ${e?.message}`, {
        status: 500, headers: { ...headers, 'Content-Type': 'text/plain' },
      });
    }
  }

  // ── index.html ────────────────────────────────────────────────────────

  private serveIndexHtml(headers: Record<string, string>): Response {
    const htmlPath = this.root + '/index.html';
    if (!this.vfs.exists(htmlPath)) {
      return new Response('<!DOCTYPE html><html><body><h1>No index.html found</h1><p>Create index.html in your project root.</p></body></html>', {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    let html = this.vfs.readFileString(htmlPath);

    // Detect importmap
    this.hasImportmap = html.includes('"importmap"') || html.includes("'importmap'");

    // Build head injections
    let headInjections = '';

    // 1. <base> tag for SPA router support
    if (this.basePath && this.basePath !== '/') {
      headInjections += `<base href="${this.basePath}/">\n`;
    }

    // 2. Tailwind: serve the vendored Play CDN bundle from our edge.
    //    Was previously `<script src="https://cdn.tailwindcss.com/...">`
    //    — that violated the 100% edge contract by making the browser
    //    fetch a third-party CDN on every preview load. The bundle is
    //    now embedded in the supervisor at build time
    //    (scripts/bundle-tailwind-play.mjs) and served from
    //    /<basePath>/__nimbus_assets/tailwind-play.js with immutable
    //    cache headers. The tailwind.config inline-script is still
    //    placed AFTER the bundle script so the IIFE picks it up.
    if (this.hasTailwind) {
      const twUrl = (this.basePath && this.basePath !== '/' ? this.basePath : '') +
        '/__nimbus_assets/tailwind-play.js';
      headInjections += `<script src="${twUrl}"></script>\n`;
      if (this.tailwindConfigJs) {
        // Inject tailwind config
        headInjections += `<script>\ntailwind.config = ${this.tailwindConfigJs}\n</script>\n`;
      }
    }

    // 3. HMR client + runtime error overlay.
    // Overlay is injected alongside HMR because both need to attach global
    // window listeners before any user modules start loading. The overlay
    // catches uncaught runtime errors (including "does not provide an export"
    // module-link failures that leave the root div empty with no console
    // output) and surfaces them as a red banner so users never see a
    // mysteriously blank preview.
    headInjections += ERROR_OVERLAY_CLIENT + '\n';
    headInjections += HMR_CLIENT + '\n';

    // Inject before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', headInjections + '</head>');
    } else if (html.includes('<body')) {
      html = html.replace('<body', headInjections + '<body');
    } else {
      html = headInjections + html;
    }

    // Rewrite absolute paths to include basePath prefix
    html = this.rewriteHtmlPaths(html);

    return new Response(html, {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // ── Module serving (/@modules/<pkg>) ──────────────────────────────────

  private async serveModule(specifier: string, headers: Record<string, string>): Promise<Response> {
    const JS_CT = 'application/javascript; charset=utf-8';
    const cacheKey = `@modules/${specifier}`;

    // 1. In-memory cache (hot path — already bundled)
    const memCached = this.moduleCache.get(cacheKey);
    if (memCached) {
      return new Response(memCached.code, {
        headers: { ...headers, 'Content-Type': JS_CT },
      });
    }

    // 2. SQLite pre-bundle cache (warm path — from npm install pre-bundling)
    //    Pre-bundled modules may contain leaked bare imports if they were built
    //    with `external` peer deps (see npm-installer.prebundleUsedModules).
    //    Run them through rewriteAllImports so any remaining bare specifiers
    //    get the correct /preview/@modules/ URL prefix, then synthesize named
    //    exports if the bundle only exports default (CJS-only packages).
    if (this.npmCache) {
      const esmBundle = this.npmCache.getEsmBundle(specifier);
      // Only use cached bundles built with the current bundler version.
      // Stale bundles (from older bundler versions) are treated as missing
      // and re-bundled on the cold path.
      if (esmBundle && esmBundle.bundleHash === BUNDLER_VERSION) {
        let code = esmBundle.esmCode;
        // Rewrite __require("external") calls to ESM imports so externalized
        // packages (react, scheduler) actually work in the browser.
        code = rewriteExternalRequires(code, this.basePath);
        code = rewriteAllImports(code, this.aliases, this.basePath);
        code = synthesizeCjsNamedExports(code);
        this.moduleCache.set(cacheKey, { code, timestamp: Date.now() });
        return new Response(code, {
          headers: { ...headers, 'Content-Type': JS_CT },
        });
      }
    }

    // ── Cold path coalescing + serialization ──────────────────────
    // Multiple parallel browser requests for the same module are
    // common on first preview load; coalesce so exactly ONE bundle
    // attempt runs per spec. Across DIFFERENT specs, serialize via a
    // single-slot semaphore so peak supervisor slice memory stays at
    // ~28 MiB regardless of browser parallelism. See
    // `pendingBundles` and `onDemandQueue` field docs for context.
    const inflight = this.pendingBundles.get(cacheKey);
    if (inflight) return inflight;
    const coldPromise = (async (): Promise<Response> => {
      const prev = this.onDemandQueue;
      let releaseSlot!: () => void;
      this.onDemandQueue = new Promise<void>((res) => { releaseSlot = res; });
      try {
        await prev;
        return await this.serveModuleCold(specifier, headers);
      } finally {
        releaseSlot();
      }
    })();
    this.pendingBundles.set(cacheKey, coldPromise);
    coldPromise.finally(() => {
      // Drop the coalescing entry once settled. Subsequent requests
      // for the same spec will hit the moduleCache (set inside the
      // cold path) on the hot path, not re-enter the slow path.
      this.pendingBundles.delete(cacheKey);
    });
    return coldPromise;
  }

  /**
   * Cold path of serveModule: package resolution → on-demand facet
   * bundle (synthetic-entry for barrels) → hard-error if bundle fails.
   * NO CDN fallback (100% edge contract). Extracted so the coalescing
   * + semaphore wrapper in serveModule() reads cleanly. Always runs
   * inside the on-demand semaphore — see serveModule's wrapper.
   */
  private async serveModuleCold(
    specifier: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const JS_CT = 'application/javascript; charset=utf-8';
    const cacheKey = `@modules/${specifier}`;
    // 3. On-demand bundle (cold path — resolve from node_modules, bundle via esbuild)
    //
    // Architecture: this used to call this.esbuild.build(...) in the
    // supervisor isolate. For large modules (lucide-react, ~18 MiB
    // unpacked) that OOM'd the supervisor and surfaced as CF error
    // 1101 on /preview/@modules/lucide-react, taking down the entire
    // preview. We now dispatch the bundle work to a NimbusLoaderPool
    // isolate via its own 128 MiB heap — same pattern as install-time
    // pre-bundling. Supervisor never bundles esbuild for any path.
    //
    // Falls back to in-supervisor esbuild ONLY if env/ctx aren't
    // available (e.g. legacy callers / tests).
    const resolved = this.resolvePackage(specifier);
    // Barrel packages (lucide-react, @phosphor-icons/react, react-icons,
    // @mui/icons-material, …) ship hundreds/thousands of tiny re-export
    // files. Bundling the whole barrel OOMs esbuild's 128 MiB facet.
    // Instead we synthesize a tiny entry from the user's actual named
    // imports (`export { Home, FileText } from 'pkg'`) and bundle THAT
    // through the standard facet path — esbuild tree-shakes the rest.
    // 100% edge: NO esm.sh / CDN fallback.
    if (resolved) {
      const pkgName = packageNameFromSpecifier(specifier);
      const pkgDir = this.root + '/node_modules/' + pkgName;
      const fileCount = countPackageFiles(this.vfs, pkgDir);
      const isBarrel = fileCount > BARREL_PKG_FILE_THRESHOLD && specifier === pkgName;
      let bundled: string | null = null;
      const externals = getSharedRuntimeExternals(specifier);
      const onDemandPool = await this.ensureOnDemandPool().catch(() => null);

      // Determine the entry path the facet should bundle:
      //   - non-barrel:  the package's resolved main entry
      //   - barrel:      a synthesized entry written to VFS that
      //                  re-exports just the named imports the user's
      //                  source uses. esbuild tree-shakes the rest.
      let bundleEntryPath: string = resolved;
      let synthetic = false;
      let syntheticReferencedFiles: string[] | null = null;
      if (isBarrel) {
        const namedImports = scanNamedImports(this.vfs, this.root);
        const names = namedImports.get(pkgName);
        if (!names || names.size === 0) {
          // No statically-resolvable imports. We refuse to CDN-fallback
          // (100% edge contract) AND we refuse to bundle the whole
          // barrel (would OOM the facet). Emit a hard error so the
          // user sees a clear remediation.
          const diag =
            `[vite-dev] cannot bundle ${specifier}: barrel package (${fileCount} files) ` +
            `with no static named imports detected in user source. ` +
            `Dynamic imports / computed-name access can't be tree-shaken. ` +
            `Add explicit imports like ` +
            `\`import { IconName } from '${pkgName}'\` so Nimbus can synthesize ` +
            `a tree-shakable entry.`;
          console.error(diag);
          return new Response(
            `// nimbus: ${diag}\n` +
            `throw new Error(${JSON.stringify('Nimbus: ' + diag)});\n`,
            {
              status: 500,
              headers: { ...headers, 'Content-Type': JS_CT },
            },
          );
        }
        const nmDirOnDemand = this.root + '/node_modules';
        const synth = buildSyntheticEntry(this.vfs, nmDirOnDemand, pkgName, names);
        if (!synth) {
          return new Response(
            `// nimbus: synthetic entry generation returned null for ${specifier}\n` +
            `throw new Error(${JSON.stringify('Nimbus: synthetic entry generation failed for ' + specifier)});\n`,
            { status: 500, headers: { ...headers, 'Content-Type': JS_CT } },
          );
        }
        const synthPath = syntheticEntryPath(this.root, pkgName);
        try {
          this.vfs.mkdir(synthPath.substring(0, synthPath.lastIndexOf('/')), { recursive: true });
          this.vfs.writeFile(synthPath, synth.code);
        } catch (e: any) {
          const msg = `[vite-dev] failed to write synthetic entry for ${specifier}: ${e?.message || e}`;
          console.error(msg);
          return new Response(
            `// nimbus: ${msg}\nthrow new Error(${JSON.stringify('Nimbus: ' + msg)});\n`,
            { status: 500, headers: { ...headers, 'Content-Type': JS_CT } },
          );
        }
        bundleEntryPath = synthPath;
        synthetic = true;
        // Stash the referenced files so the slice-build below uses
        // a SCOPED slice instead of the standard whole-package walk.
        syntheticReferencedFiles = synth.referencedFiles;
        console.warn(
          `[vite-dev] synthesized entry for ${specifier} ` +
          `(barrel: ${fileCount} files; ${names.size} static imports → tree-shaken bundle)`,
        );
      }

      if (onDemandPool) {
        // Facet path — supervisor stays at 0 esbuild bytes.
        try {
          const {
            buildSliceForSpecifierWithCap,
            prebundleOne,
            BUNDLER_VERSION,
          } = await import('./pre-bundle-facet.js');
          const SLICE_CAP_BYTES = 28 * 1024 * 1024;
          const projDir = this.root;
          const nmDir = projDir + '/node_modules';
          let slice: { slice: SliceEntry[]; totalBytes: number } | null = null;
          if (synthetic && syntheticReferencedFiles) {
            // SCOPED slice: only the files the synthetic entry directly
            // references (+ transitive relative imports + package.json).
            // Skips the full package walk so icon-libraries with
            // thousands of files don't blow the 28 MiB cap.
            const scoped = buildScopedSliceForSynthetic(
              this.vfs, nmDir, pkgName, syntheticReferencedFiles,
            );
            const built: { slice: SliceEntry[]; totalBytes: number } = {
              slice: scoped.entries,
              totalBytes: scoped.totalBytes,
            };
            try {
              const bytes = this.vfs.readFile(bundleEntryPath);
              const parentDir = bundleEntryPath.substring(0, bundleEntryPath.lastIndexOf('/'));
              built.slice.push({ path: '/' + parentDir.replace(/^\/+/, ''), isDir: true });
              built.slice.push({
                path: '/' + bundleEntryPath.replace(/^\/+/, ''),
                bytes,
                isDir: false,
              });
              built.totalBytes += bytes.length + bundleEntryPath.length;
            } catch (e: any) {
              console.error('[vite-dev] synthetic entry unreadable for', specifier, e?.message);
            }
            slice = built;
          } else {
            slice = buildSliceForSpecifierWithCap(
              this.vfs, specifier, nmDir, SLICE_CAP_BYTES,
            );
          }
          if (slice) {
            // Build the spec, then drop our supervisor-side handle to
            // the slice array immediately — `spec` is the only thing
            // that needs to keep it alive until the RPC structured-clone
            // completes. Mirrors the install-time runSlot pattern (see
            // commit 40cfc01) so peak supervisor heap during a flurry of
            // /preview/@modules/* requests stays at <(1 × 28 MiB).
            let spec: any = {
              specifier,
              entryPath: bundleEntryPath,
              externals,
              slice: slice.slice,
              bundlerVersion: BUNDLER_VERSION,
              define: this.define,
            };
            slice = null;
            let result: any = null;
            try {
              result = await onDemandPool.submit(prebundleOne, spec);
            } finally {
              spec = null;
            }
            if (result && result.ok && result.esmCode) {
              bundled = result.esmCode;
            } else if (result && result.errorText) {
              console.error('[vite-dev] facet bundle failed for', specifier, result.errorText);
            }
            result = null;
          } else {
            console.error('[vite-dev] slice walker exceeded cap for', specifier);
          }
        } catch (e: any) {
          console.error('[vite-dev] on-demand facet dispatch failed for', specifier, e?.message);
        }
      } else {
        // Legacy fallback — in-supervisor esbuild. Used only when
        // env/ctx weren't passed in (no facet pool can be built).
        try {
          const result = await this.esbuild.build([bundleEntryPath], {
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'esnext',
            define: this.define,
            external: externals.length > 0 ? externals : undefined,
          });
          if (result.outputFiles?.length) {
            bundled = result.outputFiles[0].contents;
          }
        } catch (e: any) {
          console.error('[vite-dev] esbuild bundle failed for', specifier, e?.message);
        }
      }

      if (bundled !== null) {
        let code = bundled;
        // Convert `__require("external")` calls (from CJS source with esbuild
        // externals) into ESM `import * as` + dispatch. Without this, the
        // browser throws when it hits __require("react") at runtime.
        code = rewriteExternalRequires(code, this.basePath);
        // Rewrite any bare imports that esbuild marked external (e.g., from
        // the VFS plugin's exports-field-unaware fallback). Without this, a
        // bundled output like `import X from "scheduler"` would 404 in the
        // browser because the specifier doesn't include the base prefix.
        code = rewriteAllImports(code, this.aliases, this.basePath);

        // For CJS-only packages (react, react-dom), esbuild's __commonJS
        // wrapper only emits `export default` — named imports like
        // `import { createRoot } from "react-dom/client"` would fail. Statically
        // scan the bundled source for CJS export patterns and synthesize
        // named exports.
        code = synthesizeCjsNamedExports(code);

        // Cache ONLY successful bundles. Caching a failed build (where
        // `code` was the raw unbundled source) would poison the cache
        // and break the module forever.
        if (this.npmCache) {
          try {
            this.npmCache.putEsmBundle({
              specifier,
              bundleHash: BUNDLER_VERSION,
              esmCode: code,
              builtAt: Date.now(),
              inputHash: '',
            });
          } catch { /* non-fatal */ }
        }

        this.moduleCache.set(cacheKey, { code, timestamp: Date.now() });
        return new Response(code, {
          headers: { ...headers, 'Content-Type': JS_CT },
        });
      }

      // Bundle failed — fall through to the hard-error response below.
      // Previously fell through to a CDN fallback (esm.sh) but that
      // violated the 100% edge contract.
    }

    // 4. NOT-INSTALLED → STUB; BUNDLE-FAILED → HARD ERROR.
    //    NO CDN fallback (100% edge contract).
    //
    // Two distinct failure modes need different responses:
    //
    // a. Package not installed locally. This is common for OPTIONAL
    //    peer-deps surfaced by transitive imports — e.g. framer-motion
    //    does `try { import('@emotion/is-prop-valid') } catch {}` for a
    //    runtime feature flag. Pre-bundle's slice walker marks the
    //    unresolved import as external; the browser then fetches
    //    /preview/@modules/@emotion/is-prop-valid. Returning a 503
    //    with `throw new Error(...)` would fail the entire module graph
    //    BEFORE framer-motion's try/catch runs (the throw happens at
    //    module-load time, not at function-call time). Instead we serve
    //    a tiny stub:
    //
    //        export default undefined;
    //        export const __nimbus_optional_dep_stub = true;
    //
    //    The browser-side library's runtime feature-detect picks up the
    //    undefined and gracefully degrades. NO crash, NO CDN hit, NO
    //    accidental "you forgot to install X" silent failure (we log
    //    a clear warning to the supervisor for visibility).
    //
    // b. Package IS installed but bundling failed (slice cap, OOM,
    //    unresolvable internal import). Return 503 with throwing
    //    module body — the user needs to see the failure to fix it.
    const pkgName = packageNameFromSpecifier(specifier);
    const installed = this.vfs.exists(this.root + '/node_modules/' + pkgName);
    if (!installed) {
      const stubMsg =
        `[vite-dev] serving stub for /preview/@modules/${specifier}: ` +
        `package not installed locally (likely an optional transitive peer-dep). ` +
        `If your code calls into ${specifier} directly, add it to package.json ` +
        `and run \`npm install\`.`;
      console.warn(stubMsg);
      const stubCode =
        `// nimbus: ${stubMsg}\n` +
        `export default undefined;\n` +
        `export const __nimbus_optional_dep_stub = true;\n`;
      // Cache so repeated transitive references don't re-walk + re-warn.
      this.moduleCache.set(cacheKey, { code: stubCode, timestamp: Date.now() });
      return new Response(stubCode, {
        headers: { ...headers, 'Content-Type': JS_CT },
      });
    }
    const diag =
      `[vite-dev] cannot serve /preview/@modules/${specifier}: ` +
      `on-demand bundle failed (esbuild OOM, slice cap, or unresolved internal import). ` +
      `Check supervisor logs for the underlying error. ` +
      `If the package is a "barrel" (icon library, etc.), Nimbus ` +
      `auto-tree-shakes from your static named imports — make sure ` +
      `you're using \`import { Foo } from '${pkgName}'\` syntax ` +
      `(not \`import * as X\` or dynamic \`import()\`).`;
    console.error(diag);
    const errCode =
      `// nimbus: ${diag}\n` +
      `throw new Error(${JSON.stringify('Nimbus: ' + diag)});\n`;
    return new Response(errCode, {
      status: 503,
      headers: {
        ...headers,
        'Content-Type': JS_CT,
        'Cache-Control': 'no-store',
      },
    });
  }

  /**
   * Resolve a bare package specifier (possibly with subpath) to a VFS file path.
   *
   * Algorithm:
   *   1. Parse into pkgName + subpath (e.g. "pkg/sub/deep" → pkg="pkg", subpath="sub/deep")
   *   2. Walk search dirs looking for node_modules/<pkg>/
   *   3. PREFER exports-field resolution (modern packages) with conditions
   *      [import, module, browser, default]
   *   4. FALL BACK to legacy resolution (packages without exports field):
   *      a. For subpath: try <nmDir>/<subpath>.{js,mjs,cjs,jsx,ts,tsx} — direct file
   *      b. For subpath: try <nmDir>/<subpath>/index.{js,mjs,cjs,jsx,ts,tsx}
   *      c. For subpath: try <nmDir>/<subpath>/package.json → read module/main
   *      d. For root: try pkg.module / pkg.main, then tryResolveFile
   *      e. For root: try <nmDir>/index.{ext}
   *
   * Step 4c is what makes `react-remove-scroll-bar/constants` work for legacy
   * packages without an exports field — the subpath directory has its own
   * package.json (or just an index.js that we pick up in 4b).
   */
  private resolvePackage(specifier: string): string | null {
    let pkgName: string;
    let subpath: string;
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      pkgName = parts.slice(0, 2).join('/');
      subpath = parts.slice(2).join('/');
    } else {
      const parts = specifier.split('/');
      pkgName = parts[0];
      subpath = parts.slice(1).join('/');
    }

    const searchDirs = [this.root, 'home/user', 'usr/share/pkg'];
    for (const dir of searchDirs) {
      const nmDir = dir + '/node_modules/' + pkgName;
      if (!this.vfs.exists(nmDir)) continue;

      // Read the owning package.json once.
      const pkgJsonPath = nmDir + '/package.json';
      let pkg: any = null;
      if (this.vfs.exists(pkgJsonPath)) {
        try { pkg = JSON.parse(this.vfs.readFileString(pkgJsonPath)); } catch { /* malformed */ }
      }

      // 1. EXPORTS-FIELD RESOLUTION (modern packages like zustand, vfile).
      //    Only attempt if the package actually declares exports. For a subpath
      //    that isn't in exports, resolveExports returns null — we fall through
      //    to legacy resolution rather than treating the miss as fatal.
      if (pkg?.exports) {
        const entry = resolvePackageEntry(pkg, subpath ? './' + subpath : '.');
        if (entry) {
          // Normalize to collapse any ../ segments from relative entry paths.
          const resolved = this.tryResolveFile(normalizePath(nmDir + '/' + entry.replace(/^\.\//, '')));
          if (resolved) return resolved;
        }
      }

      // 2. LEGACY SUBPATH (no exports field, or exports didn't cover this subpath).
      //    Packages like react-remove-scroll-bar expose their structure directly
      //    through `files` and flat directory layout. This block walks the
      //    usual Node.js legacy resolution:
      //      a) <subpath>.{ext}          — direct file
      //      b) <subpath>/index.{ext}    — directory with index
      //      c) <subpath>/package.json   — nested package.json (pkg/module/main)
      //
      //    Branch (c) is critical for packages like react-remove-scroll-bar
      //    whose `constants/package.json` points OUT of the directory with
      //    `"module": "../dist/es2015/constants.js"`. The resulting path
      //    `constants/../dist/es2015/constants.js` MUST be normalized to
      //    `dist/es2015/constants.js` before VFS lookup.
      if (subpath) {
        // (a) + (b) combined — tryResolveFile handles both
        const direct = this.tryResolveFile(normalizePath(nmDir + '/' + subpath));
        if (direct) return direct;

        // (c) nested package.json
        const nestedPkgPath = nmDir + '/' + subpath + '/package.json';
        if (this.vfs.exists(nestedPkgPath)) {
          try {
            const nested = JSON.parse(this.vfs.readFileString(nestedPkgPath));
            const entry = nested.module || nested.main || 'index.js';
            // Normalize to collapse ../ segments — critical when a nested
            // package.json redirects to a sibling directory (common pattern
            // for legacy packages shipping both es5 and es2015 builds).
            const resolved = this.tryResolveFile(
              normalizePath(nmDir + '/' + subpath + '/' + entry.replace(/^\.\//, ''))
            );
            if (resolved) return resolved;
          } catch { /* malformed */ }
        }
      }

      // 3. ROOT ENTRY (no subpath) via module/main fields.
      if (!subpath && pkg) {
        const entry = pkg.module || pkg.main;
        if (entry) {
          const resolved = this.tryResolveFile(normalizePath(nmDir + '/' + entry.replace(/^\.\//, '')));
          if (resolved) return resolved;
        }
      }

      // 4. Last resort — <pkgRoot>/index.{ext}
      const fallback = this.tryResolveFile(nmDir + '/index');
      if (fallback) return fallback;
    }
    return null;
  }

  private tryResolveFile(base: string): string | null {
    // Defense in depth: normalize input even if callers already did. The VFS
    // treats `..` as a literal path component (no traversal resolution at
    // lookup time), so any un-normalized `../` in the path will miss.
    const norm = normalizePath(base);
    // Covers .cjs and .mts/.cts too — legacy packages use .cjs,
    // some modern packages use .mts for their ESM build.
    const exts = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json'];
    for (const ext of exts) {
      const p = norm + ext;
      if (this.vfs.exists(p) && !this.vfs.isDirectory(p)) return p;
    }
    // Directory index fallback.
    if (this.vfs.exists(norm) && this.vfs.isDirectory(norm)) {
      const idxExts = ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx'];
      for (const idx of idxExts) {
        const p = norm + '/' + idx;
        if (this.vfs.exists(p) && !this.vfs.isDirectory(p)) return p;
      }
    }
    return null;
  }

  // ── File serving ──────────────────────────────────────────────────────

  /**
   * Try to resolve a URL pathname to an actual file in the VFS by applying
   * Vite/webpack-style extension resolution. This is critical for ES module
   * imports like `import App from "./App"` where the browser requests
   * /preview/src/App with no extension.
   *
   * Resolution order (matches Vite's default `resolve.extensions` plus .vue/.svelte):
   *   1. Exact file path
   *   2. path + .tsx, .ts, .jsx, .js, .mjs, .cjs, .vue, .svelte, .json
   *   3. path as directory → path/index.{ext} (covering .html for static sites)
   *   4. For .js/.mjs/.cjs/.jsx specifiers that don't resolve, try .ts/.tsx/.mts/.cts
   *      fallback — common in TypeScript projects with NodeNext module resolution
   *      (imports written as "./bar.js" while source is "./bar.ts")
   *
   * Note: `sanitizePath` strips trailing slashes before this runs, so requests
   * like `/utils/` arrive here as `/utils` — they hit the directory-index branch
   * via the `isDirectory` check, which is correct.
   */
  private resolveFileCandidate(pathname: string): { vfsPath: string; pathname: string } | null {
    const basePath = this.root + pathname;

    // Extension candidates, in preference order (TSX first — most common in React projects).
    // .vue and .svelte are included for resolver completeness — serving/transforming
    // them still requires a framework plugin, but at least the resolver finds them.
    const extensions = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
    const indexFiles = [
      '/index.tsx', '/index.ts', '/index.jsx', '/index.js', '/index.mjs', '/index.cjs',
      '/index.vue', '/index.svelte', '/index.json', '/index.html',
    ];

    // 1. Exact path match
    if (this.vfs.exists(basePath) && !this.vfs.isDirectory(basePath)) {
      return { vfsPath: basePath, pathname };
    }

    // Determine whether the final path segment already has an extension.
    // We compute lastDot and lastSlash relative to the path to handle cases like
    // `/src/v1.0/App` where a dot appears in a DIRECTORY name (lastDot < lastSlash).
    const lastSlash = pathname.lastIndexOf('/');
    const lastDot = pathname.lastIndexOf('.');
    const hasExtension = lastDot > lastSlash && lastDot < pathname.length - 1;

    // 2. Append extensions if the final segment has no extension.
    if (!hasExtension) {
      for (const ext of extensions) {
        const candidate = basePath + ext;
        if (this.vfs.exists(candidate) && !this.vfs.isDirectory(candidate)) {
          return { vfsPath: candidate, pathname: pathname + ext };
        }
      }
    } else {
      // 4. TypeScript .js → .ts / .tsx fallback for NodeNext projects.
      const currentExt = pathname.substring(lastDot);
      const jsToTs: Record<string, string[]> = {
        '.js':  ['.ts', '.tsx'],
        '.mjs': ['.mts', '.ts'],
        '.cjs': ['.cts', '.ts'],
        '.jsx': ['.tsx'],
      };
      const fallbacks = jsToTs[currentExt];
      if (fallbacks) {
        const withoutExt = pathname.substring(0, lastDot);
        for (const tsExt of fallbacks) {
          const candidate = this.root + withoutExt + tsExt;
          if (this.vfs.exists(candidate) && !this.vfs.isDirectory(candidate)) {
            return { vfsPath: candidate, pathname: withoutExt + tsExt };
          }
        }
      }
    }

    // 3. Directory → /index.{ext}
    if (this.vfs.exists(basePath) && this.vfs.isDirectory(basePath)) {
      for (const idx of indexFiles) {
        const candidate = basePath + idx;
        if (this.vfs.exists(candidate) && !this.vfs.isDirectory(candidate)) {
          return { vfsPath: candidate, pathname: pathname + idx };
        }
      }
    }

    return null;
  }

  /**
   * Decide whether a 404 on this request should fall back to index.html (SPA
   * routing) or stay as 404. We MUST NOT return HTML for JS module requests —
   * the browser rejects them with a MIME-type error and the whole app breaks.
   *
   * Strategy: trust `Sec-Fetch-Dest` (set by all modern browsers) as the
   * primary signal. Fall back to `Accept` header analysis + tight source-path
   * heuristics for edge cases like old clients or non-browser fetchers.
   *
   * We intentionally DO NOT treat every path under `/api/`, `/hooks/`,
   * `/components/`, etc. as a module — those are common client-side route
   * names in real React/Vue apps, and marking them as module would 404 legit
   * navigation. Only paths rooted under unambiguous build-system directories
   * (`/src/`, `/node_modules/`, `/@vite/`, `/@modules/`, `/@fs/`, `/public/`,
   * `/assets/`) are treated as definitely-not-SPA.
   */
  private isModuleRequest(request: Request, pathname: string, query: string): boolean {
    // 1. Explicit module query marker (?import)
    if (query.includes('import')) return true;

    // 2. Sec-Fetch-Dest — most reliable signal. All modern browsers set this:
    //    'document' / 'iframe' → top-level navigation (SPA fallback OK)
    //    'script' / 'style' / 'font' / 'image' / 'audio' / 'video' / 'worker'
    //    / 'object' / 'embed' / 'manifest' / 'track' → subresource (no HTML)
    //    'empty' → fetch() — treat as module to avoid MIME errors
    const secFetchDest = request.headers.get('Sec-Fetch-Dest');
    if (secFetchDest) {
      if (secFetchDest === 'document' || secFetchDest === 'iframe') {
        // Explicit navigation — not a module request
        return false;
      }
      // Anything else (script, style, empty, etc.) is a subresource.
      return true;
    }

    // 3. Has-extension check — any recognizable file extension means
    //    "this is a specific file, not a SPA route". Catches .js, .css,
    //    .svg, .png, .woff2, etc. Uses slash-aware dot detection to avoid
    //    misidentifying paths with dotted directory segments.
    const lastSlash = pathname.lastIndexOf('/');
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot > lastSlash && lastDot < pathname.length - 1) {
      return true;
    }

    // 4. Unambiguous build-system source directories. Trimmed from the prior
    //    aggressive list — `/components/`, `/pages/`, `/hooks/`, `/utils/`,
    //    `/api/` etc. are common SPA route names in real apps and should NOT
    //    force module treatment based on path alone.
    const sourcePatterns = [
      '/src/', '/node_modules/', '/@vite/', '/@modules/', '/@fs/',
      '/public/', '/assets/',
    ];
    for (const pat of sourcePatterns) {
      if (pathname.includes(pat)) return true;
    }

    // 5. Accept header. A genuine browser navigation always includes `text/html`.
    //    fetch()'s default '*/*' indicates a programmatic request — treat as module.
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) return false;
    if (accept === '*/*' || accept === '') return true;
    if (accept.includes('application/javascript') || accept.includes('application/json')) return true;
    if (accept.includes('text/css')) return true;

    return false;
  }

  private async serveFile(request: Request, pathname: string, query: string, headers: Record<string, string>): Promise<Response> {
    let vfsPath = this.root + pathname;

    // If the exact path doesn't exist, try Vite-style extension resolution.
    // This is essential for ES module imports like `import X from "./foo"` —
    // the browser fetches /preview/src/foo with no extension, and we need to
    // try .tsx/.ts/.jsx/.js/.mjs/.cjs/.json and directory index files.
    if (!this.vfs.exists(vfsPath) || (this.vfs.isDirectory(vfsPath) && !pathname.endsWith('/'))) {
      const resolved = this.resolveFileCandidate(pathname);
      if (resolved) {
        vfsPath = resolved.vfsPath;
        pathname = resolved.pathname;
      } else {
        // Nothing matched. Only fall back to index.html for true navigation
        // requests — never for module/asset/style fetches (which would get a
        // MIME-type error in the browser and break everything).
        if (this.isModuleRequest(request, pathname, query)) {
          return new Response('404 Not Found: ' + pathname, {
            status: 404, headers: { ...headers, 'Content-Type': 'text/plain' },
          });
        }
        return this.serveIndexHtml(headers);
      }
    }

    if (this.vfs.isDirectory(vfsPath)) {
      const indexPath = vfsPath + '/index.html';
      if (this.vfs.exists(indexPath)) {
        let html = this.vfs.readFileString(indexPath);
        if (html.includes('</head>')) {
          html = html.replace('</head>', ERROR_OVERLAY_CLIENT + '\n' + HMR_CLIENT + '\n</head>');
        }
        html = this.rewriteHtmlPaths(html);
        return new Response(html, {
          headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('403 Directory listing not supported', {
        status: 403, headers,
      });
    }

    // Extract extension using slash-aware dot detection. Naive `split('.').pop()`
    // returns garbage for paths with dotted directories like `/src/v1.0/App`
    // (would produce `ext = '.0/app'`). We only accept a dot that occurs AFTER
    // the final slash and has at least one character after it.
    const pExtLastSlash = pathname.lastIndexOf('/');
    const pExtLastDot = pathname.lastIndexOf('.');
    const ext = (pExtLastDot > pExtLastSlash && pExtLastDot < pathname.length - 1)
      ? pathname.substring(pExtLastDot).toLowerCase()
      : '';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Transform TS/TSX/JSX/MTS/CTS files
    if (ext === '.ts' || ext === '.tsx' || ext === '.jsx' || ext === '.mts' || ext === '.cts') {
      return this.serveTransformed(vfsPath, ext, headers);
    }

    // CSS handling
    if (ext === '.css') {
      let css = this.vfs.readFileString(vfsPath);
      // Resolve @import "./other.css" (but pass through @import url(...) for Google Fonts etc.)
      const cssDir = vfsPath.includes('/') ? vfsPath.substring(0, vfsPath.lastIndexOf('/')) : this.root;
      css = css.replace(/@import\s+["']([^"']+)["']\s*;/g, (_match: string, importPath: string) => {
        if (importPath.startsWith('http')) return _match;
        const resolvedPath = importPath.startsWith('/')
          ? this.root + importPath
          : cssDir + '/' + importPath;
        try {
          return this.vfs.readFileString(resolvedPath);
        } catch {
          return `/* @import "${importPath}" not found */`;
        }
      });

      // Process Tailwind CSS directives if project uses Tailwind
      if (this.hasTailwind) {
        css = processTailwindCss(css);
      }

      // CSS-as-JS module: if ?import query, wrap in JS that injects <style>
      if (query.includes('import')) {
        const escapedCss = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        const jsCode = `(function() {
  var id = ${JSON.stringify(this.basePath + pathname)};
  var existing = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (existing) { existing.textContent = \`${escapedCss}\`; return; }
  var s = document.createElement('style');
  s.setAttribute('data-vite-dev-id', id);
  s.textContent = \`${escapedCss}\`;
  document.head.appendChild(s);
})();`;
        return new Response(jsCode, {
          headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }

      return new Response(css, {
        headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' },
      });
    }

    // JSON files: serve as ES module when imported from JS
    if (ext === '.json') {
      const accept = request.headers.get('Accept') || '';
      // If requested as a module (via import), wrap as ES module
      if (accept.includes('application/javascript') || query.includes('import')) {
        const json = this.vfs.readFileString(vfsPath);
        const code = `export default ${json};`;
        return new Response(code, {
          headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }
      // Otherwise serve as plain JSON
      const data = this.vfs.readFile(vfsPath);
      return new Response(data, {
        headers: { ...headers, 'Content-Type': contentType },
      });
    }

    // JS files: rewrite imports (cached)
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const cached = this.moduleCache.get(vfsPath);
      if (cached) {
        return new Response(cached.code, {
          headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }
      let code = this.vfs.readFileString(vfsPath);
      if (!this.hasImportmap) {
        code = rewriteAllImports(code, this.aliases, this.basePath);
      }
      this.moduleCache.set(vfsPath, { code, timestamp: Date.now() });
      return new Response(code, {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    }

    // Asset imports from JS: serve as URL-exporting module
    if (ASSET_EXTS.has(ext) && query.includes('import')) {
      const url = this.basePath + pathname;
      const code = `export default ${JSON.stringify(url)};`;
      return new Response(code, {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    }

    // Other files: serve as-is (binary)
    const data = this.vfs.readFile(vfsPath);
    return new Response(data, { headers: { ...headers, 'Content-Type': contentType } });
  }

  // ── TS/TSX/JSX transform ──────────────────────────────────────────────

  private async serveTransformed(
    vfsPath: string,
    ext: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const cached = this.moduleCache.get(vfsPath);
    if (cached) {
      return new Response(cached.code, {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    }

    let code = this.vfs.readFileString(vfsPath);

    // Auto-inject React Router `basename` into entry files so user links
    // like <NavLink to="/x"> correctly resolve to `${basePath}/x`. Safe
    // no-op if the file doesn't reference createBrowserRouter/<BrowserRouter>
    // or the user has opted out (explicit basename / line-leading comment /
    // vite.config.ts nimbusInjectBasename: false).
    if (this.injectBasename && shouldProcessForRouter(vfsPath)) {
      try {
        code = injectRouterBasename(code, this.basePath);
      } catch (e: any) {
        // Never let the transform break serving — log and continue with original.
        console.warn('[vite-dev] basename injection skipped for', vfsPath, ':', e?.message);
      }
    }

    const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts';
    try {
      const hasPreact = code.includes('from "preact"') || code.includes("from 'preact'") || code.includes('from "preact/');
      const jsxOpts: any = hasPreact
        ? { jsx: 'transform' as const, jsxFactory: 'h', jsxFragment: 'Fragment' }
        : { jsx: 'automatic' as const };

      const result = await this.esbuild.transform(code, {
        loader,
        format: 'esm',
        target: 'esnext',
        ...jsxOpts,
        define: this.define,
        sourcemap: 'inline',
      });
      code = result.code;
    } catch (e: any) {
      const errMsg = (e?.message || String(e)).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
      code = `
console.error(\`[nimbus-vite] Transform error:\\n${errMsg}\`);
if (!document.getElementById('nimbus-error-overlay')) {
  const d = document.createElement('div');
  d.id = 'nimbus-error-overlay';
  d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);color:#ff6b6b;font-family:monospace;padding:32px;overflow:auto;white-space:pre-wrap;font-size:14px;line-height:1.6';
  d.innerHTML = '<div style="max-width:800px;margin:0 auto"><h2 style="color:#ff6b6b;margin-bottom:16px">Transform Error</h2><pre style="color:#e4e4e7;background:#1a1a2e;padding:16px;border-radius:8px;overflow-x:auto">' + \`${errMsg}\`.replace(/</g,'&lt;') + '</pre><p style="color:#666;margin-top:16px">Fix the error and save. The page will reload.</p></div>';
  d.onclick = () => d.remove();
  document.body.appendChild(d);
}\n`;
      return new Response(code, {
        headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    }

    // Rewrite all imports: CSS ?import, aliases, bare → /@modules/, dynamic
    if (!this.hasImportmap) {
      code = rewriteAllImports(code, this.aliases, this.basePath);
    }

    this.moduleCache.set(vfsPath, { code, timestamp: Date.now() });
    return new Response(code, {
      headers: { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }

  get stats() {
    return {
      running: this.running,
      port: this.port,
      root: this.root,
      cachedModules: this.moduleCache.size,
      hasTailwind: this.hasTailwind,
      aliases: Object.keys(this.aliases),
    };
  }
}
