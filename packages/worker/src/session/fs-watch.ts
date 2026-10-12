/**
 * session/fs-watch.ts — server-side `fs-watch-*` WS protocol.
 *
 * The session's namespace tells every change it shows
 * (`CompositeVFS.watchChanges`: `add`/`addDir`/`change`/`unlink`/
 * `unlinkDir`/`rename`), on SQLite and on any mount, as the kernel sees
 * it. This module exposes that to browser clients (the FileTree sidebar
 * in public/s/index.html) over the existing shell WebSocket, closing the
 * user-reported gap: "file editor doesnt auto load any new
 * files/folders". An event's paths are sent as SQLite names them, without
 * the leading slash.
 *
 * Protocol (additive; coexists with fs-read/fs-write/fs-list at
 * session/init.ts:260):
 *
 *   IN  { type:'fs-watch-subscribe', reqId, paths:string[] }
 *   OUT { type:'fs-watch-subscribe-result', reqId, ok:true, subId:string }
 *       or { type:'fs-watch-subscribe-result', reqId, ok:false, error }
 *
 *   OUT { type:'fs-watch-event', subId, events:VfsEvent[], dropped?:number }
 *       — SERVER-PUSHED; no reqId echo.
 *
 *   IN  { type:'fs-watch-unsubscribe', reqId, subId?:string }
 *   OUT { type:'fs-watch-unsubscribe-result', reqId, ok:true, removed:number }
 *
 *   subId is optional on unsubscribe: omitting it drops ALL of the
 *   WS's subscriptions. The client side prefers omitting since it
 *   maintains one subscription per WS in practice.
 *
 * Coalescing strategy
 * -------------------
 * The namespace tells each change as it lands. We add a ~50 ms
 * debounce so a 1000-file npm install doesn't produce 1000 WS
 * frames. 50 ms absorbs
 * the typical burst pattern and stays well under the user-perceptible
 * 100 ms threshold.
 *
 * Memory cap: per subscriber, pending events are hard-capped at 200.
 * When the cap is hit, oldest events are dropped and a `dropped:N`
 * field rides on the next emitted frame so the client can choose to
 * re-fetch the whole tree (it does in practice — bounded patches vs
 * full reload). No producer back-pressure.
 *
 * Lifecycle
 * ---------
 *   - One Map<WebSocket, Sub[]> per session DO on the WsHost.
 *   - On `fs-watch-subscribe`: append a Sub + watch each of its paths.
 *   - On `fs-watch-unsubscribe`: invoke unsub closures + remove entries.
 *   - On WS close / error (ws.ts:wsClose / wsError): unconditionally
 *     drop all subs for the dying WS.
 *   - On WS warm-rejoin: the OLD ws's close already cleaned up; the
 *     NEW ws is unrelated until the client re-subscribes from
 *     its onopen handler.
 *
 * No recurring timers introduced. The debounce uses a one-shot
 * setTimeout that nulls itself on fire and is cleared on unsub —
 * preserving the W1 hibernation invariant (CF DO docs verbatim:
 * "scheduled callbacks prevent hibernation. This includes setTimeout
 * and setInterval usage." — a transient one-shot during active work is
 * acceptable and matches the W9 flush debounce pattern at
 * hibernation.ts:236-256).
 */

