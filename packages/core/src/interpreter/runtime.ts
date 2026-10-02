/**
 * runtime.ts — what compiled closures run against: environments, completion
 * signals, interpreted function objects, classes and private names.
 */
import type { FactoryFunctionInfo, FunctionFactories, FunctionRuntime, HostOperators, HostOps, NativeFunction } from './host-ops.js';
import {
  Error, ReferenceError, SafeAsyncGeneratorPrototype, SafeGeneratorPrototype, SafeMap, SafeWeakMap, SafeWeakSet, TypeError, arrayIsArray, copyList,
  dataDescriptor, defineOrThrow, globalObject, newList, objectCreate, objectFreeze, objectGetPrototypeOf, objectHasOwn,
  reflectApply, reflectConstruct, reflectOwnKeys, registerSource, stringOf, symbolDescription, withElement,
} from './intrinsics.js';

/**
 * A scope's environment: slot 0 is the enclosing environment, the rest are
 * the scope's bindings (scope.ts assigns the slots).
 */
export type Env = unknown[];

/** The enclosing environment of `env`. */
export function up(env: Env): Env {
  const parent = env[0];
  if (!arrayIsArray(parent)) throw new Error('interpreter: environment without a parent');
  return parent;
}

/** An environment `hops` levels up. */
export function upN(env: Env, hops: number): Env {
  let e = env;
  for (let i = 0; i < hops; i++) e = up(e);
  return e;
}

/** The value of a lexical binding before its declaration has run. */
export const TDZ: object = objectFreeze(objectCreate(null));

export function tdzError(name: string): ReferenceError {
  return new ReferenceError(`Cannot access '${name}' before initialization`);
}

export const THIS_BEFORE_SUPER = "Must call super constructor in derived class before accessing 'this' or returning from derived constructor";

/** How a statement ended abnormally; a normal completion is `undefined`. */
export class Completion {
  constructor(
    readonly kind: 'break' | 'continue' | 'return',
    readonly label: string | null,
    readonly value: unknown,
  ) {}
}
export type Signal = Completion | undefined;

export const BREAK = new Completion('break', null, undefined);
export const CONTINUE = new Completion('continue', null, undefined);
const labeled = new SafeMap<string, Completion>();
export function labeledSignal(kind: 'break' | 'continue', label: string): Completion {
  const key = `${kind}:${label}`;
  let signal = labeled.get(key);
  if (!signal) {
    signal = new Completion(kind, label, undefined);
    labeled.set(key, signal);
  }
  return signal;
}

/** The marker an async generator body yields to await, yield or delegate; its operand is beside it. */
export const AWAIT = objectFreeze({ mark: 'await' });
export const YIELD = objectFreeze({ mark: 'yield' });
export const DELEGATE = objectFreeze({ mark: 'delegate' });
export const MARK = objectFreeze({ mark: 'return' });
let pendingOperand: unknown;
export function signalOperand(value: unknown): void {
  pendingOperand = value;
}

export type Sync = (env: Env) => unknown;
export type Gen = (env: Env) => Generator<unknown, unknown, unknown>;

export type FunctionShape =
  | 'plain' | 'method' | 'arrow' | 'generator' | 'async' | 'asyncArrow' | 'asyncGenerator'
  | 'classBase' | 'classDerived';

/** A compiled function: what every function object made from one source function shares. */
export class FunctionInfo implements FactoryFunctionInfo {
  body: Sync | null = null;
  gen: Gen | null = null;
  /** The body evaluates to the return value itself (an arrow's expression body). */
  expression = false;
  thisSlot = 0;
  argumentsSlot = 0;
  newTargetSlot = 0;
  homeSlot = 0;
  funcSlot = 0;
  /** Parameter slots, when every parameter is a plain identifier. */
  params: number[] | null = null;
  /** Binds the parameters otherwise. */
  bindParams: ((env: Env, args: ArrayLike<unknown>) => void) | null = null;
  /**
   * What a call's frame starts as: slot 0 (the scope) unset, lexical slots
   * in their TDZ, the rest undefined. Copied per call (frameTemplate).
   */
  frame: Env = [];
  /** A derived constructor's `this` starts uninitialized. */
  derived = false;
  /** A class constructor with no constructor in its source. */
  implicit = false;
  /** Compiles the body, on the function's first call (compile.ts); null once compiled. */
  lazy: (() => void) | null = null;
  constructor(
    readonly shape: FunctionShape,
    readonly name: string,
    readonly length: number,
    readonly strict: boolean,
    /** The source text Function.prototype.toString answers. */
    readonly source: string,
  ) {}
}

// ── The host module and the function runtime ──

let host: HostOperators;
let strictFactories: FunctionFactories<FunctionInfo, Env, ClassRecord>;
let sloppyFactories: FunctionFactories<FunctionInfo, Env, ClassRecord>;

/**
 * A frame of `size` slots, `tdz` of them in their TDZ: every slot an own
 * property, so that an environment copied from it (withElement) is read and
 * written without ever consulting Array.prototype.
 */
