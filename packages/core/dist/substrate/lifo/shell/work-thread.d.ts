/**
 * One thread of a shell's control as its process's work: a line, an element
 * of a pipeline, a background job. The session tells a process doing nothing
 * but await its children by counting its units of work against its awaits
 * (SessionProcessSupervisor.beginWork / beginAwait, CommandIdentity.beginWork):
 * a command that runs a program counts one of each, a builtin one of work.
 *
 * Between two commands a thread is the shell's own work: it is expanding the
 * next command's words, opening its redirections, looking it up, or
 * deciding whether to run it at all (`&&`, `if`, a loop's next pass). So a
 * thread holds a unit of its own whenever no command of its runs, and lends
 * it to its commands while one does: a command's unit is taken before the
 * thread's is let go, and the thread's is taken back before the command's
 * ends, so the process's count never dips between two steps, whichever turn
 * the next one starts on. A thread waiting on a command that only awaits a
 * program adds nothing to that await, so a shell stuck on its program is
 * still told as such.
 *
 * A pipeline's elements are threads the pipeline's thread waits on (fork):
 * it lends its unit to them as to a command. A background job runs beside
 * the thread that started it (sibling), on a unit of its own.
 */
export declare class WorkThread {
    private readonly begin;
    private readonly root;
    /** The thread's own unit, while no unit under it is in flight. */
    private held;
    /** Units under it in flight: commands, and threads it waits on. */
    private active;
    private closed;
    /**
     * @param begin a unit of the process's work (or of the thread this one
     *   is under), as SessionProcessSupervisor.beginWork gives one.
     * @param root the process's own, for a thread beside this one.
     */
    constructor(begin: () => () => void, root?: () => () => void);
    /** A unit of work under this thread (a command it runs), until the returned function is called. */
    beginWork(): () => void;
    /** A thread this one waits on (a pipeline element), lent this one's unit while it runs. */
    fork(): WorkThread;
    /** A thread beside this one (a background job), on a unit of the process's own. */
    sibling(): WorkThread;
    /** The thread has ended: its unit is let go, and is not taken back. */
    close(): void;
}
//# sourceMappingURL=work-thread.d.ts.map