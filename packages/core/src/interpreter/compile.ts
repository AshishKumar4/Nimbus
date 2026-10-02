/**
 * compile.ts — turns an analyzed tree into closures, once per function.
 *
 * Each expression and statement becomes a closure over the environment array
 * of the scope it runs in (`(env) => value`); variables are fixed slots
 * resolved by scope.ts, so running code never looks a name up. Code that
 * awaits or yields cannot be a plain closure: it has to stop and resume. Only
 * the nodes on the path from a function's body to an `await`, `yield` or
 * `for await` become generator functions (`function* (env)`), which the
 * native generator, async function or async generator wrapping the body
 * (host-ops.ts) drives; everything off that path stays a plain closure.
 * A body that never suspends has no generator at all.
 *
 * A Code is both flavors: `s` runs it directly, `g` (when it suspends) as a
 * generator whose return value is the result.
 */
import type {
  AnyNode, ArrayExpression, ArrayPattern, ArrowFunctionExpression, AssignmentExpression, AwaitExpression,
  BinaryExpression, BlockStatement, CallExpression, ClassBody, ClassExpression, ExportDefaultDeclaration, Expression,
  ForInStatement, ForOfStatement, ForStatement, FunctionDeclaration, FunctionExpression, Identifier, ImportExpression,
  Literal, LogicalExpression, MemberExpression, MetaProperty, ModuleDeclaration, NewExpression,
  ObjectExpression, ObjectPattern, Pattern, PrivateIdentifier, Program, SpreadElement, Statement, StaticBlock, Super,
  SwitchStatement, TaggedTemplateExpression, TemplateLiteral, TryStatement, UnaryExpression, UpdateExpression,
  VariableDeclaration, WithStatement, YieldExpression,
} from 'acorn';
import type { HostOperators, NativeFunction } from './host-ops.js';
import {
  type Analysis, type Binding, type ClassNode, type FunctionNode, FunctionScope, type Reference, type Scope,
  forEachChildNode, patternIdentifiers,
} from './scope.js';
import {
  SafeMap, SafeSet, SafeWeakMap, append, arrayIsArray, arraySliceFrom, contains, defineOrThrow, everyItem, indexWhere,
  mapList, objectCreate, objectFreeze, objectGetOwnPropertyNames, objectHasOwn, reflectApply, reflectConstruct,
  reflectDefineProperty, reflectGet, reflectGetOwnPropertyDescriptor, objectGetPrototypeOf, reflectHas, reflectOwnKeys,
  reflectSet, reflectSetPrototypeOf, skipTrivia, someItem, stringOf, stringSlice, symbolAsyncIterator, symbolDescriptiveString, symbolIterator,
  symbolUnscopables, withLast,
} from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
import {
  AWAIT, BREAK, CONTINUE, ClassRecord, Completion, DELEGATE, type Env, FunctionInfo, type FunctionShape, PrivateName,
  type Signal, type Sync, TDZ, THIS_BEFORE_SUPER, YIELD, asyncFromSyncIterator, functionName, initializeInstance,
  isObject, labeledSignal, makeClass, makeFunction, operators, signalOperand, superConstruct, tdzError, up, upN,
} from './runtime.js';

/** Code that evaluates to a T: run directly (`s`), or as a generator (`g`) when it suspends. */
export interface CodeOf<T> {
  readonly s: (env: Env) => T;
  readonly g: ((env: Env) => Generator<unknown, T, unknown>) | null;
}
export type Code = CodeOf<unknown>;

function syncCode<T>(s: (env: Env) => T): CodeOf<T> {
  return { s, g: null };
}

function suspendedSync(): never {
  throw new Error('interpreter: suspending code run synchronously');
}

function suspendedBind(): never {
  throw new Error('interpreter: suspending pattern bound synchronously');
}

function genCode<T>(g: (env: Env) => Generator<unknown, T, unknown>): CodeOf<T> {
  return { s: suspendedSync, g };
}

/** A generator that runs `c` in a suspending context. */
function asGen<T>(c: CodeOf<T>): (env: Env) => Generator<unknown, T, unknown> {
  if (c.g !== null) return c.g;
  const s = c.s;
  return function* (env) { return s(env); };
}

/** The value an optional chain short-circuits to, inside the chain. */
const SHORT: object = objectFreeze({ short: true });

/** What the host gives a compiled unit. */
export interface UnitHost {
  /** The unit's `import(specifier, options)`. */
  readonly dynamicImport: ((specifier: unknown, options: unknown) => Promise<unknown>) | null;
}

type Labels = readonly string[];

/** A property key known when compiling, or computed when the code runs. */
type KeyCode = { readonly static: PropertyKey } | { readonly computed: Code };

/**
 * A class element's key: static, one of the class's private names, or the
 * index of its computed key among the class's computed keys, which are all
 * evaluated (in order) before the class's elements are defined. Nothing can
 * reach the class until its definition completes, so that order is
 * unobservable, and it lets a key await or yield.
 */
type ElementKey = { readonly static: PropertyKey } | { readonly private: (env: Env) => PrivateName } | { readonly computed: number };

/** A function value and the `this` a call through it passes. */
type Callee = readonly [fn: unknown, thisArg: unknown];

const G: typeof globalThis = globalThis;

const constructors = new SafeWeakMap<Function, boolean>();
function isConstructorValue(value: unknown): value is Function {
  if (typeof value !== 'function') return false;
  let known = constructors.get(value);
  if (known === undefined) {
    try {
      // Constructing with `value` as new.target succeeds only for a constructor.
      reflectConstruct(Object, [], value);
      known = true;
    } catch {
      known = false;
    }
    constructors.set(value, known);
  }
  return known;
}

function toPropertyKey(value: unknown): PropertyKey {
  if (typeof value === 'string' || typeof value === 'symbol') return value;
  if (isObject(value)) return operators().propertyKey(value);
  return stringOf(value);
}

function describe(value: unknown): string {
  if (typeof value === 'function') return 'function';
  if (typeof value === 'object' && value !== null) return 'object';
  if (typeof value === 'symbol') return symbolDescriptiveString(value);
  return stringOf(value);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return value !== null && value !== undefined && typeof operators().get(value, symbolIterator) === 'function';
}

/** `value` as an iterable, or the TypeError for spreading or iterating a non-iterable. */
function iterable(value: unknown): Iterable<unknown> {
  if (isIterable(value)) return value;
  throw new TypeError(`${describe(value)} is not iterable`);
}

/** An iterator record over `value`, for destructuring (which may stop early and must close it). */
interface IteratorRecord {
  /**
   * Whether the iterator is finished: it said done, or a call to next()
   * (or its result) threw, after which it is never closed.
   */
  readonly done: boolean;
  /** IteratorStep: the next value, or `undefined` with `done` set. */
  step(): unknown;
  /** IteratorClose on a normal or return completion: calls return() and checks its result. */
  close(): void;
}

function getIterator(value: unknown): IteratorRecord {
  const method: unknown = operators().get(iterable(value), symbolIterator);
  if (typeof method !== 'function') throw new TypeError(`${describe(value)} is not iterable`);
  const it: unknown = reflectApply(method, value, []);
  if (!isObject(it)) throw new TypeError('Result of the symbolIterator method is not an object');
  const next: unknown = reflectGet(it, 'next');
  let done = false;
  return {
    get done() { return done; },
    step() {
      done = true;
      if (typeof next !== 'function') throw new TypeError(`${describe(next)} is not a function`);
      const result: unknown = reflectApply(next, it, []);
      if (!isObject(result)) throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
      if (reflectGet(result, 'done')) return undefined;
      const value: unknown = reflectGet(result, 'value');
      done = false;
      return value;
    },
    close() {
      const ret: unknown = reflectGet(it, 'return');
      if (ret === undefined || ret === null) return;
      if (typeof ret !== 'function') throw new TypeError(`${describe(ret)} is not a function`);
      const result: unknown = reflectApply(ret, it, []);
      if (!isObject(result)) throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
    },
  };
}

/** IteratorClose on an abrupt completion: the completion's error wins over return()'s. */
function closeQuietly(it: IteratorRecord): void {
  try { it.close(); } catch { /* the original error propagates */ }
}

const ArrayValues: unknown = Array.prototype[symbolIterator];
const ArrayIteratorPrototype: object = objectGetPrototypeOf([][symbolIterator]());
const ArrayIteratorNext: unknown = reflectGet(ArrayIteratorPrototype, 'next');

/** Whether indexing `value` is exactly iterating it (an array whose iteration nobody replaced). */
function plainArray(value: unknown): value is unknown[] {
  return arrayIsArray(value)
    && reflectGet(value, symbolIterator) === ArrayValues
    && reflectGet(ArrayIteratorPrototype, 'next') === ArrayIteratorNext;
}

function requireObjectCoercible(value: unknown): void {
  if (value === null || value === undefined) throw new TypeError(`Cannot destructure '${stringOf(value)}' as it is ${stringOf(value)}.`);
}

/** CopyDataProperties(target, source, excluded): an object rest or spread. */
function copyDataProperties(target: object, source: unknown, excluded: readonly PropertyKey[] | null): void {
  if (source === null || source === undefined) return;
  const from: object = Object(source);
  const keys = reflectOwnKeys(from);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (excluded && contains(excluded, key)) continue;
    const desc = reflectGetOwnPropertyDescriptor(from, key);
    if (desc && desc.enumerable) createDataProperty(target, key, reflectGet(from, key));
  }
}

/** CreateDataPropertyOrThrow, with one descriptor object reused. */
const DATA: PropertyDescriptor = { value: undefined, writable: true, enumerable: true, configurable: true };
function createDataProperty(target: object, key: PropertyKey, value: unknown): void {
  DATA.value = value;
  const ok = reflectDefineProperty(target, key, DATA);
  DATA.value = undefined;
  if (!ok) throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
}

function defineMethod(target: object, key: PropertyKey, value: unknown, enumerable: boolean): void {
  if (!reflectDefineProperty(target, key, { value, writable: true, enumerable, configurable: true })) {
    throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
  }
}

function defineAccessor(target: object, key: PropertyKey, kind: 'get' | 'set', fn: NativeFunction, enumerable: boolean): void {
  const desc: PropertyDescriptor = kind === 'get' ? { get: fn, enumerable, configurable: true } : { set: fn, enumerable, configurable: true };
  if (!reflectDefineProperty(target, key, desc)) throw new TypeError(`Cannot redefine property: ${stringOf(key)}`);
}

function templateObject(cooked: readonly (string | undefined)[], raw: readonly string[]): readonly (string | undefined)[] {
  const strings = arraySliceFrom(cooked, 0);
  defineOrThrow(strings, 'raw', { value: objectFreeze(arraySliceFrom(raw, 0)), writable: false, enumerable: false, configurable: false });
  return objectFreeze(strings);
}

function callValue(fn: unknown, thisArg: unknown, args: unknown[], text: string): unknown {
  if (typeof fn !== 'function') throw new TypeError(`${text} is not a function`);
  return reflectApply(fn, thisArg, args);
}

function constructValue(fn: unknown, args: unknown[], text: string): unknown {
  if (typeof fn !== 'function') throw new TypeError(`${text} is not a constructor`);
  try {
    return reflectConstruct(fn, args);
  } catch (error) {
    // V8 names a non-constructor by its own source text; name it by the expression.
    if (error instanceof TypeError && !isConstructorValue(fn)) throw new TypeError(`${text} is not a constructor`);
    throw error;
  }
}

/** A key as an error message shows it, without converting an object key (which could run its code). */
function keyText(key: unknown): string {
  return isObject(key) ? 'object' : stringOf(key);
}

/** The TypeError for reading `key` of null or undefined, before the key is converted. */
function nullBase(base: null | undefined, key: unknown): TypeError {
  return new TypeError(`Cannot read properties of ${stringOf(base)} (reading '${keyText(key)}')`);
}

/** Whether `name` resolves on a `with` object (HasBinding of an object environment). */
function withHas(target: unknown, name: string): target is object {
  if (!isObject(target) || !reflectHas(target, name)) return false;
  const unscopables: unknown = reflectGet(target, symbolUnscopables);
  return !(isObject(unscopables) && reflectGet(unscopables, name));
}

function isAnonymousFunctionDefinition(node: Expression): node is FunctionExpression | ArrowFunctionExpression | ClassExpression {
  return (node.type === 'FunctionExpression' && !node.id) || node.type === 'ArrowFunctionExpression' || (node.type === 'ClassExpression' && !node.id);
}

function expectedArgumentCount(params: readonly Pattern[]): number {
  let n = 0;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p.type === 'AssignmentPattern' || p.type === 'RestElement') break;
    n++;
  }
  return n;
}

/** An element of a suspending destructuring pattern (Compiler.elementGen). */
interface ElementGen {
  reference(env: Env): Generator<unknown, ((value: unknown) => void) | null, unknown>;
  assign(env: Env, set: ((value: unknown) => void) | null, value: unknown): Generator<unknown, void, unknown>;
}

/** A loop's verdict on its body's completion. */
type LoopStep = 'next' | 'stop' | 'out';

/** A key read and then written converts once, as the reference does. */
function keyOnce(key: unknown): unknown {
  return typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol' ? key : toPropertyKey(key);
}

/** `rest` with `first` before it. */
function withFirst(first: unknown, rest: readonly unknown[]): unknown[] {
  const out = new Array<unknown>(rest.length + 1);
  out[0] = first;
  for (let i = 0; i < rest.length; i++) out[i + 1] = rest[i];
  return out;
}

function signalOf(value: unknown): Signal {
  return value instanceof Completion ? value : undefined;
}

export class Compiler {
  private scope: Scope;
  private shape: FunctionShape = 'plain';
  private readonly suspendCache = new SafeWeakMap<AnyNode, boolean>();
  private readonly functionInfos = new SafeMap<AnyNode, FunctionInfo>();
  /** Module import bindings: the slot holds the module (named, default) or the namespace object. */
  readonly imports = new SafeMap<Binding, { kind: 'named' | 'default' | 'namespace'; name: string }>();

  constructor(
    readonly analysis: Analysis,
    readonly source: string,
    readonly host: UnitHost,
    root: FunctionScope,
  ) {
    this.scope = root;
  }

  // ── Suspension ──

  /** Whether evaluating `node` can await or yield in the current function. */
  suspends(node: AnyNode | null | undefined): boolean {
    // Only an async function or a generator suspends; a class's keys are evaluated where it sits.
    if (!node || this.shape === 'plain' || this.shape === 'method' || this.shape === 'arrow'
      || this.shape === 'classBase' || this.shape === 'classDerived') return false;
    const cached = this.suspendCache.get(node);
    if (cached !== undefined) return cached;
    let result = false;
    switch (node.type) {
      case 'AwaitExpression': case 'YieldExpression': result = true; break;
      case 'ForOfStatement': result = node.await || this.suspends(node.left) || this.suspends(node.right) || this.suspends(node.body); break;
      case 'FunctionExpression': case 'FunctionDeclaration': case 'ArrowFunctionExpression': result = false; break;
      case 'ClassExpression': case 'ClassDeclaration':
        result = this.suspends(node.superClass)
          || someItem(node.body.body, (m) => m.type !== 'StaticBlock' && m.computed && this.suspends(m.key));
        break;
      default:
        forEachChildNode(node, (child) => {
          if (!result && this.suspends(child)) result = true;
        });
    }
    this.suspendCache.set(node, result);
    return result;
  }

  // ── Scopes ──

  private withScope<T>(scope: Scope, f: () => T): T {
    const saved = this.scope;
    this.scope = scope;
    try {
      return f();
    } finally {
      this.scope = saved;
    }
  }

  /** Environment levels from the current scope's environment up to `target`'s. */
  private hops(target: Scope): number {
    const goal = target.holder();
    let s = this.scope.holder();
    let n = 0;
    while (s !== goal) {
      if (!s.parent) throw new Error('interpreter: binding outside the scope chain');
      s = s.parent.holder();
      n++;
    }
    return n;
  }

  /** Reads slot `slot` of the environment `hops` levels up. */
  private slotReader(hops: number, slot: number): Sync {
    switch (hops) {
      case 0: return (env) => env[slot];
      case 1: return (env) => up(env)[slot];
      case 2: return (env) => up(up(env))[slot];
      default: return (env) => upN(env, hops)[slot];
    }
  }

  private envAt(hops: number): (env: Env) => Env {
    switch (hops) {
      case 0: return (env) => env;
      case 1: return up;
      default: return (env) => upN(env, hops);
    }
  }

  /**
   * What entering `scope` does: allocate its environment when materialized,
   * start its lexical bindings in their TDZ, and instantiate its function
   * declarations. Null when entering costs nothing. `frame` is a function's
   * own scope, whose environment the call already allocated.
   */
  private scopeEntry(scope: Scope, frame = false): ((env: Env) => Env) | null {
    const tdz: number[] = [];
    scope.bindings.forEach((b) => { if (b.tdz && b.kind !== 'param') append(tdz, b.slot); });
    const script = scope.fn.functionKind === 'script' && scope === scope.fn;
    const functions = mapList(scope.functions, (decl) => {
      const fi = this.withScope(scope, () => this.functionInfo(decl, decl.id ? decl.id.name : 'default'));
      const binding = decl.id ? scope.bindings.get(decl.id.name) : scope.bindings.get('*default*');
      return { fi, slot: binding ? binding.slot : 0, global: script && decl.id ? decl.id.name : null };
    });
    const instantiate = (env: Env) => {
      for (let i = 0; i < tdz.length; i++) env[tdz[i]] = TDZ;
      for (let i = 0; i < functions.length; i++) {
        const f = functions[i];
        const value = makeFunction(f.fi, env, undefined);
        if (f.global !== null) {
          reflectDefineProperty(G, f.global, { value, writable: true, enumerable: true, configurable: false })
            || reflectSet(G, f.global, value);
        } else {
          env[f.slot] = value;
        }
      }
      return env;
    };
    if (scope.materialized && !frame) {
      const size = scope.size;
      return (env) => {
        const e: Env = new Array<unknown>(size);
        e[0] = env;
        return instantiate(e);
      };
    }
    if (tdz.length === 0 && functions.length === 0) return null;
    return instantiate;
  }

  // ── Functions ──

