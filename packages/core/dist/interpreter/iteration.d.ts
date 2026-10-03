/**
 * iteration.ts — the iterator protocol as interpreted code runs it: spread,
 * destructuring, for-of and for-await, over the program's own iterables.
 *
 * Each reads an iterable's @@iterator method once and its iterator's `next`
 * once (GetIterator), as natively. An array whose iteration nobody replaced
 * (its @@iterator and %ArrayIteratorPrototype%.next are the originals) is
 * read by index instead, which reads exactly what its iterator would.
 */
import { type SafeList } from './intrinsics.js';
/** A value as an error message names it, without running its code. */
export declare function describe(value: unknown): string;
/** GetMethod(value, @@iterator), or the TypeError for spreading or iterating what has none. */
export declare function iteratorMethod(value: unknown): Function;
/** Whether `method` iterates `value` as reading it by index would: an array, iterated by the original iterator. */
export declare function arrayIteration(value: unknown, method: unknown): value is readonly unknown[];
/** An iterator and its `next`, as GetIterator records them, for a protocol that may stop early and must close it. */
export declare class IteratorRecord {
    readonly iterator: object;
    readonly next: unknown;
    /**
     * Whether the iterator is finished: it said done, or a call to next()
     * (or its result) threw, after which it is never closed.
     */
    done: boolean;
    constructor(iterator: object, next: unknown);
    /** IteratorStep: the next value, or `undefined` with `done` set. */
    step(): unknown;
    /** IteratorClose on a normal or return completion: calls return() and checks its result. */
    close(): void;
    /** IteratorClose on an abrupt completion: the completion's error wins over return()'s. */
    closeQuietly(): void;
}
/** GetIterator(value, sync) with its method already read. */
export declare function iteratorFrom(value: unknown, method: Function): IteratorRecord;
export declare function getIterator(value: unknown): IteratorRecord;
/** Append to `out` what spreading `value` yields. */
export declare function spreadInto(out: SafeList<unknown>, value: unknown): void;
/**
 * IteratorClose of an array's original iterator, which an array pattern read
 * by index stopped short of its end: the lookup of `return` (and its call,
 * should a program have defined one) that native destructuring makes.
 */
export declare function closeArrayIteration(value: readonly unknown[]): void;
/** AsyncIteratorClose on a normal or return completion, awaiting as the enclosing body awaits. */
export declare const asyncIteratorClose: (iterator: object, awaitValue: (x: unknown) => Generator<unknown, unknown, unknown>) => Generator<unknown, void, unknown>;
/** CreateAsyncFromSyncIterator, for `for await` over a sync iterable. */
export declare function asyncFromSyncIterator(syncIterator: object, next: unknown): object;
//# sourceMappingURL=iteration.d.ts.map