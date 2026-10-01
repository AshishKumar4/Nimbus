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
import type { AnonymousClassDeclaration, AnonymousFunctionDeclaration, AnyNode, ArrowFunctionExpression, BlockStatement, CatchClause, ClassDeclaration, ClassExpression, ForInStatement, ForOfStatement, ForStatement, FunctionDeclaration, FunctionExpression, Identifier, MethodDefinition, ModuleDeclaration, Pattern, PrivateIdentifier, Program, PropertyDefinition, Statement, StaticBlock, SwitchStatement, VariableDeclaration } from 'acorn';
export type FunctionNode = FunctionDeclaration | AnonymousFunctionDeclaration | FunctionExpression | ArrowFunctionExpression;
export type ClassNode = ClassDeclaration | AnonymousClassDeclaration | ClassExpression;
export type BindingKind = 'var' | 'let' | 'const' | 'class' | 'function' | 'param' | 'catch' | 'import'
/** A named function expression's own name: read-only, silently in sloppy code. */
 | 'callee'
/** The implicit bindings of a function: this, arguments, new.target, its home object, itself. */
 | 'special'
/** A class's private name (#x), held by the class scope. */
 | 'private';
export declare class Binding {
    readonly name: string;
    readonly kind: BindingKind;
    readonly scope: Scope;
    /** Source offset after which, in the same function, the declaration has run. */
    readonly declEnd: number;
    /** Index in its holder's environment array; 0 is the parent link. */
    slot: number;
    /** Referenced from a function nested inside the one that declares it. */
    captured: boolean;
    /** Some reference can run before the declaration does, so the slot starts as the TDZ marker. */
    tdz: boolean;
    constructor(name: string, kind: BindingKind, scope: Scope, 
    /** Source offset after which, in the same function, the declaration has run. */
    declEnd: number);
}
export type ScopeKind = 'function' | 'module' | 'script' | 'field' | 'static'
/** A function's body when its parameter list holds closures (its own var environment). */
 | 'body' | 'block' | 'switch' | 'loop' | 'catch' | 'class' | 'with';