  /**
   * The compiled function of `node`. A class constructor passes its shape and
   * the class's source text, which is what the class's toString answers.
   */
  functionInfo(node: FunctionNode, name: string, shapeOverride?: FunctionShape, source?: string): FunctionInfo {
    const cached = this.functionInfos.get(node);
    if (cached) return cached;
    const fs = this.analysis.functionScopeOf(node);
    const shape: FunctionShape = shapeOverride ?? (
      node.type === 'ArrowFunctionExpression' ? (node.async ? 'asyncArrow' : 'arrow')
        : node.async ? (node.generator ? 'asyncGenerator' : 'async')
          : node.generator ? 'generator' : fs.method ? 'method' : 'plain');
    const fi = new FunctionInfo(shape, name, expectedArgumentCount(node.params), fs.strict, source ?? stringSlice(this.source, node.start, node.end));
    this.functionInfos.set(node, fi);
    this.compileFunctionInto(fi, fs, node.params, node.body);
    return fi;
  }

  private compileFunctionInto(fi: FunctionInfo, fs: FunctionScope, params: readonly Pattern[], body: BlockStatement | Expression): void {
    const saved = { scope: this.scope, shape: this.shape };
    this.scope = fs;
    this.shape = fi.shape;
    try {
      fi.size = fs.size;
      fi.derived = fs.derived;
      if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
      if (fs.argumentsBinding) fi.argumentsSlot = fs.argumentsBinding.slot;
      if (fs.newTargetBinding) fi.newTargetSlot = fs.newTargetBinding.slot;
      if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
      if (fs.funcBinding) fi.funcSlot = fs.funcBinding.slot;
      if (everyItem(params, (p) => p.type === 'Identifier')) {
        fi.params = mapList(params, (p) => this.declaredBinding(p).slot);
      } else {
        fs.bindings.forEach((b) => { if (b.kind === 'param' && b.tdz) append(fi.tdzSlots, b.slot); });
        fi.bindParams = this.paramBinder(params);
      }
      if (body.type !== 'BlockStatement') {
        fi.expression = true;
        const c = this.expr(body);
        if (c.g) fi.gen = c.g; else fi.body = c.s;
        return;
      }
      const code = this.functionBody(fs, body);
      if (code.expression) fi.expression = true;
      if (code.code.g) fi.gen = code.code.g; else fi.body = code.code.s;
    } finally {
      this.scope = saved.scope;
      this.shape = saved.shape;
    }
  }

  /** A function body: its var scope's entry, then its statements. */
  private functionBody(fs: FunctionScope, body: BlockStatement): { code: Code; expression: boolean } {
    const varScope = fs.varScope;
    let entry: ((env: Env) => Env) | null;
    if (varScope === fs) {
      entry = this.scopeEntry(fs, true);
    } else {
      // A separate var environment: body vars named like parameters start with the parameter's value.
      const copies: Array<[from: number, to: number]> = [];
      varScope.bindings.forEach((b) => {
        const param = fs.bindings.get(b.name);
        if (b.kind !== 'var') return;
        if (param && param.kind === 'param') append(copies, [param.slot, b.slot]);
        else if (b.name === 'arguments' && fs.argumentsBinding) append(copies, [fs.argumentsBinding.slot, b.slot]);
      });
      const inner = this.withScope(varScope, () => this.scopeEntry(varScope));
      entry = (env) => {
        const e = inner ? inner(env) : env;
        for (let i = 0; i < copies.length; i++) e[copies[i][1]] = env[copies[i][0]];
        return e;
      };
    }
    return this.withScope(varScope, () => {
      const statements = body.body;
      // A body that is one `return <expr>` evaluates to the expression itself.
      if (entry === null && statements.length === 1 && statements[0].type === 'ReturnStatement') {
        const arg = statements[0].argument;
        return { code: arg ? this.expr(arg) : syncCode(() => undefined), expression: true };
      }
      const list = this.statementList(statements);
      return { code: this.entered(entry, list), expression: false };
    });
  }

  /** Code that runs `body` in the environment `entry` makes. */
  private entered(entry: ((env: Env) => Env) | null, body: Code): Code {
    if (entry === null) return body;
    const bs = body.s;
    const bg = body.g;
    if (bg) return genCode(function* (env) { return yield* bg(entry(env)); });
    return syncCode((env) => bs(entry(env)));
  }

  private declaredBinding(id: Identifier): Binding {
    const ref = this.analysis.ref(id);
    if (!ref.binding) throw new Error(`interpreter: ${id.name} declares no binding`);
    return ref.binding;
  }

  private paramBinder(params: readonly Pattern[]): (env: Env, args: ArrayLike<unknown>) => void {
    const binders = mapList(params, (p, i) => {
      if (p.type === 'RestElement') {
        const bind = this.patternBinder(p.argument, true);
        return (env: Env, args: ArrayLike<unknown>) => bind(env, arraySliceFrom(args, i));
      }
      const bind = this.patternBinder(p, true);
      return (env: Env, args: ArrayLike<unknown>) => bind(env, args[i]);
    });
    return (env, args) => {
      for (let i = 0; i < binders.length; i++) binders[i](env, args);
    };
  }

  /** A function or class expression evaluated to a new function object. */
  private functionExpr(node: FunctionExpression | ArrowFunctionExpression, name: string): Code {
    const fi = this.functionInfo(node, node.type === 'FunctionExpression' && node.id ? node.id.name : name);
    return syncCode((env) => makeFunction(fi, env, undefined));
  }

  /** Evaluate `node`, naming it `name` if it is an anonymous function or class (NamedEvaluation). */
  private named(node: Expression, name: string): Code {
    if (node.type === 'FunctionExpression' && !node.id) return this.functionExpr(node, name);
    if (node.type === 'ArrowFunctionExpression') return this.functionExpr(node, name);
    if (node.type === 'ClassExpression' && !node.id) return this.classCode(node, name);
    return this.expr(node);
  }

  /** Like named(), with the name known only when the code runs (a computed key). */
  private namedAtRuntime(node: Expression): (env: Env, name: string) => unknown {
    if (!isAnonymousFunctionDefinition(node)) {
      const c = this.expr(node).s;
      return (env) => c(env);
    }
    if (node.type === 'ClassExpression') {
      const make = this.classMaker(node);
      if (make.g !== null) throw new UnsupportedSyntax('await in the heritage of a class named by a computed key');
      return make.s;
    }
    const fi = this.functionInfo(node, '');
    return (env, name) => makeFunction(fi, env, undefined, name);
  }

  // ── Statements ──

