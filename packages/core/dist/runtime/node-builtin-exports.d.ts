/**
 * node-builtin-exports.ts — the names Node 22.23.4 gives each builtin's ES
 * module namespace beside `default`: Object.keys of its CommonJS exports, as
 * BuiltinModule.getESMFacade takes them when the builtin first loads. An ES
 * module's import of a builtin links to a facade with these names
 * (native-esm.ts builtinFacadeModule), the shims' own module behind it, so a
 * name Node has links whether or not the shim provides it.
 * tests/unit/node-builtin-exports-match-node.mjs checks the table against
 * host Node and prints it when they differ.
 */
/** Each builtin by its name without `node:`, and its namespace's names but `default`, sorted. */
export declare const NODE_BUILTIN_EXPORTS: Readonly<Record<string, readonly string[]>>;
//# sourceMappingURL=node-builtin-exports.d.ts.map