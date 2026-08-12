import { resolve } from './path.js';
import { encode, decode, concatBytes } from './encoding.js';
// ─── CRC-32 ───
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
}
export function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
// ─── Gzip (browser CompressionStream/DecompressionStream) ───
export async function compressGzip(data) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
    }
    return concatBytes(...chunks);
}
export async function decompressGzip(data) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
    }
    return concatBytes(...chunks);
}
function tarWriteString(buf, offset, str, len) {
    const bytes = encode(str);
    buf.set(bytes.subarray(0, len), offset);
}
function tarWriteOctal(buf, offset, value, len) {
    const str = value.toString(8).padStart(len - 1, '0');
    tarWriteString(buf, offset, str, len - 1);
    buf[offset + len - 1] = 0;
}
function tarChecksum(header) {
    let sum = 0;
    for (let i = 0; i < 512; i++) {
        // Checksum field (offset 148, length 8) is treated as spaces
        sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    return sum;
}
function tarReadString(buf, offset, len) {
    let end = offset;
    const max = offset + len;
    while (end < max && buf[end] !== 0)
        end++;
    return decode(buf.subarray(offset, end));
}
function tarReadOctal(buf, offset, len) {
    const str = tarReadString(buf, offset, len).trim();
    return str ? parseInt(str, 8) : 0;
}
export function createTar(entries) {
    const blocks = [];
    for (const entry of entries) {
        const header = new Uint8Array(512);
        let path = entry.path;
        if (entry.type === 'directory' && !path.endsWith('/'))
            path += '/';
        // Remove leading /
        if (path.startsWith('/'))
            path = path.slice(1);
        tarWriteString(header, 0, path, 100); // name
        tarWriteOctal(header, 100, entry.mode, 8); // mode
        tarWriteOctal(header, 108, 0, 8); // uid
        tarWriteOctal(header, 116, 0, 8); // gid
        tarWriteOctal(header, 124, entry.data.length, 12); // size
        tarWriteOctal(header, 136, Math.floor(entry.mtime / 1000), 12); // mtime
        // type flag
        header[156] = entry.type === 'directory' ? 53 : 48; // '5' or '0'
        // ustar magic
        tarWriteString(header, 257, 'ustar', 6);
        tarWriteString(header, 263, '00', 2); // version
        tarWriteString(header, 265, 'user', 32); // uname
        tarWriteString(header, 297, 'user', 32); // gname
        // Compute and write checksum
        const checksum = tarChecksum(header);
        tarWriteOctal(header, 148, checksum, 7);
        header[155] = 0x20; // trailing space
        blocks.push(header);
        if (entry.type === 'file' && entry.data.length > 0) {
            // Data blocks, padded to 512 bytes
            const paddedLen = Math.ceil(entry.data.length / 512) * 512;
            const dataBlock = new Uint8Array(paddedLen);
            dataBlock.set(entry.data);
            blocks.push(dataBlock);
        }
    }
    // Two zero blocks to mark end of archive
    blocks.push(new Uint8Array(1024));
    return concatBytes(...blocks);
}
export function parseTar(data) {
    const entries = [];
    let offset = 0;
    while (offset + 512 <= data.length) {
        const header = data.subarray(offset, offset + 512);
        // Check for zero block (end of archive)
        let allZero = true;
        for (let i = 0; i < 512; i++) {
            if (header[i] !== 0) {
                allZero = false;
                break;
            }
        }
        if (allZero)
            break;
        let path = tarReadString(header, 0, 100);
        const mode = tarReadOctal(header, 100, 8);
        const size = tarReadOctal(header, 124, 12);
        const mtime = tarReadOctal(header, 136, 12) * 1000;
        const typeFlag = header[156];
        const isDir = typeFlag === 53 || path.endsWith('/'); // '5' or trailing /
        if (path.endsWith('/'))
            path = path.slice(0, -1);
        offset += 512;
        let entryData = new Uint8Array(0);
        if (size > 0) {
            entryData = data.slice(offset, offset + size);
            offset += Math.ceil(size / 512) * 512;
        }
        entries.push({
            path,
            data: entryData,
            type: isDir ? 'directory' : 'file',
            mode: mode || (isDir ? 0o755 : 0o644),
            mtime,
        });
    }
    return entries;
}
function writeU16LE(buf, offset, value) {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
}
function writeU32LE(buf, offset, value) {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
    buf[offset + 2] = (value >>> 16) & 0xff;
    buf[offset + 3] = (value >>> 24) & 0xff;
}
function readU16LE(buf, offset) {
    return buf[offset] | (buf[offset + 1] << 8);
}
function readU32LE(buf, offset) {
    return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}
export function createZip(entries) {
    const chunks = [];
    const centralHeaders = [];
    let offset = 0;
    for (const entry of entries) {
        let path = entry.path;
        if (path.startsWith('/'))
            path = path.slice(1);
        if (entry.isDirectory && !path.endsWith('/'))
            path += '/';
        const nameBytes = encode(path);
        const crc = entry.isDirectory ? 0 : crc32(entry.data);
        const size = entry.isDirectory ? 0 : entry.data.length;
        // Local file header (30 + name + data)
        const local = new Uint8Array(30 + nameBytes.length);
        writeU32LE(local, 0, 0x04034b50); // Local file header signature
        writeU16LE(local, 4, 20); // Version needed (2.0)
        writeU16LE(local, 6, 0); // Flags
        writeU16LE(local, 8, 0); // Compression (stored)
        writeU16LE(local, 10, 0); // Mod time
        writeU16LE(local, 12, 0); // Mod date
        writeU32LE(local, 14, crc); // CRC-32
        writeU32LE(local, 18, size); // Compressed size
        writeU32LE(local, 22, size); // Uncompressed size
        writeU16LE(local, 26, nameBytes.length); // Name length
        writeU16LE(local, 28, 0); // Extra field length
        local.set(nameBytes, 30);
        chunks.push(local);
        if (size > 0)
            chunks.push(entry.data);
        // Central directory header (46 + name)
        const central = new Uint8Array(46 + nameBytes.length);
        writeU32LE(central, 0, 0x02014b50); // Central dir signature
        writeU16LE(central, 4, 20); // Version made by
        writeU16LE(central, 6, 20); // Version needed
        writeU16LE(central, 8, 0); // Flags
        writeU16LE(central, 10, 0); // Compression
        writeU16LE(central, 12, 0); // Mod time
        writeU16LE(central, 14, 0); // Mod date
        writeU32LE(central, 16, crc); // CRC-32
        writeU32LE(central, 20, size); // Compressed size
        writeU32LE(central, 24, size); // Uncompressed size
        writeU16LE(central, 28, nameBytes.length); // Name length
        writeU16LE(central, 30, 0); // Extra field length
        writeU16LE(central, 32, 0); // Comment length
        writeU16LE(central, 34, 0); // Disk number start
        writeU16LE(central, 36, 0); // Internal attributes
        writeU32LE(central, 38, entry.isDirectory ? 0x10 : 0); // External attributes
        writeU32LE(central, 42, offset); // Relative offset of local header
        central.set(nameBytes, 46);
        centralHeaders.push(central);
        offset += 30 + nameBytes.length + size;
    }
    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const h of centralHeaders) {
        chunks.push(h);
        centralDirSize += h.length;
    }
    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    writeU32LE(eocd, 0, 0x06054b50); // EOCD signature
    writeU16LE(eocd, 4, 0); // Disk number
    writeU16LE(eocd, 6, 0); // Central dir start disk
    writeU16LE(eocd, 8, entries.length); // Entries on this disk
    writeU16LE(eocd, 10, entries.length); // Total entries
    writeU32LE(eocd, 12, centralDirSize); // Central dir size
    writeU32LE(eocd, 16, centralDirOffset); // Central dir offset
    writeU16LE(eocd, 20, 0); // Comment length
    chunks.push(eocd);
    return concatBytes(...chunks);
}
export function parseZip(data) {
    const entries = [];
    // Find EOCD (last 22+ bytes)
    let eocdOffset = -1;
    for (let i = data.length - 22; i >= 0; i--) {
        if (readU32LE(data, i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1)
        throw new Error('Invalid ZIP: EOCD not found');
    const entryCount = readU16LE(data, eocdOffset + 10);
    let centralOffset = readU32LE(data, eocdOffset + 16);
    for (let i = 0; i < entryCount; i++) {
        if (readU32LE(data, centralOffset) !== 0x02014b50)
            break;
        const nameLen = readU16LE(data, centralOffset + 28);
        const extraLen = readU16LE(data, centralOffset + 30);
        const commentLen = readU16LE(data, centralOffset + 32);
        const localOffset = readU32LE(data, centralOffset + 42);
        const nameBytes = data.subarray(centralOffset + 46, centralOffset + 46 + nameLen);
        let path = decode(nameBytes);
        const isDirectory = path.endsWith('/');
        if (isDirectory)
            path = path.slice(0, -1);
        // Read data from local file header
        const localNameLen = readU16LE(data, localOffset + 26);
        const localExtraLen = readU16LE(data, localOffset + 28);
        const compressedSize = readU32LE(data, localOffset + 18);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const entryData = isDirectory
            ? new Uint8Array(0)
            : data.slice(dataStart, dataStart + compressedSize);
        entries.push({ path, data: entryData, isDirectory });
        centralOffset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}
// ─── VFS helper: recursively collect files ───
/**
 * Members are named relative to the archive's working directory, so
 * `tar -czf a.tgz src/f.txt` stores `src/f.txt`. Naming them relative to each
 * operand's own parent instead flattened every multi-component operand to its
 * basename, and the archive lost the directory the caller asked for.
 */
export function collectFiles(vfs, basePath, paths) {
    const entries = [];
    const relBase = basePath === '/' ? '/' : basePath + '/';
    const member = (absPath) => absPath.startsWith(relBase) ? absPath.slice(relBase.length) : absPath.replace(/^\/+/, '');
    function walk(absPath) {
        const stat = vfs.stat(absPath);
        if (stat.type === 'directory') {
            entries.push({
                path: member(absPath),
                data: new Uint8Array(0),
                type: 'directory',
                mode: stat.mode,
                mtime: stat.mtime,
            });
            const children = vfs.readdir(absPath);
            for (const child of children) {
                walk(absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`);
            }
        }
        else {
            entries.push({
                path: member(absPath),
                data: vfs.readFile(absPath),
                type: 'file',
                mode: stat.mode,
                mtime: stat.mtime,
            });
        }
    }
    for (const p of paths)
        walk(resolve(basePath, p));
    return entries;
}
