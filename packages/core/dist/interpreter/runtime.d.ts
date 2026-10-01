/**
 * runtime.ts — what compiled closures run against: environments, completion
 * signals, interpreted function objects, classes and private names.
 */
import type { FactoryFunctionInfo, HostOperators, HostOps, NativeFunction } from './host-ops.js';
/**
 * A scope's environment: slot 0 is the enclosing environment, the rest are
 * the scope's bindings (scope.ts assigns the slots).
 */
export type Env = unknown[];
/** The enclosing environment of `env`. */
export declare function up(env: Env): Env;
/** An environment `hops` levels up. */
export declare function upN(env: Env, hops: number): Env;
/** The value of a lexical binding before its declaration has run. */
export declare const TDZ: object;
export declare function tdzError(name: string): ReferenceError;
export declare const THIS_BEFORE_SUPER = "Must call super constructor in derived class before accessing 'this' or returning from derived constructor";
/** How a statement ended abnormally; a normal completion is `undefined`. */
export declare class Completion {
    readonly kind: 'break' | 'continue' | 'return';
    readonly label: string | null;
    readonly value: unknown;
    constructor(kind: 'break' | 'continue' | 'return', label: string | null, value: unknown);
}
export type Signal = Completion | undefined;
export declare const BREAK: Completion;
export declare const CONTINUE: Completion;
export declare function labeledSignal(kind: 'break' | 'continue', label: string): Completion;
/** The marker an async generator body yields to await, yield or delegate; its operand is beside it. */
export declare const AWAIT: Readonly<{
    mark: "await";
}>;
export declare const YIELD: Readonly<{
    mark: "yield";
}>;
export declare const DELEGATE: Readonly<{
    mark: "delegate";
}>;
export declare const MARK: Readonly<{
    mark: "return";
}>;
export declare function signalOperand(value: unknown): void;
export type Sync = (env: Env) => unknown;
export type Gen = (env: Env) => Generator<unknown, unknown, unknown>;
export type FunctionShape = 'plain' | 'method' | 'arrow' | 'generator' | 'async' | 'asyncArrow' | 'asyncGenerator' | 'classBase' | 'classDerived';
/** A compiled function: what every function object made from one source function shares. */
export declare class FunctionInfo implements FactoryFunctionInfo {
    readonly shape: FunctionShape;
    readonly name: string;
    readonly length: number;
    readonly strict: boolean;
    /** The source text Function.prototype.toString answers. */
    readonly source: string;
    body: Sync | null;
    gen: Gen | null;
    /** The body evaluates to the return value itself (an arrow's expression body). */
    expression: boolean;
    size: number;
    thisSlot: number;
    argumentsSlot: number;
    newTargetSlot: number;
    homeSlot: number;
    funcSlot: number;
    /** Parameter slots, when every parameter is a plain identifier. */
    params: number[] | null;
    /** Binds the parameters otherwise. */
    bindParams: ((env: Env, args: ArrayLike<unknown>) => void) | null;
    /** Slots that start in their TDZ when the frame is created. */
    tdzSlots: number[];
    /** A derived constructor's `this` starts uninitialized. */
    derived: boolean;
    /** A class constructor with no constructor in its source. */
    implicit: boolean;
    constructor(shape: FunctionShape, name: string, length: number, strict: boolean, 
    /** The source text Function.prototype.toString answers. */
    source: string);
}
export declare function operators(): HostOperators;
/**
 * One evaluation of a class: what constructing an instance initializes, and
 * the home object of its constructor. Filled in once the class's elements
 * are defined, before anything can construct it.
 */
export declare class ClassRecord {
    /** Initializes an instance's private methods and fields, in order. */
    initialize: ((instance: object) => void) | null;
    home: object | undefined;
}
/** The object a derived constructor's super(...args) constructs, before its fields. */
export declare function superConstruct(ctor: Function, args: unknown[], newTarget: unknown): object;
/** InitializeInstanceElements: the private methods and fields of `ctor`'s class, once `this` is bound. */
export declare function initializeInstance(ctor: Function, instance: object): void;
export declare function isObject(value: unknown): value is object;
export declare function installHost(hostOps: HostOps): void;
/** A function object of `fi`'s shape over `scope`. */
export declare function makeFunction(fi: FunctionInfo, scope: Env, home: object | undefined, name?: string): NativeFunction;
/** A class constructor of `fi` over `scope`, extending `parent` when derived. */
export declare function makeClass(fi: FunctionInfo, scope: Env, parent: unknown, name: string, record: ClassRecord): NativeFunction;
/** SetFunctionName's name for a property key, with an optional get/set prefix. */
export declare function functionName(key: PropertyKey, prefix?: string): string;
/** One private name of one evaluation of a class. */
export declare class PrivateName {
    readonly description: string;
    kind: 'field' | 'method' | 'accessor';
    readonly values: WeakMap<object, unknown>;
    /** For methods and accessors: the objects that carry the class's brand. */
    brand: WeakSet<object>;
    method: unknown;
    getter: unknown;
    setter: unknown;
    constructor(description: string);
    private present;
    get(target: unknown): unknown;
    set(target: unknown, value: unknown): void;
    has(target: unknown): boolean;
    /** PrivateFieldAdd / PrivateMethodOrAccessorAdd. */
    add(target: object, value: unknown): void;
}
/** CreateAsyncFromSyncIterator, for `for await` over a sync iterable. */
export declare function asyncFromSyncIterator(syncIterator: object, next: unknown): object;
//# sourceMappingURL=runtime.d.ts.map