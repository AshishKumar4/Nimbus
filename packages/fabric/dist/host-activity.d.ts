/** A host-loss watch exists only while somebody owns work on this actor. */
export interface HostActivityLease {
    readonly ready?: Promise<void>;
    release(): void;
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
    private owners;
    private generation;
    observe(open: Observation['open'], lost: Observation['lost']): () => void;
    acquire(): HostActivityLease;
    run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
    /** End every old lease; a reused session starts with a fresh ownership epoch. */
    close(): void;
    private stop;
    private start;
    private failed;
}
export declare function hostActivity(host: object): HostActivity;
/** One native fetch endpoint, outside the guest's HTTP handler, on every resident class. */
export declare function observeResidentConfig(config: Record<string, unknown>, capability: string): Record<string, unknown>;
export {};
//# sourceMappingURL=host-activity.d.ts.map