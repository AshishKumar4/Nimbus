/**
 * EsbuildService — TypeScript/JSX transform + bundling via esbuild-wasm.
 *
 * Architecture:
 *   - esbuild-wasm is imported directly in the supervisor bundle
 *   - WASM is compiled during module evaluation (startup phase) — allowed
 *   - transform() runs in the supervisor's isolate (fast, no facet needed)
 *   - build() also runs in supervisor with a VFS resolver plugin
 *
 * Why not a facet? The esbuild-wasm WASM binary needs to be compiled
 * during module startup (not request time). Dynamic workers created via
 * LOADER.load() have the same restriction. Since esbuild-wasm is bundled
 * into the supervisor, it initializes once at startup and stays warm.
 *
 * Memory: esbuild-wasm uses ~15-20MB heap. Within the DO's 128MB budget
 * this is acceptable for Phase 3. Phase 4+ can move it to a dedicated
 * facet once wasm module passing to dynamic workers is stable.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { resolvePackageEntry, resolveExports } from '../_shared/exports-resolver.js';
import { normalizeVfsPath, stripLeadingSlashes } from '../vfs/path.js';

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
 */
export const BUNDLER_VERSION = 'v6';

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
 * Cheap heuristic to detect top-level await in source. Used by
 * `EsbuildService.transform` to decide whether to async-IIFE-wrap
 * CJS-target sources (see transform()'s header comment).
 *
 * Why a regex (not a real parser):
 *   - We only need to know "is there an `await` outside any
 *     function body?". A regex over a comment-stripped source is
 *     cheap and the false-positive class is harmless (an async-
 *     IIFE wrap around code that didn't need it is a no-op).
 *   - Real parsing would require shipping a JS parser to the
 *     supervisor isolate — adds tens of KiB to the worker bundle
 *     and a fraction-of-a-millisecond per call. Not worth it.
 *
 * Heuristic:
 *   1. Strip line and block comments (avoid matching commented-out
 *      `// await foo` strings).
 *   2. Strip string and template literals (avoid matching `"await x"`
 *      in error messages or user-data strings).
 *   3. Scan token-by-token tracking brace/paren/function-keyword
 *      depth. An `await` at depth-0 OUTSIDE any `function`/`=>` body
 *      is top-level.
 *
 * Misses (accepted):
 *   - Await inside a class static initializer block at depth 0 —
 *     real Node treats that as a syntax error anyway.
 *   - Heavily-minified sources where function boundaries are
 *     packed onto a single line — we false-positive (wrap when
 *     not needed). Harmless.
 *
 * NEVER false-negatives a real top-level await in normal source;
 * the wrap is the safe direction.
 */
function hasTopLevelAwait(src: string): boolean {
  if (!src || src.indexOf('await') === -1) return false;

  // Strip comments + string/template literals so the depth-tracker
  // only sees real syntax. Shared helper preserves `${...}`
  // interpolation expressions so `\`${await foo}\`` at module top
  // level is still detected as TLA.
  const stripped = stripCommentsAndStrings(src);

  // Now walk tokens. Track function depth: `function` / `=>` opens a
  // function scope; entering `{` increments; matching `}` decrements.
  // For arrow funcs the body may be an expression (no braces) —
  // in that case the function body ends at the next `;` or top-level
  // comma. Approximation: count `function` keyword occurrences as
  // "entered fn scope" and assume the first balanced `{ ... }` after
  // it is the body.
  //
  // We use a simpler approach: scan for the keyword `await`, then
  // count `function`-keywords + `=>` arrows up to that point, minus
  // matching scope-closes via brace depth. If the await is at depth 0
  // (no enclosing function), it's TLA.
  //
  // For robustness across formatting, we just track brace depth and
  // a 'inFunctionAt' stack: when we see `function`, push the next `{`'s
  // depth onto the stack. When we see `}` and it matches the stack's
  // top, pop. Await at depth not matching any function-stack entry
  // is TLA.
  const re = /\b(await|function|class)\b|=>|\{|\}|\(|\)/g;
  let m: RegExpExecArray | null;
  const fnEntryDepths: number[] = [];
  let depth = 0;
  let pendingFnAtNextBrace = 0;
  while ((m = re.exec(stripped)) !== null) {
    const tok = m[0];
    if (tok === '{') {
      depth++;
      if (pendingFnAtNextBrace > 0) {
        fnEntryDepths.push(depth);
        pendingFnAtNextBrace--;
      }
    } else if (tok === '}') {
      if (
        fnEntryDepths.length > 0 &&
        fnEntryDepths[fnEntryDepths.length - 1] === depth
      ) {
        fnEntryDepths.pop();
      }
      depth--;
    } else if (tok === 'function' || tok === '=>') {
      // The next `{` opens the function body. Arrow functions may
      // have an expression body (no brace) — accepted false-positive.
      pendingFnAtNextBrace++;
    } else if (tok === 'class') {
      // Class bodies use `{}` too, but `await` inside a class field
      // initializer would be inside a method or value — those open
      // their own braces. Treat `class` like `function` for depth.
      pendingFnAtNextBrace++;
    } else if (tok === 'await') {
      // TLA iff no enclosing function scope is open at current depth.
      if (fnEntryDepths.length === 0) return true;
    }
  }
  return false;
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
 * Operates on the comment-and-string-stripped source so commented-out
 * imports and "import" appearing inside string literals don't trigger.
 * We reuse the comment/string stripper from `hasTopLevelAwait`'s pass
 * — see `stripCommentsAndStrings` below.
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

/**
 * Strip `//` and `/* * /` comments and string / template literals from
 * source, replacing each with a single space. The result is byte-aligned
 * with the input on a per-line basis (newlines are preserved), so error
 * line numbers from downstream parsers still align with the original.
 *
 * Shared by `hasTopLevelAwait` (which had this inline) and
 * `hasEsmImports`. Pure function — no caching needed for the small
 * inputs we see (typical .mjs entry-point: <2KiB).
 */
function stripCommentsAndStrings(src: string): string {
  let stripped = '';
  let i = 0;
  const N = src.length;
  // Track the last non-whitespace non-comment output character so we
  // can disambiguate `/` as division (after identifier/literal/`)`/`]`)
  // vs regex-literal opener (after operator / punctuator / keyword /
  // start-of-file). Pre-fix the stripper had no regex awareness, so
  // patterns like `var X = /^(?:'…)/` contained an unmatched `'` that
  // bit it as a string opener that didn't close until many lines
  // later — corrupting every downstream classifier (export-scanner,
  // hasEsmImports, hasTopLevelAwait). Real-world bite: sv-utils@0.0.3
  // index.mjs has dozens of these regex literals.
  let lastNonWsChar = '';
  const recordOut = (ch: string) => {
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      lastNonWsChar = ch;
    }
  };
  // Identifier-suffix detection on lastNonWsChar: any of these means
  // `/` is division. Anything else means `/` opens a regex.
  // Includes ascii word chars + `)` `]` to cover `foo()/x` `a[i]/y`.
  const DIVISION_AFTER = /[A-Za-z0-9_$\)\]]/;
  while (i < N) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < N && src[i] !== '\n') i++;
      stripped += ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) {
        // Preserve newlines so line numbers stay aligned.
        if (src[i] === '\n') stripped += '\n';
        i++;
      }
      i += 2;
      stripped += ' ';
      continue;
    }
    // Regex literal: `/` not followed by `/` or `*` (already handled
    // above), AND preceded by something that makes regex valid here.
    // The classifier looks at lastNonWsChar — for `(`, `,`, `=`, `;`,
    // `{`, `[`, `:`, `!`, `&`, `|`, `?`, operators, or start-of-file,
    // a slash is a regex opener.
    if (c === '/' && !DIVISION_AFTER.test(lastNonWsChar)) {
      stripped += ' ';
      i++;
      while (i < N) {
        const rc = src[i];
        if (rc === '\\') { i += 2; continue; }
        // Regex character class [...]: `/` inside it is content.
        if (rc === '[') {
          i++;
          while (i < N && src[i] !== ']') {
            if (src[i] === '\\') { i += 2; continue; }
            if (src[i] === '\n') { stripped += '\n'; }
            i++;
          }
          if (i < N) i++; // consume ']'
          continue;
        }
        if (rc === '/') { i++; break; }
        if (rc === '\n') {
          // Regex literals can't span newlines. If we hit one without
          // finding the closing `/`, this was probably NOT a regex —
          // bail out gracefully (rare in practice; better than getting
          // stuck in a wrong state).
          break;
        }
        i++;
      }
      // Skip regex flags (g, i, m, s, u, y, d).
      while (i < N && /[gimsuyd]/.test(src[i])) i++;
      recordOut('/');
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      stripped += ' ';
      i++;
      while (i < N) {
        const cc = src[i];
        if (cc === '\\') { i += 2; continue; }
        if (cc === q) { i++; break; }
        // Template interpolation: ${...} — preserve the inner
        // expression as raw code so the caller's depth-tracker can
        // see `await` etc. inside it. Strip the wrapping `${`/`}`
        // (those don't affect brace-depth from the caller's POV).
        //
        // CRITICAL: inside the interpolation expression, we must
        // recognise NESTED strings (`'}'`, `"}"`, `` `${...}` ``) so
        // their internal `}` characters don't decrement the depth
        // counter — otherwise we exit the interpolation early and
        // start consuming code as string content, eventually parsing
        // the rest of the file as one massive unclosed string. This
        // bit sv-utils/dist/index.mjs: multi-line backticks with
        // `${url.replace('}', '_')}`-style interpolations corrupted
        // line classification downstream. Recursive-by-loop here.
        if (q === '`' && cc === '$' && src[i + 1] === '{') {
          stripped += '${';
          i += 2;
          let depth = 1;
          while (i < N && depth > 0) {
            const ic = src[i];
            // Nested string inside interpolation: skip its content.
            if (ic === '"' || ic === "'" || ic === '`') {
              const iq = ic;
              stripped += ' ';
              i++;
              while (i < N) {
                const icc = src[i];
                if (icc === '\\') { i += 2; continue; }
                if (icc === iq) { i++; break; }
                // Nested template inside interpolation can also have its
                // own ${...} — recurse once more (the practical depth
                // observed in real code never exceeds 2; deeper nesting
                // falls back to brace counting which is a best-effort).
                if (iq === '`' && icc === '$' && src[i + 1] === '{') {
                  stripped += '${'; i += 2;
                  let d2 = 1;
                  while (i < N && d2 > 0) {
                    const i2 = src[i];
                    if (i2 === '{') d2++;
                    else if (i2 === '}') d2--;
                    if (d2 > 0) stripped += i2;
                    i++;
                  }
                  stripped += '}';
                  continue;
                }
                if (icc === '\n') stripped += '\n';
                i++;
              }
              continue;
            }
            if (ic === '{') depth++;
            else if (ic === '}') depth--;
            if (depth > 0) stripped += ic;
            i++;
          }
          stripped += '}';
          continue;
        }
        if (cc === '\n') stripped += '\n';
        i++;
      }
      continue;
    }
    stripped += c;
    recordOut(c);
    i++;
  }
  return stripped;
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
  // See .seal-internal/2026-05-11-sk-mjs-fix/audit.md.
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
    let m = line.match(/^[ \t]*import\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) { requires.push(`require(${JSON.stringify(m[1])});`); continue; }
    // Identifier class: JS spec allows `$` and `_` in addition to `\w`
    // (letters/digits/underscore). esbuild's ESM-pass-1 emits `process$1`
    // when colliding with a global (e.g. `import process from 'node:process'`
    // becomes `process$1`). Pre-fix `\w+` truncated at `$`, all the regexes
    // below missed → line fell through to bodyLines → top-level `import`
    // statement survived into the async-IIFE wrap → SyntaxError
    // "import statement outside module" at facet pre-compile.
    // Default + namespace: `import x, * as ns from "m";`
    m = line.match(/^[ \t]*import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) {
      const def = m[1], ns = m[2], mod = m[3];
      requires.push(`const ${ns} = require(${JSON.stringify(mod)}); const ${def} = ${ns}.__esModule ? ${ns}.default : ${ns};`);
      continue;
    }
    // Default + named: `import x, { a, b as c } from "m";`
    m = line.match(/^[ \t]*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?\s*$/);
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
    m = line.match(/^[ \t]*import\s+\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["']\s*;?\s*$/);
    if (m) { requires.push(`const ${m[1]} = require(${JSON.stringify(m[2])});`); continue; }
    // Named only: `import { a, b as c } from "m";`
    m = line.match(/^[ \t]*import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?\s*$/);
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
    m = line.match(/^[ \t]*import\s+([\w$]+)\s+from\s+["']([^"']+)["']\s*;?\s*$/);
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
  // .seal-internal/2026-05-11-sk-exports-fix/audit.md for shape table).
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

// ── esbuild-wasm imports ────────────────────────────────────────────────
//
// We must NOT eagerly import('esbuild-wasm') at module evaluation.
// esbuild-wasm's CJS `lib/main.js` runs `createRequire(import.meta.url)('fs')`
// at module-init, which workerd rejects with:
//     "Dynamic require of \"fs\" is not supported"
// on dynamic-worker instances (nodejs_compat only satisfies static
// `import 'node:fs'`, NOT runtime __require2-style CJS requires).
//
// Types are imported type-only so TypeScript sees `esbuild.Plugin` /
// `esbuild.Loader` without emitting a runtime require. The actual
// namespace is loaded lazily by `loadEsbuild()` below, triggered on
// the first transform/build/initialize call. If no caller ever runs
// esbuild (e.g. an inner Nimbus that only serves its shell), the
// module never loads and `__require2('fs')` is never hit.
//
// The .wasm import is a compile-time asset binding (wrangler resolves
// it to a WebAssembly.Module) — it does NOT execute esbuild-wasm's
// main.js, so it's safe to keep at the top level.
import type * as esbuild from 'esbuild-wasm';
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm';

/**
 * Cached reference to the esbuild namespace. Populated on first
 * `loadEsbuild()` call; nullable until then so module-load code paths
 * that never touch bundling can complete without ever evaluating
 * `esbuild-wasm/lib/main.js`.
 */
let _esbuildMod: typeof esbuild | null = null;
let _esbuildLoadPromise: Promise<typeof esbuild> | null = null;

/**
 * Lazily load the esbuild-wasm namespace. Safe to call many times;
 * concurrent callers share a single in-flight Promise. Throws if the
 * CJS main module itself can't run (i.e. the runtime doesn't support
 * the require('fs') pattern esbuild-wasm uses) — callers should catch
 * and surface a helpful error rather than crash the Worker.
 */
async function loadEsbuild(): Promise<typeof esbuild> {
  if (_esbuildMod) return _esbuildMod;
  if (_esbuildLoadPromise) return _esbuildLoadPromise;
  _esbuildLoadPromise = (async () => {
    const mod = await import('esbuild-wasm');
    _esbuildMod = mod as unknown as typeof esbuild;
    return _esbuildMod;
  })();
  try {
    return await _esbuildLoadPromise;
  } catch (e) {
    // Reset so a future call can retry (e.g., after the caller has done
    // environment setup we didn't anticipate).
    _esbuildLoadPromise = null;
    throw e;
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface TransformResult {
  code: string;
  map: string;
  warnings: { text: string; location?: any }[];
}

export interface BuildOutputFile {
  path: string;
  contents: string;
}

export interface BuildResult {
  outputFiles: BuildOutputFile[];
  errors: { text: string; location?: any }[];
  warnings: { text: string; location?: any }[];
}

// ── EsbuildService ──────────────────────────────────────────────────────

export class EsbuildService {
  private vfs: SqliteVFS;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Resolved esbuild namespace — populated by ensureInit() after loadEsbuild(). */
  private _esbuild: typeof esbuild | null = null;

  constructor(vfs: SqliteVFS) {
    this.vfs = vfs;
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
            wasmModule: esbuildWasmUrl as any,
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
      } catch (e: any) {
        // "Cannot call initialize more than once" means it's already ready
        if (e?.message?.includes('more than once')) {
          this.initialized = true;
          return;
        }
        this.initPromise = null;
        throw new Error('esbuild init failed: ' + (e?.message || e));
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
   * top-level await, wrap the source in an async IIFE:
   *
   *     ;(async () => {
   *       <original-source>
   *     })();
   *
   * Inside the IIFE, await is legal.
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
   *   3. Wrap the remaining body in the async IIFE.
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
    options?: {
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
    },
  ): Promise<TransformResult> {
    await this.ensureInit();

    const format = options?.format || 'esm';
    const loader = options?.loader || 'ts';

    // ── CJS + TLA + ESM imports: two-pass with import rewrite ──
    // This precedes the simple TLA-only IIFE wrap. We test ESM imports
    // first because the IIFE wrap is incompatible with them; if both
    // conditions hold we MUST go through the rewrite path.
    if (format === 'cjs' && hasTopLevelAwait(code) && hasEsmImports(code)) {
      // Pass 1: emit ESM so esbuild accepts TLA + imports without complaint.
      // We use the same loader/target so TS/JSX is handled here too.
      const pass1 = await this._esbuild!.transform(code, {
        loader,
        format: 'esm',
        target: options?.target || 'esnext',
        sourcemap: false, // pass-1 source map is discarded; pass-2 doesn't run esbuild
        minify: false,    // minify only on the final output if requested
        jsx: options?.jsx,
        jsxFactory: options?.jsxFactory,
        jsxFragment: options?.jsxFragment,
        tsconfigRaw: options?.tsconfigRaw,
        define: options?.define,
        // Dynamic-import lowering: rewrites `import(x)` to
        // `Promise.resolve().then(() => __toESM(require(x)))` so the
        // call routes through Nimbus's scopedRequire → VFS lookup
        // instead of workerd's worker-module-map resolver (which only
        // knows {'runner.js': workerCode}). Without this, every user
        // dynamic import() rejects with "No such module ..." — and if
        // user code has no .catch() (e.g. create-astro.mjs's
        // `import('./dist/index.js').then(({main}) => main())`), the
        // rejection is unhandled and the facet exits silently
        // exitCode=0. See .seal-internal/2026-05-11-astro-silent-exit/audit.md.
        supported: { 'dynamic-import': false },
      });
      const { requires, body } = convertEsmImportsToRequire(pass1.code);
      const assembled =
        requires + '\n' +
        ';(async () => {\n' +
        body +
        '\n})().catch((e) => { console.error(e && e.stack || e); });\n';
      return {
        code: assembled,
        map: '',
        warnings: pass1.warnings?.map((w) => ({
          text: w.text,
          location: w.location,
        })) || [],
      };
    }

    // ── CJS + TLA (no ESM imports): single-pass IIFE wrap (P2 fix) ──
    let sourceToTransform = code;
    if (format === 'cjs' && hasTopLevelAwait(code)) {
      sourceToTransform =
        ';(async () => {\n' +
        code +
        '\n})().catch((e) => { console.error(e && e.stack || e); });\n';
    }

    const result = await this._esbuild!.transform(sourceToTransform, {
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
      // Dynamic-import lowering — see two-pass branch above for rationale.
      supported: { 'dynamic-import': false },
    });

    return {
      code: result.code,
      map: result.map || '',
      warnings: result.warnings?.map(w => ({
        text: w.text,
        location: w.location,
      })) || [],
    };
  }

  /**
   * Bundle entry points from the VFS.
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
    },
  ): Promise<BuildResult> {
    await this.ensureInit();

    // VFS plugin reads directly from VFS (synchronous, co-located)
    const vfsPlugin = this.makeVfsPlugin();

    const result = await this._esbuild!.build({
      entryPoints: entryPoints.map(ep => ep.startsWith('/') ? ep : '/' + ep),
      bundle: options?.bundle ?? true,
      write: false,
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
      // Prefer ESM builds and modern module fields. This matters for packages
      // like zustand that ship both CJS (main) and ESM (module / exports.import).
      // Without these, esbuild falls back to CJS which wraps everything in
      // __commonJS and only emits `export default`, losing named exports.
      conditions: ['import', 'module', 'browser', 'default'],
      mainFields: ['module', 'browser', 'main'],
      plugins: [vfsPlugin],
    });

    return {
      outputFiles: (result.outputFiles || []).map(f => ({
        path: f.path,
        contents: f.text,
      })),
      errors: result.errors?.map(e => ({ text: e.text, location: e.location })) || [],
      warnings: result.warnings?.map(w => ({ text: w.text, location: w.location })) || [],
    };
  }

  /**
   * VFS resolver plugin for esbuild.
   * Reads directly from the SqliteVFS (synchronous, co-located — no snapshot needed).
   * Handles: absolute paths, relative paths, bare specifiers (node_modules).
   */
  private makeVfsPlugin(): esbuild.Plugin {
    const vfs = this.vfs;
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
          let pkgJson: any = null;
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

        build.onResolve({ filter: /.*/ }, (args) => {
          // 1. Subpath imports (#foo) — Node.js package.json `imports` field.
          // These MUST be resolved against the owning package's package.json,
          // not node_modules. Used by vfile, unified, and others to switch
          // between node/browser implementations.
          if (args.path.startsWith('#') && args.resolveDir) {
            const resolved = resolvePackageImport(args.path, strip(args.resolveDir));
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
            // If we can't resolve it, fall through — better to leak a bare
            // import that fails loudly than to pretend it's external.
          }

          // 2. Bare specifier + external → leave as-is so the browser resolves
          // via its own module resolver (which hits /preview/@modules/...).
          // This MUST come before any vfs resolution, otherwise we'd embed
          // the package into the bundle and break single-instance invariants
          // for react/react-dom.
          if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
            if (isExternal(args.path)) return { external: true };
          }
          // 3. Absolute paths
          if (args.path.startsWith('/')) {
            const resolved = tryResolve(args.path);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
          }
          // 4. Relative paths
          if (args.path.startsWith('.') && args.resolveDir) {
            const dir = strip(args.resolveDir);
            const resolved = tryResolve(dir + '/' + args.path);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
          }
          // 5. Bare specifier (npm package)
          if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
            const fromDir = args.resolveDir || '/home/user';
            // Per Node spec: `require()` triggers the 'require' condition,
            // `import` triggers 'import'. esbuild surfaces this via
            // args.kind. Without this, packages that ship a dual-export
            // CJS file alongside a bare ESM file (e.g. @babel/runtime/
            // helpers/*) get resolved to the ESM variant for CJS callers,
            // and the `__toCommonJS` wrapper surfaces `{ default: fn }`
            // to a callsite that expects the function directly — runtime
            // crash with "<helper>2 is not a function" on the first
            // route that uses the affected package.
            const conditions = args.kind === 'require-call' || args.kind === 'require-resolve'
              ? CJS_CONDITIONS
              : ESM_CONDITIONS;
            const resolved = resolveBarePkg(args.path, fromDir, conditions);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
            // Mark as external if not found (common for Node built-ins)
            return { external: true };
          }
          return { external: true };
        });

        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs' }, (args) => {
          const stripped = strip(args.path);
          try {
            const loader = inferLoader(args.path);
            const lastSlash = stripped.lastIndexOf('/');
            const resolveDir = lastSlash > 0 ? '/' + stripped.substring(0, lastSlash) : '/';
            // Binary loaders (wasm, native addons) must receive raw bytes.
            // TextDecoder would corrupt them with U+FFFD replacement chars.
            if (loader === 'binary') {
              const bytes = vfs.readFile(stripped);
              return { contents: bytes, loader, resolveDir };
            }
            const contents = vfs.readFileString(stripped);
            return { contents, loader, resolveDir };
          } catch {
            return { errors: [{ text: 'File not found in VFS: ' + args.path }] };
          }
        });
      },
    };
  }

  get isInitialized() { return this.initialized; }
}