export function frameTemplate(size: number, tdz: readonly number[]): Env {
  const frame = newList(size);
  for (let i = 0; i < tdz.length; i++) frame[tdz[i]] = TDZ;
  return frame;
}

export function operators(): HostOperators {
  return host;
}

function enter(
  fi: FunctionInfo, scope: Env, fn: Function | undefined, thisArg: unknown, args: ArrayLike<unknown>,
  newTarget: Function | undefined, home: object | undefined,
): Env {
  if (fi.lazy !== null) fi.lazy();
  const env = withElement(fi.frame, 0, scope);
  if (fi.thisSlot !== 0) env[fi.thisSlot] = fi.derived ? TDZ : thisArg;
  if (fi.argumentsSlot !== 0) env[fi.argumentsSlot] = args;
  if (fi.newTargetSlot !== 0) env[fi.newTargetSlot] = newTarget;
  if (fi.homeSlot !== 0) env[fi.homeSlot] = home;
  if (fi.funcSlot !== 0) env[fi.funcSlot] = fn;
  const params = fi.params;
  if (params !== null) {
    for (let i = 0; i < params.length; i++) env[params[i]] = args[i];
  } else if (fi.bindParams !== null) {
    fi.bindParams(env, args);
  }
  return env;
}

function finish(fi: FunctionInfo, result: unknown): unknown {
  if (fi.expression) return result;
  return result instanceof Completion ? result.value : undefined;
}

function run(fi: FunctionInfo, env: Env): unknown {
  const body = fi.body;
  if (body === null) throw new Error('interpreter: a suspending body called synchronously');
  return finish(fi, body(env));
}

/**
 * One evaluation of a class: what constructing an instance initializes, and
 * the home object of its constructor. Filled in once the class's elements
 * are defined, before anything can construct it.
 */
export class ClassRecord {
  /** Initializes an instance's private methods and fields, in order. */
  initialize: ((instance: object) => void) | null = null;
  home: object | undefined = undefined;
}
/** The record of each class constructor, for super() calls, which know only the constructor. */
const classRecords = new SafeWeakMap<Function, ClassRecord>();

function registerClass(ctor: Function, record: ClassRecord): void {
  classRecords.set(ctor, record);
}

/** The object a derived constructor's super(...args) constructs, before its fields. */
export function superConstruct(ctor: Function, args: unknown[], newTarget: unknown): object {
  const parent: unknown = objectGetPrototypeOf(ctor);
  if (typeof parent !== 'function' || typeof newTarget !== 'function') {
    throw new TypeError(`Super constructor ${stringOf(parent)} of anonymous class is not a constructor`);
  }
  const instance: unknown = reflectConstruct(parent, args, newTarget);
  if (!isObject(instance)) throw new TypeError('Derived constructor did not produce an object');
  return instance;
}

/** InitializeInstanceElements: the private methods and fields of `ctor`'s class, once `this` is bound. */
export function initializeInstance(ctor: Function, instance: object): void {
  const record = classRecords.get(ctor);
  if (record && record.initialize) record.initialize(instance);
}

export function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

const runtime: FunctionRuntime<FunctionInfo, Env, ClassRecord> = {
  call(fi, scope, fn, thisArg, args, newTarget, home) {
    return run(fi, enter(fi, scope, fn, thisArg, args, newTarget, home));
  },
  arrow(fi, scope, args) {
    return run(fi, enter(fi, scope, undefined, undefined, args, undefined, undefined));
  },
  enter,
  finish,
  construct(fi, scope, ctor, record, thisArg, args, newTarget) {
    if (record.initialize) record.initialize(thisArg);
    if (fi.implicit) return undefined;
    return run(fi, enter(fi, scope, ctor, thisArg, args, newTarget, record.home));
  },
  constructDerived(fi, scope, ctor, record, args, newTarget) {
    // The implicit constructor passes its arguments on as they are, without iterating them.
    if (fi.implicit) {
      const instance = superConstruct(ctor, copyList(args), newTarget);
      if (record.initialize) record.initialize(instance);
      return instance;
    }
    const env = enter(fi, scope, ctor, undefined, args, newTarget, record.home);
    const body = fi.body;
    if (body === null) throw new Error('interpreter: a suspending constructor');
    // Undefined falls through to `this`; anything else is the native
    // constructor's own answer (an object, or the TypeError for a primitive).
    const value = finish(fi, body(env));
    if (value !== undefined) return value;
    const self = fi.thisSlot === 0 ? TDZ : env[fi.thisSlot];
    // Returning undefined uninitialized makes the native constructor throw its ReferenceError.
    return self === TDZ ? undefined : self;
  },
  enterGenerator(fi, scope, fn, thisArg, args, home) {
    pendingFrames.set(args, enter(fi, scope, fn, thisArg, args, undefined, home));
    return 'length';
  },
  takeFrame(args) {
    const env = pendingFrames.get(args);
    if (env === undefined) throw new Error('interpreter: a generator started without its frame');
    pendingFrames.delete(args);
    return env;
  },
  operand() {
    const value = pendingOperand;
    pendingOperand = undefined;
    return value;
  },
  ownKeys: reflectOwnKeys,
  hasOwn: objectHasOwn,
  global: globalObject,
  SafeGeneratorPrototype,
  SafeAsyncGeneratorPrototype,
  AWAIT,
  YIELD,
  DELEGATE,
  MARK,
};

