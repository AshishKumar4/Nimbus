import type { VFS } from '../kernel/vfs/index.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { LoopbackRouter, VirtualRequestHandler } from '../kernel/index.js';
export interface NodeContext {
    vfs: VFS;
    cwd: string;
    env: Record<string, string>;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    argv: string[];
    filename: string;
    dirname: string;
    signal: AbortSignal;
    executeCapture?: (input: string) => Promise<string>;
    portRegistry?: Map<number, VirtualRequestHandler>;
    routeLoopback?: LoopbackRouter;
}
export declare function createModuleMap(ctx: NodeContext): Record<string, () => unknown>;
export { ProcessExitError } from './process.js';
//# sourceMappingURL=index.d.ts.map