import type { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { VfsEvent } from '@nimbus-sh/core/vfs/events.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

/** Per-subscription state. Closed over a single WebSocket. */
export interface FsWatchSub {
  /** Stable id for client-side correlation. */
  subId: string;
  /** The trees the client watches, as the namespace names them. */
  paths: string[];
  /** Stops its watches. */
  unsub: () => void;
  /** Pending events to flush in the next debounce window. */
  pending: VfsEvent[];
  /** Count of events dropped due to the SUB_MAX_QUEUE cap. */
  dropped: number;
  /** Active debounce timer; null when no flush scheduled. */
  flushTimer: any;
}

/** Hard cap on pending events per subscriber before drop-oldest. */
const SUB_MAX_QUEUE = 200;

/**
 * Debounce window in ms. 50 ms absorbs npm-install / git-checkout
 * burst patterns; well under the 100 ms user-perceptible threshold;
 * not a recurring timer (one-shot per burst, self-clears on fire).
 */
const COALESCE_MS = 50;

/** Generate a short opaque id for a new subscription. */
function genSubId(): string {
  return 'sub-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

/** Minimal host shape needed by this module. */
export interface FsWatchHost {
  sqliteFs: SqliteVFS | null;
  getFilesystemAuthority(): ProcessFiles;
  _fsWatchSubs?: Map<WebSocket, FsWatchSub[]>;
}

/**
 * The trees `paths` names, each once: absolute, and none under another
 * (whose changes it would tell twice). None: the whole namespace.
 */
function watchedTrees(paths: string[]): string[] {
  const trees = [...new Set(paths.map((p) => `/${p.replace(/^\/+|\/+$/g, '')}`))].sort();
  if (trees.length === 0 || trees.includes('/')) return ['/'];
  return trees.filter((tree, i) => !trees.slice(0, i).some((outer) => tree.startsWith(`${outer}/`)));
}

/**
 * Handle `fs-watch-subscribe`. Watches each path the client names in the
 * session's namespace; the watch captures `ws` and pushes events
 * (debounced + coalesced) over it.
 *
 * Returns the structured result for the caller to forward as the
 * `fs-watch-subscribe-result` frame.
 */
export function handleFsWatchSubscribe(
  host: FsWatchHost,
  ws: WebSocket,
  msg: { paths?: unknown },
): { ok: true; subId: string } | { ok: false; error: string } {
  if (!host.sqliteFs) return { ok: false, error: 'VFS not initialised' };
  const namespace = host.getFilesystemAuthority().vfs;

  const named: string[] = [];
  if (Array.isArray(msg.paths)) {
    for (const p of msg.paths) {
      if (typeof p === 'string' && p.length > 0) named.push(p);
    }
  }
  const paths = watchedTrees(named);

  if (!host._fsWatchSubs) host._fsWatchSubs = new Map();
  let list = host._fsWatchSubs.get(ws);
  if (!list) {
    list = [];
    host._fsWatchSubs.set(ws, list);
  }

  const sub: FsWatchSub = {
    subId: genSubId(),
    paths,
    unsub: () => {}, // patched below once busUnsub is in hand
    pending: [],
    dropped: 0,
    flushTimer: null,
  };

  /** Flush pending events over the WS. Best-effort. */
  const flush = () => {
    sub.flushTimer = null;
    if (sub.pending.length === 0 && sub.dropped === 0) return;
    const events = sub.pending;
    const dropped = sub.dropped;
    sub.pending = [];
    sub.dropped = 0;
    try {
      const frame: any = { type: 'fs-watch-event', subId: sub.subId, events };
      if (dropped > 0) frame.dropped = dropped;
      ws.send(JSON.stringify(frame));
    } catch {
      // WS closed mid-flush; wsClose cleanup handles unsub. Silent drop.
    }
  };

  /** A change in one of its trees, queued as SQLite names its paths. */
  const onChange = (ev: VfsEvent) => {
    if (sub.pending.length >= SUB_MAX_QUEUE) {
      // Drop-oldest: shift instead of unbounded growth.
      sub.pending.shift();
      sub.dropped++;
    }
    sub.pending.push(ev.oldPath === undefined
      ? { type: ev.type, path: ev.path.slice(1), timestamp: ev.timestamp }
      : { type: ev.type, path: ev.path.slice(1), oldPath: ev.oldPath.slice(1), timestamp: ev.timestamp });
    // One-shot debounce: re-arm if no flush scheduled.
    if (!sub.flushTimer) {
      sub.flushTimer = setTimeout(flush, COALESCE_MS);
    }
  };

  const stops = paths.map((path) => namespace.watchChanges(path, onChange));
  sub.unsub = () => {
    for (const stop of stops) {
      try { stop(); } catch {}
    }
    if (sub.flushTimer) {
      try { clearTimeout(sub.flushTimer); } catch {}
      sub.flushTimer = null;
    }
    sub.pending = [];
    sub.dropped = 0;
  };

  list.push(sub);
  return { ok: true, subId: sub.subId };
}

/**
 * Handle `fs-watch-unsubscribe`. If `subId` is given, drops only that
 * subscription; otherwise drops ALL of this WS's subscriptions.
 * Returns the count removed.
 */
export function handleFsWatchUnsubscribe(
  host: FsWatchHost,
  ws: WebSocket,
  msg: { subId?: unknown },
): { ok: true; removed: number } {
  const map = host._fsWatchSubs;
  if (!map) return { ok: true, removed: 0 };
  const list = map.get(ws);
  if (!list) return { ok: true, removed: 0 };
  let removed = 0;
  const targetId = typeof msg.subId === 'string' ? msg.subId : null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (targetId === null || list[i].subId === targetId) {
      try { list[i].unsub(); } catch {}
      list.splice(i, 1);
      removed++;
    }
  }
  if (list.length === 0) map.delete(ws);
  return { ok: true, removed };
}

/**
 * Drop EVERY subscription on the closing WS. Called from wsClose /
 * wsError. Idempotent + no-op when nothing pending.
 */
export function cleanupFsWatchOnClose(host: FsWatchHost, ws: WebSocket): void {
  const map = host._fsWatchSubs;
  if (!map) return;
  const list = map.get(ws);
  if (!list) return;
  for (const sub of list) {
    try { sub.unsub(); } catch {}
  }
  map.delete(ws);
}



