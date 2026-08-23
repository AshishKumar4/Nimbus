/**
 * real-node-imports.ts — single source of truth for the static
 * `import * as __real_X from 'node:X'` block that generated runtime
 * workers prepend so the SHIMS string can forward to workerd's real
 * `node:*` builtins.
 *
 * Used by:
 *   - src/facet-manager.ts one-shot runtime worker template
 *   - src/facet-manager.ts long-running process worker template
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
 */
export declare function getRealNodeImportsCode(): string;
//# sourceMappingURL=real-node-imports.d.ts.map