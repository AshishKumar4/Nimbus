import type { Command, CommandContext } from '../types.js';
import { createHash } from 'node:crypto';
import { concatBytes, decodeLossless, encodeLossless, fsErrorText, inputChunks, writeBytes } from '../../utils/bytes-io.js';

// GNU coreutils 9.7's checksum tools on one engine: md5sum, sha1sum,
// sha224sum, sha256sum, sha384sum, sha512sum, b2sum, cksum and sum. Input is
// hashed as it streams; -c verifies a list of checksums.

// ── hashers ──

interface Hasher { update(bytes: Uint8Array): void; digest(): Uint8Array }

function nodeHasher(name: 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512'): Hasher {
  const h = createHash(name);
  return { update: (b) => { h.update(b); }, digest: () => new Uint8Array(h.digest()) };
}

/** BLAKE2b (RFC 7693) with an output of `outBytes` (1..64). */
function blake2b(outBytes: number): Hasher {
  const IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ];
  const M64 = (1n << 64n) - 1n;
  const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outBytes);
  let t = 0n;
  let buf = new Uint8Array(128);
  let fill = 0;
  const compress = (block: Uint8Array, last: boolean) => {
    const m: bigint[] = [];
    const view = new DataView(block.buffer, block.byteOffset, 128);
    for (let i = 0; i < 16; i++) m.push(view.getBigUint64(i * 8, true));
    const v = [...h, ...IV];
    v[12] ^= t & M64;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= M64;
    const G = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  };
  return {
    update(bytes) {
      for (let i = 0; i < bytes.length; i++) {
        // A full buffer is compressed only once more input follows (the last block is special).
        if (fill === 128) { t += 128n; compress(buf, false); fill = 0; }
        buf[fill++] = bytes[i];
      }
    },
    digest() {
      t += BigInt(fill);
      buf.fill(0, fill);
      compress(buf, true);
      const out = new Uint8Array(64);
      const view = new DataView(out.buffer);
      h.forEach((x, i) => view.setBigUint64(i * 8, x, true));
      buf = new Uint8Array(128);
      return out.subarray(0, outBytes);
    },
  };
}

const CRC_POSIX = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();
const CRC_32B = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** A counting "hash": the value cksum/sum print, and the input's size. */
interface Counter { update(bytes: Uint8Array): void; result(): { value: number; size: number } }

function crcPosix(): Counter {
  let crc = 0;
  let size = 0;
  return {
    update(bytes) {
      for (const b of bytes) crc = ((crc << 8) ^ CRC_POSIX[((crc >>> 24) ^ b) & 0xff]) >>> 0;
      size += bytes.length;
    },
    result() {
      let c = crc;
      for (let n = size; n > 0; n = Math.floor(n / 256)) c = ((c << 8) ^ CRC_POSIX[((c >>> 24) ^ (n & 0xff)) & 0xff]) >>> 0;
      return { value: (~c) >>> 0, size };
    },
  };
}

function crc32b(): Counter {
  let crc = 0xffffffff;
  let size = 0;
  return {
    update(bytes) {
      for (const b of bytes) crc = (crc >>> 8) ^ CRC_32B[(crc ^ b) & 0xff];
      size += bytes.length;
    },
    result: () => ({ value: (crc ^ 0xffffffff) >>> 0, size }),
  };
}

function bsdSum(): Counter {
  let sum = 0;
  let size = 0;
  return {
    update(bytes) {
      for (const b of bytes) { sum = (sum >> 1) + ((sum & 1) << 15); sum = (sum + b) & 0xffff; }
      size += bytes.length;
    },
    result: () => ({ value: sum, size }),
  };
}

function sysvSum(): Counter {
  let sum = 0;
  let size = 0;
  return {
    update(bytes) {
      for (const b of bytes) sum = (sum + b) >>> 0;
      size += bytes.length;
    },
    result() {
      let r = (sum & 0xffff) + (sum >>> 16);
      r = (r & 0xffff) + (r >>> 16);
      return { value: r, size };
    },
  };
}

// ── algorithms ──

type Algorithm =
  | { kind: 'digest'; name: string; tag: string; bits: number; make: (bits: number) => Hasher }
  | { kind: 'crc' | 'crc32b' | 'bsd' | 'sysv' };

