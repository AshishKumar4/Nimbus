/**
 * modules.ts — an ES module the interpreter evaluates (one a program produced
 * after its launch began, or a staged one the registry could not evaluate
 * with Node's semantics: node-shims' adoption), as Node's CommonJS wrapper
 * function, linked as runtime/esm-interop.ts says. Its imports are calls of
 * the require it is given, told each is an import (ESM_LOAD_HELPER), which
 * the loader resolves as Node's ESM loader does,
 * and its exports the getters of module.exports. compile.ts makes the plan
 * (Compiler.modulePlan); this runs it, with the interop helpers the launch
 * compiled from esm-interop.ts's text (InterpreterHost).
 */
import type { Code } from './code.js';
import { SafeWeakSet, SyntaxError, reflectApply, reflectHas, resume, resumeThrowing, withElement } from './intrinsics.js';
import type { HostOperators, NativeFunction } from './host-ops.js';
import { type Env, ROOT_ENV, TDZ, tdzError } from './runtime.js';
import { type StackInfo, initializeStack, popStack, pushStack, stampStack, suspendedStack } from './stack.js';

/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;

/** esm-interop.ts's helpers, compiled from their text (ESM_MODULE_HELPERS). */
export interface ModuleHelpers {
  readonly exports: NativeFunction;
  readonly interop: NativeFunction;
  readonly namespace: NativeFunction;
  readonly star: NativeFunction;
  readonly load: NativeFunction;
}

/**
 * What an export's getter reads: its value from the evaluation's frame, or a
 * re-exported namespace (`export * as`), made into `slot` from the module in
 * `from` when first read.
 */
export type ModuleExport =
  | { readonly kind: 'read'; readonly name: string; readonly read: (env: Env) => unknown }
  | { readonly kind: 'namespace'; readonly name: string; readonly slot: number; readonly from: number };

/** A module, compiled. */
export interface ModulePlan {
  readonly stack: StackInfo;
  /** The module scope's frame (runtime.ts frameTemplate). */
  readonly frame: Env;
  /** Slots of the wrapper's arguments. */
  readonly exportsSlot: number;
  readonly requireSlot: number;
  readonly moduleSlot: number;
  readonly filenameSlot: number;
  readonly dirnameSlot: number;
  /** The export getters, in the order they are installed. */
  readonly exports: readonly ModuleExport[];
  /**
   * Each requested module, required in order with its `type` attribute
   * (which the loader checks): the slot it goes to, and its interop's (a
   * default import's), -1 for none; and the names its imports and re-exports
   * read of it (esm-interop.ts ModuleBindings).
   */
  readonly requests: readonly {
    readonly source: string;
    readonly type: string | null;
    readonly module: number;
    readonly interop: number;
    readonly names: readonly string[];
  }[];
  /** Each import's namespace, made into `slot` from the module in `from` once every request is required. */
  readonly namespaces: readonly { readonly slot: number; readonly from: number }[];
  /** Slots of the modules whose names `export *` copies. */
  readonly stars: readonly number[];
  /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
  readonly instantiate: ((env: Env) => Env) | null;
  /** The module's statements, as an async function body (top-level await). */
  readonly body: Code;
}

/** The wrapper function that runs `plan`. */
export function moduleCell(plan: ModulePlan, ops: HostOperators, helpers: ModuleHelpers): ModuleCell {
  const { frame, exportsSlot, requireSlot, moduleSlot, filenameSlot, dirnameSlot, instantiate, body } = plan;
  const bs = body.s;
  const bg = body.g;
  return (exportsArg, requireArg, moduleArg, filename, dirname) => {
    const env = withElement(frame, 0, ROOT_ENV);
    env[exportsSlot] = exportsArg;
    env[requireSlot] = requireArg;
    env[moduleSlot] = moduleArg;
    env[filenameSlot] = filename;
    env[dirnameSlot] = dirname;
    initializeStack(env, plan.stack, undefined, undefined, false);
    const exportsObject: unknown = ops.get(moduleArg, 'exports');
    const define = reflectApply(helpers.exports, undefined, [exportsObject]) as NativeFunction;
    // Instantiation, before any import is evaluated: an import that
    // imports this module back (a cycle) finds its function declarations
    // made, as a module's linking provides, and its exports published (link).
    if (instantiate !== null) instantiate(env);
    // The module is linked where the body runs: a module that suspends
    // (top-level await) rejects for a failure linking it, rather than
    // throwing.
    if (bg === null) {
      const previous = pushStack(env);
      try {
        link(plan, env, requireArg, helpers, exportsObject, define);
        bs(env);
        return undefined;
      } catch (error) {
        stampStack(error);
        throw error;
      } finally { popStack(previous); }
    }
    return drive(env, () => {
      link(plan, env, requireArg, helpers, exportsObject, define);
      return bg(env);
    });
  };
}

