/**
 * nimbus-session-ws.ts — WebSocket lifecycle handlers.
 *
 * Extracted from src/nimbus-session.ts per
 * audit/sections/SESSION-REFACTOR-PLAN.md §B.3.7 + S7.
 *
 * Surfaces:
 *   - wsKind(ws) — pure attachment-tag classifier (Audit F1 invariant).
 *   - wsMessage(self, ws, message) — discriminate by kind; route to
 *     cirrusReal HMR / drop process-logs / shell terminal handler.
 *   - wsClose(self, ws, ...) — Audit F1: HMR/process-logs close does
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

import { dec } from './_shared/bytes.js';
import { recordFailure, getLastRpcFrame, getLastFacetId, recordRecoveryEvent } from './oom-discriminator.js';
import { flushOnClose as _w9DoFlushOnClose } from './nimbus-session-hib.js';
import { persistShellState } from './session/state-store.js';
import type { ProcessLogStore } from './process-logs.js';
import type { SqliteVFS } from './sqlite-vfs.js';
import type { CirrusReal } from './cirrus-real.js';
import type { WebSocketTerminal } from './ws-terminal.js';
import type { Kernel, Shell } from '@lifo-sh/core';

/**
 * Minimal host shape for WS lifecycle. Per plan §IX.1 b': fields here
 * drop `private` on the class. `ctx` NOT on the interface (D1).
 */
export interface WsHost {
  sqliteFs: SqliteVFS | null;
  shell: Shell | null;
  terminal: WebSocketTerminal | null;
  kernel: Kernel | null;
  cirrusReal: CirrusReal | null;
  _cirrusHmrWsClients: Map<WebSocket, string> | null;
  processLogs: ProcessLogStore;
  wranglerAliasBannerShown: boolean;
  _w9PersistWired: boolean;
  _w9FlushTimer: any;
  _w9SchemaInit: boolean;
  _w9IsolateGen: number;
  _w9IsolateGenPersisted: boolean;
  _w9WsConfig: any;
  _diagPeakRss: number;
  _diagPeakHeapUsed: number;
  _w5LastPersistAt: number;
  _w5LastPersistRingSize: number;
  /** [B'.4] live phase indicator — see nimbus-session-internal.d.ts */
  _b4Phase: import('./oom-discriminator.js').SessionState | null;
  _w5PersistRing(): Promise<void> | null;
  _w9FlushOnClose(): void;
}

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
function snapshotShellState(self: WsHost): void {
  const shell = self.shell;
  if (!shell) return;
  const ctx = (self as any).ctx;
  if (!ctx?.storage?.sql) return;
  let cwd: string | null = null;
  let env: Record<string, string> | null = null;
  try { cwd = shell.getCwd() || null; } catch { /* best-effort */ }
  try {
    const rawEnv = shell.getEnv();
    if (rawEnv && typeof rawEnv === 'object') {
      // Defensive copy. The Shell mutates this.env in place on
      // export; we want the SQL write to reflect a stable view.
      env = { ...rawEnv } as Record<string, string>;
    }
  } catch { /* best-effort */ }
  if (!cwd && !env) return;
  try {
    persistShellState(ctx, { cwd, env });
  } catch (e: any) {
    console.warn('[nimbus/B\'.1] persistShellState failed:', e?.message || e);
  }
}

/**
 * Classify a closing/erroring WebSocket by its serialized attachment.
 * Shell sockets carry `{kind:'shell'}` (set at the /ws upgrade site);
 * HMR sockets carry `{kind:'cirrus-hmr', clientId}` (set at :1240).
 * Any other (undefined/unknown) attachment falls back to 'shell' to
 * preserve pre-F1 behaviour for legacy accept sites.
 */
export function wsKind(ws: WebSocket): { kind: string; clientId?: string } {
  try {
    const att = (ws as any).deserializeAttachment?.();
    if (att && typeof att === 'object' && typeof att.kind === 'string') {
      return att as { kind: string; clientId?: string };
    }
  } catch { /* deserializeAttachment is optional */ }
  return { kind: 'shell' };
}

