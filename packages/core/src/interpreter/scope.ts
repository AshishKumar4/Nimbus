/**
 * scope.ts — the interpreter's static scope analysis.
 *
 * Runs once per compiled unit, before any closure is built. It declares every
 * binding where the language puts it (var and function declarations hoisted
 * to their function, let/const/class to their block, parameters, catch
 * parameters, class names and private names), resolves every identifier to
 * the binding it names or to the global object, and decides which scopes need
 * an environment of their own at runtime.
 *
 * A scope is MATERIALIZED (an array allocated each time it is entered) only
 * when a nested function can observe one of its bindings. Every other scope's
 * bindings are slots in the nearest materialized ancestor of the same
 * function, so a block in a loop body costs no allocation unless a closure
 * captures what it declares. Function scopes are always materialized: they
 * are the frame of a call.
 */
import type {
  AnonymousClassDeclaration, AnonymousFunctionDeclaration, AnyNode, ArrowFunctionExpression, BlockStatement, CatchClause, ClassDeclaration, ClassExpression,
  Expression, ForInStatement, ForOfStatement, ForStatement, FunctionDeclaration, FunctionExpression,
  Identifier, MethodDefinition, ModuleDeclaration, Pattern, PrivateIdentifier, Program, PropertyDefinition,
  Statement, StaticBlock, SwitchStatement, VariableDeclaration,
} from 'acorn';
import { UnsupportedSyntax } from './unsupported.js';

export type FunctionNode = FunctionDeclaration | AnonymousFunctionDeclaration | FunctionExpression | ArrowFunctionExpression;
export type ClassNode = ClassDeclaration | AnonymousClassDeclaration | ClassExpression;

export type BindingKind =
  | 'var' | 'let' | 'const' | 'class' | 'function' | 'param' | 'catch' | 'import'
  /** A named function expression's own name: read-only, silently in sloppy code. */
  | 'callee'
  /** The implicit bindings of a function: this, arguments, new.target, its home object, itself. */
  | 'special'
  /** A class's private name (#x), held by the class scope. */
  | 'private';

/**
 * Kinds that throw when read before their declaration runs: lexical
 * declarations, and parameters of a list with expressions (initialized in
 * order, each in its TDZ until then).
 */
const TDZ_KINDS: Record<BindingKind, boolean> = {
  var: false, let: true, const: true, class: true, function: false, param: true, catch: false,
  import: false, callee: false, special: false, private: false,
};

export class Binding {
  /** Index in its holder's environment array; 0 is the parent link. */
  slot = 0;
  /** Referenced from a function nested inside the one that declares it. */
  captured = false;
  /** Some reference can run before the declaration does, so the slot starts as the TDZ marker. */
  tdz = false;
  constructor(
    readonly name: string,
    readonly kind: BindingKind,
    readonly scope: Scope,
    /** Source offset after which, in the same function, the declaration has run. */
    readonly declEnd: number,
  ) {}
}

export type ScopeKind =
  | 'function' | 'module' | 'script' | 'field' | 'static'
  /** A function's body when its parameter list holds closures (its own var environment). */
  | 'body'
  | 'block' | 'switch' | 'loop' | 'catch' | 'class' | 'with';

export class Scope {
  readonly bindings = new Map<string, Binding>();
  readonly children: Scope[] = [];
  materialized = false;
  /** Slots of the environment this scope allocates, when materialized. */
  size = 1;
  /** Function declarations this scope instantiates on entry, in source order. */
  readonly functions: Array<FunctionDeclaration | AnonymousFunctionDeclaration> = [];
  readonly fn: FunctionScope;
  /** Whether code in this scope is strict: its function's mode, or a class body's (always strict). */
  readonly strict: boolean;
  constructor(readonly kind: ScopeKind, readonly parent: Scope | null, fn: FunctionScope | null, strict?: boolean) {
    this.fn = fn ?? (this instanceof FunctionScope ? this : unreachable('scope without a function'));
    this.strict = strict ?? (kind === 'class' || (parent !== null && parent.fn === this.fn ? parent.strict : false));
    if (parent) parent.children.push(this);
  }

  /** The scope whose environment holds this scope's bindings at runtime. */
  holder(): Scope {
    let s: Scope = this;
    while (!s.materialized) {
      if (!s.parent || s.parent.fn !== s.fn) unreachable('unmaterialized function scope');
      s = s.parent;
    }
    return s;
  }

  declare(name: string, kind: BindingKind, declEnd: number): Binding {
    const existing = this.bindings.get(name);
    if (existing) return existing;
    const binding = new Binding(name, kind, this, declEnd);
    this.bindings.set(name, binding);
    return binding;
  }
}