export declare class Scope {
    readonly kind: ScopeKind;
    readonly parent: Scope | null;
    readonly bindings: Map<string, Binding>;
    readonly children: Scope[];
    materialized: boolean;
    /** Slots of the environment this scope allocates, when materialized. */
    size: number;
    /** Function declarations this scope instantiates on entry, in source order. */
    readonly functions: Array<FunctionDeclaration | AnonymousFunctionDeclaration>;
    readonly fn: FunctionScope;
    /** Whether code in this scope is strict: its function's mode, or a class body's (always strict). */
    readonly strict: boolean;
    constructor(kind: ScopeKind, parent: Scope | null, fn: FunctionScope | null, strict?: boolean);
    /** The scope whose environment holds this scope's bindings at runtime. */
    holder(): Scope;
    declare(name: string, kind: BindingKind, declEnd: number): Binding;
}
export type FunctionKind = 'function' | 'module' | 'script' | 'field' | 'static';
export declare class FunctionScope extends Scope {
    readonly functionKind: FunctionKind;
    readonly node: FunctionNode | Program | StaticBlock | null;
    readonly strict: boolean;
    readonly async: boolean;
    readonly generator: boolean;
    /** Arrow functions take this, arguments, new.target and super from their enclosing function. */
    readonly arrow: boolean;
    thisBinding: Binding | null;
    argumentsBinding: Binding | null;
    newTargetBinding: Binding | null;
    homeBinding: Binding | null;
    /** The function object itself: a named expression's name, or a class constructor (for super()). */
    funcBinding: Binding | null;
    /** Where the body's declarations live: this scope, or a 'body' scope below it. */
    varScope: Scope;
    /** Whether `this` starts uninitialized (a derived class constructor). */
    derived: boolean;
    /** Whether this function is a method with a home object (for super.x). */
    method: boolean;
    /** A script's top-level var and function names: global object properties, not bindings. */
    readonly globalVars: string[];
    constructor(functionKind: FunctionKind, parent: Scope | null, node: FunctionNode | Program | StaticBlock | null, strict: boolean, arrow: boolean, async: boolean, generator: boolean);
    special(name: string): Binding;
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
/** Whether a function body opens with a "use strict" directive. */
export declare function hasUseStrict(body: readonly (Statement | ModuleDeclaration)[]): boolean;
/** The names a binding pattern declares, with the pattern identifiers. */
export declare function patternIdentifiers(pattern: Pattern, out?: Identifier[]): Identifier[];
/** Each child node of `node`. */
export declare function forEachChildNode(node: AnyNode, visit: (child: AnyNode) => void): void;
export interface ClassScopes {
    readonly scope: Scope;
    /** The function scope instance field initializers run in, if the class has any. */
    readonly instanceFields: FunctionScope | null;
    /** The function scope static field initializers run in, if any. */
    readonly staticFields: FunctionScope | null;
}
/** The analysis of one compiled unit. */
export declare class Analysis {
    readonly refs: Map<Identifier, Reference>;
    /** Scope of each scope-creating node (functions, blocks, loops, catch, switch, with, class). */
    readonly scopes: Map<FunctionDeclaration | AnonymousFunctionDeclaration | Identifier | import("acorn").ExpressionStatement | BlockStatement | import("acorn").EmptyStatement | import("acorn").DebuggerStatement | import("acorn").WithStatement | import("acorn").ReturnStatement | import("acorn").LabeledStatement | import("acorn").BreakStatement | import("acorn").ContinueStatement | import("acorn").IfStatement | SwitchStatement | import("acorn").ThrowStatement | import("acorn").TryStatement | import("acorn").WhileStatement | import("acorn").DoWhileStatement | ForStatement | ForInStatement | ForOfStatement | VariableDeclaration | ClassDeclaration | import("acorn").Literal | import("acorn").ThisExpression | import("acorn").ArrayExpression | import("acorn").ObjectExpression | FunctionExpression | import("acorn").UnaryExpression | import("acorn").UpdateExpression | import("acorn").BinaryExpression | import("acorn").AssignmentExpression | import("acorn").LogicalExpression | import("acorn").MemberExpression | import("acorn").ConditionalExpression | import("acorn").CallExpression | import("acorn").NewExpression | import("acorn").SequenceExpression | ArrowFunctionExpression | import("acorn").YieldExpression | import("acorn").TemplateLiteral | import("acorn").TaggedTemplateExpression | ClassExpression | import("acorn").MetaProperty | import("acorn").AwaitExpression | import("acorn").ChainExpression | import("acorn").ImportExpression | import("acorn").ParenthesizedExpression | import("acorn").ImportDeclaration | import("acorn").ExportNamedDeclaration | import("acorn").ExportDefaultDeclaration | import("acorn").ExportAllDeclaration | Program | import("acorn").SwitchCase | CatchClause | import("acorn").Property | import("acorn").Super | import("acorn").SpreadElement | import("acorn").TemplateElement | import("acorn").AssignmentProperty | import("acorn").ObjectPattern | import("acorn").ArrayPattern | import("acorn").RestElement | import("acorn").AssignmentPattern | import("acorn").ClassBody | MethodDefinition | import("acorn").ImportAttribute | import("acorn").ImportSpecifier | import("acorn").ImportDefaultSpecifier | import("acorn").ImportNamespaceSpecifier | import("acorn").ExportSpecifier | AnonymousClassDeclaration | PropertyDefinition | PrivateIdentifier | StaticBlock | import("acorn").VariableDeclarator, Scope>;
    readonly classes: Map<ClassNode, ClassScopes>;
    /** For `this`, `super` and `new.target`: the function scope that provides them. */
    readonly receivers: Map<FunctionDeclaration | AnonymousFunctionDeclaration | Identifier | import("acorn").ExpressionStatement | BlockStatement | import("acorn").EmptyStatement | import("acorn").DebuggerStatement | import("acorn").WithStatement | import("acorn").ReturnStatement | import("acorn").LabeledStatement | import("acorn").BreakStatement | import("acorn").ContinueStatement | import("acorn").IfStatement | SwitchStatement | import("acorn").ThrowStatement | import("acorn").TryStatement | import("acorn").WhileStatement | import("acorn").DoWhileStatement | ForStatement | ForInStatement | ForOfStatement | VariableDeclaration | ClassDeclaration | import("acorn").Literal | import("acorn").ThisExpression | import("acorn").ArrayExpression | import("acorn").ObjectExpression | FunctionExpression | import("acorn").UnaryExpression | import("acorn").UpdateExpression | import("acorn").BinaryExpression | import("acorn").AssignmentExpression | import("acorn").LogicalExpression | import("acorn").MemberExpression | import("acorn").ConditionalExpression | import("acorn").CallExpression | import("acorn").NewExpression | import("acorn").SequenceExpression | ArrowFunctionExpression | import("acorn").YieldExpression | import("acorn").TemplateLiteral | import("acorn").TaggedTemplateExpression | ClassExpression | import("acorn").MetaProperty | import("acorn").AwaitExpression | import("acorn").ChainExpression | import("acorn").ImportExpression | import("acorn").ParenthesizedExpression | import("acorn").ImportDeclaration | import("acorn").ExportNamedDeclaration | import("acorn").ExportDefaultDeclaration | import("acorn").ExportAllDeclaration | Program | import("acorn").SwitchCase | CatchClause | import("acorn").Property | import("acorn").Super | import("acorn").SpreadElement | import("acorn").TemplateElement | import("acorn").AssignmentProperty | import("acorn").ObjectPattern | import("acorn").ArrayPattern | import("acorn").RestElement | import("acorn").AssignmentPattern | import("acorn").ClassBody | MethodDefinition | import("acorn").ImportAttribute | import("acorn").ImportSpecifier | import("acorn").ImportDefaultSpecifier | import("acorn").ImportNamespaceSpecifier | import("acorn").ExportSpecifier | AnonymousClassDeclaration | PropertyDefinition | PrivateIdentifier | StaticBlock | import("acorn").VariableDeclarator, FunctionScope>;
    /** Block-level function declarations that also assign a var of their name (Annex B.3.3). */
    readonly annexB: Map<FunctionDeclaration, Binding>;
    readonly privateRefs: Map<PrivateIdentifier, Reference>;
    /** A module's own scope, which holds `%module` for import.meta. */
    moduleScope: FunctionScope | null;
    scopeOf(node: AnyNode): Scope;
    functionScopeOf(node: AnyNode): FunctionScope;
    ref(node: Identifier): Reference;
    privateRef(node: PrivateIdentifier): Reference;
}
/** The specials a module's cell binds from its five wrapper arguments. */
export declare const MODULE_CELL_PARAMS: readonly ["%exports", "%require", "%module", "%filename", "%dirname"];
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
export declare function analyzeProgram(program: Program, options: UnitOptions): Analysis;
/** Analyze a function expression that closes over the global scope (a Function constructor's). */
export declare function analyzeFunction(node: FunctionExpression): Analysis;
/**
 * Analyze a CommonJS module body: a function of Node's five wrapper
 * parameters whose `this` is `exports`.
 */
export declare function analyzeCommonJs(program: Program, params: readonly string[]): Analysis;
//# sourceMappingURL=scope.d.ts.map