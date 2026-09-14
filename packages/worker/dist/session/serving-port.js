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
import { clearPortCapability } from './port-capability.js';
export async function registerServingPort(self, pid, port) {
    self.ensureFacetManager?.();
    if (self.facetManager) {
        await self.facetManager.registerPort(pid, port);
        return;
    }
    // No manager means nothing resident is running — a bare registration
    // retires the previous occupant's preview capability.
    await clearPortCapability(self, port);
    self.portRegistry.register(port, pid);
}
