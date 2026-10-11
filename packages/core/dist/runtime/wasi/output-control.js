export const OUTPUT_CONTROL_MAX_BYTES = 4096;
/** Filter only declared frames; all other bytes retain their exact encoding. */
export function outputControlReader(frames) {
    const encoder = new TextEncoder();
    const table = frames.map(frame => ({ ...frame, start: encoder.encode(frame.prefix), end: frame.suffix === undefined ? null : encoder.encode(frame.suffix) }));
    let held = new Uint8Array(0);
    const values = {};
    const equal = (data, at, pattern, count) => {
        for (let i = 0; i < count; i++)
            if (data[at + i] !== pattern[i])
                return false;
        return true;
    };
    return {
        values,
        feed(bytes) {
            const data = held.length ? (() => { const joined = new Uint8Array(held.length + bytes.length); joined.set(held); joined.set(bytes, held.length); return joined; })() : bytes;
            held = new Uint8Array(0);
            const emitted = [];
            let emittedBytes = 0, begin = 0;
            const emit = (end) => { if (end > begin) {
                const part = data.subarray(begin, end);
                emitted.push(part);
                emittedBytes += part.length;
            } };
            for (let at = 0; at < data.length; at++) {
                const frame = table.find(item => equal(data, at, item.start, Math.min(item.start.length, data.length - at)));
                if (!frame)
                    continue;
                emit(at);
                if (data.length - at < frame.start.length) {
                    held = data.slice(at);
                    begin = data.length;
                    break;
                }
                const payload = at + frame.start.length;
                if (frame.end === null) {
                    values[frame.key] = '';
                    at = payload - 1;
                    begin = payload;
                    continue;
                }
                let end = payload;
                while (end + frame.end.length <= data.length && !equal(data, end, frame.end, frame.end.length))
                    end++;
                if (end + frame.end.length > data.length) {
                    if (data.length - at > OUTPUT_CONTROL_MAX_BYTES)
                        throw new Error('runtime output control frame exceeds its byte bound');
                    held = data.slice(at);
                    begin = data.length;
                    break;
                }
                if (end - payload > OUTPUT_CONTROL_MAX_BYTES)
                    throw new Error('runtime output control frame exceeds its byte bound');
                values[frame.key] = new TextDecoder().decode(data.subarray(payload, end));
                at = end + frame.end.length - 1;
                begin = at + 1;
            }
            emit(data.length);
            if (emitted.length === 0)
                return new Uint8Array(0);
            if (emitted.length === 1)
                return emitted[0];
            const out = new Uint8Array(emittedBytes);
            let at = 0;
            for (const part of emitted) {
                out.set(part, at);
                at += part.length;
            }
            return out;
        },
        finish() { const tail = held; held = new Uint8Array(0); return tail; },
    };
}
