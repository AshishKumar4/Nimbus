import { SafeMap, append, arrayIsArray, objectKeys, reflectGet, someItem } from './intrinsics.js';
import { UnsupportedSyntax } from './unsupported.js';
/**
 * Kinds that throw when read before their declaration runs: lexical
 * declarations, and parameters of a list with expressions (initialized in
 * order, each in its TDZ until then).
 */
const TDZ_KINDS = {
    var: false, let: true, const: true, class: true, function: false, param: true, catch: false,
    import: false, callee: false, special: false, private: false,
};
export class Binding {
    name;
    kind;
    scope;
    declEnd;
    /** Index in its holder's environment array; 0 is the parent link. */
    slot = 0;
    /** Referenced from a function nested inside the one that declares it. */
    captured = false;
    /** Some reference can run before the declaration does, so the slot starts as the TDZ marker. */
    tdz = false;
    constructor(name, kind, scope, 
    /** Source offset after which, in the same function, the declaration has run. */
    declEnd) {
        this.name = name;
        this.kind = kind;
        this.scope = scope;
        this.declEnd = declEnd;
    }
}
export class Scope {
    kind;
    parent;
    bindings = new SafeMap();
    /** The scopes inside this one, for laying out slots; null once the analysis is released. */
    children = [];
    materialized = false;
    /** Slots of the environment this scope allocates, when materialized. */
    size = 1;
    /** Function declarations this scope instantiates on entry, in source order. */
    functions = [];
    fn;
    /** Whether code in this scope is strict: its function's mode, or a class body's (always strict). */
    strict;
    constructor(kind, parent, fn, strict) {
        this.kind = kind;
        this.parent = parent;
        this.fn = fn ?? (this instanceof FunctionScope ? this : unreachable('scope without a function'));
        this.strict = strict ?? (kind === 'class' || (parent !== null && parent.fn === this.fn ? parent.strict : false));
        if (parent !== null && parent.children !== null)
            append(parent.children, this);
    }
    /** The scope whose environment holds this scope's bindings at runtime. */
    holder() {
        let s = this;
        while (!s.materialized) {
            if (!s.parent || s.parent.fn !== s.fn)
                unreachable('unmaterialized function scope');
            s = s.parent;
        }
        return s;
    }
    /** The scope's bindings, in the order they were declared. */
    bindingList() {
        const list = [];
        this.bindings.forEach((binding) => { append(list, binding); });
        return list;
    }
    declare(name, kind, declEnd) {
        const existing = this.bindings.get(name);
        if (existing)
            return existing;
        const binding = new Binding(name, kind, this, declEnd);
        this.bindings.set(name, binding);
        return binding;
    }
}
export class FunctionScope extends Scope {
    functionKind;
    strict;
    async;
    generator;
    /** Arrow functions take this, arguments, new.target and super from their enclosing function. */
    arrow;
    thisBinding = null;
    argumentsBinding = null;
    newTargetBinding = null;
    homeBinding = null;
    /** The function object itself: a named expression's name, or a class constructor (for super()). */
    funcBinding = null;
    /** Where the body's declarations live: this scope, or a 'body' scope below it. */
    varScope = this;
    /** Whether `this` starts uninitialized (a derived class constructor). */
    derived = false;
    /** Whether this function is a method with a home object (for super.x). */
    method = false;
    /** A script's top-level var and function names: global object properties, not bindings. */
    globalVars = [];
    constructor(functionKind, parent, strict, arrow, async, generator) {
        super(functionKind, parent, null, strict);
        this.functionKind = functionKind;
        this.strict = strict;
        this.async = async;
        this.generator = generator;
        this.arrow = arrow;
        this.materialized = true;
    }
    special(name) {
        return this.declare(name, 'special', -1);
    }
}
function unreachable(what) {
    throw new Error(`interpreter scope analysis: ${what}`);
}
/** Whether a function body opens with a "use strict" directive. */
export function hasUseStrict(body) {
    for (let i = 0; i < body.length; i++) {
        const statement = body[i];
        if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string')
            return false;
        if (statement.directive === 'use strict')
            return true;
    }
    return false;
}
/** The names a binding pattern declares, with the pattern identifiers. */
export function patternIdentifiers(pattern, out = []) {
    switch (pattern.type) {
        case 'Identifier':
            append(out, pattern);
            break;
        case 'ObjectPattern':
            for (let i = 0; i < pattern.properties.length; i++) {
                const p = pattern.properties[i];
                patternIdentifiers(p.type === 'RestElement' ? p.argument : p.value, out);
            }
            break;
        case 'ArrayPattern':
            for (let i = 0; i < pattern.elements.length; i++) {
                const e = pattern.elements[i];
                if (e)
                    patternIdentifiers(e, out);
            }
            break;
        case 'RestElement':
            patternIdentifiers(pattern.argument, out);
            break;
        case 'AssignmentPattern':
            patternIdentifiers(pattern.left, out);
            break;
        case 'MemberExpression': break;
    }
    return out;
}
/** The child nodes of `node`, in a new array. */
export function childNodes(node) {
    const children = [];
    forEachChildNode(node, (child) => { append(children, child); });
    return children;
}
/** Each child node of `node`. */
export function forEachChildNode(node, visit) {
    const keys = objectKeys(node);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
            continue;
        const value = reflectGet(node, key);
        if (arrayIsArray(value)) {
            for (let j = 0; j < value.length; j++) {
                const item = value[j];
                if (isNode(item))
                    visit(item);
            }
        }
        else if (isNode(value)) {
            visit(value);
        }
    }
}
function isNode(value) {
    return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && 'start' in value;
}
/** The analysis of one compiled unit. */
export class Analysis {
    refs = new SafeMap();
    /** Scope of each scope-creating node (functions, blocks, loops, catch, switch, with, class). */
    scopes = new SafeMap();
    classes = new SafeMap();
    /** For `this`, `super` and `new.target`: the function scope that provides them. */
    receivers = new SafeMap();
    /** Block-level function declarations that also assign a var of their name (Annex B.3.3). */
    annexB = new SafeMap();
    privateRefs = new SafeMap();
    /** A module's own scope, which holds `%module` for import.meta. */
    moduleScope = null;
    scopeOf(node) {
        return this.scopes.get(node) ?? unreachable(`no scope for ${node.type}`);
    }
    functionScopeOf(node) {
        const scope = this.scopeOf(node);
        return scope instanceof FunctionScope ? scope : unreachable(`${node.type} has no function scope`);
    }
    ref(node) {
        return this.refs.get(node) ?? unreachable(`unresolved identifier ${node.name}`);
    }
    privateRef(node) {
        return this.privateRefs.get(node) ?? unreachable(`unresolved private name #${node.name}`);
    }
}
/** The specials a module's cell binds from its five wrapper arguments. */
export const MODULE_CELL_PARAMS = ['%exports', '%require', '%module', '%filename', '%dirname'];
/**
 * Analyze a program. For a script, top-level var and function declarations
 * become global object properties (they declare no binding here); for a
 * module, every top-level declaration is a binding of the module scope.
 */
