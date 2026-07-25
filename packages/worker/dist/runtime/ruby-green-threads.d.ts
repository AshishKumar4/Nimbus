/**
 * ruby-green-threads.ts - the concurrency substrate for ruby.wasm.
 *
 * This is a kernel component, not a shim to make one library pass. It is the
 * model every guest runtime on Nimbus can use, so the contract is written down
 * rather than left to be inferred.
 *
 * ── Why fibers ─────────────────────────────────────────────────────────────
 *
 * ruby.wasm has one thread of execution; `Thread.new` raises
 * NotImplementedError. Running the block inline and returning a thread-shaped
 * object is not a thread - it is a function call wearing a thread's name, and
 * every program that uses threads for concurrency deadlocks or answers wrongly
 * with no error.
 *
 * A fiber is a real suspension, and - this is the load-bearing property -
 * one that survives a workerd request boundary. See "State ownership" below.
 * So a thread is a fiber, and the scheduler here runs them: M:1 green threads,
 * the model Ruby itself used before 1.9 and the model Node still uses to serve
 * thousands of concurrent connections on one thread.
 *
 * ── 1. Scheduling policy ───────────────────────────────────────────────────
 *
 * Round-robin, run-to-park, no priorities. Each scheduling pass walks the
 * threads in creation order and resumes every one whose wait condition is
 * satisfied. A resumed thread runs until it parks or finishes.
 *
 * There is NO preemption, and none is possible: nothing can interrupt a fiber
 * that does not yield. A CPU-bound thread therefore holds the process until it
 * finishes. That is bounded and observable rather than silent - the virtual
 * socket kernel's response timer fires and the caller gets a 504 naming the
 * port, instead of a request that hangs forever. It is not hidden and it is
 * not a bug to be "fixed" by going back to inline execution.
 *
 * ── 2. The park set ────────────────────────────────────────────────────────
 *
 * Every operation that can block MUST park, or it is a latent deadlock. The
 * complete set, and where each lives:
 *
 *   Thread#join, Thread#value                    here
 *   Queue#pop (empty), SizedQueue#push (full)    here
 *   Mutex#lock (held), ConditionVariable#wait    here
 *   sleep, inside a spawned thread               here
 *   TCPServer#accept                             ruby-socket-shim
 *   IO.select over Nimbus sockets                ruby-socket-shim
 *   IO.pipe read on an empty pipe                ruby-socket-shim
 *
 * Ruby exports the synchronisation primitives under two names each - ::Queue
 * and Thread::Queue - and defines both itself. BOTH have to resolve to the
 * implementations here: the real ones wait for an OS thread to wake them,
 * which a fiber can never be, so the first green thread that reaches one stops
 * the process for good. WEBrick's timeout watcher reaches Thread::Queue#pop on
 * its second connection, which is exactly how that was found.
 *
 * Deliberately NOT parked, and why it is safe: reads and writes on a CONNECTED
 * socket descriptor suspend the wasm stack through JSPI instead of yielding to
 * peers. An accepted connection's request is already buffered when it is
 * accepted, and a dialed connection's response is produced by the host within
 * the same request, so neither can wait on another green thread - they cannot
 * deadlock. They do not interleave either: a thread blocked in a socket read
 * stops its peers until the bytes arrive.
 *
 * ── 3. State ownership across the request boundary ─────────────────────────
 *
 * A workerd request context will NOT resume a wasm stack that a different
 * request suspended. Measured: three requests inside one context all serve in
 * 6ms; the first request in a new context times out at 30s. So what a thread
 * is suspended in decides whether it survives:
 *
 *   Fiber stacks, Ruby objects, thread-locals   Ruby VM linear memory - SURVIVES
 *   A JSPI-suspended wasm stack                 bound to its request - DOES NOT
 *   Accept queues, connection byte queues       host JS (the kernel) - SURVIVES
 *
 * The rule that falls out: a thread that must outlive the current request may
 * only ever be suspended by Fiber.yield. That is why every entry in the park
 * set above routes through Threading.park, and why the socket shim's blocking
 * accept parks instead of awaiting the host.
 *
 * ── 4. Termination ─────────────────────────────────────────────────────────
 *
 * Thread#kill and process shutdown raise inside the fiber (Fiber#raise), so
 * `ensure` blocks run and sockets close. Nothing is left parked holding a
 * descriptor: when the main body finishes, every surviving thread is killed
 * the same way, which is Ruby's own semantics for process exit.
 *
 * ── 5. Honest limits ───────────────────────────────────────────────────────
 *
 * No parallelism: one thread of execution, so CPU-bound work in a fiber blocks
 * everyone until it yields. No preemption: scheduling points are the park set,
 * nothing else. For I/O-bound work - per-connection handlers, watchdogs,
 * timeouts - that is the whole of what threads are for here. CPU-parallel work
 * sharing a heap is not available at this level and belongs to the process
 * fabric on peer DOs.
 */
export declare const RUBY_GREEN_THREADS: string;
//# sourceMappingURL=ruby-green-threads.d.ts.map