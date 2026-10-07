import type { ITerminal } from '../terminal/ITerminal.js';
/**
 * A terminal with no screen, for a shell nobody watches (programmatic and
 * agent sessions, tests): what the shell writes to it is dropped, by
 * contract (a command's output reaches its caller through Shell.execute's
 * capture, not the terminal), and sendData types into the shell.
 */
export declare class HeadlessTerminal implements ITerminal {
    private dataCallback;
    write(_data: string): void;
    writeln(_data: string): void;
    onData(cb: (data: string) => void | Promise<void>): void;
    get cols(): number;
    get rows(): number;
    focus(): void;
    clear(): void;
    /** Send data as if typed on keyboard (used internally for stdin) */
    sendData(data: string): void | Promise<void>;
}
//# sourceMappingURL=HeadlessTerminal.d.ts.map