/**
 * Processes and pipes for a WASI guest: the `nimbus_proc` imports.
 *
 * A guest without fork (git, built with NIMBUS_PROC: packages/worker/wasm/git)
 * starts a child as Windows does, naming the program, its arguments and
 * environment, its directory, and which of its own descriptors become the
 * child's 0, 1 and 2. The child is an ordinary session process, started
 * through the one child-process route every facet program uses (cpSpawn;
 * node's child_process takes the same route): it is in the process table,
 * runs as this process's credential, and can be signalled. Its standard
 * streams are always pipes on the session side; this module connects each to
 * whatever the guest named:
 *
 *   - a pipe the guest made (`pipe`): bytes the guest writes to its end go to
 *     the child's stdin (cpStdinWrite, cpStdinEnd when the last writer
 *     closes), bytes the child writes come into it (cpReadOutput);
 *   - the guest's own stdout or stderr: the child's output joins it;
 *   - nothing (-1, or the guest's stdin, which is empty): the child's stdin
 *     ends at once and its output is dropped.
 *
 * A guest's pipe descriptors read, write, close, poll (poll_oneoff) and take
 * O_NONBLOCK as POSIX's do; git's pipe_command polls a child's stdin and
 * stdout together.
 *
 * Coherence follows the process model (core README, "When a program sees a
 * change"): starting a child and writing to it are observations, so what the
 * guest holds of its writes goes to the session first (`release`); a child's
 * output and its exit are input, so the guest's next filesystem answer takes
 * the barrier (`inbound`).
 *
 * Every import answers 0 or a positive WASI errno; the C side
 * (git-wasi-compat.c) turns that into errno.
 */
import { filesystemErrno } from './filesystem.js';
/** WASI errno values these imports answer with. */
const E = { SUCCESS: 0, AGAIN: 6, BADF: 8, CHILD: 12, INTR: 27, INVAL: 28, IO: 29, NOSYS: 52, PIPE: 64, SRCH: 71 };
const FDFLAGS_NONBLOCK = 4;
/** Signal numbers as wasi-libc's emulated signals number them, and their names. */
const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 13: 'SIGPIPE', 15: 'SIGTERM' };
const SIGNAL_NUMBERS = Object.fromEntries(Object.entries(SIGNALS).map(([n, name]) => [name, Number(n)]));
/** How long one call to the session waits for a child's output or exit before asking again. */
const LONG_POLL_MS = 5_000;
const WNOHANG = 1;
/**
 * The longest a guest waits on a child in one call. A wasm stack suspended
 * past about 15 s in a facet never resumes (wasi/preamble.ts, park
 * watchdog), and a child may run for minutes, so a wait for its output or its
 * end gives up at this and answers EINTR, which git (xread, wait_or_whine,
 * pump_io's poll) retries. Under the watchdog's own 10 s, which still guards
 * poll_oneoff and would answer EAGAIN, which git's poll loop does not retry.
 */
