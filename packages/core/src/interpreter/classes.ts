/**
 * classes.ts — a class definition at runtime, from the plan compile.ts makes
 * of it (Compiler.classPlan): its scope entered, its private names made, its
 * heritage and computed keys evaluated, its constructor and elements
 * defined, and what constructing an instance initializes.
 */
import { type Code, asGen, suspendedSync } from './code.js';
import {
  Error, append, contains, createDataProperty, everyItem, mapList, newSafeList, reflectGet, safeGenerator,
  withElement,
} from './intrinsics.js';
import { defineAccessor, defineMethod, toPropertyKey } from './operations.js';
import {
  ClassRecord, type Env, type FunctionInfo, PrivateName, type Sync, functionName, isObject, makeClass, makeFunction,
} from './runtime.js';

/**
 * A class element's key: static, one of the class's private names, or the
 * index of its computed key among the class's computed keys, which are all
 * evaluated (in order) before the class's elements are defined. Nothing can
 * reach the class until its definition completes, so that order is
 * unobservable, and it lets a key await or yield.
 */
export type ElementKey =
  | { readonly kind: 'static'; readonly static: PropertyKey }
  | { readonly kind: 'private'; readonly private: (env: Env) => PrivateName }
  | { readonly kind: 'computed'; readonly computed: number };

/** A class's making at runtime: its scope entered, private names made, heritage and keys evaluated, then defined. */
export function classMaking(entry: ((env: Env) => Env) | null, heritage: Code | null, plan: ClassPlan): ClassMaker {
  const define = classDefiner(plan);
  const keys = plan.computedKeys;
  const privateNames = plan.privateNames;
  // The class's private names exist from its scope's start: its heritage and keys can name them.
  const enter = (env: Env): Env => {
    const classEnv = entry ? entry(env) : env;
    for (let i = 0; i < privateNames.length; i++) {
      const p = privateNames[i];
      const pn = new PrivateName(p.description);
      pn.kind = p.kind;
      classEnv[p.slot] = pn;
    }
    return classEnv;
  };
  if ((heritage === null || heritage.g === null) && everyItem(keys, (k) => k.g === null)) {
    const h = heritage ? heritage.s : null;
    const ks = mapList(keys, (k) => k.s);
    return {
      s: (env, name) => {
        const classEnv = enter(env);
        const parent = h ? h(classEnv) : undefined;
        const computed = newSafeList<PropertyKey>();
        for (let i = 0; i < ks.length; i++) append(computed, toPropertyKey(ks[i](classEnv)));
        return define(classEnv, parent, name, computed);
      },
      g: null,
    };
  }
  const hg = heritage ? asGen(heritage) : null;
  const kgs = mapList(keys, asGen);
  return {
    s: suspendedSync,
    g: safeGenerator(function* (env: Env, name: string) {
      const classEnv = enter(env);
      const parent = hg ? yield* hg(classEnv) : undefined;
      const computed = newSafeList<PropertyKey>();
      for (let i = 0; i < kgs.length; i++) append(computed, toPropertyKey(yield* kgs[i](classEnv)));
      return define(classEnv, parent, name, computed);
    }),
  };
}

/** ClassDefinitionEvaluation, with the class's name given when it runs. */
export type ClassMaker = {
  readonly s: (env: Env, name: string) => unknown;
  readonly g: ((env: Env, name: string) => Generator<unknown, unknown, unknown>) | null;
};

/** One element of a class, compiled. */
export type ClassElement =
  | { readonly kind: 'method'; readonly isStatic: boolean; readonly key: ElementKey; readonly fi: FunctionInfo; readonly accessor: 'get' | 'set' | null }
  | { readonly kind: 'field'; readonly isStatic: boolean; readonly key: ElementKey; readonly value: Sync | null; readonly named: ((env: Env, name: string) => unknown) | null }
  | { readonly kind: 'static'; readonly fi: FunctionInfo };

export type ClassPrivateName = { readonly slot: number; readonly kind: 'field' | 'method' | 'accessor'; readonly description: string };

/** A class definition, compiled (Compiler.classPlan): what classDefiner needs, and nothing of the AST. */
export interface ClassPlan {
  readonly ctorInfo: FunctionInfo;
  /** Writes the class's own name binding (a named class), in its scope. */
  readonly writeInner: ((env: Env, value: unknown) => void) | null;
  readonly elements: readonly ClassElement[];
  readonly privateNames: readonly ClassPrivateName[];
  /** The computed keys, evaluated in order before the elements are defined. */
  readonly computedKeys: readonly Code[];
  readonly instanceFi: FunctionInfo | null;
  readonly staticFi: FunctionInfo | null;
}

