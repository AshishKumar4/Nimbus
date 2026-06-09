/**
 * ProcessTable — PID allocation and process lifecycle state.
 *
 * Each `node script.js` invocation gets a PID. The supervisor uses this
 * to route signals (kill) and track running processes. Owned by
 * SessionProcessSupervisor; callers go through that facade.
 */

export type ProcessState = 'running' | 'exited' | 'killed';

export interface ProcessEntry {
  pid: number;
  command: string;       // e.g. "node hello.js" or "node -e ..."
  argv: string[];
  cwd: string;
  state: ProcessState;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  /** child-process isolation: explicit long-running flag set by FacetManager.spawn
   *  when a script is forked to a long-lived Worker Loader (vite,
   *  http.listen, --watch, …). Distinct from the regex heuristic in
   *  process-logs-api.ts:LONG_RUNNING_CMD_RE — when set, the API
   *  returns this directly. */
  longRunning?: boolean;
  /** Output is owned by a process-terminal attachment, not the parent shell. */
  attachedTty?: boolean;
}

export class ProcessTable {
  private nextPid = 1;
  private processes = new Map<number, ProcessEntry>();

  /** Allocate a PID and register a new process. */
  spawn(command: string, argv: string[], cwd: string): ProcessEntry {
    const pid = this.nextPid++;
    const entry: ProcessEntry = {
      pid,
      command,
      argv,
      cwd,
      state: 'running',
      exitCode: null,
      startTime: Date.now(),
      endTime: null,
    };
    this.processes.set(pid, entry);
    return entry;
  }

  /** child-process isolation: mark an existing entry as long-running. Idempotent. */
  setLongRunning(pid: number): void {
    const entry = this.processes.get(pid);
    if (entry) entry.longRunning = true;
  }

  /** Mark an existing entry as an attached terminal process. Idempotent. */
  setAttachedTty(pid: number): void {
    const entry = this.processes.get(pid);
    if (entry) entry.attachedTty = true;
  }

  /**
   * Mark a process as exited.
   *
   * STABILITY-AUDIT.md M-S1: state-idempotent. Once a process reaches
   * a terminal state (`killed` or `exited`), subsequent exit() calls
   * are no-ops — the first terminal state wins.
   *
   * Without this guard, a `kill <pid>` (which sets state='killed',
   * exitCode=137) followed by the facet's own crash-catch (which calls
   * exit(pid, 1)) clobbers the kill signal with an exited/1 reading.
   * `ps` then disagrees with the ring-buffer footer that still says
   * "[process killed: killed]".
   */
  exit(pid: number, exitCode: number): void {
    const entry = this.processes.get(pid);
    if (!entry) return;
    if (entry.state !== 'running') return; // first terminal state wins
    entry.state = 'exited';
    entry.exitCode = exitCode;
    entry.endTime = Date.now();
  }

  /** Mark a process as killed. */
  kill(pid: number): boolean {
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') return false;
    entry.state = 'killed';
    entry.exitCode = 137; // SIGKILL
    entry.endTime = Date.now();
    return true;
  }

  get(pid: number): ProcessEntry | undefined {
    return this.processes.get(pid);
  }

  getRunning(): ProcessEntry[] {
    return [...this.processes.values()].filter(p => p.state === 'running');
  }

  getAll(): ProcessEntry[] {
    return [...this.processes.values()];
  }

  /** Clean up exited processes older than maxAge ms. */
  reap(maxAge = 60_000): number {
    const now = Date.now();
    let reaped = 0;
    for (const [pid, entry] of this.processes) {
      if (entry.state !== 'running' && entry.endTime && now - entry.endTime > maxAge) {
        this.processes.delete(pid);
        reaped++;
      }
    }
    return reaped;
  }

  get stats() {
    const all = [...this.processes.values()];
    return {
      total: all.length,
      running: all.filter(p => p.state === 'running').length,
      exited: all.filter(p => p.state === 'exited').length,
      killed: all.filter(p => p.state === 'killed').length,
      nextPid: this.nextPid,
    };
  }
}
