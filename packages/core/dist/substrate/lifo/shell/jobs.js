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
 * A shell's jobs, by number: a view over the process table, where each job
 * is a process. A subshell's table starts as a copy of its parent's; the
 * job records are shared, which is safe because what changes about a job
 * (its state) is its process's, and how it ended is set once.
 */
export class JobTable {
    processes;
    jobs = new Map();
    waited = new Map();
    constructor(processes) {
        this.processes = processes;
    }
    /** Run `promise` as a background job: a process in the table, numbered as bash numbers jobs. Its pid and number. */
    start(options) {
        // bash: one more than the highest job still in the table.
        const id = Math.max(0, ...this.jobs.keys()) + 1;
        this.waited.delete(id);
        const pid = this.processes.spawn({
            command: options.command.split(' ')[0] || 'unknown',
            args: options.command.split(' '),
            cwd: options.cwd,
            env: options.env,
            isForeground: false,
            promise: options.promise,
            abortController: options.abortController,
            jobId: id,
        });
        const processes = this.processes;
        let exitCode = null;
        const promise = processes.get(pid)?.promise ?? options.promise;
        promise.then((code) => { exitCode = code; }, () => { exitCode = 1; });
        this.jobs.set(id, {
            id,
            command: options.command,
            promise,
            abortController: options.abortController,
            pid,
            get exitCode() { return exitCode; },
            get status() {
                if (exitCode !== null)
                    return 'done';
                return processes.get(pid)?.status === 'stopped' ? 'stopped' : 'running';
            },
        });
        return { pid, id };
    }
    list() {
        return Array.from(this.jobs.values());
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
    waitTarget(spec) {
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
