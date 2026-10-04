/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host:
 * the filesystem and fd 0 by synchronous calls (the guest waits on `wake`
 * until the answer is on `calls`), its output and its network by messages on
 * `events`. The ports come in the first message on parentPort, taken before
 * the program runs, and live only in this module's closure.
 *
 * The realm lives as a Node process does: while its event loop has work. Its
 * own timers hold it; so does `events` while a server it started listens and
 * while a request it made is unanswered (its synchronous calls need no loop). A
 * rejection or exception nothing handles is printed and ends it with 1, an
 * ES module whose top-level await never settles with 13.
 */
export {};
//# sourceMappingURL=node-guest.d.ts.map