/**
 * tree.ts — the interpreter's own copy of the tree acorn parses.
 *
 * acorn builds its tree with the realm's built-ins: each node it makes is
 * pushed onto an array with Array.prototype.push. By the time the
 * interpreter parses, a program may have replaced that (the interpreter
 * loads on the first code a launch did not compile), and the replacement
 * receives acorn's nodes as they are built. It can make a field an accessor
 * that answers each read differently: an identifier's name that passes the
 * check refusing the interpreter's own binding names, then names one of them
 * when read again to be resolved. The analysis and the compiler read a node's
 * fields many times, so they read only this copy (Owned): each field of
 * acorn's tree is read here exactly once, and kept as a primitive, a node of
 * the copy, a list of those, or a record of primitives (a template element's
 * `value`, a regular expression literal's `regex`). Every object of the copy
 * is frozen and inherits nothing, and no program code ever receives one.
 *
 * A literal's `value` is the one object acorn makes with a built-in a program
 * can replace (a RegExp, or a bigint through BigInt), so it is not copied: a
 * regular expression's is null (the compiler builds one from `regex` each
 * time it runs), and a bigint's is made again from its `bigint` text.
 */
import type { AnyNode } from 'acorn';
declare const owned: unique symbol;
/** A node of a tree ownTree made: what the analysis takes. Its descendants are owned too. */
export type Owned<T extends AnyNode> = T & {
    readonly [owned]: true;
};
/** The interpreter's copy of the tree at `root`. */
export declare function ownTree<T extends AnyNode>(root: T): Owned<T>;
export {};
//# sourceMappingURL=tree.d.ts.map