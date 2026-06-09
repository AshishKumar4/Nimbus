import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/**
 * forward - Forward a virtual port to the host browser
 * Usage: forward <port>
 * Example: forward 3000
 */
export declare function createForwardCommand(kernel: Kernel): Command;
/**
 * unforward - Stop forwarding a virtual port
 * Usage: unforward <port>
 */
export declare function createUnforwardCommand(kernel: Kernel): Command;
//# sourceMappingURL=forward.d.ts.map