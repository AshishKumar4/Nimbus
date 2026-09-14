/**
 * session/serving-port.ts — how a process that serves a port is registered.
 *
 * One path for every serving pid, whether the facet manager launched it (a
 * node/runtime resident with a journal row) or the session runs it in
 * process (the Cirrus Vite shim, real-vite, `vite preview`, a builtin that
 * adopted a shell wrapper pid). The manager's registration stamps the
 * journal row when there is one, reads the process table's identity when
 * there is not, and re-adopts a reservation the identity owns instead of
 * retiring its capability — which is what lets a dev server exposed under a
 * name come back on the same shared link after a restart or a hibernation.
 *
 * The bare registration below is only for a session that has no manager at
 * all; every DO route that serves a port stands one up first.
 */
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { type PortCapabilityHost } from './port-capability.js';
export interface ServingPortHost {
    ctx: PortCapabilityHost['ctx'];
    portRegistry: PortRegistry;
    facetManager: {
        registerPort(pid: number, port: number): Promise<void>;
    } | null;
    ensureFacetManager?(): void;
}
export declare function registerServingPort(self: ServingPortHost, pid: number, port: number): Promise<void>;
//# sourceMappingURL=serving-port.d.ts.map