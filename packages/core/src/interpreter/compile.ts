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
 *
 * A function's body is compiled on its first call, as V8 compiles lazily: a
 * program calls a fraction of the functions it loads. Until then the
 * function keeps no AST: its text is parsed again (reparse.ts) and analyzed
 * inside the scopes of the function that defined it, which the earlier
 * analysis left with what a later one needs (scope.ts releaseScopes).
 */
import type {
  AnyNode, ArrayExpression, ArrayPattern, ArrowFunctionExpression, AssignmentExpression, AssignmentPattern, AwaitExpression,
  BinaryExpression, BlockStatement, CallExpression, CatchClause, ClassBody, ClassExpression, ExportDefaultDeclaration, Expression,
  ForInStatement, ForOfStatement, ForStatement, FunctionDeclaration, FunctionExpression, Identifier, ImportExpression,
  Literal, LogicalExpression, MemberExpression, MetaProperty, ModuleDeclaration, NewExpression,
  ObjectExpression, ObjectPattern, Pattern, PrivateIdentifier, Program, SpreadElement, Statement, StaticBlock, Super,
  SwitchStatement, TaggedTemplateExpression, TemplateLiteral, TryStatement, UnaryExpression, UpdateExpression,
  VariableDeclaration, WithStatement, YieldExpression,
} from 'acorn';
import type { HostOperators } from './host-ops.js';
import { type FunctionSite, type FunctionSyntax, reparseFunction } from './reparse.js';
import {
  type Analysis, type Binding, type ClassNode, type FunctionNode, type FunctionOptions, FunctionScope, type Reference,
  type Scope, analyzeLazyFunction, patternIdentifiers, releaseScopes, suspendsInFunction,
} from './scope.js';
import {
  BigInt, Error, ReferenceError, RegExp, SafeList, SafeMap, SafeSet, SafeWeakMap, SyntaxError, TypeError, append,
  arraySliceFrom, contains, copyList, createDataProperty, dataDescriptor, everyItem, globalObject, indexWhere, listOf,
  mapList, newList, newSafeList, objectFreeze, objectHasOwn, promiseReject, reflectApply, reflectDefineProperty,
  reflectGet, objectGetPrototypeOf, reflectHas, reflectSet, reflectSetPrototypeOf, safeGenerator, skipTrivia, someItem,
  stringOf, stringSlice, symbolAsyncIterator, symbolIterator, toObject, withElement, withFirst, withLast,
} from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
import {
  AWAIT, BREAK, CONTINUE, Completion, DELEGATE, type Env, FunctionInfo, type FunctionShape, PrivateName,
  type Signal, type Sync, TDZ, THIS_BEFORE_SUPER, YIELD, functionName, initializeInstance,
  frameTemplate, isObject, makeFunction, operators, signalOperand, superConstruct, tdzError, up, upN,
} from './runtime.js';
import {
  arrayIteration, asyncFromSyncIterator, asyncIteratorClose, closeArrayIteration, describe, getIterator, iteratorFrom,
  iteratorMethod, spreadInto,
} from './iteration.js';
import { type Code, type CodeOf, asGen, genCode, suspendedBind, suspendedSync, syncCode } from './code.js';
import {
  type ClassElement, type ClassMaker, type ClassPlan, type ClassPrivateName, type ElementKey, classMaking,
} from './classes.js';
import type { ExportRead, ModuleImport, ModulePlan } from './modules.js';
import {
  arrayWithHoles, callValue, constructValue, copyDataProperties, defineAccessor, keyOnce, nullBase, requireObjectCoercible,
  signalOf, templateObject, toPropertyKey, withHas,
} from './operations.js';

/** A module specifier's text. */
function specifierOf(node: Literal): string {
  if (typeof node.value !== 'string') throw new Error('interpreter: module specifier');
  return node.value;
}

/** An imported or exported name: an identifier, or a string such as `export { a as "b-c" }`. */
function exportedName(node: Identifier | Literal): string {
  return node.type === 'Identifier' ? node.name : stringOf(node.value);
}

/** The value an optional chain short-circuits to, inside the chain. */
const SHORT: object = objectFreeze({ short: true });

/** What the host gives a compiled unit. */
export interface UnitHost {
  /** The unit's `import(specifier, options)`. */
  readonly dynamicImport: ((specifier: unknown, options: unknown) => Promise<unknown>) | null;
  /**
   * What the unit's free `Function` reads, as a native cell reads its
   * module's (commonjs-cell.ts, THE WRAPPER); null where it reads the global.
   */
  readonly functionBinding: { readonly value: unknown } | null;
}

/** An import binding's source: the slot holds the module (named, default) or the namespace object. */
type ImportInfo = { readonly kind: 'named' | 'default' | 'namespace'; readonly name: string };

/** What every function of one unit (a module, script or constructed function) shares, compiled now or later. */
export interface UnitContext {
  /** The text the unit was parsed from; functions compiled later are parsed from it again. */
  readonly source: string;
  readonly module: boolean;
  readonly host: UnitHost;
  /** A module's import bindings. */
  readonly imports: SafeMap<Binding, ImportInfo>;
  /** A module's own scope, which holds `%module` for import.meta. */
  readonly moduleScope: FunctionScope | null;
}

/** What compiling a function on its first call needs, without its AST. */
interface LazySite {
  readonly unit: UnitContext;
  readonly reparse: FunctionSite;
  /** The scope the function is defined in. */
  readonly outer: Scope;
  readonly options: FunctionOptions;
}

/** Compile `fi`'s body from `site`: called by the runtime on the function's first call. */
function compileLater(fi: FunctionInfo, site: LazySite): void {
  const { node, text, base } = reparseFunction(site.reparse);
  const analysis = analyzeLazyFunction(node, site.outer, site.options, site.unit.moduleScope);
  const fs = analysis.functionScopeOf(node);
  new Compiler(analysis, site.unit, text, base, fs).compileFunctionInto(fi, fs, node.params, node.body);
  releaseScopes(fs);
  fi.lazy = null;
}

/** The runtime's hook for `fi`: compile it from `site` on its first call. */
function lazily(fi: FunctionInfo, site: LazySite): () => void {
  return () => compileLater(fi, site);
}

type Labels = readonly string[];

/** A property key known when compiling, or computed when the code runs. */
type KeyCode = { readonly kind: 'static'; readonly static: PropertyKey } | { readonly kind: 'computed'; readonly computed: Code };

/** A function value and the `this` a call through it passes. */
type Callee = readonly [fn: unknown, thisArg: unknown];

const G = globalObject;

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

/** What a pattern element binds: the element itself, or an AssignmentPattern's left. */
function patternTarget(element: Pattern): Pattern {
  return element.type === 'AssignmentPattern' ? element.left : element;
}

/** An element of a suspending destructuring pattern (Compiler.elementGen). */
interface ElementGen {
  reference(env: Env): Generator<unknown, ((value: unknown) => void) | null, unknown>;
  assign(env: Env, set: ((value: unknown) => void) | null, value: unknown): Generator<unknown, void, unknown>;
}

/** A catch clause's code, given the error it caught. */
type CatchHandler = {
  readonly s: (env: Env, error: unknown) => Signal;
  readonly g: ((env: Env, error: unknown) => Generator<unknown, Signal, unknown>) | null;
};

type ObjectPatternStep = (env: Env, source: unknown, used: SafeList<PropertyKey> | null) => void;
type ObjectPatternStepGen = { readonly key: ((env: Env) => Generator<unknown, PropertyKey, unknown>) | null; readonly el: ElementGen };

/** A member expression target's reference: evaluated before the value it is set to is read. */
type MemberTargetCode = ((env: Env) => (value: unknown) => void) | null;
type ArrayPatternElement = { readonly kind: 'skip' }
  | { readonly kind: 'rest'; readonly bind: (env: Env, value: unknown) => void; readonly member: MemberTargetCode }
  | { readonly kind: 'one'; readonly bind: (env: Env, value: unknown) => void; readonly dflt: Sync | null; readonly member: MemberTargetCode };

/** A property of an object literal, compiled. */
type PropertyPart =
  | { readonly kind: 'spread'; readonly value: Code }
  | { readonly kind: 'proto'; readonly value: Code }
  | { readonly kind: 'data'; readonly key: KeyCode; readonly value: Code | null; readonly named: NamedCode | null }
  | { readonly kind: 'method' | 'get' | 'set'; readonly key: KeyCode; readonly fi: FunctionInfo };

