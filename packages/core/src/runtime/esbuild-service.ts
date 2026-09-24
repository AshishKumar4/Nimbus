/**
 * EsbuildService — TypeScript/JSX transform + bundling via esbuild-wasm.
 *
 * esbuild-wasm's linear memory is module-global: ~28 MiB at first use,
 * growing with every module transformed or bundled and never released. A
 * host whose isolate is memory-constrained passes a `transformHost` and a
 * `buildHost` so esbuild runs in another isolate (the session's is the
 * loader-backed esbuild facet); without them, esbuild runs here. build()'s
 * VFS resolver plugin always runs here, over this service's view.
 */

import { FACET_PROVIDED_PACKAGE_ENTRYPOINTS } from '../constants.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import { resolvePackageEntry, resolveExports, type ResolvablePackageJson } from '../_shared/exports-resolver.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import { errorText } from '../_shared/error-text.js';
import { tokenizer, tokTypes } from 'acorn';
import {
  literalStringValue,
  nodeList,
  nodeName,
  nodeProp,
  parseJavaScriptModule,
} from './javascript-ast.js';
import { scanJsSource } from './comment-strip.js';
import {
  VITE_ASSET_QUERY_SUFFIXES,
  splitImportQuery,
  viteAssetLoader,
  type ViteAssetLoaderKind,
} from './vite-assets.js';

/**
 * Bundler version tag. BUMP THIS whenever bundling semantics change —
 * the esbuild plugin's resolver logic, the shared-externals rules, the
 * post-processing pipeline, or anything that would invalidate cached
 * pre-bundles. The version is stored in pkg_esm_bundles.bundle_hash and
 * checked on read; cache entries with a different version are treated
 * as missing and rebuilt from scratch.
 *
 * History:
 *   v1 — initial pre-bundling
 *   v2 — shared React externals, CJS named exports
 *   v3 — Node subpath imports (#foo) support for vfile/unified ecosystem
 *   v4 — legacy flat-subpath resolution (pkg/sub without exports field);
 *        CDN fallback wrapper no longer crashes on modules without default
 *   v5 — normalize `../` segments in joined entry paths (react-remove-scroll-bar
 *        style: nested package.json with "module": "../dist/es2015/foo.js")
 *   v6 — externals enforced via plugin onResolve only (top-level `external:`
 *        dropped). Fixes dual-React-instance bug where jsx-runtime and
 *        react-dom/client were inlining their own copy of react because
 *        esbuild's entry-point external check rejected the externals when
 *        passed at the top level. v5 cache entries are wrong (contain
 *        embedded react copies) and must be invalidated.
 *   v7 — barrel-package bundles include a named-import signature in
 *        pkg_esm_bundles.input_hash. Prevents reusing a lucide-react
 *        bundle synthesized for one icon set after user source imports
 *        additional icons.
 *   v8 — pkg_esm_bundles now stores RAW esbuild output (base-independent);
 *        the module-URL rewrite that used to be baked in is applied per
 *        request at serve time so one bundle serves every mount base. v7
 *        rows hold post-rewrite text and must be re-bundled. user_module_
 *        transforms is likewise re-keyed by mount base.
 */
export const BUNDLER_VERSION = 'v11';

// ── Shared-runtime externals ────────────────────────────────────────────

/**
 * Returns the list of specifiers that must be marked `external` when bundling
 * `specifier` so that React / React-DOM / Scheduler share a single instance
 * across all /@modules/ bundles.
 *
 * Why: React uses an internal module-scoped singleton
 * (`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`) for current dispatcher,
 * owner, etc. If two bundles each contain their own embedded React, they each
 * have their own singleton, and `createRoot` from one bundle sees JSX elements
 * created by the other as "alien" — silent render failure (root stays empty).
 *
 * The fix: when bundling react-dom/*, mark react/* and scheduler as external.
 * The bundler leaves `import {...} from "react"` in the output; the browser
 * then fetches /preview/@modules/react, which is the SAME URL the jsx-runtime
 * bundle imports — so both react-dom and jsx-runtime share ONE React instance.
 *
 * Similarly for react/jsx-runtime and react/jsx-dev-runtime (they must share
 * react's internals), we externalize `react` (but not `scheduler` — jsx-runtime
 * doesn't need it).
 */
