/**
 * host-ops.ts — the part of the interpreter that has to be JavaScript source
 * of its own, loaded as a separate CommonJS module beside the interpreter.
 *
 * Two things live here. First, the language's operators over arbitrary
 * values (`a + b`, `a < b`, `o[k]`, `delete o[k]`, ...), which TypeScript
 * cannot type over `unknown`. Second, the native functions an interpreted
 * function IS. Every interpreted function is a real function of its kind
 * (a plain function, a method, an arrow, a generator, an async function, an
 * async generator, a class), created here from a native literal of that kind
 * whose body calls back into the interpreter. So `instanceof`, prototypes,
 * `new`, `new.target`, `this` coercion, `arguments` and generator and promise
 * machinery are V8's own; the interpreter supplies only the body.
 *
 * Why a module of its own: sloppy-mode code differs observably from strict
 * (a plain function's `this` is the global object when called bare, its
 * `arguments.callee` is the function, an assignment to a read-only property
 * is silently ignored). A native function gets those semantics only from
 * source text in sloppy mode, and the interpreter bundle is strict. This
 * module is sloppy at its top level; the operators and the strict copy of
 * the factories are inside "use strict" functions.
 */
/** A function as the interpreter holds one it made: callable with any receiver and arguments. */
export type NativeFunction = (this: unknown, ...args: unknown[]) => unknown;
/** The interpreter-side callbacks the function factories call. */
export interface FunctionRuntime<F, E, R> {
    /** Run a plain function, method, getter or setter body. */
    call(fi: F, scope: E, fn: Function, thisArg: unknown, args: IArguments, newTarget: Function | undefined, home: object | undefined): unknown;
    /** Run an arrow function body. */
    arrow(fi: F, scope: E, args: unknown[]): unknown;
    /** Bind a call's environment: the function's frame with its parameters bound. */
    enter(fi: F, scope: E, fn: Function | undefined, thisArg: unknown, args: ArrayLike<unknown>, newTarget: Function | undefined, home: object | undefined): E;
    /** A body's completion as the function's return value. */
    finish(fi: F, result: unknown): unknown;
    /** Run a base class constructor: fields, then the body. */
    construct(fi: F, scope: E, ctor: Function, record: R, thisArg: object, args: IArguments, newTarget: Function): unknown;
    /** Run a derived class constructor, whose `this` comes from super(). */
    constructDerived(fi: F, scope: E, ctor: Function, record: R, args: IArguments, newTarget: Function): unknown;
    /** The operand of the await, yield or yield* an async generator body just signalled. */
    operand(): unknown;
    readonly AWAIT: object;
    readonly YIELD: object;
    readonly DELEGATE: object;
    /** The value an async generator body is returned with when the consumer calls return(). */
    readonly MARK: object;
}
/** What an interpreted function's body is, as the factories read it. */
export interface FactoryFunctionInfo {
    /** The body when it never suspends. */
    readonly body: ((env: never) => unknown) | null;
    /** The body as a generator when it awaits or yields. */
    readonly gen: ((env: never) => Generator<unknown, unknown, unknown>) | null;
}
/** Native functions of each kind whose bodies run interpreted code. */
export interface FunctionFactories<F extends FactoryFunctionInfo, E, R> {
    plain(fi: F, scope: E): NativeFunction;
    method(fi: F, scope: E, home: object | undefined): NativeFunction;
    arrow(fi: F, scope: E): NativeFunction;
    generator(fi: F, scope: E, home: object | undefined): NativeFunction;
    async(fi: F, scope: E, home: object | undefined): NativeFunction;
    asyncArrow(fi: F, scope: E): NativeFunction;
    asyncGenerator(fi: F, scope: E, home: object | undefined): NativeFunction;
    classBase(fi: F, scope: E, record: R): NativeFunction;
    classDerived(fi: F, scope: E, parent: unknown, record: R): NativeFunction;
}
/** The operators of the language over arbitrary values (strict mode unless named sloppy). */
export interface HostOperators {
    add(a: unknown, b: unknown): unknown;
    sub(a: unknown, b: unknown): unknown;
    mul(a: unknown, b: unknown): unknown;
    div(a: unknown, b: unknown): unknown;
    mod(a: unknown, b: unknown): unknown;
    exp(a: unknown, b: unknown): unknown;
    shl(a: unknown, b: unknown): unknown;
    shr(a: unknown, b: unknown): unknown;
    ushr(a: unknown, b: unknown): unknown;
    and(a: unknown, b: unknown): unknown;
    or(a: unknown, b: unknown): unknown;
    xor(a: unknown, b: unknown): unknown;
    lt(a: unknown, b: unknown): boolean;
    gt(a: unknown, b: unknown): boolean;
    le(a: unknown, b: unknown): boolean;
    ge(a: unknown, b: unknown): boolean;
    /** `key in target` */
    has(key: unknown, target: unknown): boolean;
    instanceOf(value: unknown, target: unknown): boolean;
    /** Unary minus. */
    neg(a: unknown): unknown;
    /** Unary plus (ToNumber). */
    plus(a: unknown): unknown;
    /** Bitwise not. */
    bitNot(a: unknown): unknown;
    /** ToNumeric: what `x++` returns. */
    numeric(v: unknown): unknown;
    /** A numeric value plus one, minus one. */
    increment(n: unknown): unknown;
    decrement(n: unknown): unknown;
    /** ToPropertyKey of an object (its ToPrimitive with hint string). */
    propertyKey(value: object): PropertyKey;
    get(target: unknown, key: unknown): unknown;
    /**
     * A reader of the global `name`, for the well-known globals: a named load
     * of its own, which V8 caches per site, where a keyed load on the global
     * object is a slow lookup every time. Undefined for other names.
     */
    globalReader(name: string): (() => unknown) | undefined;
    set(target: unknown, key: unknown, value: unknown): void;
    setSloppy(target: unknown, key: unknown, value: unknown): void;
    remove(target: unknown, key: unknown): boolean;
    removeSloppy(target: unknown, key: unknown): boolean;
}
export interface HostOps {
    readonly ops: HostOperators;
    bind<F extends FactoryFunctionInfo, E, R>(rt: FunctionRuntime<F, E, R>): {
        readonly strict: FunctionFactories<F, E, R>;
        readonly sloppy: FunctionFactories<F, E, R>;
    };
}
/** The module's source: `module.exports` is a HostOps. */
export declare const HOST_OPS_SOURCE: string;
//# sourceMappingURL=host-ops.d.ts.map