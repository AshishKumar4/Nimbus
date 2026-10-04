import { REPLAY_FETCH_MAX_BYTES, type ReplayFailure } from './stop-replay-contracts.js';
import { OwnedPieces } from './stop-replay-host.js';

/** Bounded recording and incremental digest; never delay response headers. */
export class ReplayBodyRecord {
  private pieces = new OwnedPieces();
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;
  private chunks: number[] = [];
  over = false;
  add(bytes: Uint8Array): void {
    if (this.over) return;
    if (this.pieces.bytes + bytes.byteLength > REPLAY_FETCH_MAX_BYTES) {
      this.over = true; this.pieces = new OwnedPieces(); return;
    }
    for (const byte of bytes) {
      this.a = Math.imul(this.a ^ byte, 16777619) >>> 0;
      this.b = Math.imul(this.b ^ (byte + 0x9e), 2246822519) >>> 0;
    }
    this.pieces.add(bytes);
    this.chunks.push(bytes.byteLength);
  }
  finish(): { body: Uint8Array; digest: string; chunks: number[] } | { tooLarge: true } {
    if (this.over) return { tooLarge: true };
    const body = new Uint8Array(this.pieces.bytes);
    let at = 0;
    for (const piece of this.pieces.finish()) { body.set(piece, at); at += piece.length; }
    return { body, chunks: this.chunks, digest: this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0') };
  }
}

/** The same error shape is delivered live and on replay, including its cause. */
export function recordFailure(error: unknown): ReplayFailure {
  const e = error instanceof Error ? error : new Error(String(error));
  const properties = Object.fromEntries(Object.getOwnPropertyNames(e)
    .filter((key) => !['name', 'message', 'stack', 'cause'].includes(key))
    .map((key) => [key, (e as unknown as Record<string, unknown>)[key]]));
  if (e.cause !== undefined && !(e.cause instanceof Error)) properties.cause = e.cause;
  return { name: e.name, message: e.message, stack: e.stack, properties,
    ...(e.cause instanceof Error ? { cause: recordFailure(e.cause) } : {}) };
}
export function failureOf(record: ReplayFailure): Error {
  const constructors: Record<string, ErrorConstructor> = { Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError };
  const error = new (constructors[record.name] ?? Error)(record.message);
  error.name = record.name;
  if (record.stack !== undefined) error.stack = record.stack;
  Object.assign(error, record.properties);
  if (record.cause) error.cause = failureOf(record.cause);
  return error;
}