export function getSharedRuntimeExternals(specifier: string): string[] {
  // react: the canonical bundle. No externals — it's the source of truth.
  if (specifier === 'react') return [];

  // react/jsx-runtime, react/jsx-dev-runtime: import from react's
  // ReactSharedInternals to use the dispatcher. Externalize `react` so
  // the jsx-runtime bundle is just the JSX helpers (~5 KiB) sharing
  // ONE React instance via the browser's module loader.
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
    return ['react'];
  }
  // Other react/* subpaths (e.g., react/server) — externalize react.
  if (specifier.startsWith('react/')) {
    return ['react'];
  }

  // EVERYTHING ELSE — react-dom, framer-motion, lucide-react, zustand,
  // @radix-ui/*, react-router, etc. — must share react's singleton. If any
  // of these embeds its own React copy, elements tagged by that copy get
  // rejected as "alien" by the createRoot from the OTHER React copy
  // (silent render fail / "Objects are not valid as a React child" with
  // $$typeof spelled out). Externalize the entire React runtime.
  //
  // We DO NOT use `react/*` glob here because that has historically tripped
  // esbuild's entry-point check. Instead we list the specific subpath
  // imports React's ecosystem actually emits: jsx-runtime + jsx-dev-runtime.
  // (react-dom subpaths are handled below by 'react-dom/*'.)
  //
  // Filter out patterns that match the spec being bundled — when
  // bundling 'react-dom', drop 'react-dom' / 'react-dom/*' from the list
  // so the entry can be bundled.
  const all = [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/*',
    'scheduler',
  ];
  // Determine the package name for the spec being bundled (handles
  // scoped packages and subpaths: 'react-dom/client' → 'react-dom').
  const specPkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

  return all.filter((pat) => {
    if (pat === specifier) return false;
    if (pat.endsWith('/*')) {
      const prefix = pat.slice(0, -1); // e.g. 'react-dom/'
      const pkgName = pat.slice(0, -2); // e.g. 'react-dom'
      if (specifier.startsWith(prefix)) return false;
      if (specifier === pkgName) return false;
      if (specPkg === pkgName) return false;
    } else {
      // Plain (non-glob) external. Drop if the spec being bundled is
      // a subpath of this external's package.
      if (specPkg === pat) return false;
    }
    return true;
  });
}

/**
 * Cheap heuristic: does the source contain a top-level ESM `import`
 * statement? Used by `EsbuildService.transform` to detect sources that
 * cannot be IIFE-wrapped as-is.
 *
 * Bug history (nuxt-esm-in-cjs wave):
 * ─────────────────────────────────
 * The TLA fix (framework-gaps-fix P2) wraps CJS-target sources in an
 * async IIFE:
 *
 *     ;(async () => { <source> })().catch(...);
 *
 * For sources with TLA-only, that works: `await` becomes legal inside
 * the async function body. But for sources with BOTH TLA AND ESM
 * `import` statements (real-world example: nuxi's `bin/nuxi.mjs`), the
 * wrap moves `import` statements into a function body — and ESM
 * `import` syntax is only legal at module top-level. esbuild rejects
 * the wrapped source with `Unexpected "<binding>"` at line 3 of stdin
 * (the wrap's line 1 is `;(async () =>...`, line 2 is the open brace,
 * line 3 is the first user import).
 *
 * When TLA AND ESM imports coexist we must extract the imports first,
 * rewrite them as `const X = require(...)` shims at top-level (above
 * the IIFE), then wrap the rest. See `convertEsmImportsToRequire` for
 * the rewrite contract and `transform()` for the integration site.
 *
 * Heuristic match: any of `import "..."` / `import x from "..."` /
 * `import { ... } from "..."` / `import * as ns from "..."` / `import
 * x, { ... } from "..."` appearing on a line whose first non-whitespace
 * token is the `import` keyword. Dynamic `import(...)` calls are
 * EXCLUDED — those are expressions, legal anywhere including IIFE
 * bodies, and need no rewrite.
 *
 * Operates on comment-and-string-stripped source so commented-out imports
 * and "import" inside string literals do not trigger.
 */
function hasEsmImports(src: string): boolean {
  if (!src || src.indexOf('import') === -1) return false;
  const stripped = stripCommentsAndStrings(src);
  // Top-level `import ... from "..."` OR side-effect `import "..."`.
  // Negative lookbehind for `.` (avoids `something.import` member
  // access) is unsupported in some JS engines; we match start-of-line
  // (after whitespace) + the keyword. dynamic import() is matched as
  // `import(` and excluded by negative lookahead.
  const re = /^[ \t]*import\b(?!\s*\()/m;
  return re.test(stripped);
}

function hasEsmExports(src: string): boolean {
  if (!src || src.indexOf('export') === -1) return false;
  const stripped = stripCommentsAndStrings(src);
  return /^[ \t]*export\b/m.test(stripped);
}

/**
 * Strip `//` and `/* *\/` comments and string / template literals from
 * source for the import/export classifiers — one scanner shared with
 * prefetch's import detection in `comment-strip.ts`. The result is
 * byte-aligned with the input per line (comment and literal newlines are
 * preserved), so error line numbers still match the original.
 */
function stripCommentsAndStrings(src: string): string {
  return scanJsSource(src, 'blank');
}

/**
 * Convert ESM `import` statements at the top of `src` to CJS
 * `require()` declarations, returning `{ requires, body }` where
 * `requires` is the require-shim block (a single string of newline-
 * separated declarations) and `body` is the source with the imports
 * removed.
 *
 * Operates on the OUTPUT of an esbuild `format: 'esm'` pre-pass, NOT
 * on raw user source. esbuild normalises imports onto single lines and
 * canonicalises the binding shape, which means a small regex over the
 * normalised output is reliable. Specifically:
 *   - Multi-line imports are collapsed to one line per import
 *   - `import x from 'm';` always has the semicolon
 *   - String quotes are normalised to double-quotes
 *   - Whitespace is canonical
 *
 * Supported import shapes (after esbuild normalisation):
 *   1. `import "m";`                    side-effect
 *   2. `import x from "m";`             default
 *   3. `import * as ns from "m";`       namespace
 *   4. `import { a, b as c } from "m";` named (with optional rename)
 *   5. `import x, { a } from "m";`      default + named
 *   6. `import x, * as ns from "m";`    default + namespace
 *
 * Rewrites:
 *   1. `require("m");`
 *   2. `const x = (() => { const _m = require("m"); return _m && _m.__esModule ? _m.default : _m; })();`
 *   3. `const ns = require("m");`
 *   4. `const { a, b: c } = require("m");`
 *   5. `const _m_<n> = require("m"); const x = _m_<n>.__esModule ? _m_<n>.default : _m_<n>; const { a } = _m_<n>;`
 *   6. `const ns = require("m"); const x = ns.__esModule ? ns.default : ns;`
 *
 * Default-binding compat: ESM `import x from "m"` binds the module's
 * default export, OR the whole module if there is no default. Real
 * Node + esbuild's __esModule interop check handle this with the
 * `__esModule ? .default : whole` pattern reproduced above. Same as
 * what esbuild emits inline when targeting CJS for a no-TLA source
 * (verified empirically against `esbuild-wasm 0.24.2`).
 *
 * Unknown shapes are left in `body` unchanged — esbuild will reject
 * them on the second pass and the caller surfaces a clear error.
 * That's the safe failure mode.
 */
function convertEsmImportsToRequire(src: string): { requires: string; body: string } {
  const lines = src.split('\n');
  // Strip comments + string/template literals so the line scanner only
  // sees real syntax. Without this, import-shaped lines INSIDE template
  // literals (real-world: sv@0.15.3's engine.mjs scaffolds SvelteKit
  // project files via templates containing `import { redirect } from
  // '@sveltejs/kit';`) get parsed as actual imports — emitted twice into
  // the requires block → duplicate const declaration → SyntaxError at
  // facet pre-compile ("Identifier 'redirect' has already been declared").
  //
  // stripCommentsAndStrings preserves newlines, so line indices align
  // between `src` and `strippedLines`. We use the stripped line to
  // CLASSIFY (is this an import line?) and the original line to
  // EXTRACT the actual import shape (specifier, bindings).
  //
  const strippedLines = stripCommentsAndStrings(src).split('\n');
  const requires: string[] = [];
  const bodyLines: string[] = [];
  let counter = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const cls = strippedLines[li] ?? '';
    // Classification check: is this line a real top-level import?
    // The stripped version masks string content, so import-shaped
    // template-literal lines are now whitespace.
    if (!/^[ \t]*import\b/.test(cls)) {
      bodyLines.push(line);
      continue;
    }
    // Side-effect import: `import "m";` / `import 'm';`
    let m = line.match(/^[ \t]*import\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) { requires.push(`require(${JSON.stringify(m[1])});`); continue; }
    // Identifier class: JS spec allows `$` and `_` in addition to `\w`
    // (letters/digits/underscore). esbuild's ESM-pass-1 emits `process$1`
    // when colliding with a global (e.g. `import process from 'node:process'`
    // becomes `process$1`). Pre-fix `\w+` truncated at `$`, all the regexes
    // below missed → line fell through to bodyLines → top-level `import`
    // statement survived into the async-IIFE wrap → SyntaxError
    // "import statement outside module" at facet pre-compile.
    // Default + namespace: `import x, * as ns from "m";`
    m = line.match(/^[ \t]*import\s+([\w$]+)\s*,\s*\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const def = m[1], ns = m[2], mod = m[3];
      requires.push(`const ${ns} = require(${JSON.stringify(mod)}); const ${def} = ${ns}.__esModule ? ${ns}.default : ${ns};`);
      continue;
    }
    // Default + named: `import x, { a, b as c } from "m";`
    m = line.match(/^[ \t]*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const def = m[1], bindings = m[2], mod = m[3];
      const tmp = `_nimbus_m_${counter++}`;
      const named = bindings.split(',').map((b) => {
        const am = b.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!am) return b.trim();
        return am[2] ? `${am[1]}: ${am[2]}` : am[1];
      }).join(', ');
      requires.push(`const ${tmp} = require(${JSON.stringify(mod)}); const ${def} = ${tmp}.__esModule ? ${tmp}.default : ${tmp}; const { ${named} } = ${tmp};`);
      continue;
    }
    // Namespace: `import * as ns from "m";`
    m = line.match(/^[ \t]*import\s*\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) { requires.push(`const ${m[1]} = require(${JSON.stringify(m[2])});`); continue; }
    // Named only: `import { a, b as c } from "m";`
    m = line.match(/^[ \t]*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const bindings = m[1], mod = m[2];
      const named = bindings.split(',').map((b) => {
        const am = b.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!am) return b.trim();
        return am[2] ? `${am[1]}: ${am[2]}` : am[1];
      }).join(', ');
      requires.push(`const { ${named} } = require(${JSON.stringify(mod)});`);
      continue;
    }
    // Default only: `import x from "m";`
    m = line.match(/^[ \t]*import\s+([\w$]+)\s+from\s*["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const def = m[1], mod = m[2];
      requires.push(`const ${def} = (() => { const _m = require(${JSON.stringify(mod)}); return _m && _m.__esModule ? _m.default : _m; })();`);
      continue;
    }
    // Stripped-line claimed this was an import, but none of the shape
    // regexes matched. Unknown import form (e.g. multi-line import that
    // esbuild's pass-1 normalization didn't collapse, or a future-syntax
    // variant). Keep in body — esbuild's pass-2 will reject it with a
    // clear error if it's actually invalid, or accept it if it's a form
    // we don't yet recognise.
    bodyLines.push(line);
  }
  // ── Pass 2: scan bodyLines for top-level `export` statements. ──────
  //
  // After import-stripping, the body still has every `export` statement
  // verbatim. The async-IIFE wrap (the caller wraps body in
  // `;(async () => { ... })();`) makes those exports illegal grammar
  // ('export' is module-only, not legal in function bodies) →
  // SyntaxError "Unexpected token 'export'" at facet pre-compile.
  //
  // Rewrite each top-level export to a CJS-compatible equivalent (see
  // Same defences as imports:
  //   - String-content masking (template-literal exports don't trigger)
  //   - $-aware identifier regex ([\w$]+, esbuild emits foo$1 ids)
  //
  // Multi-line `export { ... }` lists are coalesced before shape match.
  const bodySrc = bodyLines.join('\n');
  const bodyLines2 = bodySrc.split('\n');
  const strippedBody = stripCommentsAndStrings(bodySrc).split('\n');
  const out: string[] = [];
  let i = 0;
  let exportCounter = 0;
  while (i < bodyLines2.length) {
    const line = bodyLines2[i];
    const cls = strippedBody[i] ?? '';
    if (!/^[ \t]*export\b/.test(cls)) {
      out.push(line);
      i++;
      continue;
    }
    // Multi-line collector: if the stripped line opens a `{` for an
    // `export { ... }` list and doesn't close it on the same line,
    // accumulate subsequent lines until the matching `}` (tracked on
    // the stripped lines so string `}`s don't trip us).
    let coalesced = line;
    let coalescedCls = cls;
    if (/^[ \t]*export\s*\{/.test(cls) && !/\}/.test(cls)) {
      let j = i + 1;
      while (j < bodyLines2.length) {
        coalesced += ' ' + bodyLines2[j];
        coalescedCls += ' ' + (strippedBody[j] ?? '');
        if (/\}/.test(strippedBody[j] ?? '')) { j++; break; }
        j++;
      }
      i = j;
    } else {
      i++;
    }

    // Helper: emit a `__esModule = true` marker exactly once.
    // (Mirrors esbuild's own emit; consumers using the __esModule check
    // in convertEsmImportsToRequire's default-import shim then pick
    // .default correctly.)
    const ensureEsmMarker = (() => {
      let emitted = false;
      return () => {
        if (emitted) return '';
        emitted = true;
        return 'module.exports.__esModule = true; ';
      };
    })();

    // Shape regexes operate on the COALESCED ORIGINAL line. We use the
    // stripped version only for classification (already done above).
    let m: RegExpMatchArray | null;

    // export default function/class — declaration form
    // `export default function foo(args){...}` (named declaration)
    m = coalesced.match(/^([ \t]*)export\s+default\s+(async\s+)?function\s*([\w$]+)\s*([\s\S]*)$/);
    if (m) {
      const indent = m[1], asyncKw = m[2] || '', name = m[3], rest = m[4];
      out.push(`${indent}${asyncKw}function ${name} ${rest}`);
      out.push(`${ensureEsmMarker()}module.exports.default = ${name};`);
      continue;
    }
    // export default class K {...}
    m = coalesced.match(/^([ \t]*)export\s+default\s+class\s+([\w$]+)\s*([\s\S]*)$/);
    if (m) {
      const indent = m[1], name = m[2], rest = m[3];
      out.push(`${indent}class ${name} ${rest}`);
      out.push(`${ensureEsmMarker()}module.exports.default = ${name};`);
      continue;
    }
    // export default <anonymous-function | anonymous-class | expression>
    // Match any remaining `export default …` shape and emit as assignment.
    m = coalesced.match(/^([ \t]*)export\s+default\s+([\s\S]*)$/);
    if (m) {
      const indent = m[1];
      let rest = m[2];
      // Strip trailing semicolon (we add our own).
      rest = rest.replace(/;\s*$/, '');
      out.push(`${indent}${ensureEsmMarker()}module.exports.default = (${rest});`);
      continue;
    }

    // export named-declaration: const/let/var
    m = coalesced.match(/^([ \t]*)export\s+(const|let|var)\s+([\w$]+)\s*=\s*([\s\S]*)$/);
    if (m) {
      const indent = m[1], kw = m[2], name = m[3];
      let rest = m[4];
      rest = rest.replace(/;\s*$/, '');
      out.push(`${indent}${kw} ${name} = ${rest};`);
      out.push(`${ensureEsmMarker()}module.exports.${name} = ${name};`);
      continue;
    }
    // export function NAME(...) {...}
    m = coalesced.match(/^([ \t]*)export\s+(async\s+)?function\s*\*?\s*([\w$]+)\s*([\s\S]*)$/);
    if (m) {
      const indent = m[1], asyncKw = m[2] || '', name = m[3], rest = m[4];
      // Preserve generator-star if present (function\s*\*).
      const generatorStar = /^export\s+(?:async\s+)?function\s*\*/.test(coalesced.replace(/^[ \t]+/, '')) ? '*' : '';
      out.push(`${indent}${asyncKw}function${generatorStar} ${name} ${rest}`);
      out.push(`${ensureEsmMarker()}module.exports.${name} = ${name};`);
      continue;
    }
    // export class NAME { ... } / export class NAME extends X { ... }
    m = coalesced.match(/^([ \t]*)export\s+class\s+([\w$]+)\s*([\s\S]*)$/);
    if (m) {
      const indent = m[1], name = m[2], rest = m[3];
      out.push(`${indent}class ${name} ${rest}`);
      out.push(`${ensureEsmMarker()}module.exports.${name} = ${name};`);
      continue;
    }

    // export { x, y as z } from 'm' / export * from 'm' / export * as ns from 'm'
    m = coalesced.match(/^([ \t]*)export\s*\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const indent = m[1], ns = m[2], mod = m[3];
      out.push(`${indent}${ensureEsmMarker()}module.exports.${ns} = require(${JSON.stringify(mod)});`);
      continue;
    }
    m = coalesced.match(/^([ \t]*)export\s*\*\s+from\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const indent = m[1], mod = m[2];
      const tmp = `_nimbus_re_${exportCounter++}`;
      out.push(`${indent}${ensureEsmMarker()}{ const ${tmp} = require(${JSON.stringify(mod)}); for (const _k in ${tmp}) { if (_k !== "default" && _k !== "__esModule") module.exports[_k] = ${tmp}[_k]; } }`);
      continue;
    }
    m = coalesced.match(/^([ \t]*)export\s*\{([^}]*)\}\s+from\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const indent = m[1], bindings = m[2], mod = m[3];
      const tmp = `_nimbus_re_${exportCounter++}`;
      const parts = bindings.split(',').map((b) => b.trim()).filter(Boolean);
      const assigns: string[] = [];
      for (const p of parts) {
        const am = p.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!am) continue;
        const src = am[1], dst = am[2] || am[1];
        assigns.push(`module.exports.${dst} = ${tmp}.${src};`);
      }
      out.push(`${indent}${ensureEsmMarker()}{ const ${tmp} = require(${JSON.stringify(mod)}); ${assigns.join(' ')} }`);
      continue;
    }
    // export { x, y as z }  (binding-only list — no `from`)
    m = coalesced.match(/^([ \t]*)export\s*\{([^}]*)\}\s*;?\s*$/);
    if (m) {
      const indent = m[1], bindings = m[2];
      const parts = bindings.split(',').map((b) => b.trim()).filter(Boolean);
      const assigns: string[] = [];
      for (const p of parts) {
        const am = p.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!am) continue;
        const src = am[1], dst = am[2] || am[1];
        assigns.push(`module.exports.${dst} = ${src};`);
      }
      out.push(`${indent}${ensureEsmMarker()}${assigns.join(' ')}`);
      continue;
    }

    // Unknown export shape — leave in body (esbuild will surface a clear
    // error at the next pass, or this is a future-syntax variant we
    // don't yet recognise).
    out.push(coalesced);
  }
  return { requires: requires.join('\n'), body: out.join('\n') };
}

