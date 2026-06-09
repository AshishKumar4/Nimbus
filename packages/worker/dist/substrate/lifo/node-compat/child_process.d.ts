import { EventEmitter } from './events.js';
type ExecuteCapture = (input: string) => Promise<string>;
export declare function createChildProcess(executeCapture?: ExecuteCapture): {
    exec: (cmd: string, optionsOrCb?: Record<string, unknown> | ((err: Error | null, stdout: string, stderr: string) => void), cb?: (err: Error | null, stdout: string, stderr: string) => void) => EventEmitter;
    execSync: () => never;
    spawn: () => never;
    fork: () => never;
};
export {};
//# sourceMappingURL=child_process.d.ts.map