import type { NodeFilesystem } from './filesystem.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { LoopbackRouter, VirtualRequestHandler } from '../kernel/index.js';
import type { DNSResolver } from '../kernel/dns-resolver.js';
export interface NodeContext {
    filesystem: () => NodeFilesystem;
    cwd: string;
    env: Record<string, string>;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    argv: string[];
    filename: string;
    dirname: string;
    signal: AbortSignal;
    executeCapture?: (input: string) => Promise<string>;
    /** fd 0 to its end, blocking until stdin ends (readFileSync(0)); absent, fd 0 reads as empty. */
    stdin?: () => Uint8Array;
    portRegistry?: Map<number, VirtualRequestHandler>;
    routeLoopback?: LoopbackRouter;
    /** The kernel's resolver, which dns.lookup answers from as curl and wget do. */
    dns?: DNSResolver;
}
export declare function createModuleMap(ctx: NodeContext): Record<string, () => unknown>;
export { ProcessExitError } from './process.js';
//# sourceMappingURL=index.d.ts.map