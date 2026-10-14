import type { SessionInternal } from './internal.js';
/**
 * `initSession` reads `this.ctx` and `this.env` extensively (~14 sites).
 * Both are `protected` on the parent `CloudflareDurableObject` class
 * The pragmatic shape for THIS module: extend SessionInternal with
 * `ctx`/`env` as `any` and have the class delegator cast `this as
 * unknown as InitHost`. Other sibling modules (-rpc, -ws, -hib,
 * -replica) DO take ctx as a separate explicit arg per D1 — initSession
 * can't because the body has too many call sites to thread through.
 */
type InitHost = SessionInternal & {
    readonly ctx: any;
    readonly env: any;
};
/**
 * How the socket being wired came to need a session.
 *
 *   - reconnect: a fresh terminal on a fresh /ws upgrade. Its screen is
 *     empty, so the persisted scrollback is replayed above the live prompt.
 *   - wake: the socket was accepted by a previous instance and outlived it
 *     in hibernation; the peer's screen still shows everything up to the
 *     sleep. Replaying scrollback there duplicates what the peer already
 *     has, and a driver waiting for a fresh prompt would take the replayed
 *     one for its answer. Only the resumed-instance notice is written.
 */
export interface InitSessionOptions {
    resume?: 'reconnect' | 'wake';
}
/**
 * The session's one build. Whatever needs the session while it is being
 * built (an SDK call, a cold upgrade, the frame of a socket that woke this
 * instance) waits on that build, and then has its socket joined to it,
 * rather than starting a second build that replaces the first's terminal,
 * workspace and shell process under it.
 *
 * `self.usable` settles first: once the session's own commands are
 * registered, before the user's login files run, so a command those files
 * run that needs the session (`nimbus app list`) finds it usable rather
 * than waiting on the build that runs it.
 */
export declare function initSession(self: InitHost, ws: WebSocket | null, options?: InitSessionOptions): Promise<void>;
export {};
//# sourceMappingURL=init.d.ts.map