/**
 * The store as a process's filesystem adapter reads it (core
 * runtime/wasi/resident-filesystem.ts, ResidentNamespace), for both kinds of
 * namespace a store holds:
 *
 * - **Listed on demand** (a WASI guest, parked under JSPI): it starts with no
 *   names at the authority's cursor and lists a directory the first time a
 *   lookup needs one of its entries (namespace.ts). A barrier that cannot be
 *   applied starts it again from nothing.
 * - **Enumerated** (node, eagerly booted from its data plan): every name the
 *   launch listed, absent below a directory unless a mount left it unlisted.
 *   A barrier that cannot be applied is repaired: from the durable floor, or
 *   by listing again (sync.synchronize). What a delta drops that the store
 *   held is fetched again before the barrier lands, so a synchronous read
 *   right after it finds the new bytes, not a miss.
 *
 * One barrier for both: it asks (or takes the answer a delivery carried),
 * applies, and differs only in how it repairs what it could not apply.
 */
import type { RuntimeVfsStat } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ResidentNamespace } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
import type { Admission } from './admission.js';
import type { Cells } from './cells.js';
import type { Coherence } from './coherence.js';
import { type Namespace } from './namespace.js';
import type { Pages } from './pages.js';
import { type ResidentCred } from './permissions.js';
import type { ResidentSupervisor } from './supervisor.js';
import type { Sync } from './sync.js';
import type { Transport } from './transport.js';
export interface View {
    bootLazy(supervisor: ResidentSupervisor | null | undefined): Promise<boolean>;
    namespaceView(supervisor: ResidentSupervisor, root: RuntimeVfsStat, cred: ResidentCred): ResidentNamespace;
}
export declare function createView(coherence: Coherence, admission: Admission, namespace: Namespace, cells: Cells, transport: Transport, sync: Sync, pages: Pages): View;
//# sourceMappingURL=view.d.ts.map