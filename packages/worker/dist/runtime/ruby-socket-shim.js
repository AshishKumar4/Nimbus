export const RUBY_SOCKET_SHIM = String.raw `
begin
  require 'js'
  require 'json'
  require 'base64'
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

      def recv(id, max_bytes)
        encoded = Bridge.call(:recvBase64, id.to_i, max_bytes.to_i).to_s
        return ''.b if encoded.empty?
        Base64.decode64(encoded).b
      end

      def send(id, data)
        bytes = data.to_s.b
        Bridge.call(:sendBase64, id.to_i, Base64.strict_encode64(bytes)).to_i
      end

      def close(id)
        Bridge.call(:close, id.to_i)
        nil
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

class TCPSocket < IPSocket
  def self.__nimbus_from_connection(id, local_host, local_port, remote_host, remote_port)
    socket = allocate
    socket.send(:initialize_nimbus, id, local_host, local_port, remote_host, remote_port)
    socket
  end

  def initialize(host = nil, port = nil)
    raise SocketError, "Nimbus Ruby currently supports accepted virtual sockets only; outbound TCPSocket is not available"
  end

  def initialize_nimbus(id, local_host, local_port, remote_host, remote_port)
    @id = id.to_i
    @local_host = local_host
    @local_port = local_port.to_i
    @remote_host = remote_host
    @remote_port = remote_port.to_i
    @read_buffer = ''.b
    @eof = false
    @closed = false
    @sync = true
  end

  def __nimbus_socket_ready?
    !@closed && !@eof
  end

  def eof?
    @eof && @read_buffer.empty?
  end

  def readpartial(size, outbuf = ''.b)
    raise IOError, 'closed stream' if @closed
    fill_read_buffer(size.to_i) if @read_buffer.empty?
    raise EOFError, 'end of file reached' if @read_buffer.empty?
    chunk = @read_buffer.byteslice(0, size.to_i)
    @read_buffer = @read_buffer.byteslice(chunk.bytesize, @read_buffer.bytesize - chunk.bytesize) || ''.b
    outbuf.replace(chunk)
    outbuf
  end

  def read(length = nil, outbuf = nil)
    if length
      data = ''.b
      data << readpartial(length - data.bytesize) while data.bytesize < length
      outbuf ? outbuf.replace(data) : data
    else
      data = @read_buffer
      @read_buffer = ''.b
      loop do
        fill_read_buffer(16_384)
        break if @read_buffer.empty?
        data << @read_buffer
        @read_buffer = ''.b
      end
      outbuf ? outbuf.replace(data) : data
    end
  end

  def read_nonblock(size, outbuf = ''.b, exception: true)
    readpartial(size, outbuf)
  rescue EOFError
    return :wait_readable unless exception
    raise
  end

  def gets(separator = $/, limit = nil)
    separator = "\n" if separator.nil?
    loop do
      idx = @read_buffer.index(separator)
      if idx
        take = idx + separator.bytesize
        take = [take, limit].min if limit
        line = @read_buffer.byteslice(0, take)
        @read_buffer = @read_buffer.byteslice(take, @read_buffer.bytesize - take) || ''.b
        return line
      end
      fill_read_buffer(16_384)
      if @eof
        return nil if @read_buffer.empty?
        line = @read_buffer
        @read_buffer = ''.b
        return line
      end
    end
  end

  def write(data)
    raise IOError, 'closed stream' if @closed
    Nimbus::VirtualSocket.send(@id, data)
  end

  def write_nonblock(data, exception: true)
    write(data)
  rescue IOError
    return :wait_writable unless exception
    raise
  end

  def <<(data)
    write(data)
    self
  end

  def flush
    self
  end

  def close
    return nil if @closed
    @closed = true
    Nimbus::VirtualSocket.close(@id)
    nil
  end

  def closed?
    @closed
  end

  private

  def fill_read_buffer(size)
    return if @eof
    chunk = Nimbus::VirtualSocket.recv(@id, [size, 16_384].max)
    if chunk.empty?
      @eof = true
    else
      @read_buffer << chunk
    end
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
  unless method_defined?(:__nimbus_original_require)
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
    Nimbus::VirtualSocket.install_webrick_adapter if path == 'webrick' || path.start_with?('webrick/')
    loaded
  end
end

$LOADED_FEATURES << 'socket.rb' unless $LOADED_FEATURES.include?('socket.rb')
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
