export class PipeChannel {
    buffer = [];
    closed = false;
    waiting = [];
    writer = {
        write: (text) => {
            if (this.closed)
                return;
            this.deliver(text, 'back');
        },
    };
    reader = {
        read: () => this.read(),
        readAll: () => this.readAll(),
        readLine: () => this.readLine(),
        readBytes: (maxLength) => this.readBytes(maxLength),
    };
    read() {
        if (this.buffer.length > 0) {
            return Promise.resolve(this.buffer.shift() ?? null);
        }
        if (this.closed) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            this.waiting.push(resolve);
        });
    }
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
    close() {
        this.closed = true;
        while (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve(null);
        }
    }
    deliver(text, position) {
        if (text.length === 0)
            return;
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve(text);
            return;
        }
        if (position === 'front')
            this.buffer.unshift(text);
        else
            this.buffer.push(text);
    }
}
