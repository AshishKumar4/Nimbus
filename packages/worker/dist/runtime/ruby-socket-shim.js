export const RUBY_SOCKET_SHIM = String.raw `
begin
  require 'js'
  require 'json'
rescue LoadError => e
  raise LoadError, "Nimbus Ruby virtual sockets require the ruby.wasm JS bridge: #{e.message}"
end

module Nimbus
  module VirtualSocket
    class << self
      # The listener bridge belongs to a process that outlives the command
      # which started it. A one-liner is answered from the pooled VM and has no
      # such process, so nothing could hold a port open once it returns. Saying
      # that is far more use than whatever the JS bridge throws on a handle
      # that is not there.
      # JS::Object descends from BasicObject, so typeof is the only question it
      # can be asked; a global that was never set answers 'undefined'.
      def bridge
        handle = JS.global[:__nimbusRubySockets]
        if handle.typeof == 'undefined'
          raise ::SocketError,
                'listening sockets need a Nimbus process that outlives the command, ' +
                'and a one-liner has none: put this in a script file and run it ' +
                'as ruby <file>.rb'
        end
        handle
      end

      def listen(port)
        bridge.call(:listen, port.to_i).to_i
      end

      def close_listener(port)
        bridge.call(:closeListener, port.to_i)
        nil
      end

      def pending(port)
        bridge.call(:pending, port.to_i).to_i
      end

      # Why the last socket call failed. A WASI errno cannot distinguish
      # "nothing is listening" from "this process cannot route loopback at
      # all", and the difference is the whole diagnosis.
      def last_socket_error
        JS.global[:__nimbusWasiLastSocketError].to_s
      rescue StandardError
        ''
      end

      # Park the process until the next inbound request resumes it, or until a
      # deadline passes. This is what "blocking" means here: a wasm-stack
      # suspension cannot outlive the request context that created it, so
      # waiting has to happen in a fiber, whose state is Ruby's own memory.
      def park(condition = nil, deadline = nil)
        Nimbus::Threading.park(condition, deadline)
      rescue FiberError
        raise IOError, 'Nimbus sockets can only block inside a Nimbus process'
      end

    end
  end
end

# ── In-memory pipe ─────────────────────────────────────────────────────────
#
# Real threads live in ruby-green-threads.rb, which this file relies on for
# parking. What is left here is the other thing WASI preview1 simply does not
# have: pipe(2). Both ends share a byte buffer, and a read with nothing in it
# parks the caller the same way every other wait here does.
class NimbusPipe
  def initialize(shared)
    @shared = shared
    @closed = false
  end

  def write(data)
    bytes = data.to_s.b
    @shared << bytes
    bytes.bytesize
  end
  alias syswrite write
  alias write_nonblock write
  alias print write

  def read_nonblock(maxlen = 4096, outbuf = nil, exception: true)
    if @shared.empty?
      return nil unless exception
      raise IO::EAGAINWaitReadable
    end
    take = @shared.byteslice(0, maxlen)
    @shared.replace(@shared.byteslice(take.bytesize, @shared.bytesize - take.bytesize) || ''.b)
    outbuf ? outbuf.replace(take) : take
  end

  # Blocking read: an empty pipe means "not yet", so park until a writer
  # arrives rather than reporting a false EOF or spinning.
  def read(maxlen = nil, outbuf = nil)
    loop do
      chunk = read_nonblock(maxlen || @shared.bytesize, outbuf, exception: false)
      return chunk if chunk
      return ''.b if @closed
      Nimbus::Threading.park(-> { !@shared.empty? || @closed })
    end
  end
  alias sysread read
  alias readpartial read

  def gets(_sep = $/, _limit = nil)
    read(@shared.bytesize)
  end

  def __nimbus_socket_ready?
    !@shared.empty?
  end

  def to_io
    self
  end

  def fileno
    -1
  end

  def flush
    self
  end

  def sync
    true
  end

  def sync=(value)
    value
  end

  def close
    @closed = true
    nil
  end

  def closed?
    @closed
  end
end

class << IO
  unless method_defined?(:__nimbus_original_pipe)
    alias_method :__nimbus_original_pipe, :pipe
    def pipe(*)
      shared = ''.b
      ends = [NimbusPipe.new(shared), NimbusPipe.new(shared)]
      return ends unless block_given?
      begin
        yield(*ends)
      ensure
        ends.each(&:close)
      end
    end
  end
end

# Normally defined by the socket extension, which ruby.wasm does not ship, so
# raising it from this shim would fail with "uninitialized constant" instead.
class SocketError < StandardError; end unless defined?(::SocketError)

class BasicSocket
  attr_accessor :do_not_reverse_lookup, :sync, :autoclose

  def nonblock=(value)
    @__nimbus_nonblock = !!value
  end

  def nonblock?
    !!@__nimbus_nonblock
  end

  def nonblock
    previous = nonblock?
    self.nonblock = true
    return self unless block_given?
    begin
      yield self
    ensure
      self.nonblock = previous
    end
  end

  def setsockopt(*)
    0
  end

  def shutdown(*)
    close
  end

  def to_io
    self
  end

  def wait_readable(_timeout = nil)
    respond_to?(:__nimbus_socket_ready?) && __nimbus_socket_ready? ? self : nil
  end

  def wait_writable(_timeout = nil)
    closed? ? nil : self
  end
end unless defined?(::BasicSocket)

class IPSocket < BasicSocket
  def addr
    ['AF_INET', @local_port || 0, @local_host || '0.0.0.0', @local_host || '0.0.0.0']
  end

  def peeraddr
    ['AF_INET', @remote_port || 0, @remote_host || '127.0.0.1', @remote_host || '127.0.0.1']
  end

  def local_address
    Addrinfo.new(@local_host || '0.0.0.0', @local_port || 0)
  end

  def remote_address
    Addrinfo.new(@remote_host || '127.0.0.1', @remote_port || 0)
  end
end unless defined?(::IPSocket)

class Socket < BasicSocket
  AF_INET = 2 unless const_defined?(:AF_INET)
  AF_INET6 = 10 unless const_defined?(:AF_INET6)
  SOCK_STREAM = 1 unless const_defined?(:SOCK_STREAM)
  SOL_SOCKET = 1 unless const_defined?(:SOL_SOCKET)
  SO_REUSEADDR = 2 unless const_defined?(:SO_REUSEADDR)
  IPPROTO_TCP = 6 unless const_defined?(:IPPROTO_TCP)
  TCP_NODELAY = 1 unless const_defined?(:TCP_NODELAY)
  AI_PASSIVE = 1 unless const_defined?(:AI_PASSIVE)

  def self.gethostname
    'nimbus'
  end

  def self.getaddrinfo(host, port, *_)
    [[AF_INET, port.to_i, host || '0.0.0.0', host || '0.0.0.0', AF_INET, SOCK_STREAM, IPPROTO_TCP]]
  end

  def self.tcp_server_sockets(address, port)
    [TCPServer.new(address || '0.0.0.0', port)]
  end
end unless defined?(::Socket)

# Ruby's socket API hands addresses back as Addrinfo, and callers print them.
class Addrinfo
  attr_reader :ip_address, :ip_port

  def initialize(host, port)
    @ip_address = host.to_s
    @ip_port = port.to_i
  end

  def inspect_sockaddr
    @ip_address.include?(':') ? "[#{@ip_address}]:#{@ip_port}" : "#{@ip_address}:#{@ip_port}"
  end
  alias to_s inspect_sockaddr

  def afamily
    Socket::AF_INET
  end
  alias pfamily afamily

  def ip?
    true
  end

  def ipv4?
    true
  end

  def ipv6?
    false
  end

  def getnameinfo(*)
    [@ip_address, @ip_port.to_s]
  end
end unless defined?(::Addrinfo)

# A listening socket is a descriptor whose read is accept(2): it parks until a
# connection is queued and yields that connection. So an ordinary stdlib accept
# loop works, and every server - a hand-written TCPServer, Rack, WEBrick - runs
# on the same code with no adapter and no knowledge of any particular library.
class TCPServer < IPSocket
  # for_fd is standard Ruby: reconstruct a listening socket from a descriptor.
  # The descriptor is the identity, so the same object is handed back.
  @@__nimbus_by_fd = {}

  def self.for_fd(fd)
    server = @@__nimbus_by_fd[fd.to_i]
    raise Errno::EBADF, "not a Nimbus listening socket: #{fd}" unless server
    server
  end

  def initialize(host_or_port, port = nil)
    @local_host = port.nil? ? '0.0.0.0' : host_or_port.to_s
    # Bind first: port 0 means "pick one", and only the kernel knows which.
    @local_port = Nimbus::VirtualSocket.listen((port || host_or_port).to_i)
    @io = File.open("/dev/nimbus/listen/#{@local_port}", File::RDONLY)
    # Listening is what makes this process host-driven: from here on inbound
    # requests are what resume it, so the scheduler waits on the host's clock
    # rather than stopping the world in a wall-clock sleep.
    Nimbus::Threading.host_driven = true
    @@__nimbus_by_fd[@io.fileno] = self
  end

  def __nimbus_virtual_port
    @local_port
  end

  def fileno
    @io.fileno
  end

  # Ruby servers reach for to_io to get at the "real" socket; this IS the real
  # socket, and handing back the bare descriptor would lose accept.
  def to_io
    self
  end

  def addr
    ['AF_INET', @local_port, @local_host, @local_host]
  end

  def local_address
    Addrinfo.new(@local_host, @local_port)
  end
  alias connect_address local_address

  # Blocks until a connection arrives, by parking the process rather than the
  # wasm stack. A workerd request context cannot resume a stack another request
  # suspended, so a JSPI-level block here would serve exactly one request and
  # then hang; a fiber park survives, because its state is Ruby's own.
  def accept
    loop do
      return connect_accepted(@io.gets) if __nimbus_socket_ready?
      raise IOError, 'closed stream' if closed?
      Nimbus::VirtualSocket.park(-> { __nimbus_socket_ready? })
    end
  end

  def accept_nonblock(exception: true)
    unless __nimbus_socket_ready?
      return :wait_readable unless exception
      raise IO::EAGAINWaitReadable
    end
    connect_accepted(@io.gets)
  end

  def __nimbus_socket_ready?
    !closed? && Nimbus::VirtualSocket.pending(@local_port) > 0
  end

  def listen(_backlog = nil)
    0
  end

  # POSIX autoclose: with it cleared the descriptor - and so the listener -
  # outlives this object. Servers rely on that when they re-wrap a listening
  # socket with for_fd and drop the original.
  def close
    return nil if closed? || @autoclose == false
    @@__nimbus_by_fd.delete(@io.fileno)
    Nimbus::VirtualSocket.close_listener(@local_port)
    @io.close
    nil
  end

  def closed?
    @io.closed?
  end

  private

  def connect_accepted(line)
    id = line.to_s.strip
    raise IOError, 'closed stream' if id.empty?
    TCPSocket.__nimbus_from_connection(id.to_i, @local_host, @local_port, '127.0.0.1', 0)
  end
end unless defined?(::TCPServer)

# One socket class, one transport: a WASI file descriptor.
#
# fd_read and fd_write are WebAssembly.Suspending imports and Ruby's eval
# entrypoint runs under WebAssembly.promising, so a read genuinely parks the
# wasm stack until bytes arrive and then resumes. That makes a Nimbus socket an
# ordinary IO, which is why there is no buffering, framing or blocking logic
# here - Ruby's own IO layer supplies all of it.
#
# A DIALED socket opens /dev/tcp/<host>/<port>. An ACCEPTED one is bound to a
# descriptor by the kernel when the cooperative pump hands the connection over.
# Both are the same kind of fd, so both are the same code below.
class TCPSocket < IPSocket
  # Everything a stream socket does IS what an IO does. Delegating rather than
  # reimplementing is what keeps this class from growing a second, subtly
  # different set of socket semantics.
  IO_METHODS = %i[
    read readpartial read_nonblock readline readlines readchar readbyte
    write write_nonblock print printf putc puts
    gets each_line getc getbyte ungetbyte ungetc
    eof eof? flush fsync sync sync= fileno binmode
    close_read close_write external_encoding set_encoding
  ].freeze

  IO_METHODS.each do |name|
    define_method(name) { |*args, **kwargs, &block| @io.public_send(name, *args, **kwargs, &block) }
  end

  def self.__nimbus_from_connection(id, local_host, local_port, remote_host, remote_port)
    socket = allocate
    socket.send(:initialize_nimbus, File.open("/dev/nimbus/socket/#{id.to_i}", File::RDWR),
                local_host, local_port, remote_host, remote_port)
    socket
  end

  def initialize(host = nil, port = nil, local_host = nil, local_port = nil)
    remote_host = (host || '127.0.0.1').to_s
    remote_port = port.to_i
    begin
      io = File.open("/dev/tcp/#{remote_host}/#{remote_port}", File::RDWR)
    rescue SystemCallError => e
      detail = Nimbus::VirtualSocket.last_socket_error
      message = "Nimbus could not dial #{remote_host}:#{remote_port}: #{e.message}"
      message += " (#{detail})" unless detail.empty?
      raise ::SocketError, message
    end
    initialize_nimbus(io, local_host ? local_host.to_s : '0.0.0.0', local_port.to_i, remote_host, remote_port)
  end

  # Without this, TCPSocket.open - which is how Net::HTTP opens a connection -
  # falls through to the private Kernel#open and reports that instead of
  # anything about sockets.
  def self.open(*args, &block)
    socket = new(*args)
    return socket unless block
    begin
      block.call(socket)
    ensure
      socket.close
    end
  end

  def initialize_nimbus(io, local_host, local_port, remote_host, remote_port)
    @io = io
    # Unbuffered writes: a request that sits in Ruby's write buffer never
    # reaches the peer, and this socket has no separate flush point.
    @io.sync = true
    @local_host = local_host
    @local_port = local_port.to_i
    @remote_host = remote_host
    @remote_port = remote_port.to_i
  end

  def to_io
    @io
  end

  def __nimbus_socket_ready?
    !@io.closed?
  end

  def <<(data)
    @io.write(data)
    self
  end

  def close
    @io.close unless @io.closed?
    nil
  end

  def closed?
    @io.closed?
  end
end unless defined?(::TCPSocket)

class << IO
  unless method_defined?(:__nimbus_original_select)
    alias_method :__nimbus_original_select, :select
  end

  # select is two waits wearing one name, and a timeout is load-bearing in
  # both: waiting for a Nimbus socket to become readable, and waiting for
  # nothing at all, which is how a great deal of stdlib code spells sleep. Both
  # go through the scheduler, because a caller that waits by watching the clock
  # here never gets to see it move.
  def select(reads, writes = nil, errors = nil, timeout = nil)
    read_list = Array(reads)
    write_list = Array(writes)
    error_list = Array(errors)
    if read_list.empty? && write_list.empty? && error_list.empty?
      Kernel.sleep(timeout)
      return nil
    end
    virtual_reads = read_list.select { |io| io.respond_to?(:__nimbus_socket_ready?) }
    if virtual_reads.any?
      deadline = timeout ? Time.now + timeout : nil
      loop do
        ready = virtual_reads.select { |io| io.__nimbus_socket_ready? }
        return [ready, write_list, []] if ready.any?
        return nil if deadline && Time.now >= deadline
        Nimbus::VirtualSocket.park(
          -> { virtual_reads.any? { |io| io.__nimbus_socket_ready? } }, deadline
        )
      end
    end
    __nimbus_original_select(reads, writes, errors, timeout)
  end
end

module Kernel
  # Kernel#require is PRIVATE, so method_defined? is always false here and a
  # second application of this shim would alias the override onto itself and
  # recurse until SystemStackError.
  unless private_method_defined?(:__nimbus_original_require)
    alias_method :__nimbus_original_require, :require
  end

  def require(path)
    if path == 'socket'
      $LOADED_FEATURES << 'socket.rb' unless $LOADED_FEATURES.include?('socket.rb')
      return false
    end
    if path == 'io/nonblock'
      $LOADED_FEATURES << 'io/nonblock.rb' unless $LOADED_FEATURES.include?('io/nonblock.rb')
      return false
    end
    if path == 'io/wait'
      $LOADED_FEATURES << 'io/wait.rb' unless $LOADED_FEATURES.include?('io/wait.rb')
      return false
    end
    loaded = __nimbus_original_require(path)
    Nimbus::Threading.install_timeout_shim if path == 'timeout' || path.start_with?('net/')
    loaded
  end
end

$LOADED_FEATURES << 'socket.rb' unless $LOADED_FEATURES.include?('socket.rb')
Nimbus::Threading.install_timeout_shim
`;