export type FunctionKind = 'function' | 'module' | 'script' | 'field' | 'static';

export class FunctionScope extends Scope {
  /** Arrow functions take this, arguments, new.target and super from their enclosing function. */
  readonly arrow: boolean;
  thisBinding: Binding | null = null;
  argumentsBinding: Binding | null = null;
  newTargetBinding: Binding | null = null;
  homeBinding: Binding | null = null;
  /** The function object itself: a named expression's name, or a class constructor (for super()). */
  funcBinding: Binding | null = null;
  /** Where the body's declarations live: this scope, or a 'body' scope below it. */
  varScope: Scope = this;
  /** Whether `this` starts uninitialized (a derived class constructor). */
  derived = false;
  /** Whether this function is a method with a home object (for super.x). */
  method = false;
  /** A script's top-level var and function names: global object properties, not bindings. */
  readonly globalVars: string[] = [];
  constructor(
    readonly functionKind: FunctionKind,
    parent: Scope | null,
    readonly node: FunctionNode | Program | StaticBlock | null,
    readonly strict: boolean,
    arrow: boolean,
    readonly async: boolean,
    readonly generator: boolean,
  ) {
    super(functionKind, parent, null, strict);
    this.arrow = arrow;
    this.materialized = true;
  }

  special(name: string): Binding {
    return this.declare(name, 'special', -1);
  }
}

/** What an identifier reference resolves to. */
export interface Reference {
  /** The binding, or null for the global object. */
  readonly binding: Binding | null;
  /** Whether this access must check the binding's TDZ marker. */
  readonly tdz: boolean;
  /** The `with` scopes between the reference and its binding, innermost first. */
  readonly withs: readonly Scope[];
}


function unreachable(what: string): never {
  throw new Error(`interpreter scope analysis: ${what}`);
}

/** Whether a function body opens with a "use strict" directive. */
export function hasUseStrict(body: readonly (Statement | ModuleDeclaration)[]): boolean {
  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') return false;
    if (statement.directive === 'use strict') return true;
  }
  return false;
}

/** The names a binding pattern declares, with the pattern identifiers. */
export function patternIdentifiers(pattern: Pattern, out: Identifier[] = []): Identifier[] {
  switch (pattern.type) {
    case 'Identifier': out.push(pattern); break;
    case 'ObjectPattern':
      for (const p of pattern.properties) patternIdentifiers(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const e of pattern.elements) if (e) patternIdentifiers(e, out);
      break;
    case 'RestElement': patternIdentifiers(pattern.argument, out); break;
    case 'AssignmentPattern': patternIdentifiers(pattern.left, out); break;
    case 'MemberExpression': break;
  }
  return out;
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** Each child node of `node`. */
export function forEachChildNode(node: AnyNode, visit: (child: AnyNode) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item);
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && 'start' in value;
}

export interface ClassScopes {
  readonly scope: Scope;
  /** The function scope instance field initializers run in, if the class has any. */
  readonly instanceFields: FunctionScope | null;
  /** The function scope static field initializers run in, if any. */
  readonly staticFields: FunctionScope | null;
}

/** The analysis of one compiled unit. */
export class Analysis {
  readonly refs = new Map<Identifier, Reference>();
  /** Scope of each scope-creating node (functions, blocks, loops, catch, switch, with, class). */
  readonly scopes = new Map<AnyNode, Scope>();
  readonly classes = new Map<ClassNode, ClassScopes>();
  /** For `this`, `super` and `new.target`: the function scope that provides them. */
  readonly receivers = new Map<AnyNode, FunctionScope>();
  /** Block-level function declarations that also assign a var of their name (Annex B.3.3). */
  readonly annexB = new Map<FunctionDeclaration, Binding>();
  readonly privateRefs = new Map<PrivateIdentifier, Reference>();
  /** A module's own scope, which holds `%module` for import.meta. */
  moduleScope: FunctionScope | null = null;

  scopeOf(node: AnyNode): Scope {
    return this.scopes.get(node) ?? unreachable(`no scope for ${node.type}`);
  }

  functionScopeOf(node: AnyNode): FunctionScope {
    const scope = this.scopeOf(node);
    return scope instanceof FunctionScope ? scope : unreachable(`${node.type} has no function scope`);
  }

  ref(node: Identifier): Reference {
    return this.refs.get(node) ?? unreachable(`unresolved identifier ${node.name}`);
  }

  privateRef(node: PrivateIdentifier): Reference {
    return this.privateRefs.get(node) ?? unreachable(`unresolved private name #${node.name}`);
  }
}

