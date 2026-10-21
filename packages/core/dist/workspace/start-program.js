import { feedProgramInput } from '../runtime/program-start.js';
import { exitCodeForSignal } from '../substrate/lifo/shell/signals.js';
import { errnoOf } from '../vfs/vfs-error.js';
/** How long one wait on the broker lasts before it is made again. */
const WAIT_MS = 5000;
/** How long an ended program's exit is kept for a wait that comes late. */
const EXIT_KEPT_MS = 60_000;
/**
 * The programs startProgram started: each one's exit, waited for apart from
 * its output (waitProgram), kept a minute past its end.
 */
export class StartedPrograms {
    programs = new Map();
    add(pid, exit) {
        const record = { outcome: null, endedAt: null, waiters: new Set() };
        this.programs.set(pid, record);
        const ended = (outcome) => {
            record.outcome = outcome;
            record.endedAt = Date.now();
            for (const waiter of record.waiters)
                waiter(outcome);
            record.waiters.clear();
        };
        exit.then((status) => ended({ status }), (error) => ended({ error }));
    }
    /** Whether `pid` is one of them that has not ended. */
    running(pid) {
        return this.programs.get(pid)?.endedAt === null;
    }
    /** `pid`'s exit once it comes, or null once `waitMs` pass first; ESRCH for none of them. */
    async wait(pid, waitMs) {
        const record = this.programs.get(pid);
        if (record === undefined)
            throw Object.assign(new Error(`waitProgram: no started program ${pid}`), { code: 'ESRCH', errno: -3 });
        const outcome = record.outcome ?? await new Promise((resolve) => {
            const waiter = (ended) => {
                clearTimeout(timer);
                resolve(ended);
            };
            const timer = setTimeout(() => {
                record.waiters.delete(waiter);
                resolve(null);
            }, waitMs);
            record.waiters.add(waiter);
        });
        if (outcome === null)
            return null;
        if ('error' in outcome)
            throw outcome.error;
        return outcome.status;
    }
    /** Forget those that ended more than EXIT_KEPT_MS ago. */
    prune() {
        const now = Date.now();
        for (const [pid, record] of this.programs) {
            if (record.endedAt !== null && now - record.endedAt > EXIT_KEPT_MS)
                this.programs.delete(pid);
        }
    }
}
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
    await processes.reap();
    host.started.prune();
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
    // Its broker entry goes once its end is taken; its table rows once its output is read too.
    const forget = () => { children.release(pid); };
    const release = async () => {
        await ended.catch(() => { });
        forget();
        await processes.reapTree(parent.pid);
    };
    if (cancel.aborted || (heard.done && heard.spawnError !== undefined)) {
        children.kill(pid, 'SIGKILL');
        await ended;
        await release();
        throw spawnError(program.argv, { code: cancel.aborted ? 'ECANCELED' : heard.spawnError });
    }
    host.started.add(pid, ended);
    if (program.stdin !== 'written')
        void pumpInput(children, pid, program.stdin, ended);
    const output = outputOf(children, pid, release, () => { ended.then(forget, forget); });
    return { pid, output, exit: ended, kill: (signal) => { children.kill(pid, signal); } };
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
/** `stdin` into the child's input (feedProgramInput); none: ended at once. One whose input cannot be ended is killed. */
function pumpInput(children, childPid, stdin, ended) {
    if (stdin === null)
        return children.stdinEnd(childPid);
    const sink = { write: async (bytes) => (await children.stdinWrite(childPid, bytes)).ok, end: () => children.stdinEnd(childPid) };
    return feedProgramInput(stdin, sink, ended).catch(() => { children.kill(childPid, 'SIGKILL'); });
}
/**
 * The child's stdout and stderr as one stream of chunks, in the order the
 * reads answered (neither starves the other), read only as its reader takes
 * them. Read to their end, `done` is waited for before the reader hears it;
 * given up, `abandoned` is told, and what it ran leaves the table as a job
 * that outlived its exec does, with the launch-time reap.
 */
function outputOf(children, childPid, done, abandoned) {
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
            abandoned();
        },
    }, { highWaterMark: 0 });
}
function spawnError(argv, cause) {
    const file = argv[0] ?? '';
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'EIO';
    const error = new Error(`spawn ${file} ${code}`);
    return Object.assign(error, { code, errno: errnoOf(code) ?? -5, syscall: `spawn ${file}`, path: file, spawnargs: argv.slice(1) });
}
