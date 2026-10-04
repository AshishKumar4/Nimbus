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
 * (ReadAheadBudget), shared by its concurrent launches as they read: a launch
 * the budget cannot cover streams the rest of its pipe. Measured on a
 * throwaway (2026-09-30;
 * GraphQL durableObjectsPeriodicGroups, max memoryUsageBytes of the session
 * object per minute; `yes | head -c N | node -e "fs.readFileSync(0)"`):
 * one 16 MiB read ahead at a time peaked at 59.5-82.0 MB of the 128 MB
 * isolate, no higher than the same session's ordinary `echo x | node` launch
 * (71.8-82.0 MB); three at once peaked at 115.2 MB, too close to the limit,
 * whose reset ends every process in the session.
 */
export declare const STDIN_SYNC_READ_BYTES: number;
/**
 * What one launch holds of a ReadAheadBudget: bytes taken as they are about to
 * be read, and given back as the program takes them.
 */
export interface ReadAheadAccount {
    /** Bytes this launch holds now. */
    readonly held: number;
    /** Take up to `max` bytes from the budget; returns how many it got (0 when none is free). */
    take(max: number): number;
    /** Give back `n` bytes (all this launch holds when omitted); never more than it holds. */
    give(n?: number): void;
}
/**
 * The session's pipe read-ahead budget. It counts the bytes of read ahead the
 * session's Durable Object holds, not what launches might hold: a launch takes
 * bytes from it a piece at a time, just before reading that piece, so a launch
 * waiting on a slow writer holds almost none of it. A launch the budget cannot
 * cover stops reading ahead and streams the rest; it gives back what it did
 * not read at once, each piece as the program takes it, and the rest however
 * the launch ends (exit, abort, a failed launch).
 */
export declare class ReadAheadBudget {
    readonly capacity: number;
    private heldBytes;
    private peakBytes;
    constructor(capacity: number);
    /** Bytes held now, across all launches. */
    get held(): number;
    /** The most bytes held at once since the budget was made: never past its capacity. */
    get peak(): number;
    /** An account for one launch's read ahead. */
    open(): ReadAheadAccount;
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