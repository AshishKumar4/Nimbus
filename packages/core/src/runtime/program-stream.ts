/**
 * runtime/program-stream.ts — a program a session started by its argv
 * (NimbusWorkspace.startProgram), across a Durable Object RPC or an HTTP
 * body: one byte stream of frames, as an exec stream travels (exec-stream.ts).
 * Its first frame is the start's answer (started, with its pid, or refused,
 * with Node's spawn error); then its output, as its reader takes it; then
 * its exit, waitpid's. Cancelling the stream before the start cancels the
 * start; after it, the program is sent SIGKILL. Decoded, its output is read
 * ahead a pipe's worth, so a program whose output fits is seen to exit with
 * that output unread.
 */
import { z } from 'zod/v4';
import { enc } from '../_shared/bytes.js';
import { createFrameReader, frame } from './exec-stream.js';
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

/** What a decoded program's output holds unread before the wire waits for its reader: Linux's pipe capacity. */
const PIPE_BYTES = 64 * 1024;

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
  // Once its answer is sent: the program and the one reader of its output, taken by the pull that sent it.
  let running: { program: StartedSessionProgram; output: ReadableStreamDefaultReader<ExecChunk> } | null = null;
  // Its reader has gone: a pull that resumes after it sends nothing more.
  let gone = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (running === null) {
          let program: StartedSessionProgram;
          try {
            program = await starting;
          } catch (error) {
            if (gone) return;
            const refused = refusalOf(error);
            controller.enqueue(refused === null
              ? json(FRAME_FAILED, { message: error instanceof Error ? error.message : String(error) })
              : json(FRAME_REFUSED, refused));
            controller.close();
            return;
          }
          // Gone as the answer came: the cancel ends what it started.
          if (gone) return;
          running = { program, output: program.output.getReader() };
          controller.enqueue(json(FRAME_STARTED, { pid: program.pid }));
          return;
        }
        const next = await running.output.read();
        if (gone) return;
        if (!next.done) {
          controller.enqueue(frame(next.value.stream === 'stdout' ? FRAME_STDOUT : FRAME_STDERR, next.value.data));
          return;
        }
        const exit = await running.program.exit;
        if (gone) return;
        controller.enqueue(json(FRAME_EXIT, exit));
        controller.close();
      } catch (error) {
        if (gone) return;
        controller.enqueue(json(FRAME_FAILED, { message: error instanceof Error ? error.message : String(error) }));
        controller.close();
      }
    },
    async cancel(reason) {
      gone = true;
      if (running !== null) {
        running.program.kill('SIGKILL');
        await running.output.cancel(reason);
        return;
      }
      // Its answer not yet sent: a start still pending is cancelled; one that ran all the same is killed.
      cancel.abort(reason);
      await starting.then((program) => {
        program.kill('SIGKILL');
        return program.output.cancel(reason);
      }, () => {});
    },
  }, { highWaterMark: 0 });
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
  cancel?: AbortSignal,
): Promise<StartedSessionProgram> {
  const reading = createFrameReader(wire);
  // A caller that gives up before the start's answer cancels the stream: the start, or what it ran.
  const giveUp = (): void => { void reading.cancel(cancel?.reason); };
  cancel?.addEventListener('abort', giveUp, { once: true });
  let first: Awaited<ReturnType<typeof reading.next>>;
  try {
    if (cancel?.aborted) throw cancel.reason;
    first = await reading.next();
  } catch (error) {
    if (cancel?.aborted) {
      giveUp();
      throw Object.assign(new Error('spawn: operation canceled'), { code: 'ECANCELED', errno: -125 });
    }
    throw error;
  } finally {
    cancel?.removeEventListener('abort', giveUp);
  }
  if (first === null && cancel?.aborted) throw Object.assign(new Error('spawn: operation canceled'), { code: 'ECANCELED', errno: -125 });
  if (first === null) throw new Error('program stream: it ended before the start\'s answer');
  if (first.kind === FRAME_REFUSED) {
    const refused = parse(RefusedFrameSchema, first.payload);
    throw Object.assign(new Error(refused.message), { code: refused.code, errno: refused.errno, syscall: refused.syscall, path: refused.path, spawnargs: refused.spawnargs });
  }
  if (first.kind !== FRAME_STARTED) throw new Error(first.kind === FRAME_FAILED ? parse(FailedFrameSchema, first.payload).message : `program stream: frame ${first.kind} before the start's answer`);
  const { pid } = parse(StartedFrameSchema, first.payload);
  let settle: { resolve: (exit: ExitStatus) => void; reject: (reason: unknown) => void } = { resolve: () => {}, reject: () => {} };
  const exit = new Promise<ExitStatus>((resolve, reject) => { settle = { resolve, reject }; });
  exit.catch(() => {});
  // Read ahead of its reader up to a pipe's worth, as a pipe holds what a program wrote: a program whose
  // output fits is seen to exit whether or not that output is read; one that writes more waits for its reader.
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
  }, { highWaterMark: PIPE_BYTES, size: (chunk) => chunk.data.byteLength });
  return { pid, output, exit, kill: (sent) => signal(pid, sent) };
}
