/**
 * free-names.mjs — the names a script reads that nothing in it declares: the
 * globals it needs from wherever it is evaluated, as the one scope model
 * (@nimbus-sh/core runtime/javascript-scope.ts) resolves them. A bundle
 * spliced into a facet module (scripts/bundle-facet-workers.mjs), and the
 * facet module it is spliced into, may reach only what that module imports
 * and declares and the globals every facet has; anything else is a
 * ReferenceError inside the facet, which no typecheck sees.
 */
import { parse } from 'acorn';
import { bindingScope, isNode, isSloppy, namesBinding, scoped, stringOf } from '@nimbus-sh/core/runtime/javascript-scope.js';

/**
 * The free names of `source`, a script (or, with `sourceType: 'module'`, a module).
 *
 * @param {string} source
 * @param {{ sourceType?: 'script' | 'module' }} [options]
 * @returns {Set<string>}
 */
export function freeNames(source, { sourceType = 'script' } = {}) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  if (!isNode(program)) throw new Error('free-names: acorn gave no program');
  const free = new Set();
  for (const [node, scope, parent, key] of scoped(program, { names: new Set(), parent: null }, isSloppy(program))) {
    if (node.type !== 'Identifier' || parent === null || !namesBinding(parent, key)) continue;
    const name = stringOf(node, 'name');
    if (name !== null && bindingScope(scope, name) === null) free.add(name);
  }
  return free;
}

/** What every facet module has in scope without importing it: ECMAScript's globals and the Workers runtime's (nodejs_compat's `process` among them). */
export const FACET_GLOBALS = new Set([
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Math', 'JSON', 'Reflect', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'RegExp', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'console', 'queueMicrotask', 'setTimeout', 'clearTimeout',
  'structuredClone', 'atob', 'btoa', 'performance', 'process', 'fetch', 'Request', 'Response', 'Headers',
  'AbortController', 'AbortSignal', 'ReadableStream', 'WritableStream', 'TransformStream', 'crypto', 'caches',
  'DOMException', 'Blob', 'FormData', 'TextDecoderStream', 'TextEncoderStream', 'CompressionStream', 'DecompressionStream',
]);
