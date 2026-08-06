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
 *   sleep, on a thread or the main body          here
 *   Timeout.timeout's deadline                   here
 *   TCPServer#accept                             ruby-socket-shim
 *   IO.select, over Nimbus sockets or a timeout  ruby-socket-shim
 *   IO.pipe read on an empty pipe                ruby-socket-shim
 *
 * ── 2a. Why a timed wait cannot wait here ──────────────────────────────────
 *
 * workerd freezes the clock inside a turn - a deliberate timing-attack
 * mitigation, measured at 0ms elapsed across 200,000 Time.now reads. So a wait
 * that watches the clock can never end: it consumes the process's whole CPU
 * budget and the invocation is killed with nothing to show for it. Ruby's own
 * sleep is exactly that loop, which is why nothing here calls it.
 *
 * The clock belongs to the host, so a deadline is something to hand back
 * rather than something to watch. A parked thread records when it wants
 * waking; the main body hands the earliest such moment to the host and yields;
 * the host waits on a real timer and resumes the process with the clock moved
 * on. Every wait shape above therefore takes a deadline, and one that has no
 * deadline and nothing that could ever satisfy it is reported as a deadlock.
 *
 * That clock also has a RESOLUTION - Date.now, whole milliseconds - and a
 * deadline landing between two of them is one it can never report reaching.
 * `Time.now + 0.2` is exactly that deadline, because the double nearest 0.2 is
 * 0.2000000000000000111: measured on workerd, the host resumes the process at
 * precisely +200ms and the guest finds itself 1.1e-17s short, re-arms for the
 * remainder, is resumed again with the clock unmoved, and burns the budget one
 * round trip at a time. So a deadline is rounded UP onto the clock's grid as
 * it enters the scheduler, which is the only form of it that can be reached.
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
 * sharing a heap is not available at this level, and it is not available at any
 * other level either: every resident process is a DO Facet and facet siblings
 * serialise on CPU, so there is nowhere to offload it to.
 *
 * The sharp edge of no preemption is a hand-rolled busy-wait: `until Time.now
 * - t0 > 0.05; end` has no scheduling point, so nothing can reach it, and
 * because the clock is frozen (§2a) it does not merely spin - it never ends.
 * That is the one wait shape the scheduler cannot rescue. A program that wants
 * to wait has to say so, through one of the park-set entries above.
 *
 * ── 6. The same model, one layer down ──────────────────────────────────────
 *
 * runtime/wasi-threads.ts is this contract at the HOST layer: green threads as
 * multiple wasm instances over one shared linear memory, for guests whose
 * threads are pthreads rather than fibers. Same park set, same run-to-park
 * policy, same deadlock verdict, same honest limits. Two implementations of one
 * concurrency model at two layers - not two models.
 */
