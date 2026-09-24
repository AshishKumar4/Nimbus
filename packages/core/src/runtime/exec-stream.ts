/**
 * runtime/exec-stream.ts — a command's output while it runs.
 *
 * `output` yields stdout and stderr chunks, as bytes, in the order the command
 * wrote them; `exit` settles once the last chunk is queued. The stream is
 * pull-based: a writer awaits room below {@link EXEC_STREAM_HIGH_WATER_BYTES}
 * before its next write, so a slow reader slows the command instead of
 * growing a buffer. Cancelling `output` kills the command and rejects `exit`
 * with the cancel reason.
 *
 * Across a Durable Object RPC or an HTTP body the same stream travels as one
 * byte stream of frames (`encodeExecStream` / `decodeExecStream`), so both
 * boundaries keep the platform's own stream backpressure.
 */

import { z } from 'zod/v4';
import { enc } from '../_shared/bytes.js';

export type ExecStreamName = 'stdout' | 'stderr';

export interface ExecChunk {
  stream: ExecStreamName;
  data: Uint8Array;
}

export interface ExecExit {
  command: string;
  exitCode: number;
  success: boolean;
  duration: number;
  timestamp: number;
}

export interface ExecStream {
  output: ReadableStream<ExecChunk>;
  exit: Promise<ExecExit>;
}

export interface ExecOutput extends ExecExit {
  stdout: string;
  stderr: string;
}

/** Output a writer may run ahead of its reader before its writes wait. */
export const EXEC_STREAM_HIGH_WATER_BYTES = 64 * 1024;

// Consecutive writes to one stream are joined up to this size, or until the
// next macrotask, so a line-at-a-time command is not a chunk per line.
const COALESCE_BYTES = 16 * 1024;

/** Content type of an HTTP body carrying an encoded exec stream. */
export const EXEC_STREAM_CONTENT_TYPE = 'application/vnd.nimbus.exec-stream';

export interface ExecStreamWriter {
  readonly stream: ExecStream;
  /** Queue a chunk; resolves when the reader has room for more. Dropped once the stream settled. */
  write(stream: ExecStreamName, data: Uint8Array): Promise<void>;
  end(exit: ExecExit): void;
  fail(error: unknown): void;
}

export function createExecStream(onCancel: (reason: unknown) => void): ExecStreamWriter {
  let controller!: ReadableStreamDefaultController<ExecChunk>;
  let settled = false;
  let room: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const openRoom = () => {
    release?.();
    release = null;
    room = null;
  };
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let pendingStream: ExecStreamName = 'stdout';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (settled || pendingBytes === 0) return;
    let data = pending[0];
    if (pending.length > 1) {
      data = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        data.set(part, offset);
        offset += part.byteLength;
      }
    }
    pending = [];
    pendingBytes = 0;
    controller.enqueue({ stream: pendingStream, data });
  };
  const settle = () => {
    settled = true;
    clearTimeout(flushTimer);
    pending = [];
    pendingBytes = 0;
    openRoom();
  };
  let resolveExit!: (exit: ExecExit) => void;
  let rejectExit!: (reason: unknown) => void;
  const exit = new Promise<ExecExit>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // A reader that cancels need not also await the rejection it caused.
  exit.catch(() => {});

  const output = new ReadableStream<ExecChunk>({
    start(c) { controller = c; },
    pull() { openRoom(); },
    cancel(reason) {
      if (settled) return;
      settle();
      rejectExit(reason ?? new Error('exec output cancelled'));
      onCancel(reason);
    },
  }, { highWaterMark: EXEC_STREAM_HIGH_WATER_BYTES, size: (chunk) => chunk.data.byteLength });

  return {
    stream: { output, exit },
    async write(stream, data) {
      if (settled || data.byteLength === 0) return;
      if (pendingBytes > 0 && stream !== pendingStream) flush();
      pendingStream = stream;
      pending.push(data);
      pendingBytes += data.byteLength;
      if (pendingBytes >= COALESCE_BYTES) flush();
      else flushTimer ??= setTimeout(flush, 0);
      if ((controller.desiredSize ?? 0) > 0) return;
      room ??= new Promise<void>((resolve) => { release = resolve; });
      await room;
    },
    end(record) {
      if (settled) return;
      flush();
      settle();
      controller.close();
      resolveExit(record);
    },
    fail(error) {
      if (settled) return;
      settle();
      controller.error(error);
      rejectExit(error);
    },
  };
}

/** Read the whole stream into strings: the buffered exec result. */
export async function collectExecStream(stream: ExecStream): Promise<ExecOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  for await (const chunk of stream.output as unknown as AsyncIterable<ExecChunk>) {
    const text = decoders[chunk.stream].decode(chunk.data, { stream: true });
    if (text) (chunk.stream === 'stdout' ? stdout : stderr).push(text);
  }
  stdout.push(decoders.stdout.decode());
  stderr.push(decoders.stderr.decode());
  const exit = await stream.exit;
  return { ...exit, stdout: stdout.join(''), stderr: stderr.join('') };
}

