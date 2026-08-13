/**
 * vfs-supervisor.ts — the session's syscall capability, served in place.
 *
 * The WASI layer treats its seed as a CACHE over the session filesystem and
 * reaches the real thing through a {@link WasiSupervisorStub}. In a Durable
 * Object that stub is an RPC handle minted for a pid, because the facet is a
 * different isolate; in the caller's own isolate the filesystem is right here
 * and the credential is already on the view.
 *
 * The methods are `async` because the shim's contract is, not because anything
 * here waits. That is what makes this usable on a host with no JSPI: every
 * mutation is queued and drained OUTSIDE the guest (`__wasiDrainPersist`, which
 * a runner awaits after the program returns), so a promise there costs nothing.
 * A READ is different — its promise would have to suspend the guest mid-syscall
 * — which is why a host without parking must seed the filesystem completely and
 * never reach the read paths at all. See FacetHost.parking.
 */
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import type { WasiSupervisorStub } from './wasi/types.js';
/** Serve the WASI syscall surface directly from `vfs`, as its own credential. */
export declare function vfsSupervisor(vfs: CredentialedVfs): WasiSupervisorStub;
//# sourceMappingURL=vfs-supervisor.d.ts.map