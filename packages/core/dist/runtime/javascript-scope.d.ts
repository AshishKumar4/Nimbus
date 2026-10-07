/**
 * javascript-scope.ts — which scope a name in a parsed program binds to.
 *
 * Reads ESTree as acorn and rolldown's parser give it, structurally (any
 * object with a string `type` and numeric `start` and `end` is a node), so
 * TypeScript's binding forms count where they bind at run time. The scopes
 * are the language's: a program's and a static block's, a function's
 * parameters and its body's `var`s, a block's, a switch's, a `for` head's
 * `let` and `const`, a catch clause's, and a class's name inside its body.
 *
 * Self-contained: rolldown-compat.ts (the build facet's runtime) and
 * async-module-lowering.ts (the transform facet's) both bundle it.
 */
/** A node of a parsed program. */
export interface EsNode {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly [key: string]: unknown;
}
export declare function isNode(value: unknown): value is EsNode;
/** `node[key]` when it is a node. */
export declare function child(node: EsNode | null, key: string): EsNode | null;
/** The nodes of the list `node[key]`. */
export declare function list(node: EsNode | null, key: string): EsNode[];
/** `node[key]` when it is a string. */
export declare function stringOf(node: EsNode | null, key: string): string | null;
/** The names a binding binds: an identifier, or what the parts of a pattern bind. */
export declare function patternNames(node: EsNode | null): Generator<string>;
/** A scope of a program: the names it binds, and the scope it is in. */
export interface Scope {
    readonly names: ReadonlySet<string>;
    readonly parent: Scope | null;
}
/** The names a program's top-level statement binds in its scope: its `var`s and its lexical declarations. */
export declare function programNames(statement: EsNode): string[];
/**
 * Every node under `value`, each before its children, with the scope it is
 * in, the node it is under and the key it is under that node by (null and
 * '' for `value` itself). A program's own scope is the one whose parent is
 * `scope`. A node `opaque` says is yielded, but not what is under it.
 *
 * Walked with a stack of its own, not a generator per node: a yield passes
 * through no frames, whatever the depth.
 */
export declare function scoped(value: unknown, scope: Scope, sloppy: boolean, functionBody?: boolean, parent?: EsNode | null, key?: string, opaque?: (node: EsNode) => boolean): Generator<[EsNode, Scope, EsNode | null, string]>;
/** The innermost scope from `scope` out that binds `name`, or null where none does. */
export declare function bindingScope(scope: Scope | null, name: string): Scope | null;
/**
 * Whether an identifier under `parent` by `key` reads or writes a binding,
 * rather than naming a property, a key or a label, `import.meta`'s parts, or
 * an import or export specifier's names (the declaration's, or the other
 * module's).
 */
export declare function namesBinding(parent: EsNode, key: string): boolean;
/** Whether a program's code is sloppy: a script without "use strict". */
export declare function isSloppy(program: EsNode): boolean;
//# sourceMappingURL=javascript-scope.d.ts.map