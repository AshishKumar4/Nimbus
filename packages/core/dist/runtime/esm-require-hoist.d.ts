/**
 * esm-require-hoist.ts — which require() calls of an ES module's top level
 * the registry can evaluate natively, and the question that decides the rest:
 * does a module await at its top level.
 *
 * A require() of an ES module (Node 22's require(esm)) evaluates its graph
 * synchronously, at the call. The registry cannot: it runs a module body
 * only from its gate (native-esm.ts), after the import that links it, so a
 * graph a require() meets unevaluated is the interpreter's (node-shims'
 * adoption), at a cost a whole application cannot pay. One shape is common
 * and needs no such evaluation: a module whose top level loads the program
 * through require() before anything else happens (pi's bin:
 * `enableCompileCache(); createRequire(import.meta.url)("./cli-runtime.js")`).
 * There the require() can be the module's last static import instead, and
 * the target is evaluated where Node evaluates it, as far as anything can
 * tell: after the module's own imports, before any statement of its body
 * that could observe the target or be observed by it. So a require() is
 * hoisted only when every top-level statement before it is one of:
 *   - an import or export-from declaration (evaluated first in either order);
 *   - a function declaration, or a class declaration that runs no code when
 *     declared (no heritage: `extends undefined`, or a name in its TDZ,
 *     throws; no static block, computed key, or static field initializer but
 *     a literal);
 *   - a const, let or var that binds names (no pattern) to literals, a
 *     createRequire(import.meta.url) call (pure: a function of the module's
 *     URL), or an earlier hoisted require() (both orders evaluate the two
 *     targets in turn). A pattern runs code after its initializer: getters
 *     (inherited ones, an export named 'module.exports'), an iterator,
 *     defaults, computed keys, a throw on null. Its declarator's require()
 *     is hoisted, and it ends the prefix;
 *   - a directive, an empty statement, or a call of module.enableCompileCache.
 *     That one has no effect a module can observe in Nimbus, which keeps no
 *     compile cache (the guest's answers DISABLED, status 3, the same before
 *     the target and after it).
 * and the require() is its statement's whole effect: a statement of its own,
 * or a declarator's initializer, with a literal specifier, through a name
 * bound to createRequire(import.meta.url) at the top level or the call itself.
 * Anything else ends the prefix, and later requires are left to the call.
 * The target's graph must not contain the module and must not await at its
 * top level (staging checks both: worker facets/esm-stage.ts); otherwise
 * Node's own refusal is the call's to throw.
 */
/**
 * The literal specifiers of the require() calls at `code`'s top level that
 * can be hoisted to static imports, in order (see the header). `code` is an
 * ES module's text; one that does not parse has none.
 */
export declare function hoistableRequires(code: string): string[];
/**
 * Whether an ES module's text awaits at its top level (an `await`, or a
 * `for await`, outside every function): V8's [[HasTLA]], which Node's
 * require() refuses a graph for. Text acorn cannot read (one that does not
 * parse, which the registry reports, or nests past its stack) has none. Nodes
 * complete inner first, so a function drops the awaits it holds as it
 * completes, and what is left is the top level's.
 */
export declare function hasTopLevelAwait(code: string): boolean;
/**
 * What staging reads of an ES module beside its import sites: whether it
 * awaits at its top level, and the require() calls it can hoist. Read where
 * its sites are (the transform host), and kept with them.
 */
export interface EsModuleFacts {
    readonly topLevelAwait?: true;
    readonly requires?: readonly string[];
}
/** An ES module's EsModuleFacts. */
export declare function esModuleFacts(code: string): EsModuleFacts;
//# sourceMappingURL=esm-require-hoist.d.ts.map