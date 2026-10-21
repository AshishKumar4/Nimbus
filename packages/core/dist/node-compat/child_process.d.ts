/**
 * Node's `child_process`, written once over a start face (Kinu ask 67):
 * each child is a program started by its argv (NodeStart, ExecDelegate's
 * start contract), its input a byte stream with backpressure, its output
 * read as its reader takes it, its end waitpid's. `exec` starts `/bin/sh -c`
 * its line, as Node's does. With no start face (lifo's node, until its realm
 * can wait) every start is refused ENOSYS, as a spawn the system cannot make.
 * The synchronous forms cannot wait for a child and refuse
 * (ERR_NIMBUS_SYNC_CHILD_PROCESS, the hosted node's code and reason).
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { PassThrough, Writable } from 'node:stream';
import type { StartedProgram } from '../runtime/program-start.js';
import type { NodeStart } from './faces.js';
type Stdio = 'pipe' | 'ignore' | 'inherit';
export interface SpawnOptions {
    cwd?: string | URL;
    env?: Record<string, string | undefined>;
    stdio?: Stdio | readonly (Stdio | null | undefined)[];
    /** `exec`'s shell (true: `/bin/sh`), or none. */
    shell?: boolean | string;
    timeout?: number;
    killSignal?: string | number;
    signal?: AbortSignal;
    argv0?: string;
    detached?: boolean;
    windowsHide?: boolean;
}
export interface ExecOptions extends SpawnOptions {
    encoding?: string | null;
    maxBuffer?: number;
}
type Output = string | Buffer;
type ExecCallback = (error: Error | null, stdout: Output, stderr: Output) => void;
/** Node's ChildProcess, over a started program. */
export declare class ChildProcess extends EventEmitter {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    connected: boolean;
    spawnfile: string;
    spawnargs: string[];
    stdin: Writable | null;
    stdout: PassThrough | null;
    stderr: PassThrough | null;
    stdio: [Writable | null, PassThrough | null, PassThrough | null];
    /** The program once it runs; a kill sent before then waits for it. */
    private started;
    private pendingKill;
    /** Aborted by its AbortSignal: its 'error' was the AbortError, and a start that answers cancelled says nothing more. */
    private aborted;
    private exited;
    private closed;
    private outputsOpen;
    /**
     * kill(2): `signal` to the child, true if it may be sent; false once it
     * has ended. 0 sends nothing: it says the child is there (and, as Node's,
     * marks it `killed`).
     */
    kill(signal?: string | number): boolean;
    /** What an AbortSignal's abort makes of it (Node's abortChildProcess): killed, and the AbortError its 'error' event carries. */
    abort(killSignal: string | number | undefined, reason: unknown): void;
    ref(): this;
    unref(): this;
    /** Begins it: `start`'s answer, its output into its streams, its end. */
    run(start: Promise<StartedProgram & {
        readonly pid?: number;
    }>): void;
    /** Its outputs open: what close waits for besides its exit. */
    openOutputs(count: number): void;
    /** One of its outputs has ended. */
    outputEnded(): void;
    /**
     * Its output, each chunk into its stream (waiting while that stream is
     * full), each ended at its end. Output not piped (ignored, or inherited:
     * this process shares no descriptors with it) is read and let go.
     */
    private relay;
    /**
     * Its end, waitpid's: 'exit', then 'close' once its outputs have ended.
     * An output no one reads is read off and let go, as Node's flushStdio
     * does, so it ends.
     */
    private end;
    /** A start refused (or an end not learned): the 'error' event, then 'close' with the negative errno, as Node's failed spawn. */
    private fail;
    private maybeClose;
}
export interface ChildProcessOptions {
    /** Relative cwds are taken from it, and a child given none runs in it. */
    cwd: string;
}
/** Node's `child_process` over `start` (none: every start refused ENOSYS). */
export declare function createNodeChildProcess(start: NodeStart | undefined, { cwd }: ChildProcessOptions): {
    ChildProcess: typeof ChildProcess;
    spawn: (file: string, args?: readonly string[] | SpawnOptions | null, options?: SpawnOptions) => ChildProcess;
    exec: (command: string, options?: ExecOptions | ExecCallback | null | undefined, callback?: ExecCallback | undefined) => ChildProcess;
    execFile: (file: string, args?: readonly string[] | ExecOptions | ExecCallback | null, options?: ExecOptions | ExecCallback | null, callback?: ExecCallback) => ChildProcess;
    fork: (modulePath: string) => never;
    execSync: (command: string) => never;
    execFileSync: (file: string, args?: readonly string[]) => never;
    spawnSync: (file: string, args?: readonly string[]) => never;
};
export {};
//# sourceMappingURL=child_process.d.ts.map