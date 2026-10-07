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
import type { AnyNode, BlockStatement, Expression, FunctionExpression, Pattern, PrivateIdentifier, Program, SpreadElement, Super } from 'acorn';
import { type Analysis, type Binding, type ClassNode, type FunctionNode, FunctionScope } from './scope.js';
import { SafeMap } from './intrinsics.js';
import { type Env, FunctionInfo, type FunctionShape } from './runtime.js';
import { type Code } from './code.js';
import type { ModulePlan } from './modules.js';
/** What the host gives a compiled unit. */
export interface UnitHost {
    /** The unit's `import(specifier, options)`. */
    readonly dynamicImport: ((specifier: unknown, options: unknown) => Promise<unknown>) | null;
}
/** An import binding's source: the slot holds the module (named, default) or the namespace object. */
type ImportInfo = {
    readonly kind: 'named' | 'default' | 'namespace';
    readonly name: string;
};
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
export declare class Compiler {
    readonly analysis: Analysis;
    readonly unit: UnitContext;
    /** The text this compile's AST was parsed from: the unit's, or one function's (reparse.ts). */
    readonly text: string;
    /** The offset in the unit's source of `text`'s first character. */
    readonly base: number;
    private scope;
    private shape;
    private readonly suspendCache;
    private readonly functionInfos;
    constructor(analysis: Analysis, unit: UnitContext, 
    /** The text this compile's AST was parsed from: the unit's, or one function's (reparse.ts). */
    text: string, 
    /** The offset in the unit's source of `text`'s first character. */
    base: number, root: FunctionScope);
    /** The unit's source text at [start, end) of this compile's text: what a function's toString answers. */
    private sourceOf;
    /** This compile's text at [start, end): an expression as an error message quotes it. */
    private textOf;
    /** Whether evaluating `node` can await or yield in the current function. */
    suspends(node: AnyNode | null | undefined): boolean;
    /**
     * Make `scope` the current scope; returns the one to restore after. No
     * closure here captures `this`, an AST node or an analysis object: V8 keeps
     * whatever any closure of a function captures alive for all its closures,
     * and the runtime's closures must not keep the AST or the compiler.
     * (An error abandons the compile, so a scope left set does not matter.)
     */
    private enter;
    /** Environment levels from the current scope's environment up to `target`'s. */
    private hops;
    /** Reads slot `slot` of the environment `hops` levels up. */
    private slotReader;
    private envAt;
    /**
     * What entering `scope` does: allocate its environment when materialized,
     * start its lexical bindings in their TDZ, and instantiate its function
     * declarations. Null when entering costs nothing. `frame` is a function's
     * own scope, whose environment the call already allocated.
     */
    private scopeEntry;
    /**
     * The compiled function of `node`. A class constructor passes its shape and
     * the class's source text, which is what the class's toString answers.
     */
    functionInfo(node: FunctionNode, name: string, shapeOverride?: FunctionShape, source?: string): FunctionInfo;
    /** Compile `node` as the unit's own function now (a Function constructor's), not on its first call. */
    rootFunction(node: FunctionExpression, name: string, source: string): FunctionInfo;
    compileFunctionInto(fi: FunctionInfo, fs: FunctionScope, params: readonly Pattern[], body: BlockStatement | Expression): void;
    /** A function body: its var scope's entry, then its statements. */
    private functionBody;
    /**
     * Entering a function body that has a var environment of its own (its
     * parameter list has expressions): body vars named like parameters, and
     * `var arguments`, start with the parameter's value.
     */
    private bodyScopeEntry;
    /** Code that runs `body` in the environment `entry` makes. */
    private entered;
    private declaredBinding;
    /**
     * Binds a parameter list with expressions, in order. A default can change
     * the arguments object (`arguments.length = 0`, `arguments[1] = x`), which
     * natively binds nothing: parameters are bound from the arguments as
     * passed. So a function that can reach its arguments object binds from a
     * copy of them, made before any default runs.
     */
    private paramBinder;
    /** Binds parameter `index` (or, a rest parameter, the arguments from it on). */
    private parameterBinder;
    /** A function or class expression evaluated to a new function object. */
    private functionExpr;
    /** Evaluate `node`, naming it `name` if it is an anonymous function or class (NamedEvaluation). */
    private named;
    /** Like named(), with the name known only when the code runs (a computed key). */
    private namedAtRuntime;
    private statementList;
    /** A statement's code, or null for one that does nothing when reached (a hoisted function). */
    private stmt;
    /** Code for an expression evaluated for a side effect on its value. */
    private effect;
    private exportDefault;
    private annexBFunction;
    private blockStatement;
    private blockIn;
    private variableDeclaration;
    private sequenceStatements;
    private ifStatement;
    /** An if statement's clause: a function declaration there is a block of its own (Annex B.3.4, Analyzer.visitClause). */
    private clause;
    private labeled;
    /**
     * How a loop treats its body's completion: continue with the next
     * iteration, stop normally, or hand the completion out.
     */
    private loopControl;
    /** while, do-while, and for(;;) without per-iteration bindings. */
    private loop;
    private forStatement;
    /** for (let ...) whose bindings a closure captures: each iteration gets a copy of the environment. */
    private perIterationLoop;
    /**
     * The left side of for-in/of: binds each value. A let/const head gets a
     * fresh environment per iteration (when materialized) before binding.
     */
    private forHead;
    private forIn;
    /** The iterated expression, evaluated where the loop's own names are in their TDZ. */
    /** A statement compiled in `scope` (or the current one), as code that does nothing if it compiles to nothing. */
    private stmtIn;
    private rightOfForInOf;
    private forOf;
    /** `await x` inside this function's generator body. */
    private awaiter;
    private forAwait;
    /** A catch clause: its parameter bound in its own scope, then its block. */
    private catchClause;
    private tryStatement;
    private switchStatement;
    private withStatement;
    /** Writes a value to slot `slot`, `hops` environments up. */
    private slotWriter;
    /** Initializes a declaration's binding (no TDZ check, const allowed). */
    private initializer;
    private read;
    private bindingRead;
    private globalRead;
    /** Readers of the objects of the `with` statements between a reference and its binding, innermost first. */
    private withObjects;
    private withRead;
    /** PutValue for an identifier: checks TDZ, const, and strictness. */
    private writer;
    /**
     * Binds a value to a pattern: `init` initializes declarations (let,
     * const, parameters, catch), otherwise it assigns (var declarations and
     * assignment patterns go through PutValue).
     */
    patternBinder(pattern: Pattern, init: boolean): (env: Env, value: unknown) => void;
    /**
     * The value a pattern element's default gives an undefined value, planned
     * once for both flavors (patternBinder, patternBinderGen): an anonymous
     * function or class default takes an identifier target's name, as
     * `const { f = function () {} } = o` names it `f`.
     */
    private patternDefault;
    /** A member expression as an assignment target: evaluates its reference, then returns its setter. */
    private memberTarget;
    private objectPatternBinder;
    /** One property of an object pattern: reads its key from the source and binds the value. */
    private objectPatternStep;
    /** One element of an array pattern, compiled. */
    private arrayPatternElement;
    private arrayPatternBinder;
    /** The generator flavor of patternBinder, for patterns whose defaults, keys or targets await or yield. */
    patternBinderGen(pattern: Pattern, init: boolean): (env: Env, value: unknown) => Generator<unknown, void, unknown>;
    /** One property of a suspending object pattern: its key (null for a rest element), and its element. */
    private objectPatternStepGen;
    /**
     * One element of a suspending pattern: a member target's reference,
     * evaluated before its value is read; then the default for an undefined
     * value, and the binding or assignment.
     */
    private elementGen;
    /** A member assignment target whose object or key awaits or yields: its setter, once its reference is evaluated. */
    private memberTargetGen;
    private staticKey;
    /** A property key: static, or computed and converted with ToPropertyKey. */
    private propertyKey;
    expr(node: Expression | PrivateIdentifier | Super | SpreadElement): Code;
    /** Each expression's code, in order. */
    private exprs;
    /** An element of an argument list or array literal: a spread, or a value. */
    private listPart;
    private argumentParts;
    /** An array literal's parts: null for a hole. */
    private elementParts;
    private literal;
    private thisValue;
    private homeObject;
    private metaProperty;
    private importExpr;
    private awaitExpr;
    private yieldExpr;
    private template;
    private tagged;
    private unary;
    private deleteExpr;
    private binary;
    private logical;
    /** The key of a non-private member expression. */
    private memberKey;
    /** The object of a member in an optional chain: SHORT once the chain has short-circuited. */
    private chainObject;
    /** Part of an optional chain: a member or call keeps propagating SHORT. */
    private chainPart;
    private privateName;
    private member;
    /**
     * An optional chain that awaits or yields: each link evaluated in order,
     * SHORT as soon as an optional link meets null or undefined.
     */
    private chainGen;
    /**
     * The slot of `node` when it is a plain read of a binding in the current
     * environment (no TDZ check, no `with`, not an import): one closure can
     * then read it and use it.
     */
    private localSlot;
    /** The value of `node` when it is a literal or the global `undefined`, known when compiling. */
    private constant;
    /** Whether a node continues an optional chain (contains an optional link below the chain root). */
    private inChain;
    /**
     * A callee and the `this` a call through it gets: a member's object, a
     * `with` object holding the name, or undefined.
     */
    private callee;
    /** Arguments evaluated into an array (spreads iterate). */
    private argumentList;
    /** Whether no argument spreads or suspends. */
    private plainArguments;
    /** The arguments' values, for a list plainArguments accepts. */
    private argumentValues;
    private call;
    /** `o.m(a, b)` with nothing suspending: the method and its receiver without a pair, the arguments without spreads. */
    private memberCall;
    private superCallExpr;
    private newExpr;
    private arrayExpr;
    /** One property of an object literal, compiled. */
    private propertyPart;
    private objectExpr;
    private assignment;
    /**
     * An assignment target as a reference: evaluating it fixes the object and
     * key (or binding), and get/set act on them.
     */
    private reference;
    private update;
    classCode(node: ClassNode, name: string): Code;
    /** ClassDefinitionEvaluation, with the class's name given when it runs. */
    private classMaker;
    /** What defining a class does, compiled: its constructor, elements and private names (classDefiner runs it). */
    private classPlan;
    /** The offset after a class member's `static` keyword (and the whitespace after it). */
    private afterStatic;
    /** Make `fs` the current function (field initializers, static blocks); returns what leave() restores. */
    private enterFunction;
    private leave;
    /** The frame layout of a class's field initializer scope. */
    private fieldInfo;
    private staticBlockInfo;
    /** A program's top level (module or script), as a body over its root environment. */
    programBody(program: Program, root: FunctionScope): Code;
    /** A CommonJS body: a function of the wrapper's parameters. */
    commonJsFunction(program: Program, root: FunctionScope, params: readonly string[]): FunctionInfo;
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
    modulePlan(program: Program, root: FunctionScope): ModulePlan;
    /** A module's statements, compiled as an async function body (top-level await). */
    private moduleStatements;
    /** A live read of a module-scope binding, for an export getter. */
    private rootRead;
}
export {};
//# sourceMappingURL=compile.d.ts.map