/** An element of an argument list or array literal. */
type ListPart = { readonly spread: boolean; readonly code: Code };

/** Code of an anonymous function or class definition, given the name it gets when it runs (a computed key's). */
type NamedCode = {
  readonly s: (env: Env, name: string) => unknown;
  readonly g: ((env: Env, name: string) => Generator<unknown, unknown, unknown>) | null;
};

/** A loop's verdict on its body's completion. */
type LoopStep = 'next' | 'stop' | 'out';

/** The [parameter slot, body var slot] pairs of body vars that start with a parameter's value. */
function parameterCopies(fs: FunctionScope, varScope: Scope): Array<[from: number, to: number]> {
  const copies = newSafeList<[from: number, to: number]>();
  const bindings = varScope.bindingList();
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b.kind !== 'var') continue;
    const param = fs.bindings.get(b.name);
    if (param && param.kind === 'param') append(copies, [param.slot, b.slot]);
    else if (b.name === 'arguments' && fs.argumentsBinding) append(copies, [fs.argumentsBinding.slot, b.slot]);
  }
  return copies;
}

/** The slots of `scope`'s bindings that start in their TDZ when it is entered (parameters, or the rest). */
function tdzSlots(scope: Scope, params: boolean): number[] {
  const slots = newSafeList<number>();
  const bindings = scope.bindingList();
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b.tdz && (b.kind === 'param') === params) append(slots, b.slot);
  }
  return slots;
}

/** The slot of `scope`'s binding `name`, which the unit's own analysis declared. */
function bindingSlot(scope: Scope, name: string): number {
  const b = scope.bindings.get(name);
  if (!b) throw new Error(`interpreter: no binding ${name}`);
  return b.slot;
}

export class Compiler {
  private scope: Scope;
  private shape: FunctionShape = 'plain';
  private readonly suspendCache = new SafeWeakMap<AnyNode, boolean>();
  private readonly functionInfos = new SafeMap<AnyNode, FunctionInfo>();

  constructor(
    readonly analysis: Analysis,
    readonly unit: UnitContext,
    /** The text this compile's AST was parsed from: the unit's, or one function's (reparse.ts). */
    readonly text: string,
    /** The offset in the unit's source of `text`'s first character. */
    readonly base: number,
    root: FunctionScope,
  ) {
    this.scope = root;
  }

  /** The unit's source text at [start, end) of this compile's text: what a function's toString answers. */
  private sourceOf(start: number, end: number): string {
    return stringSlice(this.unit.source, start + this.base, end + this.base);
  }

  /** This compile's text at [start, end): an expression as an error message quotes it. */
  private textOf(start: number, end: number): string {
    return stringSlice(this.text, start, end);
  }

  // ── Suspension ──

  /** Whether evaluating `node` can await or yield in the current function. */
  suspends(node: AnyNode | null | undefined): boolean {
    // Only an async function or a generator suspends; a class's keys are evaluated where it sits.
    if (!node || this.shape === 'plain' || this.shape === 'method' || this.shape === 'arrow'
      || this.shape === 'classBase' || this.shape === 'classDerived') return false;
    return suspendsInFunction(node, this.suspendCache);
  }

  // ── Scopes ──

