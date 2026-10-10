/**
 * modules.ts — an ES module as a launch's map runs one: Node's CommonJS
 * wrapper function, linked as runtime/esm-interop.ts says, the way the next
 * launch's cell (async-module-lowering.ts) links the same text. Its imports
 * are requires and its exports the getters of module.exports. compile.ts
 * makes the plan (Compiler.modulePlan); this runs it, with the interop
 * helpers the launch compiled from esm-interop.ts's text (InterpreterHost).
 */
import type { Code } from './code.js';
import { reflectApply, resume, resumeThrowing, withElement } from './intrinsics.js';
import type { HostOperators, NativeFunction } from './host-ops.js';
import { type Env, ROOT_ENV, TDZ, tdzError } from './runtime.js';

/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;

/** esm-interop.ts's helpers, compiled from their text (ESM_MODULE_HELPERS). */
export interface ModuleHelpers {
  readonly exports: NativeFunction;
  readonly interop: NativeFunction;
  readonly namespace: NativeFunction;
  readonly star: NativeFunction;
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
  /** Each requested module, required in order: the slot it goes to, and its interop's (a default import's); -1 for none. */
  readonly requests: readonly { readonly source: string; readonly module: number; readonly interop: number }[];
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
    // A cell's module is always an ES module's: the next launch lowers
    // esModuleSource's text, which declares an export.
    const exportsObject: unknown = ops.get(moduleArg, 'exports');
    const define = reflectApply(helpers.exports, undefined, [exportsObject]) as NativeFunction;
    // Instantiation, before any import is evaluated: an import that
    // imports this module back (a cycle) finds its function declarations
    // made, as a module's linking provides, and its exports published (link).
    if (instantiate !== null) instantiate(env);
    // The module is linked where the body runs: a module that suspends
    // (top-level await) rejects for a failure linking it, as its lowered
    // cell's async body does, rather than throwing.
    if (bg === null) {
      link(plan, env, requireArg, helpers, exportsObject, define);
      bs(env);
      return undefined;
    }
    return drive(() => {
      link(plan, env, requireArg, helpers, exportsObject, define);
      return bg(env);
    });
  };
}

/** The export getters installed; each request required in order, its interop made; then the import namespaces, then `export *`. */
function link(plan: ModulePlan, env: Env, requireArg: unknown, helpers: ModuleHelpers, exportsObject: unknown, define: NativeFunction): void {
  const { exports, requests, namespaces, stars } = plan;
  for (let i = 0; i < exports.length; i++) reflectApply(define, undefined, [exports[i].name, exportGetter(env, exports[i], helpers)]);
  for (let i = 0; i < requests.length; i++) {
    const { source, module, interop } = requests[i];
    const m: unknown = reflectApply(requireArg as NativeFunction, undefined, [source]);
    if (module >= 0) env[module] = m;
    if (interop >= 0) env[interop] = reflectApply(helpers.interop, undefined, [m]);
  }
  for (let i = 0; i < namespaces.length; i++) env[namespaces[i].slot] = reflectApply(helpers.namespace, undefined, [env[namespaces[i].from]]);
  for (let i = 0; i < stars.length; i++) reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]]]);
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
async function drive(start: () => Generator<unknown, unknown, unknown>): Promise<unknown> {
  const it = start();
  let r = resume(it, undefined);
  while (!r.done) {
    let value: unknown;
    let ok = true;
    try {
      value = await r.value;
    } catch (error) {
      ok = false;
      value = error;
    }
    r = ok ? resume(it, value) : resumeThrowing(it, value);
  }
  return undefined;
}
