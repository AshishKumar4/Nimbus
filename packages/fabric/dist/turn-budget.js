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
/**
 * Bytes of launch work one turn may perform before it must yield.
 *
 * Sized so a chunk stays far below both the CPU ceiling and the span in which
 * a terminal socket is at risk, while keeping the number of turn handoffs —
 * each an alarm round trip — small enough not to dominate a launch. pi's
 * 22.9 MB map crosses this about a dozen times per phase that handles it.
 */
export const TURN_CHUNK_MAX_BYTES = 2_000_000;
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
export class TurnBudget {
    scheduler;
    maxChunkBytes;
    stillWanted;
    /** Turn handoffs this launch has taken. Reported with the launch. */
    chunks = 0;
    /** Total work accounted, for the same report. */
    bytes = 0;
    spent = 0;
    chunkEnded;
    /**
     * @param stillWanted Checked every time the launch resumes. A launch spans
     *   many turns, so anything may have happened to what it is building for
     *   while it was suspended; throwing from here is how a launch stops instead
     *   of spending turn after turn on work nothing will use. Checked at the one
     *   place a launch can be interrupted, rather than at whichever phases
     *   remembered to ask.
     */
    constructor(scheduler, maxChunkBytes = TURN_CHUNK_MAX_BYTES, stillWanted) {
        this.scheduler = scheduler;
        this.maxChunkBytes = maxChunkBytes;
        this.stillWanted = stillWanted;
    }
    /**
     * Account `bytes` of completed work, ending the turn if a chunk is full.
     *
     * Safe to call anywhere the launch holds no state that a concurrent turn
     * could invalidate — which is why the image store registers its whole root
     * set before the first call rather than one entry at a time.
     */
    async spend(bytes) {
        this.bytes += bytes;
        this.spent += bytes;
        if (this.spent < this.maxChunkBytes)
            return;
        this.spent = 0;
        this.chunks++;
        // Release the turn that resumed us before asking for the next one.
        this.chunkEnded?.resolve();
        const ended = withResolvers();
        this.chunkEnded = ended;
        await this.scheduler.nextTurn(ended.promise);
        this.stillWanted?.();
    }
    /**
     * The launch has finished (or failed). Releases the turn still waiting on
     * the chunk it resumed, so a launch that ends mid-chunk does not strand the
     * handler that granted it.
     */
    settle() {
        this.chunkEnded?.resolve();
        this.chunkEnded = undefined;
    }
}
function withResolvers() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}
/**
 * The granting side of {@link TurnScheduler}: parks suspended launches
 * and resumes every one of them when the host grants a fresh turn.
 */
export class PacedWork {
    host;
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
    waiters = [];
    constructor(host) {
        this.host = host;
    }
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
    nextTurn(chunkEnded) {
        return new Promise((resume) => {
            this.waiters.push({ resume, chunkEnded });
            if (this.host.requestTurn) {
                this.host.requestTurn();
                return;
            }
            setTimeout(() => { void this.pump(); }, 0);
        });
    }
    /**
     * Run one chunk of every launch waiting for a turn.
     *
     * Awaits the chunk each resumed launch then performs, so the invocation that
     * granted the turn is the invocation that pays for the work — rather than
     * releasing it into a handler's microtask drain, where nothing owns it and
     * the runtime may tear the context down mid-chunk.
     */
    async pump() {
        await this.host.recover?.();
        const waiting = this.waiters;
        if (waiting.length === 0)
            return;
        this.waiters = [];
        for (const waiter of waiting)
            waiter.resume();
        await Promise.all(waiting.map((waiter) => waiter.chunkEnded));
    }
    /** Whether any launch is suspended waiting for a turn. */
    get hasPending() {
        return this.waiters.length > 0;
    }
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
export function turnChunkMaxBytes(env) {
    const raw = env
        ?.NIMBUS_LAUNCH_CHUNK_BYTES;
    if (!raw)
        return TURN_CHUNK_MAX_BYTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : TURN_CHUNK_MAX_BYTES;
}
