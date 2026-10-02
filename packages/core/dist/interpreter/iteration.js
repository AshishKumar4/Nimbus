/**
 * iteration.ts — the iterator protocol as interpreted code runs it: spread,
 * destructuring, for-of and for-await, over the program's own iterables.
 *
 * Each reads an iterable's @@iterator method once and its iterator's `next`
 * once (GetIterator), as natively. An array whose iteration nobody replaced
 * (its @@iterator and %ArrayIteratorPrototype%.next are the originals) is
 * read by index instead, which reads exactly what its iterator would.
 */
import { ArrayIteratorNext, ArrayIteratorPrototype, ArrayValues, TypeError, append, arrayIsArray, promiseReject, promiseResolve, reflectApply, reflectGet, safeGenerator, stringOf, symbolDescriptiveString, symbolIterator, } from './intrinsics.js';
import { isObject, operators } from './runtime.js';
/** A value as an error message names it, without running its code. */
export function describe(value) {
    if (typeof value === 'function')
        return 'function';
    if (typeof value === 'object' && value !== null)
        return 'object';
    if (typeof value === 'symbol')
        return symbolDescriptiveString(value);
    return stringOf(value);
}
/** GetMethod(value, @@iterator), or the TypeError for spreading or iterating what has none. */
export function iteratorMethod(value) {
    const method = value === null || value === undefined ? undefined : operators().get(value, symbolIterator);
    if (typeof method !== 'function')
        throw new TypeError(`${describe(value)} is not iterable`);
    return method;
}
/** Whether `method` iterates `value` as reading it by index would: an array, iterated by the original iterator. */
export function arrayIteration(value, method) {
    return method === ArrayValues && arrayIsArray(value) && reflectGet(ArrayIteratorPrototype, 'next') === ArrayIteratorNext;
}
/** An iterator and its `next`, as GetIterator records them, for a protocol that may stop early and must close it. */
export class IteratorRecord {
    iterator;
    next;
    /**
     * Whether the iterator is finished: it said done, or a call to next()
     * (or its result) threw, after which it is never closed.
     */
    done = false;
    constructor(iterator, next) {
        this.iterator = iterator;
        this.next = next;
    }
    /** IteratorStep: the next value, or `undefined` with `done` set. */
    step() {
        this.done = true;
        const next = this.next;
        if (typeof next !== 'function')
            throw new TypeError(`${describe(next)} is not a function`);
        const result = reflectApply(next, this.iterator, []);
        if (!isObject(result))
            throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
        if (reflectGet(result, 'done'))
            return undefined;
        const value = reflectGet(result, 'value');
        this.done = false;
        return value;
    }
    /** IteratorClose on a normal or return completion: calls return() and checks its result. */
    close() {
        const iterator = this.iterator;
        const ret = reflectGet(iterator, 'return');
        if (ret === undefined || ret === null)
            return;
        if (typeof ret !== 'function')
            throw new TypeError(`${describe(ret)} is not a function`);
        const result = reflectApply(ret, iterator, []);
        if (!isObject(result))
            throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
    }
    /** IteratorClose on an abrupt completion: the completion's error wins over return()'s. */
    closeQuietly() {
        try {
            this.close();
        }
        catch { /* the original error propagates */ }
    }
}
/** GetIterator(value, sync) with its method already read. */
export function iteratorFrom(value, method) {
    const iterator = reflectApply(method, value, []);
    if (!isObject(iterator))
        throw new TypeError('Result of the Symbol.iterator method is not an object');
    return new IteratorRecord(iterator, reflectGet(iterator, 'next'));
}
export function getIterator(value) {
    return iteratorFrom(value, iteratorMethod(value));
}
/** Append to `out` what spreading `value` yields. */
export function spreadInto(out, value) {
    const method = iteratorMethod(value);
    if (arrayIteration(value, method)) {
        for (let i = 0; i < value.length; i++)
            append(out, value[i]);
        return;
    }
    const it = iteratorFrom(value, method);
    for (let x = it.step(); !it.done; x = it.step())
        append(out, x);
}
/**
 * IteratorClose of an array's original iterator, which an array pattern read
 * by index stopped short of its end: the lookup of `return` (and its call,
 * should a program have defined one) that native destructuring makes.
 */
export function closeArrayIteration(value) {
    const iterator = reflectApply(ArrayValues, value, []);
    if (!isObject(iterator))
        throw new TypeError('Result of the Symbol.iterator method is not an object');
    new IteratorRecord(iterator, undefined).close();
}
/** AsyncIteratorClose on a normal or return completion, awaiting as the enclosing body awaits. */
export const asyncIteratorClose = safeGenerator(function* (iterator, awaitValue) {
    const ret = reflectGet(iterator, 'return');
    if (ret === undefined || ret === null)
        return;
    if (typeof ret !== 'function')
        throw new TypeError('iterator.return is not a function');
    const closed = yield* awaitValue(reflectApply(ret, iterator, []));
    if (!isObject(closed))
        throw new TypeError(`Iterator result ${stringOf(closed)} is not an object`);
});
/**
 * AsyncFromSyncIteratorContinuation: a sync iterator's result as the
 * promise of an iterator result, awaiting its value, and closing the
 * iterator when that rejects (if asked to).
 */
async function continuation(result, syncIterator, closeOnRejection) {
    if (!isObject(result))
        throw new TypeError(`Iterator result ${stringOf(result)} is not an object`);
    const done = !!reflectGet(result, 'done');
    const value = reflectGet(result, 'value');
    let settled;
    try {
        settled = await value;
    }
    catch (error) {
        if (!done && closeOnRejection) {
            const ret = reflectGet(syncIterator, 'return');
            if (typeof ret === 'function') {
                try {
                    reflectApply(ret, syncIterator, []);
                }
                catch { /* the rejection wins */ }
            }
        }
        throw error;
    }
    return { value: settled, done };
}
/** CreateAsyncFromSyncIterator, for `for await` over a sync iterable. */
export function asyncFromSyncIterator(syncIterator, next) {
    return {
        next(value) {
            try {
                if (typeof next !== 'function')
                    throw new TypeError('iterator.next is not a function');
                return continuation(reflectApply(next, syncIterator, [value]), syncIterator, true);
            }
            catch (e) {
                return promiseReject(e);
            }
        },
        return(value) {
            try {
                const ret = reflectGet(syncIterator, 'return');
                if (ret === undefined || ret === null)
                    return promiseResolve({ value, done: true });
                if (typeof ret !== 'function')
                    throw new TypeError('iterator.return is not a function');
                return continuation(reflectApply(ret, syncIterator, [value]), syncIterator, false);
            }
            catch (e) {
                return promiseReject(e);
            }
        },
        throw(value) {
            try {
                const thr = reflectGet(syncIterator, 'throw');
                if (thr === undefined || thr === null) {
                    const ret = reflectGet(syncIterator, 'return');
                    if (typeof ret === 'function')
                        reflectApply(ret, syncIterator, []);
                    throw new TypeError('The iterator does not provide a throw method');
                }
                if (typeof thr !== 'function')
                    throw new TypeError('iterator.throw is not a function');
                return continuation(reflectApply(thr, syncIterator, [value]), syncIterator, true);
            }
            catch (e) {
                return promiseReject(e);
            }
        },
    };
}
