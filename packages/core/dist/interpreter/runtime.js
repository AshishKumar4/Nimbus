import { Error, ReferenceError, SafeAsyncGeneratorPrototype, SafeGeneratorPrototype, SafeWeakMap, SafeWeakSet, TypeError, arrayIsArray, copyList, dataDescriptor, defineOrThrow, globalObject, newList, objectCreate, objectFreeze, objectGetPrototypeOf, objectHasOwn, reflectApply, reflectConstruct, reflectOwnKeys, registerSource, stringOf, symbolDescription, withElement, } from './intrinsics.js';
/** The enclosing environment of `env`. */
export function up(env) {
    const parent = env[0];
    if (!arrayIsArray(parent))
        throw new Error('interpreter: environment without a parent');
    return parent;
}
/** An environment `hops` levels up. */
export function upN(env, hops) {
    let e = env;
    for (let i = 0; i < hops; i++)
        e = up(e);
    return e;
}
/** The environment above every unit's: nothing reads it. */
export const ROOT_ENV = [];
/** The value of a lexical binding before its declaration has run. */
export const TDZ = objectFreeze(objectCreate(null));
export function tdzError(name) {
    return new ReferenceError(`Cannot access '${name}' before initialization`);
}
export const THIS_BEFORE_SUPER = "Must call super constructor in derived class before accessing 'this' or returning from derived constructor";
/** How a statement ended abnormally; a normal completion is `undefined`. */
export class Completion {
    kind;
    label;
    value;
    constructor(kind, label, value) {
        this.kind = kind;
        this.label = label;
        this.value = value;
    }
}
export const BREAK = new Completion('break', null, undefined);
export const CONTINUE = new Completion('continue', null, undefined);
/** The marker an async generator body yields to await, yield or delegate; its operand is beside it. */
export const AWAIT = objectFreeze({ mark: 'await' });
export const YIELD = objectFreeze({ mark: 'yield' });
export const DELEGATE = objectFreeze({ mark: 'delegate' });
export const MARK = objectFreeze({ mark: 'return' });
let pendingOperand;
export function signalOperand(value) {
    pendingOperand = value;
}
/** A compiled function: what every function object made from one source function shares. */
export class FunctionInfo {
    shape;
    name;
    length;
    strict;
    source;
    body = null;
    gen = null;
    /** The body evaluates to the return value itself (an arrow's expression body). */
    expression = false;
    thisSlot = 0;
    argumentsSlot = 0;
    newTargetSlot = 0;
    homeSlot = 0;
    funcSlot = 0;
    /** Parameter slots, when every parameter is a plain identifier. */
    params = null;
    /** Binds the parameters otherwise. */
    bindParams = null;
    /**
     * What a call's frame starts as: slot 0 (the scope) unset, lexical slots
     * in their TDZ, the rest undefined. Copied per call (frameTemplate).
     */
    frame = [];
    /** A derived constructor's `this` starts uninitialized. */
    derived = false;
    /** A class constructor with no constructor in its source. */
    implicit = false;
    /** Compiles the body, on the function's first call (compile.ts); null once compiled. */
    lazy = null;
    constructor(shape, name, length, strict, 
    /** The source text Function.prototype.toString answers. */
    source) {
        this.shape = shape;
        this.name = name;
        this.length = length;
        this.strict = strict;
        this.source = source;
    }
}
// ── The host module and the function runtime ──
let host;
let strictFactories;
let sloppyFactories;
/**
 * A frame of `size` slots, `tdz` of them in their TDZ: every slot an own
 * property, so that an environment copied from it (withElement) is read and
 * written without ever consulting Array.prototype.
 */