export function analyzeProgram(program, options) {
    const analyzer = new Analyzer();
    const strict = options.strict || options.kind === 'module' || hasUseStrict(program.body);
    const root = new FunctionScope(options.kind, null, strict, false, options.kind === 'module', false);
    analyzer.analysis.scopes.set(program, root);
    if (options.kind === 'module') {
        // A module runs as a cell of the five CommonJS wrapper arguments.
        for (let i = 0; i < MODULE_CELL_PARAMS.length; i++) {
            const name = MODULE_CELL_PARAMS[i];
            root.special(name);
        }
        analyzer.analysis.moduleScope = root;
        for (let i = 0; i < program.body.length; i++) {
            const statement = program.body[i];
            analyzer.declareImports(statement, root);
        }
    }
    analyzer.declareLexical(program.body, root);
    analyzer.hoistVars(program.body, root, true);
    analyzer.visitStatements(program.body, root);
    analyzer.finish(root);
    return analyzer.analysis;
}
/** Analyze a function expression that closes over the global scope (a Function constructor's). */
export function analyzeFunction(node) {
    const analyzer = new Analyzer();
    analyzer.visitFunction(node, null, { strict: false, method: false, derived: false, ctor: false, unbound: true });
    analyzer.finish(analyzer.analysis.functionScopeOf(node));
    return analyzer.analysis;
}
/**
 * Analyze a function compiled on its first call, parsed again on its own
 * (reparse.ts), inside the scopes of the function that defined it, which an
 * earlier analysis made and released. Their bindings and slots stand: this
 * analysis resolves the function's names to them as that one did.
 */
export function analyzeLazyFunction(node, outer, options, moduleScope) {
    const analyzer = new Analyzer();
    analyzer.analysis.moduleScope = moduleScope;
    analyzer.finish(analyzer.visitFunction(node, outer, options));
    return analyzer.analysis;
}
/**
 * Release an analysis once its function is compiled: what it keeps is what a
 * function compiled later needs of the scopes it sits in. Its scopes drop
 * their links to inner scopes and the declarations they held, and each keeps
 * only the bindings a nested function refers to (captured) and the implicit
 * ones (this, arguments, the module), which is all a later analysis can
 * resolve a name to. Scopes no function compiled later sits in are then
 * garbage.
 */
