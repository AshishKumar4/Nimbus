/**
 * supervisor-props.ts — what every SUPERVISOR binding a Durable Object mints
 * for a process carries, and the one rule for naming the instance in it.
 *
 * A binding names its host INSTANCE (`hostIncarnation`) exactly when a
 * mutation sent through it can be delivered once
 * (@nimbus-sh/core/workspace/supervisor-delivery.js): the host opened a
 * delivery store, the binding acts as a real process (SupervisorRPC refuses
 * every filesystem mutation of pid 0), and it routes back to this very
 * object rather than another (a fanout pool writes to its coordinator).
 * Minting every binding here is what keeps a new mint site from forgetting
 * that, which would fail silently: its mutations would simply never be
 * re-sent.
 */
import { type HostRoute } from './composition.js';
import type { WorkspaceEgress, WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
/** The props every SUPERVISOR binding for a process carries. */
export interface SupervisorBindingProps {
    /** The Durable Object the binding's calls reach. */
    doId: string;
    /** The process the calls act as; 0 is none, and can mutate nothing. */
    pid: number;
    /** The way back, minted with the binding in the host's isolate. */
    route?: HostRoute;
    /** The host instance that applies this binding's mutations once, when there is one. */
    hostIncarnation?: string;
    /** A write-wave epoch that host minted with the binding, and when (supervisorDeliveryProps). */
    waveWriter?: string;
    waveWriterMintedAt?: number;
    bindingKind: 'process';
    writerId: string;
    /**
     * The process's egress (NimbusWorkspaceOptions.egressFor, else .egress),
     * when its host supplied one: the process's network, its packument reads
     * and its sockets go out through it, from the binding (SupervisorRPC).
     * With its id, so a cache this binding fills is the egress's own.
     */
    egress?: WorkspaceEgress;
    networkId?: string;
}
/**
 * The props of a SUPERVISOR binding minted in the Durable Object whose state
 * is `ctx`, for process `pid`, reaching `options.doId` (this object by
 * default) by `options.route` (this isolate's composition by default).
 */
export declare function supervisorBindingProps(ctx: {
    readonly id: {
        toString(): string;
    };
}, pid: number, 
/**
 * `network` is the workspace's (`workspace.network`), required so that no
 * mint site can hand a process a binding that bypasses its egress; a
 * binding no workspace's work goes through passes ISOLATE_NETWORK.
 */
options: {
    writerId: string;
    network: WorkspaceNetwork;
    doId?: string;
    route?: HostRoute;
}): SupervisorBindingProps;
/**
 * `config` with a process's network: its egress (SupervisorBindingProps.egress)
 * as its globalOutbound when the config names none. A process inherits its
 * workspace's network, and so does a Worker it loads; an explicit one (a
 * binding that mediates, or null that denies) stands. Every config a
 * process's worker is loaded from goes through here: resident, one-shot,
 * staged, and nested (env.LOADER).
 */
export declare function workspaceOutbound<C extends object>(config: C, network: Pick<SupervisorBindingProps, 'egress'>): C;
/**
 * What tells a process its network goes through an egress (`NIMBUS_EGRESS`):
 * its node:tls goes to the egress's connectTls, or refuses by name.
 */
export declare function egressMarker(network: Pick<SupervisorBindingProps, 'egress'>): {
    NIMBUS_EGRESS?: true;
};
/**
 * The props of a SUPERVISOR binding no run acts through: a host's own work,
 * never a process's. It acts as `pid` (0 is none) for authority, but nothing
 * read through it is an observation of that process's run (stop/replay).
 * Minted in the Durable Object whose state is `ctx`, reaching `options.doId`
 * (this object by default) by `options.route`, on `options.network`.
 */
export declare function infrastructureSupervisorProps(ctx: {
    readonly id: {
        toString(): string;
    };
}, pid: number, options: {
    doId?: string;
    route?: HostRoute;
    network: WorkspaceNetwork;
}): {
    hostIncarnation?: string;
    waveWriter?: string;
    waveWriterMintedAt?: number;
    egress?: undefined;
    networkId?: undefined;
    doId: string;
    pid: number;
    route: HostRoute | undefined;
    bindingKind: 'infrastructure';
} | {
    hostIncarnation?: string;
    waveWriter?: string;
    waveWriterMintedAt?: number;
    egress: WorkspaceEgress;
    networkId: string;
    doId: string;
    pid: number;
    route: HostRoute | undefined;
    bindingKind: 'infrastructure';
};
/** What infrastructureSupervisorProps mints: a binding no run acts through. */
export type InfrastructureSupervisorProps = ReturnType<typeof infrastructureSupervisorProps>;
/** The one mint for SUPERVISOR/outbound capabilities handed to a process. */
export declare function mintProcessSupervisor<T>(mint: (options: {
    props: SupervisorBindingProps;
}) => T, props: SupervisorBindingProps): T;
/**
 * A process's SUPERVISOR as its binding, minted through the composed
 * entrypoint: a resident's, a run's network (its globalOutbound), a staged
 * run's (minted in its stateless hop, from that isolate's `exports`), and what
 * a host that answers none in-process hands its one-shots (Supervise). Each
 * call on it is a request to the host.
 */
export declare function bindingSupervisor(props: SupervisorBindingProps, exports?: unknown): object;
/** A binding no run acts through (infrastructureSupervisorProps), minted as bindingSupervisor mints a process's. */
export declare function infrastructureSupervisor(props: InfrastructureSupervisorProps, exports?: unknown): object;
/**
 * `key`, for a loader cache entry whose worker holds a binding with `props`:
 * made specific to the host instance the binding names, since the loader
 * outlives that instance and the next one refuses every mutation the binding
 * would deliver. A binding that names none keeps `key`, and its warm worker.
 */
export declare function supervisorLoaderKey(key: string, props: Pick<SupervisorBindingProps, 'hostIncarnation'>): string;
//# sourceMappingURL=supervisor-props.d.ts.map