export function frameTemplate(size, tdz) {
    const frame = newList(size);
    for (let i = 0; i < tdz.length; i++)
        frame[tdz[i]] = TDZ;
    return frame;
}
export function operators() {
    return host;
}
function enter(fi, scope, fn, thisArg, args, newTarget, home) {
    if (fi.lazy !== null)
        fi.lazy();
    const env = withElement(fi.frame, 0, scope);
    if (fi.thisSlot !== 0)
        env[fi.thisSlot] = fi.derived ? TDZ : thisArg;
    if (fi.argumentsSlot !== 0)
        env[fi.argumentsSlot] = args;
    if (fi.newTargetSlot !== 0)
        env[fi.newTargetSlot] = newTarget;
    if (fi.homeSlot !== 0)
        env[fi.homeSlot] = home;
    if (fi.funcSlot !== 0)
        env[fi.funcSlot] = fn;
    const params = fi.params;
    if (params !== null) {
        for (let i = 0; i < params.length; i++)
            env[params[i]] = args[i];
    }
    else if (fi.bindParams !== null) {
        fi.bindParams(env, args);
    }
    return env;
}
function finish(fi, result) {
    if (fi.expression)
        return result;
    return result instanceof Completion ? result.value : undefined;
}
function run(fi, env) {
    const body = fi.body;
    if (body === null)
        throw new Error('interpreter: a suspending body called synchronously');
    return finish(fi, body(env));
}
/**
 * One evaluation of a class: what constructing an instance initializes, and
 * the home object of its constructor. Filled in once the class's elements
 * are defined, before anything can construct it.
 */
