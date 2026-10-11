/**
 * node-shims-imports.ts — the static import block every generated node runner
 * (facets/manager.ts's runtime worker, runtime/opencode-facet-runner.ts)
 * prepends to the node shims: what the shims reach by import.
 *
 * The platform's builtins the shims' native provider (`__nativeBuiltin`,
 * node-shims.ts) serves, imported statically: in workerd a static import of
 * one costs a fraction of what process.getBuiltinModule does as the runner's
 * modules initialize (measured: ~90 ms a launch for these). Not node:http or
 * node:https, which a runner's module map may name for its program (the shims
 * re-export them there): the provider reads those from the host as the
 * runner initializes.
 *
 * What workerd gives for them (probe-verified 2026-05-04 at compat date
 * 2026-04-01, flag `nodejs_compat`):
 *   - node:crypto       — full Node 20 surface
 *   - node:tls          — connect/TLSSocket/createSecureContext/...
 *   - node:async_hooks  — AsyncLocalStorage + AsyncResource + createHook
 *   - node:diagnostics_channel — full surface incl. tracingChannel +
 *                                Channel.runStores (fastify-critical)
 *   - node:repl         — surface stub (start/REPLServer)
 *   - node:vm           — surface stub: classes/constants present BUT every
 *                         code-running method throws ERR_METHOD_NOT_IMPLEMENTED;
 *                         the vm block forwards the surface and answers eval
 *                         through the runtime-code service.
 *   - node:inspector    — Session/console/url surface present; the V8
 *                         debugger isn't attachable in workerd, so a
 *                         constructed Session's connect/post are inert.
 *   - node:zlib         — full surface: every *Sync variant, brotli/zstd,
 *                         crc32, constants, and streaming create* factories
 *                         (probe-verified 2026-08-23).
 *   - node:string_decoder, node:perf_hooks — Node's surfaces (perf_hooks'
 *                         createHistogram and monitorEventLoopDelay throw
 *                         ERR_METHOD_NOT_IMPLEMENTED).
 *   - node:url          — full surface, including the legacy parse/format/
 *                         resolve/resolveObject/Url API (v1.20260926.1).
 */
const STATIC_BUILTINS = [
    'async_hooks', 'buffer', 'crypto', 'diagnostics_channel', 'events', 'inspector', 'inspector/promises', 'net', 'path',
    'perf_hooks', 'repl', 'stream', 'string_decoder', 'tls', 'url', 'util', 'vm', 'zlib',
];
export const NODE_SHIMS_IMPORTS = [
    `import { handleAsNodeRequest as __nimbusHandleAsNodeRequest } from 'cloudflare:node';`,
    ...STATIC_BUILTINS.map((id, i) => `import * as __nimbusNative${i} from 'node:${id}';`),
    `const __nimbusNativeBuiltins = { ${STATIC_BUILTINS.map((id, i) => `${JSON.stringify(id)}: __nimbusNative${i}.default ?? __nimbusNative${i}`).join(', ')} };`,
].join('\n');
