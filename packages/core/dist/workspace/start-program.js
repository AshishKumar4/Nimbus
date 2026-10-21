import { exitCodeForSignal } from '../substrate/lifo/shell/signals.js';
import { errnoOf } from '../vfs/vfs-error.js';
/** How long one wait on the broker lasts before it is made again. */
const WAIT_MS = 5000;
/**
 * `program` started (ExecDelegate.start's contract): resolved once it runs,
 * rejected with Node's spawn error (`code`, `errno`, `syscall: 'spawn
 * <file>'`, `path`) when it could not start, ECANCELED when `cancel`
 * aborted while it was pending (whatever had started is killed first).
 */
export async function startProgram(host, program, cancel) {
    const [file, ...args] = program.argv;
    if (file === undefined || file === '')
        throw new TypeError('startProgram: argv[0] must name a program');
    if (cancel.aborted)
        throw spawnError(program.argv, { code: 'ECANCELED' });
    const { children, processes } = host;
    // What ended a minute ago goes as a launch begins (NimbusWorkspace.runProcess's rule).
    children.reap();
    await processes.reap();
    // Its parent: a process of its own, as an exec's, which ends with it.
    const parent = processes.spawn(program.argv.join(' '), [...program.argv], program.cwd, { cred: host.cred });
    let childPid = null;
    const stopPending = () => { if (childPid !== null)
        children.kill(childPid, 'SIGKILL'); };
    cancel.addEventListener('abort', stopPending, { once: true });
    try {
        ({ childPid } = await children.spawn({
            command: file, args, env: { ...program.env }, cwd: program.cwd, stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid,
        }));
    }
    catch (error) {
        cancel.removeEventListener('abort', stopPending);
        processes.exit(parent.pid, 127);
        await processes.reapTree(parent.pid);
        throw spawnError(program.argv, error);
    }
    const pid = childPid;
    let heard;
    try {
        // An abort that came while the broker placed it stops it now.
        if (cancel.aborted)
            stopPending();
        do
            heard = await children.wait(pid, WAIT_MS, false);
        while (!heard.done && heard.started !== true);
    }
    finally {
        cancel.removeEventListener('abort', stopPending);
    }
    const ended = settleExit(children, processes, parent.pid, pid, heard);
    const release = async () => {
        await ended.catch(() => { });
        await processes.reapTree(parent.pid);
    };
    if (cancel.aborted || (heard.done && heard.spawnError !== undefined)) {
        children.kill(pid, 'SIGKILL');
        await ended;
        await release();
        throw spawnError(program.argv, { code: cancel.aborted ? 'ECANCELED' : heard.spawnError });
    }
    host.started.add(pid);
    const forget = () => { host.started.delete(pid); };
    ended.then(forget, forget);
    if (program.stdin !== 'written')
        void pumpInput(children, pid, program.stdin, ended);
    // Its table rows go once it has ended and its output is read.
    return { pid, output: outputOf(children, pid, release), exit: ended, kill: (signal) => { children.kill(pid, signal); } };
}
/** The child's exit as waitpid says it, once it comes; its parent ends with it. */
async function settleExit(children, processes, parentPid, childPid, heard) {
    let status = heard;
    while (!status.done)
        status = await children.wait(childPid, WAIT_MS);
    const exit = status.signal === null || status.signal === undefined
        ? { code: status.exitCode ?? 1, signal: null }
        : { code: null, signal: status.signal };
    processes.exit(parentPid, exit.signal === null ? exit.code : exitCodeForSignal(exit.signal.replace(/^SIG/, '')));
    return exit;
}
/**
 * `stdin`'s bytes into the child's, each write waiting for room, then its
 * end; none: ended at once. Once the child has ended its source is let go:
 * a read still waiting is cancelled.
 */
async function pumpInput(children, childPid, stdin, ended) {
    if (stdin === null)
        return children.stdinEnd(childPid);
    const reader = stdin.getReader();
    const gone = ended.then(() => null, () => null);
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), gone]);
            if (next === null) {
                await reader.cancel();
                return;
            }
            if (next.done)
                break;
            // A child gone takes no more: what is left is not read.
            if (!(await children.stdinWrite(childPid, next.value)).ok) {
                await reader.cancel();
                return;
            }
        }
        await children.stdinEnd(childPid);
    }
    catch {
        // Its writer failed: the child sees its input end there.
        await children.stdinEnd(childPid);
    }
    finally {
        reader.releaseLock();
    }
}
/**
 * The child's stdout and stderr as one stream of chunks, in the order the
 * reads answered (neither starves the other), read only as its reader takes
 * them. Read to their end, `done` is waited for before the reader hears it;
 * given up, what it ran goes as a job that outlived its exec does, with the
 * launch-time reap.
 */
function outputOf(children, childPid, done) {
    const cursors = new Map([[1, 0], [2, 0]]);
    const answered = [];
    let open = 2;
    let cancelled = false;
    let failed = null;
    let wake = null;
    const read = (fd) => {
        children.readOutput(childPid, fd, cursors.get(fd) ?? 0, WAIT_MS).then((result) => {
            if (cancelled)
                return;
            answered.push({ fd, chunks: result.chunks.map((chunk) => chunk.data), closed: result.closed, maxSeq: result.maxSeq });
            wake?.();
        }, (error) => {
            failed = { error };
            wake?.();
        });
    };
    read(1);
    read(2);
    return new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (cancelled)
                    return;
                if (failed !== null) {
                    controller.error(failed.error);
                    return;
                }
                if (open === 0) {
                    // Its rows go before its reader hears the end, as an exec's do before its result.
                    try {
                        await done();
                    }
                    catch (error) {
                        controller.error(error);
                        return;
                    }
                    controller.close();
                    return;
                }
                const next = answered.shift();
                if (next === undefined) {
                    await new Promise((resolve) => { wake = resolve; });
                    wake = null;
                    continue;
                }
                cursors.set(next.fd, next.maxSeq);
                if (next.closed && next.chunks.length === 0)
                    open--;
                else
                    read(next.fd);
                const name = next.fd === 1 ? 'stdout' : 'stderr';
                let gave = false;
                for (const data of next.chunks) {
                    if (data.byteLength === 0)
                        continue;
                    controller.enqueue({ stream: name, data });
                    gave = true;
                }
                if (gave)
                    return;
            }
        },
        cancel() {
            cancelled = true;
            wake?.();
            children.closeOutput(childPid, 1);
            children.closeOutput(childPid, 2);
        },
    }, { highWaterMark: 0 });
}
function spawnError(argv, cause) {
    const file = argv[0] ?? '';
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'EIO';
    const error = new Error(`spawn ${file} ${code}`);
    return Object.assign(error, { code, errno: errnoOf(code) ?? -5, syscall: `spawn ${file}`, path: file, spawnargs: argv.slice(1) });
}
