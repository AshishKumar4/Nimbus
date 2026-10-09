/**
 * real-node-imports.ts — single source of truth for the static
 * `import * as __real_X from 'node:X'` block that generated runtime
 * workers prepend so the SHIMS string can forward to workerd's real
 * `node:*` builtins.
 *
 * Used by:
 *   - src/facets/manager.ts one-shot runtime worker template
 *   - src/facets/manager.ts long-running process worker template
 *
 * Symmetry constraint (W3 plan §3): both templates MUST consume this
 * helper to prevent drift. If you add a new `import * as __real_X`,
 * also wire it into the matching shim block in node-shims.ts.
 *
 * Why this lives in _shared/ alongside exports-resolver.ts: same
 * pattern — JS-string emitter consumed by the facet-code generators
 * that can't `import` at runtime because the surrounding code is a
 * raw string template.
 *
 * Workerd availability matrix (probe-verified 2026-05-04 at compat
 * date 2026-04-01, flag `nodejs_compat`):
 *   - node:crypto       — full Node 20 surface
 *   - node:tls          — connect/TLSSocket/createSecureContext/...
 *   - node:async_hooks  — AsyncLocalStorage + AsyncResource + createHook
 *   - node:fs/promises  — full surface (BUT operates on real-host FS,
 *                         not our VFS, so we shim VFS-backed instead
 *                         of forwarding fs/promises)
 *   - node:diagnostics_channel — full surface incl. tracingChannel +
 *                                Channel.runStores (fastify-critical)
 *   - node:repl         — surface stub (start/REPLServer)
 *   - node:vm           — surface stub: classes/constants present BUT
 *                         every code-running method throws
 *                         ERR_METHOD_NOT_IMPLEMENTED. Hybrid shim:
 *                         forward surface, wrap eval methods with
 *                         honest error.
 *   - node:inspector    — Session/console/url surface present; the V8
 *                         debugger isn't attachable in workerd, so a
 *                         constructed Session's connect/post are inert.
 *                         Tools (e.g. nuxi) that open a Session purely
 *                         for optional profiling degrade cleanly.
 *   - node:zlib         — full surface: every *Sync variant, brotli/zstd,
 *                         crc32, constants, and streaming create* factories
 *                         (probe-verified 2026-08-23 at compat date
 *                         2026-04-01). Forwarded verbatim by the zlib
 *                         block in node-shims.ts; results are the host
 *                         realm's own Buffers, which the widened
 *                         __BufferMod.isBuffer recognizes.
 *   - node:string_decoder — Node's StringDecoder, every encoding; forwarded
 *                         as the string_decoder builtin.
 *   - node:perf_hooks   — Node's surface over the platform's performance
 *                         (its classes are the globals); forwarded as the
 *                         perf_hooks builtin. createHistogram and
 *                         monitorEventLoopDelay throw ERR_METHOD_NOT_IMPLEMENTED.
 *   - node:url          — full surface, including the legacy parse/format/
 *                         resolve/resolveObject/Url API (workerd's
 *                         node-internal:legacy_url, v1.20260926.1). The url
 *                         block in node-shims.ts serves that API from here and
 *                         keeps its own pathToFileURL/fileURLToPath, which
 *                         answer against the guest's cwd.
 *   - node:dns          — resolve/resolve4/resolve6/lookup transport only
 *                         (v1.20260926.1): resolve* return [] on any failure
 *                         and lookup ignores family/all and answers
 *                         127.0.0.1 for literals and misses. The dns block
 *                         in node-shims.ts keeps this transport and adds
 *                         Node's validation, errors, typed queries,
 *                         Resolver and lookupService over DoH JSON.
 */
/**
 * Native imports shared by generated node and opencode guests: events, url,
 * path and HTTP. Userland's `require('events')` must be the class native servers
 * use.
 */
export function getRealNodeSharedImportsCode() {
    return `
import * as __real_events from 'node:events';
import * as __real_url from 'node:url';
import * as __real_path from 'node:path';
import * as __real_http from 'node:http';
import * as __real_https from 'node:https';
import * as __real_net from 'node:net';
import * as __real_util from 'node:util';
import { handleAsNodeRequest as __nimbusHandleAsNodeRequest } from 'cloudflare:node';
`.trim();
}
export function getRealNodeImportsCode() {
    return `
import * as __real_crypto from 'node:crypto';
import * as __real_buffer from 'node:buffer';
import * as __real_tls from 'node:tls';
import * as __real_async_hooks from 'node:async_hooks';
import * as __real_diagnostics_channel from 'node:diagnostics_channel';
import * as __real_repl from 'node:repl';
import * as __real_vm from 'node:vm';
import * as __real_inspector from 'node:inspector';
import * as __real_zlib from 'node:zlib';
import * as __real_dns from 'node:dns';
import * as __real_perf_hooks from 'node:perf_hooks';
${getRealNodeSharedImportsCode()}
`.trim();
}