export class ClassRecord {
    /** Initializes an instance's private methods and fields, in order. */
    initialize = null;
    home = undefined;
}
/** The record of each class constructor, for super() calls, which know only the constructor. */
const classRecords = new SafeWeakMap();
function registerClass(ctor, record) {
    classRecords.set(ctor, record);
}
/** The object a derived constructor's super(...args) constructs, before its fields. */
export function superConstruct(ctor, args, newTarget) {
    const parent = objectGetPrototypeOf(ctor);
    if (typeof parent !== 'function' || typeof newTarget !== 'function') {
        throw new TypeError(`Super constructor ${stringOf(parent)} of anonymous class is not a constructor`);
    }
    const instance = reflectConstruct(parent, args, newTarget);
    if (!isObject(instance))
        throw new TypeError('Derived constructor did not produce an object');
    return instance;
}
/** InitializeInstanceElements: the private methods and fields of `ctor`'s class, once `this` is bound. */
export function initializeInstance(ctor, instance) {
    const record = classRecords.get(ctor);
    if (record && record.initialize)
        record.initialize(instance);
}
export function isObject(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
const runtime = {
    call(fi, scope, fn, thisArg, args, newTarget, home) {
        return run(fi, enter(fi, scope, fn, thisArg, args, newTarget, home));
    },
    arrow(fi, scope, args) {
        return run(fi, enter(fi, scope, undefined, undefined, args, undefined, undefined));
    },
    enter,
    finish,
    construct(fi, scope, ctor, record, thisArg, args, newTarget) {
        if (record.initialize)
            record.initialize(thisArg);
        if (fi.implicit)
            return undefined;
        return run(fi, enter(fi, scope, ctor, thisArg, args, newTarget, record.home));
    },
    constructDerived(fi, scope, ctor, record, args, newTarget) {
        // The implicit constructor passes its arguments on as they are, without iterating them.
        if (fi.implicit) {
            const instance = superConstruct(ctor, copyList(args), newTarget);
            if (record.initialize)
                record.initialize(instance);
            return instance;
        }
        const env = enter(fi, scope, ctor, undefined, args, newTarget, record.home);
        const body = fi.body;
        if (body === null)
            throw new Error('interpreter: a suspending constructor');
        // Undefined falls through to `this`; anything else is the native
        // constructor's own answer (an object, or the TypeError for a primitive).
        const value = finish(fi, body(env));
        if (value !== undefined)
            return value;
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
        if (env === undefined)
            throw new Error('interpreter: a generator started without its frame');
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
const pendingFrames = new SafeWeakMap();
export function installHost(hostOps) {
    const bound = hostOps.bind(runtime);
    host = bound.ops;
    strictFactories = bound.strict;
    sloppyFactories = bound.sloppy;
}
/** A function object of `fi`'s shape over `scope`. */
export function makeFunction(fi, scope, home, name = fi.name) {
    const factories = fi.strict ? strictFactories : sloppyFactories;
    let fn;
    switch (fi.shape) {
        case 'plain':
            fn = factories.plain(fi, scope);
            break;
        case 'method':
            fn = factories.method(fi, scope, home);
            break;
        case 'arrow':
            fn = factories.arrow(fi, scope);
            break;
        case 'generator':
            fn = factories.generator(fi, scope, home);
            break;
        case 'async':
            fn = factories.async(fi, scope, home);
            break;
        case 'asyncArrow':
            fn = factories.asyncArrow(fi, scope);
            break;
        case 'asyncGenerator':
            fn = factories.asyncGenerator(fi, scope, home);
            break;
        case 'classBase':
        case 'classDerived': throw new Error('interpreter: classes are made by makeClass');
    }
    return finishFunction(fn, fi, name);
}
/** A class constructor of `fi` over `scope`, extending `parent` when derived. */
export function makeClass(fi, scope, parent, name, record) {
    const ctor = fi.shape === 'classDerived' ? strictFactories.classDerived(fi, scope, parent, record) : strictFactories.classBase(fi, scope, record);
    registerClass(ctor, record);
    return finishFunction(ctor, fi, name);
}
function finishFunction(fn, fi, name) {
    if (fi.length !== 0)
        defineOrThrow(fn, 'length', dataDescriptor(fi.length, false, false, true));
    if (name !== '' || fi.shape === 'method')
        defineOrThrow(fn, 'name', dataDescriptor(name, false, false, true));
    registerSource(fn, fi.source);
    return fn;
}
/** SetFunctionName's name for a property key, with an optional get/set prefix. */
export function functionName(key, prefix) {
    let name;
    if (typeof key === 'symbol') {
        const description = symbolDescription(key);
        name = description === undefined ? '' : `[${description}]`;
    }
    else {
        name = stringOf(key);
    }
    return prefix ? `${prefix} ${name}` : name;
}
// ── Private names ──
/** One private name of one evaluation of a class. */
export class PrivateName {
    description;
    kind = 'field';
    values = new SafeWeakMap();
    /** For methods and accessors: the objects that carry the class's brand. */
    brand = new SafeWeakSet();
    method = undefined;
    getter = undefined;
    setter = undefined;
    constructor(description) {
        this.description = description;
    }
    present(target) {
        if (!isObject(target))
            return false;
        return this.kind === 'field' ? this.values.has(target) : this.brand.has(target);
    }
    get(target) {
        if (!this.present(target))
            throw new TypeError(`Cannot read private member ${this.description} from an object whose class did not declare it`);
        if (this.kind === 'field')
            return this.values.get(target);
        if (this.kind === 'method')
            return this.method;
        if (typeof this.getter !== 'function')
            throw new TypeError(`'${this.description}' was defined without a getter`);
        return reflectApply(this.getter, target, []);
    }
    set(target, value) {
        if (!this.present(target))
            throw new TypeError(`Cannot write private member ${this.description} to an object whose class did not declare it`);
        if (this.kind === 'field') {
            this.values.set(target, value);
            return;
        }
        if (this.kind === 'method')
            throw new TypeError(`Private method '${this.description}' is not writable`);
        if (typeof this.setter !== 'function')
            throw new TypeError(`'${this.description}' was defined without a setter`);
        reflectApply(this.setter, target, [value]);
    }
    has(target) {
        if (!isObject(target))
            throw new TypeError(`Cannot use 'in' operator to search for '${this.description}' in ${stringOf(target)}`);
        return this.kind === 'field' ? this.values.has(target) : this.brand.has(target);
    }
    /** PrivateFieldAdd / PrivateMethodOrAccessorAdd. */
    add(target, value) {
        if (this.kind === 'field') {
            if (this.values.has(target))
                throw new TypeError(`Cannot initialize ${this.description} twice on the same object`);
            this.values.set(target, value);
            return;
        }
        if (this.brand.has(target))
            throw new TypeError(`Cannot initialize private methods of class ${this.description} twice on the same object`);
        this.brand.add(target);
    }
}
