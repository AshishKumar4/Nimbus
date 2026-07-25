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
export const RUBY_GREEN_THREADS = String.raw `
module Nimbus
  # The scheduler. Owns every green thread and decides which may run.
  module Threading
    # Raised into a fiber to unwind it. Not a StandardError, so a bare
    # rescue-StandardError in user code cannot swallow a kill.
    class Killed < Exception; end

    class << self
      attr_accessor :running

      # A process becomes host-driven the moment it listens: from then on
      # inbound requests resume it, so waiting means handing control back to
      # the host. Until then nothing outside will ever resume this process, so
      # waiting has to happen on the wall clock right here.
      attr_accessor :host_driven

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

      # The soonest moment a sleeping thread wants to wake, or nil.
      def earliest_deadline
        threads.map { |t| t.finished? ? nil : t.deadline }.compact.min
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

      # Wait. What that means depends on who is waiting.
      #
      # A spawned thread yields to the scheduler, recording what would unblock
      # it. The main body has no scheduler above it, so it runs its peers
      # instead; if none of them can move either, it waits on real time when a
      # sleeper is due, and otherwise yields out to the host, which resumes the
      # process once the world has changed.
      def park(condition = nil)
        thread = running
        if thread
          thread.blocked_on = condition
          begin
            Fiber.yield
          ensure
            thread.blocked_on = nil
          end
          return nil
        end
        progressed = run_others
        return nil if condition && condition.call
        return nil if progressed
        return nil if condition.nil?
        deadline = earliest_deadline
        unless host_driven
          # Nothing outside will resume this process, so wait here.
          if deadline
            remaining = deadline - Time.now
            Kernel.__nimbus_wall_sleep(remaining) if remaining > 0
            return nil
          end
          # Every thread is blocked on something none of them can produce, and
          # no request will arrive to change that. Say so instead of hanging.
          raise ThreadError, 'deadlock: every thread is blocked and nothing can wake them'
        end
        # Tell the host how long until the earliest sleeper is due and hand
        # control back: the host owns the clock, so it can serve other inbound
        # connections meanwhile instead of the process sitting in one sleep.
        $__nimbus_wake_after = deadline ? [deadline - Time.now, 0.0].max : nil
        begin
          Fiber.yield
        ensure
          $__nimbus_wake_after = nil
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
        nil
      end

      # Process exit: unwind every surviving thread so its ensure blocks run
      # and its descriptors close. Ruby's own semantics for the main thread
      # ending, and the reason a parked fiber never leaks a socket.
      def shutdown
        threads.dup.each { |t| t.kill unless t.finished? }
        threads.clear
        nil
      end
    end
  end

  # One green thread: a fiber, what it is waiting for, and its result.
  class GreenThread
    attr_accessor :blocked_on
    attr_accessor :name, :abort_on_exception, :report_on_exception
    attr_reader :deadline

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
        end
      end
      Nimbus::Threading.register(self)
    end

    # Sleep without stopping the world: park with a deadline the scheduler can
    # see, so peers keep running and the main body knows when to wake us.
    def sleep_until(deadline)
      @deadline = deadline
      begin
        Nimbus::Threading.park(-> { Time.now >= deadline })
      ensure
        @deadline = nil
      end
    end

    def runnable?
      return false if @finished
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
        Nimbus::Threading.park(-> { finished? })
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

Object.send(:remove_const, :ThreadGroup) if defined?(::ThreadGroup)
ThreadGroup = NimbusThreadGroup

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

Object.send(:remove_const, :Queue) if defined?(::Queue)
Queue = NimbusQueue
Object.send(:remove_const, :SizedQueue) if defined?(::SizedQueue)
SizedQueue = NimbusSizedQueue
Thread.const_set(:Queue, NimbusQueue) unless Thread.const_defined?(:Queue, false)
Thread.const_set(:SizedQueue, NimbusSizedQueue) unless Thread.const_defined?(:SizedQueue, false)

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
      timeout ? Kernel.sleep(timeout) : Nimbus::Threading.park
    ensure
      lock
    end
  end
end

Object.send(:remove_const, :Mutex) if defined?(::Mutex)
Mutex = NimbusMutex
Thread.const_set(:Mutex, NimbusMutex) unless Thread.const_defined?(:Mutex, false)

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
        Nimbus::Threading.park(-> { @signalled >= target })
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

Object.send(:remove_const, :ConditionVariable) if defined?(::ConditionVariable)
ConditionVariable = NimbusConditionVariable
Thread.const_set(:ConditionVariable, NimbusConditionVariable) unless Thread.const_defined?(:ConditionVariable, false)

module Kernel
  # The real sleep suspends the whole wasm stack, stopping every green thread
  # with it. A spawned thread therefore sleeps by parking with a deadline so
  # its peers keep running; the main body still sleeps for real, once its peers
  # have nothing left to do.
  #
  # Guard on BOTH visibilities: module_function below makes the alias public,
  # so a private-only check would fail on a second application and re-alias
  # __nimbus_wall_sleep onto the override, recursing until the stack dies.
  unless method_defined?(:__nimbus_wall_sleep) || private_method_defined?(:__nimbus_wall_sleep)
    alias_method :__nimbus_wall_sleep, :sleep
    module_function :__nimbus_wall_sleep
    public :__nimbus_wall_sleep

    def sleep(seconds = nil)
      thread = Nimbus::Threading.running
      if thread && seconds
        thread.sleep_until(Time.now + seconds)
        return seconds
      end
      Nimbus::Threading.run_others
      seconds.nil? ? __nimbus_wall_sleep : __nimbus_wall_sleep(seconds)
    end
  end
end
`;
