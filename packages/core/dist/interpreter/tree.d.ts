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
 * fields many times, so they read only this copy (Owned).
 *
 * The copy is made node by node, by the type acorn gave the node, which is
 * read first: each field acorn's typings declare for that type is read
 * exactly once and checked to be what they say (a string, a node of the
 * kinds the field may hold, a list of those), and nothing else is read. Every
 * object of the copy is frozen and inherits nothing, every list is a
 * SafeList, and no program code ever receives one. So the copy is an Owned
 * tree by construction, and the analysis takes nothing else.
 *
 * A literal's `value` is the one object acorn makes with a built-in a program
 * can replace (a RegExp, or a bigint through BigInt), so it is not copied: a
 * regular expression's is null (the compiler builds one from `regex` each
 * time it runs), and a bigint's is made again from its `bigint` text.
 */
import type { AnyNode, FunctionExpression, Program, SourceLocation } from 'acorn';
import type { FunctionNode } from './scope.js';
import { type SafeList } from './intrinsics.js';
/**
 * A node of the copy: acorn's typing of it, every node in it owned and every
 * list a SafeList (so a tree acorn returned is not one).
 */
export type Owned<T extends AnyNode> = {
    readonly [K in keyof T]: OwnedField<T[K]>;
};
type OwnedField<V> = V extends AnyNode ? Owned<V> : V extends SourceLocation | [number, number] ? V : V extends (infer E)[] ? SafeList<OwnedField<E>> : V;
/** The interpreter's copy of a program acorn parsed. Each function in it is appended to `found`, if given. */
export declare function ownProgram(program: Program, found?: SafeList<Owned<FunctionNode>> | null): Owned<Program>;
/** The interpreter's copy of a function expression acorn parsed (a Function constructor's). */
export declare function ownFunctionExpression(node: FunctionExpression): Owned<FunctionExpression>;
export {};
//# sourceMappingURL=tree.d.ts.map