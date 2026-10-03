/**
 * modules.ts — an ES module as a launch's map runs one: Node's CommonJS
 * wrapper function, as esbuild lowers a module for the map. Its imports are
 * requires and its exports the getters of one object, module.exports.
 * compile.ts makes the plan (Compiler.modulePlan); this runs it.
 */
import type { Code } from './code.js';
import {
  TypeError, accessorDescriptor, dataDescriptor, defineOrThrow, isEnumerableOwn, objectCreate, objectGetOwnPropertyNames,
  objectGetPrototypeOf, objectHasOwn, reflectApply, reflectGet, resume, resumeThrowing, withElement,
} from './intrinsics.js';
import { type Env, ROOT_ENV, isObject, operators } from './runtime.js';

/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;

/** Where an exported name reads its value. */
export type ExportRead =
  /** A binding of the module, read live (in its TDZ until its declaration runs: a cycle can read it early). */
  | { readonly kind: 'binding'; readonly read: (env: Env) => unknown }
  /** `export { name } from 'm'`: m's export `name`; its `default` is m itself unless m is an ES module. */
  | { readonly kind: 'reexport'; readonly slot: number; readonly name: string }
  /** `export * as name from 'm'`: m's namespace object. */
  | { readonly kind: 'namespace'; readonly slot: number };

/** An import declaration or a re-export's source, required in source order. */
export interface ModuleImport {
  readonly source: string;
  /** The slot the required module is kept in, for a re-export to read; null for an import declaration. */
  readonly slot: number | null;
  /** An import declaration's bindings: the module, or (a namespace import) its namespace object. */
  readonly bindings: readonly { readonly slot: number; readonly namespace: boolean }[];
}

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
  readonly imports: readonly ModuleImport[];
  /** The exported names, in order; the first of a name wins. */
  readonly exports: readonly { readonly name: string; readonly read: ExportRead }[];
  /** Slots of `export * from` modules, whose names join the exports after the imports are evaluated. */
  readonly stars: readonly number[];
  /** Instantiation: the module scope's function declarations made, its lexical bindings in their TDZ. */
  readonly instantiate: ((env: Env) => Env) | null;
  /** The module's statements, as an async function body (top-level await). */
  readonly body: Code;
}

/** The export getter for `read`, over one evaluation's environment. */
function exportGetter(env: Env, read: ExportRead): () => unknown {
  switch (read.kind) {
    case 'binding': {
      const r = read.read;
      return () => r(env);
    }
    case 'reexport': {
      const { slot, name } = read;
      const ops = operators();
      if (name !== 'default') return () => ops.get(env[slot], name);
      return () => {
        const m = env[slot];
        return isObject(m) && reflectGet(m, '__esModule') ? ops.get(m, 'default') : m;
      };
    }
    case 'namespace': {
      const slot = read.slot;
      let namespace: object | null = null;
      return () => {
        if (namespace === null) namespace = toESM(env[slot]);
        return namespace;
      };
    }
  }
}

/** The wrapper function that runs `plan`. */
export function moduleCell(plan: ModulePlan): ModuleCell {
  const { frame, exportsSlot, requireSlot, moduleSlot, filenameSlot, dirnameSlot, imports, exports, stars, instantiate, body } = plan;
  const ops = operators();
  const bs = body.s;
  const bg = body.g;
  return (exportsArg, requireArg, moduleArg, filename, dirname) => {
    const env = withElement(frame, 0, ROOT_ENV);
    env[exportsSlot] = exportsArg;
    env[requireSlot] = requireArg;
    env[moduleSlot] = moduleArg;
    env[filenameSlot] = filename;
    env[dirnameSlot] = dirname;
    if (typeof requireArg !== 'function') throw new TypeError('require is not a function');
    // Instantiation, before any import is evaluated: an import that
    // imports this module back (a cycle) finds its exports published and
    // its function declarations made, as a module's linking provides.
    const facade = {};
    defineOrThrow(facade, '__esModule', dataDescriptor(true, false, false, false));
    for (let i = 0; i < exports.length; i++) {
      const { name, read } = exports[i];
      if (!objectHasOwn(facade, name)) defineOrThrow(facade, name, accessorDescriptor('get', exportGetter(env, read), true, false));
    }
    ops.set(moduleArg, 'exports', facade);
    if (instantiate !== null) instantiate(env);
    for (let i = 0; i < imports.length; i++) {
      const { source, slot, bindings } = imports[i];
      const m: unknown = reflectApply(requireArg, undefined, [source]);
      if (slot !== null) env[slot] = m;
      for (let j = 0; j < bindings.length; j++) env[bindings[j].slot] = bindings[j].namespace ? toESM(m) : m;
    }
    for (let i = 0; i < stars.length; i++) {
      const m = env[stars[i]];
      if (!isObject(m)) continue;
      const keys = objectGetOwnPropertyNames(m);
      for (let j = 0; j < keys.length; j++) {
        const key = keys[j];
        if (key === 'default' || objectHasOwn(facade, key)) continue;
        defineOrThrow(facade, key, accessorDescriptor('get', () => ops.get(m, key), isEnumerableOwn(m, key), false));
      }
    }
    if (bg === null) {
      bs(env);
      return undefined;
    }
    return drive(bg(env));
  };
}

/** esbuild's __toESM: a namespace object over a CommonJS module's exports. */
function toESM(m: unknown): object {
  const target: object = objectCreate(isObject(m) ? objectGetPrototypeOf(m) : null);
  if (!isObject(m) || !reflectGet(m, '__esModule')) defineOrThrow(target, 'default', dataDescriptor(m, false, true, false));
  if (isObject(m)) {
    const keys = objectGetOwnPropertyNames(m);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (objectHasOwn(target, key)) continue;
      defineOrThrow(target, key, accessorDescriptor('get', () => reflectGet(m, key), isEnumerableOwn(m, key), false));
    }
  }
  return target;
}

/** Runs a module body's generator as an async function would: one await per yielded value. */
async function drive(it: Generator<unknown, unknown, unknown>): Promise<unknown> {
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