/** A field initializer's (or static block's) frame: `this` and the home object. */
export function fieldFrame(fi: FunctionInfo, scope: Env, thisArg: unknown, home: object): Env {
  const env = withElement(fi.frame, 0, scope);
  if (fi.thisSlot !== 0) env[fi.thisSlot] = thisArg;
  if (fi.homeSlot !== 0) env[fi.homeSlot] = home;
  return env;
}

/** ClassDefinitionEvaluation's runtime half, from a compiled plan. */
export function classDefiner(plan: ClassPlan): (classEnv: Env, parent: unknown, name: string, computed: readonly PropertyKey[]) => Function {
  const { ctorInfo, writeInner, elements, instanceFi, staticFi } = plan;
  return (classEnv: Env, parent: unknown, name: string, computed: readonly PropertyKey[]): Function => {
    const record = new ClassRecord();
    const C = makeClass(ctorInfo, classEnv, parent, name, record);
    const protoValue: unknown = reflectGet(C, 'prototype');
    if (!isObject(protoValue)) throw new Error('interpreter: class without a prototype');
    const proto = protoValue;
    type FieldRecord = { key: PropertyKey | PrivateName; value: Sync | null; named: ((env: Env, name: string) => unknown) | null };
    const instanceFieldList = newSafeList<FieldRecord>();
    const instancePrivateMethods = newSafeList<PrivateName>();
    const staticWork = newSafeList<{ readonly kind: 'field'; readonly field: FieldRecord } | { readonly kind: 'block'; readonly block: FunctionInfo }>();
    const staticPrivateMethods = newSafeList<PrivateName>();
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.kind === 'static') { append(staticWork, { kind: 'block', block: el.fi }); continue; }
      const target = el.isStatic ? C : proto;
      let key: PropertyKey | PrivateName;
      if (el.key.kind === 'private') key = el.key.private(classEnv);
      else if (el.key.kind === 'static') key = el.key.static;
      else key = computed[el.key.computed];
      if (el.kind === 'method') {
        const fname = key instanceof PrivateName ? (el.accessor ? `${el.accessor} ${key.description}` : key.description)
          : functionName(key, el.accessor ?? undefined);
        const fn = makeFunction(el.fi, classEnv, target, fname);
        if (key instanceof PrivateName) {
          if (el.accessor === 'get') key.getter = fn;
          else if (el.accessor === 'set') key.setter = fn;
          else key.method = fn;
          const list = el.isStatic ? staticPrivateMethods : instancePrivateMethods;
          if (!contains(list, key)) append(list, key);
        } else if (el.accessor) {
          defineAccessor(target, key, el.accessor, fn, false);
        } else {
          defineMethod(target, key, fn, false);
        }
        continue;
      }
      const record: FieldRecord = { key, value: el.value, named: el.named };
      if (el.isStatic) append(staticWork, { kind: 'field', field: record });
      else append(instanceFieldList, record);
    }
    const defineField = (fieldEnv: Env | null, receiver: object, f: FieldRecord) => {
      let v: unknown;
      if (fieldEnv !== null) {
        if (f.value !== null) v = f.value(fieldEnv);
        else if (f.named !== null) v = f.named(fieldEnv, f.key instanceof PrivateName ? f.key.description : functionName(f.key));
      }
      if (f.key instanceof PrivateName) f.key.add(receiver, v);
      else createDataProperty(receiver, f.key, v);
    };
    const initialize = instanceFieldList.length === 0 && instancePrivateMethods.length === 0 ? null : (instance: object) => {
      for (let i = 0; i < instancePrivateMethods.length; i++) instancePrivateMethods[i].add(instance, undefined);
      if (instanceFieldList.length === 0) return;
      const fieldEnv = instanceFi ? fieldFrame(instanceFi, classEnv, instance, proto) : null;
      for (let i = 0; i < instanceFieldList.length; i++) defineField(fieldEnv, instance, instanceFieldList[i]);
    };
    record.initialize = initialize;
    record.home = proto;
    if (writeInner) writeInner(classEnv, C);
    for (let i = 0; i < staticPrivateMethods.length; i++) staticPrivateMethods[i].add(C, undefined);
    const staticEnv = staticFi ? fieldFrame(staticFi, classEnv, C, C) : null;
    for (let i = 0; i < staticWork.length; i++) {
      const work = staticWork[i];
      if (work.kind === 'block') {
        const fi = work.block;
        if (fi.body) fi.body(fieldFrame(fi, classEnv, C, C));
      } else {
        defineField(staticEnv, C, work.field);
      }
    }
    return C;
  };
}
