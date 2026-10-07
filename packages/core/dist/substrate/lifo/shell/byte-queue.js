/**
 * Byte chunks in order, with readers that wait for the next: what a shell
 * pipe (pipe.ts) and the terminal's stdin (terminal-stdin.ts) both are
 * underneath. Bytes are the storage, so a byte read always makes progress
 * (`dd bs=1` over `é` yields c3, then a9) and the text reads decode
 * progressively, a multi-byte sequence split across chunks intact.
 */
export class ByteQueue {
    consumed;
    buffer = [];
    waiting = [];
    decoder = new TextDecoder('utf-8');
    ended = false;
    /** `consumed` hears how many bytes each read takes (a pipe's capacity accounting). */
    constructor(consumed = () => { }) {
        this.consumed = consumed;
    }
    /** True when a reader is waiting for input. */
    get isWaiting() {
        return this.waiting.length > 0;
    }
    /** Queue `bytes`, handing them to a waiting reader first. */
    deliver(bytes) {
        if (bytes.length === 0)
            return;
        const waiting = this.waiting.shift();
        if (waiting)
            waiting(bytes);
        else
            this.buffer.push(bytes);
    }
    /** No more input: every waiting reader, and every later one, sees the end. */
    close() {
        this.ended = true;
        while (this.waiting.length > 0)
            this.waiting.shift()?.(null);
    }
    /** Drop what is queued and unread. */
    discard() {
        this.buffer = [];
    }
    /** Next queued chunk, a delivery waited for, or null once ended and empty. */
    pull() {
        if (this.buffer.length > 0)
            return Promise.resolve(this.buffer.shift() ?? null);
        if (this.ended)
            return Promise.resolve(null);
        return new Promise((resolve) => { this.waiting.push(resolve); });
    }
    /** The next text the input holds, or null at its end. */
    async read() {
        while (true) {
            const bytes = await this.pull();
            if (bytes === null) {
                const tail = this.decoder.decode();
                return tail.length > 0 ? tail : null;
            }
            this.consumed(bytes.length);
            const text = this.decoder.decode(bytes, { stream: true });
            if (text.length > 0)
                return text;
        }
    }
    /** Everything to the end, as text. */
    async readAll() {
        const parts = [];
        for (let chunk = await this.read(); chunk !== null; chunk = await this.read())
            parts.push(chunk);
        return parts.join('');
    }
    /**
     * The next line without its newline, or null at the end. The split is on
     * the raw 0x0A byte and what follows it is queued back as it came, so a
     * multi-byte sequence straddling the split survives.
     */
    async readLine() {
        let line = '';
        let sawAny = false;
        while (true) {
            const bytes = await this.pull();
            if (bytes === null)
                break;
            sawAny = true;
            const newline = bytes.indexOf(0x0a);
            if (newline >= 0) {
                const rest = bytes.subarray(newline + 1);
                if (rest.length > 0)
                    this.buffer.unshift(rest);
                this.consumed(newline + 1);
                line += this.decoder.decode(bytes.subarray(0, newline), { stream: true });
                return line + this.decoder.decode();
            }
            this.consumed(bytes.length);
            line += this.decoder.decode(bytes, { stream: true });
        }
        // A trailing incomplete sequence still surfaces as U+FFFD at the end.
        const tail = this.decoder.decode();
        line += tail;
        return sawAny || tail.length > 0 ? line : null;
    }
    /**
     * Bounded byte read: whatever has already arrived, capped at maxLength.
     * maxLength bounds the result and is never a fill target: waiting to
     * complete it would stall every reader downstream of a live producer. A
     * larger chunk gives its first maxLength bytes; the rest stays queued.
     */
    async readBytes(maxLength) {
        if (maxLength <= 0)
            return new Uint8Array(0);
        const chunk = await this.pull();
        if (chunk === null)
            return null;
        if (chunk.length <= maxLength) {
            this.consumed(chunk.length);
            return chunk;
        }
        this.buffer.unshift(chunk.subarray(maxLength));
        this.consumed(maxLength);
        return chunk.subarray(0, maxLength);
    }
    /** What is queued and unread, as text, without waiting: the queue is left empty. */
    drainText() {
        let text = '';
        while (this.buffer.length > 0)
            text += this.decoder.decode(this.buffer.shift(), { stream: true });
        return text + this.decoder.decode();
    }
}