/** The specials a module's cell binds from its five wrapper arguments. */
export const MODULE_CELL_PARAMS = ['%exports', '%require', '%module', '%filename', '%dirname'] as const;

export interface UnitOptions {
  /** Program kind: a module's top level, a script's, or a function body (CommonJS and Function constructors). */
  readonly kind: 'module' | 'script';
  readonly strict: boolean;
}

/**
 * Analyze a program. For a script, top-level var and function declarations
 * become global object properties (they declare no binding here); for a
 * module, every top-level declaration is a binding of the module scope.
 */
export function analyzeProgram(program: Program, options: UnitOptions): Analysis {
  const analyzer = new Analyzer();
  const strict = options.strict || options.kind === 'module' || hasUseStrict(program.body);
  const root = new FunctionScope(options.kind, null, program, strict, false, options.kind === 'module', false);
  analyzer.analysis.scopes.set(program, root);
  if (options.kind === 'module') {
    // A module runs as a cell of the five CommonJS wrapper arguments.
    for (const name of MODULE_CELL_PARAMS) root.special(name);
    analyzer.analysis.moduleScope = root;
    for (const statement of program.body) analyzer.declareImports(statement, root);
  }
  analyzer.declareLexical(program.body, root);
  analyzer.hoistVars(program.body, root, true);
  analyzer.visitStatements(program.body, root);
  analyzer.finish(root);
  return analyzer.analysis;
}

/** Analyze a function expression that closes over the global scope (a Function constructor's). */
export function analyzeFunction(node: FunctionExpression): Analysis {
  const analyzer = new Analyzer();
  analyzer.visitFunction(node, null, { strict: false, method: false, derived: false, ctor: false });
  analyzer.finish(analyzer.analysis.functionScopeOf(node));
  return analyzer.analysis;
}

/**
 * Analyze a CommonJS module body: a function of Node's five wrapper
 * parameters whose `this` is `exports`.
 */
export function analyzeCommonJs(program: Program, params: readonly string[]): Analysis {
  const analyzer = new Analyzer();
  const strict = hasUseStrict(program.body);
  const root = new FunctionScope('function', null, program, strict, false, false, false);
  analyzer.analysis.scopes.set(program, root);
  for (const name of params) root.declare(name, 'param', -1);
  analyzer.declareLexical(program.body, root);
  analyzer.hoistVars(program.body, root, true);
  analyzer.visitStatements(program.body, root);
  analyzer.finish(root);
  return analyzer.analysis;
}

interface FunctionOptions {
  readonly strict: boolean;
  readonly method: boolean;
  readonly derived: boolean;
  readonly ctor: boolean;
}

class Analyzer {
  readonly analysis = new Analysis();

  // ── Declarations ──

  /** Module imports: bindings of the module scope, live reads of what they import. */
  declareImports(statement: Statement | ModuleDeclaration, scope: Scope): void {
    if (statement.type !== 'ImportDeclaration') return;
    for (const spec of statement.specifiers) {
      const binding = scope.declare(spec.local.name, 'import', -1);
      this.analysis.refs.set(spec.local, { binding, tdz: false, withs: [] });
    }
  }