const DIGESTS: Record<string, { tag: string; bits: number; make: (bits: number) => Hasher }> = {
  md5: { tag: 'MD5', bits: 128, make: () => nodeHasher('md5') },
  sha1: { tag: 'SHA1', bits: 160, make: () => nodeHasher('sha1') },
  sha224: { tag: 'SHA224', bits: 224, make: () => nodeHasher('sha224') },
  sha256: { tag: 'SHA256', bits: 256, make: () => nodeHasher('sha256') },
  sha384: { tag: 'SHA384', bits: 384, make: () => nodeHasher('sha384') },
  sha512: { tag: 'SHA512', bits: 512, make: () => nodeHasher('sha512') },
  blake2b: { tag: 'BLAKE2b', bits: 512, make: (bits) => blake2b(bits / 8) },
};

function digestAlgorithm(name: string): Algorithm {
  const d = DIGESTS[name];
  return { kind: 'digest', name, ...d };
}

// ── output ──

/** A name as GNU prints it: with `\`, newline or CR it is escaped and the line gets a leading `\`. */
function escapeName(name: string, zero: boolean): { name: string; escaped: boolean } {
  if (zero || !/[\\\n\r]/.test(name)) return { name, escaped: false };
  return { name: name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r'), escaped: true };
}

function unescapeName(name: string): string | null {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== '\\') { out += name[i]; continue; }
    const n = name[++i];
    if (n === '\\') out += '\\';
    else if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else return null;
  }
  return out;
}

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

interface Options {
  program: string;
  algorithm: Algorithm;
  bits: number;
  binary: boolean;
  tag: boolean;
  zero: boolean;
  base64: boolean;
  raw: boolean;
  check: boolean;
  ignoreMissing: boolean;
  quiet: boolean;
  status: boolean;
  strict: boolean;
  warn: boolean;
  files: string[];
}

async function hashFile(ctx: CommandContext, file: string, o: Options): Promise<Uint8Array | { value: number; size: number }> {
  if (o.algorithm.kind === 'digest') {
    const h = o.algorithm.make(o.bits);
    for await (const chunk of inputChunks(ctx, file)) h.update(chunk);
    return h.digest();
  }
  const c = o.algorithm.kind === 'crc' ? crcPosix() : o.algorithm.kind === 'crc32b' ? crc32b() : o.algorithm.kind === 'bsd' ? bsdSum() : sysvSum();
  for await (const chunk of inputChunks(ctx, file)) c.update(chunk);
  return c.result();
}

function tagOf(o: Options): string {
  if (o.algorithm.kind !== 'digest') return '';
  return o.algorithm.name === 'blake2b' && o.bits !== 512 ? `BLAKE2b-${o.bits}` : o.algorithm.tag;
}

async function sumFiles(ctx: CommandContext, o: Options): Promise<number> {
  let status = 0;
  const files = o.files.length > 0 ? o.files : ['-'];
  const end = o.zero ? '\0' : '\n';
  for (const file of files) {
    let result: Uint8Array | { value: number; size: number };
    try {
      result = await hashFile(ctx, file, o);
    } catch (error) {
      await ctx.stderr.write(`${o.program}: ${file}: ${fsErrorText(error)}\n`);
      status = 1;
      continue;
    }
    if (!(result instanceof Uint8Array)) {
      const { value, size } = result;
      const named = files.length > 1 || file !== '-';
      let line: string;
      if (o.algorithm.kind === 'bsd') line = `${String(value).padStart(5, '0')} ${String(Math.ceil(size / 1024)).padStart(5)}`;
      else if (o.algorithm.kind === 'sysv') line = `${value} ${Math.ceil(size / 512)}`;
      else line = `${value} ${size}`;
      // cksum names every file but standard input; sum names them when there are operands.
      const showName = o.algorithm.kind === 'crc' || o.algorithm.kind === 'crc32b' ? file !== '-' : named && o.files.length > 0;
      await writeBytes(ctx.stdout, encodeLossless(`${line}${showName ? ` ${file}` : ''}\n`));
      continue;
    }
    if (o.raw) { await writeBytes(ctx.stdout, result); continue; }
    const value = o.base64 ? toBase64(result) : hex(result);
    const { name, escaped } = escapeName(file, o.zero);
    const line = o.tag
      ? `${escaped ? '\\' : ''}${tagOf(o)} (${name}) = ${value}${end}`
      : `${escaped ? '\\' : ''}${value} ${o.binary ? '*' : ' '}${name}${end}`;
    await writeBytes(ctx.stdout, encodeLossless(line));
  }
  return status;
}

// ── -c ──

