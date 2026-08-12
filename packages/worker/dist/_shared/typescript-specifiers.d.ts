/**
 * typescript-specifiers.ts — the one definition of how a module specifier
 * reaches a TypeScript source, shared by the install-time prefetch resolver
 * and the `require()` inside a running facet.
 *
 * TypeScript's `"moduleResolution": "NodeNext"` requires authors to write the
 * OUTPUT extension in a specifier that names a TypeScript source:
 *
 *     // packages/cli/bin/cli.ts
 *     import '../src/program.js';        // means ../src/program.ts
 *
 * That is not one project's quirk, it is what every modern TS project on
 * NodeNext looks like. Real bun resolves it; node does not.
 *
 * SCOPE — this resolver serves node as well, so the rule is deliberately a
 * FALLBACK rather than a reordering: these candidates are probed only after
 * every candidate node itself would try has missed, and they only ever name a
 * TypeScript source. The inputs whose resolution changes are therefore exactly
 * the inputs that resolve to nothing today, where node's own answer is
 * "Cannot find module". No module graph that resolves now resolves
 * differently, so nothing about node's semantics moves — while the TypeScript
 * projects Nimbus already transforms and runs become resolvable.
 *
 * The one bun behaviour deliberately NOT adopted is its probe ORDER. Bun tries
 * `.tsx, .ts, .jsx, .js`, so for `./m` with both `m.ts` and `m.js` present bun
 * answers `m.ts` and node answers `m.js`. Preferring the TypeScript file there
 * would change a specifier that already resolves, which is the one thing this
 * scoping promises not to do.
 *
 * Mapping measured against bun 1.3.1, not recalled:
 *   ./m.js   → m.ts, m.tsx      (and m.js itself still wins when it exists)
 *   ./m.mjs  → m.mts
 *   ./m.cjs  → nothing; bun does not map it to m.cts
 *   ./m      → m.ts, m.tsx
 *
 * `getTypescriptSpecifiersJS()` emits the same mapping for the facet shim.
 * The two bodies are checked against each other mechanically —
 * tests/unit/typescript-specifier-resolution.mjs evaluates the emitted one and
 * compares it to this one over the whole table — because a "keep in sync"
 * comment has never once caught a drift.
 */
/**
 * TypeScript sources a specifier may name once every path node itself would
 * take has missed. Empty when the specifier cannot name one.
 */
export declare function typescriptFallbackCandidates(base: string): string[];
/** Directory entry points, probed after node's `index.{js,cjs,mjs,json}`. */
export declare const TYPESCRIPT_INDEX_CANDIDATES: readonly ["/index.ts", "/index.tsx"];
/**
 * The same mapping as raw JS, for embedding in the facet shim.
 *
 * The regex and the index list are interpolated from the definitions above so
 * only the four-branch body is written twice, and the equivalence of the two
 * bodies is asserted over the whole table by the unit test rather than
 * asserted by a comment.
 */
export declare function getTypescriptSpecifiersJS(): string;
//# sourceMappingURL=typescript-specifiers.d.ts.map