export interface Job {
  id: number;
  command: string;
  promise: Promise<number>;
  abortController: AbortController;
  status: 'running' | 'done' | 'stopped';
  exitCode: number | null;
  /** The job's process, when it has one in the registry. */
  pid?: number;
}

export class JobTable {
  private jobs = new Map<number, Job>();

  add(command: string, promise: Promise<number>, abortController: AbortController, pid?: number): number {
    // bash: one more than the highest job still in the table.
    const id = Math.max(0, ...this.jobs.keys()) + 1;
    const job: Job = {
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

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  byPid(pid: number): Job | undefined {
    for (const job of this.jobs.values()) if (job.pid === pid) return job;
    return undefined;
  }

  get(id: number): Job | undefined {
    return this.jobs.get(id);
  }

  remove(id: number): void {
    this.jobs.delete(id);
  }

  /**
   * Collect and remove finished jobs, returning their info for display.
   */
  collectDone(): Job[] {
    const done: Job[] = [];
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
