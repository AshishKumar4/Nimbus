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
 * With `guarded`, a read that cannot throw for want of a binding is not free:
 * `typeof name` itself, and a read only where a `typeof name` test says the
 * name is there, by the test's sense: the branch of an `if` or conditional,
 * or the right of `&&` or `||`, that runs only when the test holds
 * (`typeof name !== "undefined"`, `typeof name === "function"`, either
 * negated, joined by `&&` or `||`). A name some code puts on globalThis is
 * not a binding: the read may run first, or the install not at all.
 *
 * @param {string} source
 * @param {{ sourceType?: 'script' | 'module', guarded?: boolean }} [options]
 * @returns {Set<string>}
 */
export function freeNames(source, { sourceType = 'script', guarded = false } = {}) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  if (!isNode(program)) throw new Error('free-names: acorn gave no program');
  const ranges = guarded ? typeofGuards(program) : new Map();
  const covered = (name, at) => (ranges.get(name) ?? []).some(([start, end]) => at >= start && at < end);
  const free = new Set();
  for (const [node, scope, parent, key] of scoped(program, { names: new Set(), parent: null }, isSloppy(program))) {
    if (node.type !== 'Identifier' || parent === null || !namesBinding(parent, key)) continue;
    const name = stringOf(node, 'name');
    if (name === null || bindingScope(scope, name) !== null) continue;
    if (guarded && ((parent.type === 'UnaryExpression' && parent.operator === 'typeof') || covered(name, node.start))) continue;
    free.add(name);
  }
  return free;
}

/** For each name, the source ranges that run only when a `typeof` test of it said it is there. */
function typeofGuards(program) {
  const ranges = new Map();
  const guard = (names, node) => {
    for (const name of names) ranges.set(name, [...(ranges.get(name) ?? []), [node.start, node.end]]);
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
      guard(boundWhen(node.test, true), node.consequent);
      if (node.alternate) guard(boundWhen(node.test, false), node.alternate);
    } else if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
      guard(boundWhen(node.left, node.operator === '&&'), node.right);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(program);
  return ranges;
}

/** The names `test` says are there when it evaluates to `sense` (truthy when true). */
function boundWhen(test, sense) {
  if (!test || typeof test !== 'object') return [];
  if (test.type === 'UnaryExpression' && test.operator === '!') return boundWhen(test.argument, !sense);
  if (test.type === 'LogicalExpression') {
    // `a && b` true: both are; `a || b` false: neither is. Otherwise either may be what decided it.
    if (test.operator === '&&' && sense) return [...boundWhen(test.left, true), ...boundWhen(test.right, true)];
    if (test.operator === '||' && !sense) return [...boundWhen(test.left, false), ...boundWhen(test.right, false)];
    return [];
  }
  if (test.type !== 'BinaryExpression' || !['===', '==', '!==', '!='].includes(test.operator)) return [];
  const typeofOf = (node) => (node?.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument?.type === 'Identifier' ? node.argument.name : null);
  const textOf = (node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null);
  const name = typeofOf(test.left) ?? typeofOf(test.right);
  const text = typeofOf(test.left) !== null ? textOf(test.right) : textOf(test.left);
  if (name === null || text === null) return [];
  // Whether `typeof name === text` holds when the test is `sense`.
  const equal = (test.operator === '===' || test.operator === '==') === sense;
  return equal === (text !== 'undefined') ? [name] : [];
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
  'setInterval', 'clearInterval', 'WebAssembly', 'EventTarget', 'Event', 'MessageEvent',
  'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'Buffer',
]);
