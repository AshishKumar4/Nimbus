/**
 * session/ws.ts — WebSocket lifecycle for the supervisor DO.
 *
 * One DO can host multiple WS kinds simultaneously: the user's shell
 * terminal, cirrus-real HMR clients (one per browser tab on /preview),
 * and process terminal streams. Without a discriminator
 * a close on the HMR socket would null the shell's terminal and the
 * user's tab would freeze (Audit F1). The wsKind() classifier reads
 * the attachment tag set at upgrade time to route each lifecycle
 * event to the right handler.
 *
 * Surfaces:
 *   - wsKind(ws)              — pure attachment-tag classifier.
 *   - wsMessage(self, ws, m)  — route by kind to terminal/HMR/process terminals.
 *   - wsClose(self, ws, ...) — Audit F1: HMR/process terminal close does
 *     NOT null shell/terminal/kernel; only shell-kind close does.
 *   - wsError(self, ws, err) — same discriminator; W5 ring-persist +
 *     W9 flush-on-close + recordFailure on error.
 *   - safePersistRing(self) — bridges _w5PersistRing → ctx.waitUntil.
 *
 * Per plan §IX.2 R3: this module does NOT export accept-* helpers
 * (they live in -routes.ts when S9a lands). Routes call
 * `self.acceptShellWebSocket(req)` via class delegators (when those
 * land in S9a).
 *
 * Per plan §IX.4 R1: class delegators preserve method NAMES so DO
 * runtime contract holds (`webSocketMessage`, `webSocketClose`,
 * `webSocketError`).
 *
 * DEFECT-D1 pattern: `ctx` taken via `host.ctx` would TS-2412 against
 * parent's `protected ctx`. Free functions accept ctx implicitly via
 * `host as any` patterns where required (here only `safePersistRing`
 * touches ctx.waitUntil; uses `(host.ctx as any)` cast).
 */
import { dec } from '../_shared/bytes.js';
import { recordFailure, getLastRpcFrame, getLastFacetId, recordRecoveryEvent } from '../observability/oom-discriminator.js';
import { persistShellState } from './state-store.js';
import { handleFsWatchSubscribe, handleFsWatchUnsubscribe, cleanupFsWatchOnClose, } from './fs-watch.js';
import { parseProcessLogClientFrame } from '../runtime/process-io-protocol.js';
import { applyProcessClientFrame } from '../runtime/process-input-routing.js';
import { z } from 'zod/v4';
/**
 * Snapshot the live Shell state and write it through to DO SQLite
 * [Phase 3 B'.1].
 *
 * Called from wsMessage (post-process, every inbound keystroke) and
 * once more in the wsClose / wsError shell-kind branch as a final
 * safety net before the in-memory Shell is torn down.
 *
 * Read-only and synchronous (DO storage SQL is sync inside a request
 * context). Cheap: one read of `shell.getCwd()` + `shell.getEnv()`,
 * a JSON.stringify of env, and an INSERT-OR-REPLACE into the small
 * nimbus_session_kv table. Skips the SQL write entirely when nothing
 * has changed since the previous snapshot — the comparison is
 * pointer-equality on cwd plus env reference, since Shell.getEnv()
 * returns a live Record and `cd` mutates `this.cwd` in place.
 *
 * Failure model: persistShellState throws ONLY on env-too-large
 * (the SESSION_ENV_MAX_BYTES gate). We surface that via console.warn
 * — it indicates a misbehaving session that's exporting unbounded
 * data, not an architectural bug. Suppressing the throw keeps the
 * WS message handler running; the next snapshot retries.
 */
