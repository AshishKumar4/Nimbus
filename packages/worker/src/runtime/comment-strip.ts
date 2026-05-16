/**
 * Minimal byte-aligned comment stripper for prefetch's import detection.
 *
 * Scope: strip `//` line comments and `/* … *\/` block comments by
 * replacing each comment with a single space. Newlines INSIDE the
 * comment are preserved so that line numbers stay aligned with the
 * input (matches the strip-and-classify pattern used by
 * `esbuild-service.ts:stripCommentsAndStrings` for the transform
 * pipeline).
 *
 * Why a separate, smaller scanner: prefetch's IMPORT_RE / REQUIRE_RE
 * in `require-resolver.ts:41,87` are detection-only — they extract
 * specifier strings, not shapes. The full string-and-template-literal
 * stripper in `esbuild-service.ts` is overkill for that, and crossing
 * the anti-touch boundary on `esbuild-service.ts` to extend a single
 * shared helper isn't worth it right now.
 *
 * Empirical justification (esbuild-ast-rewrite wave, P2 measurement):
 *   - Per-file AST-based extraction: ~5 ms warm avg
 *   - 100-file session bootstrap with AST: ~553 ms (over the 500 ms gate)
 *   - Regex with this stripper: ~0.1 ms per file
 *   - Correctness gap closed: chalk `import { // eslint-disable\n   a,\n   b\n} from './utilities.js'` now matches
 *
 * String-literal handling is intentionally OUT of scope. A literal
 * `import x from 'y'` inside a JavaScript string would still produce
 * a false-positive prefetch attempt. The resolver no-ops on misses,
 * so it's a minor wasted-work cost — see IMPORT_RE header comment in
 * `require-resolver.ts:84-86`.
 *
 * TODO(CLN-X): when the `src/runtime/esbuild-service.ts` anti-touch
 * window opens, unify with the canonical
 * `stripCommentsAndStrings(src)` helper there. Both implement the
 * same logical pass over comments; only the string/regex-literal
 * handling differs.
 */
export function stripCommentsForImports(src: string): string {
  let out = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    const c = src[i];
    // Line comment: `//` to end-of-line.
    if (c === '/' && src[i + 1] === '/') {
      out += ' ';
      i += 2;
      while (i < N && src[i] !== '\n') i++;
      // Newline preserved by falling through; do NOT consume it.
      continue;
    }
    // Block comment: `/*` to `*/`.
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < N) {
        if (src[i] === '\n') {
          // Preserve newlines so line numbers stay aligned.
          out += '\n';
          i++;
          continue;
        }
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          out += ' ';
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
