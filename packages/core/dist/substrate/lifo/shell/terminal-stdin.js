/**
 * A bridge between terminal keyboard input and command stdin.
 * The Shell feeds lines in via feed(), commands consume via read()/readAll().
 */
export class TerminalStdin {
    buffer = [];
    closed = false;
    resolvers = [];
    _rawMode = false;
    /** True when a command has called read() and is waiting for input. */
    get isWaiting() {
        return this.resolvers.length > 0;
    }
    /** When true, the shell should bypass line editing and feed raw keypresses. */
    get rawMode() {
        return this._rawMode;
    }
    set rawMode(value) {
        this._rawMode = value;
    }
    /** Shell calls this on Enter (with line + '\n'). */
    feed(text) {
        if (this.closed)
            return;
        this.deliver(text, 'back');
    }
    /** Shell calls this on Ctrl+D to signal EOF. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve(null);
        }
    }
    /** Commands consume input. Returns null on EOF. */
    async read() {
        if (this.buffer.length > 0) {
            return this.buffer.shift();
        }
        if (this.closed) {
            return null;
        }
        return new Promise((resolve) => {
            this.resolvers.push(resolve);
        });
    }
    async readLine() {
        let line = '';
        while (true) {
            const chunk = await this.read();
            if (chunk === null)
                return line.length > 0 ? line : null;
            const newline = chunk.indexOf('\n');
            if (newline >= 0) {
                const rest = chunk.slice(newline + 1);
                if (rest.length > 0)
                    this.deliver(rest, 'front');
                return line + chunk.slice(0, newline);
            }
            line += chunk;
        }
    }
    async readBytes(maxLength) {
        if (maxLength <= 0)
            return '';
        const chunk = await this.read();
        if (chunk === null)
            return null;
        if (chunk.length <= maxLength)
            return chunk;
        this.deliver(chunk.slice(maxLength), 'front');
        return chunk.slice(0, maxLength);
    }
    /** Read all remaining input until EOF, joined together. */
    async readAll() {
        const parts = [];
        while (true) {
            const chunk = await this.read();
            if (chunk === null)
                break;
            parts.push(chunk);
        }
        return parts.join('');
    }
    deliver(text, position) {
        if (text.length === 0)
            return;
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve(text);
            return;
        }
        if (position === 'front')
            this.buffer.unshift(text);
        else
            this.buffer.push(text);
    }
}
