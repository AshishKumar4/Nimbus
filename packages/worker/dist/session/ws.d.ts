/**
 * session/ws.ts — WebSocket lifecycle for the supervisor DO.
 *
 * One DO can host multiple WS kinds simultaneously: the user's shell
 * terminal, cirrus-real HMR clients (one per browser tab on /preview),
 * and process-log streams (one per `logs -f`). Without a discriminator
 * a close on the HMR socket would null the shell's terminal and the
 * user's tab would freeze (Audit F1). The wsKind() classifier reads
 * the attachment tag set at upgrade time to route each lifecycle
 * event to the right handler.
 *
 * Surfaces:
 *   - wsKind(ws)              — pure attachment-tag classifier.
 *   - wsMessage(self, ws, m)  — route by kind to terminal/HMR/process-logs.
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
import { type FsWatchSub } from './fs-watch.js';
import type { ProcessLogStore } from '../runtime/process-logs.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { CirrusReal } from '../facets/cirrus-real.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
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
    /** file-tree-watch (2026-05-15): per-WS fs-watch subscriptions.
     *  Keyed on the live WebSocket; cleaned up unconditionally in
     *  wsClose / wsError. See src/session/fs-watch.ts for the protocol
     *  + lifecycle. Optional (undefined) until first subscribe so
     *  memory stays at 0 for terminal-only sessions. */
    _fsWatchSubs?: Map<WebSocket, FsWatchSub[]>;
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
    _b4Phase: import('../observability/oom-discriminator.js').SessionState | null;
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
export declare function wsKind(ws: WebSocket): {
    kind: string;
    clientId?: string;
};
export declare function wsMessage(self: WsHost, ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
export declare function wsClose(self: WsHost, ws: WebSocket, _code?: number, _reason?: string, _wasClean?: boolean): Promise<void>;
export declare function wsError(self: WsHost, ws: WebSocket, _error?: any): Promise<void>;
/**
 * W5 Lever 5: bridge between _w5PersistRing (which returns a Promise)
 * and ctx.waitUntil. Skipped silently if ctx.waitUntil isn't available
 * (test contexts). Takes ctx via `(self as any).ctx` cast — D1 escape.
 */
export declare function safePersistRing(self: WsHost): void;
//# sourceMappingURL=ws.d.ts.map