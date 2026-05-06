// X.5-M3 functional probe helper. Loads the generated runner.js source so
// probes can do source-text + targeted IIFE-extraction assertions.

import { generateShimsCode } from '../../../../src/node-shims.ts';

export function getShimSource() {
  return generateShimsCode();
}

/**
 * Locate the M-3 URL-wrap IIFE and evaluate it against a stub globalThis.
 * Stub.__currentModulePath is honored if set BEFORE the constructor call.
 *
 * Returns:
 *   { wrapped: <constructor>, stub: <object> } on success,
 *   null if marker absent (pre-fix red state).
 */
export function loadWrappedURL() {
  const src = getShimSource();
  const marker = '// X.5-M (M-3): lenient URL constructor';
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const iifeStart = src.indexOf('(() =>', idx);
  if (iifeStart < 0) return null;
  const openBrace = src.indexOf('{', iifeStart);
  if (openBrace < 0) return null;
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === ')') i++;
  if (src[i] === '(') i++;
  if (src[i] === ')') i++;
  if (src[i] === ';') i++;
  const iifeSrc = src.slice(iifeStart, i);

  const stub = { URL: globalThis.URL, __currentModulePath: undefined };
  const fn = new Function('globalThis', `${iifeSrc}; return globalThis.URL;`);
  const wrapped = fn(stub);
  return { wrapped, stub };
}
