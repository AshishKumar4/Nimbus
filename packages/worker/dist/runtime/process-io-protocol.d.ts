import { z } from 'zod/v4';
declare const ProcessTerminalSizeSchema: any;
export declare const ProcessSignalNameSchema: any;
export type ProcessTerminalSize = z.infer<typeof ProcessTerminalSizeSchema>;
export type ProcessSignalName = z.infer<typeof ProcessSignalNameSchema>;
export declare function parseProcessPid(value: unknown): number | null;
export declare function parseProcessTerminalSize(value: unknown): ProcessTerminalSize | null;
export declare function parseProcessSignalName(value: string): ProcessSignalName | null;
export declare const ProcessLogClientFrameSchema: any;
export type ProcessLogClientFrame = z.infer<typeof ProcessLogClientFrameSchema>;
export declare function parseProcessLogClientFrame(raw: string): ProcessLogClientFrame | null;
export {};
//# sourceMappingURL=process-io-protocol.d.ts.map