/**
 * runtime/remote-http-contract.ts — where the remote API's routes live, for
 * its client (the SDK's Nimbus.connect) and its server (worker
 * router/remote-api.ts) alike. Browser-safe: no Node builtins, no worker
 * code.
 */
/** The base path the remote API is served under unless configured otherwise. */
export declare const DEFAULT_REMOTE_BASE_PATH = "/api/nimbus/v1";
/**
 * A configured base path as both sides route it: one leading slash and no
 * trailing one, its inner segments as given. None, or an empty one, is the
 * default; slashes alone are '/'.
 */
export declare function normalizeRemoteBasePath(path: string | undefined): string;
//# sourceMappingURL=remote-http-contract.d.ts.map