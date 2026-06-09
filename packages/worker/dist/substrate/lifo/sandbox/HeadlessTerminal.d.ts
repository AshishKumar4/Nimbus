import type { ITerminal } from '../terminal/ITerminal.js';
/**
 * A Terminal-shaped class that captures output without xterm.js.
 * Used for headless/programmatic Sandbox usage (AI agents, tests, etc.)
 */
export declare class HeadlessTerminal implements ITerminal {
    private dataCallback;
    write(_data: string): void;
    writeln(_data: string): void;
    onData(cb: (data: string) => void): void;
    get cols(): number;
    get rows(): number;
    focus(): void;
    clear(): void;
    /** Send data as if typed on keyboard (used internally for stdin) */
    sendData(data: string): void;
}
//# sourceMappingURL=HeadlessTerminal.d.ts.map