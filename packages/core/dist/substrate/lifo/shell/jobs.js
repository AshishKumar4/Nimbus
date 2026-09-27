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
export class JobTable {
    jobs = new Map();
    waited = new Map();
    add(command, promise, abortController, pid) {
        // bash: one more than the highest job still in the table.
        const id = Math.max(0, ...this.jobs.keys()) + 1;
        this.waited.delete(id);
        const job = {
            id,
            command,
            promise,
            abortController,
            status: 'running',
            exitCode: null,
            ...(pid === undefined ? {} : { pid }),
        };
        promise.then((code) => {
            job.status = 'done';
            job.exitCode = code;
        }).catch(() => {
            job.status = 'done';
            job.exitCode = 1;
        });
        this.jobs.set(id, job);
        return id;
    }
    list() {
        return Array.from(this.jobs.values());
    }
    fork() {
        const child = new JobTable();
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
