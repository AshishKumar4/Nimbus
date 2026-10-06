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
    bindingKind: 'process';
    writerId: string;
    /**
     * The workspace's egress (NimbusWorkspaceOptions.egress), when its host
     * supplied one: the process's network, its packument reads and its sockets
     * go out through it, from the binding (SupervisorRPC). With its id, so a
     * cache this binding fills is the egress's own.
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
/** The one mint for SUPERVISOR/outbound capabilities handed to a process. */
export declare function mintProcessSupervisor<T>(mint: (options: {
    props: SupervisorBindingProps;
}) => T, props: SupervisorBindingProps): T;
/**
 * `key`, for a loader cache entry whose worker holds a binding with `props`:
 * made specific to the host instance the binding names, since the loader
 * outlives that instance and the next one refuses every mutation the binding
 * would deliver. A binding that names none keeps `key`, and its warm worker.
 */
export declare function supervisorLoaderKey(key: string, props: Pick<SupervisorBindingProps, 'hostIncarnation'>): string;
//# sourceMappingURL=supervisor-props.d.ts.map