import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/** A `dig` bound to one kernel: its query goes through that workspace's network. */
export declare function createDigCommand(kernel: Kernel): Command;
declare const command: Command;
export default command;
//# sourceMappingURL=dig.d.ts.map