/**
 * The text of the node launch map's module of Node's library
 * (RUNTIME_NODE_LIB_MODULE, core _shared/commonjs-cell.ts): Node's own
 * modules (node-lib-source.ts), the host they run over (node-lib-host.ts),
 * and the data they read. A `{ cjs }` module the shims require the first time
 * a program needs Node's library (node-shims.ts __nimbusNodeLib), so a launch
 * that never formats a value or requires util, assert, querystring or
 * punycode never compiles it. Staged as an asset beside the shims
 * (scripts/bundle-node-shims.mjs).
 */
export declare function generateNodeLibModule(): string;
//# sourceMappingURL=node-lib-module.d.ts.map