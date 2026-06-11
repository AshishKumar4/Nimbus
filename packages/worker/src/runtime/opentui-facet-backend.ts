/**
 * opentui-facet-backend.ts — the in-facet boot glue that constructs the OpenTUI
 * wasm FFI backend and parks it on `globalThis.__nimbusOpenTUIBackend` for the
 * Nimbus-patched @opentui/core seams (see scripts/opencode/build-node.ts,
 * nimbusPatchOpenTUI) to resolve their render library from.
 *
 * The opencode bundle rides into the Worker Loader module map as an ESM module,
 * so worker-internal TypeScript cannot be imported into the facet isolate.
 * Facet-side runtime code is therefore authored as a source string injected at
 * module-init — the same mechanism wasi-instance.ts (WASI_INSTANCE_PREAMBLE_SRC)
 * and sqlite-shim.ts (generateSqliteFacetPreamble) use.
 *
 * SOURCE OF TRUTH: the backend implementation is
 * runtime/opentui-wasm-backend.ts (OpenTUIWasmBackend, Stage B, audited). The
 * string below is its facet-runnable mirror (type annotations stripped, private
 * fields kept). Keep the two in sync by hand; the bundle-wiring test
 * (tests/unit/opentui-bundle-wiring.mjs) evaluates THIS string and drives a full
 * 279-symbol render through it, so any behavioral drift from the TS class fails
 * loudly.
 *
 * The WASI host the backend needs (`__wasiMakeImports` / `__wasiInitFS`) comes
 * from WASI_INSTANCE_PREAMBLE_SRC, which the runner injects ahead of this glue.
 */

import { WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import {
  OpenTUIWasmBackend,
  OPENTUI_FFI_TYPES,
  ARENA_ALIGN,
  toOffset,
  viewBytes,
} from './opentui-wasm-backend.js';

/** Module-map specifier for the staged OpenTUI wasm32-wasi reactor Module. */
export const OPENTUI_WASM_MODULE_NAME = 'opentui.wasm';

/** Global the patched @opentui/core seams read their FFI backend from. */
export const OPENTUI_BACKEND_GLOBAL = '__nimbusOpenTUIBackend';

/**
 * The backend class body, facet-runnable. SINGLE-SOURCED from OpenTUIWasmBackend
 * (opentui-wasm-backend.ts) via `.toString()`: the class and its module-scope
 * helpers are serialized from the real implementation, so the facet runs
 * byte-equivalent logic and cannot drift. The parity test
 * (tests/unit/opentui-facet-backend-parity.mjs) evaluates this string and drives
 * the full backend contract through it. Mirrors npm-resolve-preamble (policy fns
 * embedded via fn.toString() + a parity test).
 */
const OPENTUI_BACKEND_CLASS_SRC = [
  `const FFI_TYPE_SET = new Set(${JSON.stringify(OPENTUI_FFI_TYPES)});`,
  `const ARENA_ALIGN = ${ARENA_ALIGN};`,
  `const toOffset = ${toOffset.toString()};`,
  `const viewBytes = ${viewBytes.toString()};`,
  OpenTUIWasmBackend.toString(),
].join('\n');

/**
 * The facet-runnable backend definition: the WASI preamble + the backend class.
 * Both the runner boot code and the wiring test embed this. Exposes the class
 * and the two WASI host helpers as locals; the boot code (or test) constructs
 * the instance from them.
 */
export const OPENTUI_BACKEND_FACET_SRC: string = `${WASI_INSTANCE_PREAMBLE_SRC}\n${OPENTUI_BACKEND_CLASS_SRC}`;

/**
 * Module-init boot block for the opencode runner: instantiate the backend over
 * the Nimbus WASI host and park it on the registry global BEFORE the
 * @opentui/core bundle init runs. The staged bytes' integrity is verified
 * supervisor-side at fetch time (fetchOpenTUIWasmBytes vs OPENTUI_WASM_SHA256),
 * so the Module reaching this scope is already trusted.
 *
 * The WASI preamble + backend class (OPENTUI_BACKEND_FACET_SRC) must already be
 * in scope, and `__nimbusOpenTUIWasmModule` (the pre-compiled Module imported
 * from the Worker Loader module map) must be bound — request-time
 * WebAssembly.compile is blocked, so the Module never comes from bytes here.
 */
export function generateOpenTUIBackendBootCode(): string {
  return `
// ── OpenTUI wasm FFI backend (module-init scope) ───────────────────────────
// The pre-compiled WebAssembly.Module rides in via the module map (integrity
// already verified supervisor-side). The backend is instantiated over the
// Nimbus WASI host and parked on the registry global the Nimbus-patched
// @opentui/core seams read from — BEFORE the opencode bundle import links
// @opentui/core's module-init FFI resolution.
{
  const __otuiWasi = {
    makeImports: (o) => __wasiMakeImports(o),
    initFS: (o) => __wasiInitFS(o),
  };
  globalThis.${OPENTUI_BACKEND_GLOBAL} = OpenTUIWasmBackend.create({
    module: __nimbusOpenTUIWasmModule,
    wasi: __otuiWasi,
    env: {
      TERM: (env && env.TERM) || "xterm-256color",
      COLORTERM: (env && env.COLORTERM) || "truecolor",
    },
  });
}
`;
}
