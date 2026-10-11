/**
 * Interpreted activations live in the already allocated function environment.
 * A call records its position once; a fault supplies its innermost position
 * lazily. Nothing allocates a stack, or writes a statement position, until an
 * error is made. Native wrappers delimit these activations in V8's stack.
 */
import { Error, SafeWeakMap, charCodeAt, globalObject, newSafeList, reflectGetOwnPropertyDescriptor, reflectOwnKeys, objectGetPrototypeOf, } from './intrinsics.js';
// Suffix slots, filled with own properties by frameTemplate/withElement.
export const STACK_SLOTS = 9;
const INFO = 0, FN = 1, RECEIVER = 2, CONSTRUCTOR = 3, PARENT = 4, ASYNC_PARENT = 5, ASYNC_AT = 6, RESUMED = 7, AT = 8;
let active = null;
let pendingAsync = null;
const promises = new SafeWeakMap();
const stamped = new SafeWeakMap();
export function initializeStack(env, info, fn, receiver, constructor) {
    const at = env.length - STACK_SLOTS;
    env[at + INFO] = info;
    env[at + FN] = fn;
    env[at + RECEIVER] = receiver;
    env[at + CONSTRUCTOR] = constructor;
    env[at + PARENT] = null;
    env[at + ASYNC_PARENT] = null;
    env[at + ASYNC_AT] = 0;
    env[at + RESUMED] = false;
    env[at + AT] = info.start;
}
export function pushStack(env) {
    const previous = active;
    env[env.length - STACK_SLOTS + PARENT] = previous;
    active = env;
    return previous;
}
export function popStack(previous) {
    if (active !== null)
        active[active.length - STACK_SLOTS + PARENT] = null;
    active = previous;
}
/** Called only immediately before invoking a callee, after its arguments. */
export function callPosition(position) {
    if (active !== null)
        active[active.length - STACK_SLOTS + AT] = position;
    pendingAsync = null;
}
/** The native async wrapper has returned its promise to the call expression. */
export function callResult(value) {
    if (pendingAsync !== null && object(value))
        promises.set(value, pendingAsync);
    pendingAsync = null;
    if (value instanceof Error)
        stampStack(value);
    return value;
}
export function suspendedStack(env) {
    const at = env.length - STACK_SLOTS;
    env[at + RESUMED] = true;
    const info = env[at + INFO];
    if (info.shape === 'async' || info.shape === 'asyncArrow')
        pendingAsync = env;
}
/** Only an await establishes an async parent; an un-awaited call does not. */
export function awaitStack(value, position) {
    if (active === null || !object(value))
        return;
    const child = promises.get(value);
    if (child === undefined)
        return;
    const at = child.length - STACK_SLOTS;
    child[at + ASYNC_PARENT] = active;
    child[at + ASYNC_AT] = position;
}
function object(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
function place(source, offset) {
    let line = 1, start = 0;
    for (let i = 0; i < offset; i++) {
        const c = charCodeAt(source, i);
        if (c === 13) {
            if (charCodeAt(source, i + 1) === 10)
                i++;
            line++;
            start = i + 1;
        }
        else if (c === 10 || c === 0x2028 || c === 0x2029) {
            line++;
            start = i + 1;
        }
    }
    return [line, offset - start + 1];
}
// V8's names do not invoke a receiver's constructor/name getters.
function dataName(value, key) {
    if (!object(value))
        return undefined;
    for (let o = value; o !== null; o = objectGetPrototypeOf(o)) {
        const descriptor = reflectGetOwnPropertyDescriptor(o, key);
        if (descriptor !== undefined)
            return descriptor.value;
    }
    return undefined;
}
function methodName(receiver, fn, name) {
    if (!object(receiver) || typeof fn !== 'function')
        return null;
    if (name !== '' && dataName(receiver, name) === fn)
        return name;
    let found = null;
    for (let o = receiver; o !== null; o = objectGetPrototypeOf(o)) {
        const keys = reflectOwnKeys(o);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (typeof key !== 'string')
                continue;
            const descriptor = reflectGetOwnPropertyDescriptor(o, key);
            if (descriptor !== undefined && descriptor.value === fn) {
                if (found !== null && found !== key)
                    return null;
                found = key;
            }
        }
    }
    return found;
}
function snapshot(position, above) {
    const frames = newSafeList();
    let env = active;
    let async = false, strict = false;
    let skipping = typeof above === 'function';
    while (env !== null) {
        const at = env.length - STACK_SLOTS;
        const info = env[at + INFO];
        const fn = env[at + FN];
        strict = strict || info.strict;
        if (skipping) {
            if (fn === above)
                skipping = false;
        }
        else if (info.unit.file !== null) {
            const loc = place(info.unit.source, position === undefined ? env[at + AT] : position);
            const enclosing = place(info.unit.source, info.start);
            const receiver = env[at + RECEIVER];
            const named = dataName(fn, 'name');
            const name = typeof named === 'string' && named !== '' ? named : info.name;
            const constructor = env[at + CONSTRUCTOR] === true;
            const isMethod = !constructor && receiver !== undefined && receiver !== null && receiver !== globalObject
                && info.shape !== 'arrow' && info.shape !== 'asyncArrow' && (info.unit.isProxy === null || !info.unit.isProxy(receiver));
            const method = isMethod ? methodName(receiver, fn, name) : null;
            const ctor = isMethod ? (typeof receiver === 'function' ? receiver : dataName(receiver, 'constructor')) : undefined;
            const typeName = dataName(ctor, 'name');
            frames[frames.length] = {
                unit: info.unit, name: name === '' ? null : name, method,
                type: isMethod ? (typeof typeName === 'string' && typeName !== '' ? typeName : 'Object') : null,
                line: loc[0], column: loc[1], enclosingLine: enclosing[0], enclosingColumn: enclosing[1],
                constructor, async, top: info.shape === 'module', fn: strict ? undefined : fn, receiver: strict ? undefined : receiver,
            };
        }
        const parent = env[at + PARENT];
        if (parent !== null) {
            env = parent;
            position = undefined;
        }
        else if (env[at + RESUMED] === true) {
            position = env[at + ASYNC_AT];
            env = env[at + ASYNC_PARENT];
            async = true;
        }
        else
            env = null;
    }
    return skipping ? newSafeList() : frames;
}
/** Stamp before code can read .stack. Re-throwing an error keeps its origin. */
export function stampStack(error, position, above, replace = false) {
    if (!object(error) || active === null || (!replace && stamped.has(error)))
        return;
    try {
        const frames = snapshot(position, above);
        if (frames.length === 0 && typeof above !== 'function')
            return;
        stamped.set(error, frames);
        const info = active[active.length - STACK_SLOTS + INFO];
        if (info.unit.capture !== null)
            info.unit.capture(error, frames);
    }
    catch {
        // Diagnostics cannot replace the thrown value (a Proxy receiver or a
        // locked Error formatter may refuse introspection).
    }
}
export function stackFrames(error) {
    return stamped.get(error) ?? null;
}
/** Preserve the original thrown value; stacks are metadata, not semantics. */
export function errorAt(error, position) {
    stampStack(error, position);
    throw error;
}
