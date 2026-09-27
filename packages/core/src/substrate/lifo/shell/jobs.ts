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

export function resolveJobSpec<T extends { id: number; command: string }>(spec: string, jobs: readonly T[]): T | 'ambiguous' | undefined {
  const text = spec.startsWith('%') ? spec.slice(1) : spec;
  if (text === '' || text === '%' || text === '+' || text === '-') {
    let current: T | undefined;
    let previous: T | undefined;
    for (const job of jobs) {
      if (!current || job.id > current.id) { previous = current; current = job; }
      else if (!previous || job.id > previous.id) previous = job;
    }
    return text === '-' ? previous ?? current : current;
  }
  if (/^\d+$/.test(text)) return jobs.find((job) => job.id === Number(text));
  let found: T | undefined;
  for (const job of jobs) {
    const matches = text.startsWith('?') ? job.command.includes(text.slice(1)) : job.command.startsWith(text);
    if (!matches) continue;
    if (found) return 'ambiguous';
    found = job;
  }
  return found;
}

export class JobTable {
  private jobs = new Map<number, Job>();
  private waited = new Map<number, Job>();

  add(command: string, promise: Promise<number>, abortController: AbortController, pid?: number): number {
    // bash: one more than the highest job still in the table.
    const id = Math.max(0, ...this.jobs.keys()) + 1;
    this.waited.delete(id);
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

  fork(): JobTable {
    const child = new JobTable();
    child.jobs = new Map(this.jobs);
    return child;
  }

  byPid(pid: number): Job | undefined {
    for (const job of this.jobs.values()) if (job.pid === pid) return job;
    return undefined;
  }

  get(id: number): Job | undefined {
    return this.jobs.get(id);
  }

  waitTarget(spec: string): Job | 'ambiguous' | undefined {
    const live = resolveJobSpec(spec, this.list());
    if (live !== undefined) return live;
    return /^%\d+$/.test(spec) ? this.waited.get(Number(spec.slice(1))) : undefined;
  }

  reap(job: Job): void {
    this.waited.set(job.id, job);
    this.jobs.delete(job.id);
  }

  clearWaited(): void {
    this.waited.clear();
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
