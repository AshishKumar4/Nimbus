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
 * Whether a request's caller left it, asked by its handler on another actor:
 * true once the caller has left the response, false once it is done with it.
 * Minted with the request and passed beside it (a function crosses Workers
 * RPC as a stub, a signal does not), so the handler hears a caller that
 * leaves before any header as well as after one.
 */
export type CallerLeft = () => Promise<boolean>;
/** The caller of a request with `scope`, for its handler on another actor. */
export declare function callerLeft(scope: ResponseScope): CallerLeft;
/**
 * The handler's side: the scope of a request whose caller is on another
 * actor. Only that caller sees whether the response was delivered, so the
 * scope ends as the caller answers: settled when it was, aborted when it left
 * or can no longer be asked (its actor is gone), or aborted here first
 * (`fail`) when the relay to it fails. A stub received as a call's argument
 * is the call's; its `dup` is held until the answer.
 */
export declare function callerScope(left: CallerLeft): {
    scope: ResponseScope;
    fail(reason?: unknown): void;
};
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