interface ModuleDeclarationRange {
  start: number;
  end: number;
  kind: 'import' | 'export';
}

function topLevelModuleDeclarationRanges(source: string): ModuleDeclarationRange[] | null {
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    const ranges: ModuleDeclarationRange[] = [];
    let active: Omit<ModuleDeclarationRange, 'end'> | null = null;
    let braces = 0;
    let parens = 0;
    let brackets = 0;
    // `exports.import = …` is a member, not a declaration.
    let previous = tokTypes.eof;

    const updateDepth = (type: typeof tokTypes.eof): void => {
      if (type === tokTypes.braceL || type === tokTypes.dollarBraceL) braces++;
      else if (type === tokTypes.braceR) braces = Math.max(0, braces - 1);
      else if (type === tokTypes.parenL) parens++;
      else if (type === tokTypes.parenR) parens = Math.max(0, parens - 1);
      else if (type === tokTypes.bracketL) brackets++;
      else if (type === tokTypes.bracketR) brackets = Math.max(0, brackets - 1);
    };

    while (true) {
      const token = tokens.getToken();
      const type = token.type;
      if (type === tokTypes.eof) return active ? null : ranges;
      const member = previous === tokTypes.dot || previous === tokTypes.questionDot;
      previous = type;

      if (active) {
        updateDepth(type);
        if (type === tokTypes.semi && braces === 0 && parens === 0 && brackets === 0) {
          ranges.push({ ...active, end: token.end });
          active = null;
        }
        continue;
      }

      const topLevel = braces === 0 && parens === 0 && brackets === 0;
      if (topLevel && type === tokTypes._import && !member) {
        const next = tokens.getToken();
        previous = next.type;
        if (next.type !== tokTypes.parenL && next.type !== tokTypes.dot) {
          active = { start: token.start, kind: 'import' };
        }
        updateDepth(next.type);
        continue;
      }
      if (topLevel && type === tokTypes._export && !member) {
        active = { start: token.start, kind: 'export' };
        continue;
      }
      updateDepth(type);
    }
  } catch {
    return null;
  }
}


function hasUnscopedAwait(source: string): boolean {
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    const functionBraces: boolean[] = [];
    const functionParenDepths: number[] = [];
    const methodParenCandidates: boolean[] = [];
    const arrowExpressions: Array<{ parens: number; braces: number; brackets: number }> = [];
    let bracketDepth = 0;
    let pendingMethodBody = false;
    let pendingArrowBody = false;
    let pendingFunctionKeyword = false;
    let previous = tokTypes.eof;
    let previousEnd = 0;

    while (true) {
      const token = tokens.getToken();
      const type = token.type;
      if (type === tokTypes.eof) return false;

      if (pendingMethodBody && type !== tokTypes.braceL) pendingMethodBody = false;
      if (pendingArrowBody && type !== tokTypes.braceL) {
        arrowExpressions.push({
          parens: methodParenCandidates.length,
          braces: functionBraces.length,
          brackets: bracketDepth,
        });
        pendingArrowBody = false;
      }

      if (pendingFunctionKeyword) {
        if (
          type === tokTypes.colon || type === tokTypes.comma || type === tokTypes.braceR
          || type === tokTypes.parenR || type === tokTypes.bracketR || type === tokTypes.eq
        ) functionParenDepths.pop();
        pendingFunctionKeyword = false;
      }

      if (source.slice(previousEnd, token.start).includes('\n')) {
        while (arrowExpressions.length > 0) {
          const arrow = arrowExpressions[arrowExpressions.length - 1];
          if (
            methodParenCandidates.length !== arrow.parens
            || functionBraces.length !== arrow.braces
            || bracketDepth !== arrow.brackets
          ) break;
          arrowExpressions.pop();
        }
      }

      while (arrowExpressions.length > 0) {
        const arrow = arrowExpressions[arrowExpressions.length - 1];
        const delimited = (type === tokTypes.semi || type === tokTypes.comma)
          && methodParenCandidates.length === arrow.parens
          && functionBraces.length === arrow.braces
          && bracketDepth === arrow.brackets;
        const closed = (type === tokTypes.parenR && methodParenCandidates.length === arrow.parens)
          || (type === tokTypes.bracketR && bracketDepth === arrow.brackets)
          || (type === tokTypes.braceR && functionBraces.length === arrow.braces);
        if (!delimited && !closed) break;
        arrowExpressions.pop();
      }

      if (
        type === tokTypes.name
        && source.slice(token.start, token.end) === 'await'
        && !functionBraces.includes(true)
        && arrowExpressions.length === 0
      ) return true;

      if (type === tokTypes._function || type === tokTypes._class) {
        if (previous !== tokTypes.dot && previous !== tokTypes.questionDot) {
          functionParenDepths.push(methodParenCandidates.length);
          pendingFunctionKeyword = true;
        }
      } else if (type === tokTypes.arrow) {
        pendingArrowBody = true;
      } else if (type === tokTypes.parenL) {
        methodParenCandidates.push(
          functionBraces.length > 0
            && (previous === tokTypes.name || previous === tokTypes.string
              || previous === tokTypes.num || previous === tokTypes.bracketR),
        );
      } else if (type === tokTypes.parenR) {
        pendingMethodBody = methodParenCandidates.pop() === true;
      } else if (type === tokTypes.bracketL) {
        bracketDepth++;
      } else if (type === tokTypes.bracketR) {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (type === tokTypes.dollarBraceL) {
        functionBraces.push(false);
      } else if (type === tokTypes.braceL) {
        const functionBody = pendingArrowBody
          || pendingMethodBody
          || functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length;
        if (functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length) {
          functionParenDepths.pop();
        }
        functionBraces.push(functionBody);
        pendingArrowBody = false;
        pendingMethodBody = false;
      } else if (type === tokTypes.braceR) {
        functionBraces.pop();
      }
      previousEnd = token.end;
      previous = type;
    }
  } catch {
    return true;
  }
}

interface ConvertedModuleDeclarations {
  imports: string;
  exports: string;
}

function convertBundledModuleDeclarations(snippets: string[]): ConvertedModuleDeclarations | null {
  const imports: string[] = [];
  const exports: string[] = [];
  let importIndex = 0;
  let markedEsm = false;

  for (const snippet of snippets) {
    const bindingList = snippet.match(/^[ \t]*export\s*\{([\s\S]*)\}\s*;?\s*$/);
    if (bindingList && !/\}\s*from\b/.test(snippet)) {
      if (!markedEsm) {
        exports.push('Object.defineProperty(module.exports, "__esModule", { value: true });');
        markedEsm = true;
      }
      for (const binding of bindingList[1].split(',')) {
        const match = binding.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (!match) return null;
        const local = match[1];
        const exported = match[2] || local;
        exports.push(
          `Object.defineProperty(module.exports, ${JSON.stringify(exported)}, { enumerable: true, get: () => ${local} });`,
        );
      }
      continue;
    }
    let ast: ReturnType<typeof parseJavaScriptModule>;
    try {
      ast = parseJavaScriptModule(snippet);
    } catch {
      return null;
    }
    const body = nodeList(ast, 'body');
    if (body.length !== 1) return null;
    const declaration = body[0];

    if (declaration.type === 'ImportDeclaration') {
      const source = literalStringValue(nodeProp(declaration, 'source'));
      if (!source) return null;
      const specifiers = nodeList(declaration, 'specifiers');
      if (specifiers.length === 0) {
        imports.push(`module.require(${JSON.stringify(source)});`);
        continue;
      }
      const moduleName = `__nimbus_import_${importIndex++}`;
      imports.push(`const ${moduleName} = module.require(${JSON.stringify(source)});`);
      for (const specifier of specifiers) {
        const local = nodeName(nodeProp(specifier, 'local'));
        if (!local) return null;
        if (specifier.type === 'ImportDefaultSpecifier') {
          imports.push(`const ${local} = ${moduleName} && ${moduleName}.__esModule ? ${moduleName}.default : ${moduleName};`);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          imports.push(`const ${local} = ${moduleName};`);
        } else if (specifier.type === 'ImportSpecifier') {
          const imported = nodeName(nodeProp(specifier, 'imported'));
          if (!imported) return null;
          imports.push(`const ${local} = ${moduleName}[${JSON.stringify(imported)}];`);
        } else {
          return null;
        }
      }
      continue;
    }

    if (declaration.type === 'ExportNamedDeclaration') {
      if (nodeProp(declaration, 'source') || nodeProp(declaration, 'declaration')) return null;
      if (!markedEsm) {
        exports.push('Object.defineProperty(module.exports, "__esModule", { value: true });');
        markedEsm = true;
      }
      for (const specifier of nodeList(declaration, 'specifiers')) {
        const local = nodeName(nodeProp(specifier, 'local'));
        const exported = nodeName(nodeProp(specifier, 'exported'));
        if (!local || !exported) return null;
        exports.push(
          `Object.defineProperty(module.exports, ${JSON.stringify(exported)}, { enumerable: true, get: () => ${local} });`,
        );
      }
      continue;
    }

    if (declaration.type === 'ExportDefaultDeclaration') {
      const value = nodeProp(declaration, 'declaration');
      if (!value || typeof value.start !== 'number' || typeof value.end !== 'number') return null;
      if (value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration') return null;
      if (!markedEsm) {
        exports.push('Object.defineProperty(module.exports, "__esModule", { value: true });');
        markedEsm = true;
      }
      exports.push(
        `Object.defineProperty(module.exports, "default", { enumerable: true, value: (${snippet.slice(value.start, value.end)}) });`,
      );
      continue;
    }

    return null;
  }

  return { imports: imports.join('\n'), exports: exports.join('\n') };
}
interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

