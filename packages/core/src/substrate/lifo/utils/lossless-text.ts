// Lossless text: bytes as a string and back without loss, the shell's
// text for bytes that may not be UTF-8 (decodeLossless). Pure codecs, with
// no file system, so the lexer can read escapes with them (bytes-io.ts holds
// the I/O over them).
import { concatBytes as concatParts, enc, nameDec } from '../../../_shared/bytes.js';

/**
 * {@link decodeLossless} across writes: a sequence a write leaves unfinished
 * is held for the next, so a character split between writes decodes whole;
 * what is held at the end decodes byte by byte, as decodeLossless has it.
 */
export class LosslessDecoder {
  private held: Uint8Array = NOTHING_HELD;

  decode(bytes: Uint8Array): string {
    const all = this.held.length === 0 ? bytes : concatParts([this.held, bytes]);
    const cut = unfinishedTail(all);
    this.held = cut === all.length ? NOTHING_HELD : all.slice(cut);
    return decodeLossless(cut === all.length ? all : all.subarray(0, cut));
  }

  end(): string {
    const rest = this.held;
    this.held = NOTHING_HELD;
    return rest.length === 0 ? '' : decodeLossless(rest);
  }
}

const NOTHING_HELD = new Uint8Array(0);

/** Where a UTF-8 sequence that `bytes` ends inside begins: their length when none does. */
function unfinishedTail(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const at = bytes.length - back;
    const b = bytes[at];
    if (b >= 0x80 && b < 0xc0) continue;
    const length = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xc2 && b < 0xe0 ? 2 : 1;
    return length > back ? at : bytes.length;
  }
  return bytes.length;
}

/**
 * Bytes as a string without loss: valid UTF-8 decodes to its characters,
 * and every byte of an invalid sequence to U+DC80 + byte (a lone surrogate,
 * which valid UTF-8 never produces). `encodeLossless` inverts it exactly.
 */
export function decodeLossless(bytes: Uint8Array): string {
  // Valid UTF-8, nearly all of it, decodes natively; only bytes that are not take the walk below.
  try {
    return validUtf8.decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  let out = '';
  let run = 0;
  const flush = (end: number) => {
    if (end > run) out += nameDec.decode(bytes.subarray(run, end));
  };
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }
    const len = utf8SequenceLength(bytes, i);
    if (len > 0) { i += len; continue; }
    flush(i);
    out += String.fromCharCode(0xdc00 + b);
    i++;
    run = i;
  }
  flush(bytes.length);
  return out;
}

/** Valid UTF-8, decoded as the walk's runs are: a leading U+FEFF kept, as every other character (_shared/bytes.ts nameDec). */
const validUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The length of the valid UTF-8 sequence at `i`, or 0. */
export function utf8SequenceLength(bytes: Uint8Array, i: number): number {
  const b = bytes[i];
  if (b < 0x80) return 1;
  const cont = (k: number) => i + k < bytes.length && (bytes[i + k] & 0xc0) === 0x80;
  if (b >= 0xc2 && b <= 0xdf) return cont(1) ? 2 : 0;
  if (b >= 0xe0 && b <= 0xef) {
    if (!cont(1) || !cont(2)) return 0;
    const b1 = bytes[i + 1];
    if (b === 0xe0 && b1 < 0xa0) return 0;
    if (b === 0xed && b1 >= 0xa0) return 0;
    return 3;
  }
  if (b >= 0xf0 && b <= 0xf4) {
    if (!cont(1) || !cont(2) || !cont(3)) return 0;
    const b1 = bytes[i + 1];
    if (b === 0xf0 && b1 < 0x90) return 0;
    if (b === 0xf4 && b1 >= 0x90) return 0;
    return 4;
  }
  return 0;
}

/**
 * `head` then `tail`, lossless text joined as their bytes join. A high
 * surrogate ending `head` is half a character (the shell can cut one), and
 * a byte (U+DC80..U+DCFF) starting `tail` would read as its other half: that
 * half goes as what it encodes to alone, U+FFFD, and the byte stays a byte.
 */
export function joinLossless(head: string, tail: string): string {
  const first = tail.charCodeAt(0);
  if (first >= 0xdc80 && first <= 0xdcff && isHigh(head.charCodeAt(head.length - 1))) return head.slice(0, -1) + '\ufffd' + tail;
  return head + tail;
}

/** Where the first byte decodeLossless kept as U+DC80 + byte is in `text`, or -1. */
export function firstLosslessByte(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && isHigh(text.charCodeAt(i - 1)))) return i;
  }
  return -1;
}

/** The inverse of `decodeLossless`. */
export function encodeLossless(text: string): Uint8Array {
  const first = firstLosslessByte(text);
  if (first === -1) return enc.encode(text);
  const parts: Uint8Array[] = [];
  let run = 0;
  for (let i = first; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff && !(i > 0 && isHigh(text.charCodeAt(i - 1)))) {
      if (i > run) parts.push(enc.encode(text.slice(run, i)));
      parts.push(Uint8Array.of(c - 0xdc00));
      run = i + 1;
    }
  }
  if (run < text.length) parts.push(enc.encode(text.slice(run)));
  return parts.length === 1 ? parts[0] : concatParts(parts);
}

function isHigh(c: number): boolean { return c >= 0xd800 && c <= 0xdbff; }
