/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host:
 * the filesystem and fd 0 by synchronous calls (the guest waits on `wake`
 * until the answer is on `calls`), its output and its network by messages on
 * `events`. Once its main script has run (and any servers it started have
 * closed), `events` stops holding the realm open, so the realm ends when its
 * event loop runs empty, as a Node process does.
 */
export {};
//# sourceMappingURL=node-guest.d.ts.map