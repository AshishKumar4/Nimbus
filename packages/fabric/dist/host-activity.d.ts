import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
/** A host-loss watch exists only while somebody owns work on this actor. */
export interface HostActivityLease {
    readonly ready?: Promise<void>;
    release(): void;
}
export interface HostObservation {
    acquire(signal?: AbortSignal): HostActivityLease;
    /** A watch on the host is open now and found the pinned incarnation. */
    validated(): boolean;
    close(): void;
}
export declare const HOST_WATCH_HEADER = "x-nimbus-host-watch";
export declare const HOST_INCARNATION_HEADER = "x-nimbus-host-incarnation";
/** A data request's per-open capability; with the pinned incarnation, it admits the request at the leaf. */
export declare const HOST_REQUEST_HEADER = "x-nimbus-host-request";
/** On a leaf's 500, its capability: the guest's handler failed, and the call arrived. */
export declare const HOST_FAILED_HEADER = "x-nimbus-host-failed";
export declare const HOST_WATCH_MODULE = "__nimbus_host_watch.js";
interface Observation {
    readonly open: (signal: AbortSignal) => Promise<Response>;
    readonly lost: (error: Error) => void;
    /** The host's incarnation, pinned when the process opened; a watch never changes it. */
    readonly incarnation: string | Promise<string>;
    current?: {
        abort: AbortController;
        ready: Promise<void>;
        validated?: true;
    };
    failed: Error | null;
}
export declare class HostActivity {
    private readonly observations;
    private readonly owners;
    observe(open: Observation['open'], lost: Observation['lost'], incarnation: Observation['incarnation']): HostObservation;
    acquire(signal?: AbortSignal): HostActivityLease;
    private hold;
    /** `lease` let go: the last one stops the host's observations. */
    released(lease: Lease): boolean;
    /** `dependency`'s validation, for a holder that waits on it. */
    validation(dependency: Observation): Promise<void>;
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close(): void;
    private stop;
    private start;
    private failed;
}
/**
 * The requests a coordinator sends the peer hosting a process, by id, so it
 * can abandon one: before its response's headers as well as after. Workers
 * RPC carries no signal, and asking per request costs a round trip;
 * abandoning is the rare path, so only it sends anything (the peer's
 * abandonHostedHttp). Each call carries `low`, below which every id is
 * retired (delivered, or abandoned where the peer heard it), so the peer
 * forgets them; and, only when there are any, the ids whose abandon did not
 * arrive (`abandoned`), which the peer abandons first (HandledRequests).
 */
export declare class SentRequests {
    #private;
    /** An id for a request, the watermark below which its leaf forgets, and any abandons it must carry. */
    send(): HostRequest;
    /**
     * Request `id` ended: retired when delivered, else once its abandon
     * arrived. A retirement that overtook the abandon would let the leaf forget
     * it unabandoned; an abandon that does not arrive rides the next request.
     */
    settled(id: number, delivered: boolean, abandon: (id: number) => Promise<unknown>): void;
    /** `request`'s peer answered: the abandons it carried arrived. */
    received(request: HostRequest): void;
    /** `request`'s call failed before its peer saw it (leafReceived): its abandons ride the next one. */
    unsent(request: HostRequest): void;
}
/**
 * The receiving end of SentRequests: one AbortController per request its
 * sender may still abandon, aborted when that abandon arrives, whether before
 * the request (kept until it comes) or after. Ids below the sender's `low`
 * are forgotten; an id already retired when its request arrives gets a
 * signal no abandon will reach.
 */
export declare class HandledRequests {
    #private;
    /** The signal request `request.id` runs under, once the abandons it carried are applied. */
    signal(request: HostRequest): AbortSignal;
    /** Its sender abandoned request `id`. */
    abandon(id: number): void;
}
/**
 * The property a host sets on a guest failure its leaf answered: the call
 * arrived, and what it carried was seen; any other failure may not have
 * reached the leaf. It crosses only Nimbus's own RPC (a peer to its
 * coordinator), which composeFabric holds to enhanced_error_serialization.
 */
export declare const LEAF_RECEIVED = "nimbusLeafReceived";
export declare function leafReceived(error: unknown): boolean;
export declare function receivedFailure(failure: Error): Error;
/** A request's id, the watermark below which its leaf forgets (`low`), and the ids it abandons first, only when there are any. */
export interface HostRequest {
    id: number;
    low: number;
    abandoned?: number[];
}
/**
 * One holder's claim on a host's activity: an object of its own rather than a
 * set of closures, since every routed request takes one. Its validation
 * promise is made only for a holder that reads `ready`; a request never does.
 */
declare class Lease implements HostActivityLease {
    #private;
    private readonly activity;
    private readonly signal;
    private readonly dependency;
    constructor(activity: HostActivity, signal: AbortSignal | undefined, dependency: Observation | undefined);
    get ready(): Promise<void> | undefined;
    release(): void;
    /** The signal aborted. */
    handleEvent(): void;
    /** Ended without being released by its holder (HostActivity.close), or as it is released. */
    cancel(): void;
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