/**
 * The frame a generator's call bound, from when its parameters are bound
 * (at the call) to when its body starts (at the first next()), keyed by the
 * call's arguments object, which nothing else holds then.
 */
const pendingFrames = new SafeWeakMap<object, Env>();

export function installHost(hostOps: HostOps): void {
  const bound = hostOps.bind(runtime);
  host = bound.ops;
  strictFactories = bound.strict;
  sloppyFactories = bound.sloppy;
}

/** A function object of `fi`'s shape over `scope`. */
export function makeFunction(fi: FunctionInfo, scope: Env, home: object | undefined, name: string = fi.name): NativeFunction {
  const factories = fi.strict ? strictFactories : sloppyFactories;
  let fn: NativeFunction;
  switch (fi.shape) {
    case 'plain': fn = factories.plain(fi, scope); break;
    case 'method': fn = factories.method(fi, scope, home); break;
    case 'arrow': fn = factories.arrow(fi, scope); break;
    case 'generator': fn = factories.generator(fi, scope, home); break;
    case 'async': fn = factories.async(fi, scope, home); break;
    case 'asyncArrow': fn = factories.asyncArrow(fi, scope); break;
    case 'asyncGenerator': fn = factories.asyncGenerator(fi, scope, home); break;
    case 'classBase': case 'classDerived': throw new Error('interpreter: classes are made by makeClass');
  }
  return finishFunction(fn, fi, name);
}

/** A class constructor of `fi` over `scope`, extending `parent` when derived. */
export function makeClass(fi: FunctionInfo, scope: Env, parent: unknown, name: string, record: ClassRecord): NativeFunction {
  const ctor = fi.shape === 'classDerived' ? strictFactories.classDerived(fi, scope, parent, record) : strictFactories.classBase(fi, scope, record);
  registerClass(ctor, record);
  return finishFunction(ctor, fi, name);
}

function finishFunction(fn: NativeFunction, fi: FunctionInfo, name: string): NativeFunction {
  if (fi.length !== 0) defineOrThrow(fn, 'length', dataDescriptor(fi.length, false, false, true));
  if (name !== '' || fi.shape === 'method') defineOrThrow(fn, 'name', dataDescriptor(name, false, false, true));
  registerSource(fn, fi.source);
  return fn;
}

/** SetFunctionName's name for a property key, with an optional get/set prefix. */
export function functionName(key: PropertyKey, prefix?: string): string {
  let name: string;
  if (typeof key === 'symbol') {
    const description = symbolDescription(key);
    name = description === undefined ? '' : `[${description}]`;
  } else {
    name = stringOf(key);
  }
  return prefix ? `${prefix} ${name}` : name;
}

// ── Private names ──

/** One private name of one evaluation of a class. */
export class PrivateName {
  kind: 'field' | 'method' | 'accessor' = 'field';
  readonly values = new SafeWeakMap<object, unknown>();
  /** For methods and accessors: the objects that carry the class's brand. */
  brand: SafeWeakSet<object> = new SafeWeakSet();
  method: unknown = undefined;
  getter: unknown = undefined;
  setter: unknown = undefined;
  constructor(readonly description: string) {}

  private present(target: unknown): target is object {
    if (!isObject(target)) return false;
    return this.kind === 'field' ? this.values.has(target) : this.brand.has(target);
  }

  get(target: unknown): unknown {
    if (!this.present(target)) throw new TypeError(`Cannot read private member ${this.description} from an object whose class did not declare it`);
    if (this.kind === 'field') return this.values.get(target);
    if (this.kind === 'method') return this.method;
    if (typeof this.getter !== 'function') throw new TypeError(`'${this.description}' was defined without a getter`);
    return reflectApply(this.getter, target, []);
  }

  set(target: unknown, value: unknown): void {
    if (!this.present(target)) throw new TypeError(`Cannot write private member ${this.description} to an object whose class did not declare it`);
    if (this.kind === 'field') {
      this.values.set(target, value);
      return;
    }
    if (this.kind === 'method') throw new TypeError(`Private method '${this.description}' is not writable`);
    if (typeof this.setter !== 'function') throw new TypeError(`'${this.description}' was defined without a setter`);
    reflectApply(this.setter, target, [value]);
  }

  has(target: unknown): boolean {
    if (!isObject(target)) throw new TypeError(`Cannot use 'in' operator to search for '${this.description}' in ${stringOf(target)}`);
    return this.kind === 'field' ? this.values.has(target) : this.brand.has(target);
  }

  /** PrivateFieldAdd / PrivateMethodOrAccessorAdd. */
  add(target: object, value: unknown): void {
    if (this.kind === 'field') {
      if (this.values.has(target)) throw new TypeError(`Cannot initialize ${this.description} twice on the same object`);
      this.values.set(target, value);
      return;
    }
    if (this.brand.has(target)) throw new TypeError(`Cannot initialize private methods of class ${this.description} twice on the same object`);
    this.brand.add(target);
  }
}