export const PROCESS_PARK_MS = 8_000;
function newPipe() {
    return { chunks: [], writers: 0, readers: 0, waiters: [], forward: null, end: null, ended: false, failed: false };
}
function wake(pipe) {
    for (const waiter of pipe.waiters.splice(0))
        waiter();
}
export function processHost(opts) {
    const children = new Map();
    const view = () => new DataView(opts.memory().buffer);
    const bytesAt = () => new Uint8Array(opts.memory().buffer);
    const decoder = new TextDecoder();
    /**
     * The guest's waits on its children and their pipes in progress. While
     * there are any, all it does is wait on its children (it is one thread), and
     * it says so; an answer says it runs again. A wait that gave up leaves that
     * standing: the guest asks again at once (git loops on EINTR).
     */
    let parks = 0;
    /** The guest is gone: nothing follows its children any more. */
    let disposed = false;
    /**
     * A wait the guest gives up at PROCESS_PARK_MS. `attempt` answers, or gives
     * null while there is nothing to answer yet; `subscribe` asks for a wake
     * when that may have changed. Once the wait is answered, has given up or is
     * cancelled, `attempt` is never asked again, so a wait that did not answer
     * consumed nothing: the guest's retry finds it all still there.
     */
    const parkedWait = (subscribe, attempt) => {
        let finish = () => { };
        const ready = new Promise((resolve) => {
            let over = false;
            if (parks++ === 0)
                opts.news?.say(true);
            const timer = setTimeout(() => finish(null, false), PROCESS_PARK_MS);
            finish = (answer, ran) => {
                if (over)
                    return;
                over = true;
                clearTimeout(timer);
                if (--parks === 0 && ran)
                    opts.news?.say(false);
                resolve(answer);
            };
            const wake = () => {
                if (over)
                    return;
                const answer = attempt();
                if (answer === null)
                    subscribe(wake);
                else
                    finish(answer, true);
            };
            subscribe(wake);
        });
        return { ready, cancel: () => finish(null, true) };
    };
    const notify = (child) => {
        for (const waiter of child.waiters.splice(0))
            waiter();
    };
    const supervisor = () => {
        const sup = opts.supervisor();
        return sup && typeof sup.cpSpawn === 'function' ? sup : null;
    };
    const pipeEntry = (fd) => {
        const entry = opts.fds.get(fd);
        return entry && entry.kind === 'pipe' ? entry : null;
    };
    /** One more descriptor on `entry`'s end. */
    const hold = (entry) => {
        if (entry.end === 'read')
            entry.pipe.readers++;
        else
            entry.pipe.writers++;
    };
    /**
     * A descriptor on `pipe`'s `end` went: the last writer ends what a reader
     * or a child sees. A child's stdin the session cannot end is past helping:
     * the session is gone, and the child with it.
     */
    const drop = async (pipe, end) => {
        if (end === 'read') {
            pipe.readers--;
            if (pipe.readers === 0)
                wake(pipe);
            return;
        }
        pipe.writers--;
        if (pipe.writers > 0)
            return;
        wake(pipe);
        if (pipe.end && !pipe.ended) {
            pipe.ended = true;
            await pipe.end().catch(() => { });
        }
    };
    /** The strings in a NUL-separated buffer the guest passed. */
    const strings = (ptr, len) => {
        if (len === 0)
            return [];
        const text = decoder.decode(bytesAt().slice(ptr, ptr + len));
        return text.split('\0').slice(0, -1);
    };
    const gather = (iovs, iovsLen) => {
        const dv = view();
        const u8 = bytesAt();
        const parts = [];
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
            const ptr = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            if (len > 0) {
                parts.push(u8.slice(ptr, ptr + len));
                total += len;
            }
        }
        if (parts.length === 1)
            return parts[0];
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.byteLength;
        }
        return out;
    };
    /** Move queued bytes into the guest's iovecs; how many. */
    const scatter = (pipe, iovs, iovsLen) => {
        const dv = view();
        const u8 = bytesAt();
        let moved = 0;
        for (let i = 0; i < iovsLen && pipe.chunks.length > 0; i++) {
            const ptr = dv.getUint32(iovs + i * 8, true);
            let room = dv.getUint32(iovs + i * 8 + 4, true);
            let at = ptr;
            while (room > 0 && pipe.chunks.length > 0) {
                const chunk = pipe.chunks[0];
                const n = Math.min(room, chunk.byteLength);
                u8.set(chunk.subarray(0, n), at);
                at += n;
                room -= n;
                moved += n;
                if (n === chunk.byteLength)
                    pipe.chunks.shift();
                else
                    pipe.chunks[0] = chunk.subarray(n);
            }
        }
        return moved;
    };
    /**
     * A child's output, pumped into `target` until the child closes it. What
     * the session cannot deliver fails the pump, and a reader of the pipe gets
     * EIO after what did arrive.
     */
    const pump = async (sup, child, fd, target) => {
        let since = 0;
        try {
            while (!disposed) {
                const out = await sup.cpReadOutput(child, fd, since, LONG_POLL_MS);
                for (const chunk of out.chunks) {
                    since = Math.max(since, chunk.seq);
                    if (target === null)
                        continue;
                    if (typeof target === 'number')
                        await opts.output(target, chunk.data);
                    else if (target.pipe.readers > 0) {
                        target.pipe.chunks.push(chunk.data);
                        wake(target.pipe);
                    }
                }
                // Applied once delivered: the bytes are where the guest reads them.
                opts.news?.apply(out.news);
                if (out.closed)
                    break;
            }
        }
        catch {
            if (target !== null && typeof target !== 'number')
                target.pipe.failed = true;
        }
        if (target !== null && typeof target !== 'number')
            await drop(target.pipe, 'write');
    };
    /** The wait(2) status of a child's end, as the session reports it. */
    const statusOf = (exit) => {
        if (exit.signal)
            return (SIGNAL_NUMBERS[exit.signal] ?? 9) & 0x7f;
        return ((exit.exitCode ?? 0) & 0xff) << 8;
    };
    const imports = {
        /** getuid(2) and getgid(2): the credential the session runs the guest as (uid, gid as u32). */
        ids(outPtr) {
            const cred = opts.cred();
            view().setUint32(outPtr, cred?.uid ?? 0, true);
            view().setUint32(outPtr + 4, cred?.gid ?? 0, true);
            return E.SUCCESS;
        },
        pipe(fdsPtr) {
            const pipe = newPipe();
            const read = opts.allocateFd();
            const write = opts.allocateFd();
            opts.fds.set(read, { kind: 'pipe', end: 'read', pipe });
            opts.fds.set(write, { kind: 'pipe', end: 'write', pipe });
            pipe.readers = 1;
            pipe.writers = 1;
            view().setInt32(fdsPtr, read, true);
            view().setInt32(fdsPtr + 4, write, true);
            return E.SUCCESS;
        },
        dup(fd, outPtr) {
            const entry = opts.fds.get(fd);
            if (!entry)
                return E.BADF;
            // Pipes and the guest's own streams; a file's descriptor is the codec's, and not shared this way.
            if (entry.kind !== 'pipe' && entry.kind !== 'stdin' && entry.kind !== 'stdout' && entry.kind !== 'stderr')
                return E.NOSYS;
            const copy = { ...entry };
            if (copy.kind === 'pipe')
                hold(copy);
            const next = opts.allocateFd();
            opts.fds.set(next, copy);
            view().setInt32(outPtr, next, true);
            return E.SUCCESS;
        },
        dup2(from, to) {
            if (from === to)
                return opts.fds.has(from) ? E.SUCCESS : E.BADF;
            const entry = opts.fds.get(from);
            if (!entry)
                return E.BADF;
            if (entry.kind !== 'pipe' && entry.kind !== 'stdin' && entry.kind !== 'stdout' && entry.kind !== 'stderr')
                return E.NOSYS;
            const replaced = pipeEntry(to);
            const copy = { ...entry };
            if (copy.kind === 'pipe')
                hold(copy);
            opts.fds.set(to, copy);
            return replaced ? drop(replaced.pipe, replaced.end).then(() => E.SUCCESS) : E.SUCCESS;
        },
        spawn(argvPtr, argvLen, envPtr, envLen, dirPtr, dirLen, fdin, fdout, fderr, pidPtr) {
            const sup = supervisor();
            if (!sup)
                return E.NOSYS;
            const argv = strings(argvPtr, argvLen);
            if (argv.length === 0)
                return E.INVAL;
            const env = {};
            for (const entry of strings(envPtr, envLen)) {
                const at = entry.indexOf('=');
                if (at > 0)
                    env[entry.slice(0, at)] = entry.slice(at + 1);
            }
            const cwd = decoder.decode(bytesAt().slice(dirPtr, dirPtr + dirLen)) || '/';
            // What each of the child's streams connects to, taken now: the guest
            // closes its copies as soon as this returns.
            const stdin = pipeEntry(fdin);
            const inheritedInput = opts.fds.get(fdin)?.kind === 'stdin';
            const outputTo = (fd) => {
                const entry = opts.fds.get(fd);
                if (!entry)
                    return null;
                if (entry.kind === 'pipe')
                    return entry.end === 'write' ? entry : null;
                if (entry.kind === 'stdout')
                    return 1;
                if (entry.kind === 'stderr')
                    return 2;
                return null;
            };
            const stdout = outputTo(fdout);
            const stderr = outputTo(fderr);
            if (stdin)
                stdin.pipe.readers++;
            for (const target of [stdout, stderr])
                if (target !== null && typeof target !== 'number')
                    target.pipe.writers++;
            return (async () => {
                // The child sees what this process wrote before it started.
                await opts.release();
                let childPid;
                try {
                    ({ childPid } = await sup.cpSpawn({
                        command: argv[0], args: argv.slice(1), env, cwd, stdio: [inheritedInput ? 'inherit' : 'pipe', 'pipe', 'pipe'], parentPid: opts.pid,
                    }));
                }
                catch (error) {
                    if (stdin)
                        await drop(stdin.pipe, 'read');
                    for (const target of [stdout, stderr])
                        if (target !== null && typeof target !== 'number')
                            await drop(target.pipe, 'write');
                    // As execvp fails: ENOENT for a program that is not there, which
                    // git takes as "not a command" (an alias's dashed external first).
                    return filesystemErrno(error);
                }
                // Its stdin: what the guest writes to the pipe, forwarded, or nothing.
                if (stdin) {
                    const pipe = stdin.pipe;
                    // A write the session cannot take is the child's stdin gone (EPIPE).
                    pipe.forward = async (bytes) => {
                        await opts.release();
                        return sup.cpStdinWrite(childPid, bytes).then(({ ok }) => ok, () => false);
                    };
                    pipe.end = () => sup.cpStdinEnd(childPid);
                    for (const chunk of pipe.chunks.splice(0))
                        await pipe.forward(chunk);
                    // The child holds the read end until it exits.
                    if (pipe.writers === 0 && !pipe.ended) {
                        pipe.ended = true;
                        await pipe.end().catch(() => { });
                    }
                }
                else if (!inheritedInput) {
                    await sup.cpStdinEnd(childPid).catch(() => { });
                }
                const child = { pid: childPid, start: null, status: null, failed: false, waiters: [] };
                children.set(childPid, child);
                const pumps = [pump(sup, childPid, 1, stdout), pump(sup, childPid, 2, stderr)];
                // Its start (or the refusal of it), then its end, each applied before its news.
                void (async () => {
                    try {
                        let r = await sup.cpWait(childPid, LONG_POLL_MS, undefined, false);
                        while (!r.done && !r.started && !disposed)
                            r = await sup.cpWait(childPid, LONG_POLL_MS, undefined, false);
                        if (disposed)
                            return;
                        if (r.done && r.spawnError) {
                            child.start = filesystemErrno({ code: r.spawnError });
                            if (stdin)
                                await drop(stdin.pipe, 'read');
                            opts.news?.apply(r.news);
                            return;
                        }
                        child.start = E.SUCCESS;
                        notify(child);
                        if (!r.done)
                            opts.news?.apply(r.news);
                        while (!r.done && !disposed)
                            r = await sup.cpWait(childPid, LONG_POLL_MS);
                        if (disposed)
                            return;
                        // Its stdin's reader is gone: a writer now gets EPIPE.
                        if (stdin)
                            await drop(stdin.pipe, 'read');
                        // Everything it printed has arrived before its end is reported.
                        await Promise.all(pumps);
                        child.status = statusOf(r);
                        opts.news?.apply(r.news);
                    }
                    catch {
                        child.start ??= E.IO;
                        child.failed = true;
                    }
                    finally {
                        notify(child);
                    }
                })();
                view().setInt32(pidPtr, childPid, true);
                return E.SUCCESS;
            })();
        },
        start(pid) {
            const child = children.get(pid);
            if (!child)
                return E.SRCH;
            /** Its start, or the errno of a spawn that failed, which forgets it. */
            const answer = () => {
                if (child.start === null)
                    return null;
                if (child.start !== E.SUCCESS)
                    children.delete(pid);
                return child.start;
            };
            const now = answer();
            if (now !== null)
                return now;
            return parkedWait((wake) => child.waiters.push(wake), answer).ready.then((started) => started ?? E.INTR);
        },
        wait(pid, options, statusPtr, waitedPtr) {
            const candidates = pid === -1 || pid === 0 ? [...children.values()] : [children.get(pid)].filter((c) => c !== undefined);
            if (candidates.length === 0)
                return E.CHILD;
            /** Reap one candidate that has ended: its status, or null while none has. */
            const reap = () => {
                const live = candidates.filter((child) => children.get(child.pid) === child);
                if (live.length === 0)
                    return E.CHILD;
                const child = live.find((c) => c.status !== null || c.failed);
                if (!child)
                    return null;
                children.delete(child.pid);
                if (child.status === null)
                    return E.IO;
                opts.inbound();
                view().setInt32(statusPtr, child.status, true);
                view().setInt32(waitedPtr, child.pid, true);
                return E.SUCCESS;
            };
            const now = reap();
            if (now !== null)
                return now;
            if (options & WNOHANG) {
                view().setInt32(waitedPtr, 0, true);
                return E.SUCCESS;
            }
            return parkedWait((wake) => { for (const child of candidates)
                child.waiters.push(wake); }, reap).ready.then((reaped) => reaped ?? E.INTR);
        },
        kill(pid, signal) {
            const sup = supervisor();
            if (!sup)
                return E.NOSYS;
            if (!children.has(pid))
                return E.SRCH;
            if (signal === 0)
                return E.SUCCESS;
            const name = SIGNALS[signal];
            if (!name)
                return E.INVAL;
            return sup.cpKill(pid, name).then((delivered) => (delivered ? E.SUCCESS : E.SRCH));
        },
    };
    const read = (fd, iovs, iovsLen, nread) => {
        if (opts.fds.get(fd)?.kind === 'stdin' && opts.input) {
            let room = 0;
            for (let i = 0; i < iovsLen; i++)
                room += view().getUint32(iovs + i * 8 + 4, true);
            if (room === 0) {
                view().setUint32(nread, 0, true);
                return E.SUCCESS;
            }
            const finish = (packet) => {
                if (!(packet.data instanceof Uint8Array) || packet.data.byteLength > room)
                    return E.IO;
                if (packet.data.byteLength > 0) {
                    const moved = scatter({ chunks: [packet.data] }, iovs, iovsLen);
                    view().setUint32(nread, moved, true);
                    opts.inbound();
                    return E.SUCCESS;
                }
                if (packet.signal || !packet.ended)
                    return E.INTR;
                view().setUint32(nread, 0, true);
                return E.SUCCESS;
            };
            try {
                const packet = opts.input(room);
                return packet && typeof packet.then === 'function'
                    ? Promise.resolve(packet).then(finish, () => E.IO) : finish(packet);
            }
            catch {
                return E.IO;
            }
        }
        const entry = pipeEntry(fd);
        if (!entry)
            return null;
        if (entry.end !== 'read')
            return E.BADF;
        const pipe = entry.pipe;
        const answer = () => {
            if (pipe.chunks.length > 0) {
                const moved = scatter(pipe, iovs, iovsLen);
                view().setUint32(nread, moved, true);
                // Bytes from another process: what follows may depend on what it did.
                opts.inbound();
                return E.SUCCESS;
            }
            if (pipe.failed)
                return E.IO;
            if (pipe.writers === 0) {
                view().setUint32(nread, 0, true);
                return E.SUCCESS;
            }
            return null;
        };
        const now = answer();
        if (now !== null)
            return now;
        if (((entry.fdflags ?? 0) & FDFLAGS_NONBLOCK) !== 0)
            return E.AGAIN;
        return parkedWait((wake) => pipe.waiters.push(wake), answer).ready.then((read) => read ?? E.INTR);
    };
    const write = (fd, iovs, iovsLen, nwritten) => {
        const entry = pipeEntry(fd);
        if (!entry)
            return null;
        if (entry.end !== 'write')
            return E.BADF;
        const pipe = entry.pipe;
        const bytes = gather(iovs, iovsLen);
        if (pipe.readers === 0)
            return E.PIPE;
        if (pipe.forward) {
            return pipe.forward(bytes).then((ok) => {
                if (!ok)
                    return E.PIPE;
                view().setUint32(nwritten, bytes.byteLength, true);
                return E.SUCCESS;
            });
        }
        pipe.chunks.push(bytes);
        wake(pipe);
        view().setUint32(nwritten, bytes.byteLength, true);
        return E.SUCCESS;
    };
    const close = (fd) => {
        const entry = pipeEntry(fd);
        if (!entry)
            return null;
        opts.fds.delete(fd);
        return drop(entry.pipe, entry.end).then(() => E.SUCCESS);
    };
    const readiness = (fd, want) => {
        const entry = pipeEntry(fd);
        // Closed meanwhile: hung up, as a read or write of it would find.
        if (!entry)
            return { nbytes: 0, hangup: true };
        const pipe = entry.pipe;
        const check = () => {
            if (want === 'write')
                return { nbytes: 0xFFFF_FFFF, hangup: pipe.readers === 0 };
            const nbytes = pipe.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            if (nbytes > 0)
                return { nbytes, hangup: false };
            return pipe.writers === 0 || pipe.failed ? { nbytes: 0, hangup: true } : null;
        };
        // A write end always has room: what is written to a child goes to the session.
        return check() ?? parkedWait((wake) => pipe.waiters.push(wake), check);
    };
    return { imports, read, write, close, isPipe: (fd) => pipeEntry(fd) !== null, readiness, dispose: () => { disposed = true; } };
}
