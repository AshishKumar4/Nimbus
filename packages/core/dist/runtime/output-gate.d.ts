/**
 * What holds a process's output back from its observers until the writes it
 * made before that output are published (SessionProcessSupervisor.setOutputGate).
 */
export interface OutputGate {
    /** Null when nothing of `pid`'s is held; otherwise settles once its output may go on. */
    before(pid: number): Promise<void> | null;
    /**
     * `pid`'s output leaves, from now on, by a way no gate sees (a raw socket):
     * its writes wait for their publication again.
     */
    escaped?(pid: number): void;
}
/**
 * Where what a supervised process makes visible leaves the session
 * (SessionProcessSupervisor): each effect once its gate lets it, in the
 * order the process made them, and the way out no gate sees it is told of.
 */
export interface ProcessOutput {
    releaseOutput<T>(pid: number, deliver: () => T): T | Promise<Awaited<T>>;
    escapeOutput(pid: number): void;
}
//# sourceMappingURL=output-gate.d.ts.map