  private statementList(list: readonly (Statement | ModuleDeclaration)[]): Code {
    const codes: Code[] = [];
    for (let j = 0; j < list.length; j++) {
      const s = list[j];
      const c = this.stmt(s, []);
      if (c !== null) append(codes, c);
    }
    if (everyItem(codes, (c) => c.g === null)) {
      const fns = mapList(codes, (c) => c.s);
      switch (fns.length) {
        case 0: return syncCode(() => undefined);
        case 1: return syncCode(fns[0]);
        case 2: {
          const a = fns[0], b = fns[1];
          return syncCode((env) => {
            const s = a(env);
            if (s !== undefined) return s;
            return b(env);
          });
        }
        default:
          return syncCode((env) => {
            for (let i = 0; i < fns.length; i++) {
              const s = fns[i](env);
              if (s !== undefined) return s;
            }
            return undefined;
          });
      }
    }
    return genCode(function* (env) {
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        const s = c.g !== null ? yield* c.g(env) : c.s(env);
        if (s !== undefined) return s;
      }
      return undefined;
    });
  }

  /** A statement's code, or null for one that does nothing when reached (a hoisted function). */
  private stmt(node: Statement | ModuleDeclaration, labels: Labels): Code | null {
    switch (node.type) {
      case 'ExpressionStatement': {
        const e = this.expr(node.expression);
        const es = e.s;
        const eg = e.g;
        if (eg) return genCode(function* (env) { yield* eg(env); return undefined; });
        return syncCode((env) => { es(env); return undefined; });
      }
      case 'BlockStatement': return this.blockStatement(node, node.body);
      case 'EmptyStatement': case 'DebuggerStatement': return null;
      case 'VariableDeclaration': return this.variableDeclaration(node);
      case 'FunctionDeclaration': return this.annexBFunction(node);
      case 'ClassDeclaration': {
        const binding = this.scope.bindings.get(node.id.name);
        if (!binding) throw new Error('interpreter: class without a binding');
        const write = this.initializer(binding);
        const c = this.classCode(node, node.id.name);
        return this.effect(c, (env, value) => write(env, value));
      }
      case 'ReturnStatement': {
        if (!node.argument) {
          const done = new Completion('return', null, undefined);
          return syncCode(() => done);
        }
        const arg = this.expr(node.argument);
        const as = arg.s;
        const ag = arg.g;
        if (ag) return genCode(function* (env) { return new Completion('return', null, yield* ag(env)); });
        return syncCode((env) => new Completion('return', null, as(env)));
      }
      case 'IfStatement': return this.ifStatement(node.test, node.consequent, node.alternate ?? null);
      case 'ThrowStatement': {
        const arg = this.expr(node.argument);
        const as = arg.s;
        const ag = arg.g;
        if (ag) return genCode(function* (env) { throw yield* ag(env); });
        return syncCode((env) => { throw as(env); });
      }
      case 'BreakStatement': {
        const signal = node.label ? labeledSignal('break', node.label.name) : BREAK;
        return syncCode(() => signal);
      }
      case 'ContinueStatement': {
        const signal = node.label ? labeledSignal('continue', node.label.name) : CONTINUE;
        return syncCode(() => signal);
      }
      case 'LabeledStatement': return this.labeled(node.label.name, node.body, labels);
      case 'WhileStatement': return this.loop(labels, null, node.test, null, node.body, false);
      case 'DoWhileStatement': return this.loop(labels, null, node.test, null, node.body, true);
      case 'ForStatement': return this.forStatement(node, labels);
      case 'ForInStatement': return this.forIn(node, labels);
      case 'ForOfStatement': return node.await ? this.forAwait(node, labels) : this.forOf(node, labels);
      case 'TryStatement': return this.tryStatement(node);
      case 'SwitchStatement': return this.switchStatement(node, labels);
      case 'WithStatement': return this.withStatement(node);
      case 'ImportDeclaration': return null;
      case 'ExportNamedDeclaration': return node.declaration ? this.stmt(node.declaration, labels) : null;
      case 'ExportDefaultDeclaration': return this.exportDefault(node.declaration);
      case 'ExportAllDeclaration': return null;
    }
  }

  /** Code for an expression evaluated for a side effect on its value. */
  private effect(c: Code, use: (env: Env, value: unknown) => void): Code {
    const cs = c.s;
    const cg = c.g;
    if (cg) return genCode(function* (env) { use(env, yield* cg(env)); return undefined; });
    return syncCode((env) => { use(env, cs(env)); return undefined; });
  }

  private exportDefault(decl: ExportDefaultDeclaration['declaration']): Code | null {
    if (decl.type === 'FunctionDeclaration') return null;
    const binding = decl.type === 'ClassDeclaration' && decl.id ? this.scope.bindings.get(decl.id.name) : this.scope.bindings.get('*default*');
    if (!binding) throw new Error('interpreter: default export without a binding');
    const write = this.initializer(binding);
    const c = decl.type === 'ClassDeclaration'
      ? this.classCode(decl, decl.id ? decl.id.name : 'default')
      : this.named(decl, 'default');
    return this.effect(c, write);
  }

  private annexBFunction(node: FunctionDeclaration): Code | null {
    const target = this.analysis.annexB.get(node);
    if (!target) return null;
    const source = this.scope.bindings.get(node.id.name);
    if (!source) return null;
    const read = this.slotReader(this.hops(source.scope), source.slot);
    const write = this.slotWriter(this.hops(target.scope), target.slot);
    return syncCode((env) => { write(env, read(env)); return undefined; });
  }

  private blockStatement(node: AnyNode, body: readonly Statement[]): Code {
    const scope = this.analysis.scopeOf(node);
    const entry = this.scopeEntry(scope);
    const list = this.withScope(scope, () => this.statementList(body));
    return this.entered(entry, list);
  }

  private variableDeclaration(node: VariableDeclaration): Code | null {
    const parts: Code[] = [];
    for (let i = 0; i < node.declarations.length; i++) {
      const d = node.declarations[i];
      if (!d.init) {
        // `let x;` initializes to undefined; `var x;` does nothing.
        if (node.kind === 'var') continue;
        const bind = this.patternBinder(d.id, true);
        append(parts, syncCode((env) => { bind(env, undefined); return undefined; }));
        continue;
      }
      const value = d.id.type === 'Identifier' ? this.named(d.init, d.id.name) : this.expr(d.init);
      // `let x = v` in this environment: the value written to its slot by one closure.
      const target = d.id.type === 'Identifier' ? this.analysis.ref(d.id) : null;
      if (target && target.binding && target.withs.length === 0 && value.g === null && this.hops(target.binding.scope) === 0
        && (node.kind !== 'var' || target.binding.kind === 'var')) {
        const slot = target.binding.slot;
        const vs = value.s;
        append(parts, syncCode((env) => { env[slot] = vs(env); return undefined; }));
        continue;
      }
      if (this.suspends(d.id)) {
        const bindGen = this.patternBinderGen(d.id, node.kind !== 'var');
        const vg = asGen(value);
        append(parts, genCode(function* (env) { yield* bindGen(env, yield* vg(env)); return undefined; }));
      } else {
        const bind = this.patternBinder(d.id, node.kind !== 'var');
        append(parts, this.effect(value, bind));
      }
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return this.sequenceStatements(parts);
  }

  private sequenceStatements(parts: Code[]): Code {
    if (everyItem(parts, (p) => p.g === null)) {
      const fns = mapList(parts, (p) => p.s);
      return syncCode((env) => {
        for (let i = 0; i < fns.length; i++) fns[i](env);
        return undefined;
      });
    }
    return genCode(function* (env) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.g !== null) yield* p.g(env); else p.s(env);
      }
      return undefined;
    });
  }

  private ifStatement(testNode: Expression, consequent: Statement, alternate: Statement | null): Code {
    const test = this.expr(testNode);
    const then = this.stmt(consequent, []) ?? syncCode(() => undefined);
    const otherwise = alternate ? this.stmt(alternate, []) ?? syncCode(() => undefined) : null;
    if (test.g === null && then.g === null && (otherwise === null || otherwise.g === null)) {
      const t = test.s;
      const a = then.s;
      if (otherwise === null) return syncCode((env) => (t(env) ? a(env) : undefined));
      const b = otherwise.s;
      return syncCode((env) => (t(env) ? a(env) : b(env)));
    }
    const tg = asGen(test);
    const ag = asGen(then);
    const bg = otherwise ? asGen(otherwise) : null;
    return genCode(function* (env) {
      if (yield* tg(env)) return yield* ag(env);
      return bg ? yield* bg(env) : undefined;
    });
  }

  private labeled(label: string, body: Statement, labels: Labels): Code | null {
    const all = withLast(labels, label);
    const isLoop = body.type === 'ForStatement' || body.type === 'ForInStatement' || body.type === 'ForOfStatement'
      || body.type === 'WhileStatement' || body.type === 'DoWhileStatement';
    if (body.type === 'LabeledStatement') return this.labeled(body.label.name, body.body, all);
    const inner = this.stmt(body, isLoop ? all : []);
    if (inner === null) return null;
    if (isLoop) return inner;
    // A labeled non-loop statement ends normally on a break to its label.
    const target = labeledSignal('break', label);
    const is = inner.s;
    const ig = inner.g;
    if (ig) return genCode(function* (env) { const s = yield* ig(env); return s === target ? undefined : s; });
    return syncCode((env) => { const s = is(env); return s === target ? undefined : s; });
  }

  /**
   * How a loop treats its body's completion: continue with the next
   * iteration, stop normally, or hand the completion out.
   */
  private loopControl(labels: Labels): (s: Completion) => LoopStep {
    const breaks = mapList(labels, (l) => labeledSignal('break', l));
    const continues = mapList(labels, (l) => labeledSignal('continue', l));
    return (s) => {
      if (s === CONTINUE) return 'next';
      if (s === BREAK) return 'stop';
      if (s.kind === 'continue' && contains(continues, s)) return 'next';
      if (s.kind === 'break' && contains(breaks, s)) return 'stop';
      return 'out';
    };
  }

  /** while, do-while, and for(;;) without per-iteration bindings. */
  private loop(labels: Labels, init: Code | null, testNode: Expression | null, updateNode: Expression | null, bodyNode: Statement, doWhile: boolean): Code {
    const control = this.loopControl(labels);
    const test = testNode ? this.expr(testNode) : null;
    const update = updateNode ? this.expr(updateNode) : null;
    const body = this.stmt(bodyNode, []) ?? syncCode(() => undefined);
    if (body.g === null && (test === null || test.g === null) && (update === null || update.g === null) && (init === null || init.g === null)) {
      const t = test ? test.s : null;
      const u = update ? update.s : null;
      const b = body.s;
      const i = init ? init.s : null;
      if (doWhile) {
        return syncCode((env) => {
          do {
            const s = b(env);
            if (s instanceof Completion) {
              const c = control(s);
              if (c === 'stop') break;
              if (c === 'out') return s;
            }
          } while (t === null || t(env));
          return undefined;
        });
      }
      return syncCode((env) => {
        if (i !== null) i(env);
        for (; t === null || t(env); u !== null && u(env)) {
          const s = b(env);
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'stop') break;
            if (c === 'out') return s;
          }
        }
        return undefined;
      });
    }
    const tg = test ? asGen(test) : null;
    const ug = update ? asGen(update) : null;
    const bg = asGen(body);
    const ig = init ? asGen(init) : null;
    if (doWhile) {
      return genCode(function* (env) {
        do {
          const s = yield* bg(env);
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'stop') break;
            if (c === 'out') return s;
          }
        } while (tg === null || (yield* tg(env)));
        return undefined;
      });
    }
    return genCode(function* (env) {
      if (ig !== null) yield* ig(env);
      for (;;) {
        if (tg !== null && !(yield* tg(env))) break;
        const s = yield* bg(env);
        if (s instanceof Completion) {
          const c = control(s);
          if (c === 'stop') break;
          if (c === 'out') return s;
        }
        if (ug !== null) yield* ug(env);
      }
      return undefined;
    });
  }

  private forStatement(node: ForStatement, labels: Labels): Code {
    const loopScope = this.analysis.scopes.get(node);
    if (!loopScope) {
      const init = node.init
        ? node.init.type === 'VariableDeclaration' ? this.variableDeclaration(node.init) : this.effect(this.expr(node.init), () => undefined)
        : null;
      return this.loop(labels, init, node.test ?? null, node.update ?? null, node.body, false);
    }
    // let/const in the head: a scope of its own, copied per iteration when captured.
    const entry = this.scopeEntry(loopScope);
    return this.withScope(loopScope, () => {
      const init = node.init && node.init.type === 'VariableDeclaration' ? this.variableDeclaration(node.init) : null;
      if (!loopScope.materialized) return this.entered(entry, this.loop(labels, init, node.test ?? null, node.update ?? null, node.body, false));
      return this.entered(entry, this.perIterationLoop(labels, init, node));
    });
  }

  /** for (let ...) whose bindings a closure captures: each iteration gets a copy of the environment. */
  private perIterationLoop(labels: Labels, init: Code | null, node: ForStatement): Code {
    const control = this.loopControl(labels);
    const test = node.test ? this.expr(node.test) : null;
    const update = node.update ? this.expr(node.update) : null;
    const body = this.stmt(node.body, []) ?? syncCode(() => undefined);
    const copy = (env: Env): Env => arraySliceFrom(env, 0);
    const ig = init ? asGen(init) : null;
    const tg = test ? asGen(test) : null;
    const ug = update ? asGen(update) : null;
    const bg = asGen(body);
    if (body.g === null && (test === null || test.g === null) && (update === null || update.g === null) && (init === null || init.g === null)) {
      const i = init ? init.s : null;
      const t = test ? test.s : null;
      const u = update ? update.s : null;
      const b = body.s;
      return syncCode((start) => {
        if (i !== null) i(start);
        let env = copy(start);
        for (;;) {
          if (t !== null && !t(env)) break;
          const s = b(env);
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'stop') break;
            if (c === 'out') return s;
          }
          env = copy(env);
          if (u !== null) u(env);
        }
        return undefined;
      });
    }
    return genCode(function* (start) {
      if (ig !== null) yield* ig(start);
      let env = copy(start);
      for (;;) {
        if (tg !== null && !(yield* tg(env))) break;
        const s = yield* bg(env);
        if (s instanceof Completion) {
          const c = control(s);
          if (c === 'stop') break;
          if (c === 'out') return s;
        }
        env = copy(env);
        if (ug !== null) yield* ug(env);
      }
      return undefined;
    });
  }

  /**
   * The left side of for-in/of: binds each value. A let/const head gets a
   * fresh environment per iteration (when materialized) before binding.
   */
  private forHead(node: ForInStatement | ForOfStatement): { scope: Scope | null; bind: (env: Env, value: unknown) => void; bindGen: ((env: Env, value: unknown) => Generator<unknown, void, unknown>) | null } {
    const left = node.left;
    const loopScope = this.analysis.scopes.get(node) ?? null;
    if (left.type === 'VariableDeclaration') {
      const pattern = left.declarations[0].id;
      const lexical = left.kind !== 'var';
      const compileBind = () => (this.suspends(pattern)
        ? { bind: suspendedBind, bindGen: this.patternBinderGen(pattern, lexical) }
        : { bind: this.patternBinder(pattern, lexical), bindGen: null });
      if (loopScope) return { scope: loopScope, ...this.withScope(loopScope, compileBind) };
      return { scope: null, ...compileBind() };
    }
    return this.suspends(left)
      ? { scope: null, bind: suspendedBind, bindGen: this.patternBinderGen(left, false) }
      : { scope: null, bind: this.patternBinder(left, false), bindGen: null };
  }

  private forIn(node: ForInStatement, labels: Labels): Code {
    const control = this.loopControl(labels);
    const right = this.rightOfForInOf(node);
    const head = this.forHead(node);
    const entry = head.scope ? this.scopeEntry(head.scope) : null;
    const body = (head.scope ? this.withScope(head.scope, () => this.stmt(node.body, [])) : this.stmt(node.body, [])) ?? syncCode(() => undefined);
    const bind = head.bind;
    if (body.g === null && right.g === null && head.bindGen === null) {
      const r = right.s;
      const b = body.s;
      return syncCode((env) => {
        const object = r(env);
        if (object === null || object === undefined) return undefined;
        for (const key in Object(object)) {
          const e = entry ? entry(env) : env;
          bind(e, key);
          const s = b(e);
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'stop') break;
            if (c === 'out') return s;
          }
        }
        return undefined;
      });
    }
    const rg = asGen(right);
    const bg = asGen(body);
    const bindGen = head.bindGen;
    return genCode(function* (env) {
      const object = yield* rg(env);
      if (object === null || object === undefined) return undefined;
      for (const key in Object(object)) {
        const e = entry ? entry(env) : env;
        if (bindGen) yield* bindGen(e, key); else bind(e, key);
        const s = yield* bg(e);
        if (s instanceof Completion) {
          const c = control(s);
          if (c === 'stop') break;
          if (c === 'out') return s;
        }
      }
      return undefined;
    });
  }

  /** The iterated expression, evaluated where the loop's own names are in their TDZ. */
  private rightOfForInOf(node: ForInStatement | ForOfStatement): Code {
    const tdzScope = this.analysis.scopes.get(node.right);
    if (!tdzScope) return this.expr(node.right);
    const entry = this.scopeEntry(tdzScope);
    const c = this.withScope(tdzScope, () => this.expr(node.right));
    if (entry === null) return c;
    const cs = c.s;
    const cg = c.g;
    if (cg) return genCode(function* (env) { return yield* cg(entry(env)); });
    return syncCode((env) => cs(entry(env)));
  }

  private forOf(node: ForOfStatement, labels: Labels): Code {
    const control = this.loopControl(labels);
    const right = this.rightOfForInOf(node);
    const head = this.forHead(node);
    const entry = head.scope ? this.scopeEntry(head.scope) : null;
    const body = (head.scope ? this.withScope(head.scope, () => this.stmt(node.body, [])) : this.stmt(node.body, [])) ?? syncCode(() => undefined);
    const bind = head.bind;
    if (body.g === null && right.g === null && head.bindGen === null) {
      const r = right.s;
      const b = body.s;
      return syncCode((env) => {
        const subject = r(env);
        for (const value of iterable(subject)) {
          const e = entry ? entry(env) : env;
          bind(e, value);
          const s = b(e);
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'stop') break;
            if (c === 'out') return s;
          }
        }
        return undefined;
      });
    }
    const rg = asGen(right);
    const bg = asGen(body);
    const bindGen = head.bindGen;
    return genCode(function* (env) {
      const subject = yield* rg(env);
      for (const value of iterable(subject)) {
        const e = entry ? entry(env) : env;
        if (bindGen) yield* bindGen(e, value); else bind(e, value);
        const s = yield* bg(e);
        if (s instanceof Completion) {
          const c = control(s);
          if (c === 'stop') break;
          if (c === 'out') return s;
        }
      }
      return undefined;
    });
  }

  /** `await x` inside this function's generator body. */
  private awaiter(): (x: unknown) => Generator<unknown, unknown, unknown> {
    if (this.shape === 'asyncGenerator') {
      return function* (x) {
        signalOperand(x);
        return yield AWAIT;
      };
    }
    return function* (x) { return yield x; };
  }

  private forAwait(node: ForOfStatement, labels: Labels): Code {
    const control = this.loopControl(labels);
    const right = asGen(this.rightOfForInOf(node));
    const head = this.forHead(node);
    const entry = head.scope ? this.scopeEntry(head.scope) : null;
    const body = asGen((head.scope ? this.withScope(head.scope, () => this.stmt(node.body, [])) : this.stmt(node.body, [])) ?? syncCode(() => undefined));
    const bind = head.bind;
    const bindGen = head.bindGen;
    const awaitValue = this.awaiter();
    return genCode(function* (env) {
      const iterable = yield* right(env);
      const ops = operators();
      let iterator: object;
      const asyncMethod: unknown = iterable === null || iterable === undefined ? undefined : ops.get(iterable, symbolAsyncIterator);
      if (asyncMethod === undefined || asyncMethod === null) {
        const syncMethod: unknown = iterable === null || iterable === undefined ? undefined : ops.get(iterable, symbolIterator);
        if (typeof syncMethod !== 'function') throw new TypeError(`${describe(iterable)} is not async iterable`);
        const syncIterator: unknown = reflectApply(syncMethod, iterable, []);
        if (!isObject(syncIterator)) throw new TypeError('Result of the symbolIterator method is not an object');
        iterator = asyncFromSyncIterator(syncIterator, reflectGet(syncIterator, 'next'));
      } else {
        if (typeof asyncMethod !== 'function') throw new TypeError(`${describe(iterable)} is not async iterable`);
        const it: unknown = reflectApply(asyncMethod, iterable, []);
        if (!isObject(it)) throw new TypeError('Result of the symbolAsyncIterator method is not an object');
        iterator = it;
      }
      const next: unknown = reflectGet(iterator, 'next');
      for (;;) {
        if (typeof next !== 'function') throw new TypeError('iterator.next is not a function');
        const result = yield* awaitValue(reflectApply(next, iterator, []));
        if (!isObject(result)) throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
        if (reflectGet(result, 'done')) return undefined;
        const value: unknown = reflectGet(result, 'value');
        let s: unknown;
        try {
          const e = entry ? entry(env) : env;
          if (bindGen) yield* bindGen(e, value); else bind(e, value);
          s = yield* body(e);
        } catch (error) {
          // AsyncIteratorClose with a throw completion: the original error wins.
          try {
            const ret: unknown = reflectGet(iterator, 'return');
            if (typeof ret === 'function') yield* awaitValue(reflectApply(ret, iterator, []));
          } catch { /* the body's error is what propagates */ }
          throw error;
        }
        if (s instanceof Completion) {
          const c = control(s);
          if (c === 'next') continue;
          const ret: unknown = reflectGet(iterator, 'return');
          if (ret !== undefined && ret !== null) {
            if (typeof ret !== 'function') throw new TypeError('iterator.return is not a function');
            const closed = yield* awaitValue(reflectApply(ret, iterator, []));
            if (!isObject(closed)) throw new TypeError(`Iterator result ${stringOf(closed)} is not an object`);
          }
          return c === 'stop' ? undefined : s;
        }
      }
    });
  }

  private tryStatement(node: TryStatement): Code {
    type Handler = {
      readonly s: (env: Env, error: unknown) => Signal;
      readonly g: ((env: Env, error: unknown) => Generator<unknown, Signal, unknown>) | null;
    };
    const block = this.blockStatement(node.block, node.block.body);
    // The catch clause: its parameter bound in its own scope, then its block.
    let handler: Handler | null = null;
    if (node.handler) {
      const clause = node.handler;
      const catchScope = this.analysis.scopeOf(clause);
      const entry = this.scopeEntry(catchScope);
      handler = this.withScope(catchScope, (): Handler => {
        const param = clause.param ?? null;
        const body = this.blockStatement(clause.body, clause.body.body);
        const bs = body.s;
        if (param && this.suspends(param)) {
          const bind = this.patternBinderGen(param, true);
          const run = asGen(body);
          return {
            s: suspendedSync,
            g: function* (env, error) {
              const e = entry ? entry(env) : env;
              yield* bind(e, error);
              return signalOf(yield* run(e));
            },
          };
        }
        const bind = param ? this.patternBinder(param, true) : null;
        const bg = body.g;
        return {
          s: (env, error) => {
            const e = entry ? entry(env) : env;
            if (bind) bind(e, error);
            return signalOf(bs(e));
          },
          g: bg === null ? null : function* (env, error) {
            const e = entry ? entry(env) : env;
            if (bind) bind(e, error);
            return signalOf(yield* bg(e));
          },
        };
      });
    }
    const finalizer = node.finalizer ? this.blockStatement(node.finalizer, node.finalizer.body) : null;
    const h = handler;
    if (block.g === null && (h === null || h.g === null) && (finalizer === null || finalizer.g === null)) {
      const b = block.s;
      const hs = h ? h.s : null;
      const f = finalizer ? finalizer.s : null;
      if (f === null && hs !== null) {
        return syncCode((env) => {
          try {
            return b(env);
          } catch (error) {
            return hs(env, error);
          }
        });
      }
      return syncCode((env) => {
        let s: unknown;
        try {
          s = b(env);
        } catch (error) {
          if (hs === null) throw error;
          s = hs(env, error);
        } finally {
          // A break, continue or return in finally replaces the completion, a thrown error included.
          if (f !== null) {
            const fs = f(env);
            if (fs !== undefined) return fs;
          }
        }
        return s;
      });
    }
    const bg = asGen(block);
    const hg = h === null ? null : h.g ?? ((env: Env, error: unknown) => (function* (): Generator<unknown, Signal, unknown> { return h.s(env, error); })());
    const fg = finalizer ? asGen(finalizer) : null;
    return genCode(function* (env) {
      let s: unknown;
      try {
        s = yield* bg(env);
      } catch (error) {
        if (hg === null) throw error;
        s = yield* hg(env, error);
      } finally {
        if (fg !== null) {
          const fs = yield* fg(env);
          if (fs !== undefined) return fs;
        }
      }
      return s;
    });
  }

  private switchStatement(node: SwitchStatement, labels: Labels): Code {
    const breakLabels = mapList(labels, (l) => labeledSignal('break', l));
    const discriminant = this.expr(node.discriminant);
    const scope = this.analysis.scopeOf(node);
    const entry = this.scopeEntry(scope);
    const { tests, bodies, defaultIndex } = this.withScope(scope, () => ({
      tests: mapList(node.cases, (c) => (c.test ? this.expr(c.test) : null)),
      bodies: mapList(node.cases, (c) => this.statementList(c.consequent)),
      defaultIndex: indexWhere(node.cases, (c) => !c.test),
    }));
    const finish = (s: unknown): unknown => {
      if (s === undefined) return undefined;
      if (s === BREAK) return undefined;
      if (s instanceof Completion && s.kind === 'break' && contains(breakLabels, s)) return undefined;
      return s;
    };
    const allSync = discriminant.g === null && everyItem(tests, (t) => t === null || t.g === null) && everyItem(bodies, (b) => b.g === null);
    if (allSync) {
      const d = discriminant.s;
      const ts = mapList(tests, (t) => (t ? t.s : null));
      const bs = mapList(bodies, (b) => b.s);
      return syncCode((outer) => {
        const value = d(outer);
        const env = entry ? entry(outer) : outer;
        let start = -1;
        for (let i = 0; i < ts.length; i++) {
          const t = ts[i];
          if (t !== null && t(env) === value) { start = i; break; }
        }
        if (start < 0) start = defaultIndex;
        if (start < 0) return undefined;
        for (let i = start; i < bs.length; i++) {
          const s = bs[i](env);
          if (s !== undefined) return finish(s);
        }
        return undefined;
      });
    }
    const dg = asGen(discriminant);
    const tgs = mapList(tests, (t) => (t ? asGen(t) : null));
    const bgs = mapList(bodies, (b) => asGen(b));
    return genCode(function* (outer) {
      const value = yield* dg(outer);
      const env = entry ? entry(outer) : outer;
      let start = -1;
      for (let i = 0; i < tgs.length; i++) {
        const t = tgs[i];
        if (t !== null && (yield* t(env)) === value) { start = i; break; }
      }
      if (start < 0) start = defaultIndex;
      if (start < 0) return undefined;
      for (let i = start; i < bgs.length; i++) {
        const s = yield* bgs[i](env);
        if (s !== undefined) return finish(s);
      }
      return undefined;
    });
  }

  private withStatement(node: WithStatement): Code {
    if (this.scope.strict) throw new UnsupportedSyntax('with in strict mode');
    const object = this.expr(node.object);
    const withScope = this.analysis.scopeOf(node);
    const body = this.withScope(withScope, () => this.stmt(node.body, []) ?? syncCode(() => undefined));
    const enter = (env: Env, target: unknown): Env => {
      if (target === null || target === undefined) throw new TypeError('Cannot convert undefined or null to object');
      const e: Env = new Array<unknown>(2);
      e[0] = env;
      e[1] = Object(target);
      return e;
    };
    if (object.g === null && body.g === null) {
      const o = object.s;
      const b = body.s;
      return syncCode((env) => b(enter(env, o(env))));
    }
    const og = asGen(object);
    const bg = asGen(body);
    return genCode(function* (env) { return yield* bg(enter(env, yield* og(env))); });
  }

  // ── Bindings: read, write, initialize ──

  /** Writes a value to slot `slot`, `hops` environments up. */
  private slotWriter(hops: number, slot: number): (env: Env, value: unknown) => void {
    switch (hops) {
      case 0: return (env, value) => { env[slot] = value; };
      case 1: return (env, value) => { up(env)[slot] = value; };
      default: return (env, value) => { upN(env, hops)[slot] = value; };
    }
  }

  /** Initializes a declaration's binding (no TDZ check, const allowed). */
  private initializer(binding: Binding): (env: Env, value: unknown) => void {
    return this.slotWriter(this.hops(binding.scope), binding.slot);
  }

  private read(id: Identifier, forTypeof = false): Sync {
    const ref = this.analysis.ref(id);
    let read = ref.binding ? this.bindingRead(ref.binding, ref.tdz) : this.globalRead(id.name, forTypeof);
    if (ref.withs.length > 0) read = this.withRead(ref, id.name, read);
    return read;
  }

  private bindingRead(b: Binding, tdz: boolean): Sync {
    const hops = this.hops(b.scope);
    const slot = b.slot;
    const raw = this.slotReader(hops, slot);
    const imported = this.imports.get(b);
    if (imported) {
      const ops = operators();
      const name = imported.name;
      if (imported.kind === 'named') return (env) => ops.get(raw(env), name);
      if (imported.kind === 'default') {
        return (env) => {
          const m = raw(env);
          return isObject(m) && reflectGet(m, '__esModule') ? ops.get(m, 'default') : m;
        };
      }
      return raw;
    }
    if (!tdz) return raw;
    const name = b.kind === 'special' ? 'this' : b.name;
    if (b.kind === 'special') {
      return (env) => {
        const v = raw(env);
        if (v === TDZ) throw new ReferenceError(THIS_BEFORE_SUPER);
        return v;
      };
    }
    if (hops === 0) {
      return (env) => {
        const v = env[slot];
        if (v === TDZ) throw tdzError(name);
        return v;
      };
    }
    return (env) => {
      const v = raw(env);
      if (v === TDZ) throw tdzError(name);
      return v;
    };
  }

  private globalRead(name: string, forTypeof: boolean): Sync {
    // The global object's undefined, NaN and Infinity are read-only and cannot be deleted.
    if (name === 'undefined') return () => undefined;
    if (name === 'NaN') return () => NaN;
    if (name === 'Infinity') return () => Infinity;
    const ops = operators();
    const get = ops.globalReader(name) ?? (() => ops.get(G, name));
    if (forTypeof) return get;
    return () => {
      const v = get();
      if (v === undefined && !reflectHas(G, name)) throw new ReferenceError(`${name} is not defined`);
      return v;
    };
  }

  private withObjects(ref: Reference): Array<(env: Env) => unknown> {
    return mapList(ref.withs, (w) => {
      const at = this.slotReader(this.hops(w), 1);
      return at;
    });
  }

  private withRead(ref: Reference, name: string, fallback: Sync): Sync {
    const objects = this.withObjects(ref);
    const ops = operators();
    return (env) => {
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i](env);
        if (withHas(o, name)) return ops.get(o, name);
      }
      return fallback(env);
    };
  }

  /** PutValue for an identifier: checks TDZ, const, and strictness. */
  private writer(id: Identifier): (env: Env, value: unknown) => void {
    const ref = this.analysis.ref(id);
    const name = id.name;
    const strict = this.scope.strict;
    const ops = operators();
    let write: (env: Env, value: unknown) => void;
    const b = ref.binding;
    if (b === null) {
      write = strict
        ? (_env, value) => {
          if (!reflectHas(G, name)) throw new ReferenceError(`${name} is not defined`);
          ops.set(G, name, value);
        }
        : (_env, value) => ops.setSloppy(G, name, value);
    } else {
      const hops = this.hops(b.scope);
      const slot = b.slot;
      const raw = this.slotWriter(hops, slot);
      const read = this.slotReader(hops, slot);
      if (b.kind === 'const' || b.kind === 'class' && b.scope.kind === 'class' || b.kind === 'import') {
        const tdz = ref.tdz;
        write = (env) => {
          if (tdz && read(env) === TDZ) throw tdzError(name);
          throw new TypeError('Assignment to constant variable.');
        };
      } else if (b.kind === 'callee') {
        write = strict ? () => { throw new TypeError('Assignment to constant variable.'); } : () => undefined;
      } else if (ref.tdz) {
        write = (env, value) => {
          if (read(env) === TDZ) throw tdzError(name);
          raw(env, value);
        };
      } else {
        write = raw;
      }
    }
    if (ref.withs.length === 0) return write;
    const objects = this.withObjects(ref);
    const fallback = write;
    return (env, value) => {
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i](env);
        if (withHas(o, name)) {
          if (strict) ops.set(o, name, value); else ops.setSloppy(o, name, value);
          return;
        }
      }
      fallback(env, value);
    };
  }

  // ── Patterns ──

  /**
   * Binds a value to a pattern: `init` initializes declarations (let,
   * const, parameters, catch), otherwise it assigns (var declarations and
   * assignment patterns go through PutValue).
   */
  patternBinder(pattern: Pattern, init: boolean): (env: Env, value: unknown) => void {
    switch (pattern.type) {
      case 'Identifier': {
        const ref = this.analysis.ref(pattern);
        if (init && ref.binding && ref.withs.length === 0) return this.initializer(ref.binding);
        return this.writer(pattern);
      }
      case 'MemberExpression': {
        const target = this.memberTarget(pattern);
        return (env, value) => target(env)(value);
      }
      case 'AssignmentPattern': {
        const inner = this.patternBinder(pattern.left, init);
        const dflt = pattern.left.type === 'Identifier' ? this.named(pattern.right, pattern.left.name).s : this.expr(pattern.right).s;
        return (env, value) => inner(env, value === undefined ? dflt(env) : value);
      }
      case 'ObjectPattern': return this.objectPatternBinder(pattern, init);
      case 'ArrayPattern': return this.arrayPatternBinder(pattern, init);
      case 'RestElement': return this.patternBinder(pattern.argument, init);
    }
  }

  /** A member expression as an assignment target: evaluates its reference, then returns its setter. */
  private memberTarget(node: MemberExpression): (env: Env) => (value: unknown) => void {
    const ops = operators();
    const strict = this.scope.strict;
    if (this.suspends(node)) throw new UnsupportedSyntax('await or yield inside a destructuring target');
    if (node.object.type === 'Super') {
      const key = this.memberKey(node);
      const home = this.homeObject(node.object);
      const thisValue = this.thisValue(node.object);
      return (env) => {
        const k = toPropertyKey(key(env));
        const receiver = thisValue(env);
        const proto: unknown = objectGetPrototypeOf(home(env));
        return (value) => {
          if (!isObject(proto) || (!reflectSet(proto, k, value, receiver) && strict)) {
            throw new TypeError(`Cannot assign to read only property '${stringOf(k)}' of object`);
          }
        };
      };
    }
    if (node.property.type === 'PrivateIdentifier') {
      const object = this.expr(node.object).s;
      const name = this.privateName(node.property);
      return (env) => {
        const o = object(env);
        const pn = name(env);
        return (value) => pn.set(o, value);
      };
    }
    const object = this.expr(node.object).s;
    const key = this.memberKey(node);
    const set = strict ? ops.set : ops.setSloppy;
    return (env) => {
      const o = object(env);
      const k = key(env);
      return (value) => set(o, k, value);
    };
  }

  private objectPatternBinder(pattern: ObjectPattern, init: boolean): (env: Env, value: unknown) => void {
    const ops = operators();
    type Step = (env: Env, source: unknown, used: PropertyKey[] | null) => void;
    const hasRest = someItem(pattern.properties, (p) => p.type === 'RestElement');
    const steps: Step[] = mapList(pattern.properties, (p): Step => {
      if (p.type === 'RestElement') {
        const bind = this.patternBinder(p.argument, init);
        if (p.argument.type === 'MemberExpression') {
          const target = this.memberTarget(p.argument);
          return (env, source, used) => {
            const set = target(env);
            const rest = {};
            copyDataProperties(rest, source, used);
            set(rest);
          };
        }
        return (env, source, used) => {
          const rest = {};
          copyDataProperties(rest, source, used);
          bind(env, rest);
        };
      }
      const key = this.propertyKey(p.key, p.computed);
      const value = p.value;
      const bind = this.patternBinder(value.type === 'AssignmentPattern' ? value.left : value, init);
      const target = value.type === 'AssignmentPattern' ? value.left : value;
      const dflt = value.type === 'AssignmentPattern'
        ? (value.left.type === 'Identifier' ? this.named(value.right, value.left.name).s : this.expr(value.right).s)
        : null;
      const member = target.type === 'MemberExpression' ? this.memberTarget(target) : null;
      return (env, source, used) => {
        const k = key(env);
        if (used !== null) used[used.length] = k;
        const set = member ? member(env) : null;
        let v = ops.get(source, k);
        if (v === undefined && dflt !== null) v = dflt(env);
        if (set) set(v); else bind(env, v);
      };
    });
    return (env, value) => {
      requireObjectCoercible(value);
      const used = hasRest ? [] : null;
      for (let i = 0; i < steps.length; i++) steps[i](env, value, used);
    };
  }

  private arrayPatternBinder(pattern: ArrayPattern, init: boolean): (env: Env, value: unknown) => void {
    type Target = ((env: Env) => (value: unknown) => void) | null;
    type Element = { kind: 'skip' }
      | { kind: 'rest'; bind: (env: Env, value: unknown) => void; member: Target }
      | { kind: 'one'; bind: (env: Env, value: unknown) => void; dflt: Sync | null; member: Target };
    const elements: Element[] = mapList(pattern.elements, (e): Element => {
      if (e === null) return { kind: 'skip' };
      if (e.type === 'RestElement') {
        return { kind: 'rest', bind: this.patternBinder(e.argument, init), member: e.argument.type === 'MemberExpression' ? this.memberTarget(e.argument) : null };
      }
      const target = e.type === 'AssignmentPattern' ? e.left : e;
      const dflt = e.type === 'AssignmentPattern'
        ? (e.left.type === 'Identifier' ? this.named(e.right, e.left.name).s : this.expr(e.right).s)
        : null;
      return { kind: 'one', bind: this.patternBinder(target, init), dflt, member: target.type === 'MemberExpression' ? this.memberTarget(target) : null };
    });
    return (env, value) => {
      if (plainArray(value)) {
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          if (el.kind === 'skip') continue;
          // A member target's reference is evaluated before the value is read.
          const set = el.member ? el.member(env) : null;
          let v: unknown;
          if (el.kind === 'rest') {
            v = arraySliceFrom(value, i);
          } else {
            v = value[i];
            if (v === undefined && el.dflt !== null) v = el.dflt(env);
          }
          if (set) set(v); else el.bind(env, v);
          if (el.kind === 'rest') break;
        }
        return;
      }
      const it = getIterator(value);
      try {
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const set = el.kind !== 'skip' && el.member ? el.member(env) : null;
          let v: unknown;
          if (el.kind === 'rest') {
            const rest: unknown[] = [];
            for (let x = it.step(); !it.done; x = it.step()) rest[rest.length] = x;
            v = rest;
          } else if (!it.done) {
            v = it.step();
          }
          if (el.kind === 'skip') continue;
          if (el.kind === 'one' && v === undefined && el.dflt !== null) v = el.dflt(env);
          if (set) set(v); else el.bind(env, v);
        }
      } catch (error) {
        if (!it.done) closeQuietly(it);
        throw error;
      }
      if (!it.done) it.close();
    };
  }

  /** The generator flavor of patternBinder, for patterns whose defaults, keys or targets await or yield. */
  patternBinderGen(pattern: Pattern, init: boolean): (env: Env, value: unknown) => Generator<unknown, void, unknown> {
    const ops = operators();
    switch (pattern.type) {
      case 'Identifier': {
        const bind = this.patternBinder(pattern, init);
        return function* (env, value) { bind(env, value); };
      }
      case 'MemberExpression': {
        // A lone target (a for-of head): its reference is evaluated after the value.
        const ref = this.memberTargetGen(pattern);
        return function* (env, value) { (yield* ref(env))(value); };
      }
      case 'AssignmentPattern': case 'RestElement': {
        const el = this.elementGen(pattern, init);
        return function* (env, value) { yield* el.assign(env, yield* el.reference(env), value); };
      }
      case 'ObjectPattern': {
        type Step = { readonly key: ((env: Env) => Generator<unknown, PropertyKey, unknown>) | null; readonly el: ElementGen };
        const steps = mapList(pattern.properties, (p): Step => {
          if (p.type === 'RestElement') return { key: null, el: this.elementGen(p.argument, init) };
          let key: (env: Env) => Generator<unknown, PropertyKey, unknown>;
          if (p.computed) {
            const k = asGen(this.expr(p.key));
            key = function* (env) { return toPropertyKey(yield* k(env)); };
          } else {
            const k = this.staticKey(p.key);
            key = function* () { return k; };
          }
          return { key, el: this.elementGen(p.value, init) };
        });
        return function* (env, value) {
          requireObjectCoercible(value);
          const used: PropertyKey[] = [];
          for (let i = 0; i < steps.length; i++) {
            const { key, el } = steps[i];
            if (key === null) {
              const target = yield* el.reference(env);
              const rest = {};
              copyDataProperties(rest, value, used);
              yield* el.assign(env, target, rest);
              continue;
            }
            const k = yield* key(env);
            used[used.length] = k;
            const target = yield* el.reference(env);
            yield* el.assign(env, target, ops.get(value, k));
          }
        };
      }
      case 'ArrayPattern': {
        const elements = mapList(pattern.elements, (e) => (e === null ? null : { rest: e.type === 'RestElement', el: this.elementGen(e.type === 'RestElement' ? e.argument : e, init) }));
        return function* (env, value) {
          const it = getIterator(value);
          // A generator's return() while suspended in here is a return
          // completion: it closes the iterator, and return()'s error wins.
          let threw = false;
          let finished = false;
          try {
            for (let i = 0; i < elements.length; i++) {
              const item = elements[i];
              const target = item ? yield* item.el.reference(env) : null;
              let v: unknown;
              if (item && item.rest) {
                const rest: unknown[] = [];
                for (let x = it.step(); !it.done; x = it.step()) rest[rest.length] = x;
                v = rest;
              } else if (!it.done) {
                v = it.step();
              }
              if (item) yield* item.el.assign(env, target, v);
            }
            finished = true;
          } catch (error) {
            threw = true;
            if (!it.done) closeQuietly(it);
            throw error;
          } finally {
            if (!finished && !threw && !it.done) it.close();
          }
          if (!it.done) it.close();
        };
      }
    }
  }

  /**
   * One element of a suspending pattern: a member target's reference,
   * evaluated before its value is read; then the default for an undefined
   * value, and the binding or assignment.
   */
  private elementGen(element: Pattern, init: boolean): ElementGen {
    const target = element.type === 'AssignmentPattern' ? element.left : element;
    const dflt = element.type === 'AssignmentPattern'
      ? asGen(element.left.type === 'Identifier' ? this.named(element.right, element.left.name) : this.expr(element.right))
      : null;
    if (target.type === 'MemberExpression') {
      const ref = this.memberTargetGen(target);
      return {
        reference: ref,
        * assign(env, set, value) {
          const v = value === undefined && dflt !== null ? yield* dflt(env) : value;
          if (set === null) throw new Error('interpreter: member target without a reference');
          set(v);
        },
      };
    }
    const bind = this.patternBinderGen(target, init);
    return {
      * reference() { return null; },
      * assign(env, _set, value) {
        yield* bind(env, value === undefined && dflt !== null ? yield* dflt(env) : value);
      },
    };
  }

  /** A member assignment target whose object or key awaits or yields: its setter, once its reference is evaluated. */
  private memberTargetGen(node: MemberExpression): (env: Env) => Generator<unknown, (value: unknown) => void, unknown> {
    if (!this.suspends(node)) {
      const target = this.memberTarget(node);
      return function* (env) { return target(env); };
    }
    if (node.object.type === 'Super') throw new UnsupportedSyntax('await or yield inside a super member key of a destructuring target');
    const ops = operators();
    const set = this.scope.strict ? ops.set : ops.setSloppy;
    const og = asGen(this.expr(node.object));
    if (node.property.type === 'PrivateIdentifier') {
      const name = this.privateName(node.property);
      return function* (env) {
        const o = yield* og(env);
        const pn = name(env);
        return (value) => pn.set(o, value);
      };
    }
    const kg = node.computed ? asGen(this.expr(node.property)) : null;
    const name = !node.computed && node.property.type === 'Identifier' ? node.property.name : '';
    return function* (env) {
      const o = yield* og(env);
      const k = kg ? yield* kg(env) : name;
      return (value) => set(o, k, value);
    };
  }

  private staticKey(key: Expression | PrivateIdentifier): PropertyKey {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return typeof key.value === 'bigint' ? stringOf(key.value) : stringOf(key.value);
    throw new Error(`interpreter: ${key.type} is not a static key`);
  }

  /** A property key: static, or computed and converted with ToPropertyKey. */
  private propertyKey(key: Expression | PrivateIdentifier, computed: boolean): (env: Env) => PropertyKey {
    if (!computed) {
      const k = this.staticKey(key);
      return () => k;
    }
    if (key.type === 'PrivateIdentifier') throw new Error('interpreter: private key in a pattern');
    const c = this.expr(key).s;
    return (env) => toPropertyKey(c(env));
  }

  // ── Expressions ──

  expr(node: Expression | PrivateIdentifier | Super | SpreadElement): Code {
    switch (node.type) {
      case 'Identifier': return syncCode(this.read(node));
      case 'Literal': return syncCode(this.literal(node));
      case 'ThisExpression': return syncCode(this.thisValue(node));
      case 'ArrayExpression': return this.arrayExpr(node);
      case 'ObjectExpression': return this.objectExpr(node);
      case 'FunctionExpression': case 'ArrowFunctionExpression': return this.functionExpr(node, '');
      case 'UnaryExpression': return this.unary(node);
      case 'UpdateExpression': return this.update(node);
      case 'BinaryExpression': return this.binary(node);
      case 'AssignmentExpression': return this.assignment(node);
      case 'LogicalExpression': return this.logical(node);
      case 'MemberExpression': return this.member(node, false);
      case 'ConditionalExpression': {
        const t = this.expr(node.test);
        const a = this.expr(node.consequent);
        const b = this.expr(node.alternate);
        if (t.g === null && a.g === null && b.g === null) {
          const ts = t.s;
          const as = a.s;
          const bs = b.s;
          return syncCode((env) => (ts(env) ? as(env) : bs(env)));
        }
        const tg = asGen(t);
        const ag = asGen(a);
        const bg = asGen(b);
        return genCode(function* (env) { return (yield* tg(env)) ? yield* ag(env) : yield* bg(env); });
      }
      case 'CallExpression': return this.call(node, false);
      case 'NewExpression': return this.newExpr(node);
      case 'SequenceExpression': {
        const parts = mapList(node.expressions, (e) => this.expr(e));
        if (everyItem(parts, (p) => p.g === null)) {
          const fns = mapList(parts, (p) => p.s);
          return syncCode((env) => {
            let v: unknown;
            for (let i = 0; i < fns.length; i++) v = fns[i](env);
            return v;
          });
        }
        const gens = mapList(parts, asGen);
        return genCode(function* (env) {
          let v: unknown;
          for (let i = 0; i < gens.length; i++) v = yield* gens[i](env);
          return v;
        });
      }
      case 'YieldExpression': return this.yieldExpr(node);
      case 'AwaitExpression': return this.awaitExpr(node);
      case 'TemplateLiteral': return this.template(node);
      case 'TaggedTemplateExpression': return this.tagged(node);
      case 'ClassExpression': return this.classCode(node, node.id ? node.id.name : '');
      case 'MetaProperty': return syncCode(this.metaProperty(node));
      case 'ChainExpression': {
        const inner = node.expression.type === 'CallExpression' ? this.call(node.expression, true) : this.member(node.expression, true);
        const is = inner.s;
        const ig = inner.g;
        if (ig) return genCode(function* (env) { const v = yield* ig(env); return v === SHORT ? undefined : v; });
        return syncCode((env) => { const v = is(env); return v === SHORT ? undefined : v; });
      }
      case 'ImportExpression': return this.importExpr(node);
      case 'ParenthesizedExpression': return this.expr(node.expression);
      case 'PrivateIdentifier': throw new Error('interpreter: a private name outside a member or `in`');
      case 'Super': throw new Error('interpreter: super outside a member or call');
      case 'SpreadElement': throw new Error('interpreter: spread outside a list');
    }
  }

  private literal(node: Literal): Sync {
    if (node.regex) {
      const { pattern, flags } = node.regex;
      return () => new RegExp(pattern, flags);
    }
    if (node.bigint !== undefined) {
      const value = BigInt(node.bigint);
      return () => value;
    }
    const value = node.value;
    return () => value;
  }

  private thisValue(node: AnyNode): Sync {
    const fs = this.analysis.receivers.get(node);
    if (!fs || !fs.thisBinding) throw new Error('interpreter: this without a receiver');
    const b = fs.thisBinding;
    const hops = this.hops(b.scope);
    const read = this.slotReader(hops, b.slot);
    if (fs.functionKind === 'script') return () => G;
    if (!b.tdz) return read;
    return (env) => {
      const v = read(env);
      if (v === TDZ) throw new ReferenceError(THIS_BEFORE_SUPER);
      return v;
    };
  }

  private homeObject(node: Super): (env: Env) => object {
    const fs = this.analysis.receivers.get(node);
    if (!fs || !fs.homeBinding) throw new Error('interpreter: super without a home object');
    const read = this.slotReader(this.hops(fs.homeBinding.scope), fs.homeBinding.slot);
    return (env) => {
      const home = read(env);
      if (!isObject(home)) throw new SyntaxError("'super' keyword unexpected here");
      return home;
    };
  }

  private metaProperty(node: MetaProperty): Sync {
    if (node.meta.name === 'new') {
      const fs = this.analysis.receivers.get(node);
      if (!fs || !fs.newTargetBinding) return () => undefined;
      return this.slotReader(this.hops(fs.newTargetBinding.scope), fs.newTargetBinding.slot);
    }
    // import.meta is the metadata the loader put on the module object (node-shims __loadModule).
    const moduleScope = this.analysis.moduleScope;
    const binding = moduleScope ? moduleScope.bindings.get('%module') : undefined;
    if (!moduleScope || !binding) throw new UnsupportedSyntax('import.meta outside a module');
    const read = this.slotReader(this.hops(moduleScope), binding.slot);
    const ops = operators();
    return (env) => ops.get(read(env), '__nimbusImportMeta');
  }

  private importExpr(node: ImportExpression): Code {
    const load = this.host.dynamicImport;
    const specifier = this.expr(node.source);
    const options = node.options ? this.expr(node.options) : null;
    const run = (spec: unknown, opts: unknown): Promise<unknown> => {
      if (!load) return Promise.reject(new TypeError('import() is not supported here'));
      return load(spec, opts);
    };
    if (specifier.g === null && (options === null || options.g === null)) {
      const s = specifier.s;
      const o = options ? options.s : null;
      return syncCode((env) => {
        const spec = s(env);
        return run(spec, o ? o(env) : undefined);
      });
    }
    const sg = asGen(specifier);
    const og = options ? asGen(options) : null;
    return genCode(function* (env) {
      const spec = yield* sg(env);
      return run(spec, og ? yield* og(env) : undefined);
    });
  }

  private awaitExpr(node: AwaitExpression): Code {
    const arg = this.expr(node.argument);
    const as = arg.s;
    const ag = arg.g;
    if (this.shape === 'asyncGenerator') {
      return genCode(function* (env) {
        const v = ag ? yield* ag(env) : as(env);
        signalOperand(v);
        return yield AWAIT;
      });
    }
    return genCode(function* (env) {
      return yield (ag ? yield* ag(env) : as(env));
    });
  }

  private yieldExpr(node: YieldExpression): Code {
    const arg = node.argument ? this.expr(node.argument) : null;
    const as = arg ? arg.s : null;
    const ag = arg ? arg.g : null;
    const async = this.shape === 'asyncGenerator';
    if (node.delegate) {
      if (async) {
        return genCode(function* (env) {
          const v = ag ? yield* ag(env) : as ? as(env) : undefined;
          signalOperand(v);
          return yield DELEGATE;
        });
      }
      return genCode(function* (env) {
        const v = ag ? yield* ag(env) : as ? as(env) : undefined;
        return yield* iterable(v);
      });
    }
    if (async) {
      return genCode(function* (env) {
        const v = ag ? yield* ag(env) : as ? as(env) : undefined;
        signalOperand(v);
        return yield YIELD;
      });
    }
    return genCode(function* (env) {
      return yield (ag ? yield* ag(env) : as ? as(env) : undefined);
    });
  }

  private template(node: TemplateLiteral): Code {
    const quasis = mapList(node.quasis, (q) => q.value.cooked ?? '');
    const parts = mapList(node.expressions, (e) => this.expr(e));
    if (parts.length === 0) {
      const text = quasis[0];
      return syncCode(() => text);
    }
    if (everyItem(parts, (p) => p.g === null)) {
      const fns = mapList(parts, (p) => p.s);
      if (fns.length === 1) {
        const head = quasis[0], tail = quasis[1];
        const f = fns[0];
        return syncCode((env) => `${head}${f(env)}${tail}`);
      }
      return syncCode((env) => {
        let s = quasis[0];
        for (let i = 0; i < fns.length; i++) s += `${fns[i](env)}${quasis[i + 1]}`;
        return s;
      });
    }
    const gens = mapList(parts, asGen);
    return genCode(function* (env) {
      let s = quasis[0];
      for (let i = 0; i < gens.length; i++) s += `${yield* gens[i](env)}${quasis[i + 1]}`;
      return s;
    });
  }

  private tagged(node: TaggedTemplateExpression): Code {
    const cooked = mapList(node.quasi.quasis, (q) => (q.value.cooked === null ? undefined : q.value.cooked));
    const raw = mapList(node.quasi.quasis, (q) => q.value.raw);
    // One template object per site, made the first time the site runs.
    let strings: readonly (string | undefined)[] | null = null;
    const site = () => {
      if (strings === null) strings = templateObject(cooked, raw);
      return strings;
    };
    const callee = this.callee(node.tag, false);
    const args = this.argumentList(node.quasi.expressions);
    const text = stringSlice(this.source, node.tag.start, node.tag.end);
    if (callee.g === null && args.g === null) {
      const c = callee.s;
      const a = args.s;
      return syncCode((env) => {
        const callee = c(env);
        return callValue(callee[0], callee[1], withFirst(site(), a(env)), text);
      });
    }
    const cg = asGen(callee);
    const ag = asGen(args);
    return genCode(function* (env) {
      const callee = yield* cg(env);
      return callValue(callee[0], callee[1], withFirst(site(), yield* ag(env)), text);
    });
  }

  private unary(node: UnaryExpression): Code {
    const ops = operators();
    if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
      const read = this.read(node.argument, true);
      return syncCode((env) => typeof read(env));
    }
    if (node.operator === 'delete') return this.deleteExpr(node.argument);
    const arg = this.expr(node.argument);
    let op: (v: unknown) => unknown;
    switch (node.operator) {
      case '!': op = (v) => !v; break;
      case '-': op = (v) => (typeof v === 'number' ? -v : ops.neg(v)); break;
      case '+': op = ops.plus; break;
      case '~': op = ops.bitNot; break;
      case 'typeof': op = (v) => typeof v; break;
      case 'void': op = () => undefined; break;
    }
    const as = arg.s;
    const ag = arg.g;
    if (ag) return genCode(function* (env) { return op(yield* ag(env)); });
    return syncCode((env) => op(as(env)));
  }

  private deleteExpr(argument: Expression): Code {
    const ops = operators();
    const strict = this.scope.strict;
    const remove = strict ? ops.remove : ops.removeSloppy;
    let target: Expression = argument;
    while (target.type === 'ParenthesizedExpression') target = target.expression;
    if (target.type === 'ChainExpression' && target.expression.type === 'MemberExpression') {
      const m = target.expression;
      const object = this.chainObject(m);
      const key = this.memberKey(m);
      return syncCode((env) => {
        const o = object(env);
        if (o === SHORT) return true;
        return remove(o, key(env));
      });
    }
    if (target.type === 'MemberExpression') {
      if (target.object.type === 'Super') {
        const thisValue = this.thisValue(target.object);
        return syncCode((env) => {
          thisValue(env);
          throw new ReferenceError("Unsupported reference to 'super'");
        });
      }
      const object = this.expr(target.object);
      const key = this.memberKey(target);
      if (object.g === null) {
        const os = object.s;
        return syncCode((env) => {
          const o = os(env);
          return remove(o, key(env));
        });
      }
      const og = object.g;
      return genCode(function* (env) {
        const o = yield* og(env);
        return remove(o, key(env));
      });
    }
    if (target.type === 'Identifier') {
      const ref = this.analysis.ref(target);
      const name = target.name;
      const objects = this.withObjects(ref);
      const isGlobal = ref.binding === null;
      return syncCode((env) => {
        for (let i = 0; i < objects.length; i++) {
          const o = objects[i](env);
          if (withHas(o, name)) return ops.removeSloppy(o, name);
        }
        return isGlobal ? ops.removeSloppy(G, name) : false;
      });
    }
    const value = this.expr(target);
    const vs = value.s;
    const vg = value.g;
    if (vg) return genCode(function* (env) { yield* vg(env); return true; });
    return syncCode((env) => { vs(env); return true; });
  }

  private binary(node: BinaryExpression): Code {
    const ops = operators();
    if (node.left.type === 'PrivateIdentifier') {
      const name = this.privateName(node.left);
      const right = this.expr(node.right);
      const rs = right.s;
      const rg = right.g;
      if (rg) return genCode(function* (env) { const pn = name(env); return pn.has(yield* rg(env)); });
      return syncCode((env) => name(env).has(rs(env)));
    }
    const l = this.expr(node.left);
    const r = this.expr(node.right);
    let op: (a: unknown, b: unknown) => unknown;
    switch (node.operator) {
      case '+': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : typeof a === 'string' && typeof b === 'string' ? a + b : ops.add(a, b)); break;
      case '-': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : ops.sub(a, b)); break;
      case '*': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a * b : ops.mul(a, b)); break;
      case '/': op = ops.div; break;
      case '%': op = ops.mod; break;
      case '**': op = ops.exp; break;
      case '<<': op = ops.shl; break;
      case '>>': op = ops.shr; break;
      case '>>>': op = ops.ushr; break;
      case '&': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a & b : ops.and(a, b)); break;
      case '|': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a | b : ops.or(a, b)); break;
      case '^': op = ops.xor; break;
      case '<': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a < b : ops.lt(a, b)); break;
      case '>': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a > b : ops.gt(a, b)); break;
      case '<=': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a <= b : ops.le(a, b)); break;
      case '>=': op = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a >= b : ops.ge(a, b)); break;
      case '==': op = (a, b) => a == b; break;
      case '!=': op = (a, b) => a != b; break;
      case '===': op = (a, b) => a === b; break;
      case '!==': op = (a, b) => a !== b; break;
      case 'in': op = ops.has; break;
      case 'instanceof': op = ops.instanceOf; break;
    }
    if (l.g === null && r.g === null) {
      const ls = l.s;
      const rs = r.s;
      // Against a constant: one closure for the comparison.
      const c = this.constant(node.right);
      if (c !== null) {
        const v = c.value;
        switch (node.operator) {
          case '===': return syncCode((env) => ls(env) === v);
          case '!==': return syncCode((env) => ls(env) !== v);
          case '==': return syncCode((env) => ls(env) == v);
          case '!=': return syncCode((env) => ls(env) != v);
          default: break;
        }
      }
      switch (node.operator) {
        case '===': return syncCode((env) => ls(env) === rs(env));
        case '!==': return syncCode((env) => ls(env) !== rs(env));
        default: return syncCode((env) => op(ls(env), rs(env)));
      }
    }
    const lg = asGen(l);
    const rg = asGen(r);
    return genCode(function* (env) {
      const a = yield* lg(env);
      return op(a, yield* rg(env));
    });
  }

  private logical(node: LogicalExpression): Code {
    const l = this.expr(node.left);
    const r = this.expr(node.right);
    const operator = node.operator;
    if (l.g === null && r.g === null) {
      const ls = l.s;
      const rs = r.s;
      if (operator === '&&') return syncCode((env) => ls(env) && rs(env));
      if (operator === '||') return syncCode((env) => ls(env) || rs(env));
      return syncCode((env) => ls(env) ?? rs(env));
    }
    const lg = asGen(l);
    const rg = asGen(r);
    return genCode(function* (env) {
      const a = yield* lg(env);
      if (operator === '&&' ? !a : operator === '||' ? a : a !== null && a !== undefined) return a;
      return yield* rg(env);
    });
  }

  /** The key of a non-private member expression. */
  private memberKey(node: MemberExpression): (env: Env) => unknown {
    if (!node.computed) {
      if (node.property.type !== 'Identifier') throw new Error('interpreter: dotted member without a name');
      const name = node.property.name;
      return () => name;
    }
    if (node.property.type === 'PrivateIdentifier') throw new Error('interpreter: computed private member');
    const c = this.expr(node.property);
    if (c.g !== null) throw new UnsupportedSyntax('await inside a computed member key of an assignment target');
    return c.s;
  }

  /** The object of a member in an optional chain: SHORT once the chain has short-circuited. */
  private chainObject(node: MemberExpression): (env: Env) => unknown {
    if (node.object.type === 'Super') throw new Error('interpreter: super in an optional chain');
    const object = this.chainPart(node.object).s;
    const optional = node.optional;
    return (env) => {
      const o = object(env);
      if (o === SHORT) return SHORT;
      if (optional && (o === null || o === undefined)) return SHORT;
      return o;
    };
  }

  /** Part of an optional chain: a member or call keeps propagating SHORT. */
  private chainPart(node: Expression): Code {
    if (node.type === 'MemberExpression') return this.member(node, true);
    if (node.type === 'CallExpression') return this.call(node, true);
    return this.expr(node);
  }

  private privateName(node: PrivateIdentifier): (env: Env) => PrivateName {
    const ref = this.analysis.privateRef(node);
    if (!ref.binding) throw new Error(`interpreter: undeclared private name #${node.name}`);
    const read = this.slotReader(this.hops(ref.binding.scope), ref.binding.slot);
    return (env) => {
      const pn = read(env);
      if (!(pn instanceof PrivateName)) throw new Error('interpreter: private name slot');
      return pn;
    };
  }

  private member(node: MemberExpression, inChain: boolean): Code {
    const ops = operators();
    if (node.object.type === 'Super') {
      const home = this.homeObject(node.object);
      const thisValue = this.thisValue(node.object);
      const key = this.memberKey(node);
      return syncCode((env) => {
        const receiver = thisValue(env);
        const k = toPropertyKey(key(env));
        const proto: unknown = objectGetPrototypeOf(home(env));
        if (!isObject(proto)) throw new TypeError(`Cannot read properties of ${stringOf(proto)} (reading '${stringOf(k)}')`);
        return reflectGet(proto, k, receiver);
      });
    }
    if (inChain && (node.optional || this.inChain(node.object))) {
      if (this.suspends(node)) return genCode(this.chainGen(node));
      const object = this.chainObject(node);
      if (node.property.type === 'PrivateIdentifier') {
        const name = this.privateName(node.property);
        return syncCode((env) => {
          const o = object(env);
          return o === SHORT ? SHORT : name(env).get(o);
        });
      }
      const key = this.memberKey(node);
      return syncCode((env) => {
        const o = object(env);
        return o === SHORT ? SHORT : ops.get(o, key(env));
      });
    }
    const object = this.expr(node.object);
    if (node.property.type === 'PrivateIdentifier') {
      const name = this.privateName(node.property);
      const os = object.s;
      const og = object.g;
      if (og) return genCode(function* (env) { const o = yield* og(env); return name(env).get(o); });
      return syncCode((env) => name(env).get(os(env)));
    }
    if (!node.computed) {
      if (node.property.type !== 'Identifier') throw new Error('interpreter: dotted member without a name');
      const name = node.property.name;
      const os = object.s;
      const og = object.g;
      if (og) return genCode(function* (env) { return ops.get(yield* og(env), name); });
      // A string's length is a keyed load V8 resolves slowly once megamorphic.
      if (name === 'length') return syncCode((env) => { const o = os(env); return typeof o === 'string' ? o.length : ops.get(o, 'length'); });
      const slot = this.localSlot(node.object);
      if (slot !== null) return syncCode((env) => ops.get(env[slot], name));
      return syncCode((env) => ops.get(os(env), name));
    }
    const key = this.expr(node.property);
    if (object.g === null && key.g === null) {
      const os = object.s;
      const ks = key.s;
      return syncCode((env) => {
        const o = os(env);
        return ops.get(o, ks(env));
      });
    }
    const og = asGen(object);
    const kg = asGen(key);
    return genCode(function* (env) {
      const o = yield* og(env);
      return ops.get(o, yield* kg(env));
    });
  }

  /**
   * An optional chain that awaits or yields: each link evaluated in order,
   * SHORT as soon as an optional link meets null or undefined.
   */
  private chainGen(node: Expression | Super): (env: Env) => Generator<unknown, unknown, unknown> {
    const ops = operators();
    if (node.type === 'MemberExpression' && node.object.type !== 'Super') {
      const object = this.chainGen(node.object);
      const optional = node.optional;
      const key = node.computed && node.property.type !== 'PrivateIdentifier' ? asGen(this.expr(node.property)) : null;
      const name = !node.computed && node.property.type === 'Identifier' ? node.property.name : '';
      const privateName = node.property.type === 'PrivateIdentifier' ? this.privateName(node.property) : null;
      return function* (env) {
        const o = yield* object(env);
        if (o === SHORT || (optional && (o === null || o === undefined))) return SHORT;
        if (privateName) return privateName(env).get(o);
        return ops.get(o, key ? yield* key(env) : name);
      };
    }
    if (node.type === 'CallExpression' && node.callee.type !== 'Super') {
      const callee = node.callee;
      const optional = node.optional;
      const args = asGen(this.argumentList(node.arguments));
      const text = stringSlice(this.source, callee.start, callee.end);
      if (callee.type === 'MemberExpression' && callee.object.type !== 'Super') {
        const object = this.chainGen(callee.object);
        const memberOptional = callee.optional;
        const key = callee.computed && callee.property.type !== 'PrivateIdentifier' ? asGen(this.expr(callee.property)) : null;
        const name = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : '';
        const privateName = callee.property.type === 'PrivateIdentifier' ? this.privateName(callee.property) : null;
        return function* (env) {
          const o = yield* object(env);
          if (o === SHORT || (memberOptional && (o === null || o === undefined))) return SHORT;
          const fn = privateName ? privateName(env).get(o) : ops.get(o, key ? yield* key(env) : name);
          if (optional && (fn === null || fn === undefined)) return SHORT;
          return callValue(fn, o, yield* args(env), text);
        };
      }
      const fnCode = this.chainGen(callee);
      return function* (env) {
        const fn = yield* fnCode(env);
        if (fn === SHORT || (optional && (fn === null || fn === undefined))) return SHORT;
        return callValue(fn, undefined, yield* args(env), text);
      };
    }
    return asGen(this.expr(node));
  }

  /**
   * The slot of `node` when it is a plain read of a binding in the current
   * environment (no TDZ check, no `with`, not an import): one closure can
   * then read it and use it.
   */
  private localSlot(node: Expression | Super): number | null {
    if (node.type !== 'Identifier') return null;
    const ref = this.analysis.ref(node);
    const b = ref.binding;
    if (!b || ref.tdz || ref.withs.length > 0 || this.imports.has(b) || this.hops(b.scope) !== 0) return null;
    return b.slot;
  }

  /** The value of `node` when it is a literal or the global `undefined`, known when compiling. */
  private constant(node: Expression): { readonly value: unknown } | null {
    if (node.type === 'Literal' && !node.regex && node.bigint === undefined) return { value: node.value };
    if (node.type === 'Identifier' && node.name === 'undefined' && this.analysis.ref(node).binding === null && this.analysis.ref(node).withs.length === 0) {
      return { value: undefined };
    }
    return null;
  }

  /** Whether a node continues an optional chain (contains an optional link below the chain root). */
  private inChain(node: Expression | Super): boolean {
    if (node.type === 'MemberExpression') return node.optional || this.inChain(node.object);
    if (node.type === 'CallExpression') return node.optional || this.inChain(node.callee);
    return false;
  }

  /**
   * A callee and the `this` a call through it gets: a member's object, a
   * `with` object holding the name, or undefined.
   */
  private callee(node: Expression | Super, inChain: boolean): CodeOf<Callee> {
    const ops = operators();
    if (node.type === 'MemberExpression') {
      if (node.object.type === 'Super') {
        const get = this.member(node, false);
        if (get.g !== null) throw new UnsupportedSyntax('await or yield inside a super member key');
        const gs = get.s;
        const thisValue = this.thisValue(node.object);
        return syncCode((env): Callee => [gs(env), thisValue(env)]);
      }
      if (inChain && (node.optional || this.inChain(node.object))) {
        const object = this.chainObject(node);
        if (node.property.type === 'PrivateIdentifier') {
          const name = this.privateName(node.property);
          return syncCode((env): Callee => {
            const o = object(env);
            return o === SHORT ? [SHORT, undefined] : [name(env).get(o), o];
          });
        }
        const key = this.memberKey(node);
        return syncCode((env): Callee => {
          const o = object(env);
          return o === SHORT ? [SHORT, undefined] : [ops.get(o, key(env)), o];
        });
      }
      const object = this.expr(node.object);
      const os = object.s;
      const og = object.g;
      if (node.property.type === 'PrivateIdentifier') {
        const name = this.privateName(node.property);
        if (og) return genCode(function* (env): Generator<unknown, Callee, unknown> { const o = yield* og(env); return [name(env).get(o), o]; });
        return syncCode((env): Callee => { const o = os(env); return [name(env).get(o), o]; });
      }
      if (!node.computed) {
        if (node.property.type !== 'Identifier') throw new Error('interpreter: dotted member without a name');
        const name = node.property.name;
        if (og) return genCode(function* (env): Generator<unknown, Callee, unknown> { const o = yield* og(env); return [ops.get(o, name), o]; });
        return syncCode((env): Callee => { const o = os(env); return [ops.get(o, name), o]; });
      }
      const key = this.expr(node.property);
      const ks = key.s;
      if (og === null && key.g === null) return syncCode((env): Callee => { const o = os(env); return [ops.get(o, ks(env)), o]; });
      const og2 = asGen(object);
      const kg = asGen(key);
      return genCode(function* (env): Generator<unknown, Callee, unknown> {
        const o = yield* og2(env);
        return [ops.get(o, yield* kg(env)), o];
      });
    }
    if (node.type === 'Identifier') {
      const ref = this.analysis.ref(node);
      if (ref.withs.length === 0) {
        const read = this.read(node);
        return syncCode((env): Callee => [read(env), undefined]);
      }
      // Inside `with`: the object that has the name is also the call's `this`.
      const name = node.name;
      const objects = this.withObjects(ref);
      const fallback = ref.binding ? this.bindingRead(ref.binding, ref.tdz) : this.globalRead(name, false);
      return syncCode((env): Callee => {
        for (let i = 0; i < objects.length; i++) {
          const o = objects[i](env);
          if (withHas(o, name)) return [ops.get(o, name), o];
        }
        return [fallback(env), undefined];
      });
    }
    if (node.type === 'Super') throw new Error('interpreter: super() is a super call');
    // `(a?.b)()`: the chain's value is a reference, so the call keeps `a` as `this`.
    if (node.type === 'ChainExpression' && node.expression.type === 'MemberExpression' && !this.suspends(node)) {
      const pair = this.callee(node.expression, true);
      const ps = pair.s;
      return syncCode((env): Callee => {
        const p = ps(env);
        return p[0] === SHORT ? [undefined, undefined] : p;
      });
    }
    const c = inChain ? this.chainPart(node) : this.expr(node);
    const cs = c.s;
    const cg = c.g;
    if (cg) return genCode(function* (env): Generator<unknown, Callee, unknown> { return [yield* cg(env), undefined]; });
    return syncCode((env): Callee => [cs(env), undefined]);
  }

  /** Arguments evaluated into an array (spreads iterate). */
  private argumentList(args: readonly (Expression | SpreadElement)[]): CodeOf<unknown[]> {
    const parts = mapList(args, (a) => (a.type === 'SpreadElement' ? { spread: true, code: this.expr(a.argument) } : { spread: false, code: this.expr(a) }));
    if (everyItem(parts, (p) => p.code.g === null)) {
      const fns = mapList(parts, (p) => p.code.s);
      if (!someItem(parts, (p) => p.spread)) {
        switch (fns.length) {
          case 0: return syncCode(() => []);
          case 1: { const a = fns[0]; return syncCode((env) => [a(env)]); }
          case 2: { const a = fns[0], b = fns[1]; return syncCode((env) => [a(env), b(env)]); }
          case 3: { const a = fns[0], b = fns[1], c = fns[2]; return syncCode((env) => [a(env), b(env), c(env)]); }
          default: return syncCode((env) => {
            const out = new Array<unknown>(fns.length);
            for (let i = 0; i < fns.length; i++) out[i] = fns[i](env);
            return out;
          });
        }
      }
      const spreads = mapList(parts, (p) => p.spread);
      return syncCode((env) => {
        const out: unknown[] = [];
        for (let i = 0; i < fns.length; i++) {
          const v = fns[i](env);
          if (spreads[i]) for (const x of iterable(v)) out[out.length] = x; else out[out.length] = v;
        }
        return out;
      });
    }
    const gens = mapList(parts, (p) => ({ spread: p.spread, g: asGen(p.code) }));
    return genCode(function* (env) {
      const out: unknown[] = [];
      for (let i = 0; i < gens.length; i++) {
        const p = gens[i];
        const v = yield* p.g(env);
        if (p.spread) for (const x of iterable(v)) out[out.length] = x; else out[out.length] = v;
      }
      return out;
    });
  }

  private call(node: CallExpression, inChain: boolean): Code {
    if (node.callee.type === 'Super') return this.superCallExpr(node);
    if (inChain && this.suspends(node)) return genCode(this.chainGen(node));
    const text = stringSlice(this.source, node.callee.start, node.callee.end);
    const argNodes = node.arguments;
    // A plain `f(a, b)` through a binding: no callee pair, no argument array.
    if (!inChain && node.callee.type === 'Identifier' && argNodes.length <= 3
      && everyItem(argNodes, (x) => x.type !== 'SpreadElement' && !this.suspends(x))
      && this.analysis.ref(node.callee).withs.length === 0) {
      const read = this.read(node.callee);
      const fns = mapList(argNodes, (x) => (x.type === 'SpreadElement' ? suspendedSync : this.expr(x).s));
      const check = (f: unknown): Function => {
        if (typeof f !== 'function') throw new TypeError(`${text} is not a function`);
        return f;
      };
      switch (fns.length) {
        case 0: return syncCode((env) => check(read(env))());
        case 1: { const x = fns[0]; return syncCode((env) => { const f = check(read(env)); return f(x(env)); }); }
        case 2: { const x = fns[0], y = fns[1]; return syncCode((env) => { const f = check(read(env)); return f(x(env), y(env)); }); }
        default: { const x = fns[0], y = fns[1], z = fns[2]; return syncCode((env) => { const f = check(read(env)); return f(x(env), y(env), z(env)); }); }
      }
    }
    const member = this.memberCall(node, inChain, text);
    if (member !== null) return member;
    const callee = this.callee(node.callee, inChain);
    const args = this.argumentList(argNodes);
    const optional = node.optional;
    if (callee.g === null && args.g === null) {
      const c = callee.s;
      const a = args.s;
      return syncCode((env) => {
        const callee = c(env);
        const fn = callee[0];
        const thisArg = callee[1];
        if (fn === SHORT) return SHORT;
        if (optional && (fn === null || fn === undefined)) return SHORT;
        return callValue(fn, thisArg, a(env), text);
      });
    }
    const cg = asGen(callee);
    const ag = asGen(args);
    return genCode(function* (env) {
      const callee = yield* cg(env);
      const fn = callee[0];
      const thisArg = callee[1];
      if (fn === SHORT) return SHORT;
      if (optional && (fn === null || fn === undefined)) return SHORT;
      return callValue(fn, thisArg, yield* ag(env), text);
    });
  }

  /** `o.m(a, b)` with nothing suspending: the method and its receiver without a pair, the arguments without spreads. */
  private memberCall(node: CallExpression, inChain: boolean, text: string): Code | null {
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.object.type === 'Super' || callee.property.type === 'PrivateIdentifier') return null;
    if (inChain || node.optional || node.arguments.length > 3 || this.suspends(node)) return null;
    if (someItem(node.arguments, (a) => a.type === 'SpreadElement')) return null;
    const ops = operators();
    const os = this.expr(callee.object).s;
    const key = callee.computed ? this.expr(callee.property).s : null;
    const name = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : '';
    const fns = mapList(node.arguments, (a) => (a.type === 'SpreadElement' ? suspendedSync : this.expr(a).s));
    const method = (o: unknown, env: Env): unknown => ops.get(o, key ? key(env) : name);
    const notFunction = () => new TypeError(`${text} is not a function`);
    switch (fns.length) {
      case 0: return syncCode((env) => {
        const o = os(env);
        const f = method(o, env);
        if (typeof f !== 'function') throw notFunction();
        return reflectApply(f, o, []);
      });
      case 1: {
        const x = fns[0];
        return syncCode((env) => {
          const o = os(env);
          const f = method(o, env);
          const a = x(env);
          if (typeof f !== 'function') throw notFunction();
          return reflectApply(f, o, [a]);
        });
      }
      case 2: {
        const x = fns[0], y = fns[1];
        return syncCode((env) => {
          const o = os(env);
          const f = method(o, env);
          const a = x(env);
          const b = y(env);
          if (typeof f !== 'function') throw notFunction();
          return reflectApply(f, o, [a, b]);
        });
      }
      default: {
        const x = fns[0], y = fns[1], z = fns[2];
        return syncCode((env) => {
          const o = os(env);
          const f = method(o, env);
          const a = x(env);
          const b = y(env);
          const c = z(env);
          if (typeof f !== 'function') throw notFunction();
          return reflectApply(f, o, [a, b, c]);
        });
      }
    }
  }

  private superCallExpr(node: CallExpression): Code {
    const fs = this.analysis.receivers.get(node.callee);
    if (!fs || !fs.thisBinding || !fs.funcBinding || !fs.newTargetBinding) throw new Error('interpreter: super() outside a derived constructor');
    const at = this.envAt(this.hops(fs));
    const thisSlot = fs.thisBinding.slot;
    const funcSlot = fs.funcBinding.slot;
    const newTargetSlot = fs.newTargetBinding.slot;
    const args = this.argumentList(node.arguments);
    const bind = (env: Env, list: unknown[]): unknown => {
      const frame = at(env);
      const ctor = frame[funcSlot];
      if (typeof ctor !== 'function') throw new Error('interpreter: super() without its constructor');
      const instance = superConstruct(ctor, list, frame[newTargetSlot]);
      if (frame[thisSlot] !== TDZ) throw new ReferenceError('Super constructor may only be called once');
      frame[thisSlot] = instance;
      initializeInstance(ctor, instance);
      return instance;
    };
    const as = args.s;
    const ag = args.g;
    if (ag) return genCode(function* (env) { return bind(env, yield* ag(env)); });
    return syncCode((env) => bind(env, as(env)));
  }

  private newExpr(node: NewExpression): Code {
    const callee = this.expr(node.callee);
    const args = this.argumentList(node.arguments);
    const text = stringSlice(this.source, node.callee.start, node.callee.end);
    if (callee.g === null && args.g === null) {
      const c = callee.s;
      const a = args.s;
      return syncCode((env) => {
        const fn = c(env);
        return constructValue(fn, a(env), text);
      });
    }
    const cg = asGen(callee);
    const ag = asGen(args);
    return genCode(function* (env) {
      const fn = yield* cg(env);
      return constructValue(fn, yield* ag(env), text);
    });
  }

  private arrayExpr(node: ArrayExpression): Code {
    const parts = mapList(node.elements, (e) => (e === null ? null : e.type === 'SpreadElement' ? { spread: true, code: this.expr(e.argument) } : { spread: false, code: this.expr(e) }));
    if (everyItem(parts, (p) => p === null || p.code.g === null)) {
      if (everyItem(parts, (p) => p !== null && !p.spread)) {
        const fns = mapList(parts, (p) => (p ? p.code.s : suspendedSync));
        switch (fns.length) {
          case 0: return syncCode(() => []);
          case 1: { const a = fns[0]; return syncCode((env) => [a(env)]); }
          case 2: { const a = fns[0], b = fns[1]; return syncCode((env) => [a(env), b(env)]); }
          case 3: { const a = fns[0], b = fns[1], c = fns[2]; return syncCode((env) => [a(env), b(env), c(env)]); }
          case 4: { const a = fns[0], b = fns[1], c = fns[2], d = fns[3]; return syncCode((env) => [a(env), b(env), c(env), d(env)]); }
          default: return syncCode((env) => {
            const out = new Array<unknown>(fns.length);
            for (let i = 0; i < fns.length; i++) out[i] = fns[i](env);
            return out;
          });
        }
      }
      const items = mapList(parts, (p) => (p === null ? null : { spread: p.spread, f: p.code.s }));
      return syncCode((env) => {
        const out: unknown[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item === null) out.length++;
          else if (item.spread) for (const v of iterable(item.f(env))) out[out.length] = v;
          else out[out.length] = item.f(env);
        }
        return out;
      });
    }
    const items = mapList(parts, (p) => (p === null ? null : { spread: p.spread, g: asGen(p.code) }));
    return genCode(function* (env) {
      const out: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === null) { out.length++; continue; }
        const v = yield* item.g(env);
        if (item.spread) for (const x of iterable(v)) out[out.length] = x;
        else out[out.length] = v;
      }
      return out;
    });
  }

  private objectExpr(node: ObjectExpression): Code {
    type Part =
      | { kind: 'spread'; value: Code }
      | { kind: 'proto'; value: Code }
      | { kind: 'data'; key: KeyCode; value: Code | null; named: ((env: Env, name: string) => unknown) | null }
      | { kind: 'method' | 'get' | 'set'; key: KeyCode; fi: FunctionInfo };
    const parts: Part[] = mapList(node.properties, (p): Part => {
      if (p.type === 'SpreadElement') return { kind: 'spread', value: this.expr(p.argument) };
      const key: KeyCode = p.computed ? { computed: this.expr(p.key) } : { static: this.staticKey(p.key) };
      if (!p.computed && !p.shorthand && !p.method && p.kind === 'init' && 'static' in key && key.static === '__proto__') {
        return { kind: 'proto', value: this.expr(p.value) };
      }
      if (p.kind !== 'init' || p.method) {
        if (p.value.type !== 'FunctionExpression') throw new Error('interpreter: method without a function');
        const name = 'static' in key ? functionName(key.static, p.kind === 'init' ? undefined : p.kind) : '';
        // A method's source text is its whole definition, key included.
        return { kind: p.kind === 'init' ? 'method' : p.kind, key, fi: this.functionInfo(p.value, name, undefined, stringSlice(this.source, p.start, p.value.end)) };
      }
      if ('static' in key) return { kind: 'data', key, value: this.named(p.value, functionName(key.static)), named: null };
      if (isAnonymousFunctionDefinition(p.value)) return { kind: 'data', key, value: null, named: this.namedAtRuntime(p.value) };
      return { kind: 'data', key, value: this.expr(p.value), named: null };
    });
    const suspends = someItem(parts, (p) => ((p.kind === 'spread' || p.kind === 'proto') && p.value.g !== null)
      || ((p.kind === 'data' || p.kind === 'method' || p.kind === 'get' || p.kind === 'set') && 'computed' in p.key && p.key.computed.g !== null)
      || (p.kind === 'data' && p.value !== null && p.value.g !== null));
    // Static keys and plain values only: a template copied with own data
    // properties (define semantics), then filled in.
    if (!suspends && everyItem(parts, (p) => p.kind === 'data' && 'static' in p.key || p.kind === 'method' && 'static' in p.key || p.kind === 'proto')) {
      const template: Record<PropertyKey, unknown> = {};
      const seen = new SafeSet<PropertyKey>();
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        if ((p.kind === 'data' || p.kind === 'method') && 'static' in p.key && !seen.has(p.key.static)) {
          seen.add(p.key.static);
          createDataProperty(template, p.key.static, undefined);
        }
      }
      // Data properties only (most literals): the values written in order.
      if (everyItem(parts, (p) => p.kind === 'data')) {
        if (parts.length === 0) return syncCode(() => ({}));
        const keys = mapList(parts, (p) => (p.kind === 'data' && 'static' in p.key ? p.key.static : ''));
        const values = mapList(parts, (p) => (p.kind === 'data' && p.value !== null ? p.value.s : suspendedSync));
        return syncCode((env) => {
          const o: Record<PropertyKey, unknown> = { ...template };
          for (let i = 0; i < keys.length; i++) o[keys[i]] = values[i](env);
          return o;
        });
      }
      const fills = mapList(parts, (p) => {
        if (p.kind === 'proto') return { proto: p.value.s, key: '' as PropertyKey, value: null, fi: null };
        if (p.kind === 'data' && 'static' in p.key && p.value !== null) return { proto: null, key: p.key.static, value: p.value.s, fi: null };
        if (p.kind === 'method' && 'static' in p.key) return { proto: null, key: p.key.static, value: null, fi: p.fi };
        throw new Error('interpreter: object template');
      });
      return syncCode((env) => {
        const o: Record<PropertyKey, unknown> = { ...template };
        for (let i = 0; i < fills.length; i++) {
          const f = fills[i];
          if (f.proto !== null) {
            const proto = f.proto(env);
            if (isObject(proto) || proto === null) reflectSetPrototypeOf(o, proto);
          } else if (f.fi !== null) {
            o[f.key] = makeFunction(f.fi, env, o);
          } else if (f.value !== null) {
            o[f.key] = f.value(env);
          }
        }
        return o;
      });
    }
    const keyOf = (key: KeyCode, env: Env): PropertyKey => ('static' in key ? key.static : toPropertyKey(key.computed.s(env)));
    function* keyOfGen(key: KeyCode, env: Env): Generator<unknown, PropertyKey, unknown> {
      if ('static' in key) return key.static;
      const g = key.computed.g;
      return toPropertyKey(g ? yield* g(env) : key.computed.s(env));
    }
    const apply = (o: object, p: Part, k: PropertyKey, value: unknown, env: Env) => {
      switch (p.kind) {
        case 'spread': copyDataProperties(o, value, null); return;
        case 'proto': if (isObject(value) || value === null) reflectSetPrototypeOf(o, value); return;
        case 'data': createDataProperty(o, k, value); return;
        case 'method': {
          const fn = makeFunction(p.fi, env, o, 'computed' in p.key ? functionName(k) : p.fi.name);
          createDataProperty(o, k, fn);
          return;
        }
        case 'get': case 'set': {
          const fn = makeFunction(p.fi, env, o, 'computed' in p.key ? functionName(k, p.kind) : p.fi.name);
          defineAccessor(o, k, p.kind, fn, true);
          return;
        }
      }
    };
    if (!suspends) {
      return syncCode((env) => {
        const o = {};
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.kind === 'spread' || p.kind === 'proto') { apply(o, p, '', p.value.s(env), env); continue; }
          const k = keyOf(p.key, env);
          if (p.kind === 'data') {
            const v = p.value !== null ? p.value.s(env) : p.named !== null ? p.named(env, functionName(k)) : undefined;
            apply(o, p, k, v, env);
          } else {
            apply(o, p, k, undefined, env);
          }
        }
        return o;
      });
    }
    return genCode(function* (env) {
      const o = {};
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.kind === 'spread' || p.kind === 'proto') {
          const g = p.value.g;
          apply(o, p, '', g ? yield* g(env) : p.value.s(env), env);
          continue;
        }
        const k = yield* keyOfGen(p.key, env);
        if (p.kind === 'data') {
          let v: unknown;
          if (p.value !== null) {
            const g = p.value.g;
            v = g ? yield* g(env) : p.value.s(env);
          } else if (p.named !== null) {
            v = p.named(env, functionName(k));
          }
          apply(o, p, k, v, env);
        } else {
          apply(o, p, k, undefined, env);
        }
      }
      return o;
    });
  }

  // ── Assignment and update ──

  private assignment(node: AssignmentExpression): Code {
    const ops = operators();
    const left = node.left;
    const operator = node.operator;
    if (operator === '=' && (left.type === 'ObjectPattern' || left.type === 'ArrayPattern')) {
      const value = this.expr(node.right);
      if (this.suspends(left)) {
        const bind = this.patternBinderGen(left, false);
        const vg = asGen(value);
        return genCode(function* (env) { const v = yield* vg(env); yield* bind(env, v); return v; });
      }
      const bind = this.patternBinder(left, false);
      const vs = value.s;
      const vg = value.g;
      if (vg) return genCode(function* (env) { const v = yield* vg(env); bind(env, v); return v; });
      return syncCode((env) => { const v = vs(env); bind(env, v); return v; });
    }
    const logical = operator === '&&=' || operator === '||=' || operator === '??=';
    // A parenthesized target (`(f) = function () {}`) does not name the function.
    const named = left.type === 'Identifier' && node.start === left.start && (operator === '=' || logical);
    const right = named && left.type === 'Identifier' ? this.named(node.right, left.name) : this.expr(node.right);
    const op = operator === '=' || logical ? null : binaryOperator(stringSlice(operator, 0, -1), ops);
    const shortCircuit = (v: unknown): boolean => (operator === '&&=' ? !v : operator === '||=' ? Boolean(v) : v !== null && v !== undefined);
    const rs = right.s;
    // The common targets, without a reference object: a binding, or a member with a plain object expression.
    if (right.g === null && left.type === 'Identifier') {
      const write = this.writer(left);
      if (operator === '=') return syncCode((env) => { const v = rs(env); write(env, v); return v; });
      const read = this.read(left);
      if (op !== null) return syncCode((env) => { const v = op(read(env), rs(env)); write(env, v); return v; });
      return syncCode((env) => {
        const current = read(env);
        if (shortCircuit(current)) return current;
        const v = rs(env);
        write(env, v);
        return v;
      });
    }
    if (right.g === null && left.type === 'MemberExpression' && left.object.type !== 'Super' && left.property.type !== 'PrivateIdentifier') {
      const object = this.expr(left.object);
      const key = left.computed ? this.expr(left.property) : null;
      if (object.g === null && (key === null || key.g === null)) {
        const os = object.s;
        const set = this.scope.strict ? ops.set : ops.setSloppy;
        if (key === null) {
          if (left.property.type !== 'Identifier') throw new Error('interpreter: dotted member without a name');
          const name = left.property.name;
          if (operator === '=') return syncCode((env) => { const o = os(env); const v = rs(env); set(o, name, v); return v; });
          if (op !== null) return syncCode((env) => { const o = os(env); const v = op(ops.get(o, name), rs(env)); set(o, name, v); return v; });
          return syncCode((env) => {
            const o = os(env);
            const current = ops.get(o, name);
            if (shortCircuit(current)) return current;
            const v = rs(env);
            set(o, name, v);
            return v;
          });
        }
        const ks = key.s;
        if (operator === '=') return syncCode((env) => { const o = os(env); const k = ks(env); const v = rs(env); set(o, k, v); return v; });
        return syncCode((env) => {
          const o = os(env);
          const raw = ks(env);
          if (o === null || o === undefined) throw nullBase(o, raw);
          const k = keyOnce(raw);
          const current = ops.get(o, k);
          if (op === null && shortCircuit(current)) return current;
          const v = op !== null ? op(current, rs(env)) : rs(env);
          set(o, k, v);
          return v;
        });
      }
    }
    const ref = this.reference(left);
    const rg = right.g;
    if (operator === '=') {
      if (ref.g === null && rg === null) {
        const r = ref.s;
        return syncCode((env) => {
          const target = r(env);
          const v = rs(env);
          target.set(v);
          return v;
        });
      }
      const refg = asGen(ref);
      return genCode(function* (env) {
        const target = yield* refg(env);
        const v = rg ? yield* rg(env) : rs(env);
        target.set(v);
        return v;
      });
    }
    if (ref.g === null && rg === null) {
      const r = ref.s;
      return syncCode((env) => {
        const target = r(env);
        const current = target.get();
        if (op === null && shortCircuit(current)) return current;
        const v = op !== null ? op(current, rs(env)) : rs(env);
        target.set(v);
        return v;
      });
    }
    const refg = asGen(ref);
    return genCode(function* (env) {
      const target = yield* refg(env);
      const current = target.get();
      if (op === null && shortCircuit(current)) return current;
      const r = rg ? yield* rg(env) : rs(env);
      const v = op !== null ? op(current, r) : r;
      target.set(v);
      return v;
    });
  }

  /**
   * An assignment target as a reference: evaluating it fixes the object and
   * key (or binding), and get/set act on them.
   */
  private reference(node: Pattern | Expression): CodeOf<RefValue> {
    const ops = operators();
    if (node.type === 'Identifier') {
      const read = this.read(node);
      const write = this.writer(node);
      return { s: (env) => ({ get: () => read(env), set: (v) => write(env, v) }), g: null };
    }
    if (node.type !== 'MemberExpression') throw new Error(`interpreter: ${node.type} is not a simple assignment target`);
    const strict = this.scope.strict;
    const set = strict ? ops.set : ops.setSloppy;
    if (node.object.type === 'Super') {
      const home = this.homeObject(node.object);
      const thisValue = this.thisValue(node.object);
      const key = this.memberKey(node);
      return {
        s: (env) => {
          const receiver = thisValue(env);
          const raw = key(env);
          let pk: PropertyKey | null = null;
          const k = (): PropertyKey => (pk === null ? (pk = toPropertyKey(raw)) : pk);
          const proto: unknown = objectGetPrototypeOf(home(env));
          return {
            get: () => (isObject(proto) ? reflectGet(proto, k(), receiver) : undefined),
            set: (v) => {
              const name = k();
              if (!isObject(proto) || (!reflectSet(proto, name, v, receiver) && strict)) {
                throw new TypeError(`Cannot assign to read only property '${stringOf(name)}' of object`);
              }
            },
          };
        },
        g: null,
      };
    }
    const object = this.expr(node.object);
    if (node.property.type === 'PrivateIdentifier') {
      const name = this.privateName(node.property);
      const os = object.s;
      const og = object.g;
      const make = (o: unknown, pn: PrivateName): RefValue => ({ get: () => pn.get(o), set: (v) => pn.set(o, v) });
      return { s: (env) => make(os(env), name(env)), g: og ? function* (env) { return make(yield* og(env), name(env)); } : null };
    }
    const key = node.computed ? this.expr(node.property) : null;
    const staticName = !node.computed && node.property.type === 'Identifier' ? node.property.name : '';
    const make = (o: unknown, k: unknown): RefValue => {
      // The key converts once, on the reference's first use: after the
      // right side of a plain assignment, before it in a compound one.
      if (o === null || o === undefined) throw nullBase(o, k);
      let pk: PropertyKey | null = null;
      const key = (): PropertyKey => (pk === null ? (pk = toPropertyKey(k)) : pk);
      return { get: () => ops.get(o, key()), set: (v) => set(o, key(), v) };
    };
    if (key === null) {
      const os = object.s;
      const og = object.g;
      return {
        s: (env) => {
          const o = os(env);
          return { get: () => ops.get(o, staticName), set: (v) => set(o, staticName, v) };
        },
        g: og ? function* (env) { const o = yield* og(env); return { get: () => ops.get(o, staticName), set: (v: unknown) => set(o, staticName, v) }; } : null,
      };
    }
    if (object.g === null && key.g === null) {
      const os = object.s;
      const ks = key.s;
      return { s: (env) => { const o = os(env); return make(o, ks(env)); }, g: null };
    }
    const og = asGen(object);
    const kg = asGen(key);
    return genCode(function* (env) { const o = yield* og(env); return make(o, yield* kg(env)); });
  }

  private update(node: UpdateExpression): Code {
    const ops = operators();
    const inc = node.operator === '++';
    const prefix = node.prefix;
    /** The new value and the expression's result, from the old value. */
    const step = (old: unknown, set: (v: unknown) => void): unknown => {
      if (typeof old === 'number') {
        const next = inc ? old + 1 : old - 1;
        set(next);
        return prefix ? next : old;
      }
      const numeric = ops.numeric(old);
      const next = inc ? ops.increment(numeric) : ops.decrement(numeric);
      set(next);
      return prefix ? next : numeric;
    };
    const argument = node.argument;
    if (argument.type === 'Identifier') {
      const ref = this.analysis.ref(argument);
      const b = ref.binding;
      // `i++` on a slot of this environment: no closures at all.
      if (b && !ref.tdz && ref.withs.length === 0 && (b.kind === 'var' || b.kind === 'let' || b.kind === 'param') && this.hops(b.scope) === 0) {
        const slot = b.slot;
        return syncCode((env) => {
          const old = env[slot];
          if (typeof old === 'number') {
            const next = inc ? old + 1 : old - 1;
            env[slot] = next;
            return prefix ? next : old;
          }
          return step(old, (v) => { env[slot] = v; });
        });
      }
      const read = this.read(argument);
      const write = this.writer(argument);
      return syncCode((env) => {
        const old = read(env);
        if (typeof old === 'number') {
          const next = inc ? old + 1 : old - 1;
          write(env, next);
          return prefix ? next : old;
        }
        return step(old, (v) => write(env, v));
      });
    }
    if (argument.type === 'MemberExpression' && argument.object.type !== 'Super' && argument.property.type !== 'PrivateIdentifier') {
      const object = this.expr(argument.object);
      const key = argument.computed ? this.expr(argument.property) : null;
      if (object.g === null && (key === null || key.g === null)) {
        const os = object.s;
        const set = this.scope.strict ? ops.set : ops.setSloppy;
        const name = !argument.computed && argument.property.type === 'Identifier' ? argument.property.name : '';
        const ks = key ? key.s : null;
        return syncCode((env) => {
          const o = os(env);
          const raw = ks ? ks(env) : name;
          if (o === null || o === undefined) throw nullBase(o, raw);
          const k = keyOnce(raw);
          const old = ops.get(o, k);
          if (typeof old === 'number') {
            const next = inc ? old + 1 : old - 1;
            set(o, k, next);
            return prefix ? next : old;
          }
          return step(old, (v) => set(o, k, v));
        });
      }
    }
    const ref = this.reference(argument);
    const rs = ref.s;
    const rg = ref.g;
    if (rg) return genCode(function* (env) { const target = yield* rg(env); return step(target.get(), (v) => target.set(v)); });
    return syncCode((env) => { const target = rs(env); return step(target.get(), (v) => target.set(v)); });
  }

  // ── Classes ──

  classCode(node: ClassNode, name: string): Code {
    const make = this.classMaker(node);
    const ms = make.s;
    const mg = make.g;
    if (mg) return genCode(function* (env) { return yield* mg(env, name); });
    return syncCode((env) => ms(env, name));
  }

  /** ClassDefinitionEvaluation, with the class's name given when it runs. */
  private classMaker(node: ClassNode): {
    readonly s: (env: Env, name: string) => unknown;
    readonly g: ((env: Env, name: string) => Generator<unknown, unknown, unknown>) | null;
  } {
    const scopes = this.analysis.classes.get(node);
    if (!scopes) throw new Error('interpreter: class without analysis');
    const classScope = scopes.scope;
    const entry = this.scopeEntry(classScope);
    // The heritage runs in the class's scope, where its name is in its TDZ.
    const heritage = node.superClass ? this.withScope(classScope, () => (node.superClass ? this.expr(node.superClass) : null)) : null;
    const { define, keys, privateNames } = this.withScope(classScope, () => this.classDefinition(node, scopes.instanceFields, scopes.staticFields, classScope));
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
          const computed = new Array<PropertyKey>(ks.length);
          for (let i = 0; i < ks.length; i++) computed[i] = toPropertyKey(ks[i](classEnv));
          return define(classEnv, parent, name, computed);
        },
        g: null,
      };
    }
    const hg = heritage ? asGen(heritage) : null;
    const kgs = mapList(keys, asGen);
    return {
      s: suspendedSync,
      g: function* (env, name) {
        const classEnv = enter(env);
        const parent = hg ? yield* hg(classEnv) : undefined;
        const computed = new Array<PropertyKey>(kgs.length);
        for (let i = 0; i < kgs.length; i++) computed[i] = toPropertyKey(yield* kgs[i](classEnv));
        return define(classEnv, parent, name, computed);
      },
    };
  }

  private classDefinition(
    node: ClassNode, instanceFields: FunctionScope | null, staticFields: FunctionScope | null, classScope: Scope,
  ): {
    readonly define: (classEnv: Env, parent: unknown, name: string, computed: readonly PropertyKey[]) => Function;
    readonly keys: readonly Code[];
    readonly privateNames: ReadonlyArray<{ readonly slot: number; readonly kind: 'field' | 'method' | 'accessor'; readonly description: string }>;
  } {
    const body: ClassBody = node.body;
    const derived = Boolean(node.superClass);
    const ctorIndex = indexWhere(body.body, (m) => m.type === 'MethodDefinition' && m.kind === 'constructor');
    const ctorMember = ctorIndex < 0 ? null : body.body[ctorIndex];
    const ctorNode = ctorMember !== null && ctorMember.type === 'MethodDefinition' ? ctorMember : null;
    const className = node.id ? node.id.name : '';
    const classSource = stringSlice(this.source, node.start, node.end);
    let ctorInfo: FunctionInfo;
    if (ctorNode) {
      ctorInfo = this.functionInfo(ctorNode.value, className, derived ? 'classDerived' : 'classBase', classSource);
    } else {
      ctorInfo = new FunctionInfo(derived ? 'classDerived' : 'classBase', className, 0, true, classSource);
      ctorInfo.implicit = true;
    }

    const innerBinding = node.id ? classScope.bindings.get(node.id.name) ?? null : null;
    const writeInner = innerBinding ? this.slotWriter(0, innerBinding.slot) : null;
    type Element =
      | { kind: 'method'; isStatic: boolean; key: ElementKey; fi: FunctionInfo; accessor: 'get' | 'set' | null }
      | { kind: 'field'; isStatic: boolean; key: ElementKey; value: Sync | null; named: ((env: Env, name: string) => unknown) | null }
      | { kind: 'static'; fi: FunctionInfo };
    const computedKeys: Code[] = [];
    const elements: Element[] = [];
    const privateNames: Array<{ slot: number; kind: 'field' | 'method' | 'accessor'; description: string }> = [];
    const declaredPrivate = new SafeSet<string>();
    for (let j = 0; j < body.body.length; j++) {
      const member = body.body[j];
      if (member.type === 'StaticBlock') {
        append(elements, { kind: 'static', fi: this.staticBlockInfo(member) });
        continue;
      }
      if (member.type === 'MethodDefinition' && member.kind === 'constructor') continue;
      let key: ElementKey;
      let staticName: string | null = null;
      if (member.key.type === 'PrivateIdentifier') {
        const pname = `#${member.key.name}`;
        const binding = classScope.bindings.get(pname);
        if (!binding) throw new Error('interpreter: private name without a binding');
        if (!declaredPrivate.has(pname)) {
          declaredPrivate.add(pname);
          append(privateNames, { slot: binding.slot, kind: member.type === 'PropertyDefinition' ? 'field' : member.kind === 'method' ? 'method' : 'accessor', description: pname });
        }
        key = { private: this.privateName(member.key) };
        staticName = pname;
      } else if (member.computed) {
        key = { computed: computedKeys.length };
        append(computedKeys, this.expr(member.key));
      } else {
        const k = this.staticKey(member.key);
        key = { static: k };
        staticName = functionName(k);
      }
      if (member.type === 'MethodDefinition') {
        const accessor = member.kind === 'get' || member.kind === 'set' ? member.kind : null;
        const fname = staticName === null ? '' : accessor ? `${accessor} ${staticName}` : staticName;
        // A method's source text is its definition without `static`.
        const source = stringSlice(this.source, member.static ? this.afterStatic(member.start) : member.start, member.value.end);
        append(elements, { kind: 'method', isStatic: member.static, key, fi: this.functionInfo(member.value, fname, undefined, source), accessor });
        continue;
      }
      const fieldScope = member.static ? staticFields : instanceFields;
      let value: Sync | null = null;
      let named: ((env: Env, name: string) => unknown) | null = null;
      if (member.value) {
        if (!fieldScope) throw new Error('interpreter: field without a scope');
        const init = member.value;
        this.withFunctionScope(fieldScope, 'method', () => {
          if (staticName !== null) value = this.named(init, staticName).s;
          else named = this.namedAtRuntime(init);
        });
      }
      append(elements, { kind: 'field', isStatic: member.static, key, value, named });
    }
    const instanceFi = instanceFields ? this.fieldInfo(instanceFields) : null;
    const staticFi = staticFields ? this.fieldInfo(staticFields) : null;
    const runtimeEnter = (fi: FunctionInfo, scope: Env, thisArg: unknown, home: object): Env => {
      const env: Env = new Array<unknown>(fi.size);
      env[0] = scope;
      if (fi.thisSlot !== 0) env[fi.thisSlot] = thisArg;
      if (fi.homeSlot !== 0) env[fi.homeSlot] = home;
      return env;
    };

    const define = (classEnv: Env, parent: unknown, name: string, computed: readonly PropertyKey[]): Function => {
      const record = new ClassRecord();
      const C = makeClass(ctorInfo, classEnv, parent, name, record);
      const protoValue: unknown = reflectGet(C, 'prototype');
      if (!isObject(protoValue)) throw new Error('interpreter: class without a prototype');
      const proto = protoValue;
      type FieldRecord = { key: PropertyKey | PrivateName; value: Sync | null; named: ((env: Env, name: string) => unknown) | null };
      const instanceFieldList: FieldRecord[] = [];
      const instancePrivateMethods: PrivateName[] = [];
      const staticWork: Array<{ field: FieldRecord } | { block: FunctionInfo }> = [];
      const staticPrivateMethods: PrivateName[] = [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.kind === 'static') { staticWork[staticWork.length] = { block: el.fi }; continue; }
        const target = el.isStatic ? C : proto;
        let key: PropertyKey | PrivateName;
        if ('private' in el.key) key = el.key.private(classEnv);
        else if ('static' in el.key) key = el.key.static;
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
            if (!contains(list, key)) list[list.length] = key;
          } else if (el.accessor) {
            defineAccessor(target, key, el.accessor, fn, false);
          } else {
            defineMethod(target, key, fn, false);
          }
          continue;
        }
        const record: FieldRecord = { key, value: el.value, named: el.named };
        if (el.isStatic) staticWork[staticWork.length] = { field: record };
        else instanceFieldList[instanceFieldList.length] = record;
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
        const fieldEnv = instanceFi ? runtimeEnter(instanceFi, classEnv, instance, proto) : null;
        for (let i = 0; i < instanceFieldList.length; i++) defineField(fieldEnv, instance, instanceFieldList[i]);
      };
      record.initialize = initialize;
      record.home = proto;
      if (writeInner) writeInner(classEnv, C);
      for (let i = 0; i < staticPrivateMethods.length; i++) staticPrivateMethods[i].add(C, undefined);
      const staticEnv = staticFi ? runtimeEnter(staticFi, classEnv, C, C) : null;
      for (let i = 0; i < staticWork.length; i++) {
        const work = staticWork[i];
        if ('block' in work) {
          const fi = work.block;
          if (fi.body) fi.body(runtimeEnter(fi, classEnv, C, C));
        } else {
          defineField(staticEnv, C, work.field);
        }
      }
      return C;
    };
    return { define, keys: computedKeys, privateNames };
  }

  /** The offset after a class member's `static` keyword (and the whitespace after it). */
  private afterStatic(start: number): number {
    return skipTrivia(this.source, start + 'static'.length);
  }

  /** Compile with `fs` as the current function (field initializers, static blocks). */
  private withFunctionScope<T>(fs: FunctionScope, shape: FunctionShape, f: () => T): T {
    const saved = { scope: this.scope, shape: this.shape };
    this.scope = fs;
    this.shape = shape;
    try {
      return f();
    } finally {
      this.scope = saved.scope;
      this.shape = saved.shape;
    }
  }

  /** The frame layout of a class's field initializer scope. */
  private fieldInfo(fs: FunctionScope): FunctionInfo {
    const fi = new FunctionInfo('method', '', 0, true, '');
    fi.size = fs.size;
    if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
    if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
    return fi;
  }

  private staticBlockInfo(block: StaticBlock): FunctionInfo {
    const fs = this.analysis.functionScopeOf(block);
    const fi = new FunctionInfo('method', '', 0, true, '');
    this.withFunctionScope(fs, 'method', () => {
      fi.size = fs.size;
      if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
      if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
      const entry = this.scopeEntry(fs, true);
      const list = this.statementList(block.body);
      fi.body = this.entered(entry, list).s;
    });
    return fi;
  }

  // ── Units ──

  /** A program's top level (module or script), as a body over its root environment. */
  programBody(program: Program, root: FunctionScope): Code {
    const entry = this.scopeEntry(root, true);
    const globals = root.globalVars;
    let list: Code;
    if (root.functionKind === 'module') {
      const saved = this.shape;
      this.shape = 'async';
      try {
        list = this.statementList(program.body);
      } finally {
        this.shape = saved;
      }
    } else {
      list = this.statementList(program.body);
    }
    const body = this.entered(entry, list);
    if (globals.length === 0) return body;
    // A script's vars are properties of the global object, created before it runs.
    const declare = (env: Env): Env => {
      for (let i = 0; i < globals.length; i++) {
        const name = globals[i];
        if (!objectHasOwn(G, name)) reflectDefineProperty(G, name, { value: undefined, writable: true, enumerable: true, configurable: false });
      }
      return env;
    };
    return this.entered(declare, body);
  }

  /** A CommonJS body: a function of the wrapper's parameters. */
  commonJsFunction(program: Program, root: FunctionScope, params: readonly string[]): FunctionInfo {
    const fi = new FunctionInfo('plain', '', params.length, root.strict, this.source);
    fi.size = root.size;
    if (root.thisBinding) fi.thisSlot = root.thisBinding.slot;
    if (root.argumentsBinding) fi.argumentsSlot = root.argumentsBinding.slot;
    fi.params = mapList(params, (name) => {
      const b = root.bindings.get(name);
      if (!b) throw new Error('interpreter: wrapper parameter');
      return b.slot;
    });
    const code = this.programBody(program, root);
    if (code.g !== null) throw new UnsupportedSyntax('await at the top level of a CommonJS module');
    fi.body = code.s;
    return fi;
  }

  /**
   * An ES module as a module cell: called with the five CommonJS wrapper
   * arguments, it requires what it imports, replaces module.exports with
   * its exports (live getters, `__esModule` set), and runs its body. Imports
   * and exports behave as esbuild's lowering to CommonJS, which is what the
   * same text becomes in the next launch: a default import is the module's
   * `default` when it has `__esModule`, else the module itself; a namespace
   * import is esbuild's __toESM of it. With top-level await, the cell
   * returns the promise of the body.
   */
  moduleCell(program: Program, root: FunctionScope): ModuleCell {
    const ops = operators();
    const slotOf = (name: string): number => {
      const b = root.bindings.get(name);
      if (!b) throw new Error(`interpreter: module binding ${name}`);
      return b.slot;
    };
    const exportsSlot = slotOf('%exports');
    const requireSlot = slotOf('%require');
    const moduleSlot = slotOf('%module');
    const filenameSlot = slotOf('%filename');
    const dirnameSlot = slotOf('%dirname');
    type Load = (env: Env, require: (id: string) => unknown) => void;
    const loads: Load[] = [];
    const getters: Array<[name: string, read: (env: Env) => unknown]> = [];
    const starSources: Array<(env: Env) => unknown> = [];
    const sourceOf = (node: Literal): string => {
      if (typeof node.value !== 'string') throw new Error('interpreter: module specifier');
      return node.value;
    };
    const exportedName = (node: Identifier | Literal): string => (node.type === 'Identifier' ? node.name : stringOf(node.value));
    for (let n = 0; n < program.body.length; n++) {
      const statement = program.body[n];
      if (statement.type === 'ImportDeclaration') {
        const source = sourceOf(statement.source);
        const slots: Array<{ slot: number; namespace: boolean }> = [];
        for (let k = 0; k < statement.specifiers.length; k++) {
          const spec = statement.specifiers[k];
          const binding = root.bindings.get(spec.local.name);
          if (!binding) throw new Error('interpreter: import binding');
          if (spec.type === 'ImportDefaultSpecifier') this.imports.set(binding, { kind: 'default', name: 'default' });
          else if (spec.type === 'ImportNamespaceSpecifier') this.imports.set(binding, { kind: 'namespace', name: '*' });
          else this.imports.set(binding, { kind: 'named', name: exportedName(spec.imported) });
          append(slots, { slot: binding.slot, namespace: spec.type === 'ImportNamespaceSpecifier' });
        }
        append(loads, (env, require) => {
          const m = require(source);
          for (let i = 0; i < slots.length; i++) env[slots[i].slot] = slots[i].namespace ? toESM(m) : m;
        });
      } else if (statement.type === 'ExportAllDeclaration') {
        const source = sourceOf(statement.source);
        const slot = root.size++;
        append(loads, (env, require) => { env[slot] = require(source); });
        if (statement.exported) {
          let namespace: unknown;
          let made = false;
          append(getters, [exportedName(statement.exported), (env) => {
            if (!made) { namespace = toESM(env[slot]); made = true; }
            return namespace;
          }]);
        } else {
          append(starSources, (env) => env[slot]);
        }
      } else if (statement.type === 'ExportNamedDeclaration') {
        if (statement.source) {
          const source = sourceOf(statement.source);
          const slot = root.size++;
          append(loads, (env, require) => { env[slot] = require(source); });
          for (let k = 0; k < statement.specifiers.length; k++) {
            const spec = statement.specifiers[k];
            const local = exportedName(spec.local);
            append(getters, [exportedName(spec.exported), local === 'default'
              ? (env) => {
                const m = env[slot];
                return isObject(m) && reflectGet(m, '__esModule') ? ops.get(m, 'default') : m;
              }
              : (env) => ops.get(env[slot], local)]);
          }
        }
      }
    }
    // Local exports, read live from their bindings once the imports are known.
    for (let n = 0; n < program.body.length; n++) {
      const statement = program.body[n];
      if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
        if (statement.declaration) {
          const d = statement.declaration;
          const ids: Identifier[] = [];
          if (d.type === 'VariableDeclaration') for (let j = 0; j < d.declarations.length; j++) patternIdentifiers(d.declarations[j].id, ids);
          else append(ids, d.id);
          for (let k = 0; k < ids.length; k++) { const id = ids[k]; append(getters, [id.name, this.rootRead(root, id.name)]); }
        }
        for (let k = 0; k < statement.specifiers.length; k++) {
          const spec = statement.specifiers[k];
          if (spec.local.type !== 'Identifier') throw new Error('interpreter: string export of a local');
          append(getters, [exportedName(spec.exported), this.rootRead(root, spec.local.name)]);
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const d = statement.declaration;
        const local = (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id ? d.id.name : '*default*';
        append(getters, ['default', this.rootRead(root, local)]);
      }
    }
    const body = this.programBody(program, root);
    const size = root.size;
    const bs = body.s;
    const bg = body.g;
    return (exportsArg, requireArg, moduleArg, filename, dirname) => {
      const env: Env = new Array<unknown>(size);
      env[0] = ROOT_ENV;
      env[exportsSlot] = exportsArg;
      env[requireSlot] = requireArg;
      env[moduleSlot] = moduleArg;
      env[filenameSlot] = filename;
      env[dirnameSlot] = dirname;
      if (typeof requireArg !== 'function') throw new TypeError('require is not a function');
      const require = (id: string): unknown => reflectApply(requireArg, undefined, [id]);
      for (let i = 0; i < loads.length; i++) loads[i](env, require);
      const facade = {};
      defineOrThrow(facade, '__esModule', { value: true });
      for (let i = 0; i < getters.length; i++) {
        const name = getters[i][0];
        const read = getters[i][1];
        if (!objectHasOwn(facade, name)) defineOrThrow(facade, name, { get: () => read(env), enumerable: true });
      }
      for (let i = 0; i < starSources.length; i++) {
        const m = starSources[i](env);
        if (!isObject(m)) continue;
        const keys = objectGetOwnPropertyNames(m);
        for (let j = 0; j < keys.length; j++) {
          const key = keys[j];
          if (key === 'default' || objectHasOwn(facade, key)) continue;
          const desc = reflectGetOwnPropertyDescriptor(m, key);
          defineOrThrow(facade, key, { get: () => ops.get(m, key), enumerable: !desc || Boolean(desc.enumerable) });
        }
      }
      ops.set(moduleArg, 'exports', facade);
      if (bg === null) {
        bs(env);
        return undefined;
      }
      return drive(bg(env));
    };
  }

  /** A live read of a module-scope binding, for an export getter. */
  private rootRead(root: FunctionScope, name: string): (env: Env) => unknown {
    const binding = root.bindings.get(name);
    if (!binding) throw new Error(`interpreter: export of undeclared ${name}`);
    // A getter can run before the declaration does (a cycle): it reads the TDZ.
    if (binding.declEnd >= 0) binding.tdz = true;
    return this.withScope(root, () => this.bindingRead(binding, binding.tdz));
  }
}

