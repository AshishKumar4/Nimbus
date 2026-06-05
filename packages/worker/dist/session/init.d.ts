/**
 * session/init.ts — initSession boot + shell-command registrations.
 *
 * Why this is one big function and not a class:
 * initSession runs once per /ws upgrade and walks the session
 * through Phase R (rehydrate from SQL), Phase B (build kernel +
 * shell + register commands), Phase W (attach terminal), and
 * (cold-only) Phase O (MOTD + framework hint). The phases share
 * lots of locals (vfs, kernel, registry, shell) and ordering
 * matters strictly — there's no interesting reuse boundary that a
 * class decomposition would expose.
 *
 * The function is intentionally written so that a reader sees:
 *   1. setPhase('rehydrate') ...
 *   2. setPhase('build')    ... (~95% of the LOC)
 *   3. setPhase('online')   if (cold)
 *   4. self._b4Phase = 'hydrated'
 *
 * `self` is typed as InitHost, a narrow view of SessionInternal plus readonly
 * ctx/env, so this module can use the session internals it owns without
 * depending on the full Durable Object class surface.
 *
 * Imports and class delegators on NimbusSession preserve back-compat:
 *   - acceptShellWebSocket → self.initSession(ws)  (S7 will extract).
 *   - The class still has `initSession(ws)` as a delegator method.
 */
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
export declare function initSession(self: InitHost, ws: WebSocket): void;
export {};
//# sourceMappingURL=init.d.ts.map