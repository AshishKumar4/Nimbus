import type { NodeFilesystem } from './filesystem.js';
import type { CommandOutputStream } from '../commands/types.js';
import { type ProcessIdentity } from './process.js';
import type { LoopbackRouter, VirtualRequestHandler } from '../kernel/index.js';
import type { DNSResolver } from '../kernel/dns-resolver.js';
import { type ProgramStdio } from './tty-streams.js';
export interface NodeContext {
    filesystem: () => NodeFilesystem;
    /** The program's process: its pid and credential, and its mask's setter. */
    identity: ProcessIdentity;
    cwd: string;
    env: Record<string, string>;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    argv: string[];
    filename: string;
    dirname: string;
    signal: AbortSignal;
    /** fd 0 to its end, blocking until stdin ends (readFileSync(0)); absent, fd 0 reads as empty. */
    stdin?: () => Uint8Array;
    /** Its standard descriptors, as its process and its tty module see them (one object per program). */
    stdio: ProgramStdio;
    portRegistry?: Map<number, VirtualRequestHandler>;
    routeLoopback?: LoopbackRouter;
    /** The kernel's resolver, which dns.lookup answers from as curl and wget do. */
    dns?: DNSResolver;
    /** Told when the program first reaches the engine's stream classes (a stream module, an fs or tty stream, process.stdout). */
    reachStreams?: () => void;
}
export declare function createModuleMap(ctx: NodeContext): Record<string, () => unknown>;
export { ProcessExitError } from './process.js';
//# sourceMappingURL=index.d.ts.map