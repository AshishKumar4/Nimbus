/**
 * turn-budget.ts — spreading a resident launch across Durable Object turns.
 *
 * Building a resident process is the largest single span of computation this
 * session performs: for pi it walks a 17 MB source tree through eight
 * enrichment passes, serializes a 22.9 MB module map, and writes that map into
 * the image store. Done in one turn it occupied the session DO's only thread
 * for 15-35 s, and a session that cannot reach its thread cannot service the
 * terminal WebSocket — the launch turn finished `outcome=ok` and the terminal
 * died anyway, painting "[process terminal closed]" over a process that was
 * still running.
 *
 * A faster launch does not fix that. A launch half the length still blocks the
 * thread for as long as it runs, and the socket is dropped inside that window
 * whether or not the work succeeds. What fixes it is never holding the thread
 * for long in the first place, which means suspending the launch at bounded
 * intervals and resuming it on a fresh turn. Responsiveness stops depending on
 * how long the total work takes.
 *
 * A fresh turn is also a fresh CPU budget. The same launches that dropped the
 * socket were also being killed with `exceededCpu` at 31.8 s and 32.5 s
 * against a 30 s ceiling, and no amount of yielding *within* one invocation
 * moves that: CPU accrues to the invocation, not to the pause. Only genuinely
 * re-entering the object resets it.
 *
 * Progress is measured in bytes rather than milliseconds because workerd's
 * clock does not advance without I/O — a wall-clock guard inside a span of
 * pure computation reads zero however many seconds it burns, which is why the
 * phase costs behind this module had to be recovered from per-turn `cpuTime`
 * rather than measured in place. Bytes are what the work is actually
 * proportional to, and they are exact. The same reasoning is why
 * `git/network-facet.ts` bounds its checkout chunks by entries and decoded
 * bytes and treats its wall guard as coarse.
 */
/** How a paced launch gets back onto a fresh Durable Object turn. */
export interface TurnScheduler {
    /**
     * Suspend until a fresh turn is running this launch again.
     *
     * `chunkEnded` settles when the resumed launch reaches its next suspension
     * point or finishes, so whoever grants the turn can await the work it just
     * released rather than letting it run detached in a handler's microtask
     * drain.
     */
    nextTurn(chunkEnded: Promise<void>): Promise<void>;
}
/**
 * Bytes of launch work one turn may perform before it must yield.
 *
 * Sized so a chunk stays far below both the CPU ceiling and the span in which
 * a terminal socket is at risk, while keeping the number of turn handoffs —
 * each an alarm round trip — small enough not to dominate a launch. pi's
 * 22.9 MB map crosses this about a dozen times per phase that handles it.
 */
export declare const TURN_CHUNK_MAX_BYTES = 2000000;
/**
 * Accounts launch progress and ends the turn when a chunk's worth has been
 * spent.
 *
 * Callers report the work they are about to do or have just done and await
 * the result; a pacer that is not yielding returns without suspending, so the
 * one-shot exec path — which passes no pacer at all — keeps its exact
 * behaviour and cost. Nothing here decides WHAT the launch does, only where it
 * is allowed to stop.
 */
export declare class TurnBudget {
    private readonly scheduler;
    private readonly maxChunkBytes;
    private readonly stillWanted?;
    /** Turn handoffs this launch has taken. Reported with the launch. */
    chunks: number;
    /** Total work accounted, for the same report. */
    bytes: number;
    private spent;
    private chunkEnded;
    /**
     * @param stillWanted Checked every time the launch resumes. A launch spans
     *   many turns, so anything may have happened to what it is building for
     *   while it was suspended; throwing from here is how a launch stops instead
     *   of spending turn after turn on work nothing will use. Checked at the one
     *   place a launch can be interrupted, rather than at whichever phases
     *   remembered to ask.
     */
    constructor(scheduler: TurnScheduler, maxChunkBytes?: number, stillWanted?: (() => void) | undefined);
    /**
     * Account `bytes` of completed work, ending the turn if a chunk is full.
     *
     * Safe to call anywhere the launch holds no state that a concurrent turn
     * could invalidate — which is why the image store registers its whole root
     * set before the first call rather than one entry at a time.
     */
    spend(bytes: number): Promise<void>;
    /**
     * The launch has finished (or failed). Releases the turn still waiting on
     * the chunk it resumed, so a launch that ends mid-chunk does not strand the
     * handler that granted it.
     */
    settle(): void;
}
/** What {@link PacedWork} needs from the Durable Object hosting it. */
export interface PacedWorkHost {
    /**
     * Arrange for {@link PacedWork.pump} to run on a fresh Durable Object
     * turn.
     *
     * The embedder satisfies this with an alarm, which is the only primitive
     * that genuinely re-enters the object: a fresh turn is both a released
     * thread and a fresh CPU budget, and a launch needs each for a different
     * reason. Without it the pump degrades to a same-context timer — see
     * {@link PacedWork.nextTurn}.
     */
    requestTurn?: () => void;
}
/**
 * The granting side of {@link TurnScheduler}: parks suspended launches
 * and resumes every one of them when the host grants a fresh turn.
 */
export declare class PacedWork implements TurnScheduler {
    private readonly ctx;
    private readonly host;
    /**
     * Launches suspended between chunks, waiting for a turn of their own.
     *
     * In-memory on purpose: a launch is only meaningful while the process table
     * entry it is building for exists, and both are lost together if the isolate
     * resets. What survives a reset is the journal, which names the launch's
     * INPUTS rather than its position — a resumed queue would be resurrecting
     * half-built work for pids that no longer exist, where re-driving a launch
     * from its inputs is the same idempotent work again.
     */
    private waiters;
    /**
     * `ctx` keys the cold-start queue the pump drains first on every turn it
     * grants — see {@link pump}.
     */
    constructor(ctx: object, host: PacedWorkHost);
    /**
     * How a paced launch asks for a fresh turn.
     *
     * The host grants one by calling {@link pump} from a context that is
     * genuinely a new invocation — the session's alarm. Without such a host
     * there is no fresh turn to be had, and the launch continues on this one
     * rather than hanging: that is exactly the single-turn launch this path has
     * always performed, so a harness or a runtime without alarms loses the
     * responsiveness but keeps the behaviour.
     */
    nextTurn(chunkEnded: Promise<void>): Promise<void>;
    /**
     * Run one chunk of every launch waiting for a turn.
     *
     * Awaits the chunk each resumed launch then performs, so the invocation that
     * granted the turn is the invocation that pays for the work — rather than
     * releasing it into a handler's microtask drain, where nothing owns it and
     * the runtime may tear the context down mid-chunk.
     */
    pump(): Promise<void>;
    /** Whether any launch is suspended waiting for a turn. */
    get hasPending(): boolean;
}
/**
 * Chunk bound for this session, honouring the verification knob.
 *
 * `NIMBUS_LAUNCH_CHUNK_BYTES` forces a small bound so an ordinary launch —
 * not just a pathological one — crosses several turns and exercises every
 * suspension point. Without it the multi-turn path would only ever be
 * reached by the largest programs, which is the same reason
 * `git/commands.ts` carries `NIMBUS_GIT_CHECKOUT_CHUNK_ENTRIES`. Unset in
 * production, where the default applies.
 */
export declare function turnChunkMaxBytes(env: unknown): number;
//# sourceMappingURL=turn-budget.d.ts.map