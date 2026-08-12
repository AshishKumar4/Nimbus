import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/**
 * host - DNS lookup and /etc/hosts management
 *
 * Usage:
 *   host <hostname>              - DNS lookup
 *   host list                    - List /etc/hosts entries
 *   host add <hostname> <ip>     - Add entry to /etc/hosts
 *   host remove <hostname>       - Remove entry from /etc/hosts
 *   host reload                  - Reload /etc/hosts into DNS
 */
export declare function createHostCommand(kernel: Kernel): Command;
//# sourceMappingURL=host.d.ts.map