function snapshotShellState(self) {
    const shell = self.shell;
    if (!shell)
        return;
    const ctx = self.ctx;
    if (!ctx?.storage?.sql)
        return;
    let cwd = null;
    let env = null;
    try {
        cwd = shell.getCwd() || null;
    }
    catch { /* best-effort */ }
    try {
        const rawEnv = shell.getEnv();
        if (rawEnv && typeof rawEnv === 'object') {
            // Defensive copy. The Shell mutates this.env in place on
            // export; we want the SQL write to reflect a stable view.
            env = { ...rawEnv };
        }
    }
    catch { /* best-effort */ }
    if (!cwd && !env)
        return;
    try {
        persistShellState(ctx, { cwd, env });
    }
    catch (e) {
        console.warn('[nimbus/B\'.1] persistShellState failed:', e?.message || e);
    }
}
const WsAttachmentSchema = z.object({
    kind: z.string(),
    clientId: z.string().optional(),
    pid: z.number().int().optional(),
}).passthrough();
const FsWatchClientFrameSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('fs-watch-subscribe'),
        reqId: z.unknown().optional(),
        paths: z.array(z.string()).optional(),
    }).passthrough(),
    z.object({
        type: z.literal('fs-watch-unsubscribe'),
        reqId: z.unknown().optional(),
        subId: z.string().optional(),
    }).passthrough(),
]);
const TerminalMessageSchema = z.object({
    type: z.string(),
    data: z.string().optional(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    dir: z.string().optional(),
    recursive: z.boolean().optional(),
}).passthrough();
function wsAttachment(ws) {
    try {
        const method = Reflect.get(ws, 'deserializeAttachment');
        if (typeof method !== 'function')
            return { kind: 'shell' };
        const parsed = WsAttachmentSchema.safeParse(Reflect.apply(method, ws, []));
        if (parsed.success)
            return parsed.data;
    }
    catch { /* deserializeAttachment is optional */ }
    return { kind: 'shell' };
}
export function wsKind(ws) {
    return wsAttachment(ws);
}
export async function wsMessage(self, ws, message) {
    try {
        // HMR clients: route messages to the facet via HmrBridge.
        // We identify HMR sockets by the attachment tag set at accept time.
        const attach = wsAttachment(ws);
        if (attach?.kind === 'cirrus-hmr') {
            const data = typeof message === 'string' ? message : dec.decode(message);
            if (attach.clientId)
                self.cirrusReal?.deliverHmrClientMessage(attach.clientId, data);
            return;
        }
        if (attach?.kind === 'process-logs') {
            await routeProcessLogClientMessage(self, ws, attach, message);
            return;
        }
        const data = typeof message === 'string' ? message : dec.decode(message);
        const value = JSON.parse(data);
        // file-tree-watch (2026-05-15): handle fs-watch-* on this WS BEFORE
        // delegating to the terminal. These messages are WS-scoped (the
        // bus listener captures `ws`), so the dispatch site needs the live
        // ws ref — the terminal.onFs callback only has (msg, reply). Reply
        // pattern mirrors the fs-* reqId-echo at ws-terminal.ts:142-150.
        const fsWatchFrame = FsWatchClientFrameSchema.safeParse(value);
        if (fsWatchFrame.success) {
            const msg = fsWatchFrame.data;
            const reqId = msg.reqId;
            const reply = (frame) => {
                try {
                    const merged = reqId !== undefined
                        ? { ...frame, reqId }
                        : frame;
                    ws.send(JSON.stringify(merged));
                }
                catch { /* WS may be closing */ }
            };
            try {
                if (msg.type === 'fs-watch-subscribe') {
                    const r = handleFsWatchSubscribe(self, ws, msg);
                    if (r.ok) {
                        reply({ type: 'fs-watch-subscribe-result', ok: true, subId: r.subId });
                    }
                    else {
                        reply({ type: 'fs-watch-subscribe-result', ok: false, error: r.error });
                    }
                }
                else {
                    const r = handleFsWatchUnsubscribe(self, ws, msg);
                    reply({ type: 'fs-watch-unsubscribe-result', ok: true, removed: r.removed });
                }
            }
            catch (e) {
                reply({
                    type: msg.type + '-result',
                    ok: false,
                    error: 'fs-watch handler threw: ' + (e?.message || String(e)),
                });
            }
            return;
        }
        if (attach?.kind === 'fs-watch') {
            return;
        }
        const terminalMessage = TerminalMessageSchema.safeParse(value);
        if (self.terminal && terminalMessage.success)
            self.terminal.handleMessage(terminalMessage.data);
        // ── B'.1 snapshot ───────────────────────────────────────────────
        // Persist Shell state to DO SQLite after the terminal has handled
        // the user's keystroke. The Shell builtin `cd` mutates this.cwd
        // synchronously inside executeLine, so by the time we reach this
        // line a `cd app\r` has already taken effect and we capture the
        // new cwd. Cheap when nothing has changed; SESSION_ENV_MAX_BYTES
        // is the only failure mode and is logged, not thrown.
        snapshotShellState(self);
    }
    catch (e) {
        // Never let a message parsing error crash the DO
        console.error('[nimbus] webSocketMessage error:', e?.message);
    }
}
async function routeProcessLogClientMessage(self, ws, attach, message) {
    const pid = attach.pid;
    if (!pid)
        return;
    const entry = self.processTable.get(pid);
    if (!entry || entry.state !== 'running')
        return;
    let frame;
    try {
        const data = typeof message === 'string' ? message : dec.decode(message);
        frame = parseProcessLogClientFrame(data);
    }
    catch {
        return;
    }
    if (!frame)
        return;
    const result = await applyProcessClientFrame(self, pid, frame);
    sendProcessInputAck(ws, pid, result.ok, result.type);
}
function sendProcessInputAck(ws, pid, ok, action) {
    try {
        ws.send(JSON.stringify({ type: 'stdin-ack', pid, ok, action }));
    }
    catch { }
}
export async function wsClose(self, ws, _code, _reason, _wasClean) {
    // Audit F1: discriminate by socket kind. Previously BOTH parameters
    // were absent and every close — including preview-iframe HMR sockets
    // closed by `vite stop` / navigation — nulled the session's
    // shell/terminal/kernel, silently freezing the user's terminal tab.
    const att = wsKind(ws);
    // file-tree-watch (2026-05-15): drop any fs-watch subscriptions on
    // this WS regardless of kind. Shell WS is the canonical carrier in
    // practice; unconditional cleanup is defensive against any future
    // WS kind that might subscribe. Idempotent + no-op when map empty.
    try {
        cleanupFsWatchOnClose(self, ws);
    }
    catch { /* best-effort */ }
    // W9: process-logs sockets close routinely (user closes a log tab).
    // Don't touch shell/terminal — and don't bother flushing here either
    // because process-logs ws close doesn't imply session lifecycle.
    if (att.kind === 'process-logs') {
        return;
    }
    if (att.kind === 'fs-watch') {
        return;
    }
    if (att.kind === 'cirrus-hmr') {
        // HMR socket closed. Detach from the bridge + drop from the map.
        // Do NOT touch shell/terminal/kernel — the user's terminal tab
        // is still alive and has nothing to do with this HMR close.
        try {
            const clientId = att.clientId || self._cirrusHmrWsClients?.get(ws);
            self._cirrusHmrWsClients?.delete(ws);
            if (clientId)
                self.cirrusReal?.detachHmrClient(clientId);
        }
        catch { /* best-effort */ }
        return;
    }
    // Shell (or unknown legacy) socket close. Dev servers (vite,
    // wrangler dev) + long-running facets must still survive the
    // terminal reconnect (see 607e472 — do NOT kill running processes
    // here). Only reap per-tab state.
    // ── Phase 3 B'.1: transitionTo('drained') ──────────────────────────
    // The Track B' state-machine transition. Persist final shell
    // state + record a recovery_event BEFORE we null the in-memory
    // Shell instance. The next /ws upgrade reads the SQL row and
    // rebuilds the Shell with cwd + env intact — that's what makes
    // recovery transparent.
    //
    // Order matters: snapshot first (so SQL has the latest cwd),
    // then record the lifecycle event (so the C'.2 ring shows the
    // transition AFTER the persist completed).
    snapshotShellState(self);
    try {
        recordRecoveryEvent({
            at: Date.now(),
            fromState: 'active',
            toState: 'drained',
            trigger: 'ws-close',
            isolateGen: self._w9IsolateGen,
            dataLoss: false,
            snapshotKeysRehydrated: 0,
        });
    }
    catch { /* observability is non-critical */ }
    // [B'.4] Update live phase indicator. The recordRecoveryEvent above
    // is the legacy ring entry (active→drained); the field assignment
    // surfaces the live phase via /api/_diag/session.phase.
    self._b4Phase = 'drained';
    if (self.sqliteFs) {
        // Audit C1: flushAll() now throws when any chunk failed both
        // its first attempt and the one-shot retry. Log loudly and
        // clear so the next close doesn't re-throw.
        try {
            self.sqliteFs.flushAll();
        }
        catch (e) {
            console.error('[nimbus] webSocketClose: flushAll failed —', e?.message || e);
            try {
                self.sqliteFs.clearWriteFailures();
            }
            catch { }
        }
    }
    // W5 Lever 5: persist the OOM ring on close so cf-tail-style
    // forensics survive DO hibernation. Gated on ctx.waitUntil so
    // the close handler doesn't hang on storage. Skipped if ring
    // is empty / unchanged.
    safePersistRing(self);
    // W9: flush any pending log writes so a hibernation cycle right
    // after this close doesn't strand the in-memory ring. Synchronous
    // SQL writes wrapped in transactionSync — fast (microseconds for
    // typical buffer sizes); blocking is safer than racing waitUntil
    // because flush() is what makes the logs survive.
    self._w9FlushOnClose();
    // [B'.5] Do NOT null self.shell / self.terminal / self.kernel. The
    // DO is still alive (we're running this code right now); only the
    // WS connection died. The Shell instance still holds the live
    // cwd/env/lineBuffer state — keeping it in-memory means the next
    // /ws upgrade can JOIN it (skip Phase B) instead of rebuilding from
    // SQL. The terminal's underlying ws ref is stale, but a write
    // attempt will throw on send() and be swallowed; the next /ws
    // upgrade calls terminal.attach(newWs) to swap in the new socket.
    //
    // Pre-B'.5 we nulled these three fields to avoid two-tab cross-
    // wiring (the 409 in nimbus-session-routes.ts:97 protected against
    // overwriting an active shell). With phase=drained surfaced on the
    // host, the /ws handler can disambiguate "warm session waiting for
    // rejoin" (warmJoin path) from "active session busy" (still 409).
    // Reset the one-shot "wrangler alias" banner so a reconnecting user
    // sees it again — terminal-lifetime state, not session-lifetime.
    self.wranglerAliasBannerShown = false;
}
export async function wsError(self, ws, _error) {
    // Audit F1: same discriminator as webSocketClose. A socket error
    // on an HMR WS must not take down the terminal tab.
    const att = wsKind(ws);
    // file-tree-watch (2026-05-15): drop fs-watch subscriptions on this
    // WS. Mirror of the cleanup in wsClose above.
    try {
        cleanupFsWatchOnClose(self, ws);
    }
    catch { /* best-effort */ }
    // W9: process-logs error — same drop-and-return policy as close.
    if (att.kind === 'process-logs') {
        return;
    }
    if (att.kind === 'fs-watch') {
        return;
    }
    if (att.kind === 'cirrus-hmr') {
        try {
            const clientId = att.clientId || self._cirrusHmrWsClients?.get(ws);
            self._cirrusHmrWsClients?.delete(ws);
            if (clientId)
                self.cirrusReal?.detachHmrClient(clientId);
        }
        catch { /* best-effort */ }
        return;
    }
    // ── Phase 3 B'.1: transitionTo('drained') ──────────────────────────
    // Same architectural step as wsClose: persist shell state + record
    // a drained event before nulling. wsError is a different physical
    // trigger (workerd cancelled the WS handler — typically the 5-s
    // setHibernatableWebSocketEventTimeout cap) but the recovery
    // shape is identical. The trigger label distinguishes them in
    // the recovery_event ring.
    snapshotShellState(self);
    try {
        recordRecoveryEvent({
            at: Date.now(),
            fromState: 'active',
            toState: 'drained',
            trigger: 'ws-error',
            isolateGen: self._w9IsolateGen,
            dataLoss: false,
            snapshotKeysRehydrated: 0,
        });
    }
    catch { /* observability is non-critical */ }
    // [B'.4] Live phase indicator — same as wsClose path.
    self._b4Phase = 'drained';
    if (self.sqliteFs) {
        try {
            self.sqliteFs.flushAll();
        }
        catch (e) {
            console.error('[nimbus] webSocketError: flushAll failed —', e?.message || e);
            try {
                self.sqliteFs.clearWriteFailures();
            }
            catch { }
        }
    }
    // W5 Lever 5: persist OOM ring (same rationale as webSocketClose).
    // Also synthesize a DiagFailure for the WS error itself if one
    // hasn't already been recorded. Helps when a session vanishes
    // without ever recording an explicit failure.
    if (_error) {
        try {
            recordFailure({
                at: Date.now(),
                phase: 'ws',
                cause: 'unknown',
                rssEstimateBytes: self._diagPeakRss,
                heapUsedBytes: self._diagPeakHeapUsed,
                lruBytes: 0, inFlightBytes: 0,
                lastRpcFrame: getLastRpcFrame(),
                lastFacetId: getLastFacetId(),
                message: _error?.message ?? String(_error),
            });
        }
        catch { /* fail-soft */ }
    }
    safePersistRing(self);
    // W9: same flush rationale as webSocketClose. An error on the shell
    // socket commonly precedes hibernation by milliseconds.
    self._w9FlushOnClose();
    // [B'.5] Do NOT null shell/terminal/kernel — same rationale as
    // wsClose. The Shell stays alive in-memory for the next /ws to
    // join via the warmJoin path.
}
/**
 * W5 Lever 5: bridge between _w5PersistRing (which returns a Promise)
 * and ctx.waitUntil. Skipped silently if ctx.waitUntil isn't available
 * (test contexts). Takes ctx via `(self as any).ctx` cast — D1 escape.
 */
export function safePersistRing(self) {
    try {
        const p = self._w5PersistRing();
        const ctx = self.ctx;
        if (p && ctx && typeof ctx.waitUntil === 'function') {
            try {
                ctx.waitUntil(p);
            }
            catch { /* best-effort */ }
        }
    }
    catch (e) {
        console.warn('[nimbus/W5] _w5SafePersistRing threw:', e?.message);
    }
}
