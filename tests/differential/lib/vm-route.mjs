// vm.runInThisContext as a node process in a Worker answers it: V8 refuses
// to compile the code at request time, and node-shims
// (packages/worker/src/runtime/node-shims.ts, the vm module's
// runInThisContext) hands code that sets none of the options a function
// cannot honor to the runtime-code service (compileExpression), which the
// interpreter answers with a function returning the script's one
// expression's value. jiti (Nuxt's config loader) evaluates each module it
// transpiles this way, as a CommonJS wrapper expression statement. Node does
// not refuse vm under --disallow-code-generation-from-strings, so the
// differential's preloads route it here.

import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';

/** Whether node-shims hands code run with `options` to the runtime-code service. */
function routed(options) {
  return !(options && (options.timeout !== undefined || options.breakOnSigint || options.importModuleDynamically || options.cachedData));
}

/**
 * Route vm.runInThisContext to `run(code, native)` where node-shims would
 * route it to the service; `native` runs it as node does. Returns `native`.
 */
export function routeRunInThisContext(run) {
  const native = vm.runInThisContext;
  vm.runInThisContext = function runInThisContext(code, options) {
    if (!routed(options)) return Reflect.apply(native, vm, [code, options]);
    return run(String(code), () => Reflect.apply(native, vm, [code, options]));
  };
  syncBuiltinESMExports();
  return native;
}
