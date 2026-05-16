/**
 * real-node-imports.ts — single source of truth for the static
 * `import * as __real_X from 'node:X'` block that the generated facet
 * code prepends so the SHIMS string can forward to workerd's real
 * `node:*` builtins.
 *
 * Used by:
 *   - src/facet-manager.ts:generateFacetCode (NodeProcess template)
 *   - src/facet-manager.ts: LOADER.load fallback template
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
 */

export function getRealNodeImportsCode(): string {
  return `
import * as __real_crypto from 'node:crypto';
import * as __real_tls from 'node:tls';
import * as __real_async_hooks from 'node:async_hooks';
import * as __real_diagnostics_channel from 'node:diagnostics_channel';
import * as __real_repl from 'node:repl';
import * as __real_vm from 'node:vm';
`.trim();
}
