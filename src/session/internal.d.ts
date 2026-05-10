/**
 * session/internal.d.ts — cross-sibling contract for NimbusSession.
 *
 * Type-only — no runtime emit.
 *
 * This declaration file documents the cross-sibling-callable surface of
 * `NimbusSession`. Every member listed here MUST be PUBLIC (default
 * visibility) on the class — not `private`, not `protected`. TypeScript's
 * `private` modifier is nominal: a `private` field on the class fails
 * structural compatibility with a public field on this interface
 * (TS-2412 at every delegator call site that passes `this`).
 *
 * Per plan §IX.1 (refined option b'). See also DEFECT-D1 in
 * audit/sessions/session-refactor-build-progress.md: the parent
 * `CloudflareDurableObject` class declares `ctx` and `env` as `protected`,
 * which CANNOT be widened on a public interface — sibling helpers that
 * need them MUST take them as explicit args, not via `host.ctx`.
 *
 * MAINTENANCE RULES:
 *
 *   1. Any new field/method on `NimbusSession` that ANY sibling module
 *      reads or calls MUST be added to this interface in the SAME COMMIT.
 *   2. Any field/method removed from `NimbusSession` MUST also be removed
 *      from this interface in the same commit.
 *   3. Members NOT in this interface may remain `private` on the class;
 *      they are class-internal helpers unreachable from siblings.
 *   4. The S0 baseline probe `field-names.mjs` (planned for S11)
 *      enforces (Object.keys(NimbusSession.prototype) ∪ field names)
 *      ⊇ (members declared in SessionInternal). Drift fails the gate.
 *   5. `tsc --strict` enforces the contract at every commit.
 *
 * **NOT INCLUDED (deliberate omissions):**
 *   - `ctx` / `env` — `protected` on parent class. Pass explicitly.
 *   - `_W*_*` storage-key static constants — moved to nimbus-session-keys.ts.
 *   - Module-private helpers (`_emitExitDump` was historically `private`;
 *     post-refactor it's reachable from -rpc.ts so it lives here).
 *
 * See SESSION-REFACTOR-PLAN.md Appendix VIII.1 + IX.1 + IX.10 for design
 * context. Originally drafted in the plan; this is the live implementation.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { ProcessTable } from '../runtime/process-table.js';
import type { PortRegistry } from '../runtime/port-registry.js';
import type { ProcessLogStore } from '../runtime/process-logs.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { FacetManager } from '../facets/manager.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
import type { ViteDevServer } from '../facets/vite-dev-server.js';
import type { CirrusReal } from '../facets/cirrus-real.js';
import type { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import type { NpmInstaller } from '../npm/installer.js';
import type { Kernel, Shell } from '@lifo-sh/core';
import type { WsHibernationConfigResult } from './hibernation.js';
import type { W12EnableResult } from './replica-routes.js';

/**
 * Cross-sibling-callable contract for `NimbusSession`. The class is the
 * sole implementer; every field/method here must be default-public on
 * the class declaration.
 *
 * Sibling modules type their `self` parameter as this interface to
 * narrow the surface they touch and to enforce the maintenance rules
 * above. Where a helper needs `ctx`/`env`, it takes them as explicit
 * args separately from this `host`.
 */
export interface SessionInternal {
  // ── Core session state (always set after first request) ─────────────
  sqliteFs: SqliteVFS | null;
  kernel: Kernel | null;
  shell: Shell | null;
  terminal: WebSocketTerminal | null;
  facetManager: FacetManager | null;
  /** W8: child_process broker; lazy. */
  facetProcessManager: any;
  esbuildService: EsbuildService | null;
  viteDevServer: ViteDevServer | null;
  /**
   * Primitives wave: PID + port the default-Cirrus vite shim is registered
   * under in the supervisor's process table & port registry. Cleared on
   * `vite stop` / on-exit teardown. Null when the shim is not running.
   */
  _viteShimPid: number | null;
  _viteShimPort: number | null;
  /** Phase-2 cirrus-real (opt-in real-Vite mode). */
  cirrusReal: CirrusReal | null;
  /** Phase-2 cirrus-hmr WebSocket → clientId map. */
  _cirrusHmrWsClients: Map<WebSocket, string> | null;
  nimbusWrangler: NimbusWrangler | null;
  npmInstaller: NpmInstaller | null;
  /** Singleton fetch proxy entrypoint for npm installs. */
  fetchProxyEntrypoint: any;
  /** Process bookkeeping (always present from ctor). */
  processTable: ProcessTable;
  portRegistry: PortRegistry;
  processLogs: ProcessLogStore;

