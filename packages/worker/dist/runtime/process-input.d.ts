import type { ProcessSignalName } from './process-io-protocol.js';
export interface ProcessInputPacket {
    data: string;
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
    write(pid: number, data: string): {
        ok: boolean;
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
    end(pid: number): void;
    close(pid: number): void;
    read(pid: number, waitMs?: number): Promise<ProcessInputPacket>;
}
//# sourceMappingURL=process-input.d.ts.map