// ── Wire framing: [kind u8][length u32 BE][payload] ─────────────────────────

const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;
const FRAME_ERROR = 4;
const HEADER_BYTES = 5;

const ExitFrameSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  duration: z.number(),
  timestamp: z.number(),
});
const ErrorFrameSchema = z.object({ message: z.string() });

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.byteLength);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** One byte stream carrying `stream`'s chunks, then its exit or failure. */
export function encodeExecStream(stream: ExecStream): ReadableStream<Uint8Array> {
  const reader = stream.output.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<ExecChunk>;
      let exit: ExecExit;
      try {
        next = await reader.read();
        if (!next.done) {
          controller.enqueue(frame(next.value.stream === 'stdout' ? FRAME_STDOUT : FRAME_STDERR, next.value.data));
          return;
        }
        exit = await stream.exit;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(frame(FRAME_ERROR, enc.encode(JSON.stringify({ message }))));
        controller.close();
        return;
      }
      controller.enqueue(frame(FRAME_EXIT, enc.encode(JSON.stringify(exit))));
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/** The inverse of `encodeExecStream`; frames may arrive split or joined in any way. */
export function decodeExecStream(wire: ReadableStream<Uint8Array>): ExecStream {
  const reader = wire.getReader();
  const pending: Uint8Array[] = [];
  let buffered = 0;
  let finished = false;
  let resolveExit!: (exit: ExecExit) => void;
  let rejectExit!: (reason: unknown) => void;
  const exit = new Promise<ExecExit>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  exit.catch(() => {});

  const take = (n: number): Uint8Array => {
    const head = pending[0];
    if (head.byteLength >= n) {
      const out = head.subarray(0, n);
      if (head.byteLength === n) pending.shift();
      else pending[0] = head.subarray(n);
      buffered -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const part = pending[0];
      const count = Math.min(part.byteLength, n - filled);
      out.set(part.subarray(0, count), filled);
      filled += count;
      if (count === part.byteLength) pending.shift();
      else pending[0] = part.subarray(count);
    }
    buffered -= n;
    return out;
  };
  const peekHeader = (): { kind: number; length: number } | null => {
    if (buffered < HEADER_BYTES) return null;
    const header = new Uint8Array(HEADER_BYTES);
    let filled = 0;
    for (const part of pending) {
      const count = Math.min(part.byteLength, HEADER_BYTES - filled);
      header.set(part.subarray(0, count), filled);
      filled += count;
      if (filled === HEADER_BYTES) break;
    }
    return { kind: header[0], length: new DataView(header.buffer).getUint32(1) };
  };
  const fail = (controller: ReadableStreamDefaultController<ExecChunk>, error: Error) => {
    finished = true;
    controller.error(error);
    rejectExit(error);
  };

  const output = new ReadableStream<ExecChunk>({
    async pull(controller) {
      for (;;) {
        const header = peekHeader();
        if (header && buffered >= HEADER_BYTES + header.length) {
          take(HEADER_BYTES);
          const payload = take(header.length);
          switch (header.kind) {
            case FRAME_STDOUT:
            case FRAME_STDERR:
              controller.enqueue({ stream: header.kind === FRAME_STDOUT ? 'stdout' : 'stderr', data: payload });
              return;
            case FRAME_EXIT:
            case FRAME_ERROR: {
              let parsed: ExecExit | { message: string };
              try {
                const json = JSON.parse(new TextDecoder().decode(payload));
                parsed = header.kind === FRAME_EXIT ? ExitFrameSchema.parse(json) : ErrorFrameSchema.parse(json);
              } catch (error) {
                fail(controller, new Error(`exec stream: malformed ${header.kind === FRAME_EXIT ? 'exit' : 'error'} frame: ${error instanceof Error ? error.message : String(error)}`));
                await reader.cancel().catch(() => {});
                return;
              }
              if ('message' in parsed) {
                fail(controller, new Error(parsed.message));
                return;
              }
              finished = true;
              controller.close();
              resolveExit(parsed);
              return;
            }
            default:
              fail(controller, new Error(`exec stream: unknown frame kind ${header.kind}`));
              await reader.cancel().catch(() => {});
              return;
          }
        }
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          fail(controller, error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (next.done) {
          fail(controller, new Error('exec stream ended before the command exited'));
          return;
        }
        if (next.value.byteLength > 0) {
          pending.push(next.value);
          buffered += next.value.byteLength;
        }
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      rejectExit(reason ?? new Error('exec output cancelled'));
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });

  return { output, exit };
}
