import type { createSupervisorOpHandler } from '@nimbus-sh/core/workspace/supervisor-op.js';
export type HostNamespaceBinding = Pick<DurableObjectNamespace, 'get' | 'idFromName' | 'idFromString'>;
export type HostOpDispatch = ReturnType<typeof createSupervisorOpHandler>;
export declare function hostNamespaceBinding(env: object | null | undefined, usage: string): HostNamespaceBinding;
export declare function hostOpDispatch(stub: object, usage: string): HostOpDispatch;
//# sourceMappingURL=host-dispatch.d.ts.map