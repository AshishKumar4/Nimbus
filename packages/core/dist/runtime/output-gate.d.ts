/**
 * What holds a process's output back from its observers until the writes it
 * made before that output are published (SessionProcessSupervisor.setOutputGate).
 */
export interface OutputGate {
    /** Null when nothing of `pid`'s is held; otherwise settles once its output may go on. */
    before(pid: number): Promise<void> | null;
}
//# sourceMappingURL=output-gate.d.ts.map