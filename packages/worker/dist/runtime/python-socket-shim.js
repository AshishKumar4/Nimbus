/**
 * Python socket/select/selectors compatibility layer for Pyodide.
 *
 * This module is installed into sys.modules before user code runs. It
 * backs the Python stdlib socket APIs with Nimbus virtual sockets, so
 * socketserver/http.server/Werkzeug can run through ordinary Python
 * networking calls. It intentionally exposes Python's normal module
 * names instead of framework-specific entrypoints.
 */
export const PYTHON_SOCKET_SHIM = String.raw `
import io
import sys
import time
import types
from pyodide.ffi import run_sync, to_js
from nimbus_sockets import accept_now as _nimbus_accept_now
from nimbus_sockets import close as _nimbus_close
from nimbus_sockets import close_listener as _nimbus_close_listener
from nimbus_sockets import listen as _nimbus_listen
from nimbus_sockets import pending as _nimbus_pending
from nimbus_sockets import recv as _nimbus_recv
from nimbus_sockets import send as _nimbus_send
from nimbus_sockets import sleep as _nimbus_sleep

AF_UNSPEC = 0
AF_INET = 2
AF_INET6 = 10
AF_UNIX = 1
SOCK_STREAM = 1
SOCK_DGRAM = 2
SOCK_RAW = 3
SOCK_CLOEXEC = 524288
SOCK_NONBLOCK = 2048
SOL_SOCKET = 1
SO_REUSEADDR = 2
SO_REUSEPORT = 15
SO_TYPE = 3
SO_ERROR = 4
IPPROTO_TCP = 6
IPPROTO_IPV6 = 41
TCP_NODELAY = 1
IPV6_V6ONLY = 26
SHUT_RD = 0
SHUT_WR = 1
SHUT_RDWR = 2
AI_PASSIVE = 1
AI_CANONNAME = 2
AI_NUMERICHOST = 4
AI_NUMERICSERV = 1024
AI_ADDRCONFIG = 32
AI_V4MAPPED = 8
MSG_PEEK = 2
SOMAXCONN = 128
EAI_NONAME = -2
has_ipv6 = True

error = OSError
timeout = TimeoutError
gaierror = OSError
herror = OSError

_GLOBAL_DEFAULT_TIMEOUT = object()
_default_timeout = None

_next_fd = 100
_fd_map = {}

def _alloc_fd(sock):
    global _next_fd
    fd = _next_fd
    _next_fd += 1
    _fd_map[fd] = sock
    return fd

def _coerce_bytes(data):
    if data is None:
        return b""
    if isinstance(data, bytes):
        return data
    if isinstance(data, bytearray):
        return bytes(data)
    if isinstance(data, memoryview):
        return data.tobytes()
    if isinstance(data, str):
        return data.encode()
    return bytes(data)

def _bytes_from_js(value):
    try:
        value = value.to_py()
    except AttributeError:
        pass
    return bytes(value)

def _port_from_address(address):
    if isinstance(address, tuple) and len(address) >= 2:
        return int(address[1])
    return int(address)

_LOOPBACK_HOSTS = frozenset((
    "127.0.0.1", "localhost", "0.0.0.0", "::1", "[::1]", "::ffff:127.0.0.1", "",
))

def _host_from_address(address):
    if isinstance(address, tuple) and address:
        return str(address[0])
    return str(address)

def _connect_loopback(address):
    host = _host_from_address(address)
    port = _port_from_address(address)
    if host not in _LOOPBACK_HOSTS:
        raise OSError(
            111,
            "Nimbus sockets reach in-session loopback ports only (127.0.0.1/localhost); "
            "cannot connect to %s:%d" % (host, port),
        )
    # The kernel side of this is complete — connect(), send() and the loopback
    # routing all work — but reading the response requires Python to block on a
    # JS promise, and this Pyodide build cannot: pyodide.ffi.run_sync aborts the
    # interpreter with "trying to suspend JS frames" even under
    # PyCallable.callPromising (callSyncifying is not available either). Fail
    # here, where the message can say so, rather than after connect() succeeds
    # and the first recv() takes the whole interpreter down.
    raise OSError(
        111,
        "Nimbus cannot yet dial loopback ports from Python: this Pyodide build "
        "has no working JSPI suspension, so a socket read cannot block. "
        "Reach %s:%d from node, or run the request as a subprocess." % (host, port),
    )

def _cooperative_sleep(seconds):
    if seconds is None:
        seconds = 0.01
    seconds = max(0.0, float(seconds))
    if seconds == 0:
        return None
    run_sync(_nimbus_sleep(int(seconds * 1000)))

def gethostname():
    return "nimbus"

def getfqdn(name=""):
    return name or gethostname()

def gethostbyname(name):
    return "127.0.0.1"

def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    family = family or AF_INET
    type = type or SOCK_STREAM
    proto = proto or 0
    return [(family, type, proto, "", (host or "127.0.0.1", int(port)))]

def getnameinfo(sockaddr, flags=0):
    return (str(sockaddr[0]), str(sockaddr[1]))

def getdefaulttimeout():
    return _default_timeout

def setdefaulttimeout(value):
    global _default_timeout
    _default_timeout = value

def create_connection(address, timeout=_GLOBAL_DEFAULT_TIMEOUT, source_address=None, *, all_errors=False):
    sock = socket(AF_INET, SOCK_STREAM)
    if timeout is not _GLOBAL_DEFAULT_TIMEOUT:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock

class socket:
    family = AF_INET
    type = SOCK_STREAM
    proto = 0

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None, _conn_id=None, _address=None):
        self.family = family
        self.type = type
        self.proto = proto
        self.timeout = _default_timeout
        self.blocking = self.timeout != 0
        self._closed = False
        self._listener = False
        self._port = None
        self._conn_id = _conn_id
        self._address = _address or ("127.0.0.1", 0)
        self._fd = int(fileno) if fileno is not None else _alloc_fd(self)
        self._inheritable = False

    def bind(self, address):
        self._port = _port_from_address(address)
        self._address = (address[0] if isinstance(address, tuple) and address else "0.0.0.0", self._port)

    def listen(self, backlog=128):
        if self._port is None:
            self._port = 0
        self._port = int(_nimbus_listen(self._port))
        self._listener = True
        self._address = ("0.0.0.0", self._port)

    def accept(self):
        if not self._listener or self._port is None:
            raise OSError("socket is not listening")
        deadline = None if self.timeout is None else time.monotonic() + max(0.0, float(self.timeout))
        conn_id = None
        host = "127.0.0.1"
        port = 0
        while conn_id is None:
            item = _nimbus_accept_now(self._port)
            try:
                conn_id = int(item.id)
                host = str(item.host)
                port = int(item.port)
            except Exception:
                conn_id = None
            if conn_id is not None:
                break
            if self.timeout == 0 or not self.blocking:
                raise BlockingIOError("operation would block")
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise timeout("timed out")
                _cooperative_sleep(min(0.01, remaining))
            else:
                _cooperative_sleep(0.01)
        return (socket(self.family, self.type, self.proto, _conn_id=conn_id, _address=(host, port)), (host, port))

    def connect(self, address):
        if self.type == SOCK_DGRAM:
            self._address = address if isinstance(address, tuple) else (str(address), 0)
            return None
        _connect_loopback(address)
        return None

    def connect_ex(self, address):
        try:
            self.connect(address)
        except OSError as exc:
            return exc.errno or 111
        return 0

    def fileno(self):
        return self._fd

    def set_inheritable(self, inheritable):
        self._inheritable = bool(inheritable)

    def get_inheritable(self):
        return self._inheritable

    def settimeout(self, value):
        self.timeout = value
        self.blocking = value is None or value != 0

    def gettimeout(self):
        return self.timeout

    def setblocking(self, flag):
        self.blocking = bool(flag)
        self.timeout = None if flag else 0

    def getblocking(self):
        return self.blocking

    def setsockopt(self, level, optname, value):
        return None

    def getsockopt(self, level, optname, buflen=None):
        return 0

    def getsockname(self):
        return self._address

    def getpeername(self):
        return self._address

    def recv(self, bufsize, flags=0):
        if self._conn_id is None:
            return b""
        return _bytes_from_js(_nimbus_recv(self._conn_id, int(bufsize)))

    def recv_into(self, buffer, nbytes=0, flags=0):
        data = self.recv(nbytes or len(buffer), flags)
        n = min(len(buffer), len(data))
        buffer[:n] = data[:n]
        return n

    def send(self, data, flags=0):
        if self._conn_id is None:
            raise OSError("socket is not connected")
        payload = _coerce_bytes(data)
        return int(_nimbus_send(self._conn_id, to_js(payload)))

    def sendall(self, data, flags=0):
        self.send(data, flags)
        return None

    def shutdown(self, how):
        return None

    def close(self):
        if self._closed:
            return None
        self._closed = True
        _fd_map.pop(self._fd, None)
        if self._listener and self._port is not None:
            _nimbus_close_listener(self._port)
        if self._conn_id is not None:
            _nimbus_close(self._conn_id)
        return None

    def detach(self):
        fd = self._fd
        _fd_map.pop(fd, None)
        self._closed = True
        return fd

    def makefile(self, mode="r", buffering=None, encoding=None, errors=None, newline=None):
        raw = _SocketRawIO(self)
        if "b" in mode:
            if "w" in mode:
                return io.BufferedWriter(raw) if buffering and buffering > 0 else raw
            return io.BufferedReader(raw)
        buffer = io.BufferedRWPair(raw, raw) if "+" in mode else io.BufferedReader(raw)
        return io.TextIOWrapper(buffer, encoding=encoding or "utf-8", errors=errors, newline=newline)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

class _SocketRawIO(io.RawIOBase):
    def __init__(self, sock):
        super().__init__()
        self.sock = sock

    def readable(self):
        return True

    def writable(self):
        return True

    def readinto(self, b):
        data = self.sock.recv(len(b))
        if not data:
            return 0
        n = min(len(b), len(data))
        b[:n] = data[:n]
        return n

    def write(self, b):
        self.sock.sendall(bytes(b))
        return len(b)

    def close(self):
        try:
            self.sock.close()
        finally:
            super().close()

def fromfd(fd, family, type, proto=0):
    sock = _fd_map.get(int(fd))
    if sock is None:
        raise OSError("bad file descriptor")
    return sock

def socketpair(family=AF_INET, type=SOCK_STREAM, proto=0):
    raise OSError("socketpair is not supported by Nimbus virtual sockets")

SocketType = socket
AddressFamily = int
SocketKind = int

def _select_once(rlist, wlist):
    read_fds = []
    ready = []
    for item in rlist:
        fd = item if isinstance(item, int) else item.fileno()
        sock = _fd_map.get(int(fd))
        if sock is not None and sock._conn_id is not None:
            ready.append(item)
        elif sock is not None and sock._listener and sock._port is not None:
            if int(_nimbus_pending(sock._port)) > 0:
                ready.append(item)
            else:
                read_fds.append((item, sock._port))
    return ready

def _select(rlist, wlist, xlist, timeout_value=None):
    deadline = None if timeout_value is None else time.monotonic() + max(0.0, float(timeout_value))
    while True:
        ready = _select_once(rlist, wlist)
        if ready or timeout_value == 0:
            return (ready, list(wlist), [])
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return ([], list(wlist), [])
            _cooperative_sleep(min(0.01, remaining))
        else:
            _cooperative_sleep(0.01)

_select_mod = types.ModuleType("select")
_select_mod.select = _select
_select_mod.error = OSError
_select_mod.POLLIN = 1
_select_mod.POLLOUT = 4
_select_mod.POLLERR = 8
_select_mod.POLLHUP = 16
_select_mod.POLLNVAL = 32
sys.modules["select"] = _select_mod

EVENT_READ = 1
EVENT_WRITE = 2

class _NimbusSelector:
    def __init__(self):
        self._registry = {}

    def register(self, fileobj, events, data=None):
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        key = types.SimpleNamespace(fileobj=fileobj, fd=int(fd), events=events, data=data)
        self._registry[int(fd)] = key
        return key

    def unregister(self, fileobj):
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        return self._registry.pop(int(fd))

    def modify(self, fileobj, events, data=None):
        self.unregister(fileobj)
        return self.register(fileobj, events, data)

    def get_key(self, fileobj):
        fd = fileobj if isinstance(fileobj, int) else fileobj.fileno()
        return self._registry[int(fd)]

    def get_map(self):
        return dict(self._registry)

    def select(self, timeout=None):
        read_items = [k.fileobj for k in self._registry.values() if k.events & EVENT_READ]
        write_items = [k.fileobj for k in self._registry.values() if k.events & EVENT_WRITE]
        ready_read, ready_write, _ = _select(read_items, write_items, [], timeout)
        ready = {}
        for item in ready_read:
            fd = item if isinstance(item, int) else item.fileno()
            key = self._registry.get(int(fd))
            if key is not None:
                ready[key.fd] = [key, ready.get(key.fd, [key, 0])[1] | EVENT_READ]
        for item in ready_write:
            fd = item if isinstance(item, int) else item.fileno()
            key = self._registry.get(int(fd))
            if key is not None:
                ready[key.fd] = [key, ready.get(key.fd, [key, 0])[1] | EVENT_WRITE]
        return [(key, events) for key, events in ready.values()]

    def close(self):
        self._registry.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

_selectors_mod = types.ModuleType("selectors")
_selectors_mod.EVENT_READ = EVENT_READ
_selectors_mod.EVENT_WRITE = EVENT_WRITE
_selectors_mod.DefaultSelector = _NimbusSelector
_selectors_mod.SelectSelector = _NimbusSelector
_selectors_mod.PollSelector = _NimbusSelector
_selectors_mod.BaseSelector = _NimbusSelector
sys.modules["selectors"] = _selectors_mod
if "socketserver" in sys.modules:
    try:
        sys.modules["socketserver"]._ServerSelector = _NimbusSelector
    except Exception:
        pass

_nimbus_socketserver_servers = {}

def _nimbus_patch_socketserver():
    try:
        import socketserver as _socketserver
    except Exception:
        return
    try:
        _socketserver.socket = sys.modules["socket"]
    except Exception:
        pass
    try:
        _socketserver._ServerSelector = _NimbusSelector
    except Exception:
        pass
    if getattr(_socketserver.BaseServer.serve_forever, "_nimbus_virtual_socket", False):
        return

    _orig_server_close = _socketserver.BaseServer.server_close

    def _serve_forever(self, poll_interval=0.5):
        sock = getattr(self, "socket", None)
        if sock is not None:
            try:
                port = int(sock.getsockname()[1])
                _nimbus_socketserver_servers[port] = self
            except Exception:
                pass
        shut_down = getattr(self, "_BaseServer__is_shut_down", None)
        if shut_down is not None:
            shut_down.set()
        return None

    def _server_close(self):
        sock = getattr(self, "socket", None)
        if sock is not None:
            try:
                _nimbus_socketserver_servers.pop(int(sock.getsockname()[1]), None)
            except Exception:
                pass
        return _orig_server_close(self)

    _serve_forever._nimbus_virtual_socket = True
    _socketserver.BaseServer.serve_forever = _serve_forever
    _socketserver.BaseServer.server_close = _server_close

    def _process_request_sync(self, request, client_address):
        try:
            self.finish_request(request, client_address)
            self.shutdown_request(request)
        except Exception:
            self.handle_error(request, client_address)
            self.shutdown_request(request)

    try:
        _socketserver.ThreadingMixIn.process_request = _process_request_sync
    except Exception:
        pass

def _nimbus_handle_socketserver_request(port):
    server = _nimbus_socketserver_servers.get(int(port))
    if server is None:
        return False
    server._handle_request_noblock()
    return True

def _nimbus_ensure_socketserver_listener(port):
    server = _nimbus_socketserver_servers.get(int(port))
    if server is None:
        return False
    sock = getattr(server, "socket", None)
    if sock is None:
        return False
    try:
        sock.listen(getattr(server, "request_queue_size", 128))
        return True
    except Exception:
        return False

_socket_mod = types.ModuleType("socket")
for _name, _value in list(globals().items()):
    if _name.startswith("_") and _name not in ("_GLOBAL_DEFAULT_TIMEOUT",):
        continue
    setattr(_socket_mod, _name, _value)
sys.modules["socket"] = _socket_mod
_nimbus_patch_socketserver()
`;
