import type { Console as EngineConsole } from 'node:console';
import type { InspectOptions } from 'node:util';
import type { CommandOutputStream } from '../commands/types.js';
export declare function createConsole(stdout: CommandOutputStream, stderr: CommandOutputStream): {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    dir: (obj: unknown, options?: InspectOptions) => void;
    time: (label?: string) => void;
    timeEnd: (label?: string) => void;
    timeLog: (label?: string, ...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    assert: (condition: unknown, ...args: unknown[]) => void;
    clear: () => void;
    count: (label?: string) => void;
    countReset: () => void;
    group: () => void;
    groupEnd: () => void;
    table: (data: unknown) => void;
    /** The engine's Console class, as Node's console has it (loaded when first reached). */
    readonly Console: typeof EngineConsole;
};
//# sourceMappingURL=console.d.ts.map