export const RUBY_GREEN_THREADS = String.raw `
module Nimbus
  # The scheduler. Owns every green thread and decides which may run.
  module Threading
    # Raised into a fiber to unwind it. Not a StandardError, so a bare
    # rescue-StandardError in user code cannot swallow a kill.
    class Killed < Exception; end

    class << self
      attr_accessor :running

      # A process becomes host-driven the moment it listens: from then on an
      # inbound request can resume it, so a wait with nothing else to wake it
      # is still a wait rather than a deadlock.
      attr_accessor :host_driven

      # The main body is not a GreenThread, so the scheduler holds its wait
      # state: when it wants waking, and any Timeout deadline armed over it.
      attr_accessor :main_deadline

      # The clock reports whole milliseconds and nothing finer, so a deadline
      # between two of them is unreachable and its wait never ends. Round up
      # onto the grid: rounding down would let a wait return early, and any
      # deadline built as now + a Float is a hair above one almost every time.
      CLOCK_RESOLUTION = Rational(1, 1000)

      def on_the_clock(deadline)
        Time.at((deadline.to_r / CLOCK_RESOLUTION).ceil * CLOCK_RESOLUTION)
      end

      def main_timeouts
        @main_timeouts ||= []
      end

      def threads
        @threads ||= []
      end

      def register(thread)
        threads << thread
        thread
      end

      def any_runnable?
        threads.any? { |t| !t.finished? && t.runnable? }
      end

      # The soonest moment any waiting context wants to be woken: its own
      # deadline, and any Timeout deadline armed over it. A wake is only ever a
      # chance to re-check, so waking early costs a turn and waking late misses
      # a deadline - which is why every deadline in the process is in here.
      def wake_moments
        moments = [main_deadline]
        main_timeouts.each { |entry| moments << entry[0] }
        threads.each do |thread|
          next if thread.finished?
          moments << thread.deadline
          thread.timeouts.each { |entry| moments << entry[0] }
        end
        moments
      end

      def earliest_deadline
        wake_moments.compact.min
      end

      # The deadlines Timeout has armed over whichever context is running.
      def timeouts
        running ? running.timeouts : main_timeouts
      end

      # Timeout can only fire where the block yields: nothing here can
      # interrupt code that does not. So the deadline is registered against the
      # context running the block and delivered at its next park - which is
      # every entry in the park set, and so every point at which the block was
      # going to be slow.
      def with_timeout(seconds, error_class, message)
        entry = [on_the_clock(Time.now + seconds), error_class, message]
        armed = timeouts
        armed << entry
        begin
          yield
        ensure
          armed.delete(entry)
        end
      end

      # Ruby's own Timeout raises INTO the thread running the block, from a
      # watchdog thread. The main body is the fiber the host resumes rather
      # than a thread anything can raise into, so that delivery has nowhere to
      # land. Registering the deadline here delivers it at the block's next
      # wait instead, which is every point where the block was going to be
      # slow, and the only point anything here can interrupt it at all.
      def install_timeout_shim
        return unless defined?(::Timeout)
        return if ::Timeout.respond_to?(:__nimbus_scheduled_timeout)
        ::Timeout.singleton_class.class_eval do
          define_method(:__nimbus_scheduled_timeout) { true }
          define_method(:timeout) do |sec = nil, klass = nil, message = nil, &block|
            raise LocalJumpError, 'no block given (yield)' unless block
            return block.call(sec) if sec.nil? || sec.to_f <= 0
            Nimbus::Threading.with_timeout(
              sec.to_f, klass || ::Timeout::Error, message || 'execution expired'
            ) { block.call(sec) }
          end
        end
      end

      # Deliver a deadline that has passed for the context now running. Called
      # at every scheduling point, which is the whole of when it can be.
      def check_timeouts
        armed = timeouts
        entry = armed.find { |candidate| Time.now >= candidate[0] }
        return nil unless entry
        armed.delete(entry)
        raise entry[1], entry[2]
      end

      # One scheduling pass: every runnable thread, in creation order, gets a
      # turn. Returns whether any of them ran.
      def run_others
        ran = false
        threads.dup.each do |thread|
          next if thread.finished? || thread.equal?(running) || !thread.runnable?
          thread.__nimbus_step
          ran = true
        end
        ran
      end

      # Wait, optionally until a deadline. What waiting means depends on who is
      # waiting.
      #
      # A spawned thread yields to the scheduler, recording what would unblock
      # it and when it wants waking. The main body has no scheduler above it,
      # so it runs its peers instead; if none of them can move either, it hands
      # the earliest deadline in the process to the host and yields, because
      # the host is what owns the clock and what advances it.
      def park(condition = nil, deadline = nil)
        deadline = on_the_clock(deadline) if deadline
        wait = if condition && deadline
                 -> { condition.call || Time.now >= deadline }
               elsif deadline
                 -> { Time.now >= deadline }
               else
                 condition
               end
        thread = running
        if thread
          thread.blocked_on = wait
          thread.deadline = deadline
          begin
            Fiber.yield
          ensure
            thread.blocked_on = nil
            thread.deadline = nil
          end
          check_timeouts
          return nil
        end
        previous = main_deadline
        self.main_deadline = deadline
        begin
          progressed = run_others
          check_timeouts
          return nil if wait && wait.call
          return nil if progressed
          return nil if wait.nil?
          soonest = earliest_deadline
          # Nothing in the process is due, and no request will arrive to change
          # that. Every context is blocked on something none of them can
          # produce, so say so instead of hanging.
          unless soonest || host_driven
            raise ThreadError, 'deadlock: every thread is blocked and nothing can wake them'
          end
          # Hand the host the earliest deadline and give control back: it owns
          # the clock, so it can serve other inbound connections meanwhile
          # instead of the process sitting in one sleep.
          $__nimbus_wake_after = soonest ? [soonest - Time.now, 0.0].max : nil
          begin
            Fiber.yield
          ensure
            $__nimbus_wake_after = nil
          end
          check_timeouts
        ensure
          self.main_deadline = previous
        end
        nil
      end

      # Give up this turn without waiting for anything in particular.
      def pass
        thread = running
        if thread
          thread.blocked_on = nil
          Fiber.yield
        else
          run_others
        end
        check_timeouts
        nil
      end

      # Process exit: unwind every surviving thread so its ensure blocks run
      # and its descriptors close. Ruby's own semantics for the main thread
      # ending, and the reason a parked fiber never leaks a socket.
      #
      # The scheduler's own state goes with them. A pooled VM runs one program
      # after another, and a deadline, an armed timeout or a host-driven flag
      # left behind would belong to the program before.
      def shutdown
        threads.dup.each { |t| t.kill unless t.finished? }
        threads.clear
        main_timeouts.clear
        self.main_deadline = nil
        self.host_driven = false
        nil
      end
    end
  end

  # One green thread: a fiber, what it is waiting for, and its result.
  class GreenThread
    attr_accessor :blocked_on, :deadline
    attr_accessor :name, :abort_on_exception, :report_on_exception

    def initialize(*args, &block)
      @locals = {}
      @finished = false
      @blocked_on = nil
      @deadline = nil
      @value = nil
      @error = nil
      @fiber = Fiber.new do
        begin
          @value = block.call(*args)
        rescue Nimbus::Threading::Killed
          # Killed: unwound on purpose, not an error to re-raise at join.
        rescue Exception => e
          @error = e
          __nimbus_report_exception(e)
        end
      end
      Nimbus::Threading.register(self)
    end

    # Ruby reports a thread that dies with an exception unless asked not to,
    # and a thread nobody joins is exactly the case where that report is the
    # only evidence there is. A green thread that reaches a primitive it cannot
    # satisfy dies here, so staying silent turns a broken program into a
    # program that merely does less than it was asked.
    def __nimbus_report_exception(error)
      report = @report_on_exception.nil? ? Thread.report_on_exception : @report_on_exception
      return unless report
      $stderr.write("#<Thread:#{object_id} #{@name || 'green'}> terminated with exception:\n")
      $stderr.write(error.full_message(highlight: false, order: :top))
    end

    # Deadlines Timeout has armed over this thread, innermost last.
    def timeouts
      @timeouts ||= []
    end

    def runnable?
      return false if @finished
      return true if timeouts.any? { |entry| Time.now >= entry[0] }
      return true if @blocked_on.nil?
      @blocked_on.call
    end

    def finished?
      @finished
    end

    def __nimbus_step
      previous = Nimbus::Threading.running
      Nimbus::Threading.running = self
      begin
        @fiber.resume if @fiber.alive?
      ensure
        Nimbus::Threading.running = previous
        @finished = !@fiber.alive?
      end
    end

    def join(limit = nil)
      deadline = limit ? Time.now + limit : nil
      until finished?
        return nil if deadline && Time.now >= deadline
        Nimbus::Threading.park(-> { finished? }, deadline)
      end
      # Kernel.raise, not Thread#raise: this class defines the latter, which
      # would deliver the error back INTO the finished thread instead of
      # re-raising it here.
      Kernel.raise(@error) if @error
      self
    end

    def value
      join
      @value
    end

    def alive?
      !@finished
    end

    def status
      return false if @finished && @error.nil?
      return nil if @error
      @blocked_on ? 'sleep' : 'run'
    end

    def stop?
      @finished || !@blocked_on.nil?
    end

    # Unwind the fiber so ensure blocks run and descriptors close.
    def kill
      return self if @finished
      begin
        @fiber.raise(Nimbus::Threading::Killed, 'thread killed') if @fiber.alive?
      rescue Exception
        # The fiber may already be unwinding; either way it is done.
      ensure
        @finished = true
        @blocked_on = nil
      end
      self
    end
    alias exit kill
    alias terminate kill

    def wakeup
      @blocked_on = nil
      self
    end
    alias run wakeup

    # Thread#raise: deliver an exception INTO another thread. Watchdogs and
    # timeout handlers are built on it, so a thread without it is not a thread.
    # Fiber#raise resumes the target with the exception, which is exactly the
    # delivery semantics - the target unwinds through its own ensure blocks.
    def raise(*args)
      return self if @finished
      error = case args.length
              when 0 then RuntimeError.new('unhandled exception')
              when 1 then args[0].is_a?(String) ? RuntimeError.new(args[0]) : args[0]
              else args[0].exception(args[1])
              end
      previous = Nimbus::Threading.running
      Nimbus::Threading.running = self
      begin
        @fiber.raise(error) if @fiber.alive?
      rescue Exception => e
        @error = e
      ensure
        Nimbus::Threading.running = previous
        @finished = !@fiber.alive?
        @blocked_on = nil
      end
      self
    end

    def priority
      0
    end

    def priority=(value)
      value
    end

    def group
      nil
    end

    def backtrace
      []
    end

    def inspect
      '#<Thread green ' + (@finished ? 'dead' : 'run') + '>'
    end

    def [](key)
      @locals[key]
    end

    def []=(key, value)
      @locals[key] = value
    end

    def key?(key)
      @locals.key?(key)
    end

    def keys
      @locals.keys
    end

    def thread_variable_get(key)
      @locals[key]
    end

    def thread_variable_set(key, value)
      @locals[key] = value
    end

    def thread_variable?(key)
      @locals.key?(key)
    end
  end

  # The main body is not a GreenThread - it is the fiber the host resumes - but
  # Thread.current has to answer for it, so it gets a stand-in carrying
  # thread-locals.
  class MainThread
    def initialize
      @locals = {}
    end

    def alive?
      true
    end

    def status
      'run'
    end

    def join(_limit = nil)
      self
    end

    def value
      nil
    end

    def name
      'main'
    end

    def name=(value)
      value
    end

    def kill
      self
    end

    def [](key)
      @locals[key]
    end

    def []=(key, value)
      @locals[key] = value
    end

    def key?(key)
      @locals.key?(key)
    end

    def keys
      @locals.keys
    end

    def thread_variable_get(key)
      @locals[key]
    end

    def thread_variable_set(key, value)
      @locals[key] = value
    end

    def abort_on_exception=(value)
      value
    end

    def report_on_exception=(value)
      value
    end
  end
end

class Thread
  class << self
    def new(*args, &block)
      raise ThreadError, 'must be called with a block' unless block
      Nimbus::GreenThread.new(*args, &block)
    end
    alias_method :start, :new
    alias_method :fork, :new

    def current
      Nimbus::Threading.running || main
    end

    def main
      @__nimbus_main ||= Nimbus::MainThread.new
    end

    def pass
      Nimbus::Threading.pass
    end

    def list
      [main] + Nimbus::Threading.threads.reject(&:finished?)
    end

    # The default a thread inherits for reporting its own death. Ruby's is on,
    # and a program that turns it off has to be able to.
    attr_writer :report_on_exception

    def report_on_exception
      defined?(@report_on_exception) ? @report_on_exception : true
    end
  end
end

# ThreadGroup only tracks threads; with green threads there is nothing to
# isolate, but servers still add to one and join its members.
class NimbusThreadGroup
  def initialize
    @members = []
  end

  def add(thread)
    @members << thread
    self
  end

  def list
    @members
  end

  def enclose
    self
  end

  def enclosed?
    false
  end
end

# A queue that blocks the way a queue should: popping an empty one parks the
# caller until a push arrives. That hand-off is exactly what cannot work
# without real threads, so it is the sharpest test that these are real.
class NimbusQueue
  def initialize
    @items = []
    @closed = false
  end

  def push(item)
    raise ClosedQueueError, 'queue closed' if @closed
    @items << item
    self
  end
  alias << push
  alias enq push

  def pop(non_block = false)
    loop do
      return @items.shift unless @items.empty?
      return nil if @closed
      raise ThreadError, 'queue empty' if non_block
      Nimbus::Threading.park(-> { !@items.empty? || @closed })
    end
  end
  alias shift pop
  alias deq pop

  def close
    @closed = true
    self
  end

  def closed?
    @closed
  end

  def empty?
    @items.empty?
  end

  def size
    @items.size
  end
  alias length size

  def clear
    @items.clear
    self
  end

  def num_waiting
    0
  end
end

class NimbusSizedQueue < NimbusQueue
  attr_reader :max

  def initialize(max)
    raise ArgumentError, 'queue size must be positive' unless max.to_i > 0
    @max = max.to_i
    super()
  end

  def push(item)
    Nimbus::Threading.park(-> { size < @max }) while size >= @max
    super
  end
  alias << push
  alias enq push
end

# A mutex that parks rather than deadlocking. Ruby's own Mutex assumes real
# threads: locking one already held raises on the single OS thread instead of
# waiting, which is wrong once the waiter is a fiber that could yield.
class NimbusMutex
  def initialize
    @owner = nil
  end

  def lock
    Nimbus::Threading.park(-> { @owner.nil? }) until @owner.nil?
    @owner = Nimbus::Threading.running || :main
    self
  end

  def unlock
    @owner = nil
    self
  end

  def try_lock
    return false unless @owner.nil?
    lock
    true
  end

  def locked?
    !@owner.nil?
  end

  def owned?
    @owner == (Nimbus::Threading.running || :main)
  end

  def synchronize
    lock
    begin
      yield
    ensure
      unlock
    end
  end

  def sleep(timeout = nil)
    unlock
    begin
      Kernel.sleep(timeout)
    ensure
      lock
    end
  end
end

class NimbusConditionVariable
  def initialize
    @signalled = 0
  end

  def wait(mutex, timeout = nil)
    mutex.unlock
    begin
      deadline = timeout ? Time.now + timeout : nil
      target = @signalled + 1
      until @signalled >= target
        break if deadline && Time.now >= deadline
        Nimbus::Threading.park(-> { @signalled >= target }, deadline)
      end
    ensure
      mutex.lock
    end
    self
  end

  def signal
    @signalled += 1
    self
  end

  def broadcast
    @signalled += 1_000_000
    self
  end
end

# Ruby's own Queue, SizedQueue, Mutex and ConditionVariable block the VM: they
# wait for an OS thread to wake them, which a fiber can never be, so the first
# green thread that touches one stops the whole process - and dies with a
# fatal nobody sees. Ruby exports each of them under BOTH ::Queue and
# Thread::Queue, and defines both itself, so these are replacements rather than
# defaults: a guard that only fills in what is missing would never fire, and
# leaving either spelling on the real class is worse than leaving both, because
# a program then gets one parking primitive and one blocking one.
{
  Queue: NimbusQueue,
  SizedQueue: NimbusSizedQueue,
  Mutex: NimbusMutex,
  ConditionVariable: NimbusConditionVariable,
}.each_pair do |name, impl|
  [Object, Thread].each do |scope|
    scope.send(:remove_const, name) if scope.const_defined?(name, false)
    scope.const_set(name, impl)
  end
end

# ThreadGroup has no namespaced spelling; it only tracks threads, so a
# green-thread group has nothing to isolate.
Object.send(:remove_const, :ThreadGroup) if Object.const_defined?(:ThreadGroup, false)
Object.const_set(:ThreadGroup, NimbusThreadGroup)

module Kernel
  # Ruby's own sleep waits by watching the clock, which is frozen inside a
  # turn: it cannot end, and consumes the process's whole CPU budget trying. So
  # sleeping is parking with a deadline, and the host is what waits.
  #
  # With no duration, sleep means "until something wakes me". A thread parks on
  # a condition only Thread#wakeup can clear. The main body has no such caller,
  # so it keeps running its peers - and if none of them can move either, park
  # reports the deadlock rather than waiting for a caller that cannot exist.
  #
  # Guard on BOTH visibilities: module_function below makes the method public,
  # so a private-only check would fail on a second application and re-alias
  # sleep onto itself, recursing until the stack dies.
  unless method_defined?(:__nimbus_scheduled_sleep) || private_method_defined?(:__nimbus_scheduled_sleep)
    def __nimbus_scheduled_sleep(seconds = nil)
      started = Time.now
      if seconds.nil?
        if Nimbus::Threading.running
          Nimbus::Threading.park(-> { false })
        else
          loop { Nimbus::Threading.park(-> { false }) }
        end
      else
        # Park first, then test: a zero or already-elapsed duration is Ruby's
        # spelling of "give someone else a turn", and returning without one
        # turns that idiom into a busy loop.
        deadline = started + seconds
        loop do
          Nimbus::Threading.park(nil, deadline)
          break if Time.now >= deadline
        end
      end
      (Time.now - started).round
    end
    module_function :__nimbus_scheduled_sleep
    public :__nimbus_scheduled_sleep

    # Kernel.sleep is a SEPARATE copy taken when Ruby ran module_function on
    # its own sleep, so redefining the instance method leaves callers of the
    # module function on the original - the one that cannot end.
    alias_method :sleep, :__nimbus_scheduled_sleep
    module_function :sleep
  end
end
`;
