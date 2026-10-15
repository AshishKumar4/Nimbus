import type { CommandContext } from '../substrate/lifo/commands/types.js';
import type { NimbusFilesystemAuthority } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
/** A runtime's fd0/1/2, on the process supervisor's existing byte channels. */
export declare function openRuntimeStdio(deps: {
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
}, ctx: CommandContext, command: string, { consumedStdin }?: {
    consumedStdin?: boolean | undefined;
}): {
    pid: number;
    signal: AbortSignal;
    syscalls: {
        pid: number;
        vfs: import("./os-contracts.js").RuntimeFsBridge;
        processes: SessionProcessSupervisor;
    };
    finish(exitCode: number): Promise<void>;
};
/** A runtime's byte callback into the command's outputs, and `end`, which ends their decoding once the runtime is done. */
export declare function runtimeOutput(ctx: Pick<CommandContext, 'stdout' | 'stderr'>): {
    write(stream: 'stdout' | 'stderr', bytes: Uint8Array): Promise<void>;
    end(): Promise<void>;
};
//# sourceMappingURL=runtime-stdio.d.ts.map