  /**
   * Hoist var declarations (and, at a function's top level, function
   * declarations) from `body` into `target`. In a script, they are global
   * object properties instead, and declare nothing here.
   */
  hoistVars(body: readonly (Statement | ModuleDeclaration)[], target: Scope, topLevel: boolean): void {
    const script = target.fn.functionKind === 'script' && target === target.fn;
    const declareVar = (id: Identifier) => {
      if (script) target.fn.globalVars.push(id.name);
      else target.declare(id.name, 'var', -1);
    };
    const visit = (node: Statement | ModuleDeclaration, top: boolean): void => {
      switch (node.type) {
        case 'VariableDeclaration':
          if (node.kind === 'var') for (const d of node.declarations) for (const id of patternIdentifiers(d.id)) declareVar(id);
          return;
        case 'FunctionDeclaration':
          if (top) {
            if (!script) target.declare(node.id.name, 'function', -1);
          } else if (!target.fn.strict && !script) {
            // Annex B.3.3: a sloppy block function is also a var of its function.
            const lexical = target.bindings.get(node.id.name);
            if (!lexical || lexical.kind === 'var' || lexical.kind === 'function') {
              const params = target.fn.bindings.get(node.id.name);
              if (!params || params.kind !== 'param') target.declare(node.id.name, 'var', -1);
            }
          }
          return;
        case 'ExportNamedDeclaration':
          if (node.declaration) visit(node.declaration, top);
          return;
        case 'ExportDefaultDeclaration':
          if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
            target.declare(node.declaration.id.name, 'function', -1);
          }
          return;
        case 'BlockStatement': for (const s of node.body) visit(s, false); return;
        case 'IfStatement': visit(node.consequent, false); if (node.alternate) visit(node.alternate, false); return;
        case 'ForStatement':
          if (node.init && node.init.type === 'VariableDeclaration') visit(node.init, false);
          visit(node.body, false);
          return;
        case 'ForInStatement':
        case 'ForOfStatement':
          if (node.left.type === 'VariableDeclaration') visit(node.left, false);
          visit(node.body, false);
          return;
        case 'WhileStatement': case 'DoWhileStatement': case 'LabeledStatement': case 'WithStatement':
          visit(node.body, false);
          return;
        case 'TryStatement':
          visit(node.block, false);
          if (node.handler) visit(node.handler.body, false);
          if (node.finalizer) visit(node.finalizer, false);
          return;
        case 'SwitchStatement':
          for (const c of node.cases) for (const s of c.consequent) visit(s, false);
          return;
        default:
          return;
      }
    };
    for (const statement of body) visit(statement, topLevel);
  }

  /**
   * Declare the lexical declarations directly in `body` (let, const, class,
   * and block-level functions) in `scope`. A function's or module's
   * top-level functions were hoisted as vars and are skipped here.
   */
  declareLexical(body: readonly (Statement | ModuleDeclaration)[], scope: Scope): void {
    const functionLevel = scope === scope.fn.varScope || scope.kind === 'body';
    const script = scope.fn.functionKind === 'script' && scope === scope.fn;
    for (const raw of body) {
      let node: Statement | ModuleDeclaration = raw;
      if (node.type === 'ExportNamedDeclaration' && node.declaration) node = node.declaration;
      if (node.type === 'ExportDefaultDeclaration') {
        const d = node.declaration;
        if (d.type === 'ClassDeclaration') {
          scope.declare(d.id ? d.id.name : '*default*', 'class', d.end);
        } else if (d.type === 'FunctionDeclaration') {
          if (!d.id) scope.declare('*default*', 'function', -1);
          scope.functions.push(d);
        } else {
          scope.declare('*default*', 'const', node.end);
        }
        continue;
      }
      switch (node.type) {
        case 'VariableDeclaration':
          if (node.kind === 'using' || node.kind === 'await using') throw new UnsupportedSyntax(`${node.kind} declarations`);
          if (node.kind !== 'var') {
            for (const d of node.declarations) {
              for (const id of patternIdentifiers(d.id)) scope.declare(id.name, node.kind, d.end);
            }
          }
          break;
        case 'ClassDeclaration':
          scope.declare(node.id.name, 'class', node.end);
          break;
        case 'FunctionDeclaration':
          if (functionLevel || script) {
            scope.functions.push(node);
          } else {
            scope.declare(node.id.name, 'function', -1);
            scope.functions.push(node);
          }
          break;
        default:
          break;
      }
    }
  }

  declarePattern(pattern: Pattern, kind: BindingKind, scope: Scope, declEnd = -1): void {
    for (const id of patternIdentifiers(pattern)) scope.declare(id.name, kind, declEnd);
  }

  // ── References ──

  /**
   * Resolve a reference. An `init` reference is the declaration itself
   * initializing its binding: it never checks the TDZ.
   */
  resolve(id: Identifier, scope: Scope, init = false): void {
    const name = id.name;
    const withs: Scope[] = [];
    let s: Scope | null = scope;
    while (s) {
      let binding = s.bindings.get(name);
      if (!binding && name === 'arguments' && s instanceof FunctionScope && !s.arrow && s.functionKind === 'function') {
        binding = s.special('arguments');
        s.argumentsBinding = binding;
      }
      if (binding) {
        if (binding.scope.fn !== scope.fn) binding.captured = true;
        const tdz = !init && TDZ_KINDS[binding.kind] && binding.declEnd >= 0
          && (binding.scope.fn !== scope.fn || id.start < binding.declEnd || binding.scope.kind === 'switch');
        if (tdz) binding.tdz = true;
        this.analysis.refs.set(id, { binding, tdz, withs });
        return;
      }
      if (s.kind === 'with') withs.push(s);
      s = s.parent;
    }
    this.analysis.refs.set(id, { binding: null, tdz: false, withs });
  }

  /** The function scope that gives `this` (and super, new.target) at `scope`. */
  receiver(scope: Scope): FunctionScope {
    let fn = scope.fn;
    while (fn.arrow) {
      const parent = fn.parent;
      if (!parent) unreachable('arrow at the root');
      fn = parent.fn;
    }
    return fn;
  }

  useThis(node: AnyNode, scope: Scope): void {
    const fn = this.receiver(scope);
    if (!fn.thisBinding) fn.thisBinding = fn.special('%this');
    if (fn.derived) fn.thisBinding.tdz = true;
    if (fn !== scope.fn) fn.thisBinding.captured = true;
    this.analysis.receivers.set(node, fn);
  }

  useHome(node: AnyNode, scope: Scope): void {
    const fn = this.receiver(scope);
    if (!fn.homeBinding) fn.homeBinding = fn.special('%home');
    if (fn !== scope.fn) fn.homeBinding.captured = true;
    this.useThis(node, scope);
  }

  useNewTarget(node: AnyNode, scope: Scope): void {
    const fn = this.receiver(scope);
    if (!fn.newTargetBinding) fn.newTargetBinding = fn.special('%newtarget');
    if (fn !== scope.fn) fn.newTargetBinding.captured = true;
    this.analysis.receivers.set(node, fn);
  }

  /** super(...): the constructor's this, new.target and the constructor itself. */
  useSuperCall(node: AnyNode, scope: Scope): void {
    this.useThis(node, scope);
    this.useNewTarget(node, scope);
    const fn = this.receiver(scope);
    if (!fn.funcBinding) fn.funcBinding = fn.special('%func');
    if (fn !== scope.fn) fn.funcBinding.captured = true;
  }

  // ── Walk ──

  visitStatements(body: readonly (Statement | ModuleDeclaration)[], scope: Scope): void {
    for (const statement of body) this.visitStatement(statement, scope);
  }

  visitStatement(node: Statement | ModuleDeclaration, scope: Scope): void {
    switch (node.type) {
      case 'ExpressionStatement': this.visitExpression(node.expression, scope); return;
      case 'BlockStatement': this.visitBlock(node, scope); return;
      case 'EmptyStatement': case 'DebuggerStatement': return;
      case 'WithStatement': {
        this.visitExpression(node.object, scope);
        const withScope = new Scope('with', scope, scope.fn);
        withScope.materialized = true;
        this.analysis.scopes.set(node, withScope);
        this.visitStatement(node.body, withScope);
        return;
      }
      case 'ReturnStatement': if (node.argument) this.visitExpression(node.argument, scope); return;
      case 'LabeledStatement': this.visitStatement(node.body, scope); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'IfStatement':
        this.visitExpression(node.test, scope);
        this.visitStatement(node.consequent, scope);
        if (node.alternate) this.visitStatement(node.alternate, scope);
        return;
      case 'SwitchStatement': this.visitSwitch(node, scope); return;
      case 'ThrowStatement': this.visitExpression(node.argument, scope); return;
      case 'TryStatement':
        this.visitBlock(node.block, scope);
        if (node.handler) this.visitCatch(node.handler, scope);
        if (node.finalizer) this.visitBlock(node.finalizer, scope);
        return;
      case 'WhileStatement':
        this.visitExpression(node.test, scope);
        this.visitStatement(node.body, scope);
        return;
      case 'DoWhileStatement':
        this.visitStatement(node.body, scope);
        this.visitExpression(node.test, scope);
        return;
      case 'ForStatement': this.visitFor(node, scope); return;
      case 'ForInStatement': case 'ForOfStatement': this.visitForInOf(node, scope); return;
      case 'FunctionDeclaration': {
        this.visitFunction(node, scope, { strict: scope.strict, method: false, derived: false, ctor: false });
        this.noteAnnexB(node, scope);
        return;
      }
      case 'VariableDeclaration': this.visitVariableDeclaration(node, scope); return;
      case 'ClassDeclaration': this.visitClass(node, scope); return;
      case 'ImportDeclaration': return;
      case 'ExportNamedDeclaration':
        if (node.declaration) this.visitStatement(node.declaration, scope);
        else if (!node.source) for (const spec of node.specifiers) if (spec.local.type === 'Identifier') this.resolve(spec.local, scope);
        return;
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if (d.type === 'FunctionDeclaration') {
          this.visitFunction(d, scope, { strict: true, method: false, derived: false, ctor: false });
        } else if (d.type === 'ClassDeclaration') {
          this.visitClass(d, scope);
        } else {
          this.visitExpression(d, scope);
        }
        return;
      }
      case 'ExportAllDeclaration': return;
    }
  }

  /**
   * Annex B.3.3: evaluating a sloppy block-level function declaration also
   * assigns the function to the var of its name, unless a lexical
   * declaration between the block and the function claims the name.
   */
  noteAnnexB(node: FunctionDeclaration, scope: Scope): void {
    const varScope = scope.fn.varScope;
    if (scope.strict || scope === varScope || scope.fn.functionKind === 'script') return;
    const target = varScope.bindings.get(node.id.name);
    if (!target || target.kind !== 'var') return;
    for (let s = scope.parent; s && s !== varScope; s = s.parent) {
      const between = s.bindings.get(node.id.name);
      if (between && between.kind !== 'var') return;
    }
    this.analysis.annexB.set(node, target);
  }

  visitVariableDeclaration(node: VariableDeclaration, scope: Scope): void {
    for (const d of node.declarations) {
      this.visitPattern(d.id, scope, true);
      if (d.init) this.visitExpression(d.init, scope);
    }
  }

  visitBlock(node: BlockStatement, scope: Scope): void {
    const block = new Scope('block', scope, scope.fn);
    this.analysis.scopes.set(node, block);
    this.declareLexical(node.body, block);
    this.visitStatements(node.body, block);
  }

  visitSwitch(node: SwitchStatement, scope: Scope): void {
    this.visitExpression(node.discriminant, scope);
    const block = new Scope('switch', scope, scope.fn);
    this.analysis.scopes.set(node, block);
    for (const c of node.cases) this.declareLexical(c.consequent, block);
    for (const c of node.cases) {
      if (c.test) this.visitExpression(c.test, block);
      this.visitStatements(c.consequent, block);
    }
  }

  visitCatch(node: CatchClause, scope: Scope): void {
    const catchScope = new Scope('catch', scope, scope.fn);
    this.analysis.scopes.set(node, catchScope);
    if (node.param) {
      this.declarePattern(node.param, 'catch', catchScope);
      this.visitPattern(node.param, catchScope, true);
    }
    this.visitBlock(node.body, catchScope);
  }

  visitFor(node: ForStatement, scope: Scope): void {
    let inner = scope;
    if (node.init && node.init.type === 'VariableDeclaration' && node.init.kind !== 'var') {
      inner = new Scope('loop', scope, scope.fn);
      this.analysis.scopes.set(node, inner);
      this.declareLexical([node.init], inner);
    }
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') this.visitVariableDeclaration(node.init, inner);
      else this.visitExpression(node.init, inner);
    }
    if (node.test) this.visitExpression(node.test, inner);
    if (node.update) this.visitExpression(node.update, inner);
    this.visitStatement(node.body, inner);
  }

  visitForInOf(node: ForInStatement | ForOfStatement, scope: Scope): void {
    const left = node.left;
    if (left.type === 'VariableDeclaration' && left.kind !== 'var') {
      // The right side sees the loop's names in their TDZ (a separate scope in the spec).
      const tdzScope = new Scope('loop', scope, scope.fn);
      this.analysis.scopes.set(node.right, tdzScope);
      for (const d of left.declarations) this.declarePattern(d.id, left.kind === 'const' ? 'const' : 'let', tdzScope, node.end);
      this.visitExpression(node.right, tdzScope);
      const inner = new Scope('loop', scope, scope.fn);
      this.analysis.scopes.set(node, inner);
      this.declareLexical([left], inner);
      for (const d of left.declarations) this.visitPattern(d.id, inner, true);
      this.visitStatement(node.body, inner);
      return;
    }
    this.visitExpression(node.right, scope);
    if (left.type === 'VariableDeclaration') {
      for (const d of left.declarations) {
        this.visitPattern(d.id, scope, true);
        if (d.init) this.visitExpression(d.init, scope);
      }
    } else {
      this.visitPattern(left, scope, false);
    }
    this.visitStatement(node.body, scope);
  }

  /**
   * Visit a pattern: its default values and computed keys are expressions,
   * its identifiers are resolved (as declarations, or as assignment targets).
   */
  visitPattern(pattern: Pattern, scope: Scope, declaration: boolean): void {
    switch (pattern.type) {
      case 'Identifier':
        this.resolve(pattern, scope, declaration);
        return;
      case 'MemberExpression': this.visitExpression(pattern, scope); return;
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') {
            this.visitPattern(p.argument, scope, declaration);
          } else {
            if (p.computed) this.visitExpression(p.key, scope);
            this.visitPattern(p.value, scope, declaration);
          }
        }
        return;
      case 'ArrayPattern':
        for (const e of pattern.elements) if (e) this.visitPattern(e, scope, declaration);
        return;
      case 'RestElement': this.visitPattern(pattern.argument, scope, declaration); return;
      case 'AssignmentPattern':
        this.visitPattern(pattern.left, scope, declaration);
        this.visitExpression(pattern.right, scope);
        return;
    }
  }

  visitFunction(node: FunctionNode, scope: Scope | null, options: FunctionOptions): FunctionScope {
    const arrow = node.type === 'ArrowFunctionExpression';
    const body = node.body;
    const strict = options.strict || (body.type === 'BlockStatement' && hasUseStrict(body.body));
    const fn = new FunctionScope('function', scope, node, strict, arrow, node.async, node.generator);
    fn.method = options.method;
    fn.derived = options.derived;
    this.analysis.scopes.set(node, fn);
    // With expressions in the list, each parameter is in its TDZ until bound.
    const expressions = node.params.some((p) => p.type !== 'Identifier');
    for (const param of node.params) this.declarePattern(param, 'param', fn, expressions ? param.end : -1);
    if (body.type === 'BlockStatement') {
      // With parameter expressions the body's declarations are a scope of
      // their own, which the parameter list cannot see.
      if (expressions) fn.varScope = new Scope('body', fn, fn);
      this.analysis.scopes.set(body, fn.varScope);
      this.declareLexical(body.body, fn.varScope);
      this.hoistVars(body.body, fn.varScope, true);
    }
    if (node.type === 'FunctionExpression' && node.id && !fn.bindings.has(node.id.name) && !fn.varScope.bindings.has(node.id.name)) {
      fn.funcBinding = fn.declare(node.id.name, 'callee', -1);
    }
    if (options.ctor && !fn.funcBinding) fn.funcBinding = fn.special('%func');
    // `var arguments` is the arguments object's own binding, initialized with it.
    const argumentsVar = fn.varScope.bindings.get('arguments');
    const argumentsParam = fn.bindings.get('arguments');
    if (!arrow && argumentsVar && argumentsVar.kind === 'var' && !(argumentsParam && argumentsParam.kind === 'param')) {
      if (fn.varScope === fn) {
        fn.argumentsBinding = argumentsVar;
      } else {
        fn.argumentsBinding = fn.special('arguments');
      }
    }
    for (const param of node.params) this.visitPattern(param, fn, true);
    if (body.type === 'BlockStatement') this.visitStatements(body.body, fn.varScope);
    else this.visitExpression(body, fn);
    return fn;
  }

  visitClass(node: ClassNode, scope: Scope): void {
    const classScope = new Scope('class', scope, scope.fn);
    this.analysis.scopes.set(node, classScope);
    if (node.id) classScope.declare(node.id.name, 'class', node.end);
    // The heritage sees the class's own name, uninitialized.
    if (node.superClass) this.visitExpression(node.superClass, classScope);
    for (const member of node.body.body) {
      if (member.type !== 'StaticBlock' && member.key.type === 'PrivateIdentifier') {
        classScope.declare(`#${member.key.name}`, 'private', -1);
      }
    }
    let instanceFields: FunctionScope | null = null;
    let staticFields: FunctionScope | null = null;
    const derived = Boolean(node.superClass);
    for (const member of node.body.body) {
      if (member.type === 'StaticBlock') {
        this.visitStaticBlock(member, classScope);
        continue;
      }
      if (member.computed) this.visitExpression(member.key, classScope);
      if (member.key.type === 'PrivateIdentifier') this.resolvePrivate(member.key, classScope);
      if (member.type === 'MethodDefinition') {
        this.visitMethod(member, classScope, derived);
        continue;
      }
      if (member.value) {
        let fieldScope: FunctionScope | null = member.static ? staticFields : instanceFields;
        if (!fieldScope) {
          fieldScope = new FunctionScope('field', classScope, null, true, false, false, false);
          fieldScope.method = true;
          if (member.static) staticFields = fieldScope; else instanceFields = fieldScope;
        }
        this.visitFieldValue(member, fieldScope);
      }
    }
    this.analysis.classes.set(node, { scope: classScope, instanceFields, staticFields });
  }

  visitFieldValue(member: PropertyDefinition, fieldScope: FunctionScope): void {
    if (member.value) this.visitExpression(member.value, fieldScope);
  }

  visitMethod(member: MethodDefinition, classScope: Scope, derived: boolean): void {
    const ctor = member.kind === 'constructor';
    this.visitFunction(member.value, classScope, { strict: true, method: true, derived: ctor && derived, ctor });
  }

  visitStaticBlock(block: StaticBlock, classScope: Scope): void {
    const fn = new FunctionScope('static', classScope, block, true, false, false, false);
    fn.method = true;
    this.analysis.scopes.set(block, fn);
    this.declareLexical(block.body, fn);
    this.hoistVars(block.body, fn, true);
    this.visitStatements(block.body, fn);
  }

  resolvePrivate(node: PrivateIdentifier, scope: Scope): void {
    // Private names resolve like identifiers, under their '#'-prefixed name.
    const id: Identifier = { type: 'Identifier', name: `#${node.name}`, start: node.start, end: node.end };
    this.resolve(id, scope);
    this.analysis.privateRefs.set(node, this.analysis.ref(id));
  }

  visitExpression(node: Expression | PrivateIdentifier, scope: Scope): void {
    switch (node.type) {
      case 'Identifier': this.resolve(node, scope); return;
      case 'PrivateIdentifier': this.resolvePrivate(node, scope); return;
      case 'Literal': return;
      case 'ThisExpression': this.useThis(node, scope); return;
      case 'ArrayExpression':
        for (const e of node.elements) if (e) this.visitExpression(e.type === 'SpreadElement' ? e.argument : e, scope);
        return;
      case 'ObjectExpression':
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') {
            this.visitExpression(p.argument, scope);
            continue;
          }
          if (p.computed) this.visitExpression(p.key, scope);
          if (p.value.type === 'FunctionExpression' && (p.method || p.kind !== 'init')) {
            this.visitFunction(p.value, scope, { strict: scope.strict, method: true, derived: false, ctor: false });
          } else {
            this.visitExpression(p.value, scope);
          }
        }
        return;
      case 'FunctionExpression': case 'ArrowFunctionExpression':
        this.visitFunction(node, scope, { strict: scope.strict, method: false, derived: false, ctor: false });
        return;
      case 'UnaryExpression': this.visitExpression(node.argument, scope); return;
      case 'UpdateExpression': this.visitExpression(node.argument, scope); return;
      case 'BinaryExpression':
        this.visitExpression(node.left, scope);
        this.visitExpression(node.right, scope);
        return;
      case 'AssignmentExpression':
        this.visitPattern(node.left, scope, false);
        this.visitExpression(node.right, scope);
        return;
      case 'LogicalExpression':
        this.visitExpression(node.left, scope);
        this.visitExpression(node.right, scope);
        return;
      case 'MemberExpression':
        if (node.object.type === 'Super') this.useHome(node.object, scope);
        else this.visitExpression(node.object, scope);
        if (node.computed || node.property.type === 'PrivateIdentifier') this.visitExpression(node.property, scope);
        return;
      case 'ConditionalExpression':
        this.visitExpression(node.test, scope);
        this.visitExpression(node.consequent, scope);
        this.visitExpression(node.alternate, scope);
        return;
      case 'CallExpression':
        if (node.callee.type === 'Super') this.useSuperCall(node.callee, scope);
        else this.visitExpression(node.callee, scope);
        for (const a of node.arguments) this.visitExpression(a.type === 'SpreadElement' ? a.argument : a, scope);
        return;
      case 'NewExpression':
        this.visitExpression(node.callee, scope);
        for (const a of node.arguments) this.visitExpression(a.type === 'SpreadElement' ? a.argument : a, scope);
        return;
      case 'SequenceExpression': for (const e of node.expressions) this.visitExpression(e, scope); return;
      case 'YieldExpression': if (node.argument) this.visitExpression(node.argument, scope); return;
      case 'AwaitExpression': this.visitExpression(node.argument, scope); return;
      case 'TemplateLiteral': for (const e of node.expressions) this.visitExpression(e, scope); return;
      case 'TaggedTemplateExpression':
        this.visitExpression(node.tag, scope);
        for (const e of node.quasi.expressions) this.visitExpression(e, scope);
        return;
      case 'ClassExpression': this.visitClass(node, scope); return;
      case 'MetaProperty':
        if (node.meta.name === 'new') this.useNewTarget(node, scope);
        return;
      case 'ChainExpression': this.visitExpression(node.expression, scope); return;
      case 'ImportExpression':
        this.visitExpression(node.source, scope);
        if (node.options) this.visitExpression(node.options, scope);
        return;
      case 'ParenthesizedExpression': this.visitExpression(node.expression, scope); return;
    }
  }

  /** Decide which scopes are materialized and give every binding its slot. */
  finish(root: FunctionScope): void {
    layoutFunction(root);
  }
}

function layoutFunction(fn: FunctionScope): void {
  fn.size = 1;
  assignSlots(fn, fn);
}

function assignSlots(scope: Scope, holder: Scope): void {
  for (const binding of scope.bindings.values()) binding.slot = holder.size++;
  for (const child of scope.children) {
    if (child instanceof FunctionScope) {
      layoutFunction(child);
      continue;
    }
    let captured = child.kind === 'with';
    for (const binding of child.bindings.values()) if (binding.captured) captured = true;
    child.materialized = captured;
    if (captured) {
      // A with scope keeps its object in slot 1.
      child.size = child.kind === 'with' ? 2 : 1;
      assignSlots(child, child);
    } else {
      assignSlots(child, holder);
    }
  }
}
