/**
 * modules.ts — an ES module the interpreter evaluates (one a program produced
 * after its launch began, or a staged one the registry could not evaluate
 * with Node's semantics: node-shims' adoption), as Node's CommonJS wrapper
 * function, linked as runtime/esm-interop.ts says. Its imports are calls of
 * the require it is given, told each is an import (ESM_LOAD_HELPER), which
 * the loader resolves, checks and links as Node's ESM loader does, giving
 * each module's namespace; its exports are the getters of module.exports.
 * compile.ts makes the plan (Compiler.modulePlan); this runs it, with the
 * helpers the launch compiled from esm-interop.ts's text (InterpreterHost).
 */
import type { Code } from './code.js';
import { SafeWeakMap, promiseReject, reflectApply, resume, resumeThrowing, withElement } from './intrinsics.js';
import type { HostOperators, NativeFunction } from './host-ops.js';
import { type Env, ROOT_ENV } from './runtime.js';
import { type StackInfo, initializeStack, popStack, pushStack, stampStack, suspendedStack } from './stack.js';

/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;

/**
 * An ES module cell's ExecuteModule, once it is linked: its body, answering
 * undefined, or (top-level await) the promise of its completion.
 */
export type ModuleExecution = () => unknown;

/**
 * An ES module cell's InitializeEnvironment (runtime/esm-graph.ts): its
 * frame made, its function declarations hoisted, its exports published, its
 * imports bound (each request through the require it is given) and its
 * `export *`s copied, none of its body run; answers its ExecuteModule.
 */
export type ModuleLink = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => ModuleExecution;

/** Each ES module cell's link, by the cell. */
const links = new SafeWeakMap<ModuleCell, ModuleLink>();

/** The link of `cell`, an ES module's cell; null for any other. */
export function moduleLink(cell: ModuleCell): ModuleLink | null {
  return links.get(cell) ?? null;
}

/** esm-interop.ts's helpers, compiled from their text (ESM_MODULE_HELPERS). */
export interface ModuleHelpers {
  readonly exports: NativeFunction;
  readonly star: NativeFunction;
  readonly conflicts: NativeFunction;
  readonly load: NativeFunction;
}

/** An export's getter: `read` of the evaluation's frame. */
export interface ModuleExport {
  readonly name: string;
  readonly read: (env: Env) => unknown;
}

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
   * (which the loader checks): the slot its namespace goes to, -1 for none.
   */
  readonly requests: readonly { readonly source: string; readonly type: string | null; readonly module: number }[];
  /** Slots of the modules whose names `export *` copies. */
  readonly stars: readonly number[];
  /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
  readonly instantiate: ((env: Env) => Env) | null;
  /** The module's statements, as an async function body (top-level await). */
  readonly body: Code;
}

/**
 * The wrapper function that runs `plan`: its link, then its execution, as
 * one call (a module whose body suspends rejecting for a failure linking
 * it, rather than throwing); its link alone is moduleLink's.
 */
export function moduleCell(plan: ModulePlan, ops: HostOperators, helpers: ModuleHelpers): ModuleCell {
  const { frame, exportsSlot, requireSlot, moduleSlot, filenameSlot, dirnameSlot, instantiate, body } = plan;
  const bs = body.s;
  const bg = body.g;
  const linkModule: ModuleLink = (exportsArg, requireArg, moduleArg, filename, dirname) => {
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
    const previous = pushStack(env);
    try {
      link(plan, env, requireArg, helpers, exportsObject, define);
    } catch (error) {
      stampStack(error);
      throw error;
    } finally { popStack(previous); }
    if (bg !== null) return () => drive(env, bg);
    return () => {
      const before = pushStack(env);
      try {
        bs(env);
        return undefined;
      } catch (error) {
        stampStack(error);
        throw error;
      } finally { popStack(before); }
    };
  };
  const cell: ModuleCell = (exportsArg, requireArg, moduleArg, filename, dirname) => {
    if (bg === null) return linkModule(exportsArg, requireArg, moduleArg, filename, dirname)();
    let execute: ModuleExecution;
    try {
      execute = linkModule(exportsArg, requireArg, moduleArg, filename, dirname);
    } catch (error) {
      return promiseReject(error);
    }
    return execute();
  };
  links.set(cell, linkModule);
  return cell;
}

/**
 * The export getters installed; each request required in order, its
 * namespace in its slot; then `export *`, but the names two of them reach
 * different bindings of (the loader's answer). Its graph's names were
 * checked before any of it ran, by whoever loads it (node-shims' late link
 * plan).
 */
function link(plan: ModulePlan, env: Env, requireArg: unknown, helpers: ModuleHelpers, exportsObject: unknown, define: NativeFunction): void {
  const { exports, requests, stars } = plan;
  for (let i = 0; i < exports.length; i++) {
    const read = exports[i].read;
    reflectApply(define, undefined, [exports[i].name, () => read(env)]);
  }
  for (let i = 0; i < requests.length; i++) {
    const { source, type, module } = requests[i];
    const m: unknown = reflectApply(helpers.load, undefined, [requireArg, source, type]);
    if (module >= 0) env[module] = m;
  }
  if (stars.length === 0) return;
  const omitted: unknown = reflectApply(helpers.conflicts, undefined, [requireArg]);
  for (let i = 0; i < stars.length; i++) reflectApply(helpers.star, undefined, [exportsObject, define, env[stars[i]], omitted]);
}

/** Runs a module body's generator, made by `start` of its frame, as an async function would: one await per yielded value. */
async function drive(env: Env, start: (env: Env) => Generator<unknown, unknown, unknown>): Promise<unknown> {
  let it: Generator<unknown, unknown, unknown>;
  let r: IteratorResult<unknown, unknown>;
  let previous = pushStack(env);
  try {
    it = start(env);
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
