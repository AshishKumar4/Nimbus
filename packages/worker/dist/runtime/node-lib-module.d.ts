/**
 * The text of the node launch map's module of Node's library
 * (RUNTIME_NODE_LIB_MODULE, core _shared/commonjs-cell.ts): Node's own
 * modules (node-lib-source.ts), the host they run over (node-lib-host.ts),
 * and the data they read. A `{ cjs }` module the shims require the first time
 * a program needs Node's library (node-shims.ts __nimbusNodeLib), so a launch
 * that never formats a value or requires util, assert, querystring or
 * punycode never compiles it. Of Node's modules it carries only what
 * formatting a value requires (util.inspect, as an uncaught error's report
 * and console.log of an object do); the others are in
 * RUNTIME_NODE_LIB_REST_MODULE and DNS's in RUNTIME_NODE_DNS_MODULE, each
 * compiled the first time a program requires one of its modules. Staged as
 * assets beside the shims (scripts/bundle-node-shims.mjs).
 */
export declare function generateNodeDnsModule(): string;
export declare function generateNodeLibRestModule(): string;
export declare function generateNodeLibModule(): string;
//# sourceMappingURL=node-lib-module.d.ts.map