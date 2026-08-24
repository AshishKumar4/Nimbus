import { encode } from '../utils/encoding.js';
/**
 * A shell pipe that carries the producer's exact bytes. Text writes are
 * encoded once at the write side, `writeBytes` stores bytes verbatim, and
 * the text view (`read`/`readAll`/`readLine`) decodes progressively so a
 * multi-byte UTF-8 sequence split across chunks survives intact.
 */
export class PipeChannel {
    buffer = [];
    closed = false;
    waiting = [];
    decoder = new TextDecoder('utf-8');
    writer = {
        write: (text) => {
            if (this.closed)
                return;
            this.deliver(encode(text), 'back');
        },
        writeBytes: (bytes) => {
            if (this.closed)
                return;
            this.deliver(bytes, 'back');
        },
    };
    reader = {
        read: () => this.read(),
        readAll: () => this.readAll(),
        readLine: () => this.readLine(),
        readBytes: (maxLength) => this.readBytes(maxLength),
    };
    /** Next queued chunk, a waiter's delivery, or null once closed and empty. */
    pull() {
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
    async read() {
        while (true) {
            const bytes = await this.pull();
            if (bytes === null) {
                const tail = this.decoder.decode();
                return tail.length > 0 ? tail : null;
            }
            const text = this.decoder.decode(bytes, { stream: true });
            if (text.length > 0)
                return text;
        }
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
        let sawAny = false;
        while (true) {
            const bytes = await this.pull();
            if (bytes === null)
                break;
            sawAny = true;
            // Split on the raw 0x0A byte so pushback returns ORIGINAL bytes; a
            // multibyte sequence straddling the chunk boundary then survives as
            // é instead of collapsing into a replacement character.
            const newline = bytes.indexOf(0x0a);
            if (newline >= 0) {
                const rest = bytes.subarray(newline + 1);
                if (rest.length > 0)
                    this.deliver(rest, 'front');
                line += this.decoder.decode(bytes.subarray(0, newline), { stream: true });
                const flushed = this.decoder.decode();
                return line + flushed;
            }
            line += this.decoder.decode(bytes, { stream: true });
        }
        // A trailing incomplete sequence still surfaces as U+FFFD at EOF.
        const tail = this.decoder.decode();
        line += tail;
        return sawAny || tail.length > 0 ? line : null;
    }
    /**
     * Bounded byte read: returns whatever the producer has already delivered,
     * capped at maxLength. maxLength bounds the result, it is never a fill
     * target — waiting to complete it would stall every consumer downstream of
     * a live open producer. A larger chunk keeps only its first maxLength
     * bytes; the remainder stays queued in original order.
     */
    async readBytes(maxLength) {
        if (maxLength <= 0)
            return new Uint8Array(0);
        const chunk = await this.pull();
        if (chunk === null)
            return null;
        if (chunk.length <= maxLength)
            return chunk;
        this.buffer.unshift(chunk.subarray(maxLength));
        return chunk.subarray(0, maxLength);
    }
    close() {
        this.closed = true;
        while (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve(null);
        }
    }
    deliver(bytes, position) {
        if (bytes.length === 0)
            return;
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve(bytes);
            return;
        }
        if (position === 'front')
            this.buffer.unshift(bytes);
        else
            this.buffer.push(bytes);
    }
}
