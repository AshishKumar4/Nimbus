// The runtime-code interpreter built from core src (packages/worker/scripts/
// interpreter-bundle.mjs, as staged for a node launch's map), written as two
// CommonJS files a node process loads, and the routing the guest shims
// install: each Function constructor answers a code-generation refusal with
// the interpreter. Tests run them under `node
// --disallow-code-generation-from-strings`, which refuses string code
// generation exactly as a Worker does at request time.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleInterpreter } from '../../../packages/worker/scripts/interpreter-bundle.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Build the interpreter and its host module into a fresh directory under TMPDIR. */
export async function buildInterpreterFiles() {
  const { interpreter, ops } = await bundleInterpreter({ start: join(REPO, 'packages/worker') });
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-interpreter-'));
  const interpreterFile = join(dir, 'interpreter.cjs');
  const opsFile = join(dir, 'interpreter-ops.cjs');
  writeFileSync(interpreterFile, interpreter);
  writeFileSync(opsFile, ops);
  return { dir, interpreterFile, opsFile };
}

/**
 * Source of a function `(interp) => void` that routes the realm's Function
 * constructors' refusals to `interp`, as node-shims does with the runtime-code
 * service. Evaluated in the realm it routes (a vm context, or the main realm).
 */
export const ROUTE_FUNCTION_CONSTRUCTORS = `(function (interp) {
  const kinds = [
    ['function', Function],
    ['async', Object.getPrototypeOf(async function () {}).constructor],
    ['generator', Object.getPrototypeOf(function* () {}).constructor],
    ['asyncGenerator', Object.getPrototypeOf(async function* () {}).constructor],
  ];
  for (const [kind, Native] of kinds) {
    const routed = function (...args) {
      try {
        return new.target === undefined ? Reflect.apply(Native, undefined, args) : Reflect.construct(Native, args, new.target);
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        const fn = interp.compileFunction(kind, args.slice(0, -1).map(String), args.length ? String(args[args.length - 1]) : '');
        if (new.target !== undefined && new.target !== routed) Object.setPrototypeOf(fn, new.target.prototype);
        return fn;
      }
    };
    Object.defineProperty(routed, 'name', { value: Native.name });
    Object.defineProperty(routed, 'length', { value: Native.length });
    Object.defineProperty(routed, 'prototype', { value: Native.prototype, writable: false });
    Object.setPrototypeOf(routed, Object.getPrototypeOf(Native));
    Object.defineProperty(Native.prototype, 'constructor', { value: routed, writable: true, configurable: true, enumerable: false });
    if (kind === 'function') globalThis.Function = routed;
  }
})`;

/** Write `source` as a file in `dir`, for a node child process to run. */
export function writeScript(dir, name, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
}
