import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/** A `ping` bound to one kernel: its probes go through that workspace's network. */
export declare function createPingCommand(kernel: Kernel): Command;
declare const command: Command;
export default command;
//# sourceMappingURL=ping.d.ts.map