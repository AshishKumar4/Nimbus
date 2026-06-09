import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/**
 * route - Show/manipulate IP routing table
 * Usage: route [-n] [add|del] [destination] [gw gateway] [dev interface]
 */
export declare function createRouteCommand(kernel: Kernel): Command;
//# sourceMappingURL=route.d.ts.map