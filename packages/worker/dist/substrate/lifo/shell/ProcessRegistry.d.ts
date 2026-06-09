/**
 * Process information structure
 * Mirrors Linux process model with PID, PPID, status, etc.
 */
export interface Process {
    /** Process ID (unique identifier) */
    pid: number;
    /** Parent Process ID */
    ppid: number;
    /** Command name (argv[0]) */
    command: string;
    /** Full command line arguments */
    args: string[];
    /** Working directory when process started */
    cwd: string;
    /** Environment variables */
    env: Record<string, string>;
    /** Process start time (milliseconds since epoch) */
    startTime: number;
    /** Current process status */
    status: 'running' | 'sleeping' | 'stopped' | 'zombie';
    /** Whether this is a foreground process */
    isForeground: boolean;
    /** Promise that resolves when process completes */
    promise: Promise<number>;
    /** Controller for aborting/killing the process */
    abortController: AbortController;
    /** Exit code (null if still running) */
    exitCode: number | null;
    /** Optional job ID for background jobs (for backwards compat with JobTable) */
    jobId?: number;
}
/**
 * Options for spawning a new process
 */
export interface SpawnOptions {
    /** Command name */
    command: string;
    /** Command arguments (including command itself as args[0]) */
    args: string[];
    /** Working directory */
    cwd: string;
    /** Environment variables */
    env: Record<string, string>;
    /** Whether this is a foreground process */
    isForeground: boolean;
    /** Promise that resolves with exit code */
    promise: Promise<number>;
    /** Abort controller for killing the process */
    abortController: AbortController;
    /** Parent PID (defaults to 1 - shell) */
    ppid?: number;
}
/**
 * Central process registry for tracking all running processes.
 * Provides Linux-like process management with PIDs, status tracking,
 * and process lifecycle management.
 */
export declare class ProcessRegistry {
    private processes;
    private resolvers;
    private nextPid;
    private nextJobId;
    private shellAbortController;
    registerShell(cwd: string, env: Record<string, string>): number;
    /**
     * Spawn a new process and register it in the process table.
     * Returns the assigned PID.
     */
    spawn(opts: SpawnOptions): number;
    /**
     * Get process information by PID.
     */
    get(pid: number): Process | undefined;
    /**
     * Get process information by job ID.
     */
    getByJobId(jobId: number): Process | undefined;
    /**
     * Check if a process exists.
     */
    has(pid: number): boolean;
    /**
     * Get all PIDs in the system.
     */
    getAllPIDs(): number[];
    /**
     * Get all processes.
     */
    getAll(): Process[];
    /**
     * Get all running processes (excludes zombies and stopped).
     */
    getRunning(): Process[];
    /**
     * Get all background jobs (non-foreground processes, excluding shell).
     */
    getBackgroundJobs(): Process[];
    /**
     * Get all zombie processes (finished but not reaped).
     */
    getZombies(): Process[];
    /**
     * Kill a process by sending abort signal.
     * Returns true if process was killed, false if not found or is a shell process.
     */
    kill(pid: number, signal?: string): boolean;
    /**
     * Reap a zombie process (remove from process table).
     * This should be called after collecting exit code.
     * Returns true if process was reaped, false if not found or not a zombie.
     */
    reap(pid: number): boolean;
    /**
     * Collect and reap all zombie processes.
     * Returns array of reaped processes for display/logging.
     */
    collectZombies(): Process[];
    /**
     * Update process status.
     * Useful for manual status changes (e.g., sleeping, stopped).
     */
    updateStatus(pid: number, status: Process['status']): boolean;
    /**
     * Get process uptime in milliseconds.
     */
    getUptime(pid: number): number | null;
    /**
     * Get formatted process info (for ps command).
     */
    getFormattedInfo(pid: number): string | null;
    /**
     * Get process count.
     */
    count(): number;
    /**
     * Clear all processes except shell (useful for testing).
     */
    reset(): void;
    private finish;
}
//# sourceMappingURL=ProcessRegistry.d.ts.map