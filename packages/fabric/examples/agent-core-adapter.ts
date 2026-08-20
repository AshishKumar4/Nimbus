/**
 * agent-core-adapter.ts — EXAMPLE: agent-core's process and environment
 * seams, implemented over the fabric.
 *
 * agent-core defines two pure seams with no Cloudflare implementation:
 * `ShellProcessBackend` (packages/agent-core/src/facets/shell/facet.ts:38-43
 * — exactly `completion`, `forceTerminate`, `confirmTerminated`, `fence`)
 * and `EnvironmentProvider` (src/environments/provider.ts:195-225 — every
 * mutating verb paired with an inspect twin, requests generation-pinned,
 * outcomes `ready | absent | failed | indeterminate`). This file shows the
 * mapping onto fabric's `ResidentProcessHandle`, `cloneStorage`, and the
 * hostname-per-port preview scheme. It is a worked example, not a shipped
 * runtime: the seam types are mirrored here structurally (agent-core's repo
 * is its own), and an embedder writes this file's equivalent against the
 * real imports.
 *
 * The lifecycle facts the mapping rests on, from agent-core's own boundary
 * (`ShellExecutionBoundary`, facet.ts:60-154):
 *   - a rejected `completion` is treated as exit 1 by the boundary;
 *   - `forceTerminate` may throw — the boundary then fences immediately;
 *   - `confirmTerminated() === false` means "still deciding" and defers to
 *     the boundary's timeout, never "failed";
 *   - a throwing `fence` is swallowed: "The local fence still closes this
 *     handle even if remote cleanup reports failure."
 */

import type { ResidentProcessHandle } from '../src/process-fabric.js';
import { cloneStorage } from '../src/workerd-facet-host.js';

// ── agent-core's seams, mirrored structurally (do not import their repo) ────

/** facet.ts:38-43, verbatim shape. */
export interface ShellProcessBackend {
  readonly completion: Promise<number>;
  forceTerminate(): void;
  confirmTerminated(): boolean | Promise<boolean>;
  fence(): void;
}

/** provider.ts:37-61 — the outcome unions the provider seam speaks. */
export type ProviderActionOutcome = { readonly name: 'succeeded' | 'failed' | 'indeterminate' };
export type ProviderResourceOutcome<Value> =
  | { readonly name: 'ready'; readonly value: Value }
  | { readonly name: 'absent' }
  | { readonly name: 'failed' }
  | { readonly name: 'indeterminate' };

/** provider.ts:138-145 — the live-session handle openSession yields. */
export interface LiveEnvironmentSession {
  readonly children: ReadonlyArray<{ dispose(): void | Promise<void> }>;
  release(): void | Promise<void>;
}

/** provider.ts:171-193 — every request pins environment identity and
 *  generation, so a stale caller cannot act on a successor. */
export interface OpenSessionRequest {
  readonly environmentId: string;
  readonly environmentRevision: number;
  readonly generation: number;
  readonly sessionId: string;
}
export interface SnapshotEnvironmentRequest extends OpenSessionRequest {
  readonly sessionEpoch: number;
  readonly snapshotId: string;
}
export interface ExposePortRequest extends OpenSessionRequest {
  readonly sessionEpoch: number;
  readonly exposureId: string;
  readonly port: number;
}

// ── ShellProcessBackend over one resident process ───────────────────────────

/**
 * A shell command as a fabric resident. The exit code rides the `lifetime`
 * runner's startProcess payload, whose shape is the embedder's — so the
 * embedder names how to read it.
 */
export function shellBackendFor(
  handle: ResidentProcessHandle,
  exitCodeOf: (startPayload: unknown) => number,
): ShellProcessBackend {
  return {
    // A lifetime runner settles booted() at exit; a host that dies under the
    // process rejects it, and the boundary maps that rejection to exit 1.
    completion: handle.booted().then(exitCodeOf),
    // Synchronous and idempotent, matching ResidentProcessHandle.kill.
    forceTerminate(): void {
      handle.kill();
    },
    // False before a kill was asked for — "still deciding", the boundary
    // waits on its own timeout. After a kill, settle with the teardown: done
    // resolves only once the process is actually gone.
    confirmTerminated(): boolean | Promise<boolean> {
      if (!handle.killed) return false;
      return handle.done.then(() => true, () => true);
    },
    // The local fence: close this handle's side whatever the remote did.
    // kill() is idempotent and swallows teardown throws, which is exactly
    // the "local fence still closes this handle" contract.
    fence(): void {
      handle.kill();
    },
  };
}

