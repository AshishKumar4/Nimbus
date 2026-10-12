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
 * With `guarded`, a name is not free where reading it cannot throw or is the
 * source's own: read only as `typeof name`, or inside a test, conditional or
 * `&&` whose test asks `typeof name` (an input only some embedders give), or
 * installed by the source on globalThis (`globalThis.name = …`,
 * `Object.defineProperty(globalThis, "name", …)`,
 * `Object.defineProperties(globalThis, { name: … })`).
 *
 * @param {string} source
 * @param {{ sourceType?: 'script' | 'module', guarded?: boolean }} [options]
 * @returns {Set<string>}
 */
export function freeNames(source, { sourceType = 'script', guarded = false } = {}) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
  if (!isNode(program)) throw new Error('free-names: acorn gave no program');
  const { ranges, installed } = guarded ? guardsOf(program) : { ranges: new Map(), installed: new Set() };
  const covered = (name, at) => (ranges.get(name) ?? []).some(([start, end]) => at >= start && at < end);
  const free = new Set();
  for (const [node, scope, parent, key] of scoped(program, { names: new Set(), parent: null }, isSloppy(program))) {
    if (node.type !== 'Identifier' || parent === null || !namesBinding(parent, key)) continue;
    const name = stringOf(node, 'name');
    if (name === null || bindingScope(scope, name) !== null) continue;
    if (guarded && (installed.has(name) || (parent.type === 'UnaryExpression' && parent.operator === 'typeof') || covered(name, node.start))) continue;
    free.add(name);
  }
  return free;
}

/** Where each name is read under a `typeof` test of it, and the names the program installs on globalThis. */
function guardsOf(program) {
  const ranges = new Map();
  const installed = new Set();
  const typeofNames = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument?.type === 'Identifier') out.push(node.argument.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) typeofNames(item, out);
      else if (value && typeof value === 'object' && typeof value.type === 'string') typeofNames(value, out);
    }
    return out;
  };
  const isGlobalThis = (node) => node?.type === 'Identifier' && node.name === 'globalThis';
  const keyName = (node, computed) => (!computed && node?.type === 'Identifier' ? node.name : node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const test = node.type === 'IfStatement' || node.type === 'ConditionalExpression' ? node.test
      : node.type === 'LogicalExpression' && node.operator === '&&' ? node.left : null;
    if (test) for (const name of typeofNames(test)) ranges.set(name, [...(ranges.get(name) ?? []), [node.start, node.end]]);
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' && isGlobalThis(node.left.object)) {
      const name = keyName(node.left.property, node.left.computed);
      if (name !== null) installed.add(name);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier'
      && node.callee.object.name === 'Object' && isGlobalThis(node.arguments?.[0])) {
      const method = keyName(node.callee.property, node.callee.computed);
      if (method === 'defineProperty') {
        const name = keyName(node.arguments[1], true);
        if (name !== null) installed.add(name);
      } else if (method === 'defineProperties' && node.arguments[1]?.type === 'ObjectExpression') {
        for (const prop of node.arguments[1].properties) {
          const name = prop.type === 'Property' ? keyName(prop.key, prop.computed) : null;
          if (name !== null) installed.add(name);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(program);
  return { ranges, installed };
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