/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;

/** The environment above every unit's: nothing reads it. */
export const ROOT_ENV: Env = [];

/** esbuild's __toESM: a namespace object over a CommonJS module's exports. */
function toESM(m: unknown): object {
  const target: object = objectCreate(isObject(m) ? objectGetPrototypeOf(m) : null);
  if (!isObject(m) || !reflectGet(m, '__esModule')) defineOrThrow(target, 'default', { value: m, enumerable: true });
  if (isObject(m)) {
    const keys = objectGetOwnPropertyNames(m);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (objectHasOwn(target, key)) continue;
      const desc = reflectGetOwnPropertyDescriptor(m, key);
      defineOrThrow(target, key, { get: () => reflectGet(m, key), enumerable: !desc || Boolean(desc.enumerable) });
    }
  }
  return target;
}

/** Runs a module body's generator as an async function would: one await per yielded value. */
async function drive(it: Generator<unknown, unknown, unknown>): Promise<unknown> {
  let r = it.next();
  while (!r.done) {
    let value: unknown;
    let ok = true;
    try {
      value = await r.value;
    } catch (error) {
      ok = false;
      value = error;
    }
    r = ok ? it.next(value) : it.throw(value);
  }
  return undefined;
}

interface RefValue {
  get(): unknown;
  set(value: unknown): void;
}

function binaryOperator(operator: string, ops: HostOperators): (a: unknown, b: unknown) => unknown {
  switch (operator) {
    case '+': return (a, b) => (typeof a === 'number' && typeof b === 'number' ? a + b : ops.add(a, b));
    case '-': return ops.sub;
    case '*': return ops.mul;
    case '/': return ops.div;
    case '%': return ops.mod;
    case '**': return ops.exp;
    case '<<': return ops.shl;
    case '>>': return ops.shr;
    case '>>>': return ops.ushr;
    case '&': return ops.and;
    case '|': return ops.or;
    case '^': return ops.xor;
    default: throw new Error(`interpreter: operator ${operator}`);
  }
}