export function releaseScopes(scope) {
    const children = scope.children;
    scope.children = null;
    scope.functions = [];
    const dropped = [];
    scope.bindings.forEach((binding, name) => {
        if (!binding.captured && binding.kind !== 'special')
            append(dropped, name);
    });
    for (let i = 0; i < dropped.length; i++)
        scope.bindings.delete(dropped[i]);
    if (children !== null)
        for (let i = 0; i < children.length; i++)
            releaseScopes(children[i]);
}
/**
 * Analyze a CommonJS module body: a function of Node's five wrapper
 * parameters whose `this` is `exports`.
 */
export function analyzeCommonJs(program, params) {
    const analyzer = new Analyzer();
    const strict = hasUseStrict(program.body);
    const root = new FunctionScope('function', null, strict, false, false, false);
    analyzer.analysis.scopes.set(program, root);
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        root.declare(name, 'param', -1);
    }
    analyzer.declareLexical(program.body, root);
    analyzer.hoistVars(program.body, root, true);
    analyzer.visitStatements(program.body, root);
    analyzer.finish(root);
    return analyzer.analysis;
}
class Analyzer {
    analysis = new Analysis();
    // ── Declarations ──
    /** Module imports: bindings of the module scope, live reads of what they import. */
    declareImports(statement, scope) {
        if (statement.type !== 'ImportDeclaration')
            return;
        for (let i = 0; i < statement.specifiers.length; i++) {
            const spec = statement.specifiers[i];
            const binding = scope.declare(spec.local.name, 'import', -1);
            this.analysis.refs.set(spec.local, { binding, tdz: false, withs: [] });
        }
    }
    /**
     * Hoist var declarations (and, at a function's top level, function
     * declarations) from `body` into `target`. In a script, they are global
     * object properties instead, and declare nothing here.
     */
    hoistVars(body, target, topLevel) {
        const script = target.fn.functionKind === 'script' && target === target.fn;
        const declareVar = (id) => {
            if (script)
                append(target.fn.globalVars, id.name);
            else
                target.declare(id.name, 'var', -1);
        };
        const visit = (node, top) => {
            switch (node.type) {
                case 'VariableDeclaration':
                    if (node.kind === 'var') {
                        for (let i = 0; i < node.declarations.length; i++) {
                            const ids = patternIdentifiers(node.declarations[i].id);
                            for (let j = 0; j < ids.length; j++)
                                declareVar(ids[j]);
                        }
                    }
                    return;
                case 'FunctionDeclaration':
                    if (top) {
                        if (!script)
                            target.declare(node.id.name, 'function', -1);
                    }
                    else if (!target.fn.strict && !script) {
                        // Annex B.3.3: a sloppy block function is also a var of its function.
                        const lexical = target.bindings.get(node.id.name);
                        if (!lexical || lexical.kind === 'var' || lexical.kind === 'function') {
                            const params = target.fn.bindings.get(node.id.name);
                            if (!params || params.kind !== 'param')
                                target.declare(node.id.name, 'var', -1);
                        }
                    }
                    return;
                case 'ExportNamedDeclaration':
                    if (node.declaration)
                        visit(node.declaration, top);
                    return;
                case 'ExportDefaultDeclaration':
                    if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
                        target.declare(node.declaration.id.name, 'function', -1);
                    }
                    return;
                case 'BlockStatement':
                    for (let i = 0; i < node.body.length; i++) {
                        const s = node.body[i];
                        visit(s, false);
                    }
                    return;
                case 'IfStatement':
                    visit(node.consequent, false);
                    if (node.alternate)
                        visit(node.alternate, false);
                    return;
                case 'ForStatement':
                    if (node.init && node.init.type === 'VariableDeclaration')
                        visit(node.init, false);
                    visit(node.body, false);
                    return;
                case 'ForInStatement':
                case 'ForOfStatement':
                    if (node.left.type === 'VariableDeclaration')
                        visit(node.left, false);
                    visit(node.body, false);
                    return;
                case 'WhileStatement':
                case 'DoWhileStatement':
                case 'LabeledStatement':
                case 'WithStatement':
                    visit(node.body, false);
                    return;
                case 'TryStatement':
                    visit(node.block, false);
                    if (node.handler)
                        visit(node.handler.body, false);
                    if (node.finalizer)
                        visit(node.finalizer, false);
                    return;
                case 'SwitchStatement':
                    for (let i = 0; i < node.cases.length; i++) {
                        const c = node.cases[i];
                        for (let j = 0; j < c.consequent.length; j++) {
                            const s = c.consequent[j];
                            visit(s, false);
                        }
                    }
                    return;
                default:
                    return;
            }
        };
        for (let i = 0; i < body.length; i++) {
            const statement = body[i];
            visit(statement, topLevel);
        }
    }
    /**
     * Declare the lexical declarations directly in `body` (let, const, class,
     * and block-level functions) in `scope`. A function's or module's
     * top-level functions were hoisted as vars and are skipped here.
     */
    declareLexical(body, scope) {
        const functionLevel = scope === scope.fn.varScope || scope.kind === 'body';
        const script = scope.fn.functionKind === 'script' && scope === scope.fn;
        for (let i = 0; i < body.length; i++) {
            const raw = body[i];
            let node = raw;
            if (node.type === 'ExportNamedDeclaration' && node.declaration)
                node = node.declaration;
            if (node.type === 'ExportDefaultDeclaration') {
                const d = node.declaration;
                if (d.type === 'ClassDeclaration') {
                    scope.declare(d.id ? d.id.name : '*default*', 'class', d.end);
                }
                else if (d.type === 'FunctionDeclaration') {
                    if (!d.id)
                        scope.declare('*default*', 'function', -1);
                    append(scope.functions, d);
                }
                else {
                    scope.declare('*default*', 'const', node.end);
                }
                continue;
            }
            switch (node.type) {
                case 'VariableDeclaration':
                    if (node.kind === 'using' || node.kind === 'await using')
                        throw new UnsupportedSyntax(`${node.kind} declarations`);
                    if (node.kind !== 'var') {
                        for (let j = 0; j < node.declarations.length; j++) {
                            const d = node.declarations[j];
                            const ids = patternIdentifiers(d.id);
                            for (let k = 0; k < ids.length; k++)
                                scope.declare(ids[k].name, node.kind, d.end);
                        }
                    }
                    break;
                case 'ClassDeclaration':
                    scope.declare(node.id.name, 'class', node.end);
                    break;
                case 'FunctionDeclaration':
                    if (functionLevel || script) {
                        append(scope.functions, node);
                    }
                    else {
                        scope.declare(node.id.name, 'function', -1);
                        append(scope.functions, node);
                    }
                    break;
                default:
                    break;
            }
        }
    }
    declarePattern(pattern, kind, scope, declEnd = -1) {
        const ids = patternIdentifiers(pattern);
        for (let i = 0; i < ids.length; i++)
            scope.declare(ids[i].name, kind, declEnd);
    }
    // ── References ──
    /**
     * Resolve a reference. An `init` reference is the declaration itself
     * initializing its binding: it never checks the TDZ.
     */
    resolve(id, scope, init = false) {
        const name = id.name;
        const withs = [];
        let s = scope;
        while (s) {
            let binding = s.bindings.get(name);
            if (!binding && name === 'arguments' && s instanceof FunctionScope && !s.arrow && s.functionKind === 'function') {
                binding = s.special('arguments');
                s.argumentsBinding = binding;
            }
            if (binding) {
                if (binding.scope.fn !== scope.fn)
                    binding.captured = true;
                const tdz = !init && TDZ_KINDS[binding.kind] && binding.declEnd >= 0
                    && (binding.scope.fn !== scope.fn || id.start < binding.declEnd || binding.scope.kind === 'switch');
                if (tdz)
                    binding.tdz = true;
                this.analysis.refs.set(id, { binding, tdz, withs });
                return;
            }
            if (s.kind === 'with')
                append(withs, s);
            s = s.parent;
        }
        this.analysis.refs.set(id, { binding: null, tdz: false, withs });
    }
    /** The function scope that gives `this` (and super, new.target) at `scope`. */
    receiver(scope) {
        let fn = scope.fn;
        while (fn.arrow) {
            const parent = fn.parent;
            if (!parent)
                unreachable('arrow at the root');
            fn = parent.fn;
        }
        return fn;
    }
    useThis(node, scope) {
        const fn = this.receiver(scope);
        if (!fn.thisBinding)
            fn.thisBinding = fn.special('%this');
        if (fn.derived)
            fn.thisBinding.tdz = true;
        if (fn !== scope.fn)
            fn.thisBinding.captured = true;
        this.analysis.receivers.set(node, fn);
    }
    useHome(node, scope) {
        const fn = this.receiver(scope);
        if (!fn.homeBinding)
            fn.homeBinding = fn.special('%home');
        if (fn !== scope.fn)
            fn.homeBinding.captured = true;
        this.useThis(node, scope);
    }
    useNewTarget(node, scope) {
        const fn = this.receiver(scope);
        if (!fn.newTargetBinding)
            fn.newTargetBinding = fn.special('%newtarget');
        if (fn !== scope.fn)
            fn.newTargetBinding.captured = true;
        this.analysis.receivers.set(node, fn);
    }
    /** super(...): the constructor's this, new.target and the constructor itself. */
    useSuperCall(node, scope) {
        this.useThis(node, scope);
        this.useNewTarget(node, scope);
        const fn = this.receiver(scope);
        if (!fn.funcBinding)
            fn.funcBinding = fn.special('%func');
        if (fn !== scope.fn)
            fn.funcBinding.captured = true;
    }
    // ── Walk ──
    visitStatements(body, scope) {
        for (let i = 0; i < body.length; i++) {
            const statement = body[i];
            this.visitStatement(statement, scope);
        }
    }
    visitStatement(node, scope) {
        switch (node.type) {
            case 'ExpressionStatement':
                this.visitExpression(node.expression, scope);
                return;
            case 'BlockStatement':
                this.visitBlock(node, scope);
                return;
            case 'EmptyStatement':
            case 'DebuggerStatement': return;
            case 'WithStatement': {
                this.visitExpression(node.object, scope);
                const withScope = new Scope('with', scope, scope.fn);
                withScope.materialized = true;
                this.analysis.scopes.set(node, withScope);
                this.visitStatement(node.body, withScope);
                return;
            }
            case 'ReturnStatement':
                if (node.argument)
                    this.visitExpression(node.argument, scope);
                return;
            case 'LabeledStatement':
                this.visitStatement(node.body, scope);
                return;
            case 'BreakStatement':
            case 'ContinueStatement': return;
            case 'IfStatement':
                this.visitExpression(node.test, scope);
                this.visitStatement(node.consequent, scope);
                if (node.alternate)
                    this.visitStatement(node.alternate, scope);
                return;
            case 'SwitchStatement':
                this.visitSwitch(node, scope);
                return;
            case 'ThrowStatement':
                this.visitExpression(node.argument, scope);
                return;
            case 'TryStatement':
                this.visitBlock(node.block, scope);
                if (node.handler)
                    this.visitCatch(node.handler, scope);
                if (node.finalizer)
                    this.visitBlock(node.finalizer, scope);
                return;
            case 'WhileStatement':
                this.visitExpression(node.test, scope);
                this.visitStatement(node.body, scope);
                return;
            case 'DoWhileStatement':
                this.visitStatement(node.body, scope);
                this.visitExpression(node.test, scope);
                return;
            case 'ForStatement':
                this.visitFor(node, scope);
                return;
            case 'ForInStatement':
            case 'ForOfStatement':
                this.visitForInOf(node, scope);
                return;
            case 'FunctionDeclaration': {
                this.visitFunction(node, scope, { strict: scope.strict, method: false, derived: false, ctor: false });
                this.noteAnnexB(node, scope);
                return;
            }
            case 'VariableDeclaration':
                this.visitVariableDeclaration(node, scope);
                return;
            case 'ClassDeclaration':
                this.visitClass(node, scope);
                return;
            case 'ImportDeclaration': return;
            case 'ExportNamedDeclaration':
                if (node.declaration)
                    this.visitStatement(node.declaration, scope);
                else if (!node.source)
                    for (let i = 0; i < node.specifiers.length; i++) {
                        const spec = node.specifiers[i];
                        if (spec.local.type === 'Identifier')
                            this.resolve(spec.local, scope);
                    }
                return;
            case 'ExportDefaultDeclaration': {
                const d = node.declaration;
                if (d.type === 'FunctionDeclaration') {
                    this.visitFunction(d, scope, { strict: true, method: false, derived: false, ctor: false });
                }
                else if (d.type === 'ClassDeclaration') {
                    this.visitClass(d, scope);
                }
                else {
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
    noteAnnexB(node, scope) {
        const varScope = scope.fn.varScope;
        if (scope.strict || scope === varScope || scope.fn.functionKind === 'script')
            return;
        const target = varScope.bindings.get(node.id.name);
        if (!target || target.kind !== 'var')
            return;
        for (let s = scope.parent; s && s !== varScope; s = s.parent) {
            const between = s.bindings.get(node.id.name);
            if (between && between.kind !== 'var')
                return;
        }
        this.analysis.annexB.set(node, target);
    }
    visitVariableDeclaration(node, scope) {
        for (let i = 0; i < node.declarations.length; i++) {
            const d = node.declarations[i];
            this.visitPattern(d.id, scope, true);
            if (d.init)
                this.visitExpression(d.init, scope);
        }
    }
    visitBlock(node, scope) {
        const block = new Scope('block', scope, scope.fn);
        this.analysis.scopes.set(node, block);
        this.declareLexical(node.body, block);
        this.visitStatements(node.body, block);
    }
    visitSwitch(node, scope) {
        this.visitExpression(node.discriminant, scope);
        const block = new Scope('switch', scope, scope.fn);
        this.analysis.scopes.set(node, block);
        for (let i = 0; i < node.cases.length; i++) {
            const c = node.cases[i];
            this.declareLexical(c.consequent, block);
        }
        for (let i = 0; i < node.cases.length; i++) {
            const c = node.cases[i];
            if (c.test)
                this.visitExpression(c.test, block);
            this.visitStatements(c.consequent, block);
        }
    }
    visitCatch(node, scope) {
        const catchScope = new Scope('catch', scope, scope.fn);
        this.analysis.scopes.set(node, catchScope);
        if (node.param) {
            this.declarePattern(node.param, 'catch', catchScope);
            this.visitPattern(node.param, catchScope, true);
        }
        this.visitBlock(node.body, catchScope);
    }
    visitFor(node, scope) {
        let inner = scope;
        if (node.init && node.init.type === 'VariableDeclaration' && node.init.kind !== 'var') {
            inner = new Scope('loop', scope, scope.fn);
            this.analysis.scopes.set(node, inner);
            this.declareLexical([node.init], inner);
        }
        if (node.init) {
            if (node.init.type === 'VariableDeclaration')
                this.visitVariableDeclaration(node.init, inner);
            else
                this.visitExpression(node.init, inner);
        }
        if (node.test)
            this.visitExpression(node.test, inner);
        if (node.update)
            this.visitExpression(node.update, inner);
        this.visitStatement(node.body, inner);
    }
    visitForInOf(node, scope) {
        const left = node.left;
        if (left.type === 'VariableDeclaration' && left.kind !== 'var') {
            // The right side sees the loop's names in their TDZ (a separate scope in the spec).
            const tdzScope = new Scope('loop', scope, scope.fn);
            this.analysis.scopes.set(node.right, tdzScope);
            for (let i = 0; i < left.declarations.length; i++) {
                const d = left.declarations[i];
                this.declarePattern(d.id, left.kind === 'const' ? 'const' : 'let', tdzScope, node.end);
            }
            this.visitExpression(node.right, tdzScope);
            const inner = new Scope('loop', scope, scope.fn);
            this.analysis.scopes.set(node, inner);
            this.declareLexical([left], inner);
            for (let i = 0; i < left.declarations.length; i++) {
                const d = left.declarations[i];
                this.visitPattern(d.id, inner, true);
            }
            this.visitStatement(node.body, inner);
            return;
        }
        this.visitExpression(node.right, scope);
        if (left.type === 'VariableDeclaration') {
            for (let i = 0; i < left.declarations.length; i++) {
                const d = left.declarations[i];
                this.visitPattern(d.id, scope, true);
                if (d.init)
                    this.visitExpression(d.init, scope);
            }
        }
        else {
            this.visitPattern(left, scope, false);
        }
        this.visitStatement(node.body, scope);
    }
    /**
     * Visit a pattern: its default values and computed keys are expressions,
     * its identifiers are resolved (as declarations, or as assignment targets).
     */
    visitPattern(pattern, scope, declaration) {
        switch (pattern.type) {
            case 'Identifier':
                this.resolve(pattern, scope, declaration);
                return;
            case 'MemberExpression':
                this.visitExpression(pattern, scope);
                return;
            case 'ObjectPattern':
                for (let i = 0; i < pattern.properties.length; i++) {
                    const p = pattern.properties[i];
                    if (p.type === 'RestElement') {
                        this.visitPattern(p.argument, scope, declaration);
                    }
                    else {
                        if (p.computed)
                            this.visitExpression(p.key, scope);
                        this.visitPattern(p.value, scope, declaration);
                    }
                }
                return;
            case 'ArrayPattern':
                for (let i = 0; i < pattern.elements.length; i++) {
                    const e = pattern.elements[i];
                    if (e)
                        this.visitPattern(e, scope, declaration);
                }
                return;
            case 'RestElement':
                this.visitPattern(pattern.argument, scope, declaration);
                return;
            case 'AssignmentPattern':
                this.visitPattern(pattern.left, scope, declaration);
                this.visitExpression(pattern.right, scope);
                return;
        }
    }
    visitFunction(node, scope, options) {
        const arrow = node.type === 'ArrowFunctionExpression';
        const body = node.body;
        const strict = options.strict || (body.type === 'BlockStatement' && hasUseStrict(body.body));
        const fn = new FunctionScope('function', scope, strict, arrow, node.async, node.generator);
        fn.method = options.method;
        fn.derived = options.derived;
        this.analysis.scopes.set(node, fn);
        // With expressions in the list, each parameter is in its TDZ until bound.
        const expressions = someItem(node.params, (p) => p.type !== 'Identifier');
        for (let i = 0; i < node.params.length; i++) {
            const param = node.params[i];
            this.declarePattern(param, 'param', fn, expressions ? param.end : -1);
        }
        if (body.type === 'BlockStatement') {
            // With parameter expressions the body's declarations are a scope of
            // their own, which the parameter list cannot see.
            if (expressions)
                fn.varScope = new Scope('body', fn, fn);
            this.analysis.scopes.set(body, fn.varScope);
            this.declareLexical(body.body, fn.varScope);
            this.hoistVars(body.body, fn.varScope, true);
        }
        if (!options.unbound && node.type === 'FunctionExpression' && node.id && !fn.bindings.has(node.id.name) && !fn.varScope.bindings.has(node.id.name)) {
            fn.funcBinding = fn.declare(node.id.name, 'callee', -1);
        }
        if (options.ctor && !fn.funcBinding)
            fn.funcBinding = fn.special('%func');
        // `var arguments` is the arguments object's own binding, initialized with it.
        const argumentsVar = fn.varScope.bindings.get('arguments');
        const argumentsParam = fn.bindings.get('arguments');
        if (!arrow && argumentsVar && argumentsVar.kind === 'var' && !(argumentsParam && argumentsParam.kind === 'param')) {
            if (fn.varScope === fn) {
                fn.argumentsBinding = argumentsVar;
            }
            else {
                fn.argumentsBinding = fn.special('arguments');
            }
        }
        for (let i = 0; i < node.params.length; i++) {
            const param = node.params[i];
            this.visitPattern(param, fn, true);
        }
        if (body.type === 'BlockStatement')
            this.visitStatements(body.body, fn.varScope);
        else
            this.visitExpression(body, fn);
        return fn;
    }
    visitClass(node, scope) {
        const classScope = new Scope('class', scope, scope.fn);
        this.analysis.scopes.set(node, classScope);
        if (node.id)
            classScope.declare(node.id.name, 'class', node.end);
        // The heritage sees the class's own name, uninitialized.
        if (node.superClass)
            this.visitExpression(node.superClass, classScope);
        for (let i = 0; i < node.body.body.length; i++) {
            const member = node.body.body[i];
            if (member.type !== 'StaticBlock' && member.key.type === 'PrivateIdentifier') {
                classScope.declare(`#${member.key.name}`, 'private', -1);
            }
        }
        let instanceFields = null;
        let staticFields = null;
        const derived = Boolean(node.superClass);
        for (let i = 0; i < node.body.body.length; i++) {
            const member = node.body.body[i];
            if (member.type === 'StaticBlock') {
                this.visitStaticBlock(member, classScope);
                continue;
            }
            if (member.computed)
                this.visitExpression(member.key, classScope);
            if (member.key.type === 'PrivateIdentifier')
                this.resolvePrivate(member.key, classScope);
            if (member.type === 'MethodDefinition') {
                this.visitMethod(member, classScope, derived);
                continue;
            }
            if (member.value) {
                let fieldScope = member.static ? staticFields : instanceFields;
                if (!fieldScope) {
                    fieldScope = new FunctionScope('field', classScope, true, false, false, false);
                    fieldScope.method = true;
                    if (member.static)
                        staticFields = fieldScope;
                    else
                        instanceFields = fieldScope;
                }
                this.visitFieldValue(member, fieldScope);
            }
        }
        this.analysis.classes.set(node, { scope: classScope, instanceFields, staticFields });
    }
    visitFieldValue(member, fieldScope) {
        if (member.value)
            this.visitExpression(member.value, fieldScope);
    }
    visitMethod(member, classScope, derived) {
        const ctor = member.kind === 'constructor';
        this.visitFunction(member.value, classScope, { strict: true, method: true, derived: ctor && derived, ctor });
    }
    visitStaticBlock(block, classScope) {
        const fn = new FunctionScope('static', classScope, true, false, false, false);
        fn.method = true;
        this.analysis.scopes.set(block, fn);
        this.declareLexical(block.body, fn);
        this.hoistVars(block.body, fn, true);
        this.visitStatements(block.body, fn);
    }
    resolvePrivate(node, scope) {
        // Private names resolve like identifiers, under their '#'-prefixed name.
        const id = { type: 'Identifier', name: `#${node.name}`, start: node.start, end: node.end };
        this.resolve(id, scope);
        this.analysis.privateRefs.set(node, this.analysis.ref(id));
    }
    visitExpression(node, scope) {
        switch (node.type) {
            case 'Identifier':
                this.resolve(node, scope);
                return;
            case 'PrivateIdentifier':
                this.resolvePrivate(node, scope);
                return;
            case 'Literal': return;
            case 'ThisExpression':
                this.useThis(node, scope);
                return;
            case 'ArrayExpression':
                for (let i = 0; i < node.elements.length; i++) {
                    const e = node.elements[i];
                    if (e)
                        this.visitExpression(e.type === 'SpreadElement' ? e.argument : e, scope);
                }
                return;
            case 'ObjectExpression':
                for (let i = 0; i < node.properties.length; i++) {
                    const p = node.properties[i];
                    if (p.type === 'SpreadElement') {
                        this.visitExpression(p.argument, scope);
                        continue;
                    }
                    if (p.computed)
                        this.visitExpression(p.key, scope);
                    if (p.value.type === 'FunctionExpression' && (p.method || p.kind !== 'init')) {
                        this.visitFunction(p.value, scope, { strict: scope.strict, method: true, derived: false, ctor: false });
                    }
                    else {
                        this.visitExpression(p.value, scope);
                    }
                }
                return;
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
                this.visitFunction(node, scope, { strict: scope.strict, method: false, derived: false, ctor: false });
                return;
            case 'UnaryExpression':
                this.visitExpression(node.argument, scope);
                return;
            case 'UpdateExpression':
                this.visitExpression(node.argument, scope);
                return;
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
                if (node.object.type === 'Super')
                    this.useHome(node.object, scope);
                else
                    this.visitExpression(node.object, scope);
                if (node.computed || node.property.type === 'PrivateIdentifier')
                    this.visitExpression(node.property, scope);
                return;
            case 'ConditionalExpression':
                this.visitExpression(node.test, scope);
                this.visitExpression(node.consequent, scope);
                this.visitExpression(node.alternate, scope);
                return;
            case 'CallExpression':
                if (node.callee.type === 'Super')
                    this.useSuperCall(node.callee, scope);
                else
                    this.visitExpression(node.callee, scope);
                for (let i = 0; i < node.arguments.length; i++) {
                    const a = node.arguments[i];
                    this.visitExpression(a.type === 'SpreadElement' ? a.argument : a, scope);
                }
                return;
            case 'NewExpression':
                this.visitExpression(node.callee, scope);
                for (let i = 0; i < node.arguments.length; i++) {
                    const a = node.arguments[i];
                    this.visitExpression(a.type === 'SpreadElement' ? a.argument : a, scope);
                }
                return;
            case 'SequenceExpression':
                for (let i = 0; i < node.expressions.length; i++) {
                    const e = node.expressions[i];
                    this.visitExpression(e, scope);
                }
                return;
            case 'YieldExpression':
                if (node.argument)
                    this.visitExpression(node.argument, scope);
                return;
            case 'AwaitExpression':
                this.visitExpression(node.argument, scope);
                return;
            case 'TemplateLiteral':
                for (let i = 0; i < node.expressions.length; i++) {
                    const e = node.expressions[i];
                    this.visitExpression(e, scope);
                }
                return;
            case 'TaggedTemplateExpression':
                this.visitExpression(node.tag, scope);
                for (let i = 0; i < node.quasi.expressions.length; i++) {
                    const e = node.quasi.expressions[i];
                    this.visitExpression(e, scope);
                }
                return;
            case 'ClassExpression':
                this.visitClass(node, scope);
                return;
            case 'MetaProperty':
                if (node.meta.name === 'new')
                    this.useNewTarget(node, scope);
                return;
            case 'ChainExpression':
                this.visitExpression(node.expression, scope);
                return;
            case 'ImportExpression':
                this.visitExpression(node.source, scope);
                if (node.options)
                    this.visitExpression(node.options, scope);
                return;
            case 'ParenthesizedExpression':
                this.visitExpression(node.expression, scope);
                return;
        }
    }
    /** Decide which scopes are materialized and give every binding its slot. */
    finish(root) {
        layoutFunction(root);
    }
}
function layoutFunction(fn) {
    fn.size = 1;
    assignSlots(fn, fn);
}
function assignSlots(scope, holder) {
    scope.bindings.forEach((binding) => { binding.slot = holder.size++; });
    const children = scope.children;
    if (children === null)
        throw new Error('interpreter scope analysis: layout of a released scope');
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof FunctionScope) {
            layoutFunction(child);
            continue;
        }
        let captured = child.kind === 'with';
        child.bindings.forEach((binding) => { if (binding.captured)
            captured = true; });
        child.materialized = captured;
        if (captured) {
            // A with scope keeps its object in slot 1.
            child.size = child.kind === 'with' ? 2 : 1;
            assignSlots(child, child);
        }
        else {
            assignSlots(child, holder);
        }
    }
}
