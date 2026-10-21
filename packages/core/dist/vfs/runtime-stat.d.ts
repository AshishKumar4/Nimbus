import type { RuntimeVfsStat } from '../runtime/os-contracts.js';
import { type VfsStat } from './vfs.js';
/**
 * A namespace entry's stat in the runtime contract's shape: its identity
 * (dev, ino) is the namespace's, and a mounted backend's entries carry no
 * SQLite revision.
 */
export declare function runtimeStatOf(stat: VfsStat): RuntimeVfsStat;
//# sourceMappingURL=runtime-stat.d.ts.map