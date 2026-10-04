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
