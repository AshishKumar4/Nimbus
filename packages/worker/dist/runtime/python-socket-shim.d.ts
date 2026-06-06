/**
 * Python socket/select/selectors compatibility layer for Pyodide.
 *
 * This module is installed into sys.modules before user code runs. It
 * backs the Python stdlib socket APIs with Nimbus virtual sockets, so
 * socketserver/http.server/Werkzeug can run through ordinary Python
 * networking calls. It intentionally exposes Python's normal module
 * names instead of framework-specific entrypoints.
 */
export declare const PYTHON_SOCKET_SHIM: string;
//# sourceMappingURL=python-socket-shim.d.ts.map