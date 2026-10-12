import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
import type { ResponseScope } from '@nimbus-sh/core/runtime/os-contracts.js';
/** A host-loss watch exists only while somebody owns work on this actor. */
export interface HostActivityLease {
    readonly ready?: Promise<void>;
    release(): void;
}
export interface HostObservation {
    acquire(signal?: AbortSignal): HostActivityLease;
    close(): void;
}
export declare const HOST_WATCH_HEADER = "x-nimbus-host-watch";
export declare const HOST_INCARNATION_HEADER = "x-nimbus-host-incarnation";
/** A data request's per-open capability; with the pinned incarnation, it admits the request at the leaf. */
export declare const HOST_REQUEST_HEADER = "x-nimbus-host-request";
export declare const HOST_WATCH_MODULE = "__nimbus_host_watch.js";
interface Observation {
    readonly open: (signal: AbortSignal) => Promise<Response>;
    readonly lost: (error: Error) => void;
    /** The host's incarnation, pinned when the process opened; a watch never changes it. */
    readonly incarnation: string | Promise<string>;
    current?: {
        abort: AbortController;
        ready: Promise<void>;
    };
    failed: Error | null;
}
export declare class HostActivity {
    private readonly observations;
    private readonly owners;
    observe(open: Observation['open'], lost: Observation['lost'], incarnation: Observation['incarnation']): HostObservation;
    acquire(signal?: AbortSignal): HostActivityLease;
    private hold;
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close(): void;
    private stop;
    private start;
    private failed;
}
/**
 * The requests a host sends a resident's leaf, by id, so it can abandon one:
 * before its response's headers as well as after. Workers RPC carries no
 * signal, and asking per request costs a round trip; abandoning is the rare
 * path, so only it sends anything (the leaf's abandonHttpRequest). Each call
 * carries the ids that ended since the last (`ended`), which the leaf then
 * forgets, and those whose abandon did not arrive (`abandoned`), which it
 * abandons and forgets; it keeps an abandon that overtakes its request until
 * its request, or its end, arrives (observeResidentConfig).
 */
export declare class SentRequests {
    #private;
    /** An id for a request with `scope`, the ids to report, and abandon(id) sent if it is not delivered. */
    send(scope: ResponseScope, abandon: (id: number) => Promise<unknown>): HostRequest;
    /** `request`'s call failed, so its leaf may not have seen what it carried: carry it again (each is idempotent there). */
    unsent(request: HostRequest): void;
}
/** A request's id, and the earlier ones its leaf forgets (`ended`) or abandons first (`abandoned`). */
export interface HostRequest {
    id: number;
    ended: number[];
    abandoned: number[];
}
export declare function hostActivity(host: object): HostActivity;
/**
 * One native fetch endpoint, outside the guest's HTTP handler, on every
 * resident class, and the admission of both data entrypoints. A watch reports
 * this instance's incarnation; a data request runs only with the per-open
 * capability and the incarnation its host pinned at open, so an instance the
 * platform put in the original's place refuses it before any guest code runs
 * (its constructor and module scope still run: no subclass precedes them).
 * The refusal carries the capability, which no guest answer can.
 */
export declare function observeResidentConfig(config: WorkerCode, capability: string): WorkerCode;
/**
 * The bytes observeResidentConfig adds to a resident's map whose main module
 * is `mainModule`: part of what the map's ceiling holds beside its own text.
 */
export declare function hostAdapterBytes(mainModule: string): number;
export {};
//# sourceMappingURL=host-activity.d.ts.map