/**
 * A terminal with no screen, for a shell nobody watches (programmatic and
 * agent sessions, tests): what the shell writes to it is dropped, by
 * contract (a command's output reaches its caller through Shell.execute's
 * capture, not the terminal), and sendData types into the shell.
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
        return this.dataCallback?.(data);
    }
}