async function checkFiles(ctx: CommandContext, o: Options): Promise<number> {
  const lists = o.files.length > 0 ? o.files : ['-'];
  let status = 0;
  const say = async (text: string) => { if (!o.status) await ctx.stdout.write(text); };
  const warn = async (text: string) => { if (!o.status) await ctx.stderr.write(`${o.program}: ${text}\n`); };
  const algoName = o.algorithm.kind === 'digest' ? tagOf(o) : '';
  for (const list of lists) {
    let text: string;
    try {
      const parts: Uint8Array[] = [];
      for await (const chunk of inputChunks(ctx, list)) parts.push(chunk);
      text = decodeLossless(concatBytes(parts));
    } catch (error) {
      await ctx.stderr.write(`${o.program}: ${list}: ${fsErrorText(error)}\n`);
      status = 1;
      continue;
    }
    const lines = text.split(o.zero ? '\0' : '\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let formatted = 0, badFormat = 0, mismatched = 0, unreadable = 0, matched = 0;
    for (const [index, raw] of lines.entries()) {
      let line = raw.replace(/\r$/, '');
      let escaped = false;
      if (line.startsWith('\\')) { escaped = true; line = line.slice(1); }
      let want: string | null = null;
      let name: string | null = null;
      let bits = o.bits;
      const tagged = /^(\w+(?:-\d+)?) \((.*)\) = ([0-9A-Za-z+/=]+)$/.exec(line);
      if (tagged) {
        const [, tag, n, value] = tagged;
        const expected = o.algorithm.kind === 'digest' ? o.algorithm.tag : '';
        const m = /^BLAKE2b-(\d+)$/.exec(tag);
        if (tag === expected || tag === algoName || (m && o.algorithm.kind === 'digest' && o.algorithm.name === 'blake2b')) {
          if (m) bits = Number(m[1]);
          want = value; name = n;
        }
      } else {
        const plain = /^([0-9A-Fa-f]+) [ *](.*)$/.exec(line);
        if (plain && plain[1].length * 4 === o.bits) { want = plain[1].toLowerCase(); name = plain[2]; }
      }
      if (want !== null && name !== null && escaped) name = unescapeName(name);
      if (want === null || name === null || name === '') {
        badFormat++;
        if (o.warn) await warn(`${list}: ${index + 1}: improperly formatted ${algoName || o.program} checksum line`);
        continue;
      }
      formatted++;
      let got: Uint8Array;
      try {
        const r = await hashFile(ctx, name, { ...o, bits });
        got = r as Uint8Array;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (o.ignoreMissing && code === 'ENOENT') continue;
        unreadable++;
        await ctx.stderr.write(`${o.program}: ${name}: ${fsErrorText(error)}\n`);
        await say(`${name}: FAILED open or read\n`);
        continue;
      }
      const value = /^[0-9a-f]+$/.test(want) && want.length === got.length * 2 ? hex(got) : toBase64(got);
      // The name is reported as the line wrote it, escapes and all.
      const shown = escapeName(name, o.zero);
      const label = `${shown.escaped ? '\\' : ''}${shown.name}`;
      if (value === want) { matched++; if (!o.quiet) await say(`${label}: OK\n`); }
      else { mismatched++; await say(`${label}: FAILED\n`); }
    }
    if (formatted === 0) {
      await ctx.stderr.write(`${o.program}: ${list === '-' ? 'standard input' : list}: no properly formatted checksum lines found\n`);
      status = 1;
      continue;
    }
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    if (badFormat > 0) await warn(`WARNING: ${plural(badFormat, 'line is', 'lines are')} improperly formatted`);
    if (unreadable > 0) await warn(`WARNING: ${plural(unreadable, 'listed file could not be read', 'listed files could not be read')}`);
    if (mismatched > 0) await warn(`WARNING: ${plural(mismatched, 'computed checksum did NOT match', 'computed checksums did NOT match')}`);
    if (o.ignoreMissing && matched === 0 && mismatched === 0 && unreadable === 0) {
      await warn(`${list}: no file was verified`);
      status = 1;
    }
    if (mismatched > 0 || unreadable > 0 || (o.strict && badFormat > 0)) status = 1;
  }
  return status;
}

// ── commands ──

function makeCommand(program: string, fixed: Algorithm | null): Command {
  return async (ctx) => {
    const usage = async (message: string) => {
      await ctx.stderr.write(`${program}: ${message}\nTry '${program} --help' for more information.\n`);
      return 1;
    };
    const o: Options = {
      program, algorithm: fixed ?? { kind: 'crc' }, bits: 0, binary: false, tag: false, zero: false,
      base64: false, raw: false, check: false, ignoreMissing: false, quiet: false, status: false,
      strict: false, warn: false, files: [],
    };
    let length: number | null = null;
    let untagged = false;
    const sumMode = program === 'sum';
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { o.files.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
        const value = () => inline ?? args[++i];
        switch (name) {
          case 'binary': o.binary = true; break;
          case 'text': o.binary = false; break;
          case 'tag': o.tag = true; break;
          case 'untagged': untagged = true; break;
          case 'zero': o.zero = true; break;
          case 'check': o.check = true; break;
          case 'ignore-missing': o.ignoreMissing = true; break;
          case 'quiet': o.quiet = true; break;
          case 'status': o.status = true; break;
          case 'strict': o.strict = true; break;
          case 'warn': o.warn = true; break;
          case 'base64': o.base64 = true; break;
          case 'raw': o.raw = true; break;
          case 'debug': break;
          case 'length': length = Number(value()); break;
          case 'algorithm': {
            const a = value();
            if (fixed !== null) return usage(`unrecognized option '--algorithm'`);
            if (a in DIGESTS) o.algorithm = digestAlgorithm(a);
            else if (a === 'crc' || a === 'crc32b' || a === 'bsd' || a === 'sysv') o.algorithm = { kind: a };
            else return usage(`invalid argument \u2018${a}\u2019 for \u2018--algorithm\u2019`);
            break;
          }
          case 'sysv': if (sumMode) { o.algorithm = { kind: 'sysv' }; break; }
          // falls through
          default: return usage(`unrecognized option '--${name}'`);
        }
        continue;
      }
      if (!arg.startsWith('-') || arg === '-') { o.files.push(arg); continue; }
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if ((flag === 'l' && program !== 'sum') || (flag === 'a' && fixed === null)) {
          let value: string | undefined = arg.slice(j + 1);
          if (value === '') value = args[++i];
          if (value === undefined) return usage(`option requires an argument -- '${flag}'`);
          if (flag === 'l') length = Number(value);
          else if (value in DIGESTS) o.algorithm = digestAlgorithm(value);
          else if (value === 'crc' || value === 'crc32b' || value === 'bsd' || value === 'sysv') o.algorithm = { kind: value };
          else return usage(`invalid argument \u2018${value}\u2019 for \u2018--algorithm\u2019`);
          break;
        }
        if (sumMode && flag === 'r') { o.algorithm = { kind: 'bsd' }; continue; }
        if (sumMode && flag === 's') { o.algorithm = { kind: 'sysv' }; continue; }
        if (sumMode) return usage(`invalid option -- '${flag}'`);
        if (flag === 'b') o.binary = true;
        else if (flag === 't') o.binary = false;
        else if (flag === 'c') o.check = true;
        else if (flag === 'w') o.warn = true;
        else if (flag === 'z') o.zero = true;
        else return usage(`invalid option -- '${flag}'`);
      }
    }
    if (length !== null && (o.algorithm.kind !== 'digest' || o.algorithm.name !== 'blake2b')) {
      await ctx.stderr.write(`${program}: --length is only supported with --algorithm=blake2b\n`);
      return 1;
    }
    if (o.algorithm.kind === 'digest') {
      o.bits = o.algorithm.bits;
      if (length !== null) {
        // Over the maximum is the maximum (GNU); 0 is the default.
        if (!Number.isInteger(length) || length % 8 !== 0 || length < 0) {
          await ctx.stderr.write(`${program}: invalid length: \u2018${length}\u2019\n${program}: length is not a multiple of 8\n`);
          return 1;
        }
        if (length > 0) o.bits = Math.min(length, 512);
      }
      // cksum tags its digests unless told not to; the *sum tools tag with --tag.
      if (fixed === null) o.tag = !untagged;
    }
    return o.check ? checkFiles(ctx, o) : sumFiles(ctx, o);
  };
}

export const md5sum = makeCommand('md5sum', digestAlgorithm('md5'));
export const sha1sum = makeCommand('sha1sum', digestAlgorithm('sha1'));
export const sha224sum = makeCommand('sha224sum', digestAlgorithm('sha224'));
export const sha256sum = makeCommand('sha256sum', digestAlgorithm('sha256'));
export const sha384sum = makeCommand('sha384sum', digestAlgorithm('sha384'));
export const sha512sum = makeCommand('sha512sum', digestAlgorithm('sha512'));
export const b2sum = makeCommand('b2sum', digestAlgorithm('blake2b'));
export const cksum = makeCommand('cksum', null);
export const sum = makeCommand('sum', { kind: 'bsd' });

