import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';
/**
 * ip - Modern Linux network configuration tool
 *
 * Subcommands:
 *   ip link       - Manage network interfaces
 *   ip addr       - Manage IP addresses
 *   ip route      - Manage routing table
 *   ip tunnel     - Manage tunnels
 *   ip netns      - Manage network namespaces
 */
export declare function createIPCommand(kernel: Kernel): Command;
//# sourceMappingURL=ip.d.ts.map