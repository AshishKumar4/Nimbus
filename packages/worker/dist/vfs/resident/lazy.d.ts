/**
 * A namespace listed on demand, for a process whose calls can wait (a WASI
 * guest, parked under JSPI): it starts with no names at the authority's
 * cursor and lists a directory the first time a lookup needs one of its
 * entries (namespace.ts), and its barrier starts it again from nothing when an
 * answer cannot be applied. `namespaceView` is the store as the WASI
 * filesystem adapter reads it.
 */
import type { ResidentNamespace } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
import type { Admission } from './admission.js';
import type { Cells } from './cells.js';
import type { Coherence } from './coherence.js';
import { type Namespace } from './namespace.js';
import type { ResidentCred } from './permissions.js';
import type { ResidentSupervisor } from './supervisor.js';
import type { Sync } from './sync.js';
import type { Transport } from './transport.js';
export interface Lazy {
    bootLazy(supervisor: ResidentSupervisor | null | undefined): Promise<boolean>;
    namespaceView(supervisor: ResidentSupervisor, device: number, cred: ResidentCred): ResidentNamespace;
}
export declare function createLazy(coherence: Coherence, admission: Admission, namespace: Namespace, cells: Cells, transport: Transport, sync: Sync): Lazy;
//# sourceMappingURL=lazy.d.ts.map