  // ── W9 hibernation persistence state ────────────────────────────────
  _w9WsConfig: WsHibernationConfigResult | null;
  _w9IsolateGen: number;
  _w9IsolateGenPersisted: boolean;
  _w9SchemaInit: boolean;
  _w9PersistWired: boolean;
  _w9FlushTimer: any;

  // ── Heap probe state ────────────────────────────────────────────────
  _diagPeakRss: number;
  _diagPeakHeapUsed: number;
  _diagPeakAt: number;
  _diagSampleCount: number;

  // ── W12 read replica state ──────────────────────────────────────────
  _w12EnableResult: W12EnableResult | null;

  // ── Routing prefix + banners ────────────────────────────────────────
  sessionBasePath: string;
  sessionBasePathHydrated: boolean;
  wranglerAliasBannerShown: boolean;

  // ── W8 child_process registry handle ────────────────────────────────
  _cpRegistry: any;

  // ── W5 ring-persist tracking (separate from `_w5PersistRing()` below) ─
  _w5LastPersistAt: number;
  _w5LastPersistRingSize: number;

  // ── B'.4 session phase (R/B/W/O state machine) ─────────────────────
  // Live phase indicator surfaced via /api/_diag/session.phase. Values
  // are 'cold' (pre-init) | 'rehydrate' | 'build' | 'wire' | 'online'
  // | 'hydrated' | 'drained'. Updated in initSession at each phase
  // boundary; reset to 'drained' in wsClose. Pre-first-init the field
  // is null so the diag endpoint can distinguish "never inited" from
  // "init returned but didn't set a phase".
  _b4Phase: import('../observability/oom-discriminator.js').SessionState | null;

  // ── B'.5 warm-join counter ─────────────────────────────────────────
  // Increments each time /ws takes the warm-rejoin path (skipping
  // Phase B by reusing the still-alive kernel/shell). Probes assert
  // this is ≥1 after a forced wsClose + reconnect on the same
  // isolate. 0 on cold isolates / first connect.
  _b4WarmJoinCount: number;

  // ── Convenience getters ─────────────────────────────────────────────
  readonly nimbusDebug: boolean;
  readonly viteBasePath: string;

  // ── Methods siblings call back into ─────────────────────────────────
  ensureSqliteFs(): void;
  ensureFacetManager(): void;
  _ensureFacetProcessManager(): any;
  ensureFetchProxy(log?: (msg: string) => void): any | null;
  buildFetchFn(log?: (msg: string) => void): ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  ensureNpmInstaller(onProgress?: (msg: string) => void): void;
  _envFlagDefaultOn(name: string): boolean;
  _setCpRegistry(r: any): void;
  hydrateSessionBasePath(request: Request): Promise<void>;
  seedFilesystem(): void;

  // Class delegators that siblings dispatch through (per plan §IX.2 R3).
  initSession(ws: WebSocket): void;
  _w9MaybeBumpIsolateGen(): Promise<void>;
  _w9FlushOnClose(): void;
  _w9WireProcessLogPersist(): void;
  _w5PersistRing(): Promise<void> | null;
  _w5RehydrateRingFromStorage(): Promise<void>;
  _w5SafePersistRing(): void;
  _diagSampleMemory(): void;
  _diagReadNodeMem(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } | null;
  _diagReadPerfMem(): { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number } | null;
  getReplicaState(): { state: string; error: string | null; isReplica: boolean; bookmark: string | null; suspended: boolean };

  // RPC + emitter methods that may be called from siblings (e.g. -ws.ts
  // calls _w5SafePersistRing + _w9FlushOnClose; -routes.ts may call
  // _w5RehydrateRingFromStorage indirectly via ensureSqliteFs).
  _emitExitDump(pid: number, code: number): void;
  _emitShellExecDone(pid: number, cmd: string, code: number, durationMs: number): void;
  _reportExternalExit(pid: number, code: number, reason: string): void;
  _ensureLogJanitor(): void;
}
