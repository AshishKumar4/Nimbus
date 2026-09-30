/**
 * Whether a program reads its stdin synchronously, judged from its code before
 * it runs.
 *
 * A pipe or redirect streams to a program as it arrives (runtime-registry.ts,
 * RuntimeRunOpts.stdin), so a program that ignores a pipe that never ends
 * (`tail -f log | node x.js`) still runs and exits. A synchronous read of
 * fd 0 cannot wait for input that arrives after it starts, though:
 * `slow-writer | node -e "JSON.parse(fs.readFileSync(0))"` would see a pipe
 * that had not ended yet. Node's blocking read waits for the writer. So a
 * program whose code makes such a read gets its whole stdin, read to the end
 * before it starts.
 *
 * The reads recognised are those of fd 0 or its device, however the fs
 * function was reached (`fs.readFileSync`, a destructured or imported
 * `readFileSync`, esbuild's `(0, import_fs.readFileSync)`):
 * `readFileSync(0)`, `readFileSync(process.stdin.fd)`,
 * `readFileSync('/dev/stdin')` (or `/dev/fd/0`, `/proc/self/fd/0`), and
 * `readSync` of fd 0 or `process.stdin.fd`. They are looked for anywhere in
 * the entry and in the program's own modules it loads directly
 * (server-launch.ts, resolveOwnModules), whether or not that code runs: the
 * read ahead is bounded (STDIN_SYNC_READ_BYTES), so waiting on a read that
 * never runs costs at most that, while a missed read fails with EAGAIN.
 */
import { type ServerLaunchHost } from './server-launch.js';
/**
 * How much of a pipe is read before a one-shot program that reads stdin
 * synchronously starts. A pipe that ends within it is all delivered first;
 * past it, the program starts with the pipe streaming and a synchronous read
 * fails naming this bound (node-shims.ts, __nimbusStdinWouldBlock), so an
 * endless writer (`yes | node x.js`) costs this much at most. It also bounds
 * what a synchronous reader of a `< file` redirect holds of the file (fd 0 is
 * the file; process.stdin streams the rest of it).
 *
 * A pipe's read ahead is held in the session Durable Object until the
 * program takes it, so this is one budget for the whole session
 * (ReadAheadBudget), shared by its concurrent launches: a launch that cannot
 * reserve it streams its pipe instead. Measured on a throwaway (2026-09-30;
 * GraphQL durableObjectsPeriodicGroups, max memoryUsageBytes of the session
 * object per minute; `yes | head -c N | node -e "fs.readFileSync(0)"`):
 * one 16 MiB read ahead at a time peaked at 59.5-82.0 MB of the 128 MB
 * isolate, no higher than the same session's ordinary `echo x | node` launch
 * (71.8-82.0 MB); three at once peaked at 115.2 MB, too close to the limit,
 * whose reset ends every process in the session.
 */
export declare const STDIN_SYNC_READ_BYTES: number;
/** A share of a ReadAheadBudget: `bytes` granted, released in parts or whole. */
export interface ReadAheadReservation {
    /** The bytes granted: at most what was asked, 0 when the budget had none free. */
    readonly bytes: number;
    /** Return `n` bytes of the grant (all that remain when omitted); idempotent past zero. */
    release(n?: number): void;
}
/**
 * The session's pipe read-ahead budget. A launch reserves its read ahead from
 * it before reading, gives back what it did not use as soon as the pipe
 * ended, gives back each piece as the program takes it, and releases the rest
 * however the launch ends (exit, abort, a failed launch).
 */
export declare class ReadAheadBudget {
    readonly capacity: number;
    private heldBytes;
    constructor(capacity: number);
    /** Bytes reserved now, across all launches. */
    get held(): number;
    reserve(max: number): ReadAheadReservation;
}
export interface StdinReadProgram {
    /** The entry's code, as it will run (after any TypeScript/ESM transform). */
    source: string;
    /** The entry's VFS key; null for `-e` programs. */
    path: string | null;
    /** The directory its relative modules resolve from. */
    dir: string;
    /** Modules outside this directory are not the program's own. */
    packageRoot: string;
}
/** Whether `program`, or one of its own modules it loads, reads stdin synchronously. */
export declare function programReadsStdinSync(program: StdinReadProgram, host: ServerLaunchHost): Promise<boolean>;
//# sourceMappingURL=stdin-read.d.ts.map