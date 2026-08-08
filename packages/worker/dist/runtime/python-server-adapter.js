/**
 * python-server-adapter.ts — the bridge between a blocking-server API and a
 * request-driven host.
 *
 * THIS IS NOT A WORKAROUND, AND DELETING IT BREAKS EVERY PYTHON SERVER.
 *
 * `socketserver.BaseServer.serve_forever()` does not return. That is fine on a
 * machine where the process owns its own lifetime, and impossible here: a
 * request context is torn down when its response is sent, so a program still
 * sitting inside serve_forever when the invocation ends is a program that
 * stops existing. The server has to be reachable AFTER the call that started
 * it returned.
 *
 * Every language needs an answer to this and each one looks different enough
 * to be mistaken for a language-specific hack. Ruby's answer is a Fiber that
 * parks in accept and is resumed per request (ruby-runner.ts). Python's is
 * here: serve_forever registers the server and returns immediately, the program
 * runs to completion, and each inbound request re-enters the interpreter and
 * dispatches one request into the registered object. The server's state lives
 * on the Python heap between entries, which is exactly what a reactor build
 * gives us — no suspended stack is involved, and none is needed.
 *
 * It is worth being explicit about what this file is NOT, because its
 * predecessor bundled both and was deleted for it. The old python-socket-shim
 * also reimplemented `socket` itself, because Pyodide had no working socket
 * layer and could not block on a host promise. That half is gone for good: this
 * interpreter has real sockets over nimbus-net.c and real OpenSSL, so
 * connect/send/recv are the standard library's. A proof that one half is
 * obsolete says nothing about the other.
 */
/** Injected into __main__ before the user's program runs. */
export const PYTHON_SERVER_ADAPTER = String.raw `
import sys

_nimbus_servers = {}


def _nimbus_patch_socketserver():
    """Make serve_forever() return, and remember the server so the host can
    drive it. Idempotent: the marker keeps a second injection from stacking
    another wrapper on the first."""
    try:
        import socketserver as _socketserver
    except Exception:
        return
    if getattr(_socketserver.BaseServer.serve_forever, "_nimbus_request_driven", False):
        return

    _orig_server_close = _socketserver.BaseServer.server_close
    _orig_shutdown = _socketserver.BaseServer.shutdown

    def _serve_forever(self, poll_interval=0.5):
        sock = getattr(self, "socket", None)
        if sock is not None:
            try:
                _nimbus_servers[int(sock.getsockname()[1])] = self
                # The loop did not end, so the host owns this server's lifetime
                # from here. Anything the program does on the way out of the
                # block it started the server in is cleanup after a loop it
                # believes returned, and must not take the listener down.
                self._nimbus_adopted = True
            except Exception:
                pass
        # Callers block on this event to know the loop has stopped. It never
        # ran, so it is already true.
        shut_down = getattr(self, "_BaseServer__is_shut_down", None)
        if shut_down is not None:
            shut_down.set()
        return None

    def _shutdown(self):
        # The explicit "stop serving" call, and the only thing that hands the
        # server back to the program. A later server_close() then really closes.
        self._nimbus_adopted = False
        return _orig_shutdown(self)

    def _server_close(self):
        # python -m http.server runs its server inside a with-block, so the
        # close arrives the instant serve_forever returns. Honouring it unbound
        # the port before the first request could ever reach it.
        if getattr(self, "_nimbus_adopted", False):
            return None
        sock = getattr(self, "socket", None)
        if sock is not None:
            try:
                _nimbus_servers.pop(int(sock.getsockname()[1]), None)
            except Exception:
                pass
        return _orig_server_close(self)

    def _process_request_sync(self, request, client_address):
        # ThreadingMixIn would hand the request to a thread that will never be
        # scheduled. One request per host entry, inline.
        try:
            self.finish_request(request, client_address)
            self.shutdown_request(request)
        except Exception:
            self.handle_error(request, client_address)
            self.shutdown_request(request)

    _serve_forever._nimbus_request_driven = True
    _socketserver.BaseServer.serve_forever = _serve_forever
    _socketserver.BaseServer.server_close = _server_close
    _socketserver.BaseServer.shutdown = _shutdown
    try:
        _socketserver.ThreadingMixIn.process_request = _process_request_sync
    except Exception:
        pass


def _nimbus_serve_one(port):
    """Handle exactly one queued connection. The host calls this per inbound
    request, after the kernel has already queued the connection — so the
    accept() inside never waits on anything."""
    server = _nimbus_servers.get(int(port))
    if server is None:
        return False
    server._handle_request_noblock()
    return True


def _nimbus_listening_ports():
    return sorted(_nimbus_servers.keys())


_nimbus_patch_socketserver()
`;
