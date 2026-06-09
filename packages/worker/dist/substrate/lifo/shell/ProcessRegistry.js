import { signalAbortReason } from './signals.js';
/**
 * Central process registry for tracking all running processes.
 * Provides Linux-like process management with PIDs, status tracking,
 * and process lifecycle management.
 */
export class ProcessRegistry {
    processes = new Map();
    resolvers = new Map();
    nextPid = 2; // PID 1 reserved for shell
    nextJobId = 1; // Job IDs for background processes
    shellAbortController = null;
    registerShell(cwd, env) {
        const existing = this.processes.get(1);
        if (existing) {
            existing.cwd = cwd;
            existing.env = { ...env };
            return existing.pid;
        }
        this.shellAbortController = new AbortController();
        this.processes.set(1, {
            pid: 1,
            ppid: 0,
            command: 'shell',
            args: ['shell'],
            cwd,
            env: { ...env },
            startTime: Date.now(),
            status: 'running',
            isForeground: true,
            promise: new Promise(() => { }),
            abortController: this.shellAbortController,
            exitCode: null,
        });
        return 1;
    }
    /**
     * Spawn a new process and register it in the process table.
     * Returns the assigned PID.
     */
    spawn(opts) {
        const pid = this.nextPid++;
        // Assign job ID for background processes
        const jobId = opts.isForeground ? undefined : this.nextJobId++;
        let resolveProcess = () => { };
        const trackedPromise = new Promise((resolve) => {
            resolveProcess = resolve;
        });
        const process = {
            pid,
            ppid: opts.ppid ?? 1, // Default parent is shell (PID 1)
            command: opts.command,
            args: opts.args,
            cwd: opts.cwd,
            env: opts.env,
            startTime: Date.now(),
            status: 'running',
            isForeground: opts.isForeground,
            promise: trackedPromise,
            abortController: opts.abortController,
            exitCode: null,
            jobId,
        };
        this.resolvers.set(pid, resolveProcess);
        this.processes.set(pid, process);
        opts.promise.then((code) => {
            this.finish(pid, code);
        }).catch((error) => {
            this.finish(pid, error?.exitCode ?? 1);
        });
        return pid;
    }
    /**
     * Get process information by PID.
     */
    get(pid) {
        return this.processes.get(pid);
    }
    /**
     * Get process information by job ID.
     */
    getByJobId(jobId) {
        for (const proc of this.processes.values()) {
            if (proc.jobId === jobId) {
                return proc;
            }
        }
        return undefined;
    }
    /**
     * Check if a process exists.
     */
    has(pid) {
        return this.processes.has(pid);
    }
    /**
     * Get all PIDs in the system.
     */
    getAllPIDs() {
        return Array.from(this.processes.keys()).sort((a, b) => a - b);
    }
    /**
     * Get all processes.
     */
    getAll() {
        return Array.from(this.processes.values());
    }
    /**
     * Get all running processes (excludes zombies and stopped).
     */
    getRunning() {
        return Array.from(this.processes.values()).filter((p) => p.status === 'running' || p.status === 'sleeping');
    }
    /**
     * Get all background jobs (non-foreground processes, excluding shell).
     */
    getBackgroundJobs() {
        return Array.from(this.processes.values()).filter((p) => !p.isForeground && p.pid !== 1);
    }
    /**
     * Get all zombie processes (finished but not reaped).
     */
    getZombies() {
        return Array.from(this.processes.values()).filter((p) => p.status === 'zombie');
    }
    /**
     * Kill a process by sending abort signal.
     * Returns true if process was killed, false if not found or is a shell process.
     */
    kill(pid, signal) {
        const proc = this.processes.get(pid);
        if (!proc) {
            return false;
        }
        // Cannot kill shell processes (would close the terminal)
        if (proc.command === 'shell') {
            return false;
        }
        // Already dead
        if (proc.status === 'zombie') {
            return true;
        }
        if (signal === 'STOP' || signal === 'TSTP') {
            proc.status = 'stopped';
            return true;
        }
        if (signal === 'CONT') {
            proc.status = 'running';
            return true;
        }
        const reason = signalAbortReason(signal);
        proc.abortController.abort(reason);
        this.finish(pid, reason.exitCode);
        return true;
    }
    /**
     * Reap a zombie process (remove from process table).
     * This should be called after collecting exit code.
     * Returns true if process was reaped, false if not found or not a zombie.
     */
    reap(pid) {
        const proc = this.processes.get(pid);
        // Only reap zombies (or explicitly stopped processes)
        if (!proc || (proc.status !== 'zombie' && proc.status !== 'stopped')) {
            return false;
        }
        // Cannot reap shell processes (they never exit)
        if (proc.command === 'shell') {
            return false;
        }
        this.processes.delete(pid);
        this.resolvers.delete(pid);
        return true;
    }
    /**
     * Collect and reap all zombie processes.
     * Returns array of reaped processes for display/logging.
     */
    collectZombies() {
        const zombies = this.getZombies().filter((p) => p.pid !== 1);
        for (const zombie of zombies) {
            this.processes.delete(zombie.pid);
            this.resolvers.delete(zombie.pid);
        }
        return zombies;
    }
    /**
     * Update process status.
     * Useful for manual status changes (e.g., sleeping, stopped).
     */
    updateStatus(pid, status) {
        const proc = this.processes.get(pid);
        if (!proc) {
            return false;
        }
        proc.status = status;
        return true;
    }
    /**
     * Get process uptime in milliseconds.
     */
    getUptime(pid) {
        const proc = this.processes.get(pid);
        if (!proc) {
            return null;
        }
        return Date.now() - proc.startTime;
    }
    /**
     * Get formatted process info (for ps command).
     */
    getFormattedInfo(pid) {
        const proc = this.processes.get(pid);
        if (!proc) {
            return null;
        }
        const uptime = Math.floor((Date.now() - proc.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        const statusSymbol = proc.status === 'zombie' ? ' <defunct>' :
            proc.status === 'stopped' ? ' <stopped>' : '';
        // Show full command line with arguments
        const fullCommand = proc.args.join(' ');
        return `${proc.pid.toString().padStart(5)} pts/0    ${time} ${fullCommand}${statusSymbol}`;
    }
    /**
     * Get process count.
     */
    count() {
        return this.processes.size;
    }
    /**
     * Clear all processes except shell (useful for testing).
     */
    reset() {
        const shell = this.processes.get(1);
        this.processes.clear();
        if (shell) {
            this.processes.set(1, shell);
        }
        this.nextPid = 2;
        this.nextJobId = 1;
        this.resolvers.clear();
    }
    finish(pid, code) {
        const proc = this.processes.get(pid);
        if (!proc || proc.exitCode !== null) {
            return;
        }
        proc.status = 'zombie';
        proc.exitCode = code;
        this.resolvers.get(pid)?.(code);
    }
}
