/**
 * process-input-routing.ts — the single zod-validated protocol path for
 * process-terminal client frames (`input` / `stdin-end` / `resize` /
 * `signal`). Both WebSocket surfaces (the `/api/logs/<pid>` upgrade
 * handler and the hibernatable `webSocketMessage` dispatcher) and the
 * programmatic SDK RPCs route through these helpers.
 */
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import type { ProcessLogClientFrame } from './process-io-protocol.js';
/** The slice of the process supervisor the frame router drives. */
export type ProcessInputController = Pick<SessionProcessSupervisor, 'writeInput' | 'endInput' | 'resize' | 'signal'>;
export declare function writeProcessInput(processes: ProcessInputController, pid: number, data: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function endProcessInput(processes: ProcessInputController, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function resizeProcess(processes: ProcessInputController, pid: number, columns: number, rows: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function signalProcess(processes: ProcessInputController, pid: number, signal: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function applyProcessClientFrame(processes: ProcessInputController, pid: number, frame: ProcessLogClientFrame): Promise<{
    ok: boolean;
    pid: number;
    type: ProcessLogClientFrame['type'];
}>;
//# sourceMappingURL=process-input-routing.d.ts.map