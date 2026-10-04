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
export interface FileSink extends CommandOutputStream {
    writeBytes(bytes: Uint8Array): Promise<void>;
    /** Write what is held to the file; resolves once it is there. */
    flush(): Promise<void>;
}
/** A sink over `write`, which writes bytes at the file's position and resolves once they are written. */
export declare function fileSink(write: (bytes: Uint8Array) => Promise<void>): FileSink;
//# sourceMappingURL=file-sink.d.ts.map