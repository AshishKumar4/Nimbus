import type { ProcessInputStore } from './process-input.js';
import type { ProcessLogClientFrame } from './process-io-protocol.js';
export interface ProcessInputHost {
    processInput: ProcessInputStore;
}
export declare function writeProcessInput(host: ProcessInputHost, pid: number, data: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function endProcessInput(host: ProcessInputHost, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function resizeProcess(host: ProcessInputHost, pid: number, columns: number, rows: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function signalProcess(host: ProcessInputHost, pid: number, signal: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function applyProcessClientFrame(host: ProcessInputHost, pid: number, frame: ProcessLogClientFrame): Promise<{
    ok: boolean;
    pid: number;
    type: ProcessLogClientFrame['type'];
}>;
//# sourceMappingURL=process-input-routing.d.ts.map