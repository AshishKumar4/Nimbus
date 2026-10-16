/**
 * The Worker Loader shim's side of the session's loader code store (FAB-2;
 * worker wrangler/loader-code-store.ts): a module's stored form and its
 * digest, made and read back in bounded slices, and the host op that keeps
 * and reads it (`loaderCodeStore`, through the host's supervisorOp, as the
 * Assets shim reads a file).
 */
import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostNamespaceBinding, hostOpDispatch } from './host-dispatch.js';
/** UTF-16 units encoded at a time: at most 3 MiB of UTF-8. */
const SLICE_UNITS = 1024 * 1024;
const MAX_HAS = 256;
/** The most one read answers (the store's LOADER_STORE_READ_BYTES). */
export const STORE_READ_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
/** A leading U+FEFF is the module's own, kept as it was stored. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
function* textSlices(text) {
    for (let at = 0; at < text.length;) {
        let end = Math.min(text.length, at + SLICE_UNITS);
        // A surrogate pair is never split between slices.
        if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800)
            end--;
        yield encoder.encode(text.slice(at, end));
        at = end;
    }
}
function* bufferSlices(buffer) {
    for (let at = 0; at < buffer.byteLength; at += STORE_READ_BYTES)
        yield new Uint8Array(buffer, at, Math.min(STORE_READ_BYTES, buffer.byteLength - at));
}
/**
 * What `JSON.parse(text)` makes, charged by one scan of the text with no
 * parse: 64 per object or array, 24 per member or element (its slot and
 * backing), and 16 + 2 per unit of every string, keys included. A shared
 * object JSON wrote many times is charged as many times as it is parsed.
 */
export function jsonParseCharge(text) {
    let total = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (inString) {
            // An escape is one unit decoded: \uXXXX one, any other two-character escape one.
            if (unit === 0x5c) {
                i += text.charCodeAt(i + 1) === 0x75 ? 5 : 1;
                total += 2;
                continue;
            }
            if (unit === 0x22) {
                inString = false;
                continue;
            }
            total += 2;
            continue;
        }
        if (unit === 0x22) {
            inString = true;
            total += 16;
            continue;
        }
        if (unit === 0x7b || unit === 0x5b) {
            total += 64;
            // A first member or element, unless the container is empty.
            let next = i + 1;
            while (text.charCodeAt(next) === 0x20 || text.charCodeAt(next) === 0x0a || text.charCodeAt(next) === 0x0d || text.charCodeAt(next) === 0x09)
                next++;
            if (text.charCodeAt(next) !== 0x7d && text.charCodeAt(next) !== 0x5d)
                total += 16 + 8;
        }
        else if (unit === 0x2c)
            total += 16 + 8;
    }
    return total;
}
function shapeOf(content) {
    const text = (kind, value, graph = 0) => ({ kind, slices: () => textSlices(value), units: value.length, graph });
    const bytes = (kind, buffer) => ({ kind, slices: () => bufferSlices(buffer), units: -1, graph: 0 });
    if (typeof content === 'string')
        return text('string', content);
    if ('js' in content)
        return text('js', content.js);
    if ('cjs' in content)
        return text('cjs', content.cjs);
    if ('py' in content)
        return text('py', content.py);
    if ('text' in content)
        return text('text', content.text);
    if ('json' in content) {
        const json = JSON.stringify(content.json);
        return text('json', json, jsonParseCharge(json));
    }
    if ('data' in content)
        return bytes('data', content.data);
    const { wasm } = content;
    if (wasm instanceof ArrayBuffer)
        return bytes('wasm', wasm);
    throw new Error('Nimbus Worker Loader: a compiled WebAssembly.Module cannot be kept: pass its bytes ({ wasm: ArrayBuffer })');
}
/** `content`'s stored form: its kind, size and digest, hashed slice by slice, and its working price. */
export async function storedModule(content) {
    const shape = shapeOf(content);
    const hash = sha256Incremental();
    let size = 0;
    for (const slice of shape.slices()) {
        size += slice.byteLength;
        await hash.update(slice);
    }
    // Text: its stored bytes read whole, and the string decoded from them (with a {json}'s parsed graph); binary: its final buffer.
    const missPrice = shape.units < 0 ? 64 + size : size + 16 + 2 * shape.units + shape.graph;
    return { kind: shape.kind, size, digest: await hash.hex(), missPrice, slices: shape.slices };
}
/** `bytes` (a whole stored module) as the content it was stored from. */
export function restoredModule(kind, bytes) {
    const exact = () => bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer
        : bytes.slice().buffer;
    switch (kind) {
        case 'data': return { data: exact() };
        case 'wasm': return { wasm: exact() };
        case 'json': return { json: JSON.parse(decoder.decode(bytes)) };
        case 'string': return decoder.decode(bytes);
        case 'js': return { js: decoder.decode(bytes) };
        case 'cjs': return { cjs: decoder.decode(bytes) };
        case 'py': return { py: decoder.decode(bytes) };
        case 'text': return { text: decoder.decode(bytes) };
    }
}
/** The store's requests for `ref`'s owner, through its session's host op. */
export function loaderStore(env, ref) {
    const call = async (request, stream) => {
        const ns = hostNamespaceBinding(env, 'NimbusLoaderRPC', ref.route);
        const stub = ns.get(ns.idFromString(ref.doId));
        try {
            return await hostOpDispatch(stub, 'NimbusLoaderRPC', ref.route)({ op: 'loaderCodeStore', args: [{ ...request, owner: ref.owner }], ...(stream === undefined ? {} : { stream }) });
        }
        finally {
            disposeRpcResource(stub);
        }
    };
    return {
        async alive() {
            return (await call({ kind: 'alive' })) === true;
        },
        /** Each of `modules` the owner does not hold already (or adopt from another owner), put. */
        async keep(modules) {
            const held = new Set();
            for (let at = 0; at < modules.length; at += MAX_HAS) {
                const answer = await call({ kind: 'has', digests: [...new Set(modules.slice(at, at + MAX_HAS).map((m) => m.digest))] });
                if (Array.isArray(answer))
                    for (const digest of answer)
                        held.add(String(digest));
            }
            for (const module of modules) {
                if (held.has(module.digest))
                    continue;
                const slices = module.slices()[Symbol.iterator]();
                // A byte stream, as Workers RPC carries one; each slice an owned copy, as enqueuing one transfers its buffer.
                const stream = new ReadableStream({
                    type: 'bytes',
                    pull(controller) {
                        const next = slices.next();
                        if (next.done)
                            controller.close();
                        else
                            controller.enqueue(new Uint8Array(next.value));
                    },
                });
                await call({ kind: 'put', digest: module.digest, size: module.size }, stream);
                held.add(module.digest);
            }
        },
        /** A stored module's bytes, read in frames into one buffer, verified against its digest. */
        async read(module) {
            const bytes = new Uint8Array(module.size);
            const hash = sha256Incremental();
            for (let at = 0; at < module.size;) {
                const frame = await call({ kind: 'read', digest: module.digest, offset: at, length: Math.min(STORE_READ_BYTES, module.size - at) });
                if (!(frame instanceof Uint8Array) || frame.byteLength === 0)
                    break;
                bytes.set(frame, at);
                await hash.update(frame);
                at += frame.byteLength;
            }
            if (await hash.hex() !== module.digest)
                throw new Error(`Nimbus Worker Loader: its stored code is not what was loaded (module ${module.digest})`);
            return bytes;
        },
    };
}
