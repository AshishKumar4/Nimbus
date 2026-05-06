// Helper: returns the generated shim JS source, plus a few cooked accessors
// for grep-style assertions used by functional probes.
//
// The shim code is a heavy template that references many runner-side globals
// (__supervisor, __ws, etc.) so we can't directly eval it as a Function. The
// functional probes therefore work by: (a) source-text presence/structure
// assertions, (b) targeted IIFE extraction where feasible.

import { generateShimsCode } from '../../../../src/node-shims.ts';

export function getShimSource() {
  return generateShimsCode();
}

/**
 * Locate a class declaration block by name in the shim source. Returns the
 * block's source (from `class Name extends X {` to the matching close-brace).
 * Used to introspect e.g. http.Server class for setTimeout method.
 */
export function extractClass(source, className) {
  const re = new RegExp(`class\\s+${className}\\s+extends[\\s\\S]+?{`);
  const m = source.match(re);
  if (!m) return null;
  const start = m.index;
  let depth = 0, i = m.index;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i);
}

/**
 * Test the M-3 lenient URL guard by isolating the URL-wrap IIFE and evaluating
 * it in a fresh function scope. This works because the IIFE only references
 * globalThis.URL (no other shim locals).
 *
 * Returns the wrapped URL constructor, or null if no guard is present.
 */
export function loadWrappedURL() {
  // Search for the marker comment that delimits the M-3 fix.
  const src = getShimSource();
  // Look for an IIFE that does globalThis.URL = <Class>; and assigns __urlMod.URL
  // post-mutation. If absent, return null (red signal).
  const marker = '// X.5-M (M-3): lenient URL constructor';
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  // Extract from the marker through the next blank line + the __urlMod assignment.
  // Build a small standalone test: evaluate the IIFE block over a synthetic
  // globalThis with URL = native URL.
  const iifeStart = src.indexOf('(() =>', idx);
  if (iifeStart < 0) return null;
  // The IIFE pattern is `(() => { ... })();` — the body is enclosed in { ... }
  // (curly braces). After the matching close-curly, expect `)();`. Scan curly
  // depth until we find a `}` that returns depth to 0, then consume the
  // closing `)`, opening `(`, closing `)`, and trailing `;`.
  // Find first `{` after iifeStart.
  const openBrace = src.indexOf('{', iifeStart);
  if (openBrace < 0) return null;
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // i now points just past the matching `}`. Expect `)();`. Eat them.
  // Skip whitespace.
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === ')') i++;
  if (src[i] === '(') i++;
  if (src[i] === ')') i++;
  if (src[i] === ';') i++;
  const iifeSrc = src.slice(iifeStart, i);

  // Evaluate it. Provide our own globalThis via a Function scope with
  // a stub object whose URL property starts as native URL.
  const stubGlobal = { URL: globalThis.URL };
  const fn = new Function('globalThis', `${iifeSrc}; return globalThis.URL;`);
  return fn(stubGlobal);
}