// ── The four EnvironmentProvider verbs over the fabric ──────────────────────

/** What the example provider needs from its embedder: how to spawn one
 *  session process, and where port previews are served. */
export interface FabricEnvironmentHost {
  /** Spawn the resident process backing one session (the embedder owns the
   *  boot spec; `ProcessFabric.startResidentProcess` is the fabric half). */
  spawnSession(request: OpenSessionRequest): Promise<ResidentProcessHandle>;
  /** The hosting Durable Object's ctx — snapshots clone same-object only. */
  ctx: Parameters<typeof cloneStorage>[0];
  /** Positive populated-ness probe for a facet name (the caller's schema —
   *  see cloneStorage: a clone of an unresolvable source silently EMPTIES
   *  the destination, so both ends are verified). */
  facetPopulated(name: string): boolean | Promise<boolean>;
  /** The facet name holding a session's storage. */
  sessionFacetName(sessionId: string): string;
  /** Preview apex, e.g. 'nimbus-os.dev' — ports serve as `<port>--<id>.<apex>`. */
  previewApex: string;
}

export class FabricEnvironmentProvider {
  /** exposureId → preview URL. Inbound requests for these hosts route into
   *  the session's `ResidentProcessHandle.routeTarget.handleHttpRequest`. */
  private readonly exposures = new Map<string, string>();

  constructor(private readonly host: FabricEnvironmentHost) {}

  async openSession(request: OpenSessionRequest): Promise<ProviderResourceOutcome<LiveEnvironmentSession>> {
    try {
      const handle = await this.host.spawnSession(request);
      return {
        name: 'ready',
        value: { children: [], release: () => handle.kill() },
      };
    } catch {
      // The spawn either failed before any facet existed (failed) or the
      // host died mid-boot (indeterminate); the fabric rejects both loudly.
      return { name: 'failed' };
    }
  }

  /**
   * Snapshot = same-object copy-on-write of the session facet's SQLite
   * (measured 18-31 ms for a 45.73 MB corpus, flat in size). The ContentRef
   * is the snapshot facet's name; `cloneStorage` verifies BOTH ends are
   * populated, because an unresolvable source silently empties the
   * destination while reporting success.
   */
  async createSnapshot(request: SnapshotEnvironmentRequest): Promise<ProviderResourceOutcome<string>> {
    const src = this.host.sessionFacetName(request.sessionId);
    const dst = `snapshot-${request.snapshotId}`;
    try {
      await cloneStorage(this.host.ctx, {
        src,
        dst,
        populated: (name) => this.host.facetPopulated(name),
      });
      return { name: 'ready', value: dst };
    } catch {
      // A refused clone left nothing to trust in dst — never 'ready'.
      return { name: 'failed' };
    }
  }

  /**
   * Hostname-per-port: `<port>--<sessionId>.<apex>`, no path rewriting. The
   * URL is derivable, so re-exposing is idempotent and inspection is a map
   * read.
   */
  async exposePort(request: ExposePortRequest): Promise<ProviderResourceOutcome<string>> {
    const url = `https://${request.port}--${request.sessionId}.${this.host.previewApex}/`;
    this.exposures.set(request.exposureId, url);
    return { name: 'ready', value: url };
  }

  async inspectExposure(request: ExposePortRequest): Promise<ProviderResourceOutcome<string>> {
    const url = this.exposures.get(request.exposureId);
    return url === undefined ? { name: 'absent' } : { name: 'ready', value: url };
  }

  async revokeExposure(request: ExposePortRequest): Promise<ProviderActionOutcome> {
    this.exposures.delete(request.exposureId);
    return { name: 'succeeded' };
  }
}
