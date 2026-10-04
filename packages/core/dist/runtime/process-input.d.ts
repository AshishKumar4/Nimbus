import type { ProcessSignalName } from './process-io-protocol.js';
export interface ProcessInputPacket {
    /** Typed text (a terminal's keystrokes), or bytes (a pipe or redirect). */
    data: string | Uint8Array;
    ended: boolean;
    resize?: {
        columns: number;
        rows: number;
    };
    signal?: ProcessSignalName;
}
export interface ProcessInputStoreOptions {
    maxQueuedBytes?: number;
}
export declare class ProcessInputStore {
    private readonly maxQueuedBytes;
    private pids;
    constructor(options?: ProcessInputStoreOptions);
    private createState;
    open(pid: number): void;
    has(pid: number): boolean;
    /** Whether the process behind `pid` has started reading its input channel. */
    hasReader(pid: number): boolean;
    write(pid: number, data: string): {
        ok: boolean;
    };
    /**
     * Queue bytes exactly as given: a pipe or redirect, which need not be text.
     * Refused for room, it says \`full\`: its writer waits and writes again.
     */
    writeBytes(pid: number, data: Uint8Array): {
        ok: boolean;
        full?: boolean;
    };
    resize(pid: number, columns: number, rows: number): {
        ok: boolean;
    };
    signal(pid: number, signal: ProcessSignalName): {
        ok: boolean;
    };
    terminalSize(pid: number): {
        columns: number;
        rows: number;
    } | null;
    private enqueue;
    /**
     * Resolves once `pid`'s reader has taken queued input, so a writer refused
     * for a full queue can try again: true then, false if the channel is ended
     * or gone and will take no more.
     */
    whenWritable(pid: number): Promise<boolean>;
    /**
     * Put input a reader took back in front of the queue, as it was: a process
     * that stopped before using it, run again (worker runtime/stop-replay.ts).
     * Past the queue's bound if need be, and after the channel ended too: the
     * writer wrote it within both.
     */
    unread(pid: number, packets: readonly ProcessInputPacket[]): void;
    end(pid: number): void;
    close(pid: number): void;
    read(pid: number, waitMs?: number): Promise<ProcessInputPacket>;
}
//# sourceMappingURL=process-input.d.ts.map