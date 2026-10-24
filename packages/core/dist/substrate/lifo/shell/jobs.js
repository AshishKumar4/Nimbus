import { isKillRefusal } from '../../../runtime/session-process-supervisor.js';
import { exitCodeForSignal, signalAbortReason, signalDisposition } from './signals.js';
export function resolveJobSpec(spec, jobs) {
    const text = spec.startsWith('%') ? spec.slice(1) : spec;
    if (text === '' || text === '%' || text === '+' || text === '-') {
        let current;
        let previous;
        for (const job of jobs) {
            if (!current || job.id > current.id) {
                previous = current;
                current = job;
            }
            else if (!previous || job.id > previous.id)
                previous = job;
        }
        return text === '-' ? previous ?? current : current;
    }
    if (/^\d+$/.test(text))
        return jobs.find((job) => job.id === Number(text));
    let found;
    for (const job of jobs) {
        const matches = text.startsWith('?') ? job.command.includes(text.slice(1)) : job.command.startsWith(text);
        if (!matches)
            continue;
        if (found)
            return 'ambiguous';
        found = job;
    }
    return found;
}
/**
 * A shell's jobs, by number: each one a process of the session's table. A
 * subshell's table starts as a copy of its parent's; the job records are
 * shared, which is safe because what changes about a job (its stop mark) is
 * the job's, wherever it is signalled from, and how it ended is set once.
 */
export class JobTable {
    processes;
    jobs = new Map();
    waited = new Map();
    constructor(processes) {
        this.processes = processes;
    }
    /**
     * Run `run` as a background job, numbered as bash numbers jobs: a process
     * of the table under `parent`, with its credential, as a fork makes one.
     * Its commands run as it; a kill of it stops its work, and it ends when
     * `run` settles.
     */
    start(options, run) {
        // bash: one more than the highest job still in the table.
        const id = Math.max(0, ...this.jobs.keys()) + 1;
        this.waited.delete(id);
        const processes = this.processes;
        const { pid } = processes.spawn(options.command, [options.command], options.cwd, { parentPid: options.parent.pid, cred: options.parent.cred, backgroundJob: true });
        const held = processes.holdWork(pid);
        let exitCode = null;
        const promise = processes.whenEnded(pid);
        void promise.then((code) => { exitCode = code; });
        const record = {
            id,
            command: options.command,
            promise,
            pid,
            get exitCode() { return exitCode; },
            get status() { return exitCode !== null ? 'done' : 'running'; },
        };
        this.jobs.set(id, record);
        const identity = {
            pid,
            get cred() { return processes.cred(pid); },
            setUmask: (mask) => { processes.setUmask(pid, mask); },
            beginWork: () => processes.beginWork(pid),
        };
        void run({ identity, signal: held.signal })
            .then((code) => processes.exit(pid, code), () => processes.exit(pid, 1))
            .finally(held);
        return record;
    }
    list() {
        return Array.from(this.jobs.values());
    }
    /**
     * `job`'s status once it ends, process `waiter` (the shell `wait` or `fg`
     * runs as) awaiting it meanwhile, as the session counts an await
     * (SessionProcessSupervisor.beginAwait): a shell doing nothing but wait on
     * its job is told as such.
     */
    async awaitEnd(job, waiter) {
        const endAwait = this.processes.beginAwait(waiter, job.pid);
        try {
            return await job.promise;
        }
        finally {
            endAwait();
        }
    }
    /**
     * Deliver `signal` (a parsed name; `0` delivers nothing) to `job`, one of
     * this table's, from `caller`, as kill reports it: a terminating one ends
     * its process, which stops its work; a continue or an ignored one does
     * nothing to a job that runs. A stop is `unsupported`: nothing can pause a
     * job's work (a command is not preempted), as nothing can pause a hosted
     * process's. `not-permitted` when kill(2)'s rule refuses `caller`: the
     * kill's own check (SessionProcessSupervisor.killAs), or for a signal that
     * ends nothing, the same rule asked alone (maySignal).
     */
    signal(job, signal, caller) {
        if (this.jobs.get(job.id) !== job || job.status === 'done')
            return 'delivered';
        const disposition = signalDisposition(signal);
        if (disposition === 'terminate') {
            try {
                this.processes.killAs(caller, job.pid, exitCodeForSignal(signal), signalAbortReason(signal));
            }
            catch (error) {
                if (isKillRefusal(error))
                    return 'not-permitted';
                throw error;
            }
            return 'delivered';
        }
        if (!this.processes.maySignal(caller, job.pid))
            return 'not-permitted';
        return disposition === 'stop' ? 'unsupported' : 'delivered';
    }
    fork() {
        const child = new JobTable(this.processes);
        child.jobs = new Map(this.jobs);
        return child;
    }
    byPid(pid) {
        for (const job of this.jobs.values())
            if (job.pid === pid)
                return job;
        return undefined;
    }
    get(id) {
        return this.jobs.get(id);
    }
    /**
     * What `wait` names, by jobspec or by pid: a job of this table, else one
     * it has waited for, whose status it still answers with (bash's).
     */
    waitTarget(spec) {
        if (!spec.startsWith('%')) {
            const pid = Number(spec);
            return this.byPid(pid) ?? [...this.waited.values()].find((job) => job.pid === pid);
        }
        const live = resolveJobSpec(spec, this.list());
        if (live !== undefined)
            return live;
        return /^%\d+$/.test(spec) ? this.waited.get(Number(spec.slice(1))) : undefined;
    }
    reap(job) {
        this.waited.set(job.id, job);
        this.jobs.delete(job.id);
    }
    clearWaited() {
        this.waited.clear();
    }
    remove(id) {
        this.jobs.delete(id);
    }
    /**
     * Collect and remove finished jobs, returning their info for display.
     */
    collectDone() {
        const done = [];
        for (const job of this.jobs.values()) {
            if (job.status === 'done') {
                done.push(job);
            }
        }
        for (const job of done) {
            this.jobs.delete(job.id);
        }
        return done;
    }
}
