import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
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
export declare const HOST_WATCH_MODULE = "__nimbus_host_watch.js";
interface Observation {
    readonly open: (signal: AbortSignal) => Promise<Response>;
    readonly lost: (error: Error) => void;
    incarnation?: string;
    current?: {
        abort: AbortController;
        ready: Promise<void>;
    };
    failed: Error | null;
}
export declare class HostActivity {
    private readonly observations;
    private readonly owners;
    observe(open: Observation['open'], lost: Observation['lost'], incarnation?: string): HostObservation;
    acquire(signal?: AbortSignal): HostActivityLease;
    private hold;
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close(): void;
    private stop;
    private start;
    private failed;
}
export declare function hostActivity(host: object): HostActivity;
/** Target validation and response work share one lease through native body completion. */
export declare function hostResponse(ctx: Pick<DurableObjectState, 'waitUntil'>, observation: HostObservation, request: Request, dispatch: () => Promise<Response>): Promise<Response>;
/** One native fetch endpoint, outside the guest's HTTP handler, on every resident class. */
export declare function observeResidentConfig(config: WorkerCode, capability: string): WorkerCode;
export {};
//# sourceMappingURL=host-activity.d.ts.map