/**
 * Node's own argument checks in front of the builtins workerd provides
 * (zlib, buffer, crypto): the shims run each over its forwarded module (node-shims.ts,
 * "the builtins workerd provides"). A call Node refuses throws Node's error,
 * from core _shared/node-error.ts or Node's own validator (node-lib-host.ts),
 * which is loaded only once a cheap check has failed. A call Node takes goes
 * on to workerd's function with its arguments as Node's function would pass
 * them on. Each front names the Node v22.22.3 function whose checks it runs.
 * The text is ASCII: bun prints a String.raw template's other characters as
 * escapes, which tsc does not, so the staged shims would differ from src.
 */
export declare const NODE_BUILTIN_FRONTS_SOURCE: string;
//# sourceMappingURL=node-builtin-fronts.d.ts.map