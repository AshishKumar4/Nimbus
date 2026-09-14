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
 * Memory: the output is assembled from slices of the input — one per
 * comment-free span — and joined once. It used to be built one character
 * at a time with `out += c`, which every JS engine represents as a rope
 * of one node per append: ~30 bytes of heap per character of output, all
 * of it live until the string is first read. The require walk runs this
 * over every file in the closure, and on typescript's 6.15 MB `lib/_tsc.js`
 * that rope measured 174 MB (V8) / 172 MB (JSC) against a 128 MB isolate —
 * the session Durable Object was killed inside `tsc`'s spawn before the
 * facet existed. A span-sliced build holds the input, the output and a
 * short array of slices, and nothing else.
 *
 * TODO(CLN-X): when the `src/runtime/esbuild-service.ts` anti-touch
 * window opens, unify with the canonical
 * `stripCommentsAndStrings(src)` helper there. Both implement the
 * same logical pass over comments; only the string/regex-literal
 * handling differs.
 */
const SLASH = 0x2f;
const STAR = 0x2a;
const NEWLINE = 0x0a;

export function stripCommentsForImports(src: string): string {
  const N = src.length;
  const parts: string[] = [];
  // Start of the comment-free span not yet copied to `parts`.
  let spanStart = 0;
  let i = 0;
  while (i < N) {
    if (src.charCodeAt(i) !== SLASH) { i++; continue; }
    const next = src.charCodeAt(i + 1);
    // Line comment: `//` to end-of-line, replaced by one space. The
    // newline is not part of the comment and stays in the next span.
    if (next === SLASH) {
      parts.push(src.slice(spanStart, i), ' ');
      i += 2;
      while (i < N && src.charCodeAt(i) !== NEWLINE) i++;
      spanStart = i;
      continue;
    }
    // Block comment: `/*` to `*/`, replaced by its own newlines (so line
    // numbers stay aligned) and one space. An unterminated one runs to
    // the end of input and gets no closing space.
    if (next === STAR) {
      parts.push(src.slice(spanStart, i));
      i += 2;
      let newlines = 0;
      let closed = false;
      while (i < N) {
        const c = src.charCodeAt(i);
        if (c === NEWLINE) newlines++;
        else if (c === STAR && src.charCodeAt(i + 1) === SLASH) { i += 2; closed = true; break; }
        i++;
      }
      if (newlines > 0) parts.push('\n'.repeat(newlines));
      if (closed) parts.push(' ');
      spanStart = i;
      continue;
    }
    i++;
  }
  parts.push(src.slice(spanStart));
  return parts.join('');
}
