import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/**
 * A `wget` bound to one kernel: its loopback traffic resolves through that
 * kernel's port registry and loopback router, so two workspaces serving the
 * same numeric port answer independently.
 */
export declare function createWgetCommand(kernel: Kernel): Command;
declare const command: Command;
export default command;
//# sourceMappingURL=wget.d.ts.map