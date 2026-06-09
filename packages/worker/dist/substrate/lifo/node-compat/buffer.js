const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class Buffer extends Uint8Array {
    // Use overloaded signatures to satisfy Uint8Array's static from
    static from(value, encodingOrMapFn, _thisArg) {
        if (typeof value === 'string') {
            const encoding = encodingOrMapFn;
            if (encoding === 'base64') {
                const binary = atob(value);
                const buf = new Buffer(binary.length);
                for (let i = 0; i < binary.length; i++)
                    buf[i] = binary.charCodeAt(i);
                return buf;
            }
            if (encoding === 'hex') {
                const buf = new Buffer(value.length / 2);
                for (let i = 0; i < value.length; i += 2) {
                    buf[i / 2] = parseInt(value.substring(i, i + 2), 16);
                }
                return buf;
            }
            // utf-8 default
            const bytes = encoder.encode(value);
            const buf = new Buffer(bytes.length);
            buf.set(bytes);
            return buf;
        }
        if (value instanceof ArrayBuffer) {
            const buf = new Buffer(value.byteLength);
            buf.set(new Uint8Array(value));
            return buf;
        }
        if (value instanceof Uint8Array) {
            const buf = new Buffer(value.length);
            buf.set(value);
            return buf;
        }
        // ArrayLike<number> or number[]
        const arr = value;
        const buf = new Buffer(arr.length);
        for (let i = 0; i < arr.length; i++)
            buf[i] = arr[i];
        return buf;
    }
    static alloc(size, fill) {
        const buf = new Buffer(size);
        if (fill !== undefined)
            buf.fill(fill);
        return buf;
    }
    static allocUnsafe(size) {
        return new Buffer(size);
    }
    static isBuffer(obj) {
        return obj instanceof Buffer;
    }
    static concat(list, totalLength) {
        const len = totalLength ?? list.reduce((sum, b) => sum + b.length, 0);
        const result = Buffer.alloc(len);
        let offset = 0;
        for (const buf of list) {
            const slice = buf.subarray(0, Math.min(buf.length, len - offset));
            result.set(slice, offset);
            offset += slice.length;
            if (offset >= len)
                break;
        }
        return result;
    }
    static byteLength(str, encoding) {
        if (encoding === 'base64') {
            // Remove padding and compute
            const cleaned = str.replace(/[^A-Za-z0-9+/]/g, '');
            return Math.floor(cleaned.length * 3 / 4);
        }
        if (encoding === 'hex') {
            return str.length / 2;
        }
        return encoder.encode(str).length;
    }
    toString(encoding, start, end) {
        const slice = (start !== undefined || end !== undefined)
            ? this.subarray(start ?? 0, end ?? this.length)
            : this;
        if (encoding === 'base64') {
            let binary = '';
            for (let i = 0; i < slice.length; i++)
                binary += String.fromCharCode(slice[i]);
            return btoa(binary);
        }
        if (encoding === 'hex') {
            let hex = '';
            for (let i = 0; i < slice.length; i++)
                hex += slice[i].toString(16).padStart(2, '0');
            return hex;
        }
        // utf-8 default
        return decoder.decode(slice);
    }
    write(str, offset, length, encoding) {
        const start = offset ?? 0;
        const maxLen = length ?? this.length - start;
        let bytes;
        if (encoding === 'hex') {
            // Each pair of hex chars = 1 byte
            const byteLen = Math.min(Math.floor(str.length / 2), maxLen);
            bytes = new Uint8Array(byteLen);
            for (let i = 0; i < byteLen; i++) {
                bytes[i] = parseInt(str.substring(i * 2, i * 2 + 2), 16);
            }
        }
        else if (encoding === 'base64') {
            const binary = atob(str);
            const byteLen = Math.min(binary.length, maxLen);
            bytes = new Uint8Array(byteLen);
            for (let i = 0; i < byteLen; i++)
                bytes[i] = binary.charCodeAt(i);
        }
        else {
            bytes = encoder.encode(str);
        }
        const toWrite = Math.min(bytes.length, maxLen);
        this.set(bytes.subarray(0, toWrite), start);
        return toWrite;
    }
    toJSON() {
        return { type: 'Buffer', data: Array.from(this) };
    }
    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        const slice = this.subarray(sourceStart, sourceEnd);
        const len = Math.min(slice.length, target.length - targetStart);
        target.set(slice.subarray(0, len), targetStart);
        return len;
    }
    equals(other) {
        if (this.length !== other.length)
            return false;
        for (let i = 0; i < this.length; i++) {
            if (this[i] !== other[i])
                return false;
        }
        return true;
    }
    compare(other) {
        const len = Math.min(this.length, other.length);
        for (let i = 0; i < len; i++) {
            if (this[i] < other[i])
                return -1;
            if (this[i] > other[i])
                return 1;
        }
        if (this.length < other.length)
            return -1;
        if (this.length > other.length)
            return 1;
        return 0;
    }
    slice(start, end) {
        const sliced = super.slice(start, end);
        return Buffer.from(sliced);
    }
    subarray(start, end) {
        const sub = super.subarray(start, end);
        return Buffer.from(sub);
    }
    // ─── Integer read methods (big-endian) ───
    readUInt8(offset = 0) {
        return this[offset];
    }
    readUInt16BE(offset = 0) {
        return (this[offset] << 8) | this[offset + 1];
    }
    readUInt32BE(offset = 0) {
        return ((this[offset] * 0x1000000) +
            ((this[offset + 1] << 16) |
                (this[offset + 2] << 8) |
                this[offset + 3]));
    }
    readInt8(offset = 0) {
        const val = this[offset];
        return val & 0x80 ? val - 0x100 : val;
    }
    readInt16BE(offset = 0) {
        const val = (this[offset] << 8) | this[offset + 1];
        return val & 0x8000 ? val - 0x10000 : val;
    }
    readInt32BE(offset = 0) {
        return ((this[offset] << 24) |
            (this[offset + 1] << 16) |
            (this[offset + 2] << 8) |
            this[offset + 3]);
    }
    // ─── Integer read methods (little-endian) ───
    readUInt16LE(offset = 0) {
        return this[offset] | (this[offset + 1] << 8);
    }
    readUInt32LE(offset = 0) {
        return (this[offset] +
            (this[offset + 1] << 8) +
            (this[offset + 2] << 16) +
            (this[offset + 3] * 0x1000000));
    }
    readInt16LE(offset = 0) {
        const val = this[offset] | (this[offset + 1] << 8);
        return val & 0x8000 ? val - 0x10000 : val;
    }
    readInt32LE(offset = 0) {
        return (this[offset] |
            (this[offset + 1] << 8) |
            (this[offset + 2] << 16) |
            (this[offset + 3] << 24));
    }
    // ─── Integer write methods (big-endian) ───
    writeUInt8(value, offset = 0) {
        this[offset] = value & 0xff;
        return offset + 1;
    }
    writeUInt16BE(value, offset = 0) {
        this[offset] = (value >>> 8) & 0xff;
        this[offset + 1] = value & 0xff;
        return offset + 2;
    }
    writeUInt32BE(value, offset = 0) {
        this[offset] = (value >>> 24) & 0xff;
        this[offset + 1] = (value >>> 16) & 0xff;
        this[offset + 2] = (value >>> 8) & 0xff;
        this[offset + 3] = value & 0xff;
        return offset + 4;
    }
    writeInt8(value, offset = 0) {
        this[offset] = value & 0xff;
        return offset + 1;
    }
    writeInt16BE(value, offset = 0) {
        this[offset] = (value >>> 8) & 0xff;
        this[offset + 1] = value & 0xff;
        return offset + 2;
    }
    writeInt32BE(value, offset = 0) {
        this[offset] = (value >>> 24) & 0xff;
        this[offset + 1] = (value >>> 16) & 0xff;
        this[offset + 2] = (value >>> 8) & 0xff;
        this[offset + 3] = value & 0xff;
        return offset + 4;
    }
    // ─── Integer write methods (little-endian) ───
    writeUInt16LE(value, offset = 0) {
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;
        return offset + 2;
    }
    writeUInt32LE(value, offset = 0) {
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;
        this[offset + 2] = (value >>> 16) & 0xff;
        this[offset + 3] = (value >>> 24) & 0xff;
        return offset + 4;
    }
    writeInt16LE(value, offset = 0) {
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;
        return offset + 2;
    }
    writeInt32LE(value, offset = 0) {
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;
        this[offset + 2] = (value >>> 16) & 0xff;
        this[offset + 3] = (value >>> 24) & 0xff;
        return offset + 4;
    }
    // ─── Search methods ───
    indexOf(value, byteOffset, encoding) {
        const start = byteOffset ?? 0;
        if (typeof value === 'number') {
            for (let i = start; i < this.length; i++) {
                if (this[i] === value)
                    return i;
            }
            return -1;
        }
        const needle = typeof value === 'string'
            ? Buffer.from(value, encoding)
            : value;
        if (needle.length === 0)
            return start;
        for (let i = start; i <= this.length - needle.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) {
                    match = false;
                    break;
                }
            }
            if (match)
                return i;
        }
        return -1;
    }
    lastIndexOf(value, byteOffset, encoding) {
        if (typeof value === 'number') {
            const start = byteOffset ?? this.length - 1;
            for (let i = start; i >= 0; i--) {
                if (this[i] === value)
                    return i;
            }
            return -1;
        }
        const needle = typeof value === 'string'
            ? Buffer.from(value, encoding)
            : value;
        if (needle.length === 0)
            return byteOffset ?? this.length;
        const start = byteOffset != null ? Math.min(byteOffset, this.length - needle.length) : this.length - needle.length;
        for (let i = start; i >= 0; i--) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) {
                    match = false;
                    break;
                }
            }
            if (match)
                return i;
        }
        return -1;
    }
    includes(value, byteOffset, encoding) {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }
}
export default Buffer;
