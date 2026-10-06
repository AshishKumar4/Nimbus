import { REPLAY_FETCH_MAX_BYTES } from './stop-replay-contracts.js';
import { OwnedPieces } from './stop-replay-host.js';
/** Bounded recording and incremental digest; never delay response headers. */
export class ReplayBodyRecord {
    pieces = new OwnedPieces();
    a = 0x811c9dc5;
    b = 0x050c5d1f;
    chunks = [];
    over = false;
    add(bytes) {
        if (this.over)
            return;
        if (this.pieces.bytes + bytes.byteLength > REPLAY_FETCH_MAX_BYTES) {
            this.over = true;
            this.pieces = new OwnedPieces();
            return;
        }
        for (const byte of bytes) {
            this.a = Math.imul(this.a ^ byte, 16777619) >>> 0;
            this.b = Math.imul(this.b ^ (byte + 0x9e), 2246822519) >>> 0;
        }
        this.pieces.add(bytes);
        this.chunks.push(bytes.byteLength);
    }
    finish() {
        if (this.over)
            return { tooLarge: true };
        const body = new Uint8Array(this.pieces.bytes);
        let at = 0;
        for (const piece of this.pieces.finish()) {
            body.set(piece, at);
            at += piece.length;
        }
        return { body, chunks: this.chunks, digest: this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0') };
    }
}
/** The same error shape is delivered live and on replay, including its cause. */
export function recordFailure(error) {
    const e = error instanceof Error ? error : new Error(String(error));
    const properties = Object.fromEntries(Object.getOwnPropertyNames(e)
        .filter((key) => !['name', 'message', 'stack', 'cause'].includes(key))
        .map((key) => [key, e[key]]));
    if (e.cause !== undefined && !(e.cause instanceof Error))
        properties.cause = e.cause;
    return { name: e.name, message: e.message, stack: e.stack, properties,
        ...(e.cause instanceof Error ? { cause: recordFailure(e.cause) } : {}) };
}
export function failureOf(record) {
    const constructors = { Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError };
    const error = new (constructors[record.name] ?? Error)(record.message);
    error.name = record.name;
    if (record.stack !== undefined)
        error.stack = record.stack;
    Object.assign(error, record.properties);
    if (record.cause)
        error.cause = failureOf(record.cause);
    return error;
}
