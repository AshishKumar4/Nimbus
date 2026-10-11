/**
 * The text of the node launch map's module of the native ES module host
 * (RUNTIME_NODE_ESM_MODULE, core _shared/commonjs-cell.ts): how the
 * registry links, evaluates, adopts and requires a launch's staged ES modules
 * (worker facets/esm-stage.ts). A `{ cjs }` module the shims require the
 * first time a program links, imports or requires an ES module
 * (node-shims.ts __nimbusEsmRuntime), so a CommonJS program never compiles
 * it: carried in the shims, it cost every launch's run 10 to 17 ms.
 *
 * Its functions are the host's; their state, and the built-ins they capture,
 * are the shims', made before any program code runs, and given to
 * createEsmRuntime once per launch with everything else of the shims' they
 * call. Staged as an asset beside the shims (scripts/bundle-node-shims.mjs).
 */
export declare function generateNodeEsmModule(): string;
//# sourceMappingURL=node-esm-module.d.ts.map