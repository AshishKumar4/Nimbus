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
import type { AnyNode, Expression, Pattern, PrivateIdentifier, Program, SpreadElement, Super } from 'acorn';
import { type Analysis, type Binding, type ClassNode, type FunctionNode, FunctionScope } from './scope.js';
import { type Env, FunctionInfo, type FunctionShape } from './runtime.js';
/** Code that evaluates to a T: run directly (`s`), or as a generator (`g`) when it suspends. */
export interface CodeOf<T> {
    readonly s: (env: Env) => T;
    readonly g: ((env: Env) => Generator<unknown, T, unknown>) | null;
}
export type Code = CodeOf<unknown>;
/** What the host gives a compiled unit. */
export interface UnitHost {
    /** The unit's `import(specifier, options)`. */
    readonly dynamicImport: ((specifier: unknown, options: unknown) => Promise<unknown>) | null;
}
export declare class Compiler {
    readonly analysis: Analysis;
    readonly source: string;
    readonly host: UnitHost;
    private scope;
    private shape;
    private readonly suspendCache;
    private readonly functionInfos;
    /** Module import bindings: the slot holds the module (named, default) or the namespace object. */
    readonly imports: Map<Binding, {
        kind: "named" | "default" | "namespace";
        name: string;
    }>;
    constructor(analysis: Analysis, source: string, host: UnitHost, root: FunctionScope);
    /** Whether evaluating `node` can await or yield in the current function. */
    suspends(node: AnyNode | null | undefined): boolean;
    private withScope;
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
    private compileFunctionInto;
    /** A function body: its var scope's entry, then its statements. */
    private functionBody;
    /** Code that runs `body` in the environment `entry` makes. */
    private entered;
    private declaredBinding;
    private paramBinder;
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
    private variableDeclaration;
    private sequenceStatements;
    private ifStatement;
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
    private rightOfForInOf;
    private forOf;
    /** `await x` inside this function's generator body. */
    private awaiter;
    private forAwait;
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
    /** A member expression as an assignment target: evaluates its reference, then returns its setter. */
    private memberTarget;
    private objectPatternBinder;
    private arrayPatternBinder;
    /** The generator flavor of patternBinder, for patterns whose defaults, keys or targets await or yield. */
    patternBinderGen(pattern: Pattern, init: boolean): (env: Env, value: unknown) => Generator<unknown, void, unknown>;
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
    private call;
    /** `o.m(a, b)` with nothing suspending: the method and its receiver without a pair, the arguments without spreads. */
    private memberCall;
    private superCallExpr;
    private newExpr;
    private arrayExpr;
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
    private classDefinition;
    /** The offset after a class member's `static` keyword (and the whitespace after it). */
    private afterStatic;
    /** Compile with `fs` as the current function (field initializers, static blocks). */
    private withFunctionScope;
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
    moduleCell(program: Program, root: FunctionScope): ModuleCell;
    /** A live read of a module-scope binding, for an export getter. */
    private rootRead;
}
/** A module cell: Node's CommonJS wrapper function. */
export type ModuleCell = (exports: unknown, require: unknown, module: unknown, filename: unknown, dirname: unknown) => unknown;
/** The environment above every unit's: nothing reads it. */
export declare const ROOT_ENV: Env;
//# sourceMappingURL=compile.d.ts.map