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
export declare const PYTHON_SERVER_ADAPTER: string;
//# sourceMappingURL=python-server-adapter.d.ts.map