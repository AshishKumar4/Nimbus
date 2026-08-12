/**
 * A Terminal-shaped class that captures output without xterm.js.
 * Used for headless/programmatic Sandbox usage (AI agents, tests, etc.)
 */
export class HeadlessTerminal {
    dataCallback = null;
    write(_data) {
        // Headless mode: discard visual output
    }
    writeln(_data) {
        // Headless mode: discard visual output
    }
    onData(cb) {
        this.dataCallback = cb;
    }
    get cols() {
        return 80;
    }
    get rows() {
        return 24;
    }
    focus() { }
    clear() { }
    /** Send data as if typed on keyboard (used internally for stdin) */
    sendData(data) {
        this.dataCallback?.(data);
    }
}
