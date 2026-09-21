import { type HostRoute } from './composition.js';
import type { SupervisorOpDispatch } from '@nimbus-sh/core/workspace/supervisor-op.js';
export type HostNamespaceBinding = Pick<DurableObjectNamespace, 'get' | 'idFromName' | 'idFromString'>;
export type HostOpDispatch = SupervisorOpDispatch;
/**
 * The host's namespace binding. An entrypoint answering a facet passes the
 * route the binding's props carry, minted in the host's isolate; the host
 * itself, and a binding minted before routes travelled (a facet outlives
 * the deploy that minted its binding), resolve from this isolate's
 * composition.
 */
export declare function hostNamespaceBinding(env: object | null | undefined, usage: string, route?: Pick<HostRoute, 'hostNamespace'>): HostNamespaceBinding;
export declare function hostOpDispatch(stub: object, usage: string, route?: Pick<HostRoute, 'hostDispatchMethod'>): HostOpDispatch;
//# sourceMappingURL=host-dispatch.d.ts.map