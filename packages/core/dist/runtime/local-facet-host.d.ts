/**
 * local-facet-host.ts — a facet in a realm of its own, beside the caller.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so
 * each facet is a realm (runtime/realm.ts; its side is facet-guest.ts): the
 * wasm table filled, the preamble evaluated once there, and each submitted
 * function evaluated there inside it. The realm is a worker thread of this
 * process, or under Bun a process of its own: Bun 1.4 cannot end a worker
 * running WebAssembly, and a facet runs nothing else. A thread is handed its
 * modules compiled here (a compiled module crosses to a worker without a
 * second compile, and V8 reuses this isolate's compilation of the same
 * bytes); a process, which no compiled module crosses to, their bytes.
 *
 * A realm of its own because a facet used to be built in this realm, so what
 * its program reached of JavaScript was the host's: Ruby's `js` bridge
 * evaluates code (`JS.eval`) and reads and writes any global, so
 * `JS.eval("globalThis.Promise = null")` broke the host's shell, and a guest
 * spinning without a syscall held the host's only thread for good. Now the
 * program reaches the facet's realm, and a call's timeout or abort ends it,
 * even in a loop that never yields.
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
    /** Wasm modules to add to the table before the call: compiled for a thread, bytes for a process to compile. */
    readonly modules: Record<string, WebAssembly.Module | ArrayBuffer>;
}
export declare function isFacetPayload(value: unknown): value is FacetPayload;
export declare function isFacetSubmit(value: unknown): value is FacetSubmit;
type WasmCompiler = (bytes: BufferSource) => Promise<WebAssembly.Module>;
/**
 * The standard `WebAssembly.compile`, checked for rather than assumed.
 *
 * `@cloudflare/workers-types` declares no compiler and an abstract `Module`,
 * which is not an oversight: workerd forbids compiling at request time, and
 * that prohibition is the entire reason facets exist. Core is typed against
 * that surface, so the one host that DOES compile asks for the capability by
 * name and says so plainly when it is absent.
 */
export declare function wasmCompiler(): WasmCompiler;
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
export {};
//# sourceMappingURL=local-facet-host.d.ts.map