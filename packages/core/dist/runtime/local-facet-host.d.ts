/**
 * local-facet-host.ts — a facet in a realm of its own, in the caller's process.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so
 * each facet is a worker thread of this process (runtime/realm.ts; its side is
 * facet-guest.ts): the wasm table is compiled here and handed over (a
 * compiled module crosses to a worker without being compiled again, and V8
 * reuses this isolate's compilation of the same bytes), the preamble
 * evaluated once there, and each submitted function evaluated there inside
 * it.
 *
 * A realm of its own because a facet used to be built in this realm, so what
 * its program reached of JavaScript was the host's: Ruby's `js` bridge
 * evaluates code (`JS.eval`) and reads and writes any global, so
 * `JS.eval("globalThis.Promise = null")` broke the host's shell, and a guest
 * spinning without a syscall held the host's only thread for good. Now the
 * program reaches the facet's realm, and a call's timeout or abort ends it
 * (`terminate()` stops even a loop that never yields).
 *
 * The function is SERIALIZED rather than called in place, as on workerd. A
 * runner's facet function reads names the preamble declares —
 * `__wasiMakeImports`, `__bashBoot` — which exist only in the scope the
 * preamble was evaluated in. Its arguments and answer cross as plain data, and
 * the session capability as calls to this side: each supervisor method, and
 * each of its synchronous view's, is answered here from the facet's
 * filesystem.
 */
import type { FacetHost } from './facet-host.js';
import type { WasiParking } from './wasi/types.js';
/** Which of the facet's capabilities a call reaches: the supervisor, or its synchronous view. */
export type SupervisorView = 'supervisor' | 'synchronous';
/** What the realm starts with. */
export interface FacetPayload {
    readonly tag: string;
    /** The host's parking: whether the facet's supervisor answers by promise (jspi) or at once (none). */
    readonly parking: WasiParking;
    readonly preamble?: string;
    /** The supervisor's method names, and its synchronous view's when it has one; absent without syscalls. */
    readonly supervisor?: {
        readonly methods: readonly string[];
        readonly synchronous: readonly string[] | null;
    };
}
/** A submitted call, host to guest. */
export interface FacetSubmit {
    readonly type: 'submit';
    readonly id: number;
    /** The function's source. */
    readonly source: string;
    readonly args: unknown;
    /** Wasm modules to add to the table before the call, compiled here. */
    readonly modules: Record<string, WebAssembly.Module>;
}
export declare function isFacetPayload(value: unknown): value is FacetPayload;
export declare function isFacetSubmit(value: unknown): value is FacetSubmit;
/**
 * Run each facet in a realm of its own, a worker thread of this process.
 *
 * `parking` is the engine's (a worker's is the same engine): where it can
 * suspend a guest the facet is entered through `WebAssembly.promising` and a
 * syscall may park on a promise, so a plain-WASI child waits at a full pipe as
 * it would on Linux. Where it cannot, the guest is entered on an ordinary
 * stack, no syscall may suspend it, the supervisor it mints is the authority's
 * synchronous view, and a pipe buffers to the host's
 * {@link FacetHost.memoryBudgetBytes} instead (pipe-rules.ts).
 *
 * {@link FacetSubmitOptions.timeoutMs} and `signal` are honoured: either ends
 * the facet, as a substrate with isolates of its own does. A facet waiting for
 * no call holds no part of this process: it does not keep it alive.
 */
export declare function localFacetHost(): FacetHost;
//# sourceMappingURL=local-facet-host.d.ts.map