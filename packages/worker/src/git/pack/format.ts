/**
 * git/pack/format.ts — the bytes of a git packfile (Documentation/gitformat-pack.txt).
 *
 *   header   "PACK", version (2 or 3), object count; all big-endian u32
 *   object   type+size varint, then for ofs-delta a negative-offset varint or
 *            for ref-delta the 20-byte base id, then one zlib stream
 *   trailer  SHA-1 of everything before it
 *
 * Every varint is refused once it would pass 2^53: a size or offset past
 * that cannot be a real object, and past it a JS number silently loses bits.
 */

export const PACK_HEADER_BYTES = 12;
export const PACK_TRAILER_BYTES = 20;
export const OID_BYTES = 20;

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

/** A resolved (non-delta) object type. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_NAMES: Record<number, GitObjectType> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

const TYPE_CODES: Record<GitObjectType, number> = { commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG };

/**
 * The longest object header: 10 size bytes (a 64-bit size), then either 10
 * offset bytes or a 20-byte base id. A window this long always holds one.
 */
export const MAX_OBJECT_HEADER_BYTES = 10 + OID_BYTES;

export class PackFormatError extends Error {
  constructor(message: string) {
    super('pack: ' + message);
    this.name = 'PackFormatError';
  }
}

export function typeName(code: number): GitObjectType {
  const name = TYPE_NAMES[code];
  if (name === undefined) throw new PackFormatError('object type ' + code + ' is not a resolved type');
  return name;
}

export function typeCode(name: GitObjectType): number {
  return TYPE_CODES[name];
}

export interface PackHeader {
  version: 2 | 3;
  objects: number;
}

export function parsePackHeader(bytes: Uint8Array): PackHeader {
  if (bytes.byteLength < PACK_HEADER_BYTES ||
      bytes[0] !== 0x50 || bytes[1] !== 0x41 || bytes[2] !== 0x43 || bytes[3] !== 0x4b) {
    throw new PackFormatError('missing PACK signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, PACK_HEADER_BYTES);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new PackFormatError('unsupported version ' + version);
  return { version, objects: view.getUint32(8) };
}

export function encodePackHeader(objects: number, version: 2 | 3 = 2): Uint8Array {
  const bytes = new Uint8Array(PACK_HEADER_BYTES);
  bytes.set([0x50, 0x41, 0x43, 0x4b]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, version);
  view.setUint32(8, objects);
  return bytes;
}

/** One object's entry header, as it sits at its pack offset. */
export interface ObjectHeader {
  /** OBJ_* code. */
  type: number;
  /** Inflated size: of the object, or of the delta for a delta. */
  size: number;
  /** Bytes from the object's offset to its zlib stream. */
  headerBytes: number;
  /** ofs-delta: the base's absolute pack offset. */
  baseOffset?: number;
  /** ref-delta: the base's object id. */
  baseOid?: Uint8Array;
}

const TWO_POW_53 = 2 ** 53;

/**
 * Parse the entry header at `at` in `bytes`, for the object whose pack offset
 * is `objectOffset`. Null when `bytes` ends before the header does.
 */
export function parseObjectHeader(bytes: Uint8Array, at: number, objectOffset: number): ObjectHeader | null {
  let p = at;
  if (p >= bytes.byteLength) return null;
  let byte = bytes[p++];
  const type = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let scale = 16;
  while (byte & 0x80) {
    if (p >= bytes.byteLength) return null;
    byte = bytes[p++];
    size += (byte & 0x7f) * scale;
    scale *= 128;
    if (size >= TWO_POW_53 || scale > TWO_POW_53 * 128) throw new PackFormatError('object size overflows at offset ' + objectOffset);
  }
  if (type === 0 || type === 5) throw new PackFormatError('invalid object type ' + type + ' at offset ' + objectOffset);
  const header: ObjectHeader = { type, size, headerBytes: 0 };
  if (type === OBJ_OFS_DELTA) {
    // Each continuation adds one before shifting (gitformat-pack: "offset encoding").
    if (p >= bytes.byteLength) return null;
    byte = bytes[p++];
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      if (p >= bytes.byteLength) return null;
      byte = bytes[p++];
      distance = (distance + 1) * 128 + (byte & 0x7f);
      if (distance >= TWO_POW_53) throw new PackFormatError('delta base offset overflows at offset ' + objectOffset);
    }
    if (distance === 0 || distance > objectOffset) {
      throw new PackFormatError('delta base offset out of bounds at offset ' + objectOffset);
    }
    header.baseOffset = objectOffset - distance;
  } else if (type === OBJ_REF_DELTA) {
    if (p + OID_BYTES > bytes.byteLength) return null;
    header.baseOid = bytes.slice(p, p + OID_BYTES);
    p += OID_BYTES;
  }
  header.headerBytes = p - at;
  return header;
}

/** The entry header git writes for a non-delta object of `size` bytes. */
export function encodeObjectHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return Uint8Array.from(out);
}

