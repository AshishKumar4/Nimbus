import type { Command, CommandContext } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';
interface KillJob {
    id: number;
    command: string;
    pid?: number;
}
export declare function runKill(ctx: Pick<CommandContext, 'args' | 'stdout' | 'stderr'>, processes: ProcessRegistry, jobs: readonly KillJob[]): Promise<number>;
export declare function createKillCommand(processes: ProcessRegistry): Command;
export {};
//# sourceMappingURL=kill.d.ts.map