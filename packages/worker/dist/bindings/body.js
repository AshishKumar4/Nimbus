export function ensureBindingDir(vfs, path) {
    if (!vfs.exists(path))
        vfs.mkdir(path, { recursive: true });
}
export async function coerceBindingBody(value) {
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
    if (value instanceof Blob)
        return new Uint8Array(await value.arrayBuffer());
    if (typeof value === 'object' && 'getReader' in value && typeof value.getReader === 'function') {
        const chunks = [];
        let total = 0;
        const reader = value.getReader();
        for (;;) {
            const { value: chunk, done } = await reader.read();
            if (done)
                break;
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            chunks.push(bytes);
            total += bytes.length;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
    return new TextEncoder().encode(String(value));
}
/** A stored body as a byte stream of one chunk. */
export function bodyStream(body) {
    return new ReadableStream({
        type: 'bytes',
        start(controller) {
            controller.enqueue(body);
            controller.close();
        },
    });
}