/**
 * zlib's deflateBound for the default window and memory level: no stream of
 * `size` input bytes is longer, so a read of the header plus this many bytes
 * always holds an object's whole zlib stream.
 */
export function deflateBound(size: number): number {
  return size + Math.floor(size / 4096) + Math.floor(size / 16384) + Math.floor(size / 33554432) + 13;
}

/**
 * inflateSync's output buffer for an object of `size` bytes. Its default is
 * 16 KiB, and a small object comes back as a view of that whole buffer: a
 * cache of small objects would hold 16 KiB apiece. zlib's minimum is 64.
 */
export function inflateChunkSize(size: number): number {
  return Math.max(64, size);
}

/** A delta's two leading sizes, and where its instructions start. */
export interface DeltaSizes {
  baseSize: number;
  resultSize: number;
  at: number;
}

function deltaVarint(delta: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  let p = at;
  for (;;) {
    if (p >= delta.byteLength) throw new PackFormatError('delta size is truncated');
    const byte = delta[p++];
    value += (byte & 0x7f) * scale;
    if (value >= TWO_POW_53) throw new PackFormatError('delta size overflows');
    if (!(byte & 0x80)) return [value, p];
    scale *= 128;
  }
}

export function deltaSizes(delta: Uint8Array): DeltaSizes {
  const [baseSize, afterBase] = deltaVarint(delta, 0);
  const [resultSize, at] = deltaVarint(delta, afterBase);
  return { baseSize, resultSize, at };
}

/** Apply a git delta to its base (patch-delta.c), every instruction bounds-checked. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const { baseSize, resultSize, at } = deltaSizes(delta);
  if (baseSize !== base.byteLength) {
    throw new PackFormatError('delta expects a ' + baseSize + '-byte base, got ' + base.byteLength);
  }
  const out = new Uint8Array(resultSize);
  let p = at;
  let o = 0;
  while (p < delta.byteLength) {
    const op = delta[p++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset = (offset | (delta[p++] << 24)) >>> 0;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (p > delta.byteLength || offset + size > baseSize || o + size > resultSize) {
        throw new PackFormatError('delta copy is out of bounds');
      }
      out.set(base.subarray(offset, offset + size), o);
      o += size;
    } else if (op !== 0) {
      if (p + op > delta.byteLength || o + op > resultSize) throw new PackFormatError('delta insert is out of bounds');
      out.set(delta.subarray(p, p + op), o);
      p += op;
      o += op;
    } else {
      throw new PackFormatError('delta has a reserved zero opcode');
    }
  }
  if (o !== resultSize) throw new PackFormatError('delta produced ' + o + ' of ' + resultSize + ' bytes');
  return out;
}

const OBJECT_HEADER_ENCODER = new TextEncoder();

/** "<type> <size>\0", the prefix an object id hashes before the content. */
export function objectIdPrefix(type: GitObjectType, size: number): Uint8Array {
  return OBJECT_HEADER_ENCODER.encode(type + ' ' + size + '\0');
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function oidToHex(oid: Uint8Array, at = 0): string {
  let hex = '';
  for (let i = at; i < at + OID_BYTES; i++) hex += HEX[oid[i]];
  return hex;
}

const OID_HEX_PATTERN = /^[0-9a-f]{40}$/;

export function oidFromHex(hex: string): Uint8Array {
  if (!OID_HEX_PATTERN.test(hex)) throw new PackFormatError('invalid object id ' + JSON.stringify(hex));
  const oid = new Uint8Array(OID_BYTES);
  for (let i = 0; i < OID_BYTES; i++) oid[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return oid;
}

/** Byte order of two ids, each at its own offset; the idx's sort order. */
export function compareOids(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
  for (let i = 0; i < OID_BYTES; i++) {
    const d = a[aAt + i] - b[bAt + i];
    if (d !== 0) return d;
  }
  return 0;
}
