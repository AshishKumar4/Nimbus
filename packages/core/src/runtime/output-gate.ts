/**
 * What holds a process's output back from its observers until the writes it
 * made before that output are published (SessionProcessSupervisor.setOutputGate).
 */
export interface OutputGate {
  /** Null when nothing of `pid`'s is held; otherwise settles once its output may go on. */
  before(pid: number): Promise<void> | null;
}

/** An output gate that is told where a process's output escapes it. */
export interface ProcessOutputGate extends OutputGate {
  /**
   * `pid`'s output leaves, from now on, by a way no gate sees (a raw socket):
   * its writes wait for their publication again.
   */
  escaped(pid: number): void;
}
