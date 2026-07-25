export const RUBY_SOCKET_SHIM = String.raw`
begin
  require 'js'
  require 'json'
rescue LoadError => e
  raise LoadError, "Nimbus Ruby virtual sockets require the ruby.wasm JS bridge: #{e.message}"
end

module Nimbus
  module VirtualSocket
    Bridge = JS.global[:__nimbusRubySockets] unless const_defined?(:Bridge)
    @webrick_servers ||= {}

    class << self
      def listen(port)
        Bridge.call(:listen, port.to_i).to_i
      end

      def close_listener(port)
        Bridge.call(:closeListener, port.to_i)
        nil
      end

      def pending(port)
        Bridge.call(:pending, port.to_i).to_i
      end

      def accept_now(port)
        raw = Bridge.call(:acceptNowJson, port.to_i).to_s
        return nil if raw.empty?
        JSON.parse(raw)
      end

      # Why the last socket call failed. A WASI errno cannot distinguish
      # "nothing is listening" from "this process cannot route loopback at
      # all", and the difference is the whole diagnosis.
      def last_socket_error
        JS.global[:__nimbusWasiLastSocketError].to_s
      rescue StandardError
        ''
      end

      def register_webrick(server)
        listener = server.listeners.find { |socket| socket.respond_to?(:__nimbus_virtual_port) }
        raise "Nimbus WEBrick adapter could not find a virtual TCPServer listener" unless listener
        port = listener.__nimbus_virtual_port
        @webrick_servers[port] = server
        server.instance_variable_set(:@status, :Running)
        server.send(:call_callback, :StartCallback) if server.respond_to?(:call_callback, true)
        port
      end

      def handle_webrick_request(port)
        @last_error = nil
        server = @webrick_servers[port.to_i]
        unless server
          registered = @webrick_servers.keys.sort.join(', ')
          @last_error = "no WEBrick server registered on port #{port}; registered ports: #{registered.empty? ? '(none)' : registered}"
          return false
        end
        listener = server.listeners.find { |socket| socket.respond_to?(:__nimbus_virtual_port) && socket.__nimbus_virtual_port == port.to_i }
        unless listener
          listeners = server.listeners.map { |socket| socket.respond_to?(:__nimbus_virtual_port) ? socket.__nimbus_virtual_port : socket.class.name }.join(', ')
          @last_error = "WEBrick server on port #{port} has no matching virtual listener; listeners: #{listeners.empty? ? '(none)' : listeners}"
          return false
        end
        sock = listener.accept_nonblock(exception: false)
        if sock == :wait_readable || sock.nil?
          @last_error = "WEBrick virtual listener on port #{port} had no pending connection"
          return false
        end
        begin
          server.run(sock)
        ensure
          sock.close unless sock.closed?
        end
        true
      rescue Exception => e
        @last_error = "#{e.class}: #{e.message}"
        false
      end

      def last_error
        @last_error
      end

      # ruby.wasm has no threads, so Timeout.timeout's watchdog Thread.new
      # raises NotImplementedError on every call — which is what actually
      # stopped Net::HTTP, before it reached a socket at all. Nothing in this
      # runtime can interrupt a running block, so run it directly. Every
      # loopback request is still bounded by the kernel's own response timer,
      # so an unresponsive port cannot wedge the process.
      def install_timeout_shim
        return unless defined?(::Timeout)
        return if ::Timeout.respond_to?(:__nimbus_threadless_timeout)
        ::Timeout.singleton_class.class_eval do
          define_method(:__nimbus_threadless_timeout) { true }
          define_method(:timeout) do |sec = nil, _klass = nil, _message = nil, &block|
            block ? block.call(sec) : nil
          end
        end
      end

      def install_webrick_adapter
        return unless defined?(::WEBrick::GenericServer)
        return if ::WEBrick::GenericServer.method_defined?(:__nimbus_original_start)

        ::WEBrick::Utils.singleton_class.class_eval do
          define_method(:create_listeners) do |address, port|
            [::TCPServer.new(address || '0.0.0.0', port)]
          end

          unless method_defined?(:__nimbus_original_timeout)
            alias_method :__nimbus_original_timeout, :timeout
            define_method(:timeout) do |_seconds, _exception = ::Timeout::Error, &block|
              block ? block.call : nil
            end
          end
        end

        ::WEBrick::GenericServer.class_eval do
          alias_method :__nimbus_original_start, :start
          def start(&block)
            if @listeners.any? { |socket| socket.respond_to?(:__nimbus_virtual_port) }
              raise WEBrick::ServerError, "already started." if @status != :Stop
              Nimbus::VirtualSocket.register_webrick(self)
              nil
            else
              __nimbus_original_start(&block)
            end
          end
        end
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

class TCPServer < IPSocket
  @@__nimbus_next_fd = 10_000
  @@__nimbus_servers_by_fd = {}

  def self.for_fd(fd)
    server = @@__nimbus_servers_by_fd[fd.to_i]
    raise IOError, "Nimbus virtual TCPServer fd #{fd} is not open" unless server
    server
  end

  def initialize(host_or_port, port = nil)
    @local_host = port.nil? ? '0.0.0.0' : host_or_port.to_s
    @local_port = Nimbus::VirtualSocket.listen((port || host_or_port).to_i)
    @closed = false
    @autoclose = true
    @fd = (@@__nimbus_next_fd += 1)
    @@__nimbus_servers_by_fd[@fd] = self
  end

  def __nimbus_virtual_port
    @local_port
  end

  def fileno
    @fd
  end

  def accept
    sock = accept_nonblock(exception: false)
    raise IOError, "Nimbus virtual TCPServer has no pending connection" if sock == :wait_readable
    sock
  end

  def accept_nonblock(exception: true)
    raise IOError, 'closed stream' if @closed
    conn = Nimbus::VirtualSocket.accept_now(@local_port)
    unless conn
      return :wait_readable unless exception
      raise Errno::EAGAIN
    end
    TCPSocket.__nimbus_from_connection(conn['id'], @local_host, @local_port, conn['host'] || '127.0.0.1', conn['port'] || 0)
  end

  def __nimbus_socket_ready?
    !@closed && Nimbus::VirtualSocket.pending(@local_port) > 0
  end

  def close
    return nil if @closed
    @closed = true
    @@__nimbus_servers_by_fd.delete(@fd)
    Nimbus::VirtualSocket.close_listener(@local_port)
    nil
  end

  def closed?
    @closed
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

  def select(reads, writes = nil, errors = nil, timeout = nil)
    read_list = Array(reads)
    write_list = Array(writes)
    error_list = Array(errors)
    virtual_reads = read_list.select { |io| io.respond_to?(:__nimbus_socket_ready?) }
    if virtual_reads.any?
      ready = virtual_reads.select { |io| io.__nimbus_socket_ready? }
      return [ready, write_list, []] if ready.any? || write_list.any?
      return nil if timeout == 0
      return nil
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
    Nimbus::VirtualSocket.install_timeout_shim if path == 'timeout' || path.start_with?('net/')
    Nimbus::VirtualSocket.install_webrick_adapter if path == 'webrick' || path.start_with?('webrick/')
    loaded
  end
end

$LOADED_FEATURES << 'socket.rb' unless $LOADED_FEATURES.include?('socket.rb')
Nimbus::VirtualSocket.install_timeout_shim
Nimbus::VirtualSocket.install_webrick_adapter

def __nimbus_handle_virtual_socket_request(port)
  ok = Nimbus::VirtualSocket.handle_webrick_request(port.to_i)
  unless ok
    error = Nimbus::VirtualSocket.last_error
    $stderr.write("#{error}\n") if error && error != ''
  end
  ok
end
`;
