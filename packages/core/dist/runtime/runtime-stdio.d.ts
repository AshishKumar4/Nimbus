import type { CommandContext, CommandInputStream } from '../substrate/lifo/commands/types.js';
import type { NimbusFilesystemAuthority, VfsCred } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import { type ProcessSignalName } from './process-io-protocol.js';
/** The signals a WASI image that takes its own is sent (NIMBUS_SIGNAL_ERRNOS). */
export declare const DELIVERED_SIGNALS: readonly ProcessSignalName[];
/** What one run of a runtime is: its process, and what its fd0/1/2 read and write. */
export interface InvocationStdioSpec {
    /** Its process, when one was made for it (a broker's); absent, the run makes its own, a child of `parentPid`. */
    readonly existingPid: number | undefined;
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly parentPid: number | undefined;
    readonly cred: VfsCred;
    /**
     * The caller's: its abort ends the run, as a kill of its process does; or,
     * for a program that takes its own signals (`takesSignals`), sends it and
     * the processes below it the abort's signal, as a terminal's key does its
     * foreground job's process group, and the run goes on until it ends.
     */
    readonly signal: AbortSignal | undefined;
    /** Its program takes its own signals (SessionProcessSupervisor.takeSignals): its image delivers what it is sent (NIMBUS_ESIGNAL). */
    readonly takesSignals?: boolean;
    /** What fd 0 reads, pumped in; null when it reads nothing of the caller's (a broker's input, or stdin already read). */
    readonly input: Pick<CommandInputStream, 'read' | 'readBytes'> | null;
    /** Where fd 1 and 2 go; null when a broker routes them. */
    readonly output: ((stream: 'stdout' | 'stderr', bytes: Uint8Array) => void | Promise<void>) | null;
}
/**
 * A run's fd0/1/2, on the process supervisor's byte channels: its process
 * (made, or the broker's), the signal that ends it, its input pumped (fd 0
 * at EOF when nothing is) and its output delivered. `release` stops them as
 * the run ends; ending an owned process is the runner's, once it has said
 * what it has to.
 */
export declare function openInvocationStdio(processes: SessionProcessSupervisor, spec: InvocationStdioSpec): {
    pid: number;
    owned: boolean;
    cred: VfsCred;
    signal: AbortSignal;
    release(): void;
};
/** A runtime's fd0/1/2 for a command's run (openInvocationStdio over its CommandContext). */
export declare function openRuntimeStdio(deps: {
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
}, ctx: CommandContext, command: string, { consumedStdin, takesSignals }?: {
    consumedStdin?: boolean | undefined;
    takesSignals?: boolean | undefined;
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