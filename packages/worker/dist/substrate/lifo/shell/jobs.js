export class JobTable {
    jobs = new Map();
    nextId = 1;
    add(command, promise, abortController) {
        const id = this.nextId++;
        const job = {
            id,
            command,
            promise,
            abortController,
            status: 'running',
            exitCode: null,
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
    get(id) {
        return this.jobs.get(id);
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
