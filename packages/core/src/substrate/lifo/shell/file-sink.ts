/**
 * A redirection's file, written in blocks.
 *
 * Commands write what they produce as it comes: `yes` 8 KiB at a time, `head`
 * whatever its pipe hands it. Each write to a file rewrites the file's last,
 * still-growing chunk (content-defined chunks average 32 KiB), so 8 KiB writes
 * stored several bytes for each byte of the file, and in a Durable Object
 * every event-loop turn that wrote waits for its commit: `yes | head -c 48M
 * > f` took 79 s on a local workerd with yes yielding every 512 KiB, and more
 * than 120 s before; written in 1 MiB blocks it took 2.7 s.
 *
 * So the sink holds what a command writes and writes it to the file in blocks,
 * as a program's stdio buffer does for a file: when a block is full, when the
 * shell flushes the command's descriptors (the command has ended: every
 * command that wrote the file, through its own redirection or one `exec`
 * keeps), when it closes, and at most LATENCY_MS after the oldest byte it
 * holds, so a reader of a long-running writer's file (`server > log &` and
 * `tail log`) sees it promptly. Writes reach the file in the order they were
 * made. A failed write is reported by the write, flush or close after it.
 */

import type { CommandOutputStream } from '../commands/types.js';

/** A pending timer, as the host's setTimeout returns it (a number in workerd, an object in Bun and Node). */
type Timer = Parameters<typeof clearTimeout>[0];

/** A block written whole: what a file write carries once one is full. */
const BLOCK_BYTES = 1 << 20;
/** The longest a byte waits for its block, so a slow writer's file stays current. */
const LATENCY_MS = 100;

export interface FileSink extends CommandOutputStream {
  writeBytes(bytes: Uint8Array): Promise<void>;
  /** Write what is held to the file; resolves once it is there. */
  flush(): Promise<void>;
}

/** A sink over `write`, which writes bytes at the file's position and resolves once they are written. */
export function fileSink(write: (bytes: Uint8Array) => Promise<void>): FileSink {
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let timer: Timer | null = null;
  // Flushes run one after another, so blocks land in the order written.
  let flushing: Promise<void> = Promise.resolve();
  let failure: unknown = null;

  const raise = (): void => {
    if (failure === null) return;
    const error = failure;
    failure = null;
    throw error;
  };

  const writeHeld = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (heldBytes === 0) return;
    const block = held.length === 1 ? held[0] : new Uint8Array(heldBytes);
    if (held.length > 1) {
      let at = 0;
      for (const piece of held) { block.set(piece, at); at += piece.length; }
    }
    held = [];
    heldBytes = 0;
    await write(block);
  };

  const flush = (): Promise<void> => {
    const next = flushing.then(writeHeld);
    flushing = next.catch(() => {});
    return next;
  };

  const writeBytes = async (bytes: Uint8Array): Promise<void> => {
    raise();
    if (bytes.length === 0) return;
    // A copy: a writer may reuse its buffer once the write resolves.
    held.push(bytes.slice());
    heldBytes += bytes.length;
    if (heldBytes >= BLOCK_BYTES) {
      await flush();
      return;
    }
    timer ??= setTimeout(() => {
      timer = null;
      flush().catch((error: unknown) => { failure = error; });
    }, LATENCY_MS);
  };

  return {
    write: (text: string) => writeBytes(new TextEncoder().encode(text)),
    writeBytes,
    flush: async () => {
      raise();
      await flush();
    },
  };
}