/** The exports objects of the modules whose link has finished: every name they export is there, `export *`'s too. */
const linked = new SafeWeakSet<object>();

/**
 * The export getters installed; each request required in order, its interop
 * made; then the import namespaces, then `export *`. Then, before the body
 * runs, each name read of an ES module is checked to be one it exports, as
 * Node's linker checks it: a registry's namespace, or a module this
 * interpreter linked. One still linking (a cycle) is not yet complete, and a
 * CommonJS module's names are its source's (cjs-module-lexer's), not its
 * exports object's; neither is checked here.
 */
function link(plan: ModulePlan, env: Env, requireArg: unknown, helpers: ModuleHelpers, exportsObject: unknown, define: NativeFunction): void {
  const { exports, requests, namespaces, stars } = plan;
  for (let i = 0; i < exports.length; i++) reflectApply(define, undefined, [exports[i].name, exportGetter(env, exports[i], helpers)]);
  for (let i = 0; i < requests.length; i++) {
    const { source, type, module, interop } = requests[i];
    const m: unknown = reflectApply(helpers.load, undefined, [requireArg, source, type]);
    if (module >= 0) env[module] = m;
    if (interop >= 0) env[interop] = reflectApply(helpers.interop, undefined, [m]);
  }
  for (let i = 0; i < namespaces.length; i++) env[namespaces[i].slot] = reflectApply(helpers.namespace, undefined, [env[namespaces[i].from]]);
  for (let i = 0; i < stars.length; i++) reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]]]);
  if (typeof exportsObject === 'object' && exportsObject !== null) linked.add(exportsObject);
  for (let i = 0; i < requests.length; i++) {
    const { source, module, names } = requests[i];
    if (module < 0 || names.length === 0) continue;
    const m: unknown = env[module];
    if (reflectApply(helpers.interop, undefined, [m]) !== m || typeof m !== 'object' || m === null) continue;
    if (!linked.has(m) && reflectHas(m, '__esModule')) continue;
    for (let j = 0; j < names.length; j++) {
      if (!reflectHas(m, names[j])) throw new SyntaxError(`The requested module '${source}' does not provide an export named '${names[j]}'`);
    }
  }
}

/** The getter of `entry` over one evaluation's frame. */
function exportGetter(env: Env, entry: ModuleExport, helpers: ModuleHelpers): () => unknown {
  if (entry.kind === 'read') {
    const read = entry.read;
    return () => read(env);
  }
  const { name, slot, from } = entry;
  return () => {
    if (env[slot] === undefined) {
      if (env[from] === TDZ) throw tdzError(name);
      env[slot] = reflectApply(helpers.namespace, undefined, [env[from]]);
    }
    return env[slot];
  };
}

/** Runs a module body's generator, made by `start`, as an async function would: one await per yielded value. */
async function drive(env: Env, start: () => Generator<unknown, unknown, unknown>): Promise<unknown> {
  let it: Generator<unknown, unknown, unknown>;
  let r: IteratorResult<unknown, unknown>;
  let previous = pushStack(env);
  try {
    it = start();
    r = resume(it, undefined);
  } catch (error) {
    stampStack(error);
    throw error;
  } finally { suspendedStack(env); popStack(previous); }
  while (!r.done) {
    let value: unknown;
    let ok = true;
    try {
      value = await r.value;
    } catch (error) {
      ok = false;
      value = error;
    }
    previous = pushStack(env);
    try { r = ok ? resume(it, value) : resumeThrowing(it, value); }
    catch (error) { stampStack(error); throw error; }
    finally { suspendedStack(env); popStack(previous); }
  }
  return undefined;
}
