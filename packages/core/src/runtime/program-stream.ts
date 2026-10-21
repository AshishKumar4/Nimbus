/**
 * runtime/program-stream.ts — a program a session started by its argv
 * (NimbusWorkspace.startProgram), across a Durable Object RPC or an HTTP
 * body: one byte stream of frames, as an exec stream travels (exec-stream.ts).
 * Its first frame is the start's answer (started, with its pid, or refused,
 * with Node's spawn error); then its output, as its reader takes it; then
 * its exit, waitpid's. Cancelling the stream before the start cancels the
 * start; after it, the program is sent SIGKILL.
 */
import { z } from 'zod/v4';
import { enc } from '../_shared/bytes.js';
import { frame } from './exec-stream.js';
import type { ExecChunk } from './exec-stream.js';
import type { ExitStatus, StartedSessionProgram } from './program-start.js';

/** Content type of an HTTP body carrying an encoded program stream. */
export const PROGRAM_STREAM_CONTENT_TYPE = 'application/vnd.nimbus.program-stream';

const FRAME_STARTED = 1;
const FRAME_REFUSED = 2;
const FRAME_STDOUT = 3;
const FRAME_STDERR = 4;
const FRAME_EXIT = 5;
const FRAME_FAILED = 6;
const HEADER_BYTES = 5;

const StartedFrameSchema = z.object({ pid: z.number().int() });
/** Node's spawn error, as its own properties. */
const RefusedFrameSchema = z.object({
  message: z.string(), code: z.string(), errno: z.number(), syscall: z.string(), path: z.string(), spawnargs: z.array(z.string()),
});
const ExitFrameSchema = z.union([
  z.object({ code: z.number(), signal: z.null() }),
  z.object({ code: z.null(), signal: z.string() }),
]);
const FailedFrameSchema = z.object({ message: z.string() });

const json = (kind: number, value: object): Uint8Array => frame(kind, enc.encode(JSON.stringify(value)));

/** Node's spawn error as the frame carries it: what a refused start rejects with. */
function refusalOf(error: unknown): z.infer<typeof RefusedFrameSchema> | null {
  const parsed = RefusedFrameSchema.safeParse(typeof error === 'object' && error !== null
    ? { message: error instanceof Error ? error.message : String(error), ...error }
    : null);
  return parsed.success ? parsed.data : null;
}

/** The started program `start` makes (given the stream's own cancel), as one byte stream of frames. */
export function encodeProgramStream(start: (cancel: AbortSignal) => Promise<StartedSessionProgram>): ReadableStream<Uint8Array> {
  const cancel = new AbortController();
  const starting = start(cancel.signal);
  // A reader gone before the start's answer is read need not see its rejection.
  starting.catch(() => {});
  let started: StartedSessionProgram | null = null;
  let output: ReadableStreamDefaultReader<ExecChunk> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (started === null) {
          try {
            started = await starting;
          } catch (error) {
            const refused = refusalOf(error);
            controller.enqueue(refused === null
              ? json(FRAME_FAILED, { message: error instanceof Error ? error.message : String(error) })
              : json(FRAME_REFUSED, refused));
            controller.close();
            return;
          }
          output = started.output.getReader();
          controller.enqueue(json(FRAME_STARTED, { pid: started.pid }));
          return;
        }
        const next = await (output ?? started.output.getReader()).read();
        if (!next.done) {
          controller.enqueue(frame(next.value.stream === 'stdout' ? FRAME_STDOUT : FRAME_STDERR, next.value.data));
          return;
        }
        controller.enqueue(json(FRAME_EXIT, await started.exit));
        controller.close();
      } catch (error) {
        controller.enqueue(json(FRAME_FAILED, { message: error instanceof Error ? error.message : String(error) }));
        controller.close();
      }
    },
    async cancel(reason) {
      if (started === null) return cancel.abort(reason);
      started.kill('SIGKILL');
      await output?.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/** One frame at a time from `wire`, as its bytes arrive split or joined in any way; null at its end. */
function frames(wire: ReadableStream<Uint8Array>): { next(): Promise<{ kind: number; payload: Uint8Array } | null>; cancel(reason: unknown): Promise<void> } {
  const reader = wire.getReader();
  let buffered = new Uint8Array(0);
  return {
    async next() {
      for (;;) {
        if (buffered.byteLength >= HEADER_BYTES) {
          const length = new DataView(buffered.buffer, buffered.byteOffset).getUint32(1);
          if (buffered.byteLength >= HEADER_BYTES + length) {
            const kind = buffered[0];
            const payload = buffered.slice(HEADER_BYTES, HEADER_BYTES + length);
            buffered = buffered.subarray(HEADER_BYTES + length);
            return { kind, payload };
          }
        }
        const read = await reader.read();
        if (read.done) {
          if (buffered.byteLength > 0) throw new Error('program stream: it ended inside a frame');
          return null;
        }
        const joined = new Uint8Array(buffered.byteLength + read.value.byteLength);
        joined.set(buffered);
        joined.set(read.value, buffered.byteLength);
        buffered = joined;
      }
    },
    cancel: (reason) => reader.cancel(reason),
  };
}

const parse = <T>(schema: z.ZodType<T>, payload: Uint8Array): T => schema.parse(JSON.parse(new TextDecoder().decode(payload)));

/**
 * The inverse of encodeProgramStream: resolved with the started program
 * (its kill sent through `signal`), or rejected with the start's error, Node's
 * spawn error with its own properties.
 */
export async function decodeProgramStream(
  wire: ReadableStream<Uint8Array>,
  signal: (pid: number, signal: string) => void,
): Promise<StartedSessionProgram> {
  const reading = frames(wire);
  const first = await reading.next();
  if (first === null) throw new Error('program stream: it ended before the start\'s answer');
  if (first.kind === FRAME_REFUSED) {
    const refused = parse(RefusedFrameSchema, first.payload);
    throw Object.assign(new Error(refused.message), { code: refused.code, errno: refused.errno, syscall: refused.syscall, path: refused.path, spawnargs: refused.spawnargs });
  }
  if (first.kind !== FRAME_STARTED) throw new Error(first.kind === FRAME_FAILED ? parse(FailedFrameSchema, first.payload).message : `program stream: frame ${first.kind} before the start's answer`);
  const { pid } = parse(StartedFrameSchema, first.payload);
  let settle!: { resolve: (exit: ExitStatus) => void; reject: (reason: unknown) => void };
  const exit = new Promise<ExitStatus>((resolve, reject) => { settle = { resolve, reject }; });
  exit.catch(() => {});
  const output = new ReadableStream<ExecChunk>({
    async pull(controller) {
      try {
        const next = await reading.next();
        if (next === null) throw new Error('program stream: it ended before the program\'s exit');
        if (next.kind === FRAME_STDOUT || next.kind === FRAME_STDERR) {
          controller.enqueue({ stream: next.kind === FRAME_STDOUT ? 'stdout' : 'stderr', data: next.payload });
          return;
        }
        if (next.kind === FRAME_EXIT) {
          settle.resolve(parse(ExitFrameSchema, next.payload));
          controller.close();
          return;
        }
        throw new Error(next.kind === FRAME_FAILED ? parse(FailedFrameSchema, next.payload).message : `program stream: frame ${next.kind} after the start`);
      } catch (error) {
        settle.reject(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle.reject(reason ?? new Error('program output cancelled'));
      await reading.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return { pid, output, exit, kill: (sent) => signal(pid, sent) };
}
