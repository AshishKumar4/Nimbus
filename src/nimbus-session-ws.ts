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
import { recordFailure, getLastRpcFrame, getLastFacetId } from './oom-discriminator.js';
import { flushOnClose as _w9DoFlushOnClose } from './nimbus-session-hib.js';
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
  _w5PersistRing(): Promise<void> | null;
  _w9FlushOnClose(): void;
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
  self.shell = null;
  self.terminal = null;
  self.kernel = null;
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
  self.shell = null;
  self.terminal = null;
  self.kernel = null;
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