  /**
   * Make `scope` the current scope; returns the one to restore after. No
   * closure here captures `this`, an AST node or an analysis object: V8 keeps
   * whatever any closure of a function captures alive for all its closures,
   * and the runtime's closures must not keep the AST or the compiler.
   * (An error abandons the compile, so a scope left set does not matter.)
   */
  private enter(scope: Scope): Scope {
    const outer = this.scope;
    this.scope = scope;
    return outer;
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
    const tdz = tdzSlots(scope, false);
    const script = scope.fn.functionKind === 'script' && scope === scope.fn;
    const functions = newSafeList<{ readonly fi: FunctionInfo; readonly slot: number; readonly global: string | null }>();
    const outer = this.enter(scope);
    for (let i = 0; i < scope.functions.length; i++) {
      const decl = scope.functions[i];
      const fi = this.functionInfo(decl, decl.id ? decl.id.name : 'default');
      const binding = decl.id ? scope.bindings.get(decl.id.name) : scope.bindings.get('*default*');
      append(functions, { fi, slot: binding ? binding.slot : 0, global: script && decl.id ? decl.id.name : null });
    }
    this.scope = outer;
    const instantiate = (env: Env) => {
      for (let i = 0; i < tdz.length; i++) env[tdz[i]] = TDZ;
      for (let i = 0; i < functions.length; i++) {
        const f = functions[i];
        const value = makeFunction(f.fi, env, undefined);
        if (f.global !== null) {
          reflectDefineProperty(G, f.global, dataDescriptor(value, true, true, false)) || reflectSet(G, f.global, value);
        } else {
          env[f.slot] = value;
        }
      }
      return env;
    };
    if (scope.materialized && !frame) {
      const template = frameTemplate(scope.size, []);
      return (env) => instantiate(withElement(template, 0, env));
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
    const fi = new FunctionInfo(shape, name, expectedArgumentCount(node.params), fs.strict, source ?? this.sourceOf(node.start, node.end));
    this.functionInfos.set(node, fi);
    const outer = fs.parent;
    if (outer === null) throw new Error('interpreter: a nested function without a scope around it');
    const syntax: FunctionSyntax = node.type === 'ArrowFunctionExpression' ? { kind: 'arrow' }
      : fs.method ? { kind: 'method', async: node.async, generator: node.generator, derivedConstructor: fs.derived }
        : { kind: 'keyword', declaration: node.type === 'FunctionDeclaration' && node.id !== null };
    fi.lazy = lazily(fi, {
      unit: this.unit,
      reparse: { source: this.unit.source, module: this.unit.module, start: node.start + this.base, end: node.end + this.base, syntax, strict: outer.strict },
      outer,
      options: { strict: outer.strict, method: fs.method, derived: fs.derived, ctor: shape === 'classBase' || shape === 'classDerived', unbound: false },
    });
    return fi;
  }

  /** Compile `node` as the unit's own function now (a Function constructor's), not on its first call. */
  rootFunction(node: FunctionExpression, name: string, source: string): FunctionInfo {
    const fs = this.analysis.functionScopeOf(node);
    const shape: FunctionShape = node.async ? (node.generator ? 'asyncGenerator' : 'async') : node.generator ? 'generator' : 'plain';
    const fi = new FunctionInfo(shape, name, expectedArgumentCount(node.params), fs.strict, source);
    this.compileFunctionInto(fi, fs, node.params, node.body);
    return fi;
  }

  compileFunctionInto(fi: FunctionInfo, fs: FunctionScope, params: readonly Pattern[], body: BlockStatement | Expression): void {
    const saved = { scope: this.scope, shape: this.shape };
    this.scope = fs;
    this.shape = fi.shape;
    try {
      fi.derived = fs.derived;
      if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
      if (fs.argumentsBinding) fi.argumentsSlot = fs.argumentsBinding.slot;
      if (fs.newTargetBinding) fi.newTargetSlot = fs.newTargetBinding.slot;
      if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
      if (fs.funcBinding) fi.funcSlot = fs.funcBinding.slot;
      if (everyItem(params, (p) => p.type === 'Identifier')) {
        const slots = newSafeList<number>();
        for (let i = 0; i < params.length; i++) append(slots, this.declaredBinding(params[i]).slot);
        fi.params = listOf(slots);
        fi.frame = frameTemplate(fs.size, []);
      } else {
        fi.frame = frameTemplate(fs.size, tdzSlots(fs, true));
        fi.bindParams = this.paramBinder(params, fs.argumentsBinding !== null);
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
    const entry = varScope === fs ? this.scopeEntry(fs, true) : this.bodyScopeEntry(fs, varScope);
    const outer = this.enter(varScope);
    const statements = body.body;
    let result: { code: Code; expression: boolean };
    // A body that is one `return <expr>` evaluates to the expression itself.
    if (entry === null && statements.length === 1 && statements[0].type === 'ReturnStatement') {
      const arg = statements[0].argument;
      result = { code: arg ? this.expr(arg) : syncCode(() => undefined), expression: true };
    } else {
      result = { code: this.entered(entry, this.statementList(statements)), expression: false };
    }
    this.scope = outer;
    return result;
  }

  /**
   * Entering a function body that has a var environment of its own (its
   * parameter list has expressions): body vars named like parameters, and
   * `var arguments`, start with the parameter's value.
   */
  private bodyScopeEntry(fs: FunctionScope, varScope: Scope): (env: Env) => Env {
    const copies = parameterCopies(fs, varScope);
    const outer = this.enter(varScope);
    const inner = this.scopeEntry(varScope);
    this.scope = outer;
    return (env) => {
      const e = inner ? inner(env) : env;
      for (let i = 0; i < copies.length; i++) e[copies[i][1]] = env[copies[i][0]];
      return e;
    };
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

  /**
   * Binds a parameter list with expressions, in order. A default can change
   * the arguments object (`arguments.length = 0`, `arguments[1] = x`), which
   * natively binds nothing: parameters are bound from the arguments as
   * passed. So a function that can reach its arguments object binds from a
   * copy of them, made before any default runs.
   */
  private paramBinder(params: readonly Pattern[], argumentsReachable: boolean): (env: Env, args: ArrayLike<unknown>) => void {
    const binders = newSafeList<(env: Env, args: ArrayLike<unknown>) => void>();
    for (let i = 0; i < params.length; i++) append(binders, this.parameterBinder(params[i], i));
    if (!argumentsReachable) {
      return (env, args) => {
        for (let i = 0; i < binders.length; i++) binders[i](env, args);
      };
    }
    return (env, args) => {
      const passed = copyList(args);
      for (let i = 0; i < binders.length; i++) binders[i](env, passed);
    };
  }

  /** Binds parameter `index` (or, a rest parameter, the arguments from it on). */
  private parameterBinder(param: Pattern, index: number): (env: Env, args: ArrayLike<unknown>) => void {
    if (param.type === 'RestElement') {
      const bind = this.patternBinder(param.argument, true);
      return (env, args) => bind(env, arraySliceFrom(args, index));
    }
    const bind = this.patternBinder(param, true);
    // As enter() does for simple parameters: nothing past the last argument is read.
    return (env, args) => bind(env, index < args.length ? args[index] : undefined);
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
  private namedAtRuntime(node: Expression): NamedCode {
    if (!isAnonymousFunctionDefinition(node)) {
      const c = this.expr(node);
      const cs = c.s;
      const cg = c.g;
      return { s: (env) => cs(env), g: cg === null ? null : safeGenerator(function* (env: Env) { return yield* cg(env); }) };
    }
    // A class whose heritage or keys await or yield makes its constructor in the generator flavor.
    if (node.type === 'ClassExpression') return this.classMaker(node);
    const fi = this.functionInfo(node, '');
    return { s: (env, name) => makeFunction(fi, env, undefined, name), g: null };
  }

  // ── Statements ──

  private statementList(list: readonly (Statement | ModuleDeclaration)[]): Code {
    const codes = newSafeList<Code>();
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
        const signal = node.label ? new Completion('break', node.label.name, undefined) : BREAK;
        return syncCode(() => signal);
      }
      case 'ContinueStatement': {
        const signal = node.label ? new Completion('continue', node.label.name, undefined) : CONTINUE;
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
    return this.blockIn(this.analysis.scopeOf(node), body);
  }

  private blockIn(scope: Scope, body: readonly Statement[]): Code {
    const entry = this.scopeEntry(scope);
    const outer = this.enter(scope);
    const list = this.statementList(body);
    this.scope = outer;
    return this.entered(entry, list);
  }

  private variableDeclaration(node: VariableDeclaration): Code | null {
    const parts = newSafeList<Code>();
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
    const then = this.clause(consequent) ?? syncCode(() => undefined);
    const otherwise = alternate ? this.clause(alternate) ?? syncCode(() => undefined) : null;
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

  /** An if statement's clause: a function declaration there is a block of its own (Annex B.3.4, Analyzer.visitClause). */
  private clause(node: Statement): Code | null {
    if (node.type !== 'FunctionDeclaration') return this.stmt(node, []);
    const block = this.analysis.clauseBlocks.get(node);
    if (!block) throw new Error('interpreter: an if clause declaration without its block');
    return this.blockIn(block, [node]);
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
    const ends = (s: unknown): boolean => s instanceof Completion && s.kind === 'break' && s.label === label;
    const is = inner.s;
    const ig = inner.g;
    if (ig) return genCode(function* (env) { const s = yield* ig(env); return ends(s) ? undefined : s; });
    return syncCode((env) => { const s = is(env); return ends(s) ? undefined : s; });
  }

  /**
   * How a loop treats its body's completion: continue with the next
   * iteration, stop normally, or hand the completion out.
   */
  private loopControl(labels: Labels): (s: Completion) => LoopStep {
    return (s) => {
      if (s === CONTINUE) return 'next';
      if (s === BREAK) return 'stop';
      if (s.label === null || !contains(labels, s.label)) return 'out';
      return s.kind === 'continue' ? 'next' : s.kind === 'break' ? 'stop' : 'out';
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
    const outer = this.enter(loopScope);
    const init = node.init && node.init.type === 'VariableDeclaration' ? this.variableDeclaration(node.init) : null;
    const loop = loopScope.materialized ? this.perIterationLoop(labels, init, node) : this.loop(labels, init, node.test ?? null, node.update ?? null, node.body, false);
    this.scope = outer;
    return this.entered(entry, loop);
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
      const outer = loopScope ? this.enter(loopScope) : this.scope;
      const head = this.suspends(pattern)
        ? { scope: loopScope, bind: suspendedBind, bindGen: this.patternBinderGen(pattern, lexical) }
        : { scope: loopScope, bind: this.patternBinder(pattern, lexical), bindGen: null };
      this.scope = outer;
      return head;
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
    const body = this.stmtIn(head.scope, node.body);
    const bind = head.bind;
    if (body.g === null && right.g === null && head.bindGen === null) {
      const r = right.s;
      const b = body.s;
      return syncCode((env) => {
        const object = r(env);
        if (object === null || object === undefined) return undefined;
        for (const key in toObject(object)) {
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
      for (const key in toObject(object)) {
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
  /** A statement compiled in `scope` (or the current one), as code that does nothing if it compiles to nothing. */
  private stmtIn(scope: Scope | null, node: Statement): Code {
    const outer = scope ? this.enter(scope) : this.scope;
    const c = this.stmt(node, []);
    this.scope = outer;
    return c ?? syncCode(() => undefined);
  }

  private rightOfForInOf(node: ForInStatement | ForOfStatement): Code {
    const tdzScope = this.analysis.scopes.get(node.right);
    if (!tdzScope) return this.expr(node.right);
    const entry = this.scopeEntry(tdzScope);
    const outer = this.enter(tdzScope);
    const c = this.expr(node.right);
    this.scope = outer;
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
    const body = this.stmtIn(head.scope, node.body);
    const bind = head.bind;
    if (body.g === null && right.g === null && head.bindGen === null) {
      const r = right.s;
      const b = body.s;
      return syncCode((env) => {
        const it = getIterator(r(env));
        for (;;) {
          const value = it.step();
          if (it.done) return undefined;
          let s: unknown;
          try {
            const e = entry ? entry(env) : env;
            bind(e, value);
            s = b(e);
          } catch (error) {
            it.closeQuietly();
            throw error;
          }
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'next') continue;
            it.close();
            return c === 'stop' ? undefined : s;
          }
        }
      });
    }
    const rg = asGen(right);
    const bg = asGen(body);
    const bindGen = head.bindGen;
    return genCode(function* (env) {
      const it = getIterator(yield* rg(env));
      // Whether leaving now must close the iterator: a generator's return()
      // while suspended in the body leaves through `finally` alone.
      let open = true;
      try {
        for (;;) {
          const value = it.step();
          if (it.done) return undefined;
          let s: unknown;
          try {
            const e = entry ? entry(env) : env;
            if (bindGen) yield* bindGen(e, value); else bind(e, value);
            s = yield* bg(e);
          } catch (error) {
            open = false;
            it.closeQuietly();
            throw error;
          }
          if (s instanceof Completion) {
            const c = control(s);
            if (c === 'next') continue;
            open = false;
            it.close();
            return c === 'stop' ? undefined : s;
          }
        }
      } finally {
        if (open && !it.done) it.close();
      }
    });
  }

  /** `await x` inside this function's generator body. */
  private awaiter(): (x: unknown) => Generator<unknown, unknown, unknown> {
    if (this.shape === 'asyncGenerator') {
      return safeGenerator(function* (x) {
        signalOperand(x);
        return yield AWAIT;
      });
    }
    return safeGenerator(function* (x) { return yield x; });
  }

  private forAwait(node: ForOfStatement, labels: Labels): Code {
    const control = this.loopControl(labels);
    const right = asGen(this.rightOfForInOf(node));
    const head = this.forHead(node);
    const entry = head.scope ? this.scopeEntry(head.scope) : null;
    const body = asGen(this.stmtIn(head.scope, node.body));
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
      // Whether leaving now must close the iterator: an async generator's
      // return() while suspended in the body leaves through `finally` alone.
      let open = true;
      try {
        for (;;) {
          if (typeof next !== 'function') { open = false; throw new TypeError('iterator.next is not a function'); }
          let result: unknown;
          try {
            result = yield* awaitValue(reflectApply(next, iterator, []));
          } catch (error) {
            open = false;
            throw error;
          }
          if (!isObject(result)) { open = false; throw new TypeError(`Iterator result ${stringOf(result)} is not an object`); }
          let value: unknown;
          try {
            if (reflectGet(result, 'done')) { open = false; return undefined; }
            value = reflectGet(result, 'value');
          } catch (error) {
            open = false;
            throw error;
          }
          let s: unknown;
          try {
            const e = entry ? entry(env) : env;
            if (bindGen) yield* bindGen(e, value); else bind(e, value);
            s = yield* body(e);
          } catch (error) {
            open = false;
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
            open = false;
            yield* asyncIteratorClose(iterator, awaitValue);
            return c === 'stop' ? undefined : s;
          }
        }
      } finally {
        if (open) yield* asyncIteratorClose(iterator, awaitValue);
      }
    });
  }

  /** A catch clause: its parameter bound in its own scope, then its block. */
  private catchClause(clause: CatchClause): CatchHandler {
    const catchScope = this.analysis.scopeOf(clause);
    const entry = this.scopeEntry(catchScope);
    const outer = this.enter(catchScope);
    const param = clause.param ?? null;
    const body = this.blockStatement(clause.body, clause.body.body);
    const suspendingParam = param !== null && this.suspends(param);
    const bindGen = param !== null && suspendingParam ? this.patternBinderGen(param, true) : null;
    const bind = param !== null && !suspendingParam ? this.patternBinder(param, true) : null;
    this.scope = outer;
    const bs = body.s;
    if (bindGen !== null) {
      const run = asGen(body);
      return {
        s: suspendedSync,
        g: safeGenerator(function* (env, error) {
          const e = entry ? entry(env) : env;
          yield* bindGen(e, error);
          return signalOf(yield* run(e));
        }),
      };
    }
    const bg = body.g;
    return {
      s: (env, error) => {
        const e = entry ? entry(env) : env;
        if (bind) bind(e, error);
        return signalOf(bs(e));
      },
      g: bg === null ? null : safeGenerator(function* (env, error) {
        const e = entry ? entry(env) : env;
        if (bind) bind(e, error);
        return signalOf(yield* bg(e));
      }),
    };
  }

  private tryStatement(node: TryStatement): Code {
    const block = this.blockStatement(node.block, node.block.body);
    // The catch clause: its parameter bound in its own scope, then its block.
    const handler = node.handler ? this.catchClause(node.handler) : null;
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
    const hs = h === null ? null : h.s;
    const hg = h === null ? null : h.g ?? safeGenerator(function* (env: Env, error: unknown): Generator<unknown, Signal, unknown> {
      return hs === null ? undefined : hs(env, error);
    });
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
    const discriminant = this.expr(node.discriminant);
    const scope = this.analysis.scopeOf(node);
    const entry = this.scopeEntry(scope);
    const outer = this.enter(scope);
    const cases = node.cases;
    const tests = newSafeList<Code | null>();
    const bodies = newSafeList<Code>();
    let defaultIndex = -1;
    for (let i = 0; i < cases.length; i++) {
      const test = cases[i].test;
      append(tests, test ? this.expr(test) : null);
      append(bodies, this.statementList(cases[i].consequent));
      if (!test && defaultIndex < 0) defaultIndex = i;
    }
    this.scope = outer;
    const finish = (s: unknown): unknown => {
      if (s === undefined) return undefined;
      if (s === BREAK) return undefined;
      if (s instanceof Completion && s.kind === 'break' && s.label !== null && contains(labels, s.label)) return undefined;
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
    const body = this.stmtIn(withScope, node.body);
    const enter = (env: Env, target: unknown): Env => {
      if (target === null || target === undefined) throw new TypeError('Cannot convert undefined or null to object');
      const e: Env = [env, toObject(target)];
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
    const imported = this.unit.imports.get(b);
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
    const bound = name === 'Function' ? this.unit.host.functionBinding : null;
    if (bound !== null) return () => bound.value;
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

  /** Readers of the objects of the `with` statements between a reference and its binding, innermost first. */
  private withObjects(ref: Reference): Array<(env: Env) => unknown> {
    const readers = newSafeList<(env: Env) => unknown>();
    for (let i = 0; i < ref.withs.length; i++) append(readers, this.slotReader(this.hops(ref.withs[i]), 1));
    return readers;
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
        const dflt = this.patternDefault(pattern).s;
        return (env, value) => inner(env, value === undefined ? dflt(env) : value);
      }
      case 'ObjectPattern': return this.objectPatternBinder(pattern, init);
      case 'ArrayPattern': return this.arrayPatternBinder(pattern, init);
      case 'RestElement': return this.patternBinder(pattern.argument, init);
    }
  }

  /**
   * The value a pattern element's default gives an undefined value, planned
   * once for both flavors (patternBinder, patternBinderGen): an anonymous
   * function or class default takes an identifier target's name, as
   * `const { f = function () {} } = o` names it `f`.
   */
  private patternDefault(element: AssignmentPattern): Code {
    return element.left.type === 'Identifier' ? this.named(element.right, element.left.name) : this.expr(element.right);
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
    const hasRest = someItem(pattern.properties, (p) => p.type === 'RestElement');
    const steps = newSafeList<ObjectPatternStep>();
    for (let i = 0; i < pattern.properties.length; i++) append(steps, this.objectPatternStep(pattern.properties[i], init));
    return (env, value) => {
      requireObjectCoercible(value);
      const used = hasRest ? newSafeList<PropertyKey>() : null;
      for (let i = 0; i < steps.length; i++) steps[i](env, value, used);
    };
  }

  /** One property of an object pattern: reads its key from the source and binds the value. */
  private objectPatternStep(p: ObjectPattern['properties'][number], init: boolean): ObjectPatternStep {
    const ops = operators();
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
    const target = patternTarget(p.value);
    const bind = this.patternBinder(target, init);
    const dflt = p.value.type === 'AssignmentPattern' ? this.patternDefault(p.value).s : null;
    const member = target.type === 'MemberExpression' ? this.memberTarget(target) : null;
    return (env, source, used) => {
      const k = key(env);
      if (used !== null) append(used, k);
      const set = member ? member(env) : null;
      let v = ops.get(source, k);
      if (v === undefined && dflt !== null) v = dflt(env);
      if (set) set(v); else bind(env, v);
    };
  }

  /** One element of an array pattern, compiled. */
  private arrayPatternElement(e: ArrayPattern['elements'][number], init: boolean): ArrayPatternElement {
    if (e === null) return { kind: 'skip' };
    if (e.type === 'RestElement') {
      return { kind: 'rest', bind: this.patternBinder(e.argument, init), member: e.argument.type === 'MemberExpression' ? this.memberTarget(e.argument) : null };
    }
    const target = patternTarget(e);
    const dflt = e.type === 'AssignmentPattern' ? this.patternDefault(e).s : null;
    return { kind: 'one', bind: this.patternBinder(target, init), dflt, member: target.type === 'MemberExpression' ? this.memberTarget(target) : null };
  }

  private arrayPatternBinder(pattern: ArrayPattern, init: boolean): (env: Env, value: unknown) => void {
    const elements = newSafeList<ArrayPatternElement>();
    for (let i = 0; i < pattern.elements.length; i++) append(elements, this.arrayPatternElement(pattern.elements[i], init));
    return (env, value) => {
      const method = iteratorMethod(value);
      if (arrayIteration(value, method)) {
        // The array's iterator, stepped by index: it is done once a step
        // finds the index at the length, as that step reads it.
        let done = false;
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          if (el.kind === 'skip') {
            if (!done && i >= value.length) done = true;
            continue;
          }
          // A member target's reference is evaluated before the value is read.
          const set = el.member ? el.member(env) : null;
          let v: unknown;
          if (el.kind === 'rest') {
            v = done ? [] : arraySliceFrom(value, i);
            done = true;
          } else {
            if (!done && i < value.length) v = value[i];
            else done = true;
            if (v === undefined && el.dflt !== null) v = el.dflt(env);
          }
          if (set) set(v); else el.bind(env, v);
        }
        if (!done) closeArrayIteration(value);
        return;
      }
      const it = iteratorFrom(value, method);
      try {
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const set = el.kind !== 'skip' && el.member ? el.member(env) : null;
          let v: unknown;
          if (el.kind === 'rest') {
            const rest = newSafeList<unknown>();
            for (let x = it.step(); !it.done; x = it.step()) append(rest, x);
            v = listOf(rest);
          } else if (!it.done) {
            v = it.step();
          }
          if (el.kind === 'skip') continue;
          if (el.kind === 'one' && v === undefined && el.dflt !== null) v = el.dflt(env);
          if (set) set(v); else el.bind(env, v);
        }
      } catch (error) {
        if (!it.done) it.closeQuietly();
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
        return safeGenerator(function* (env, value) { bind(env, value); });
      }
      case 'MemberExpression': {
        // A lone target (a for-of head): its reference is evaluated after the value.
        const ref = this.memberTargetGen(pattern);
        return safeGenerator(function* (env, value) { (yield* ref(env))(value); });
      }
      case 'AssignmentPattern': case 'RestElement': {
        const el = this.elementGen(pattern, init);
        return safeGenerator(function* (env, value) { yield* el.assign(env, yield* el.reference(env), value); });
      }
      case 'ObjectPattern': {
        const steps = newSafeList<ObjectPatternStepGen>();
        for (let i = 0; i < pattern.properties.length; i++) append(steps, this.objectPatternStepGen(pattern.properties[i], init));
        return safeGenerator(function* (env, value) {
          requireObjectCoercible(value);
          const used = newSafeList<PropertyKey>();
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
            append(used, k);
            const target = yield* el.reference(env);
            yield* el.assign(env, target, ops.get(value, k));
          }
        });
      }
      case 'ArrayPattern': {
        const elements = newSafeList<{ readonly rest: boolean; readonly el: ElementGen } | null>();
        for (let i = 0; i < pattern.elements.length; i++) {
          const e = pattern.elements[i];
          append(elements, e === null ? null : { rest: e.type === 'RestElement', el: this.elementGen(e.type === 'RestElement' ? e.argument : e, init) });
        }
        return safeGenerator(function* (env, value) {
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
                const rest = newSafeList<unknown>();
                for (let x = it.step(); !it.done; x = it.step()) append(rest, x);
                v = listOf(rest);
              } else if (!it.done) {
                v = it.step();
              }
              if (item) yield* item.el.assign(env, target, v);
            }
            finished = true;
          } catch (error) {
            threw = true;
            if (!it.done) it.closeQuietly();
            throw error;
          } finally {
            if (!finished && !threw && !it.done) it.close();
          }
          if (!it.done) it.close();
        });
      }
    }
  }

  /** One property of a suspending object pattern: its key (null for a rest element), and its element. */
  private objectPatternStepGen(p: ObjectPattern['properties'][number], init: boolean): ObjectPatternStepGen {
    if (p.type === 'RestElement') return { key: null, el: this.elementGen(p.argument, init) };
    if (p.computed) {
      const k = asGen(this.expr(p.key));
      return { key: safeGenerator(function* (env) { return toPropertyKey(yield* k(env)); }), el: this.elementGen(p.value, init) };
    }
    const name = this.staticKey(p.key);
    return { key: safeGenerator(function* () { return name; }), el: this.elementGen(p.value, init) };
  }

  /**
   * One element of a suspending pattern: a member target's reference,
   * evaluated before its value is read; then the default for an undefined
   * value, and the binding or assignment.
   */
  private elementGen(element: Pattern, init: boolean): ElementGen {
    const target = patternTarget(element);
    const dflt = element.type === 'AssignmentPattern' ? asGen(this.patternDefault(element)) : null;
    if (target.type === 'MemberExpression') {
      const ref = this.memberTargetGen(target);
      return {
        reference: ref,
        assign: safeGenerator(function* (env, set, value) {
          const v = value === undefined && dflt !== null ? yield* dflt(env) : value;
          if (set === null) throw new Error('interpreter: member target without a reference');
          set(v);
        }),
      };
    }
    const bind = this.patternBinderGen(target, init);
    return {
      reference: safeGenerator(function* () { return null; }),
      assign: safeGenerator(function* (env, _set, value) {
        yield* bind(env, value === undefined && dflt !== null ? yield* dflt(env) : value);
      }),
    };
  }

  /** A member assignment target whose object or key awaits or yields: its setter, once its reference is evaluated. */
  private memberTargetGen(node: MemberExpression): (env: Env) => Generator<unknown, (value: unknown) => void, unknown> {
    if (!this.suspends(node)) {
      const target = this.memberTarget(node);
      return safeGenerator(function* (env) { return target(env); });
    }
    if (node.object.type === 'Super') throw new UnsupportedSyntax('await or yield inside a super member key of a destructuring target');
    const ops = operators();
    const set = this.scope.strict ? ops.set : ops.setSloppy;
    const og = asGen(this.expr(node.object));
    if (node.property.type === 'PrivateIdentifier') {
      const name = this.privateName(node.property);
      return safeGenerator(function* (env) {
        const o = yield* og(env);
        const pn = name(env);
        return (value) => pn.set(o, value);
      });
    }
    const kg = node.computed ? asGen(this.expr(node.property)) : null;
    const name = !node.computed && node.property.type === 'Identifier' ? node.property.name : '';
    return safeGenerator(function* (env) {
      const o = yield* og(env);
      const k = kg ? yield* kg(env) : name;
      return (value) => set(o, k, value);
    });
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
        const parts = this.exprs(node.expressions);
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

  /** Each expression's code, in order. */
  private exprs(nodes: readonly Expression[]): Code[] {
    const codes = newSafeList<Code>();
    for (let i = 0; i < nodes.length; i++) append(codes, this.expr(nodes[i]));
    return codes;
  }

  /** An element of an argument list or array literal: a spread, or a value. */
  private listPart(node: Expression | SpreadElement): ListPart {
    return node.type === 'SpreadElement' ? { spread: true, code: this.expr(node.argument) } : { spread: false, code: this.expr(node) };
  }

  private argumentParts(args: readonly (Expression | SpreadElement)[]): ListPart[] {
    const parts = newSafeList<ListPart>();
    for (let i = 0; i < args.length; i++) append(parts, this.listPart(args[i]));
    return parts;
  }

  /** An array literal's parts: null for a hole. */
  private elementParts(elements: readonly (Expression | SpreadElement | null)[]): Array<ListPart | null> {
    const parts = newSafeList<ListPart | null>();
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      append(parts, e === null ? null : this.listPart(e));
    }
    return parts;
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
    const moduleScope = this.unit.moduleScope;
    const binding = moduleScope ? moduleScope.bindings.get('%module') : undefined;
    if (!moduleScope || !binding) throw new UnsupportedSyntax('import.meta outside a module');
    const read = this.slotReader(this.hops(moduleScope), binding.slot);
    const ops = operators();
    return (env) => ops.get(read(env), '__nimbusImportMeta');
  }

  private importExpr(node: ImportExpression): Code {
    const load = this.unit.host.dynamicImport;
    const specifier = this.expr(node.source);
    const options = node.options ? this.expr(node.options) : null;
    const run = (spec: unknown, opts: unknown): Promise<unknown> => {
      if (!load) return promiseReject(new TypeError('import() is not supported here'));
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
      const ops = operators();
      return genCode(function* (env) {
        const v = ag ? yield* ag(env) : as ? as(env) : undefined;
        return yield* ops.delegate(v);
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
    const parts = this.exprs(node.expressions);
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
    const text = this.textOf(node.tag.start, node.tag.end);
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
      if (this.suspends(m)) {
        const object = this.chainGen(m.object);
        const optional = m.optional;
        const key = m.computed ? asGen(this.expr(m.property)) : null;
        const name = !m.computed && m.property.type === 'Identifier' ? m.property.name : '';
        return genCode(function* (env) {
          const o = yield* object(env);
          if (o === SHORT || (optional && (o === null || o === undefined))) return true;
          return remove(o, key ? yield* key(env) : name);
        });
      }
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
      if (target.computed && this.suspends(target.property)) {
        const og = asGen(object);
        const kg = asGen(this.expr(target.property));
        return genCode(function* (env) {
          const o = yield* og(env);
          return remove(o, yield* kg(env));
        });
      }
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
      return safeGenerator(function* (env) {
        const o = yield* object(env);
        if (o === SHORT || (optional && (o === null || o === undefined))) return SHORT;
        if (privateName) return privateName(env).get(o);
        return ops.get(o, key ? yield* key(env) : name);
      });
    }
    if (node.type === 'CallExpression' && node.callee.type !== 'Super') {
      const callee = node.callee;
      const optional = node.optional;
      const args = asGen(this.argumentList(node.arguments));
      const text = this.textOf(callee.start, callee.end);
      if (callee.type === 'MemberExpression' && callee.object.type !== 'Super') {
        const object = this.chainGen(callee.object);
        const memberOptional = callee.optional;
        const key = callee.computed && callee.property.type !== 'PrivateIdentifier' ? asGen(this.expr(callee.property)) : null;
        const name = !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : '';
        const privateName = callee.property.type === 'PrivateIdentifier' ? this.privateName(callee.property) : null;
        return safeGenerator(function* (env) {
          const o = yield* object(env);
          if (o === SHORT || (memberOptional && (o === null || o === undefined))) return SHORT;
          const fn = privateName ? privateName(env).get(o) : ops.get(o, key ? yield* key(env) : name);
          if (optional && (fn === null || fn === undefined)) return SHORT;
          return callValue(fn, o, yield* args(env), text);
        });
      }
      const fnCode = this.chainGen(callee);
      return safeGenerator(function* (env) {
        const fn = yield* fnCode(env);
        if (fn === SHORT || (optional && (fn === null || fn === undefined))) return SHORT;
        return callValue(fn, undefined, yield* args(env), text);
      });
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
    if (!b || ref.tdz || ref.withs.length > 0 || this.unit.imports.has(b) || this.hops(b.scope) !== 0) return null;
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
    const parts = this.argumentParts(args);
    if (everyItem(parts, (p) => p.code.g === null)) {
      const fns = mapList(parts, (p) => p.code.s);
      if (!someItem(parts, (p) => p.spread)) {
        switch (fns.length) {
          case 0: return syncCode(() => []);
          case 1: { const a = fns[0]; return syncCode((env) => [a(env)]); }
          case 2: { const a = fns[0], b = fns[1]; return syncCode((env) => [a(env), b(env)]); }
          case 3: { const a = fns[0], b = fns[1], c = fns[2]; return syncCode((env) => [a(env), b(env), c(env)]); }
          default: {
            const template = newList(fns.length);
            return syncCode((env) => {
              const out = copyList(template);
              for (let i = 0; i < fns.length; i++) out[i] = fns[i](env);
              return out;
            });
          }
        }
      }
      const spreads = mapList(parts, (p) => p.spread);
      return syncCode((env) => {
        const out = newSafeList<unknown>();
        for (let i = 0; i < fns.length; i++) {
          const v = fns[i](env);
          if (spreads[i]) spreadInto(out, v); else append(out, v);
        }
        return listOf(out);
      });
    }
    const gens = mapList(parts, (p) => ({ spread: p.spread, g: asGen(p.code) }));
    return genCode(function* (env) {
      const out = newSafeList<unknown>();
      for (let i = 0; i < gens.length; i++) {
        const p = gens[i];
        const v = yield* p.g(env);
        if (p.spread) spreadInto(out, v); else append(out, v);
      }
      return listOf(out);
    });
  }

  /** Whether no argument spreads or suspends. */
  private plainArguments(args: readonly (Expression | SpreadElement)[]): boolean {
    for (let i = 0; i < args.length; i++) if (args[i].type === 'SpreadElement' || this.suspends(args[i])) return false;
    return true;
  }

  /** The arguments' values, for a list plainArguments accepts. */
  private argumentValues(args: readonly (Expression | SpreadElement)[]): Sync[] {
    const fns = newSafeList<Sync>();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      append(fns, a.type === 'SpreadElement' ? suspendedSync : this.expr(a).s);
    }
    return fns;
  }

  private call(node: CallExpression, inChain: boolean): Code {
    if (node.callee.type === 'Super') return this.superCallExpr(node);
    if (inChain && this.suspends(node)) return genCode(this.chainGen(node));
    const text = this.textOf(node.callee.start, node.callee.end);
    const argNodes = node.arguments;
    // A plain `f(a, b)` through a binding: no callee pair, no argument array.
    if (!inChain && node.callee.type === 'Identifier' && argNodes.length <= 3
      && this.plainArguments(argNodes)
      && this.analysis.ref(node.callee).withs.length === 0) {
      const read = this.read(node.callee);
      const fns = this.argumentValues(argNodes);
      const check = (f: unknown): Function => {
        if (typeof f !== 'function') throw new TypeError(`${text} is not a function`);
        return f;
      };
      // The callee is read, then the arguments evaluated, then the callee checked.
      switch (fns.length) {
        case 0: return syncCode((env) => check(read(env))());
        case 1: { const x = fns[0]; return syncCode((env) => { const f = read(env); const a = x(env); return check(f)(a); }); }
        case 2: {
          const x = fns[0], y = fns[1];
          return syncCode((env) => { const f = read(env); const a = x(env); const b = y(env); return check(f)(a, b); });
        }
        default: {
          const x = fns[0], y = fns[1], z = fns[2];
          return syncCode((env) => { const f = read(env); const a = x(env); const b = y(env); const c = z(env); return check(f)(a, b, c); });
        }
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
    const fns = this.argumentValues(node.arguments);
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
    const text = this.textOf(node.callee.start, node.callee.end);
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
    const parts = this.elementParts(node.elements);
    if (everyItem(parts, (p) => p === null || p.code.g === null)) {
      if (everyItem(parts, (p) => p !== null && !p.spread)) {
        const fns = mapList(parts, (p) => (p ? p.code.s : suspendedSync));
        switch (fns.length) {
          case 0: return syncCode(() => []);
          case 1: { const a = fns[0]; return syncCode((env) => [a(env)]); }
          case 2: { const a = fns[0], b = fns[1]; return syncCode((env) => [a(env), b(env)]); }
          case 3: { const a = fns[0], b = fns[1], c = fns[2]; return syncCode((env) => [a(env), b(env), c(env)]); }
          case 4: { const a = fns[0], b = fns[1], c = fns[2], d = fns[3]; return syncCode((env) => [a(env), b(env), c(env), d(env)]); }
          default: {
            const template = newList(fns.length);
            return syncCode((env) => {
              const out = copyList(template);
              for (let i = 0; i < fns.length; i++) out[i] = fns[i](env);
              return out;
            });
          }
        }
      }
      const items = mapList(parts, (p) => (p === null ? null : { spread: p.spread, f: p.code.s }));
      return syncCode((env) => {
        const out = newSafeList<unknown>();
        const holes = newSafeList<number>();
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item === null) { append(holes, out.length); out.length++; }
          else if (item.spread) spreadInto(out, item.f(env));
          else append(out, item.f(env));
        }
        return arrayWithHoles(out, holes);
      });
    }
    const items = mapList(parts, (p) => (p === null ? null : { spread: p.spread, g: asGen(p.code) }));
    return genCode(function* (env) {
      const out = newSafeList<unknown>();
      const holes = newSafeList<number>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === null) { append(holes, out.length); out.length++; continue; }
        const v = yield* item.g(env);
        if (item.spread) spreadInto(out, v); else append(out, v);
      }
      return arrayWithHoles(out, holes);
    });
  }

  /** One property of an object literal, compiled. */
  private propertyPart(p: ObjectExpression['properties'][number]): PropertyPart {
    if (p.type === 'SpreadElement') return { kind: 'spread', value: this.expr(p.argument) };
    const key: KeyCode = p.computed ? { kind: 'computed', computed: this.expr(p.key) } : { kind: 'static', static: this.staticKey(p.key) };
    if (!p.computed && !p.shorthand && !p.method && p.kind === 'init' && key.kind === 'static' && key.static === '__proto__') {
      return { kind: 'proto', value: this.expr(p.value) };
    }
    if (p.kind !== 'init' || p.method) {
      if (p.value.type !== 'FunctionExpression') throw new Error('interpreter: method without a function');
      const name = key.kind === 'static' ? functionName(key.static, p.kind === 'init' ? undefined : p.kind) : '';
      // A method's source text is its whole definition, key included.
      return { kind: p.kind === 'init' ? 'method' : p.kind, key, fi: this.functionInfo(p.value, name, undefined, this.sourceOf(p.start, p.value.end)) };
    }
    if (key.kind === 'static') return { kind: 'data', key, value: this.named(p.value, functionName(key.static)), named: null };
    if (isAnonymousFunctionDefinition(p.value)) return { kind: 'data', key, value: null, named: this.namedAtRuntime(p.value) };
    return { kind: 'data', key, value: this.expr(p.value), named: null };
  }

  private objectExpr(node: ObjectExpression): Code {
    type Part = PropertyPart;
    const parts = newSafeList<Part>();
    for (let i = 0; i < node.properties.length; i++) append(parts, this.propertyPart(node.properties[i]));
    const suspends = someItem(parts, (p) => ((p.kind === 'spread' || p.kind === 'proto') && p.value.g !== null)
      || ((p.kind === 'data' || p.kind === 'method' || p.kind === 'get' || p.kind === 'set') && p.key.kind === 'computed' && p.key.computed.g !== null)
      || (p.kind === 'data' && p.value !== null && p.value.g !== null)
      || (p.kind === 'data' && p.named !== null && p.named.g !== null));
    // Static keys and plain values only: a template copied with own data
    // properties (define semantics), then filled in.
    if (!suspends && everyItem(parts, (p) => p.kind === 'data' && p.key.kind === 'static' || p.kind === 'method' && p.key.kind === 'static' || p.kind === 'proto')) {
      const template: Record<PropertyKey, unknown> = {};
      const seen = new SafeSet<PropertyKey>();
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        if ((p.kind === 'data' || p.kind === 'method') && p.key.kind === 'static' && !seen.has(p.key.static)) {
          seen.add(p.key.static);
          createDataProperty(template, p.key.static, undefined);
        }
      }
      // Data properties only (most literals): the values written in order.
      if (everyItem(parts, (p) => p.kind === 'data')) {
        if (parts.length === 0) return syncCode(() => ({}));
        const keys = mapList(parts, (p) => (p.kind === 'data' && p.key.kind === 'static' ? p.key.static : ''));
        const values = mapList(parts, (p) => (p.kind === 'data' && p.value !== null ? p.value.s : suspendedSync));
        return syncCode((env) => {
          const o: Record<PropertyKey, unknown> = { ...template };
          for (let i = 0; i < keys.length; i++) o[keys[i]] = values[i](env);
          return o;
        });
      }
      const fills = mapList(parts, (p) => {
        if (p.kind === 'proto') return { proto: p.value.s, key: '' as PropertyKey, value: null, fi: null };
        if (p.kind === 'data' && p.key.kind === 'static' && p.value !== null) return { proto: null, key: p.key.static, value: p.value.s, fi: null };
        if (p.kind === 'method' && p.key.kind === 'static') return { proto: null, key: p.key.static, value: null, fi: p.fi };
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
    const keyOf = (key: KeyCode, env: Env): PropertyKey => (key.kind === 'static' ? key.static : toPropertyKey(key.computed.s(env)));
    const keyOfGen = safeGenerator(function* (key: KeyCode, env: Env): Generator<unknown, PropertyKey, unknown> {
      if (key.kind === 'static') return key.static;
      const g = key.computed.g;
      return toPropertyKey(g ? yield* g(env) : key.computed.s(env));
    });
    const apply = (o: object, p: Part, k: PropertyKey, value: unknown, env: Env) => {
      switch (p.kind) {
        case 'spread': copyDataProperties(o, value, null); return;
        case 'proto': if (isObject(value) || value === null) reflectSetPrototypeOf(o, value); return;
        case 'data': createDataProperty(o, k, value); return;
        case 'method': {
          const fn = makeFunction(p.fi, env, o, p.key.kind === 'computed' ? functionName(k) : p.fi.name);
          createDataProperty(o, k, fn);
          return;
        }
        case 'get': case 'set': {
          const fn = makeFunction(p.fi, env, o, p.key.kind === 'computed' ? functionName(k, p.kind) : p.fi.name);
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
            const v = p.value !== null ? p.value.s(env) : p.named !== null ? p.named.s(env, functionName(k)) : undefined;
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
            const g = p.named.g;
            v = g ? yield* g(env, functionName(k)) : p.named.s(env, functionName(k));
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
    const shortCircuit = (v: unknown): boolean => (operator === '&&=' ? !v : operator === '||=' ? !!v : v !== null && v !== undefined);
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
      return { s: (env) => make(os(env), name(env)), g: og ? safeGenerator(function* (env) { return make(yield* og(env), name(env)); }) : null };
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
        g: og ? safeGenerator(function* (env) { const o = yield* og(env); return { get: () => ops.get(o, staticName), set: (v: unknown) => set(o, staticName, v) }; }) : null,
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
  private classMaker(node: ClassNode): ClassMaker {
    const scopes = this.analysis.classes.get(node);
    if (!scopes) throw new Error('interpreter: class without analysis');
    const classScope = scopes.scope;
    const entry = this.scopeEntry(classScope);
    // The heritage runs in the class's scope, where its name is in its TDZ.
    const outer = this.enter(classScope);
    const heritage = node.superClass ? this.expr(node.superClass) : null;
    const plan = this.classPlan(node, scopes.instanceFields, scopes.staticFields, classScope);
    this.scope = outer;
    return classMaking(entry, heritage, plan);
  }

  /** What defining a class does, compiled: its constructor, elements and private names (classDefiner runs it). */
  private classPlan(node: ClassNode, instanceFields: FunctionScope | null, staticFields: FunctionScope | null, classScope: Scope): ClassPlan {
    const body: ClassBody = node.body;
    const derived = !!node.superClass;
    const ctorIndex = indexWhere(body.body, (m) => m.type === 'MethodDefinition' && m.kind === 'constructor');
    const ctorMember = ctorIndex < 0 ? null : body.body[ctorIndex];
    const ctorNode = ctorMember !== null && ctorMember.type === 'MethodDefinition' ? ctorMember : null;
    const className = node.id ? node.id.name : '';
    const classSource = this.sourceOf(node.start, node.end);
    let ctorInfo: FunctionInfo;
    if (ctorNode) {
      ctorInfo = this.functionInfo(ctorNode.value, className, derived ? 'classDerived' : 'classBase', classSource);
    } else {
      ctorInfo = new FunctionInfo(derived ? 'classDerived' : 'classBase', className, 0, true, classSource);
      ctorInfo.implicit = true;
    }

    const innerBinding = node.id ? classScope.bindings.get(node.id.name) ?? null : null;
    const writeInner = innerBinding ? this.slotWriter(0, innerBinding.slot) : null;
    const computedKeys = newSafeList<Code>();
    const elements = newSafeList<ClassElement>();
    const privateNames = newSafeList<ClassPrivateName>();
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
        key = { kind: 'private', private: this.privateName(member.key) };
        staticName = pname;
      } else if (member.computed) {
        key = { kind: 'computed', computed: computedKeys.length };
        append(computedKeys, this.expr(member.key));
      } else {
        const k = this.staticKey(member.key);
        key = { kind: 'static', static: k };
        staticName = functionName(k);
      }
      if (member.type === 'MethodDefinition') {
        const accessor = member.kind === 'get' || member.kind === 'set' ? member.kind : null;
        const fname = staticName === null ? '' : accessor ? `${accessor} ${staticName}` : staticName;
        // A method's source text is its definition without `static`.
        const source = this.sourceOf(member.static ? this.afterStatic(member.start) : member.start, member.value.end);
        append(elements, { kind: 'method', isStatic: member.static, key, fi: this.functionInfo(member.value, fname, undefined, source), accessor });
        continue;
      }
      const fieldScope = member.static ? staticFields : instanceFields;
      let value: Sync | null = null;
      let named: ((env: Env, name: string) => unknown) | null = null;
      if (member.value) {
        if (!fieldScope) throw new Error('interpreter: field without a scope');
        const outer = this.enterFunction(fieldScope, 'method');
        // A field initializer cannot await or yield (an early error), so its code is the plain flavor.
        if (staticName !== null) value = this.named(member.value, staticName).s;
        else named = this.namedAtRuntime(member.value).s;
        this.leave(outer);
      }
      append(elements, { kind: 'field', isStatic: member.static, key, value, named });
    }
    return {
      ctorInfo, writeInner, elements, privateNames, computedKeys,
      instanceFi: instanceFields ? this.fieldInfo(instanceFields) : null,
      staticFi: staticFields ? this.fieldInfo(staticFields) : null,
    };
  }

  /** The offset after a class member's `static` keyword (and the whitespace after it). */
  private afterStatic(start: number): number {
    return skipTrivia(this.text, start + 'static'.length);
  }

  /** Make `fs` the current function (field initializers, static blocks); returns what leave() restores. */
  private enterFunction(fs: FunctionScope, shape: FunctionShape): { readonly scope: Scope; readonly shape: FunctionShape } {
    const outer = { scope: this.scope, shape: this.shape };
    this.scope = fs;
    this.shape = shape;
    return outer;
  }

  private leave(outer: { readonly scope: Scope; readonly shape: FunctionShape }): void {
    this.scope = outer.scope;
    this.shape = outer.shape;
  }

  /** The frame layout of a class's field initializer scope. */
  private fieldInfo(fs: FunctionScope): FunctionInfo {
    const fi = new FunctionInfo('method', '', 0, true, '');
    fi.frame = frameTemplate(fs.size, []);
    if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
    if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
    return fi;
  }

  private staticBlockInfo(block: StaticBlock): FunctionInfo {
    const fs = this.analysis.functionScopeOf(block);
    const fi = new FunctionInfo('method', '', 0, true, '');
    const outer = this.enterFunction(fs, 'method');
    fi.frame = frameTemplate(fs.size, []);
    if (fs.thisBinding) fi.thisSlot = fs.thisBinding.slot;
    if (fs.homeBinding) fi.homeSlot = fs.homeBinding.slot;
    const entry = this.scopeEntry(fs, true);
    fi.body = this.entered(entry, this.statementList(block.body)).s;
    this.leave(outer);
    return fi;
  }

  // ── Units ──

  /** A program's top level (module or script), as a body over its root environment. */
  programBody(program: Program, root: FunctionScope): Code {
    const entry = this.scopeEntry(root, true);
    const globals = listOf(root.globalVars);
    const body = this.entered(entry, this.statementList(program.body));
    if (globals.length === 0) return body;
    // A script's vars are properties of the global object, created before it runs.
    const declare = (env: Env): Env => {
      for (let i = 0; i < globals.length; i++) {
        const name = globals[i];
        if (!objectHasOwn(G, name)) reflectDefineProperty(G, name, dataDescriptor(undefined, true, true, false));
      }
      return env;
    };
    return this.entered(declare, body);
  }

  /** A CommonJS body: a function of the wrapper's parameters. */
  commonJsFunction(program: Program, root: FunctionScope, params: readonly string[]): FunctionInfo {
    const fi = new FunctionInfo('plain', '', params.length, root.strict, this.unit.source);
    fi.frame = frameTemplate(root.size, []);
    if (root.thisBinding) fi.thisSlot = root.thisBinding.slot;
    if (root.argumentsBinding) fi.argumentsSlot = root.argumentsBinding.slot;
    const slots = newSafeList<number>();
    for (let i = 0; i < params.length; i++) append(slots, bindingSlot(root, params[i]));
    fi.params = listOf(slots);
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
  /** A module's plan (modules.ts): its imports and exports, its instantiation, its statements. */
  modulePlan(program: Program, root: FunctionScope): ModulePlan {
    const imports = newSafeList<ModuleImport>();
    const exports = newSafeList<{ readonly name: string; readonly read: ExportRead }>();
    const stars = newSafeList<number>();
    for (let n = 0; n < program.body.length; n++) {
      const statement = program.body[n];
      if (statement.type === 'ImportDeclaration') {
        const bindings = newSafeList<{ readonly slot: number; readonly namespace: boolean }>();
        for (let k = 0; k < statement.specifiers.length; k++) {
          const spec = statement.specifiers[k];
          const binding = root.bindings.get(spec.local.name);
          if (!binding) throw new Error('interpreter: import binding');
          if (spec.type === 'ImportDefaultSpecifier') this.unit.imports.set(binding, { kind: 'default', name: 'default' });
          else if (spec.type === 'ImportNamespaceSpecifier') this.unit.imports.set(binding, { kind: 'namespace', name: '*' });
          else this.unit.imports.set(binding, { kind: 'named', name: exportedName(spec.imported) });
          append(bindings, { slot: binding.slot, namespace: spec.type === 'ImportNamespaceSpecifier' });
        }
        append(imports, { source: specifierOf(statement.source), slot: null, bindings: listOf(bindings) });
      } else if (statement.type === 'ExportAllDeclaration') {
        const slot = root.size++;
        append(imports, { source: specifierOf(statement.source), slot, bindings: [] });
        if (statement.exported) append(exports, { name: exportedName(statement.exported), read: { kind: 'namespace', slot } });
        else append(stars, slot);
      } else if (statement.type === 'ExportNamedDeclaration' && statement.source) {
        const slot = root.size++;
        append(imports, { source: specifierOf(statement.source), slot, bindings: [] });
        for (let k = 0; k < statement.specifiers.length; k++) {
          const spec = statement.specifiers[k];
          append(exports, { name: exportedName(spec.exported), read: { kind: 'reexport', slot, name: exportedName(spec.local) } });
        }
      }
    }
    // Local exports, read live from their bindings.
    for (let n = 0; n < program.body.length; n++) {
      const statement = program.body[n];
      if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
        if (statement.declaration) {
          const d = statement.declaration;
          const ids = newSafeList<Identifier>();
          if (d.type === 'VariableDeclaration') for (let j = 0; j < d.declarations.length; j++) patternIdentifiers(d.declarations[j].id, ids);
          else append(ids, d.id);
          for (let k = 0; k < ids.length; k++) append(exports, { name: ids[k].name, read: { kind: 'binding', read: this.rootRead(root, ids[k].name) } });
        }
        for (let k = 0; k < statement.specifiers.length; k++) {
          const spec = statement.specifiers[k];
          if (spec.local.type !== 'Identifier') throw new Error('interpreter: string export of a local');
          append(exports, { name: exportedName(spec.exported), read: { kind: 'binding', read: this.rootRead(root, spec.local.name) } });
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const d = statement.declaration;
        const local = (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id ? d.id.name : '*default*';
        append(exports, { name: 'default', read: { kind: 'binding', read: this.rootRead(root, local) } });
      }
    }
    const instantiate = this.scopeEntry(root, true);
    const body = this.moduleStatements(program);
    return {
      frame: frameTemplate(root.size, []),
      exportsSlot: bindingSlot(root, '%exports'),
      requireSlot: bindingSlot(root, '%require'),
      moduleSlot: bindingSlot(root, '%module'),
      filenameSlot: bindingSlot(root, '%filename'),
      dirnameSlot: bindingSlot(root, '%dirname'),
      imports: listOf(imports),
      exports: listOf(exports),
      stars: listOf(stars),
      instantiate,
      body,
    };
  }

  /** A module's statements, compiled as an async function body (top-level await). */
  private moduleStatements(program: Program): Code {
    const saved = this.shape;
    this.shape = 'async';
    try {
      return this.statementList(program.body);
    } finally {
      this.shape = saved;
    }
  }

  /** A live read of a module-scope binding, for an export getter. */
  private rootRead(root: FunctionScope, name: string): (env: Env) => unknown {
    const binding = root.bindings.get(name);
    if (!binding) throw new Error(`interpreter: export of undeclared ${name}`);
    // A getter can run before the declaration does (a cycle): it reads the TDZ.
    if (binding.declEnd >= 0) binding.tdz = true;
    const outer = this.enter(root);
    const read = this.bindingRead(binding, binding.tdz);
    this.scope = outer;
    return read;
  }
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