export async function wsMessage(self: WsHost, ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  try {
    // HMR clients: route messages to the facet via HmrBridge.
    // We identify HMR sockets by the attachment tag set at accept time.
    const attach = (ws as any).deserializeAttachment?.();
    if (attach?.kind === 'cirrus-hmr') {
      const data = typeof message === 'string' ? message : dec.decode(message);
      self.cirrusReal?.deliverHmrClientMessage(attach.clientId, data);
      return;
    }
    // W9: process-logs sockets are output-only by contract. Drop
    // any inbound frame; never let it parse-fail to the shell.
    if (attach?.kind === 'process-logs') {
      return;
    }
    const data = typeof message === 'string' ? message : dec.decode(message);
    const msg = JSON.parse(data);
    if (self.terminal) self.terminal.handleMessage(msg);
    // ── B'.1 snapshot ───────────────────────────────────────────────
    // Persist Shell state to DO SQLite after the terminal has handled
    // the user's keystroke. The Shell builtin `cd` mutates this.cwd
    // synchronously inside executeLine, so by the time we reach this
    // line a `cd app\r` has already taken effect and we capture the
    // new cwd. Cheap when nothing has changed; SESSION_ENV_MAX_BYTES
    // is the only failure mode and is logged, not thrown.
    snapshotShellState(self);
  } catch (e: any) {
    // Never let a message parsing error crash the DO
    console.error('[nimbus] webSocketMessage error:', e?.message);
  }
}

export async function wsClose(
  self: WsHost,
  ws: WebSocket,
  _code?: number,
  _reason?: string,
  _wasClean?: boolean,
): Promise<void> {
  // Audit F1: discriminate by socket kind. Previously BOTH parameters
  // were absent and every close — including preview-iframe HMR sockets
  // closed by `vite stop` / navigation — nulled the session's
  // shell/terminal/kernel, silently freezing the user's terminal tab.
  const att = wsKind(ws);
  // W9: process-logs sockets close routinely (user closes a log tab).
  // Don't touch shell/terminal — and don't bother flushing here either
  // because process-logs ws close doesn't imply session lifecycle.
  if (att.kind === 'process-logs') {
    return;
  }
  if (att.kind === 'cirrus-hmr') {
    // HMR socket closed. Detach from the bridge + drop from the map.
    // Do NOT touch shell/terminal/kernel — the user's terminal tab
    // is still alive and has nothing to do with this HMR close.
    try {
      const clientId = att.clientId || self._cirrusHmrWsClients?.get(ws);
      self._cirrusHmrWsClients?.delete(ws);
      if (clientId) self.cirrusReal?.detachHmrClient(clientId);
    } catch { /* best-effort */ }
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
  } catch { /* observability is non-critical */ }
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
    } catch (e: any) {
      console.error('[nimbus] webSocketClose: flushAll failed —', e?.message || e);
      try { self.sqliteFs.clearWriteFailures(); } catch {}
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

export async function wsError(self: WsHost, ws: WebSocket, _error?: any): Promise<void> {
  // Audit F1: same discriminator as webSocketClose. A socket error
  // on an HMR WS must not take down the terminal tab.
  const att = wsKind(ws);
  // W9: process-logs error — same drop-and-return policy as close.
  if (att.kind === 'process-logs') {
    return;
  }
  if (att.kind === 'cirrus-hmr') {
    try {
      const clientId = att.clientId || self._cirrusHmrWsClients?.get(ws);
      self._cirrusHmrWsClients?.delete(ws);
      if (clientId) self.cirrusReal?.detachHmrClient(clientId);
    } catch { /* best-effort */ }
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
  } catch { /* observability is non-critical */ }
  // [B'.4] Live phase indicator — same as wsClose path.
  self._b4Phase = 'drained';

  if (self.sqliteFs) {
    try {
      self.sqliteFs.flushAll();
    } catch (e: any) {
      console.error('[nimbus] webSocketError: flushAll failed —', e?.message || e);
      try { self.sqliteFs.clearWriteFailures(); } catch {}
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
        message: (_error as any)?.message ?? String(_error),
      });
    } catch { /* fail-soft */ }
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
export function safePersistRing(self: WsHost): void {
  try {
    const p = self._w5PersistRing();
    const ctx = (self as any).ctx;
    if (p && ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(p); } catch { /* best-effort */ }
    }
  } catch (e: any) {
    console.warn('[nimbus/W5] _w5SafePersistRing threw:', e?.message);
  }
}
