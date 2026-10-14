import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
/** How many bytes a stored body is read in at a time. */
const READ_PIECE_BYTES = 1024 * 1024;
export function ensureBindingDir(vfs, path) {
    if (!vfs.exists(path))
        vfs.mkdir(path, { recursive: true });
}
/** A body that is not a stream, as its bytes: it crossed to the session whole. */
async function wholeBody(value) {
    if (value == null)
        return new Uint8Array(0);
    if (typeof value === 'string')
        return new TextEncoder().encode(value);
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(await value.arrayBuffer());
}
/**
 * `body` written to `path` as it arrives, never held whole: a stream's
 * pieces go to the file as they are read, each also given to `onPiece` (a
 * digest). A body past `limit` bytes throws `tooLarge(received)`: a stream
 * once it passes the limit, cancelled rather than drained, any other body by
 * its length before it is written. A body that fails publishes nothing.
 * Answers the body's size.
 */
export async function writeBody(vfs, path, body, limit, tooLarge, onPiece = () => { }) {
    if (!(body instanceof ReadableStream)) {
        const bytes = await wholeBody(body);
        if (bytes.byteLength > limit)
            throw tooLarge(bytes.byteLength);
        onPiece(bytes);
        vfs.writeFile(path, bytes);
        return bytes.byteLength;
    }
    const reader = body.getReader();
    let received = 0;
    let ended = false;
    const pieces = async function* () {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                ended = true;
                return;
            }
            const piece = value instanceof Uint8Array ? value : new Uint8Array(value);
            received += piece.byteLength;
            if (received > limit)
                throw tooLarge(received);
            onPiece(piece);
            yield piece;
        }
    };
    try {
        await vfs.writeFileFrom(path, limit, pieces(), { atMost: true });
    }
    catch (error) {
        if (!ended)
            await reader.cancel(error).catch(() => { });
        throw error;
    }
    return received;
}
/**
 * The `length` bytes of the file at `path` from `start`, read a piece at a
 * time as they are asked for, which may be after the call that made it has
 * answered: a piece that meets another holder's delegation waits for its
 * recall and is read again, as a call the session serves is. The file
 * changed under it (replaced, removed, or by the recall) errors the stream
 * rather than mix two bodies.
 */
export function fileStream(vfs, path, start, length) {
    const revision = vfs.revision(path);
    let at = start;
    const end = start + length;
    return new ReadableStream({
        type: 'bytes',
        async pull(controller) {
            if (at >= end) {
                controller.close();
                return;
            }
            const piece = await withRecall(() => {
                if (vfs.revision(path) !== revision)
                    throw new Error('the object changed while its body was read');
                return vfs.readRange(path, at, Math.min(READ_PIECE_BYTES, end - at));
            });
            at += piece.byteLength;
            // A byte stream refuses an empty chunk, and takes the buffer it is given: the read may share the filesystem's.
            if (piece.byteLength === 0)
                controller.close();
            else
                controller.enqueue(piece.slice());
        },
    });
}
