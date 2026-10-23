import { isKillRefusal, type SessionProcessSupervisor } from '../../../runtime/session-process-supervisor.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { CommandIdentity } from './interpreter.js';
import { exitCodeForSignal, signalAbortReason, signalDisposition } from './signals.js';
import type { HostSignalResult } from '../commands/system/kill.js';

/**
 * The session's process table as a shell uses it: its jobs are processes
 * there, under the process that started them, and the work of its lines is
 * counted and held there.
 */
export type ShellProcesses = Pick<SessionProcessSupervisor,
  'spawn' | 'exit' | 'kill' | 'killAs' | 'maySignal' | 'whenEnded' | 'holdWork' | 'beginWork' | 'beginAwait' | 'cred' | 'setUmask' | 'signalForeground'>;

/**
 * A background job: its `%N` number, its command line and its process in
 * the session's table, which says when and how it ended.
 */
export interface Job {
  readonly id: number;
  readonly command: string;
  /** Its status, once its process has ended, however it ended. */
  readonly promise: Promise<number>;
  readonly pid: number;
  /** Running, or done once its process has ended: nothing stops a job (JobTable.signal). */
  readonly status: 'running' | 'done';
  /** How it ended; null while it runs. */
  readonly exitCode: number | null;
}

/** What a job's commands run as: its own process, whose work is counted, and the signal its work stops by. */
export interface JobProcess {
  readonly identity: CommandIdentity & { beginWork(): () => void };
  readonly signal: AbortSignal;
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

/**
 * A shell's jobs, by number: each one a process of the session's table. A
 * subshell's table starts as a copy of its parent's; the job records are
 * shared, which is safe because what changes about a job (its stop mark) is
 * the job's, wherever it is signalled from, and how it ended is set once.
 */
export class JobTable {
  private jobs = new Map<number, Job>();
  private waited = new Map<number, Job>();

  constructor(private readonly processes: ShellProcesses) {}

  /**
   * Run `run` as a background job, numbered as bash numbers jobs: a process
   * of the table under `parent`, with its credential, as a fork makes one.
   * Its commands run as it; a kill of it stops its work, and it ends when
   * `run` settles.
   */
  start(options: { command: string; cwd: string; parent: Pick<CommandIdentity, 'pid' | 'cred'> }, run: (job: JobProcess) => Promise<number>): Job {
    // bash: one more than the highest job still in the table.
    const id = Math.max(0, ...this.jobs.keys()) + 1;
    this.waited.delete(id);
    const processes = this.processes;
    const { pid } = processes.spawn(options.command, [options.command], options.cwd, { parentPid: options.parent.pid, cred: options.parent.cred });
    const held = processes.holdWork(pid);
    let exitCode: number | null = null;
    const promise = processes.whenEnded(pid);
    void promise.then((code) => { exitCode = code; });
    const record: Job = {
      id,
      command: options.command,
      promise,
      pid,
      get exitCode() { return exitCode; },
      get status() { return exitCode !== null ? 'done' : 'running'; },
    };
    this.jobs.set(id, record);
    const identity: JobProcess['identity'] = {
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

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * `job`'s status once it ends, process `waiter` (the shell `wait` or `fg`
   * runs as) awaiting it meanwhile, as the session counts an await
   * (SessionProcessSupervisor.beginAwait): a shell doing nothing but wait on
   * its job is told as such.
   */
  async awaitEnd(job: Job, waiter: number): Promise<number> {
    const endAwait = this.processes.beginAwait(waiter, job.pid);
    try {
      return await job.promise;
    } finally {
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
  signal(job: Job, signal: string, caller: Readonly<VfsCred>): HostSignalResult {
    if (this.jobs.get(job.id) !== job || job.status === 'done') return 'delivered';
    const disposition = signalDisposition(signal);
    if (disposition === 'terminate') {
      try {
        this.processes.killAs(caller, job.pid, exitCodeForSignal(signal), signalAbortReason(signal));
      } catch (error) {
        if (isKillRefusal(error)) return 'not-permitted';
        throw error;
      }
      return 'delivered';
    }
    if (!this.processes.maySignal(caller, job.pid)) return 'not-permitted';
    return disposition === 'stop' ? 'unsupported' : 'delivered';
  }

  fork(): JobTable {
    const child = new JobTable(this.processes);
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

  /**
   * What `wait` names, by jobspec or by pid: a job of this table, else one
   * it has waited for, whose status it still answers with (bash's).
   */
  waitTarget(spec: string): Job | 'ambiguous' | undefined {
    if (!spec.startsWith('%')) {
      const pid = Number(spec);
      return this.byPid(pid) ?? [...this.waited.values()].find((job) => job.pid === pid);
    }
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
