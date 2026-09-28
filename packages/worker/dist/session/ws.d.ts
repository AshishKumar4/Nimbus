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
import { type FsWatchSub } from './fs-watch.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { CirrusReal } from '../facets/cirrus-real.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { InitSessionOptions } from './init.js';
import type { Kernel, Shell } from '@nimbus-sh/core/substrate/lifo/index.js';
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
     *  + lifecycle. Optional (undefined) until first subscribe so sessions
     *  that never open the file tree carry no watch state. */
    _fsWatchSubs?: Map<WebSocket, FsWatchSub[]>;
    processes: SessionProcessSupervisor;
    wranglerAliasBannerShown: boolean;
    _w9PersistWired: boolean;
    _w9FlushTimer: any;
    _w9SchemaInit: boolean;
    _w9WsConfig: any;
    _diagPeakRss: number;
    _diagPeakHeapUsed: number;
    _w5LastPersistAt: number;
    _w5LastPersistRingSize: number;
    /** [B'.4] live phase indicator — see nimbus-session-internal.d.ts */
    _b4Phase: import('@nimbus-sh/platform/oom-discriminator.js').SessionState | null;
    /** The session rebuild a woken instance has in flight; see bindShellSocket. */
    _wakeRebuild: Promise<void> | null;
    initSession(ws: WebSocket, options?: InitSessionOptions): Promise<void>;
    _w5PersistRing(): Promise<void> | null;
    _w9FlushOnClose(): void;
}
/**
 * Give the shell socket a frame arrived on a live session to land in.
 *
 * The runtime evicts a quiet object from memory while its accepted sockets
 * stay open (the WebSocket Hibernation API), and the next frame from the
 * peer wakes a fresh instance whose `shell`, `terminal` and `kernel` are
 * null: the socket outlived the sleep, the session in memory did not.
 * Measured 2026-09-14 on a deployed Worker: eight quiet seconds and the
 * object is still there, ten and it is gone; the frame that wakes it is
 * delivered and handled without error, and the peer gets nothing back —
 * no output, no close, no error — because the terminal lookup that follows
 * found nothing to hand it to. Only a new /ws upgrade rebuilt the session,
 * and a peer whose socket still reads OPEN has no reason to make one. A
 * browser tab hides this by probing every few seconds; a driver that
 * simply waits between commands does not.
 *
 * So the rebuild runs here, on the socket that spoke, before the frame is
 * handled: the cold path the upgrade takes after an eviction (cwd, env,
 * mounts back from SQLite) minus the scrollback replay the peer already has
 * on screen. Frames that land while the build runs await the same build —
 * the input gate does not serialise handlers across a non-storage await, so
 * without the shared promise two quick keystrokes would build two shells.
 *
 * A session that exists but answers to another socket — one an SDK call
 * built on its headless terminal after the same wake — is handed to this
 * socket the way the warm rejoin hands it to a new upgrade. The upgrade
 * refuses a second shell socket while one still has a peer, so the socket
 * that speaks is the one the peer is on.
 *
 * A build that fails closes the socket with a reason and answers false, so
 * the caller drops the frame. The peer must learn that its shell is gone;
 * the silence this replaces is the whole defect.
 *
 * A socket this side has already closed gets no session either: destroy
 * closes every accepted socket and nulls the terminal before it wipes
 * storage, and a frame still in flight on one of them must not rebuild
 * the session it is tearing down.
 */
export declare function bindShellSocket(self: WsHost, ws: WebSocket): Promise<boolean>;
/**
 * What every output frame of the shell terminal feeds besides the socket:
 * the persisted scrollback, and the shell-state snapshot.
 *
 * The snapshot runs here and not only after each inbound frame because
 * commands run asynchronously: the `cd` a line asked for takes effect
 * after the inbound handler has already snapshotted, and the next frame —
 * which used to catch the row up — never arrives when the object
 * hibernates first. Measured 2026-09-14: `cd /tmp && echo one`, ten quiet
 * seconds, and the woken shell answered `pwd` from /home/user. The prompt
 * that ends every command is an output frame, so by the time it has
 * flushed, the state it reflects is what the row records.
 *
 * Every socket a shell terminal is built on or handed to goes through
 * this — initSession, the warm rejoin, and the wake rebuild — so the
 * three cannot drift.
 */
export declare function shellTerminalTee(self: WsHost): (frame: string) => void;
/**
 * Classify a closing/erroring WebSocket by its serialized attachment.
 * Shell sockets carry `{kind:'shell'}` (set at the /ws upgrade site);
 * watcher sockets carry `{kind:'fs-watch'}`; HMR sockets carry
 * `{kind:'cirrus-hmr', clientId}` (set at :1240).
 * Any other (undefined/unknown) attachment falls back to 'shell' to
 * preserve pre-F1 behaviour for legacy accept sites.
 */
interface WsAttachment {
    kind: string;
    clientId?: string;
    pid?: number;
}
export declare function wsKind(ws: WebSocket): WsAttachment;
export declare function wsMessage(self: WsHost, ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
export declare function wsClose(self: WsHost, ws: WebSocket, _code?: number, _reason?: string, _wasClean?: boolean): Promise<void>;
export declare function wsError(self: WsHost, ws: WebSocket, _error?: any): Promise<void>;
/**
 * W5 Lever 5: bridge between _w5PersistRing (which returns a Promise)
 * and ctx.waitUntil. Skipped silently if ctx.waitUntil isn't available
 * (test contexts). Takes ctx via `(self as any).ctx` cast — D1 escape.
 */
export declare function safePersistRing(self: WsHost): void;
export {};
//# sourceMappingURL=ws.d.ts.map