function importMetaEdits(source: string, absoluteUrl: string): SourceEdit[] | null {
  const edits: SourceEdit[] = [];
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    while (true) {
      const start = tokens.getToken();
      if (start.type === tokTypes.eof) return edits;
      if (start.type !== tokTypes._import) continue;
      const dot1 = tokens.getToken();
      if (dot1.type !== tokTypes.dot) continue;
      const meta = tokens.getToken();
      if (meta.type !== tokTypes.name || source.slice(meta.start, meta.end) !== 'meta') return null;
      const dot2 = tokens.getToken();
      if (dot2.type !== tokTypes.dot) return null;
      const property = tokens.getToken();
      if (property.type !== tokTypes.name) return null;
      const propertyName = source.slice(property.start, property.end);
      if (propertyName === 'url') {
        edits.push({ start: start.start, end: property.end, text: JSON.stringify(absoluteUrl) });
      } else if (propertyName === 'resolve') {
        edits.push({
          start: start.start,
          end: property.end,
          text: `(specifier => globalThis.__nimbusImportMetaResolve(specifier, ${JSON.stringify(absoluteUrl)}))`,
        });
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Converts bundler-emitted ESM without constructing an AST or loading
 * esbuild-wasm. Returns null for module declarations that are not the compact,
 * semicolon-terminated shapes emitted by current JS bundlers.
 */
/**
 * Rewrite every dynamic `import(...)` so it resolves the way `require` does.
 *
 * This rewriter only converts top-level STATIC declarations, and left dynamic
 * import alone by design. In a cell that is wrong: the cell is compiled with
 * `new Function`, so a surviving `import()` is the RUNTIME's, and the runtime
 * hands back its own builtin rather than the process's shim. Measured on real
 * Vite —
 *
 *     vite/dist/node/chunks/config.js:14968
 *     const { createServer } = await import("node:http");
 *     return createServer(app);
 *
 * — which gave Vite the platform's `node:http`, whose `listen()` binds no
 * port in the shims' registry. Vite printed its URL, nothing was bound, and
 * the facet exited as a program with no handles left, straight after "ready".
 *
 * esbuild's own `format: 'cjs'` transform rewrites a literal dynamic import
 * to a require, so this keeps the bounded path's output equivalent to the one
 * it stands in for rather than introducing a behaviour of its own.
 */
function dynamicImportEdits(source: string): SourceEdit[] | null {
  const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const edits: SourceEdit[] = [];
  const parentheses: boolean[] = [];
  let previous = tokTypes.eof;
  let importStart: number | undefined;
  let closedImport = false;

  while (true) {
    const token = tokens.getToken();
    if (token.type === tokTypes.eof) return edits;
    // A method named import needs parse context; leave it to the compiler.
    if (closedImport && token.type === tokTypes.braceL) return null;
    closedImport = false;
    if (token.type === tokTypes.parenL) {
      parentheses.push(importStart !== undefined);
      if (importStart !== undefined) {
        edits.push({ start: importStart, end: token.end, text: '__nimbusCellImport(require, ' });
      }
    } else if (token.type === tokTypes.parenR) {
      closedImport = parentheses.pop() ?? false;
    }
    importStart = token.type === tokTypes._import && previous !== tokTypes.dot && previous !== tokTypes.questionDot
      ? token.start
      : undefined;
    previous = token.type;
  }
}

/** Bind canonical esbuild/Bun CommonJS records to the runtime's provided packages. */
export function rewriteProvidedCommonJsModules(source: string): string {
  const helpers = new Set(['__commonJS']);
  const declarations = topLevelModuleDeclarationRanges(source);
  if (!declarations) return source;
  for (const range of declarations) {
    const declaration = source.slice(range.start, range.end);
    if (tokenizer(declaration, { ecmaVersion: 'latest', sourceType: 'module' }).getToken().type !== tokTypes._import) continue;
    const parsed = parseJavaScriptModule(declaration);
    for (const statement of nodeList(parsed, 'body')) {
      if (statement.type !== 'ImportDeclaration') continue;
      for (const specifier of nodeList(statement, 'specifiers')) {
        if (nodeName(nodeProp(specifier, 'imported')) !== '__commonJS') continue;
        const local = nodeName(nodeProp(specifier, 'local'));
        if (local) helpers.add(local);
      }
    }
  }
  const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  let a = tokens.getToken();
  let b = tokens.getToken();
  let c = tokens.getToken();
  let d = tokens.getToken();
  let e = tokens.getToken();
  let previous = tokTypes.eof;
  const edits: SourceEdit[] = [];
  while (a.type !== tokTypes.eof) {
    const labelValue = 'value' in d ? d.value : undefined;
    const helperValue = 'value' in a ? a.value : undefined;
    const label = d.type === tokTypes.string && typeof labelValue === 'string' ? labelValue : null;
    const entry = label === null ? undefined : Object.entries(FACET_PROVIDED_PACKAGE_ENTRYPOINTS).find(([name, path]) => {
      const suffix = 'node_modules/' + name + '/' + path;
      return label === suffix || label.endsWith('/' + suffix);
    });
    if (a.type === tokTypes.name && typeof helperValue === 'string' && helpers.has(helperValue)
      && previous !== tokTypes.dot && previous !== tokTypes.questionDot
      && b.type === tokTypes.parenL && c.type === tokTypes.braceL && entry
      && e.type === tokTypes.parenL) {
      let parens = 2;
      let braces = 1;
      let singleModule = true;
      let bodySeen = false;
      let last = e;
      let pendingComma = false;
      while (parens > 0) {
        const token = tokens.getToken();
        if (token.type === tokTypes.eof) return source;
        if (pendingComma && token.type !== tokTypes.braceR) singleModule = false;
        pendingComma = false;
        if (token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) {
          if (braces === 1 && parens === 1) bodySeen = true;
          braces++;
        } else if (token.type === tokTypes.braceR) braces--;
        if (token.type === tokTypes.parenL) parens++;
        else if (token.type === tokTypes.parenR) parens--;
        if (braces === 1 && parens === 1 && token.type === tokTypes.comma) pendingComma = true;
        if (braces === 0 && parens === 1 && token.type !== tokTypes.braceR) singleModule = false;
        last = token;
      }
      if (singleModule && bodySeen && braces === 0) {
        edits.push({ start: a.start, end: last.end, text: '(() => require(' + JSON.stringify(entry[0]) + '))' });
      }
      previous = last.type;
      a = tokens.getToken(); b = tokens.getToken(); c = tokens.getToken(); d = tokens.getToken(); e = tokens.getToken();
      continue;
    }
    previous = a.type;
    a = b; b = c; c = d; d = e; e = tokens.getToken();
  }
  if (edits.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

export function rewriteBundledEsmToCjs(
  source: string,
  absoluteUrl: string,
): TransformResult | null {
  if (hasUnscopedAwait(source)) return null;
  const declarations = topLevelModuleDeclarationRanges(source);
  if (!declarations || declarations.length === 0) return null;
  const declarationSnippets = declarations.map(({ start, end }) => source.slice(start, end));
  for (let i = 0; i < declarations.length; i++) {
    if (/^[ \t]*export\s+default\b/.test(declarationSnippets[i])
      && source.slice(declarations[i].end).trim() !== '') return null;
  }
  const converted = convertBundledModuleDeclarations(declarationSnippets);
  if (!converted) return null;
  const metaEdits = importMetaEdits(source, absoluteUrl);
  if (!metaEdits) return null;
  const importCalls = dynamicImportEdits(source);
  if (!importCalls) return null;

  const edits: SourceEdit[] = [
    ...declarations.map(({ start, end }) => ({ start, end, text: '' })),
    ...metaEdits.filter((edit) =>
      !declarations.some(({ start, end }) => edit.start >= start && edit.end <= end)
    ),
    ...importCalls.filter((edit) =>
      !declarations.some(({ start, end }) => edit.start >= start && edit.end <= end)
    ),
  ].sort((a, b) => a.start - b.start);

  const bodyParts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) return null;
    bodyParts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  bodyParts.push(source.slice(cursor));
  const body = bodyParts.join('');

  return {
    code: converted.imports + '\n' + body + '\n' + converted.exports,
    map: '',
    warnings: [],
  };
}

// ── esbuild-wasm imports ────────────────────────────────────────────────
//
// `esbuild-wasm` ships no `exports` map. Its `main` is the Node CJS build
// `lib/main.js`, and only the LEGACY `browser` field points at a build that
// can run here. Every resolver that ignores that legacy field resolves the
// bare specifier to `lib/main.js`: Node, Bun, and — the case that matters in
// production — the worker environment of a host bundler, because Vite leaves
// `browser` out of `resolve.mainFields` for every non-client environment.
//
// `lib/main.js` cannot serve this file, for two independent reasons:
//   1. It runs `createRequire(import.meta.url)('fs')` at module init, which
//      workerd rejects with `Dynamic require of "fs" is not supported`
//      (`nodejs_compat` satisfies static `import 'node:fs'`, not runtime
//      CJS requires).
//   2. Its `initialize()` refuses the `wasmModule` option outright:
//      `The "wasmModule" option only works in the browser`.
//
// `wasmModule` is the only initialization form available to us. There is no
// filesystem for the Node build to read, and `wasmURL` would fetch a third
// party mid-request, which the 100% edge contract forbids. So the entrypoint
// is named rather than inferred: `esm/browser.js` is the one build whose
// `initialize()` accepts a precompiled module. It is also the exact file
// `packages/worker/scripts/bundle-esbuild-wasm.mjs` stages for facets, and
// that script gates it against `createRequire` / `require('fs')` on every
// install — so both consumers of esbuild-wasm load the same vetted build.
//
// The load stays lazy: a session that never bundles never evaluates it.
//
// The .wasm import is a compile-time asset binding (the host bundler resolves
// it to a WebAssembly.Module) and executes no esbuild-wasm JS, so it is safe
// at the top level.
import type * as esbuild from 'esbuild-wasm/esm/browser.js';
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm';

/**
 * Cached reference to the esbuild namespace. Populated on first
 * `loadEsbuild()` call; nullable until then so module-load code paths
 * that never touch bundling can complete without ever evaluating
 * esbuild-wasm's JS at all.
 */
let _esbuildMod: typeof esbuild | null = null;
let _esbuildLoadPromise: Promise<typeof esbuild> | null = null;

/**
 * Load the esbuild-wasm namespace. Safe to call many times; concurrent
 * callers share a single in-flight Promise, and a rejection clears the
 * cache so a later call can retry.
 *
 * Exported so `tests/unit/esbuild-wasm-entrypoint.mjs` can drive the real
 * specifier under a Node-style resolver. A test that restated the specifier
 * would grade its own copy of it, and this defect reached production
 * precisely because nothing graded the resolution.
 *
 * The specifier stays a literal: a computed one would defeat the host
 * bundler's static analysis and leave the module out of the deployed worker.
 */
export async function loadEsbuild(): Promise<typeof esbuild> {
  if (_esbuildMod) return _esbuildMod;
  if (_esbuildLoadPromise) return _esbuildLoadPromise;
  _esbuildLoadPromise = (async () => {
    // Deliberately dynamic: a static import would evaluate esbuild-wasm in
    // every session, including the ones that only serve a shell and never
    // bundle. The specifier is still a literal so the host bundler sees it.
    const mod = await import('esbuild-wasm/esm/browser.js');
    _esbuildMod = mod as unknown as typeof esbuild;
    return _esbuildMod;
  })();
  try {
    return await _esbuildLoadPromise;
  } catch (e) {
    _esbuildLoadPromise = null;
    throw e;
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface EsbuildTransformOptions {
  loader?: 'ts' | 'tsx' | 'jsx' | 'js' | 'css' | 'json';
  format?: 'esm' | 'cjs' | 'iife';
  target?: string;
  sourcemap?: boolean | 'inline' | 'external';
  minify?: boolean;
  jsx?: 'transform' | 'preserve' | 'automatic';
  jsxFactory?: string;
  jsxFragment?: string;
  tsconfigRaw?: string;
  define?: Record<string, string>;
}

export interface TransformResult {
  code: string;
  map: string;
  warnings: { text: string; location?: esbuild.Location | null }[];
}
/**
 * One emitted output. `bytes` is authoritative (UTF-8 fidelity for the
 * `file`-loader assets `viteAssets` emits); `contents` is the lazy decoded
 * view, memoized exactly like esbuild's own `OutputFile.text`.
 */
export interface BuildOutputFile {
  path: string;
  bytes: Uint8Array;
  readonly contents: string;
}

export interface BuildResult {
  outputFiles: BuildOutputFile[];
  errors: { text: string; location?: esbuild.Location | null }[];
  warnings: { text: string; location?: esbuild.Location | null }[];
  /** esbuild metafile — populated because build() always enables it so
   *  callers can identify entry-point outputs (`entryPoint`, `cssBundle`)
   *  instead of guessing from output ordering. */
  metafile?: esbuild.Metafile;
}

const __outputDecoder = new TextDecoder();

type EsbuildTransformApi = Pick<typeof esbuild, 'transform'>;
type EsbuildBuildApi = Pick<typeof esbuild, 'build'>;

async function transformWithEsbuild(
  esbuildApi: EsbuildTransformApi,
  source: string,
  options?: EsbuildTransformOptions,
): Promise<TransformResult> {
  let code = source;
  const format = options?.format || 'esm';
  const loader = options?.loader || 'ts';

  if (format === 'cjs') {
    try {
      const direct = await esbuildApi.transform(code, {
        loader,
        format,
        target: options?.target || 'esnext',
        sourcemap: options?.sourcemap ?? false,
        minify: options?.minify ?? false,
        jsx: options?.jsx,
        jsxFactory: options?.jsxFactory,
        jsxFragment: options?.jsxFragment,
        tsconfigRaw: options?.tsconfigRaw,
        define: options?.define,
        supported: { 'dynamic-import': false },
      });
      return {
        code: direct.code,
        map: direct.map || '',
        warnings: direct.warnings?.map((warning) => ({
          text: warning.text,
          location: warning.location,
        })) || [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/top-level await.*not supported.*cjs/i.test(message)) throw error;
    }

    if (hasEsmImports(code) || hasEsmExports(code)) {
      const pass1 = await esbuildApi.transform(code, {
        loader,
        format: 'esm',
        target: options?.target || 'esnext',
        sourcemap: false,
        minify: false,
        jsx: options?.jsx,
        jsxFactory: options?.jsxFactory,
        jsxFragment: options?.jsxFragment,
        tsconfigRaw: options?.tsconfigRaw,
        define: options?.define,
        supported: { 'dynamic-import': false },
      });
      const { requires, body } = convertEsmImportsToRequire(pass1.code);
      return {
        code: requires + '\nreturn (async () => {\n' + body + '\n})();\n',
        map: '',
        warnings: pass1.warnings?.map((warning) => ({
          text: warning.text,
          location: warning.location,
        })) || [],
      };
    }

    code = 'return (async () => {\n' + code + '\n})();\n';
  }

  const result = await esbuildApi.transform(code, {
    loader,
    format,
    target: options?.target || 'esnext',
    sourcemap: options?.sourcemap ?? false,
    minify: options?.minify ?? false,
    jsx: options?.jsx,
    jsxFactory: options?.jsxFactory,
    jsxFragment: options?.jsxFragment,
    tsconfigRaw: options?.tsconfigRaw,
    define: options?.define,
    supported: { 'dynamic-import': false },
  });

  return {
    code: result.code,
    map: result.map || '',
    warnings: result.warnings?.map((warning) => ({
      text: warning.text,
      location: warning.location,
    })) || [],
  };
}

/**
 * One esbuild build in which `plugin` resolves and loads every module,
 * wherever that plugin runs. Self-contained: it is serialized into the
 * esbuild facet as well as called here.
 */
async function buildWithEsbuild(
  esbuildApi: EsbuildBuildApi,
  options: EsbuildHostBuildOptions,
  plugin: EsbuildRemotePlugin,
): Promise<EsbuildBuildOutcome> {
  const result = await esbuildApi.build({
    ...options,
    write: false,
    plugins: [{
      name: plugin.name,
      setup(build) {
        build.onResolve({ filter: /.*/ }, async (args) => (await plugin.resolve({
          path: args.path,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          with: args.with,
        })) ?? undefined);
        build.onLoad({ filter: /.*/ }, async (args) => (await plugin.load({
          path: args.path,
          namespace: args.namespace,
          suffix: args.suffix,
          with: args.with,
        })) ?? undefined);
      },
    }],
  });
  return {
    outputFiles: (result.outputFiles || []).map((file) => ({ path: file.path, contents: file.contents })),
    errors: result.errors.map((message) => ({ text: message.text, location: message.location })),
    warnings: result.warnings.map((message) => ({ text: message.text, location: message.location })),
    metafile: result.metafile,
  };
}

/** Source the esbuild facet evaluates next to esbuild: its transform and build helpers. */
export function generateEsbuildFacetRuntimeSource(): string {
  return [
    // scanJsSource is self-contained — its constants live in the body —
    // so this serialized copy carries the whole scanner.
    scanJsSource.toString(),
    stripCommentsAndStrings.toString(),
    hasEsmImports.toString(),
    hasEsmExports.toString(),
    convertEsmImportsToRequire.toString(),
    transformWithEsbuild.toString(),
    buildWithEsbuild.toString(),
  ].join('\n');
}

/** One transform a {@link EsbuildTransformHost} runs. */
export interface EsbuildTransformRequest {
  code: string;
  options?: EsbuildTransformOptions;
}

/**
 * A host's answer for one request: the output, or why esbuild rejected the
 * module. A `transient` error is no verdict on the source: the host could not
 * run the transform this time.
 */
export type EsbuildTransformOutcome = TransformResult | { error: string; transient?: true };

/**
 * Runs transforms in another isolate: one call per batch, outcomes positional.
 * esbuild-wasm's linear memory starts at ~28 MiB, grows with every module it
 * transforms and is never released, so an isolate that is memory-constrained
 * (a session supervisor) hands its transforms to one of these.
 */
export type EsbuildTransformHost = (requests: EsbuildTransformRequest[]) => Promise<EsbuildTransformOutcome[]>;

/** esbuild's arguments to a resolve callback, as data another isolate can carry. */
export interface EsbuildRemoteResolveArgs {
  path: string;
  importer: string;
  namespace: string;
  resolveDir: string;
  kind: esbuild.ImportKind;
  with: Record<string, string>;
}

/** esbuild's arguments to a load callback, as data another isolate can carry. */
export interface EsbuildRemoteLoadArgs {
  path: string;
  namespace: string;
  suffix: string;
  with: Record<string, string>;
}

/**
 * A plugin's resolve and load callbacks, answered where the plugin runs while
 * esbuild runs elsewhere. `null` leaves the module to esbuild.
 */
export interface EsbuildRemotePlugin {
  /** The plugin's own name, which esbuild's diagnostics cite. */
  name: string;
  resolve(args: EsbuildRemoteResolveArgs): Promise<esbuild.OnResolveResult | null>;
  load(args: EsbuildRemoteLoadArgs): Promise<esbuild.OnLoadResult | null>;
}

/** Build options another isolate can carry: no plugins, and nothing written to disk. */
export type EsbuildHostBuildOptions = Omit<esbuild.BuildOptions, 'plugins' | 'write'>;

/** What one build produced, as data another isolate can carry. */
export interface EsbuildBuildOutcome {
  outputFiles: Array<{ path: string; contents: Uint8Array }>;
  errors: BuildResult['errors'];
  warnings: BuildResult['warnings'];
  metafile?: esbuild.Metafile;
}

/**
 * Runs a build in another isolate. Every module is resolved and loaded
 * through `plugin`, which stays with the caller and its filesystem view,
 * while the esbuild heap, which grows with the module graph and is never
 * released, lives in the host.
 */
export type EsbuildBuildHost = (options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin) => Promise<EsbuildBuildOutcome>;

export interface EsbuildServiceOptions {
  /** Where transform() and transformMany() run. Absent: this isolate. */
  transformHost?: EsbuildTransformHost;
  /** Where build() runs. Absent: this isolate. */
  buildHost?: EsbuildBuildHost;
}

/**
 * `plugin`, set up here, answering esbuild's resolve and load callbacks the
 * way esbuild's own dispatch within one plugin does: callbacks in the order
 * registered, and the first to return a result answers.
 */
async function remotePlugin(plugin: esbuild.Plugin, initialOptions: esbuild.BuildOptions): Promise<EsbuildRemotePlugin> {
  const resolvers: Array<{ filter: RegExp; namespace?: string; callback: (args: esbuild.OnResolveArgs) => unknown }> = [];
  const loaders: Array<{ filter: RegExp; namespace?: string; callback: (args: esbuild.OnLoadArgs) => unknown }> = [];
  const build: Pick<esbuild.PluginBuild, 'initialOptions' | 'onResolve' | 'onLoad'> = {
    initialOptions,
    onResolve: (options, callback) => { resolvers.push({ ...options, callback }); },
    onLoad: (options, callback) => { loaders.push({ ...options, callback }); },
  };
  // The VFS plugin reads initialOptions and registers callbacks; it uses nothing else of PluginBuild.
  await plugin.setup(build as esbuild.PluginBuild);
  const matches = (entry: { filter: RegExp; namespace?: string }, path: string, namespace: string) =>
    (entry.namespace === undefined || entry.namespace === namespace) && entry.filter.test(path);
  return {
    name: plugin.name,
    async resolve(args) {
      for (const entry of resolvers) {
        if (!matches(entry, args.path, args.namespace)) continue;
        const result = await entry.callback({ ...args, pluginData: undefined });
        if (result != null) return result as esbuild.OnResolveResult;
      }
      return null;
    },
    async load(args) {
      for (const entry of loaders) {
        if (!matches(entry, args.path, args.namespace)) continue;
        const result = await entry.callback({ ...args, pluginData: undefined });
        if (result != null) return result as esbuild.OnLoadResult;
      }
      return null;
    },
  };
}

/** A CJS emit of JavaScript binds bundled CommonJS records to the runtime's provided packages first. */
function withProvidedModuleRewrite(code: string, options?: EsbuildTransformOptions): string {
  return options?.format === 'cjs' && (!options.loader || options.loader === 'js' || options.loader === 'jsx')
    ? rewriteProvidedCommonJsModules(code)
    : code;
}

// ── EsbuildService ──────────────────────────────────────────────────────
export class EsbuildService {
  private vfs: CredentialedVfs | null;
  private readonly transformHost: EsbuildTransformHost | null;
  private readonly buildHost: EsbuildBuildHost | null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Resolved esbuild namespace — populated by ensureInit() after loadEsbuild(). */
  private _esbuild: typeof esbuild | null = null;

  /** Build reads use only the caller-supplied view; omit it for transform-only use. */
  constructor(vfs?: CredentialedVfs, options: EsbuildServiceOptions = {}) {
    this.vfs = vfs ?? null;
    this.transformHost = options.transformHost ?? null;
    this.buildHost = options.buildHost ?? null;
  }

  /** Whether transforms grow this isolate's esbuild heap: true unless a transform host was given. */
  get transformsInIsolate(): boolean {
    return this.transformHost === null;
  }

  /**
   * Initialize esbuild-wasm (lazy, on first use). Loads the namespace
   * via `loadEsbuild()` (which itself is deferred) and caches it on
   * `this._esbuild` so subsequent calls don't pay the dynamic-import
   * overhead. All call sites that previously used the top-level
   * `esbuild` namespace now use `this._esbuild!` after `await this.ensureInit()`.
   */
  private async ensureInit(): Promise<void> {
    if (this.initialized && this._esbuild) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const esb = await loadEsbuild();
        this._esbuild = esb;
        // The supervisor loads esbuild-wasm via wrangler's static-import
        // resolution (`import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm'`
        // at the top of this file). At deploy time wrangler bundles the
        // .wasm bytes INTO the worker and resolves the import to a
        // WebAssembly.Module value. If the import didn't resolve to a
        // module — for example, a future bundler regression — we used
        // to silently fall back to fetching from cdn.jsdelivr.net. That
        // fallback violated the 100% edge contract: the supervisor
        // would issue a third-party CDN request mid-request to bring
        // up its bundler. Removed.
        //
        // If the bundled import is missing, fail loud with a clear
        // remediation (rebuild the worker with the wasm asset). The
        // supervisor's pre-bundle path also embeds esbuild-wasm via
        // src/esbuild-wasm-bundle.generated.ts, so a complete loss of
        // wasm support would surface there too.
        if (!esbuildWasmUrl || typeof esbuildWasmUrl !== 'object') {
          throw new Error(
            'esbuild-wasm bundled import is not a WebAssembly.Module. ' +
              'Rebuild the worker so wrangler resolves ' +
              '`esbuild-wasm/esbuild.wasm` at bundle time. ' +
              'NO CDN fallback (100% edge contract).',
          );
        }
        // [WRANGLER-DEV-HANG P0b] Time-bound esb.initialize. Workerd
        // has historically had cases where wasm init blocks indefinitely;
        // 30 s is well above the typical ~200 ms init time.
        const INIT_TIMEOUT_MS = 30_000;
        let initTimeout: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          esb.initialize({
            // wrangler resolves this static `.wasm` import to a compiled
            // module at bundle time; the asset stub for a `.wasm` module can
            // only declare its default export as a string, and the guard
            // above is what checks the resolution actually happened.
            wasmModule: esbuildWasmUrl as unknown as WebAssembly.Module,
            worker: false,
          }),
          new Promise<never>((_, reject) => {
            initTimeout = setTimeout(() => {
              reject(new Error(
                `esbuild init exceeded ${INIT_TIMEOUT_MS / 1000}s. ` +
                `wasmModule type=${typeof esbuildWasmUrl}; ` +
                `Likely cause: WebAssembly compile/init stall in workerd.`
              ));
            }, INIT_TIMEOUT_MS);
          }),
        ]).finally(() => { if (initTimeout) clearTimeout(initTimeout); });
        this.initialized = true;
      } catch (e) {
        const message = errorText(e);
        // "Cannot call initialize more than once" means it's already ready
        if (message.includes('more than once')) {
          this.initialized = true;
          return;
        }
        this.initPromise = null;
        throw new Error('esbuild init failed: ' + message);
      }
    })();

    return this.initPromise;
  }

  /**
   * Transform a single code string (TS→JS, JSX→JS, minify, etc.)
   *
   * Top-level await note (gap #2 in framework-gaps-fix):
   * ─────────────────────────────────────────────────────
   * esbuild rejects top-level await when output format is 'cjs' or
   * 'iife' — neither has a runtime primitive for it. Real Node
   * supports TLA only in ESM. Nimbus's facet wrapper executes the
   * transformed code via `new Function(...)` which is CJS-shaped.
   *
   * Several modern CLIs (nuxi, vite-cli, oclif's lazy-load bootstrap,
   * many ESM-only-by-default tools) use TLA at the entry point. With
   * format:'cjs' those would crash with "Top-level await is currently
   * not supported with the 'cjs' output format" — an esbuild
   * SyntaxError surfaced as a Nimbus diagnostic. The user can't
   * fix this without rewriting upstream.
   *
   * Fix: when caller asks for format 'cjs' AND the source has a
   * top-level await, wrap the source in an async IIFE and return its
   * Promise to the facet runner:
   *
   *     return (async () => {
   *       <original-source>
   *     })();
   *
   * Inside the IIFE, await is legal. Returning the Promise is required:
   * the facet runner awaits promise-returning entry functions so
   * sequential TLA execution cannot race process teardown or VFS flushes.
   *
   * ESM-imports-in-CJS note (nuxt-esm-in-cjs wave):
   * ─────────────────────────────────────────────────
   * The IIFE wrap above moves the user source INTO a function body.
   * Top-level ESM `import` statements are LEGAL only at module top
   * level — inside a function body they're a SyntaxError. Real-world
   * trigger: nuxi's `bin/nuxi.mjs` opens with `import { performance }
   * from "node:perf_hooks"` and ends with `const { runMain } = await
   * import("./dist/index.mjs"); runMain()` — both ESM imports AND TLA.
   * Pre-fix the IIFE wrap caused esbuild to fail with
   * `Unexpected "<binding>"` at line 3 of stdin.
   *
   * Fix: when TLA AND ESM imports coexist, run a two-stage transform:
   *   1. Pass 1: `esbuild.transform(code, { format: 'esm', ... })` —
   *      esbuild accepts TLA + imports cleanly when emitting ESM.
   *      Output is JS-canonicalised: multi-line imports collapsed,
   *      bindings normalised, etc.
   *   2. Extract top-level imports from the pass-1 output and rewrite
   *      them as `const X = require(...)` shims (see
   *      `convertEsmImportsToRequire` for the contract / shape).
   *   3. Wrap the remaining body in a returned async IIFE.
   *   4. Return the assembled string as the transform result.
   *
   * The require-shim emits the standard `__esModule` interop check
   * (matches what esbuild itself emits for ESM→CJS conversions), so
   * default-export binding semantics are preserved.
   *
   * If TLA but no ESM imports → existing single-pass IIFE wrap.
   * If ESM imports but no TLA → existing single-pass esbuild
   * format:cjs (it auto-converts ESM→CJS gracefully).
   *
   * This is bytes-stable for sources outside the TLA+ESM-imports
   * intersection.
   */
  async transform(
    code: string,
    options?: EsbuildTransformOptions,
  ): Promise<TransformResult> {
    if (this.transformHost) {
      const [outcome] = await this.transformMany([{ code, options }]);
      if ('error' in outcome) throw new Error(outcome.error);
      return outcome;
    }
    await this.ensureInit();
    return transformWithEsbuild(this._esbuild!, withProvidedModuleRewrite(code, options), options);
  }

  /**
   * Transform many modules in one round trip to the transform host (or in
   * this isolate when there is none). Outcomes are positional, and a module
   * the provided-module pre-pass or esbuild rejects is an `{ error }` outcome
   * rather than a rejection, so one bad module never costs the others their
   * output.
   */
  async transformMany(requests: readonly EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]> {
    const outcomes: EsbuildTransformOutcome[] = new Array(requests.length);
    const prepared: EsbuildTransformRequest[] = [];
    const positions: number[] = [];
    requests.forEach(({ code, options }, i) => {
      try {
        prepared.push({ code: withProvidedModuleRewrite(code, options), options });
        positions.push(i);
      } catch (e) {
        outcomes[i] = { error: errorText(e) };
      }
    });
    if (prepared.length === 0) return outcomes;
    if (this.transformHost) {
      const hosted = await this.transformHost(prepared);
      if (hosted.length !== prepared.length) {
        throw new Error(`esbuild transform host answered ${hosted.length} of ${prepared.length} requests`);
      }
      hosted.forEach((outcome, j) => { outcomes[positions[j]] = outcome; });
      return outcomes;
    }
    await this.ensureInit();
    for (let j = 0; j < prepared.length; j++) {
      const { code, options } = prepared[j];
      try {
        outcomes[positions[j]] = await transformWithEsbuild(this._esbuild!, code, options);
      } catch (e) {
        outcomes[positions[j]] = { error: errorText(e) };
      }
    }
    return outcomes;
  }

  /**
   * Bundle entry points from the VFS. The VFS plugin runs here over this
   * service's view either way; esbuild itself runs in the build host when
   * one was given.
   */
  async build(
    entryPoints: string[],
    options?: {
      bundle?: boolean;
      format?: 'esm' | 'cjs' | 'iife';
      target?: string;
      platform?: 'browser' | 'node' | 'neutral';
      outdir?: string;
      outfile?: string;
      sourcemap?: boolean | 'inline' | 'external';
      minify?: boolean;
      external?: string[];
      define?: Record<string, string>;
      globalName?: string;
      tsconfigRaw?: string;
      alias?: Record<string, string>;
      keepNames?: boolean;
      entryNames?: string;
      chunkNames?: string;
      /** Output-name template for `file`-loader assets, e.g.
       *  'assets/[name]-[hash]'. Only consulted by the viteAssets path. */
      assetNames?: string;
      /**
       * Vite build semantics for imported assets: `import './x.png'`
       * yields a URL string for an emitted `[name]-[hash]` file, `?url`
       * does the same on any extension, `?raw` yields the file text,
       * `?inline` a data: URL, and `url()` references inside `.css`
       * modules emit + rewrite the same way (esbuild's `file` loader).
       * See runtime/vite-assets.ts. Off by default: non-Vite bundling
       * callers (one-shot node, pre-bundle) keep the generic loaders.
       */
      viteAssets?: boolean;
      /**
       * Absolute path of the project `public/` directory. With
       * `viteAssets`, absolute imports like `import '/favicon.svg'`
       * resolve here first and bundle to the literal public URL
       * (`export default "/favicon.svg"`), matching Vite's public-dir
       * semantics — the file is served verbatim, never emitted hashed.
       */
      vitePublicDir?: string;
    },
  ): Promise<BuildResult> {
    const buildOptions: EsbuildHostBuildOptions = {
      entryPoints: entryPoints.map(ep => ep.startsWith('/') ? ep : '/' + ep),
      bundle: options?.bundle ?? true,
      format: options?.format || 'esm',
      target: options?.target || 'esnext',
      platform: options?.platform || 'browser',
      outdir: options?.outdir || (options?.outfile ? undefined : '/dist'),
      outfile: options?.outfile,
      sourcemap: options?.sourcemap ?? false,
      minify: options?.minify ?? false,
      external: options?.external,
      define: options?.define,
      globalName: options?.globalName,
      tsconfigRaw: options?.tsconfigRaw,
      alias: options?.alias,
      keepNames: options?.keepNames,
      entryNames: options?.entryNames,
      chunkNames: options?.chunkNames,
      assetNames: options?.assetNames,
      // Always on: it is the only reliable way for callers to tell entry
      // outputs (and their `cssBundle` sidecars) apart from emitted
      // `file`-loader assets, which output ordering cannot express.
      metafile: true,
      // Prefer ESM builds and modern module fields. This matters for packages
      // like zustand that ship both CJS (main) and ESM (module / exports.import).
      // Without these, esbuild falls back to CJS which wraps everything in
      // __commonJS and only emits `export default`, losing named exports.
      conditions: ['import', 'module', 'browser', 'default'],
      mainFields: ['module', 'browser', 'main'],
    };
    const plugin = await remotePlugin(this.makeVfsPlugin({
      viteAssets: options?.viteAssets,
      vitePublicDir: options?.vitePublicDir,
    }), buildOptions);

    let outcome: EsbuildBuildOutcome;
    if (this.buildHost) {
      outcome = await this.buildHost(buildOptions, plugin);
    } else {
      await this.ensureInit();
      outcome = await buildWithEsbuild(this._esbuild!, buildOptions, plugin);
    }

    return {
      outputFiles: outcome.outputFiles.map((f) => {
        let text: string | undefined;
        return {
          path: f.path,
          bytes: f.contents,
          get contents() {
            return (text ??= __outputDecoder.decode(f.contents));
          },
        };
      }),
      errors: outcome.errors,
      warnings: outcome.warnings,
      metafile: outcome.metafile,
    };
  }
  private requireVfs(): CredentialedVfs {
    if (!this.vfs) throw new Error('EsbuildService build requires a VFS');
    return this.vfs;
  }

  /**
   * VFS resolver plugin for esbuild.
   * Reads through the caller's credentialed view (synchronous, no snapshot needed).
   * Handles: absolute paths, relative paths, bare specifiers (node_modules),
   * and — with `viteAssets` — Vite's asset/`?suffix` import semantics.
   */
  private makeVfsPlugin(opts?: {
    viteAssets?: boolean;
    vitePublicDir?: string;
  }): esbuild.Plugin {
    const vfs = this.requireVfs();
    const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
    const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];

    // Path helpers shared with git-commands via ./vfs-path.ts.
    // Local aliases preserve the existing call-site readability inside this
    // closure; behavior is identical (the canonical normalizeVfsPath has a
    // bounds check on `..` that the previous local `normalize` lacked, but
    // for the well-formed paths esbuild produces this is a no-op).
    const strip = stripLeadingSlashes;
    const normalize = normalizeVfsPath;

    /**
     * Try to resolve a VFS path with extension/index fallbacks.
     *
     * Resolution order (first match wins):
     *   1. Exact path as given (covers `.ts`, `.js`, `.json`, `.css`, and
     *      any extension on disk) — via `''` being first in EXTS.
     *   2. Append-extension candidates from EXTS (`.ts`, `.tsx`, `.js`, …)
     *      for extensionless imports like `./foo`.
     *   3. TypeScript/ESM `moduleResolution: "bundler"` compatibility:
     *      if the input ends in `.js` / `.mjs` / `.cjs` / `.jsx` and
     *      NO file matched above, swap the extension to the TS
     *      equivalent and try those. This is the idiomatic
     *      `import {X} from './y.js'` pattern where on-disk it's `y.ts`.
     *      Order (TS spec): `.ts` → `.tsx` for `.js`/`.jsx`;
     *                        `.mts`       for `.mjs`;
     *                        `.cts`       for `.cjs`.
     *      Exact-match (step 1) happens first so a real `.js` on disk
     *      takes precedence over a co-located `.ts` — we never pretend
     *      a `.ts` is canonical when a `.js` actually exists.
     *   4. Directory index files (e.g. `./foo/index.ts`) as a last step.
     */
    function tryResolve(base: string): string | null {
      const norm = normalize(base);
      for (const ext of EXTS) {
        const candidate = norm + ext;
        if (vfs.exists(strip(candidate)) && !vfs.isDirectory(strip(candidate))) {
          return '/' + strip(candidate);
        }
      }
      // Step 3: TypeScript-bundler extension swap. Only runs when no
      // exact / extension-append match succeeded above — so real `.js`
      // files on disk always win.
      const jsExtMatch = norm.match(/\.(js|mjs|cjs|jsx)$/);
      if (jsExtMatch) {
        const withoutExt = norm.slice(0, norm.length - jsExtMatch[0].length);
        const swapMap: Record<string, string[]> = {
          js:  ['.ts', '.tsx'],
          jsx: ['.tsx', '.ts'],
          mjs: ['.mts', '.ts'],
          cjs: ['.cts', '.ts'],
        };
        const swaps = swapMap[jsExtMatch[1]] || [];
        for (const tsExt of swaps) {
          const candidate = withoutExt + tsExt;
          if (vfs.exists(strip(candidate)) && !vfs.isDirectory(strip(candidate))) {
            return '/' + strip(candidate);
          }
        }
      }
      // Step 4: directory index fallback.
      if (vfs.exists(strip(norm)) && vfs.isDirectory(strip(norm))) {
        for (const idx of INDEX_FILES) {
          const candidate = norm + '/' + idx;
          if (vfs.exists(strip(candidate))) return '/' + strip(candidate);
        }
      }
      return null;
    }

    /**
     * Resolve a Node.js subpath import (`#foo`).
     *
     * Per https://nodejs.org/api/packages.html#subpath-imports, a specifier
     * starting with `#` is looked up in the closest ancestor package.json's
     * `imports` field (not `exports`). This is used by packages like `vfile`
     * to switch between node and browser implementations:
     *
     *   "imports": {
     *     "#minpath": {
     *       "node": "./lib/minpath.js",
     *       "default": "./lib/minpath.browser.js"
     *     }
     *   }
     *
     * We walk up from the importer's directory looking for package.json.
     * Once found, we resolve the subpath using the same condition algorithm
     * as `exports` (with `import`, `module`, `browser`, `default` — skipping
     * `node` since we're bundling for the browser).
     *
     * The resolved value is a path relative to the owning package root, which
     * we turn back into a VFS path for esbuild to load.
     */
    function resolvePackageImport(specifier: string, fromDir: string): string | null {
      let dir = strip(fromDir);
      const visited = new Set<string>();
      while (dir && !visited.has(dir)) {
        visited.add(dir);

        const pkgJsonPath = dir + '/package.json';
        if (vfs.exists(strip(pkgJsonPath))) {
          try {
            const pkgJson = JSON.parse(vfs.readFileString(strip(pkgJsonPath)));
            if (pkgJson.imports) {
              // resolveExports happens to work for the imports field too —
              // both are subpath→condition maps using the same format. We
              // reuse it. The specifier (`#minpath`) IS the subpath key.
              const resolved = resolveExports(pkgJson.imports, specifier);
              if (resolved) {
                // Resolved value is relative to the owning package root
                const pkgRoot = dir;
                const absPath = pkgRoot + '/' + resolved.replace(/^\.\//, '');
                const finalPath = tryResolve(absPath);
                if (finalPath) return finalPath;
              }
            }
          } catch { /* malformed package.json — try parent */ }
        }

        // Stop at node_modules boundary — subpath imports only resolve against
        // the consuming package's own package.json, not its dependencies'.
        // But DO go up through node_modules/<pkg>/ to find <pkg>/package.json.
        if (dir.endsWith('/node_modules') || dir === 'node_modules') break;

        const lastSlash = dir.lastIndexOf('/');
        if (lastSlash <= 0) break;
        dir = dir.substring(0, lastSlash);
      }
      return null;
    }

    // Conditions per-resolution. CJS `require('X')` callers need the
    // `require` condition selected so packages that ship a dual-export
    // CJS trick (e.g. @babel/runtime/helpers/X — `module.exports = fn;
    // module.exports.default = module.exports;`) resolve to the CJS
    // file. The ESM helper file declares only `export { fn as default }`,
    // which esbuild's __toCommonJS wrap surfaces to CJS callers as
    // `{ default: fn }` — and the downstream callsite calls the
    // namespace as a function and crashes with
    // `_objectWithoutPropertiesLoose2 is not a function`.
    //
    // This affects every CJS-shipping npm package that depends on
    // `@babel/runtime/helpers/*` (thousands — anything compiled with
    // `@babel/preset-env`'s `transform-runtime`).
    // See pre-bundle-facet.ts for the matching fix in the install-time
    // pre-bundle plugin. Both code paths must agree.
    const ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];
    const CJS_CONDITIONS = ['require', 'node', 'browser', 'default'];

    /**
     * Resolve bare specifier (npm package) by walking up node_modules.
     * Uses the full Node.js exports-field algorithm. `conditions` is
     * passed through so caller can request CJS-flavoured resolution
     * (for `require()` calls in bundled CJS code).
     */
    function resolveBarePkg(specifier: string, fromDir: string, conditions: string[]): string | null {
      // Split scoped packages: @scope/pkg → ["@scope/pkg"]
      // Split subpath imports: pkg/sub/path → pkg, sub/path
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

      // Walk up directories looking for node_modules/<pkg>
      let dir = strip(fromDir);
      const visited = new Set<string>();
      while (dir && !visited.has(dir)) {
        visited.add(dir);
        const nmDir = dir + '/node_modules/' + pkgName;
        if (vfs.exists(strip(nmDir)) && vfs.isDirectory(strip(nmDir))) {
          // Read package.json so we can consult the exports field.
          const pkgJsonPath = nmDir + '/package.json';
          let pkgJson: ResolvablePackageJson | null = null;
          if (vfs.exists(strip(pkgJsonPath))) {
            try { pkgJson = JSON.parse(vfs.readFileString(strip(pkgJsonPath))); } catch {}
          }

          if (pkgJson) {
            // Use the full exports-field resolution. Conditions are
            // caller-supplied so `require()` and `import` get distinct
            // resolutions per Node spec.
            const subpathKey = subpath ? './' + subpath : '.';
            const entry = resolvePackageEntry(pkgJson, subpathKey, conditions);
            if (entry) {
              const resolved = tryResolve(nmDir + '/' + entry.replace(/^\.\//, ''));
              if (resolved) return resolved;
            }
          }

          // Fallback for subpath: try direct file resolution (e.g. pkg/lib/foo).
          if (subpath) {
            const resolved = tryResolve(nmDir + '/' + subpath);
            if (resolved) return resolved;
          }

          // Fallback for root: try index files directly
          const resolved = tryResolve(nmDir + '/index');
          if (resolved) return resolved;
        }
        // Move up one directory
        const lastSlash = dir.lastIndexOf('/');
        if (lastSlash <= 0) break;
        dir = dir.substring(0, lastSlash);
      }
      return null;
    }

    function inferLoader(path: string): esbuild.Loader {
      if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts';
      if (path.endsWith('.tsx')) return 'tsx';
      if (path.endsWith('.jsx')) return 'jsx';
      if (path.endsWith('.json')) return 'json';
      if (path.endsWith('.css')) return 'css';
      // Native binaries — load as base64 blobs instead of parsing as JS.
      // Defense-in-depth: the npm-installer pre-bundler also skips these,
      // but on-demand bundling or direct `import 'foo.wasm'` could still
      // hand us a raw WASM/native-addon path.
      if (path.endsWith('.wasm')) return 'binary';
      if (path.endsWith('.node')) return 'binary';
      return 'js';
    }

    return {
      name: 'nimbus-vfs',
      setup(build) {
        // Pre-compile the external list into exact matches and prefix patterns.
        // esbuild's `external` supports glob-like patterns (`react/*`) — we
        // reproduce that here so our plugin doesn't override the user's
        // external directive by resolving packages that should stay external.
        const externalList = build.initialOptions.external || [];
        const externalExact = new Set<string>();
        const externalPrefixes: string[] = [];
        for (const pat of externalList) {
          if (pat.endsWith('/*')) {
            externalPrefixes.push(pat.slice(0, -1)); // "react/" prefix (for "react/*")
          } else {
            externalExact.add(pat);
          }
        }
        const isExternal = (spec: string): boolean => {
          if (externalExact.has(spec)) return true;
          for (const pre of externalPrefixes) {
            if (spec.startsWith(pre)) return true;
          }
          return false;
        };

        const viteAssets = opts?.viteAssets === true;
        const publicDir = opts?.vitePublicDir
          ? '/' + strip(normalize(opts.vitePublicDir))
          : null;

        /**
         * Resolve an extension-/`?`-clean specifier through the normal VFS
         * chain. `null` falls through to esbuild's default handling, which
         * reports a proper "Could not resolve" diagnostic — never silently
         * marked external (that would ship a broken import).
         */
        const resolveModulePath = (spec: string, resolveDir: string, kind: string): string | null => {
          // 1. Subpath imports (#foo) — Node.js package.json `imports` field.
          // These MUST be resolved against the owning package's package.json,
          // not node_modules. Used by vfile, unified, and others to switch
          // between node/browser implementations.
          if (spec.startsWith('#') && resolveDir) {
            return resolvePackageImport(spec, strip(resolveDir));
          }
          // 2. Absolute paths
          if (spec.startsWith('/')) return tryResolve(spec);
          // 3. Relative paths
          if (spec.startsWith('.') && resolveDir) {
            return tryResolve(strip(resolveDir) + '/' + spec);
          }
          // 4. Bare specifier (npm package)
          if (!spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
            const fromDir = resolveDir || '/home/user';
            // Per Node spec: `require()` triggers the 'require' condition,
            // `import` triggers 'import'. esbuild surfaces this via
            // args.kind. Without this, packages that ship a dual-export
            // CJS file alongside a bare ESM file (e.g. @babel/runtime/
            // helpers/*) get resolved to the ESM variant for CJS callers,
            // and the `__toCommonJS` wrapper surfaces `{ default: fn }`
            // to a callsite that expects the function directly — runtime
            // crash with "<helper>2 is not a function" on the first
            // route that uses the affected package.
            const conditions = kind === 'require-call' || kind === 'require-resolve'
              ? CJS_CONDITIONS
              : ESM_CONDITIONS;
            return resolveBarePkg(spec, fromDir, conditions);
          }
          return null;
        };

        build.onResolve({ filter: /.*/ }, (args) => {
          let spec = args.path;
          let suffix = '';
          if (viteAssets) {
            const [bare, query] = splitImportQuery(args.path);
            spec = bare;
            suffix = query.split('&')[0];
            // Vite's `?` modifiers we understand select a namespace below.
            // Anything else — `?worker`, `?sharedworker`, `?init`,
            // `?module` — has no built-in equivalent; fail loudly instead
            // of shipping a subtly wrong import.
            if (suffix && !VITE_ASSET_QUERY_SUFFIXES[suffix]) {
              return {
                errors: [{
                  text: `Built-in vite build does not support the '?${suffix}' import modifier` +
                    ` (imported as '${args.path}'). Supported: ${Object.keys(VITE_ASSET_QUERY_SUFFIXES).map((s) => '?' + s).join(', ')}.`,
                }],
              };
            }
          }

          // Bare specifier + external → leave as-is so the browser resolves
          // via its own module resolver (which hits /preview/@modules/...).
          // This MUST come before any vfs resolution, otherwise we'd embed
          // the package into the bundle and break single-instance invariants
          // for react/react-dom.
          if (!spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
            if (isExternal(spec)) return { external: true };
          }

          let resolved = resolveModulePath(spec, args.resolveDir, args.kind);
          let publicImport = false;

          // Vite public/ fallback: `import '/vite.svg'` names a file the
          // dev server serves verbatim from publicDir — it resolves to the
          // literal URL string, never to a hashed emitted file. A user
          // `?` modifier still applies to the public FILE's contents.
          if (viteAssets && !resolved && publicDir && spec.startsWith('/')) {
            const pubPath = publicDir + spec;
            if (vfs.exists(strip(pubPath)) && !vfs.isDirectory(strip(pubPath))) {
              resolved = pubPath;
              publicImport = true;
            }
          }

          if (resolved) {
            // The `?` modifier is carried in the NAMESPACE, not the path:
            // esbuild keys module identity on (namespace, path) but derives
            // emitted-asset names and MIME types from the path — a query
            // left on the path would produce `foo-ABCD.txt?url` files and
            // text/plain data URLs.
            if (publicImport && !suffix) {
              return { path: resolved, namespace: 'nimbus-vfs-public' };
            }
            if (suffix && VITE_ASSET_QUERY_SUFFIXES[suffix]) {
              return { path: resolved, namespace: 'nimbus-vfs-' + suffix };
            }
            return { path: resolved, namespace: 'nimbus-vfs' };
          }
          if (!viteAssets && !spec.startsWith('/') && !spec.startsWith('.') && !spec.startsWith('#')) {
            // Mark as external if not found (common for Node built-ins)
            return { external: true };
          }
          return null; // esbuild reports "Could not resolve '<spec>'"
        });

        const loadVfsFile = (path: string, loader: esbuild.Loader) => {
          const stripped = strip(path);
          try {
            const lastSlash = stripped.lastIndexOf('/');
            const resolveDir = lastSlash > 0 ? '/' + stripped.substring(0, lastSlash) : '/';
            // Binary loaders (wasm, native addons) and byte-oriented Vite
            // asset loaders (file → emitted bytes, dataurl/base64 → base64
            // of the raw bytes) must receive raw bytes. TextDecoder would
            // corrupt them with U+FFFD replacement chars.
            if (loader === 'binary' || loader === 'file' || loader === 'dataurl' || loader === 'base64') {
              return { contents: vfs.readFile(stripped), loader, resolveDir };
            }
            return { contents: vfs.readFileString(stripped), loader, resolveDir };
          } catch {
            return { errors: [{ text: 'File not found in VFS: ' + path }] };
          }
        };

        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs' }, (args) => {
          const loader = viteAssets
            ? (viteAssetLoader(args.path) ?? inferLoader(args.path))
            : inferLoader(args.path);
          return loadVfsFile(args.path, loader);
        });

        // public/ verbatim: `export default "<public url>"` — the file is
        // served as-is, never emitted hashed.
        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-public' }, (args) => ({
          contents: `export default ${JSON.stringify(publicDir ? args.path.slice(publicDir.length) : args.path)};`,
          loader: 'js' as esbuild.Loader,
        }));

        // One namespace per `?` modifier. The path is already clean, so
        // emitted names/MIME types are correct; the namespace alone tells
        // the modifier apart (and keeps `?raw` vs `?url` on the same file
        // as distinct modules).
        const suffixNamespaces: Record<string, ViteAssetLoaderKind> = {
          url: 'file', raw: 'text', base64: 'base64',
        };
        for (const [suffix, loader] of Object.entries(suffixNamespaces)) {
          build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-' + suffix }, (args) =>
            loadVfsFile(args.path, loader));
        }
        // ?inline needs the extension (`.css` → text, else dataurl).
        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs-inline' }, (args) =>
          loadVfsFile(args.path, viteAssetLoader(args.path + '?inline') ?? 'dataurl'));
      },
    };
  }

  get isInitialized() { return this.initialized; }
}
