/**
 * facets/manager.ts — Lifecycle for isolated user-runtime workers.
 *
 * `node script.js` from the shell prompt has to run somewhere isolated
 * — same memory bound as the supervisor (128 MiB) but separate so a
 * runaway script can't take the supervisor down. The script also needs
 * supervisor-owned services: VFS writes, stdout/stderr, process exit,
 * child-process brokering, and preview port routing.
 *
 * One-shot commands use a stateless dynamic Worker entrypoint:
 *   1. LOADER.load(makeConfig)        — isolated dynamic worker
 *   2. worker.getEntrypoint().fetch() — executes the script
 *   3. SUPERVISOR RPC                 — streams output and VFS writes
 *
 * Long-running processes use a dynamic Worker entrypoint that stays
 * registered in ProcessTable and PortRegistry until exit or kill.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ISOLATE_NETWORK, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { residencyMissReport } from '../runtime/residency-miss-report.js';
import { buildOpenCodeTransportPlan, type OpenCodeTransportPlan } from '../runtime/opencode-invocation.js';
import { RESIDENCY_MISS_REPORT_SOURCE } from '../loaders/compiled-bodies.generated.js';
import {
  commonJsCellModuleName,
  commonJsCellReadsBack,
  columnMapModuleName,
  commonJsEntryModuleName,
  declaresWrapperBinding,
  ENTRY_CHECKED,
  runtimeCodeModuleName,
  runtimeExpressionModule,
  runtimeFunctionModule,
  wrapCommonJsCell,
  type CommonJsCellRow,
  type RuntimeCodeEntry,
} from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { moduleImporterUrl } from '@nimbus-sh/core/_shared/module-importer.js';
import { isTypescriptDeclarationFile, stripsTypeScript } from '@nimbus-sh/core/_shared/typescript-specifiers.js';
import { ReadAheadBudget, STDIN_SYNC_READ_BYTES, type ReadAheadAccount } from '@nimbus-sh/core/runtime/stdin-read.js';
import { execIdField, parseExecId, type ProcessEntry, type ProcessRestart } from '@nimbus-sh/core/runtime/process-table.js';
import { InterpreterEnvFactsSchema, interpreterProcessEnv, type InterpreterEnvFacts } from '@nimbus-sh/core/runtime/interpreter-env.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { exitCodeForSignal, type SignalAbortReason } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import { ensureKernelStoreRoot, KERNEL_STORE_ROOT } from './kernel-store-root.js';
import { parseProcessSignalName } from '@nimbus-sh/core/runtime/process-io-protocol.js';
import { TASK_BODY_FAILED } from '@nimbus-sh/core/runtime/facet-host.js';
import { createNodeFacetRuntime, fetchNodeFacetSources, nodeFacetSource, type NodeFacetSources } from '../runtime/node-shims-artifact.js';
import { moduleSource, type ModuleSource, type ImmutableModuleSource } from '@nimbus-sh/platform/module-source.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { memberBuffer } from '@nimbus-sh/platform/worker-code.js';
import { generateSqliteFacetPreamble } from '../runtime/sqlite-shim.js';
import { NODE_SHIMS_IMPORTS } from '../runtime/node-shims-imports.js';
import {
  VFS_CURSOR_SEED_SOURCE,
  serializeFacetVfsCursor,
} from '@nimbus-sh/core/_shared/facet-vfs-cursor.js';
import type { SqliteVFS, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusFilesystemAuthority, NimbusHostFilesystemLease, RuntimeFsBridge, RuntimeSynchronousFs, RuntimeVfsDirEntry, RuntimeVfsStat, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { normalizeVfsPath, stripLeadingSlashes, vfsPathExtension } from '@nimbus-sh/core/vfs/path.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
import { base64, sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import { direntTypeOf, type KnownDirentType } from '@nimbus-sh/core/vfs/dirent-type.js';
import { relayRpcBody, responseScope, type PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import {
  clearPortCapability,
  listPortReservations,
  readPortReservation,
  readPortReservationByOwner,
  releasePortReservation,
  restoreReservedPortCapability,
  type PortVisibility,
} from '../session/port-capability.js';
import { deriveResidentOwner, launchArgv } from './resident-identity.js';
import { z } from 'zod/v4';
import { RESIDENT_OWNER_KEY_PREFIX, DURABLE_IMAGES_KEY_PREFIX, DEV_SERVER_KEY_PREFIX, PROCESS_ENV_DROPPED_KEY } from '../session/keys.js';
import { PORT_CAPABILITY_KEY_PREFIX } from '../session/keys.js';
import { sessionIdentity, unbindPublicPortCapability } from '../router/public-directory.js';
import {
  prefetchForRequire, requireFsOverBridge, resolveDeferredImport, ClosureBoundExceededError,
  type BridgeRequireFs, type DeferredImport, type PreloadModuleRoot, type RequiredModuleRoot,
} from '@nimbus-sh/core/runtime/require-resolver.js';
import { typeScriptStripOptions, type NodeLaunch } from '@nimbus-sh/core/runtime/node-cli.js';
import type { NodeTypeScript } from '@nimbus-sh/core/runtime/typescript-strip.js';
import { findStaticFsReferences, type StaticFsRefs } from '@nimbus-sh/core/runtime/static-fs-refs.js';
import { fileCell, fileText, packageScopeType } from '@nimbus-sh/core/runtime/require-resolution.js';
import type { ModuleScope, PackageType } from '@nimbus-sh/core/runtime/module-format.js';
import { carriesOxide, isManifestKey, linkTargetOf, packageRootOf, planFacetData, planStylesheetSources, STYLESHEET_SOURCE_MAX_FILES, type DataPlanEntry, type DataPlanSource } from './data-plan.js';
import {
  principalTag, profilePrincipal, ReadProfile, verifiedEvidence, type ReadProfileBucket, type StagedProfileEntry,
} from './read-profile.js';

/** What the shared read profile may add to one launch: an eighth of its module map's bytes. */
const READ_PROFILE_LAUNCH_BYTES = Math.floor(VFS_BUNDLE_MAX_BYTES / 8);
import { NpmCache } from '../npm/cache.js';
import { NPM_BIN_MANIFEST_NAME, parseNpmBinManifest } from '../npm/bin-links.js';
import { mayHaveDynamicImport, type ImportSites } from '@nimbus-sh/core/runtime/dynamic-import-rewrite.js';
import { stageEsModules, type EsmStage } from './esm-stage.js';
import { ESM_BINDINGS_MODULE, ESM_HOST_MODULE, readEsModule } from '@nimbus-sh/core/runtime/native-esm.js';
import { relativeWasmPaths } from '@nimbus-sh/core/_shared/relative-wasm-paths.js';
import { recordFailure, getLastRpcFrame, getLastFacetId } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { TurnBudget, PacedWork, turnChunkMaxBytes, withResolvers } from '@nimbus-sh/fabric/turn-budget.js';
import { generation, onColdStart } from '@nimbus-sh/fabric/generation.js';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES, isDynamicWorkerDeadlock, loaderLedgerStats, suspendLaunchAdmission, waitOutsideLedger, withLaunchAdmission, withLaunchPreparation } from '@nimbus-sh/fabric/budgets.js';
import {
  FencedWork,
  FENCED_WORK_KEY_PREFIX,
  type FencedWorkStorage,
  RESIDENT_PROVEN_MS,
  type FencedWorkRecord,
  type RedriveCause,
} from '@nimbus-sh/fabric/fenced-work.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { rewriteProvidedCommonJsModules } from '@nimbus-sh/core/runtime/provided-packages.js';
import {
  bundleCompiledLoader,
  esbuildDiagnosticShim,
  isBundleModuleCandidate,
  looksLikeEsm,
  needsBundleCellTransform,
  transformBundleCells,
  transformEntryScript,
  type BundleCellResultStore,
  type BundleCellTransformStats,
} from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import { TransformStore } from './transform-store.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import {
  packageJsonText,
  parseResolvablePackageJson,
  BUILD_BROWSER_PACKAGE_MAP_POLICY,
  type ResolvablePackageJson,
} from '@nimbus-sh/core/_shared/exports-resolver.js';
import { requirePackageEntry } from '@nimbus-sh/core/runtime/require-resolution.js';
import { type ExecDiagSink, type ExecTelemetryRecord, isExecDiagEnabled, recordExecTelemetry } from './exec-telemetry.js';
import { LAUNCH_PROFILE_MAX_PATHS, LaunchLearningStore, type LaunchLearning, type LaunchReport } from './launch-learning-store.js';
import { LearnedServers } from './server-hints.js';
import type { ServerIdentity } from '@nimbus-sh/core/runtime/server-launch.js';
import { disposeRpcResource, disposeRpcResources } from '@nimbus-sh/platform/rpc-dispose.js';
import { SUPERVISOR_ANSWERING_SRC } from '@nimbus-sh/core/runtime/supervisor-answering.generated.js';
import { REAL_NOW_SOURCE, STOP_REPLAY_SOURCE } from '../runtime/stop-replay.js';
import { PENDING_IO_SOURCE } from '../runtime/pending-io.js';
import { OwnedPieces, ReplayOutputGate, StdinTaken, stopRecordOf } from '../runtime/stop-replay-host.js';
import { answerDigest } from '../runtime/stop-replay-journal.js';
import { REPLAY_PREFIX_MAX_BYTES, REPLAY_JOURNAL_MAX_ENTRIES, REPLAY_READ_RECEIPT_MAX_BYTES, STOP_LIMIT, type ReplayLaunch, type StopRecord } from '../runtime/stop-replay-contracts.js';
import { ReplaySessions } from '../runtime/replay-session.js';
import { openSupervisorDeliveries } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import type { ProcessInputPacket } from '@nimbus-sh/core/runtime/process-input.js';
import { sqliteWasmModuleEntry } from './opencode-staging.js';
import type { OpencodeStageSpec } from './opencode-stage-spec.js';
import {
  FACET_IMAGE_WRITE_SLICE_BYTES,
  ImageStore,
  type ImageBlobStore,
} from '@nimbus-sh/fabric/image-store.js';
import {
  fetchStagedBindingAsset,
  NAPI_WASM_LOADER,
  NAPI_WASM_TRAMPOLINE,
  STAGED_BINDING_LOADER_MODULE,
  STAGED_BINDING_TRAMPOLINE_MODULE,
  stagedBinding,
  stagedBindingsFacetImport,
  stagedBindingsRequiredBy,
  stagedBindingsDeclaredBy,
  STAGED_BINDINGS,
  type DeclaredBindingFs,
} from '../runtime/staged-bindings.js';
import {
  encodeCodePack,
  ProcessFabric,
  ProcessHostLost,
  ResidentProcessHandle,
  type OneShotCodeSpec,
  type ProcessHost,
  type ProcessHostFactory,
  type ResidentBootSpec,
  type ResidentCodeSpec,
  type ResidentDiskReader,
  type StartContract,
  type Supervise,
} from '@nimbus-sh/fabric/process-fabric.js';
import {
  deleteFacetStorage,
  facetJournal,
  reservedFacetNames,
  type LoadedWorkerEntrypointStub,
} from '@nimbus-sh/fabric/workerd-facet-host.js';
import { drainProcessFsJournal, UNSETTLED_END_NOTE, type ProcessFsJournalSource } from '@nimbus-sh/core/_shared/process-fs-client.js';
import { journalDrainSession } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { ProcessJournals } from '../session/process-journals.js';
import {
  acquireDurableFacetSlot,
  freeDurableFacetSlot,
} from './durable-slots.js';
import {
  persistDurableWorkerImage,
  readStoredImages,
  resolveDurableWorkerImage,
  purgeDurableWorkerImages,
  rewriteWithoutEnvironment,
  unlinkDurableImages,
} from './durable-images.js';
import { legacyGeneratedImages } from './legacy-images.js';
import { deleteRecord, putRecord, relaunchEnv, type ProcessEnvKeeping, type ProcessEnvRequest, type ResolveProcessEnv } from './process-env.js';
import {
  SQLITE_WASM_MODULE_NAME,
  type OpencodeRunnerMode,
} from '../runtime/opencode-facet-runner.js';
import { parsePortFromArgv, resolveLongRunningPort } from '@nimbus-sh/core/runtime/long-running-handle.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { hostActivity, hostAdapterBytes } from '@nimbus-sh/fabric/host-activity.js';
import {
  DEFAULT_FACET_BUNDLE_PROFILE,
  type FacetBundleProfile,
} from '@nimbus-sh/core/runtime/bundle-profile.js';
import {
  CF_COMPAT_DATE,
  DEFAULT_HOME,
  GUEST_COMPAT_FLAGS,
  VFS_BUNDLE_MAX_FILES, VFS_BUNDLE_MAX_BYTES, CWD_SNAPSHOT_MAX_FILE_BYTES,
  BUNDLE_MAX_ENCODED_BYTES,
  PREFETCH_CACHE_MAX_BYTES,
  FS_LIST_PAGE_LIMIT,
  CHUNK_SIZE,
} from '@nimbus-sh/core/constants.js';
import { LEDGER_ROW_BYTES } from '@nimbus-sh/core/runtime/storage-ledger.js';
import { ONE_SHOT_STORE_MEMORY_BYTES, RESIDENT_CHUNK_BYTES } from '../vfs/facet-resident-limits.js';
import { residentCellCost } from '../vfs/resident/cell-cost.js';
import { MAX_RPC_SAFE_PAYLOAD_BYTES, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '@nimbus-sh/platform/limits.js';
import { CRED_KERNEL, isNativeBinPath, launchNamedPaths, requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  acquireSupervisorAllocation, acquireSupervisorCopyAllocation, readSupervisorAllocationBudget, tryAcquireSupervisorAllocation, tryAcquireSupervisorCopyAllocation,
  reclaimableSupervisorAllocation,
} from '@nimbus-sh/platform/heavy-alloc-coord.js';
import type { SupervisorAllocationLease, SupervisorAllocationOwner } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { streamedWasmImageDigest, type WasmImageRecord } from './wasm-image-digest.js';
import { wasmImageDigest } from './wasm-image-key.js';
import { nimbusDebugEnabled } from '../_shared/nimbus-debug.js';
import { attributeAllocation, setPrefetchCacheBytes } from '@nimbus-sh/platform/diag-counters.js';

/**
 * The filesystem a launch's module map is built from: the process's bound
 * supervisor bridge. Its probes and reads go through the resolver's one
 * adapter over it (requireFsOverBridge), made once per bridge.
 */
type LaunchFs = RuntimeFsBridge;
const launchAdapters = new WeakMap<LaunchFs, BridgeRequireFs>();

class PrefetchCreditGate {
  private used = 0;
  private readonly charged = new Map<string, number>();
  private refusal: ClosureBoundExceededError | undefined;
  constructor(private readonly limit: number, private readonly entry: string) {}

  charge(path: string, bytes: number, kind: 'file' | 'emit' = 'file'): void {
    this.check();
    const key = `${kind}\0${stripLeadingSlashes(path)}`;
    const previous = this.charged.get(key) ?? 0;
    const next = Math.max(previous, bytes);
    if (this.used + next - previous > this.limit) {
      this.refusal = new ClosureBoundExceededError({
        kind: 'closure-exceeds-bound', entry: this.entry, bytesSeen: this.used, bound: this.limit, lastPath: path,
      });
      throw this.refusal;
    }
    this.used += next - previous;
    this.charged.set(key, next);
  }

  // Optional-read catches may skip a failed file, but cannot clear a credit refusal.
  check(): void { if (this.refusal) throw this.refusal; }
}

/** A gather's own gate, never another reader's even when they share a bridge or adapter. */
const prefetchReadCredit = new AsyncLocalStorage<PrefetchCreditGate | undefined>();

/** The exact type of `entry` in `dir` on a launch's fs, lstat'ing it where its listing could not type it. */
function launchEntryType(vfs: LaunchFs, dir: string, entry: RuntimeVfsDirEntry): Promise<KnownDirentType | null> {
  return direntTypeOf(entry, () => vfs.stat(`${dir}/${entry.name}`, { followSymlinks: false }));
}
/** The declared-dependency walk's questions (stagedBindingsDeclaredBy), on a launch's fs. */
function declaredBindingFs(fs: LaunchFs): DeclaredBindingFs {
  const files = filesOf(fs);
  return {
    readText: async (path) => { const bytes = await files.readBytes(path); return bytes === null ? null : fileText(bytes); },
    exists: async (path) => await files.exists(path),
    realpath: async (path) => { try { return await fs.realpath(path); } catch { return null; } },
  };
}
/**
 * A launch's fs as a data plan reads it (DataPlanSource, but its listing):
 * keys without a leading slash, what a path holds following links, and a
 * directory's entries, a symlink's unfollowed.
 */
function planSourceOf(vfs: LaunchFs): Omit<DataPlanSource, 'list'> {
  return {
    readText: async (path) => {
      try { return await filesOf(vfs).readFileString(path); } catch { return null; }
    },
    linkTarget: (path) => linkTargetOf(vfs, path),
    stat: async (path) => {
      const st = await filesOf(vfs).stat(path).catch(() => null);
      return st && { kind: st.type, size: st.size };
    },
    readdir: async (dir) => {
      const entries = await Promise.resolve(vfs.readdir('/' + dir)).catch(() => null);
      if (entries === null) return null;
      const typed: DataPlanEntry[] = [];
      for (const entry of entries) {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
        const kind = await launchEntryType(vfs, '/' + dir, entry);
        if (kind === null) continue;
        const size = kind === 'file' ? (await filesOf(vfs).stat(path).catch(() => null))?.size ?? 0 : 0;
        typed.push({ path, kind, size });
      }
      return typed;
    },
  };
}
function filesOf(fs: LaunchFs): BridgeRequireFs {
  let files = launchAdapters.get(fs);
  if (files === undefined) {
    const base = requireFsOverBridge(fs);
    const readBytes = (path: string): Promise<Uint8Array | null> => {
      const credit = prefetchReadCredit.getStore();
      if (credit === undefined) return base.readBytes(path);
      return (async () => {
        credit.check();
        const stat = await base.stat(path).catch(() => null);
        if (stat !== null) credit.charge(path, stat.size);
        const bytes = await base.readBytes(path);
        if (bytes !== null) credit.charge(path, bytes.byteLength);
        return bytes;
      })();
    };
    files = { ...base, readBytes, readFileString: (path) => {
      if (prefetchReadCredit.getStore() === undefined) return base.readFileString(path);
      return readBytes(path).then((bytes) => {
        if (bytes === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return fileText(bytes);
      });
    } };
    launchAdapters.set(fs, files);
  }
  return files;
}

/**
 * What a launch names, which is where its process's listing walks the
 * mounts beyond SQLite (NimbusFilesystemAuthority.nameLaunch): its working
 * directory, its program and that program's directory, its arguments, the
 * files its module map holds, and the paths its code names statically.
 */
function* launchNames(
  cwd: string,
  program: string | undefined,
  argv: readonly string[],
  modules: readonly string[],
  refs: readonly StaticFsRefs[],
): Iterable<string> {
  const script = program !== undefined && program.startsWith('/') ? program : null;
  yield cwd;
  if (script !== null) yield script.slice(0, script.lastIndexOf('/')) || '/';
  yield* launchNamedPaths(cwd, script, argv);
  for (const path of modules) yield path;
  for (const found of refs) {
    for (const ref of found.exact) yield ref.path;
    for (const ref of found.cwdRelative) yield `${cwd}/${ref.path}`;
    yield* found.listed;
    for (const pattern of found.patterns) yield pattern.dir;
  }
}


/** A pipe or redirect's bytes, exactly as written, until it ends (null). */
export interface StdinBytes {
  readBytes(maxLength: number): Promise<Uint8Array | null>;
}

/** A process's stdin channel as a stopped run waits on it (FacetManagerHooks.stdinChannel). */
export interface StdinChannel {
  /** The next packet: input, the end, or (after `waitMs`) nothing. */
  read(waitMs: number): Promise<ProcessInputPacket>;
  /** Put packets taken from it back in front of it, in order. */
  unread(packets: readonly ProcessInputPacket[]): void;
}

/**
 * One run of a one-shot: what `exec` was asked, and for a run after a stop
 * (runtime/stop-replay.ts), what it replays of the run before and whether
 * its channel has ended, so it takes all of it before it starts.
 */
type ExecLaunchOpts = Parameters<FacetManager['exec']>[1] & {
  replay?: ReplayLaunch;
  stdinWhole?: boolean;
  /** The stdin a run after a stop is handed back, which it takes whole before it starts. */
  stdinAtLeast?: number;
  /** This run's stop nonce: a stop record counts only with it (stop-replay.ts stopRecordOf). */
  stopNonce?: string;
  /** Its first listen stops it, to be run again as a resident that serves (FacetManager._promote). */
  promote?: boolean;
  /** Its network goes through the session (SupervisorRPC as its globalOutbound). */
  outbound?: boolean;
  /**
   * A digest of the module map the first run loaded: a run after a stop
   * whose map differs (its code or data changed while it waited) does not run.
   */
  codeDigest?: { value: string | undefined };
};

/** A run after a stop would load another module map than the run before it. */
class ReplayCodeChanged extends Error {
  constructor() {
    super('its code, or a file it holds in its module map, changed while it waited');
  }
}

/** How a process stopped at a read of stdin runs again. */
type StoppedRunNext = Pick<ExecLaunchOpts, 'stdinWhole' | 'stdinFile' | 'stdinAtLeast'> & { replay: ReplayLaunch };

/** Result returned from a facet execution */
export interface FacetExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** It listened, and runs on as this resident (FacetManager._promote): no exit yet. */
  promotedPid?: number;
  /**
   * VFS paths whose content the process read synchronously and did not have.
   *
   * The facet cannot serve those reads and cannot recover from them, so the
   * only place the knowledge is useful is here: the next bundle built for the
   * same entry stages them, and the miss stops recurring. Reported on every
   * exec, not behind the diag flag — a residency repair that only happens
   * when debugging is switched on is not a repair.
   */
  residencyMisses?: string[];
  /**
   * Files the run tried to execute that its module map lacked: the next
   * launch's module map is built with them as roots (launch-learning-store.ts).
   */
  moduleMisses?: string[];
  /**
   * Code the run produced and could not compile (a file written then
   * required, a Function-constructor call), as its ledger reported it:
   * staged for the next launch of the same entry (commonjs-cell.ts, RUNTIME
   * CODE). Validated where it is recorded.
   */
  runtimeCode?: unknown[];
  /**
   * Exec telemetry, populated only when NIMBUS_DIAG_EXEC=1. drainPasses,
   * rpcWrites and fsRpcReads originate inside the facet (see
   * exec-telemetry.ts); the supervisor folds them with its own phase timings
   * before recording.
   */
  diag?: { drainPasses: number; rpcWrites: number; fsRpcReads: number; namespaceRefusals?: number; esmAdoptions?: number };
}

/**
 * execStagedArtifact owns the process-table entry, so it returns the
 * authoritative pid alongside the exec result. The shell caller emits the
 * terminal exit / exec-done events against this pid instead of recovering it
 * by string-matching the command line in the process table.
 */
export interface StagedArtifactExecResult extends FacetExecResult {
  pid: number;
  /** For the resident server path: the loopback port the facet is bound to. */
  port?: number;
}

/** A staged opencode process: its stage, and the env its start or run hands over in memory. */
interface StagedOpencode {
  pid: number;
  stageSpec: OpencodeStageSpec;
  env: Record<string, string>;
}

// ── Code generators ─────────────────────────────────────────────────────
//
// The node-compat layer's sources — the ~230 KiB shims, the VFS write ledger
// and the resident store — are staged as static assets
// (scripts/bundle-node-shims.mjs) and fetched once per isolate via
// fetchNodeFacetSources: they no longer live in the worker bundle (its size
// gate). The codegen functions take them as the `sources` parameter; the async
// exec/spawn callers await the memoized fetch.

interface LoadedWorkerStub {
  getEntrypoint(): LoadedWorkerEntrypointStub;
  getDurableObjectClass(name: string): unknown;
}

interface NimbusWorkerLoader {
  load(code: WorkerCode): LoadedWorkerStub;
  get(id: string, getCodeCallback: () => Promise<WorkerCode>): LoadedWorkerStub;
}

interface FacetManagerEnv {
  LOADER: NimbusWorkerLoader;
  /**
   * Static-assets binding, used by the node:sqlite path to fetch the
   * sql.js wasm bytes (sqlite-wasm-bytes.ts) and hand them to the facet
   * via the Worker Loader module map. Absent in env shapes that never
   * route node:sqlite (e.g. some test harnesses); the sqlite attach is a
   * no-op then and the shim surfaces a clear unattached-module error.
   */
  ASSETS?: { fetch(req: Request): Promise<Response> };
  /**
   * Verification knob: force a small resident-launch chunk bound so an
   * ordinary program crosses several turns. Unset in production, where the
   * default in `turn-budget.ts` applies.
   */
  NIMBUS_LAUNCH_CHUNK_BYTES?: string;

  /**
   * The bindings env verbatim — the directory binding the durable/public
   * port surface needs isn't a parsed field, and the helpers that reach it
   * take `env` themselves.
   */
  readonly rawEnv: unknown;
}

interface ProcessRpcResources {
  readonly resources: unknown[];
  readonly releaseOnReportExit: boolean;
}

/** How a process ended: the one record of its end (FacetManager._end). */
interface ProcessEnding {
  /** Its exit status. */
  code: number;
  /**
   * Why, when it did not end by its own exit (a signal, a kill, a lost host,
   * a launch or boot that failed): marked on the table, recorded, and told
   * to the host (onExternalExit). Its resources go at once.
   */
  cause?: string;
  /** Ended by a kill: the table records it killed, and its terminator runs. */
  killed?: boolean;
  /** A kill's: what the work held for it is stopped with (SessionProcessSupervisor.kill). */
  reason?: SignalAbortReason;
  /** What a request to one of its ports is told from now on (PortRegistry.ended). */
  portEnding?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNimbusWorkerLoader(value: unknown): value is NimbusWorkerLoader {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof Reflect.get(value, 'load') === 'function' && typeof Reflect.get(value, 'get') === 'function';
}

function parseFacetManagerEnv(env: unknown): FacetManagerEnv {
  const loader = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'LOADER')
    : undefined;
  if (!isNimbusWorkerLoader(loader)) {
    throw new Error('FacetManager requires an env.LOADER binding with load() and get()');
  }
  const assetsCandidate = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'ASSETS')
    : undefined;
  const assets =
    assetsCandidate !== null &&
    typeof assetsCandidate === 'object' &&
    typeof Reflect.get(assetsCandidate, 'fetch') === 'function'
      ? (assetsCandidate as { fetch(req: Request): Promise<Response> })
      : undefined;
  const chunkBytes = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'NIMBUS_LAUNCH_CHUNK_BYTES')
    : undefined;
  return {
    LOADER: loader,
    ASSETS: assets,
    NIMBUS_LAUNCH_CHUNK_BYTES: typeof chunkBytes === 'string' ? chunkBytes : undefined,
    rawEnv: env,
  };
}


/**
 * How long a RESIDENT facet settles its startup before answering its boot
 * call. It keeps running afterwards, so this is not a lifetime decision: the
 * budget only has to cover the entrypoint's own startup chain (binding a
 * port, first render). `spawnNode` awaits the boot, so a server's idle
 * keep-alive timer must not be allowed to hold the shell's prompt.
 */
export const RESIDENT_BOOT_SETTLE_MS = 1000;

/**
 * The event loop a generated entrypoint runs on.
 *
 * Node exits when its loop has no live HANDLES left — timers, sockets,
 * servers, requests in flight. A promise is not a handle: a program whose
 * last act leaves `new Promise(() => {})` unsettled prints its output and
 * exits 0. Counting unsettled promises as work was a real divergence from
 * that — such a program's drain used to end early and it was
 * reported as having not finished. A user-invoked program runs this loop
 * with NO deadline — Node itself has no wall-clock kill; the only endings
 * are the program's exit and a signal. Callers that still pass a finite
 * deadline (the resident boot settle) arm the expiry timer.
 *
 * Four kinds of handle, each owned by the shim that creates them:
 *
 *   - macrotask TIMERS and intervals (`__nimbusPendingTimers`), from the
 *     timer tracker below.
 *   - ASYNC OPERATIONS in flight (`__nimbusPendingOps`): a fetch, a response
 *     body read, an fs/child_process RPC. `await` resolves through
 *     PerformPromiseThen and surfaces nowhere else, so this counter is how
 *     awaited work is seen at all. See the shim's __nimbusTrackOp.
 *   - listening SERVERS (`__portRegistry`), open until the program closes
 *     them.
 *   - held CONNECTIONS (`__nimbusOpenSockets`): an HTTP exchange a server is
 *     answering, a WebSocket client, a tls.connect socket, until it closes
 *     (or is unref'd). Not startup work: a resident's boot does not wait on
 *     them.
 *
 * The loop subscribes to the exit promise ONCE — a per-pass
 * `exitPromise.then()` allocates a promise every iteration — and yields
 * through the raw setTimeout so its own ticks don't inflate the timer count
 * it watches.
 */
export const ENTRYPOINT_EVENT_LOOP = `
// Its deadlines are Nimbus's own reads of the clock (REAL_NOW_SOURCE).
const __nimbusLoopNow = ${REAL_NOW_SOURCE};
function __nimbusHandleCount(__name) {
  const __value = globalThis[__name];
  return typeof __value === "number" ? __value : 0;
}

// Binding a native listen(0) first awaits session-wide allocation. Until it
// binds, it is a referenced handle just like the eventual server; unref and
// close still remove its contribution. It is also startup work to settle.
function __nimbusPendingHttpListens() {
  let count = 0;
  const listeners = globalThis.__nimbusPendingHttpListeners;
  if (listeners) for (const server of listeners) if (!server.__nimbusUnrefed) count++;
  return count;
}

function __nimbusPendingStartupWork() {
  return __nimbusHandleCount("__nimbusPendingTimers") + __nimbusHandleCount("__nimbusPendingOps") + __nimbusPendingHttpListens();
}

// The above, plus the handles a program holds open on purpose. A bound port
// keeps a Node process alive, and it keeps a one-shot facet alive too.
function __nimbusLiveHandles() {
  const __servers = globalThis.__portRegistry;
  let __bound = 0;
  if (__servers && typeof __servers.values === "function") {
    for (const __server of __servers.values()) if (!__server?.__nimbusUnrefed) __bound++;
  }
  return __nimbusPendingStartupWork() + __bound + __nimbusHandleCount("__nimbusInputHandles")
    + __nimbusHandleCount("__nimbusOpenSockets");
}

async function __nimbusRunEventLoop(__countHandles, __exitPromise, __deadlineMs, __minPasses, __onPass) {
  let __exited = false;
  if (__exitPromise && typeof __exitPromise.then === "function") {
    __exitPromise.then(() => { __exited = true; }, () => { __exited = true; });
  }
  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
    ? globalThis.__nimbusRawSetTimeout
    : globalThis.setTimeout;
  const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === "function")
    ? globalThis.__nimbusRawClearTimeout
    : globalThis.clearTimeout;
  let __expired = false;
  let __pass = 0;
  // A user-invoked program runs until it exits or is killed — there is no
  // wall-clock deadline, so no expiry timer is armed at all. (Callers that
  // still pass a finite deadline get the timer for compatibility.)
  const __deadline = Number.isFinite(__deadlineMs)
    ? __rawSetTimeout(() => { __expired = true; }, __deadlineMs)
    : null;
  while (!__exited && !__expired && (__pass < __minPasses || __countHandles() > 0)) {
    // The warm-up passes give a settling microtask chain its turns and cost
    // ~5µs each; past them the loop is waiting on wall-clock work, where
    // spinning at 0ms would burn the isolate's CPU indefinitely.
    await new Promise((resolve) => __rawSetTimeout(resolve, __pass < __minPasses ? 0 : 1));
    __pass++;
    if (__onPass) __onPass();
  }
  if (__deadline !== null) { try { __rawClearTimeout(__deadline); } catch {} }
  // \`pending\` is what the caller reports when it gives up: a one-shot program
  // still holding a handle did NOT finish, and exiting 0 would claim it did.
  return { passes: __pass, pending: __exited ? 0 : __countHandles() };
}

// Whether the program's only remaining work is waiting on its children (the
// polls for their output and exit, __nimbusChildOps): no timer, socket,
// server, stdin read or fetch of its own. Said to the session when it
// changes (node-shims __nimbusReportBlocked), whose Dynamic Worker ledger
// refuses a child's launch only when every worker is held by a process in
// this state (fabric setProcessBlocked).
function __nimbusReportBlockedState() {
  const __children = __nimbusHandleCount("__nimbusChildOps");
  const __blocked = __children > 0 && __nimbusLiveHandles() === __children;
  if (typeof globalThis.__nimbusReportBlocked === "function") globalThis.__nimbusReportBlocked(__blocked);
}

// A one-shot facet's lifetime IS the loop: it runs the program until Node
// would exit, or until the lifetime budget runs out. One loop from the
// start, with the entry's evaluation (top-level await) counted as a handle
// while it is pending, so the program's state is reported throughout: a
// module whose top-level await waits on a child's close is blocked on that
// child as much as a callback would be. Once the evaluation settles, the
// loop gives a settling chain its warm-up turns again; a rejected
// evaluation is uncaught as it rejects.
async function __nimbusRunEntrypointToExit(__entryResult, __deadlineMs, __beforeExit) {
  let __evaluating = Boolean(__entryResult) && typeof __entryResult.then === "function";
  let __grace = 0;
  if (__evaluating) {
    // A rejected evaluation is uncaught as it happens, as Node's loader
    // rejects: the program ends there, or its handler takes it.
    __entryResult.then(
      () => { __evaluating = false; __grace = 4; },
      (error) => { __evaluating = false; __nimbusUncaughtException(error, true); },
    );
  }
  const __count = () => {
    if (__evaluating) return 1 + __nimbusLiveHandles();
    if (__grace > 0) { __grace--; return 1 + __nimbusLiveHandles(); }
    return __nimbusLiveHandles();
  };
  if (!__beforeExit) return await __nimbusRunEventLoop(__count, __nimbusProcessExitPromise, __deadlineMs, 4, __nimbusReportBlockedState);
  const __limited = Number.isFinite(__deadlineMs);
  const __startedAt = __limited ? __nimbusLoopNow() : 0;
  for (;;) {
    const __remaining = __limited ? Math.max(0, __deadlineMs - (__nimbusLoopNow() - __startedAt)) : __deadlineMs;
    const __drained = await __nimbusRunEventLoop(__count, __nimbusProcessExitPromise, __remaining, 4, __nimbusReportBlockedState);
    if (__drained.pending || !await __beforeExit()) return __drained;
  }
}

async function __nimbusBeforeExitHasWork() {
  if (__nimbusProgramStopped || !__processMod.listenerCount("beforeExit")) return false;
  const __rawSetTimeout = globalThis.__nimbusRawSetTimeout || globalThis.setTimeout;
  // Already-returned writes still publish, but are not new Node work.
  const __nodeHandles = () => Math.max(0, __nimbusLiveHandles() - __nimbusHandleCount("__nimbusAcknowledgedVfsOps"));
  for (;;) {
    try { __processMod.emit("beforeExit", __processMod.exitCode || 0); }
    catch (error) { __nimbusUncaughtException(error, false); }
    let __continued = __nodeHandles() > 0;
    for (let __pass = 0; __pass < 4; __pass++) {
      await new Promise((resolve) => __rawSetTimeout(resolve, 0));
      __continued ||= __nodeHandles() > 0;
    }
    if (__nimbusProgramStopped) return false;
    if (__continued && __nimbusLiveHandles() > 0) return true;
    if (!__continued) {
      await __nimbusRunEventLoop(__nimbusLiveHandles, __nimbusProcessExitPromise, Infinity, 0);
      return false;
    }
  }
}

// Whether the program holds no live handle once a settling chain has had the
// same four turns the one-shot loop gives it.
async function __nimbusHoldsNoHandle() {
  const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
    ? globalThis.__nimbusRawSetTimeout
    : globalThis.setTimeout;
  for (let __pass = 0; __pass < 4; __pass++) await new Promise((resolve) => __rawSetTimeout(resolve, 0));
  return __nimbusLiveHandles() === 0;
}

// A resident process ends as Node's does: when it holds no live handle. It
// may serve for hours, so this does not poll: every place a handle is released
// (a timer firing or cleared, an operation settling, a server closed or
// unref'd, stdin let go) calls __nimbusHandleReleased, and a release that
// leaves none is the program's natural end.
function __nimbusNaturalExit(__beforeExit) {
  return new Promise((resolve) => {
    let __checking = false;
    const __released = () => {
      if (__checking) return;
      __checking = true;
      __nimbusHoldsNoHandle().then(async (__none) => {
        if (__none && __beforeExit && await __beforeExit()) __none = false;
        __checking = false;
        if (!__none) return;
        if (globalThis.__nimbusHandleReleased === __released) globalThis.__nimbusHandleReleased = undefined;
        resolve();
      }).catch((error) => {
        __checking = false;
        __nimbusUncaughtException(error, false);
        if (__nimbusProgramStopped) {
          if (globalThis.__nimbusHandleReleased === __released) globalThis.__nimbusHandleReleased = undefined;
          resolve();
        } else __released();
      });
    };
    globalThis.__nimbusHandleReleased = __released;
    __released();
  });
}

// A resident facet keeps running after the call that boots it returns, so it
// settles startup and nothing more. The handles it holds open deliberately —
// its listening port — are the point of it, not a reason to make the shell's
// prompt wait. Its module's own evaluation is bounded by the same budget: a
// server entry that ends in a top-level await which never settles
// (\`await new Promise(() => {})\`, a dev server awaiting a listen that fails)
// is a running program in Node, and waiting on it here left the boot call —
// and every request routed to the facet, which waits for boot — hung
// forever. A rejection after the budget fails the process as Node's does.
async function __nimbusSettleEntrypointStartup(__entryResult, __deadlineMs) {
  const __startedAt = __nimbusLoopNow();
  if (__entryResult && typeof __entryResult.then === "function") {
    const __rawSetTimeout = (typeof globalThis.__nimbusRawSetTimeout === "function")
      ? globalThis.__nimbusRawSetTimeout
      : globalThis.setTimeout;
    const __rawClearTimeout = (typeof globalThis.__nimbusRawClearTimeout === "function")
      ? globalThis.__nimbusRawClearTimeout
      : globalThis.clearTimeout;
    const __exit = {};
    const __late = {};
    let __timer = null;
    // Its rejection is uncaught when it lands, during the budget or after it.
    const __settled = __entryResult.then(() => null, (__error) => { __nimbusUncaughtException(__error, true); return null; });
    const __raced = await Promise.race([
      __settled,
      __nimbusProcessExitPromise.then(() => __exit, () => __exit),
      new Promise((resolve) => { __timer = __rawSetTimeout(() => resolve(__late), __deadlineMs); }),
    ]).finally(() => { try { __rawClearTimeout(__timer); } catch {} });
    if (__raced === __exit) return { passes: 0, pending: 0 };
    if (__raced === __late) {
      return { passes: 0, pending: __nimbusPendingStartupWork() };
    }
  }
  return await __nimbusRunEventLoop(
    __nimbusPendingStartupWork, __nimbusProcessExitPromise,
    Math.max(0, __deadlineMs - (__nimbusLoopNow() - __startedAt)), 4,
  );
}
`;

/**
 * Patch the global timer functions so the startup drain can tell when
 * macrotask work is still in flight. A timer, interval or immediate is a live
 * handle until it fires (an interval until it is cleared), as in Node, and
 * holds the process open while it is referenced: unref() lets the program
 * end without it and ref() holds it again. Without this the drain, which
 * only follows promise chains, abandons sequential awaited timer work and the
 * facet exits before timer-driven CLIs (create-astro, nuxi) finish
 * scaffolding.
 */
const ENTRYPOINT_TIMER_TRACKER = `
(function(g){
  if (g.__nimbusTimerTrackerInstalled) return;
  g.__nimbusTimerTrackerInstalled = true; g.__nimbusPendingTimers = 0;
  const st = g.setTimeout, ct = g.clearTimeout, si = g.setInterval, ci = g.clearInterval, sim = g.setImmediate, cim = g.clearImmediate;
  if (typeof st !== "function") return;
  g.__nimbusRawSetTimeout = st;
  g.__nimbusRawClearTimeout = ct;
  // Each live handle: the call that clears it, and whether it holds the process.
  // A SafeMap (the launch's captures): a timer's firing releases it, after the program may have replaced Map's methods.
  const live = new __nimbusLaunchCaptures.SafeMap();
  const drop = () => { g.__nimbusPendingTimers--; g.__nimbusHandleReleased?.(); };
  const release = (id) => {
    const entry = live.get(id);
    if (entry === undefined) return;
    live.delete(id);
    if (entry.held) drop();
  };
  // The platform's handle classes, their ref() and unref() made to count.
  const patched = new WeakSet();
  const patch = (handle) => {
    const proto = Object.getPrototypeOf(handle);
    if (proto === null || patched.has(proto)) return;
    patched.add(proto);
    const { ref, unref } = proto;
    const counted = {
      unref() {
        const entry = live.get(this);
        if (entry?.held) { entry.held = false; drop(); }
        return Reflect.apply(unref, this, arguments);
      },
      ref() {
        const entry = live.get(this);
        if (entry !== undefined && !entry.held) { entry.held = true; g.__nimbusPendingTimers++; }
        return Reflect.apply(ref, this, arguments);
      },
    };
    if (typeof unref === "function") proto.unref = counted.unref;
    if (typeof ref === "function") proto.ref = counted.ref;
  };
  const hold = (id, clear) => {
    live.set(id, { clear, held: true });
    g.__nimbusPendingTimers++;
    if (id !== null && typeof id === "object") patch(id);
    return id;
  };
  g.setTimeout = function(fn, ms, ...a){
    if (typeof fn !== "function") return st(fn, ms, ...a);
    // Counted once the timer exists: a delay the platform refuses throws, and
    // a caught throw leaves no timer to wait for.
    const id = st(function(){ release(id); return fn.apply(this, arguments); }, ms, ...a);
    return hold(id, ct);
  };
  g.clearTimeout = function(id){ release(id); return ct(id); };
  if (typeof si === "function") {
    g.setInterval = function(fn, ms, ...a){ return hold(si(fn, ms, ...a), ci); };
    g.clearInterval = function(id){ release(id); return ci(id); };
  }
  if (typeof sim === "function") {
    g.setImmediate = function(fn, ...a){
      if (typeof fn !== "function") return sim(fn, ...a);
      const id = sim(function(){ release(id); return fn.apply(this, arguments); }, ...a);
      return hold(id, cim);
    };
    g.clearImmediate = function(id){ release(id); return cim(id); };
  }
  // process.exit: the program's pending timers, intervals and immediates never fire again.
  g.__nimbusStopProgramTimers = function(){
    for (const [id, entry] of live) entry.clear(id);
    live.clear();
    g.__nimbusPendingTimers = 0;
  };
})(globalThis);
`;

/**
 * The report a program owes when it finishes on an unanswered read.
 *
 * A facet has no synchronous I/O primitive, so a sync read of content that
 * was never staged into the process raises EAGAIN — honest, but a code no
 * program branches on, because it cannot arise from a POSIX regular file.
 * Whatever catch block receives it was written for a missing file, so the
 * reader proceeds on the answer it prepared for that. The result looks like
 * success and is not.
 *
 * So a run that ends with entries still in the shim's residency ledger is
 * failed here, and the files are named. Silence is the one outcome that must
 * not be available: the miss is either repaired (the next bundle stages what
 * the supervisor learned from the same ledger) or it is loud.
 *
 * Both generators call it — a one-shot exec folds it into its envelope, a
 * resident process into its final exit report — because a program's exit is
 * the only place that knows whether a miss was ever answered.
 */
const RESIDENCY_MISS_REPORT = `
// What the next launch of this entry must stage, kept apart because they are
// staged differently: files read synchronously and not answered (data), and
// modules the program tried to execute that the map lacked (graph roots).
function __nimbusDataReadMisses() {
  return [...(globalThis.__nimbusVfsResidencyMisses || [])];
}
function __nimbusExecutedModuleMisses() {
  return [...(globalThis.__nimbusModuleMisses || [])];
}
const { residencyMissReport: __nimbusResidencyMissText } = ${RESIDENCY_MISS_REPORT_SOURCE};
function __nimbusResidencyMissReport() {
  return __nimbusResidencyMissText(__nimbusDataReadMisses());
}
`;


/**
 * Detect whether a facet bundle imports node:sqlite. When true, the
 * supervisor attaches the sql.js WebAssembly.Module to the facet's Worker
 * Loader module map (request-time WebAssembly.compile is blocked) and the
 * generated facet code statically imports it + prepares the glue factory
 * at module init; the engine itself boots lazily and synchronously on the
 * first DatabaseSync open (sqlite-shim.ts __getSQL).
 *
 * Matches `require("node:sqlite")` / `require("sqlite")` (CJS, the
 * resolver strips the node: prefix) and `from "node:sqlite"` (ESM). The
 * scan covers the entry code plus every JS/CJS source already in the
 * prefetch bundle so a transitive dependency that pulls in node:sqlite is
 * also caught.
 */
const NODE_SQLITE_IMPORT_RE =
  /(?:require\s*\(\s*['"](?:node:)?sqlite['"]\s*\)|from\s+['"]node:sqlite['"]|import\s+['"]node:sqlite['"])/;

function bundleUsesNodeSqlite(
  entryCode: string,
  bundle: FacetVfsBundle,
): boolean {
  if (NODE_SQLITE_IMPORT_RE.test(entryCode)) return true;
  for (const [path, cell] of Object.entries(bundle)) {
    if (typeof cell !== 'string') continue;
    if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))) continue;
    if (NODE_SQLITE_IMPORT_RE.test(cell)) return true;
  }
  return false;
}

/**
 * The most manifest text a one-shot's copies carry (_installedManifests), and
 * the session keeps of them; past it the process fetches the rest as it
 * fetches any planned file.
 */
const MANIFEST_COPIES_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The directory the kernel keeps its stores below (facet images, inline wasm,
 * staged bindings, durable images). `/` is root's 0755, so no user can make,
 * rename or remove a name in it: below a `/.nimbus` that is the kernel's own
 * real directory, which no one else may write, no directory on the way to a
 * store is one a user could replace with a link (_kernelStoreFor).
 */


/** Where inlined wasm images are staged, one kernel-owned file per content key. */
const INLINE_WASM_DIR = `${KERNEL_STORE_ROOT}/inline-wasm`;

/**
 * A base64 string literal whose first bytes are wasm's `\0asm` magic
 * (`AGFzbQ`), long enough to be a module. Quotes bound the match, so the scan
 * reads what wasm IS and matches no call shape.
 */
const INLINE_WASM_LITERAL_RE = /["'`](AGFzbQ[A-Za-z0-9+/]{58,}={0,2})["'`]/g;

/**
 * A numeric array literal that starts with wasm's magic and version,
 * `[0,97,115,109,1,0,0,0,…]`: how xxhash-wasm (Astro's content hashing) and
 * other small modules inline their image, as `new Uint8Array([…])`.
 */
const INLINE_WASM_ARRAY_RE = /\[\s*0\s*,\s*97\s*,\s*115\s*,\s*109\s*,\s*1\s*,\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*\d{1,3}\s*)+\]/g;

/** Wasm magic (`\0asm`) and version 1. */
function isWasmImage(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
    && bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0;
}

/**
 * Every wasm image a closure's JavaScript inlines, as a base64 string or as a
 * numeric array literal, deduplicated by content. Vite 8 compiles
 * es-module-lexer's parser from base64 at module top level
 * (`WebAssembly.compile(C())`), and xxhash-wasm instantiates a
 * `new Uint8Array([0,97,115,109,…])`; from a facet cell that is request
 * time, where the runtime refuses to compile from bytes, so the image has to
 * ride in the module map and be answered by content (the node-shims seam's
 * by-digest registry).
 */
export function findInlineWasmImages(bundle: FacetVfsBundle): Uint8Array[] {
  const found = new Map<string, Uint8Array>();
  const keep = (bytes: Uint8Array) => {
    // A staged image is compiled with the map when the launch loads, so one
    // this runtime cannot compile fails the whole launch, where the program
    // meets it only if it compiles it: wasm-feature-detect inlines a module
    // per proposal it probes and catches each CompileError.
    if (!isWasmImage(bytes) || !WebAssembly.validate(bytes)) return;
    const digest = wasmImageDigest(bytes);
    if (!found.has(digest)) found.set(digest, bytes);
  };
  for (const [path, cell] of Object.entries(bundle)) {
    if (typeof cell !== 'string') continue;
    if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))) continue;
    if (cell.includes('AGFzbQ')) {
      for (const match of cell.matchAll(INLINE_WASM_LITERAL_RE)) {
        try {
          keep(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
        } catch {
          // Not base64 after all: not an image.
        }
      }
    }
    if (/97\s*,\s*115\s*,\s*109/.test(cell)) {
      for (const match of cell.matchAll(INLINE_WASM_ARRAY_RE)) {
        const values = match[0].slice(1, -1).split(',').map(Number);
        if (values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) keep(Uint8Array.from(values));
      }
    }
  }
  return [...found.values()];
}

/**
 * Module-init block prepended to facet code only when the bundle uses
 * node:sqlite. Two parts, both at module-eval time (where workerd permits
 * `new Function` and module imports):
 *   1. Static import of the pre-compiled sql.js WebAssembly.Module from
 *      the facet module map, parked on globalThis for the shim's boot.
 *   2. The sql.js glue-factory preamble (new Function at startup — request
 *      time codegen-from-strings is blocked).
 * Omitted otherwise (the import would fail — no sqlite.wasm in the map).
 */
const SQLITE_FACET_IMPORT =
  `import __nimbusSqliteWasmModule from "${SQLITE_WASM_MODULE_NAME}";\n` +
  `globalThis.__nimbusSqliteWasmModule = __nimbusSqliteWasmModule;\n` +
  generateSqliteFacetPreamble();

/**
 * A generated facet's module map: its main module, the side modules the VFS
 * bundle's data was partitioned across, and the `{ cjs }` modules of the
 * process's code — every cell of its closure and its entry
 * (core/_shared/commonjs-cell.ts).
 */
interface GeneratedNodeFacetCode {
  code: string;
  source: ModuleSource;
  immutableModules: Record<string, ImmutableModuleSource>;
  modules: Record<string, string>;
  codeModules: Record<string, string>;
  /** The staged ES modules and their facades, as `{ js }` module texts (FacetVfsBundleSource.esModules). */
  esModules: Record<string, string>;
}

interface PreparedOneShotCode {
  code(): Promise<OneShotCodeSpec>;
  discard(): void;
  digest?: string;
}

class OneShotAllocationNeeded extends Error {
  constructor(readonly bytes: number) {
    super(`Nimbus: the one-shot map needs ${bytes} bytes of supervisor credit`);
  }
}

/**
 * The URL an entry's import() resolves against and its `Function` carries:
 * the script's own, as Node names it (`-e` code is `<cwd>/[eval]`, stdin
 * `<cwd>/[stdin]`).
 */
export function entryImporterUrl(filename: string | undefined, cwd: string): string {
  const base = cwd.replace(/\/+$/, '') || '/';
  const path = filename === undefined || filename === '<eval>'
    ? `${base}/[eval]`
    : filename === '[stdin]' ? `${base}/[stdin]` : filename;
  return moduleImporterUrl(path);
}

/** The VFS key a launch stages an ES module entry at: its file, or `[eval1]` in the working directory for `-e` and stdin code. */
export function entryEsModuleKey(filename: string | undefined, cwd: string): string {
  const evaluated = filename === undefined || filename === '<eval>' || filename === '[stdin]';
  return stripLeadingSlashes(evaluated ? `${cwd.replace(/\/+$/, '')}/[eval1]` : filename);
}

/**
 * The entry as the runner evaluates it. An ES module (`esModule`,
 * RuntimeRunOpts), or TypeScript or JSX the launch compiled to one, is the
 * map's staged module at its key (entryEsModuleKey), imported: an ES entry's
 * evaluation is its job, and what escapes it is explained as Node's loader
 * explains it. Anything else is CommonJS code as a module of the map, named
 * for the script it came from so its stack frames carry that path (`-e` code
 * is `[eval]`), its scope read off the code itself (declaresWrapperBinding),
 * its `Function` carrying `importer` (entryImporterUrl).
 */
function entryModule(
  userCode: string, filename: string | undefined, cwd: string, esModule: boolean | undefined, bundleSource: FacetVfsBundleSource,
  preamble?: string, check = false,
): { name: string; esModule: boolean; modules: Record<string, string>; evaluate: string; stackEntry: string } {
  const entry = programEntry(userCode, filename, cwd, esModule, bundleSource, check);
  if (preamble === undefined) return entry;
  // The preamble, a module of its own, then the entry: `(preamble, entry)`.
  const name = commonJsEntryModuleName('[preamble]');
  const importer = entryImporterUrl(filename, cwd);
  return {
    ...entry,
    modules: { ...entry.modules, [name]: wrapCommonJsCell(preamble).text },
    evaluate: `(__nimbusEntryWrapper(${JSON.stringify(name)}, ${JSON.stringify(importer)})({}, __nimbusMakeRequire(mod), mod, filename || "/home/user/script.js", dirname || "/home/user"), ${entry.evaluate})`,
  };
}

/** `node -c`'s entry cell begins with this, on the wrapper's line: its compile succeeds, and nothing of it runs. */
const CHECKED_HEAD = `throw ${JSON.stringify(ENTRY_CHECKED)};`;

function programEntry(
  userCode: string, filename: string | undefined, cwd: string, esModule: boolean | undefined, bundleSource: FacetVfsBundleSource,
  check: boolean,
): { name: string; esModule: boolean; modules: Record<string, string>; evaluate: string; stackEntry: string } {
  const key = entryEsModuleKey(filename, cwd);
  const cell = commonJsCellModuleName(key);
  const importer = entryImporterUrl(filename, cwd);
  if (esModule === true && bundleSource.esModules[cell] !== undefined) {
    return { name: '', esModule: true, modules: {}, evaluate: `__nimbusEsmRunEntry(${JSON.stringify(key)})`, stackEntry: 'null' };
  }
  // TypeScript or JSX the launch compiled to CommonJS (or the diagnostic of
  // one it could not): its cell, whose frames are its file's.
  if (esModule === true && bundleSource.codeModules[cell] !== undefined) {
    const path = JSON.stringify('/' + key);
    return {
      name: cell, esModule: false, modules: {}, stackEntry: 'null',
      evaluate: `__nimbusEvaluateEntry(() => __nimbusEntryWrapper(${JSON.stringify(cell)}, ${JSON.stringify(importer)}), mod, ${path}, dirname || "/home/user")`,
    };
  }
  const code = rewriteProvidedCommonJsModules(userCode);
  const name = commonJsEntryModuleName(filename || '[eval]');
  const path = 'filename || "/home/user/script.js"';
  // -c compiles a function body, as Node's wrapSafe does, whatever it declares.
  const body = wrapCommonJsCell(code, !check && declaresWrapperBinding(code) ? 'block' : 'function');
  // -c: the cell stops at its first statement, so not even text of the
  // program's that closes the wrapper runs (node-shims __nimbusEvaluateEntry).
  const wrapped = check ? { ...body, text: CHECKED_HEAD + body.text, head: CHECKED_HEAD.length + body.head } : body;
  return {
    name,
    esModule: false,
    modules: { [name]: wrapped.text },
    evaluate: `__nimbusEvaluateEntry(() => __nimbusEntryWrapper(${JSON.stringify(name)}, ${JSON.stringify(importer)}), mod, ${path}, dirname || "/home/user")`,
    // commonjs-cell.ts __NIMBUS_STACK_ENTRY: how its frames are named.
    stackEntry: JSON.stringify([name, entryFrameFile(filename), wrapped.head, 0, wrapped.tail]),
  };
}

/** What Node's stack names a CommonJS entry's file: its path; -e and stdin are [eval] and [stdin]. */
function entryFrameFile(filename: string | undefined): string {
  if (filename === undefined || filename === '<eval>') return '[eval]';
  return filename;
}

/**
 * A node program's module head, the same for both lifetimes: its imports,
 * the SUPERVISOR's answering and the stop's replay, and its code cells.
 */
function nodeProgramModule(
  bundleSource: FacetVfsBundleSource,
  runtime: ReturnType<typeof createNodeFacetRuntime>,
  usesSqlite: boolean,
  stagedBindings: FacetVfsState['stagedBindings'],
  wasmImports: readonly FacetWasmImport[],
): ModuleSource {
  return moduleSource`
${bundleSource.imports}
${NODE_SHIMS_IMPORTS}
${runtime.imports}
${usesSqlite ? SQLITE_FACET_IMPORT : ''}
${stagedBindingsFacetImport(stagedBindings)}
${facetWasmImportsSource(wasmImports)}
${bundleSource.esm === 'null' ? '' : `import { host as __nimbusEsmHost } from ${JSON.stringify('./' + ESM_HOST_MODULE)};`}
const __NimbusHostResponse = globalThis.Response;
// The SUPERVISOR binding's filesystem calls answer a refusal as a value
// (core vfs-supervisor.ts answeringSupervisor).
${SUPERVISOR_ANSWERING_SRC}
// A synchronous read of stdin that has to wait stops the run with the
// isolate's ctx.abort; the run is run again once the input is there
// (runtime/stop-replay.ts).
${STOP_REPLAY_SOURCE}

// The process's code: a module per cell, compiled when first required. The
// only other way a string becomes code in a Worker is \`new Function\` at
// module evaluation, which compiled the whole closure before the program ran.
${runtime.code}

// These getters retain only identity, not a run's filesystem and shims.
function __nimbusInstallNodeNavigator(__version) {
  let __languages;
  const __languageList = () => __languages ??= Object.freeze([new Intl.DateTimeFormat().resolvedOptions().locale]);
  Object.defineProperties(globalThis.navigator, {
    userAgent: { get: () => 'Node.js/' + __version.slice(1).split('.')[0], enumerable: true, configurable: true },
    platform: { get: () => 'Linux x86_64', enumerable: true, configurable: true },
    language: { get: () => __languageList()[0], enumerable: true, configurable: true },
    languages: { get: __languageList, enumerable: true, configurable: true },
  });
}
`;
}

/**
 * A node program's runtime once its store has booted, the same for both
 * lifetimes: its output relayed to the SUPERVISOR, the shims, the event loop
 * and the globals, up to its entry module (`mod`).
 */
function nodeProgramRuntime(sources: NodeFacetSources, esModule: boolean): ModuleSource {
  return moduleSource`
    const __vfsBundle = __resident.bundle;
${PENDING_IO_SOURCE}
    let __rpcDrops = 0;
    let __rpcDropBytes = 0;
    let __rpcLastError = "";
    const __onRpcDrop = (bytes, e) => {
      __rpcDrops++;
      __rpcDropBytes += bytes | 0;
      if (e) __rpcLastError = (e && e.message) || String(e);
    };
    let __rpcWriteChain = Promise.resolve();
    let __rpcWriteCount = 0;
    // The output's own ledger, beside the registry (PENDING_IO_SOURCE): its
    // batches go in order, so the chain's tail is answered once every batch
    // before it is. A drain waits for the tail while one is outstanding.
    let __rpcWritesOutstanding = 0;
    const __rpcWriteSettled = () => { __rpcWritesOutstanding--; };
    const __outputPending = () => (__rpcWritesOutstanding === 0 ? null : __rpcWriteChain);
    // The batch writes still join: queued, its turn in the chain not yet come.
    let __rpcOpenBatch = null;
    const __RPC_BATCH_BYTES = 64 * 1024;
    // The relay carries bytes (see "Process output is bytes" in the shims).
    // Each chunk goes with its offset in what this run printed and the run's
    // number: what a replay prints again of the stopped run's output is
    // checked and dropped here, and a chunk the session has not acknowledged
    // when the run stops rides the stop (runtime/stop-replay.ts).
    //
    // A write made while the call before it is on its way joins the batch
    // queued behind that call, while it is the same stream of the same run,
    // carries on from the batch's last byte, and keeps it within
    // __RPC_BATCH_BYTES: one call for what a loop prints between two of
    // them, not one round trip a line. The batch is sealed when its turn
    // comes, and sent from its first chunk's offset once its last write's
    // gate is released (gates release in order). Each write is answered as
    // its batch is, so its callback, its stream's 'drain' and a drain's wait
    // for the output ledger mean what they did.
    const __queueRpcWrite = (method, bytes) => {
      const __chunk = __nimbusStopReplay.write(method, bytes);
      if (__chunk === null) return;
      // Released at the filesystem client's gate, taken now: once every
      // change logged ahead of it is answered (ProcessFsClient.effect).
      const __gate = __nimbusOutputGate();
      const __size = __chunk.b.byteLength;
      const __open = __rpcOpenBatch;
      if (__open !== null && __open.method === method && __open.run === __chunk.run
        && (__chunk.at === undefined || __open.end === __chunk.at) && __open.size + __size <= __RPC_BATCH_BYTES) {
        __open.chunks.push(__chunk);
        __open.size += __size;
        if (__chunk.at !== undefined) __open.end = __chunk.at + __size;
        if (__gate !== null) __open.gate = __gate;
        return __open.task;
      }
      const __batch = { method, run: __chunk.run, at: __chunk.at, end: __chunk.at === undefined ? undefined : __chunk.at + __size, chunks: [__chunk], size: __size, gate: __gate, task: null };
      __rpcOpenBatch = __batch;
      __rpcWriteCount++;
      const __task = __rpcWriteChain
        .then(() => {
          if (__rpcOpenBatch === __batch) __rpcOpenBatch = null;
          return __batch.gate;
        })
        .then(() => __supervisor[method](__rpcBatchBytes(__batch), __batch.at, __batch.run))
        .then(() => __nimbusStopReplay.ackedRun(__batch.chunks))
        .catch((e) => {
          __onRpcDrop(__batch.size, e);
          // Its reader has gone (a parent closed its end of this child's
          // pipe): the writes fail, EPIPE, as Node's do (__nimbusWriteLiveOutput).
          if (e && e.code === "EPIPE") throw e;
        });
      __batch.task = __task;
      __rpcWritesOutstanding++;
      __rpcWriteChain = __task.then(__rpcWriteSettled, __rpcWriteSettled);
      return __task;
    };
    const __rpcBatchBytes = (batch) => {
      if (batch.chunks.length === 1) return batch.chunks[0].b;
      const out = new Uint8Array(batch.size);
      let at = 0;
      for (const chunk of batch.chunks) { out.set(chunk.b, at); at += chunk.b.byteLength; }
      return out;
    };
    let cwd = _cwd || "/home/user";
    let stdout = "", stderr = "";
    let exitCode = 0;
    const __nimbusDeferProcessExitReport = true;
${nodeFacetSource(sources, "ledger")}
    const __vfsDirs = {};

${ENTRYPOINT_TIMER_TRACKER}
${nodeFacetSource(sources, "shims")}

${ENTRYPOINT_EVENT_LOOP}
${RESIDENCY_MISS_REPORT}

    // process.stdout/stderr stream live to the SUPERVISOR; console writes through them.
    if (__supervisor && !captureOutput) {
      __processMod.stdout.write = (d, enc, cb) => __nimbusWriteLiveOutput("stdout", d, enc, cb, __queueRpcWrite);
      __processMod.stderr.write = (d, enc, cb) => __nimbusWriteLiveOutput("stderr", d, enc, cb, __queueRpcWrite);
    }
    // A fatal report goes to fd 2 as Node's does: past any write a program
    // installs, after what the program wrote, and not program output that
    // a stopped run's replay retraces (runtime/stop-replay.ts).
    __nimbusFatalStderr = (__text) => {
      stderr += __text;
      if (!__supervisor || captureOutput) return;
      // Nothing written after it joins a batch sent before it.
      __rpcOpenBatch = null;
      const __bytes = __nimbusOutEnc.encode(__text);
      // At the output gate, as all of the process's output is.
      const __gate = __nimbusOutputGate();
      const __task = __rpcWriteChain.then(() => __gate).then(() => __supervisor.stderr(__bytes)).catch((e) => __onRpcDrop(__bytes.byteLength, e));
      __rpcWritesOutstanding++;
      __rpcWriteChain = __task.then(__rpcWriteSettled, __rpcWriteSettled);
    };

    // Measurement: the platform's console, whose lines reach the guest tail.
    globalThis.__nimbusHostConsole ??= globalThis.console;
    globalThis.__nimbusMeasureLog = (kind) => {
      try {
        const store = globalThis.__nimbusMeasureResident;
        globalThis.__nimbusHostConsole.log("[fs-measure] " + JSON.stringify({
          kind, pid: (globalThis.process && globalThis.process.pid) ?? null, argv: (globalThis.process && globalThis.process.argv || []).slice(1, 3),
          store: store ? store.measure() : null,
          coherence: globalThis.__nimbusVfsCoherence || null,
          fsRpcReads: globalThis.__nimbusFsRpcReads || 0,
          residencyMisses: (globalThis.__nimbusVfsResidencyMisses || new Set()).size,
        }));
      } catch (e) { try { globalThis.__nimbusHostConsole.log("[fs-measure] failed " + (e && e.message)); } catch {} }
    };
    try { globalThis.console = __consoleMod; } catch {}
    try { globalThis.process = __processMod; } catch {}
    try { globalThis.Buffer = __BufferMod; } catch {}
    try { globalThis.global = globalThis; } catch {}
    __nimbusInstallNodeNavigator(__processMod.version);
    // undici's fetch (bundled by e.g. create-cloudflare) detaches
    // performance.markResourceTiming and calls it with no receiver,
    // which workerd rejects with "Illegal invocation" and crashes the
    // process from an unhandled fetch-timing callback. Rebind it so a
    // detached call keeps the correct receiver.
    try {
      const __perf = globalThis.performance;
      if (__perf && typeof __perf.markResourceTiming === "function") {
        __perf.markResourceTiming = __perf.markResourceTiming.bind(__perf);
      }
    } catch {}
    const mod = __nimbusEntryModuleOf(filename, ${esModule});
`;
}

/**
 * Generate one-shot runtime code with a plain fetch handler. `filename`
 * names the entry's module, and so its stack frames; with `cwd` it is the
 * entry's importer (entryImporterUrl).
 */
export async function generateEntrypointCode(
  userCode: string,
  vfsState: FacetVfsState,
  usesSqlite: boolean,
  sources: NodeFacetSources,
  wasmImports: readonly FacetWasmImport[] = [],
  filename?: string,
  cwd: string = DEFAULT_HOME,
  esModule?: boolean,
  preamble?: string,
  check = false,
): Promise<GeneratedNodeFacetCode> {
  const bundleSource = await facetVfsBundleSourceFor(vfsState);
  const entry = entryModule(userCode, filename, cwd, esModule, bundleSource, preamble, check);
  const runtime = createNodeFacetRuntime(sources, { ...bundleSource, stackEntry: entry.stackEntry });
  const source = moduleSource`
${nodeProgramModule(bundleSource, runtime, usesSqlite, vfsState.stagedBindings, wasmImports)}

// The module bundle, at module level (startup time); the code cells the store
// adopts are getters over the map's own text.
const __MODULE_VFS_BUNDLE = __nimbusWithCodeCells(${bundleSource.expression});

export default {
  async fetch(request, workerEnv, workerCtx) {
    // A body that does not parse is marked for the entry to name.
    const args = await request.json().catch((error) => {
      if (error instanceof Error) error[${JSON.stringify(TASK_BODY_FAILED)}] = true;
      throw error;
    });
    const { argv, nodeCommandLine, env, cwd: _cwd, filename, dirname, stdin, captureOutput, cred, diag: __diag, vfsCursor, dataPlan, manifests } = args;
    const __nimbusProcessId = Number(args.pid || 1);
    // A pipe or redirect streams through this input channel (exec's
    // _pumpStdinPipe); node-shims' process.stdin and fd 0 read it.
    const __nimbusLiveInputPid = Number(args.stdinPid || 0);
    // The channel has ended, and what it holds is taken whole before the
    // entry runs: a run after a stop that waited for the end of stdin.
    const __nimbusStdinWhole = args.stdinWhole === true;
    // A run after a stop is handed back the stdin the run before it took, and
    // takes all of that before it starts, whatever its size.
    const __nimbusStdinAtLeast = Number(args.stdinAtLeast || 0);
    // This run's stop, and what it replays of the run that stopped before it.
    // ctx.abort ends the isolate's JavaScript where it stands, so the program
    // never sees the stop; the session believes a stop only with this run's
    // nonce, which only this module holds.
    // ctx.abort is taken now, before the program runs, and handed a string.
    const __ctxAbort = workerCtx && typeof workerCtx.abort === "function" ? workerCtx.abort : null;
    const __apply = Reflect.apply;
    __nimbusStopReplay.begin({
      replay: args.replay || null,
      abort: __ctxAbort ? (reason) => __apply(__ctxAbort, workerCtx, [reason]) : null,
      captured: !!captureOutput || !workerEnv?.SUPERVISOR,
      // Read at a stop, after the run has printed (declared below).
      capturedText: () => ({ stdout, stderr }),
      nonce: args.stopNonce,
      // Its network goes through the session, which records what it reads.
      outbound: args.outbound === true,
      // Its first listen stops it, to be run again as a resident that serves.
      promote: args.promote === true,
      // The session holds what it answers past the read the run before
      // stopped at until the replay gets there.
      boundary: () => { const b = __supervisor && __supervisor.replayBoundary; return typeof b === "function" ? Reflect.apply(b, __supervisor, []) : undefined; },
    });
    // A \`< file\` redirect: fd 0 is this file (node-shims' stdin helpers).
    const __nimbusStdinFile = args.stdinFile && typeof args.stdinFile.path === "string" ? args.stdinFile : null;
    // Per invocation, not per module: this body is cached on
    // hash(code + bundle + manifest) and reused by any session whose snapshot
    // hashes the same, and epochs are per supervisor incarnation.
    const __MODULE_VFS_CURSOR = vfsCursor || null;
${VFS_CURSOR_SEED_SOURCE}
    // A user-invoked program has no wall-clock lifetime: the drain runs the
    // entrypoint's event loop until Node would exit, and only a kill (Ctrl-C)
    // ends it early.
    const __entryBudgetMs = Infinity;
    let __drainPasses = 0;
    // Every call that changes something outside the process is counted: a
    // run that made one cannot stop to be run again.
    const __supervisor = workerEnv?.SUPERVISOR
      ? __nimbusStopReplay.ledger(globalThis.__nimbusAnsweringSupervisor(workerEnv.SUPERVISOR)) : null;
    // What the run misses, and the code it produces, reach the session as they
    // happen, as a resident's do: a run the platform kills (its memory limit)
    // sends no exit envelope, and its next launch must still stage what it
    // lacked. The envelope stays the record of a run that ends, so a report
    // that fails here is not this run's failure.
    __nimbusRuntimeCodeReporter = () => __nimbusFlushRuntimeCode(__supervisor).catch(() => {});
    // Its network goes through its workspace's egress: node:tls refuses a TLS socket by name.
    globalThis.__nimbusEgress = workerEnv?.NIMBUS_EGRESS === true;
    // The same store, namespace and data plan a resident boots on, backed by
    // this run's heap (runOnce hosts no SQLite; vfs/resident). This run's own,
    // so a loader that reuses this isolate for another run starts it from an
    // empty store.
    const __resident = __nimbusResidentModule.createResidentStore();
    __resident.bindInMemory(${ONE_SHOT_STORE_MEMORY_BYTES});
    globalThis.__nimbusMeasureResident = __resident;
    __resident.admission.setStorage(undefined, __supervisor);
    __resident.namespace.setCred(cred);
    __resident.sync.setPlan(dataPlan);
    __resident.sync.setManifests(manifests);
    __resident.sync.setPushRoots([_cwd || "/home/user", "/tmp"]);
    // The module bundle stays at module scope: a reused isolate adopts it
    // again on its next run, and its text cells are shared, not copied.
    const __residentBooted = await __resident.sync.boot(() => __MODULE_VFS_BUNDLE, __MODULE_VFS_CURSOR, __supervisor, ${bundleSource.storageBytes});
    if (__residentBooted.cursor) {
      globalThis.__nimbusVfsCursor = { epoch: __residentBooted.cursor.epoch, rev: __residentBooted.cursor.rev };
    }
    // No user code runs before the namespace answers: it is the view every
    // synchronous stat, exists and readdir reads (CUTOVER #13).
    const __namespaceFailure = await __resident.sync.requireNamespace(__supervisor, __residentBooted.failure);
    if (__namespaceFailure) {
      return __NimbusHostResponse.json({ exitCode: 1, stdout: "", stderr: __namespaceFailure + "\\n", residencyMisses: [] });
    }
${nodeProgramRuntime(sources, entry.esModule)}
    try {
      await __nimbusPrepareStdin();
      // From here on the program runs: a stop is possible while stdin can
      // still come short of a read.
      __nimbusStopReplay.arm(__nimbusStdinCanStop());
      // \`-r\` and \`--import\` modules first, before the entry is require.main.
      await __nimbusPreload();
      // Compiled here, by the registry, the first time. A SyntaxError in the
      // entry has no location of its own; the wrapper leads its stack with
      // where it is, as Node does. \`-p\`'s returns the value it prints.
      // What it throws is uncaught, as in Node: an ES module's as its
      // evaluation's rejection.
      let __entryResult;
      try {
        __entryResult = __nimbusEntryOutcome(${entry.evaluate});
      } catch (__thrown) {
        if (__thrown instanceof __ProcessExit) throw __thrown;
        __nimbusUncaughtException(__thrown, ${entry.esModule});
      }
      const __drain = await __nimbusRunEntrypointToExit(__entryResult, __entryBudgetMs, __nimbusBeforeExitHasWork);
      __drainPasses = __drain.passes;
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;

      // A program that ended on its own may still be reading stdin; one that
      // called process.exit() has ended whatever it holds, its stdin included,
      // as Node's does. Waiting for the pump there waited for a parent that
      // keeps the pipe open to close it, which it need never do.
      if (__nimbusLiveStdinPump && !__nimbusAttachedTty && __nimbusProcessExitCode === null) await __nimbusLiveStdinPump;
    } catch (e) {
      if (e instanceof __ProcessExit) { exitCode = e.code; }
      else {
        // The runtime's own failure (a preload, the loop): reported as one.
        __nimbusUncaughtException(e, false);
        if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      }
    }
    // A program that ended without process.exit still gets its 'exit' event.
    if (__nimbusProcessExitCode === null) {
      exitCode = __nimbusExitAtEnd();
      if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      __nimbusProgramStopped = true;
    }

    // The runtime's own turns, on the platform's timer: a program timer's
    // resumption barrier is the program's, and its round trip (and the read
    // lease it is answered with) is nothing an ended program needs.
    async function __drainPendingIO(maxPasses = 12) {
      for (let __pass = 0; __pass < maxPasses; __pass++) {
        await new Promise(r => globalThis.__nimbusRawSetTimeout(r, 0));
        const __output = __outputPending();
        // The registry is empty once nothing in it is outstanding (PENDING_IO_SOURCE).
        if (__pendingIO.length === 0 && __output === null) break;
        await Promise.allSettled([...__pendingIO, __output]);
      }
    }

    // Sited before the drain, like the lifetime-limit diagnostic above, so
    // the queued stderr write is one of the writes the drain settles rather
    // than an orphan dropped at teardown.
    if (globalThis.__nimbusVfsResidencySettle) {
      try { await globalThis.__nimbusVfsResidencySettle(); } catch {}
    }
    const __residencyReport = __nimbusResidencyMissReport();
    if (__residencyReport) {
      stderr += __residencyReport;
      if (exitCode === 0) exitCode = 1;
      if (__supervisor && !captureOutput) __queueRpcWrite("stderr", __nimbusOutEnc.encode(__residencyReport))?.catch(() => {});
    }
    // A run after a stop that ended before printing all the stopped run had
    // printed did not retrace it: what it printed past that is not the
    // program's output.
    const __replayShort = __nimbusStopReplay.finish();
    if (__replayShort) {
      stderr += __replayShort;
      exitCode = 1;
      if (__supervisor && !captureOutput) __nimbusReleaseStderr(__replayShort);
    }
    await __drainPendingIO();

    if (__supervisor) {
      try {
        await __nimbusDrainVfsWrites(__supervisor);
      } catch (e) {
        const message = (e && e.message) || String(e);
        const stack = (e && e.stack) || message;
        const trace = stack.includes(message) ? stack : message + "\\n" + stack;
        stderr += trace + "\\n";
        exitCode = 1;
        if (!captureOutput) await __nimbusReleaseStderr(trace + "\\n");
      }
    }

    // Drain child_process output before reporting process exit.
    try {
      if (__childProcessMod && typeof __childProcessMod.__cpDrainAllChildren === "function") {
        await __childProcessMod.__cpDrainAllChildren();
      }
    } catch (e) { /* best-effort */ }

    // Report exit after draining so the ring buffer is complete before
    // the supervisor decides whether to emit a dump. Fix 6: include an
    // orphan-drop tail if RPC writes were lost during teardown.
    if (__supervisor) {
      let __tail = "";
      if (__rpcDrops > 0) {
        __tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
                 __rpcDropBytes + " bytes lost" +
                 (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      }
      globalThis.__nimbusMeasureLog?.("node-oneshot");
      try { await __supervisor.reportExit(exitCode, __tail); } catch {}
    }

    return __NimbusHostResponse.json({
      exitCode,
      stdout: (__supervisor && !captureOutput) ? "" : stdout,
      stderr: (__supervisor && !captureOutput) ? __nimbusUnreportedStderr : stderr,
      // Unconditional, unlike diag: the supervisor stages these paths into
      // the next bundle for the same entry, so withholding them behind a
      // debug flag would leave the miss to repeat forever.
      residencyMisses: __nimbusDataReadMisses(),
      moduleMisses: __nimbusExecutedModuleMisses(),
      // Code produced while it ran, for the next launch (commonjs-cell.ts).
      runtimeCode: __nimbusRuntimeCodeLedger(),
      ...(__diag ? { diag: {
        drainPasses: __drainPasses, rpcWrites: __rpcWriteCount, fsRpcReads: globalThis.__nimbusFsRpcReads || 0, esmAdoptions: __nimbusEsmAdoptions,
        namespaceRefusals: (globalThis.__nimbusVfsCoherence && globalThis.__nimbusVfsCoherence.namespaceRefusals) || 0,
      } } : {}),
    });
  }
};
`;
  return {
    source,
    get code() { return source.text; },
    immutableModules: runtime.immutableModules,
    modules: bundleSource.modules,
    codeModules: { ...bundleSource.codeModules, ...runtime.modules, ...entry.modules },
    esModules: bundleSource.esModules,
  };
}

/**
 * Generate a long-running Node entrypoint.
 *
 * Same core shim/VFS machinery as foreground node execution, but the
 * compiled user entry is booted once and the exported entrypoint keeps
 * serving HTTP requests from the shimmed http.Server registry.
 */
/**
 * Hand a record's entries to a consumer one at a time, releasing each as it
 * goes, so the record stops being a second holder of the whole set.
 *
 * The image store takes its images as a sequence for exactly this: a launch's
 * module text is the largest thing the coordinator assembles, and holding it
 * in two places at once is what the 128 MiB isolate could not survive.
 */
function* drainSources(sources: Record<string, string>): Generator<readonly [string, string]> {
  for (const name of Object.keys(sources)) {
    const source = sources[name];
    delete sources[name];
    yield [name, source];
  }
}

/**
 * The image-store name a resident launch's code pack is materialized under.
 * Not a module name — the pack's own index names its modules — so it can
 * never collide with one of the main module's.
 */
const CODE_PACK_IMAGE = 'code pack';

/** One wasm image the generated main module imports from the module map. */
export interface FacetWasmImport {
  /** The module-map name the boot spec carries the image under. */
  moduleName: string;
  /** The absolute VFS path the program reads the same bytes from. */
  vfsPath: string;
  /**
   * A content key for the same bytes, for an image the program never reads
   * from the filesystem — one inlined in a package's own source as base64.
   * The seam recognises the bytes instead of the path.
   */
  digest?: string;
}

/** The module-map name a precompiled wasm image travels under. */
export function facetWasmModuleName(index: number): string {
  return `__nimbus_wasm_${index}.wasm`;
}

/**
 * The wasm imports one launch stages: the images its options name, then
 * every image the closure walk recorded (FacetVfsState.wasmImages) that the
 * options did not already name by path. One member per path; the closure's
 * record supplies the digest an option without one lacks.
 */
export function facetWasmImports(
  named: readonly { vfsPath: string; digest: string | undefined }[],
  closure: readonly WasmImageRecord[],
): FacetWasmImport[] {
  const byPath = new Map<string, { vfsPath: string; digest: string | undefined }>();
  for (const image of named) byPath.set(image.vfsPath, image);
  for (const image of closure) {
    const seen = byPath.get(image.vfsPath);
    if (seen === undefined) byPath.set(image.vfsPath, image);
    else if (seen.digest === undefined) byPath.set(image.vfsPath, { ...seen, digest: image.digest });
  }
  return [...byPath.values()].map((image, index) => ({ ...image, moduleName: facetWasmModuleName(index) }));
}

/**
 * The wasm images earlier runs of a command learned (runtime code of kind
 * `wasm`: bytes the program compiled that the launch did not carry, which
 * the WebAssembly seam named and recorded), for this launch to carry.
 */
export function learnedWasmImages(code: ReadonlyMap<string, RuntimeCodeEntry>): Uint8Array[] {
  const images: Uint8Array[] = [];
  for (const entry of code.values()) {
    if (entry.kind === 'wasm') images.push(Uint8Array.from(atob(entry.bytes), (c) => c.charCodeAt(0)));
  }
  return images;
}

/**
 * A launch's wasm images, parked by VFS path and by digest for the
 * node-shims WebAssembly seam, each as the compile of its map member: the
 * seam runs it when the program first compiles those bytes. A static import
 * compiled every image at load, used or not (lightningcss's 15.8 MB on every
 * Vite 8 dev launch). Under new_module_registry a member compiles on first
 * evaluation, and the registry's require() may evaluate it at request time,
 * where a compile from bytes is refused.
 */
export function facetWasmImportsSource(wasmImports: readonly FacetWasmImport[]): string {
  if (wasmImports.length === 0) return '';
  const compiles = wasmImports.map((entry, index) =>
    `const __nimbusWasm${index} = __nimbusWasmCompile(${JSON.stringify('./' + entry.moduleName)});`);
  const entries = wasmImports.map((entry, index) =>
    `[${JSON.stringify(stripLeadingSlashes(entry.vfsPath))}, __nimbusWasm${index}]`);
  const byDigest = wasmImports
    .map((entry, index) => (entry.digest === undefined
      ? null
      : `[${JSON.stringify(entry.digest)}, __nimbusWasm${index}]`))
    .filter((line): line is string => line !== null);
  // __nimbusCreateRequire: the registry's, imported with COMMONJS_CELL_IMPORTS.
  return 'const __nimbusWasmRequire = __nimbusCreateRequire(import.meta.url);'
    + '\nconst __nimbusWasmCompile = (member) => { let compiled; return () => compiled ??= __nimbusWasmRequire(member); };'
    + `\n${compiles.join('\n')}`
    + `\nglobalThis.__nimbusPrecompiledWasm = new Map([${entries.join(', ')}]);`
    + `\nglobalThis.__nimbusPrecompiledWasmByDigest = new Map([${byDigest.join(', ')}]);`;
}
export async function generateLongRunningNodeCode(
  userCode: string,
  vfsState: FacetVfsState,
  opts: {
    argv?: string[];
    /** A node program's command line: its options, conditions, preloads and `-e`/`-p` code (core runtime/node-cli.ts). */
    node?: NodeLaunch;
    cwd?: string;
    filename?: string;
    dirname?: string;
    esModule?: boolean;
    /** CommonJS evaluated before the entry (node-runner.ts RunFreshOpts.preamble). */
    preamble?: string;
    stdin?: string;
    attachedTty?: boolean;
    cred: ProcessEntry['cred'];
    /** Wasm images the generated main module imports and parks in the seam. */
    wasmImports?: readonly FacetWasmImport[];
  },
  usesSqlite: boolean,
  sources: NodeFacetSources,
  pacer?: TurnBudget,
): Promise<GeneratedNodeFacetCode> {
  const bundleSource = await facetVfsBundleSourceFor(vfsState, pacer);
  const entry = entryModule(userCode, opts.filename, opts.cwd || DEFAULT_HOME, opts.esModule, bundleSource, opts.preamble, opts.node?.check === true);
  // No env: a process's environment is its own (ask 62), and this source is
  // content-addressed into an image every process can read. It travels in
  // the start payload (startArgs.env), in memory.
  const args = {
    argv: opts.argv || [],
    nodeCommandLine: opts.node ?? null,
    cwd: opts.cwd || '/home/user',
    filename: opts.filename || '<script>',
    dirname: opts.dirname || opts.cwd || '/home/user',
    stdin: opts.stdin || '',
    attachedTty: opts.attachedTty === true,
    cred: opts.cred,
  };
  const runtime = createNodeFacetRuntime(sources, { ...bundleSource, stackEntry: entry.stackEntry });
  const source = moduleSource`
import { DurableObject } from "cloudflare:workers";
${nodeProgramModule(bundleSource, runtime, usesSqlite, vfsState.stagedBindings, opts.wasmImports ?? [])}
const __NIMBUS_ARGS = ${jsonDataLiteral(args)};

// \`let\`, not \`const\`, so the parsed bundle can be dropped once the store has
// adopted it. Holding both is the double materialisation: the module map's text
// and this object are the same bytes twice. The code cells the store adopts
// are getters over the map's own module text.
let __MODULE_VFS_BUNDLE = __nimbusWithCodeCells(${bundleSource.expression});

// The shared read profile's files this launch staged; each is struck off
// when read, and what is left at exit is reported unread (read-profile.ts).
let __nimbusProfileStaged = null;
// This facet's store: one process, one store, for the life of the isolate.
const __resident = __nimbusResidentModule.createResidentStore({
  observeRead: (path) => { if (__nimbusProfileStaged !== null) __nimbusProfileStaged.delete(path); },
});

let __nimbusStarted = false;
let __nimbusStarting = null;
let __nimbusRuntime = null;
let __nimbusAttachedLifecycle = null;

// The platform's timer, captured at module evaluation, before the shims wrap
// setTimeout in the resumption barrier. The flush below yields turns for its
// own bookkeeping; that is not a resumption of the program, and through the
// wrapped timer it paid a hidden ACQUIRE per yield — the one an inbound
// request relied on without saying so, and a second one after the response
// on every request. The request's barrier is taken explicitly, in the shared
// dispatch (__nimbusServeHttp), exactly once.
const __nimbusPlatformSetTimeout = setTimeout;

// A failed report of generated code or misses costs the next launch what this
// one learned, and nothing else: the program's own writes and responses do not
// wait on it. The failure is told to the guest's stderr, where the next-launch
// guidance it would otherwise contradict is printed.
async function __nimbusReportLearningFailure(supervisor, error) {
  try {
    // At the process's output gate, as every diagnostic of a process is.
    const gate = typeof __nimbusOutputGate === "function" ? __nimbusOutputGate() : null;
    if (gate !== null) await gate;
    if (supervisor) await supervisor.stderr(new TextEncoder().encode("Nimbus: runtime code persistence failed: " + String(error?.message || error) + "\\n"));
  } catch {}
}

async function __nimbusFlushRuntime() {
  const rt = __nimbusRuntime;
  if (!rt) return;
  const __pendingDrain = rt.pendingDrainChain.then(async () => {
    // Every change the program made is in its client's log already: the
    // flush waits for their answers (the parked cells' claims among them).
    const __vfsOutcomes = await Promise.allSettled([
      ...(rt.supervisor ? Object.keys(rt.vfsWrites).map((path) => rt.flushVfsWrite(path)) : []),
      rt.drainVfsMutations(),
      ...(globalThis.__nimbusProcessFs ? [globalThis.__nimbusProcessFs.flush()] : []),
    ]);
    for (let pass = 0; pass < 12; pass++) {
      const turn = Promise.withResolvers();
      __nimbusPlatformSetTimeout(turn.resolve, 0);
      await turn.promise;
      const output = rt.outputPending();
      // The registry is empty once nothing in it is outstanding (PENDING_IO_SOURCE).
      if (rt.pendingIO.length === 0 && output === null) break;
      await Promise.allSettled([...rt.pendingIO, output]);
    }
    // After the drain, so the program's writes are durable whatever happens
    // to the report; unacknowledged entries are sent again by the next flush.
    const [__learning] = await Promise.allSettled([__nimbusFlushRuntimeCode(rt.supervisor)]);
    if (__learning.status === "rejected") await __nimbusReportLearningFailure(rt.supervisor, __learning.reason);
    const __vfsFailure = __vfsOutcomes.find((outcome) => outcome.status === "rejected");
    if (__vfsFailure) throw __vfsFailure.reason;
    // A change the program was told succeeded that the session refused or
    // never answered: this boundary (a response, the exit) reports it.
    const __fsFailure = globalThis.__nimbusProcessFs ? globalThis.__nimbusProcessFs.takeFailuresError() : null;
    if (__fsFailure) throw __fsFailure;
  });
  rt.pendingDrainChain = __pendingDrain.catch(() => {});
  await __pendingDrain;
}

async function __nimbusEnsureStarted(workerEnv, workerCtx, __startArgs) {
  if (__nimbusStarted) return;
  if (__nimbusStarting) return __nimbusStarting;
  __nimbusStarting = (async () => {
    const args = __NIMBUS_ARGS;
    const { argv, nodeCommandLine, cwd: _cwd, filename, dirname, stdin, captureOutput, attachedTty, cred } = args;
    // The process's environment, handed over in memory (never in this module's text).
    const env = (__startArgs && __startArgs.env) || {};
    const __nimbusProcessId = Number(__startArgs?.pid || env?.NIMBUS_CP_CHILD_PID || 1);
    // Every resident process has a live input channel on its pid.
    const __nimbusLiveInputPid = Number(__startArgs?.pid || env?.NIMBUS_CP_CHILD_PID || 0);
    // The channel has ended, and what it holds is taken whole before the
    // entry runs: a boot after a stop that waited for the end of stdin.
    const __nimbusStdinWhole = !!(__startArgs && __startArgs.stdinWhole);
    // Off the start payload, never out of the module text: this body is
    // content-addressed into the facet image store, and a revision that
    // advances on every spawn would give the same program a new image each
    // time. Same reason argv/env/pid want to move here.
    const __MODULE_VFS_CURSOR = (__startArgs && __startArgs.vfsCursor) || null;
${VFS_CURSOR_SEED_SOURCE}
    const __nimbusStdinAtLeast = Number((__startArgs && __startArgs.stdinAtLeast) || 0);
    // A \`< file\` redirect: fd 0 is this file (node-shims' stdin helpers).
    const __nimbusStdinFile = __startArgs && __startArgs.stdinFile && typeof __startArgs.stdinFile.path === "string" ? __startArgs.stdinFile : null;
    const __ctxAbort = workerCtx && typeof workerCtx.abort === "function" ? workerCtx.abort : null;
    const __apply = Reflect.apply;
    __nimbusStopReplay.begin({
      replay: (__startArgs && __startArgs.replay) || null,
      abort: __ctxAbort ? (reason) => __apply(__ctxAbort, workerCtx, [reason]) : null,
      captured: !!captureOutput || !workerEnv?.SUPERVISOR,
      nonce: __startArgs && __startArgs.stopNonce,
      boundary: () => { const b = __supervisor && __supervisor.replayBoundary; return typeof b === "function" ? Reflect.apply(b, __supervisor, []) : undefined; },
      run: __startArgs && __startArgs.run,
    });
    const __supervisor = workerEnv?.SUPERVISOR
      ? __nimbusStopReplay.ledger(globalThis.__nimbusAnsweringSupervisor(workerEnv.SUPERVISOR)) : null;
    // Its network goes through its workspace's egress: node:tls refuses a TLS socket by name.
    globalThis.__nimbusEgress = workerEnv?.NIMBUS_EGRESS === true;
    __nimbusRuntimeCodeReporter = () => {
      const report = __nimbusFlushRuntimeCode(__supervisor).catch(async (error) => {
        await __nimbusReportLearningFailure(__supervisor, error);
        throw error;
      });
      // Code may be produced by a timer after boot has returned, not by an
      // HTTP request that will call our flush. Own this asynchronous write.
      workerCtx.waitUntil(report);
      return report;
    };
    // The resident set lives in this facet's own SQLite rather than its heap.
    // A synchronous read cannot block and no JS stack here can be suspended, so
    // the bytes have to sit somewhere a synchronous call can already reach;
    // \`ctx.storage.sql.exec\` returns a Cursor, not a Promise. See
    // vfs/resident.
    // Measurement: NIMBUS_MEASURE_STORE=heap holds this resident's store in its heap, at the one-shot's cap.
    const __measureHeap = !!(env && env.NIMBUS_MEASURE_STORE === "heap");
    if (__measureHeap) __resident.bindInMemory(${ONE_SHOT_STORE_MEMORY_BYTES});
    else __resident.bind(workerCtx);
    globalThis.__nimbusMeasureResident = __resident;
    __resident.admission.setStorage(__measureHeap ? undefined : __startArgs && __startArgs.storage, __supervisor);
    __resident.namespace.setCred(cred);
    __resident.sync.setPlan(__startArgs && __startArgs.dataPlan);
    // What an import() of a module only an import() reaches reads
    // synchronously, fetched when that import() runs (node-shims.ts
    // __nimbusStageImport; the planner's lazyReadsByTarget).
    globalThis.__nimbusLazyReads = new Map(Object.entries((__startArgs && __startArgs.lazyReads) || {}));
    // A SafeSet (the launch's captures): every read strikes one off, after a program may have replaced Set.prototype.delete.
    __nimbusProfileStaged = new __nimbusLaunchCaptures.SafeSet((__startArgs && __startArgs.profileStaged) || []);
    // What a barrier pushes: the working tree, /tmp, and the stylesheet
    // sources outside the tree the plan held (data-plan.ts stylesheet-source).
    __resident.sync.setPushRoots([_cwd || "/home/user", "/tmp", ...((__startArgs && __startArgs.sourceRoots) || [])]);
    // Bring the store to the authority's current state before the program's
    // first instruction. This is what makes a first synchronous read of an
    // untouched file succeed, and it is the ONLY blocking step: the waiting is
    // done once, here, so that no synchronous read after it ever has to wait.
    //
    // A cold store adopts this spawn's snapshot and fills the rest. A store
    // that outlived its process — a durable application's, relaunched or
    // re-driven — is cheap to bring current: rows the absolute listing proves
    // current are kept, and only what changed is fetched. It is SERVED only
    // once that listing has vouched for it: rows it cannot vouch for are a
    // previous process's, of unknown age, so the kept store is emptied and
    // this launch boots as a cold one does. See vfs/resident sync.boot.
    //
    // The thunk hands the parsed bundle over and drops this scope's reference,
    // so a cold boot frees it the moment it is adopted rather than holding it
    // through the fill. A kept store that reconciles never takes it.
    const __residentBootStarted = ${REAL_NOW_SOURCE}();
    const __residentBooted = await __resident.sync.boot(
      () => { const __bundle = __MODULE_VFS_BUNDLE; __MODULE_VFS_BUNDLE = null; return __bundle; },
      __MODULE_VFS_CURSOR,
      __supervisor,
      ${bundleSource.storageBytes},
    );
    if (__startArgs && __startArgs.diag && __supervisor) {
      // NIMBUS_DEBUG only: what this process holds, for per-process storage measurement.
      try {
        const __stats = __resident.cells.stats();
        await __supervisor.stderr(new TextEncoder().encode("[nimbus-debug] resident boot " + JSON.stringify({
          ms: ${REAL_NOW_SOURCE}() - __residentBootStarted, ...__stats, failure: __residentBooted.failure || null,
        }) + "\\n"));
      } catch {}
    }
    __MODULE_VFS_BUNDLE = null;
    // One cursor, not two. The seed above publishes the cursor this SPAWN
    // staged at, which is right for a cold store and stale for a kept one —
    // the cursor the boot returns describes what the rows actually are.
    if (__residentBooted.cursor) {
      globalThis.__nimbusVfsCursor = { epoch: __residentBooted.cursor.epoch, rev: __residentBooted.cursor.rev };
    }
    // No user code runs before the namespace answers: it is the view every
    // synchronous stat, exists and readdir reads (CUTOVER #13). A launch whose
    // namespace cannot be listed fails here, naming why.
    const __namespaceFailure = await __resident.sync.requireNamespace(__supervisor, __residentBooted.failure);
    if (__namespaceFailure) throw new Error(__namespaceFailure);
${nodeProgramRuntime(sources, entry.esModule)}
    if (attachedTty) {
      try { __processMod.stdin.__nimbusStartLivePump?.(); } catch {}
    }

    let __attachedExplicitExit = false;
    // \`--watch\` and \`--inspect-brk\` hold a process that has no handle left
    // (it waits for a change, or for a debugger); nothing else does.
    const __nimbusHeldWithoutHandles = [...(nodeCommandLine?.execArgv ?? []), ...(Array.isArray(argv) ? argv : [])]
      .some((__arg) => __arg === "--watch" || __arg === "--inspect-brk");
    let __nimbusEndedAtBoot = false;
    // A resident whose launcher writes its stdin takes what has arrived
    // before the entry runs, and a boot after a stop takes all of it (it has
    // ended), for its synchronous reads of fd 0; so does a one-shot run on
    // as a server, the stdin it read before it listened, or its file. Any other
    // resident's stdin is read only as the program reads it: an attached
    // one's carries the terminal's resizes and signals too.
    if (__startArgs && (__startArgs.stdinWriter || __nimbusStdinAtLeast > 0 || __nimbusStdinFile)) await __nimbusPrepareStdin();
    // From here on the program runs. Its boot can stop while stdin can still
    // come short of a read, when its launcher writes that stdin
    // (FacetManager._residentLaunchBody); nothing else would ever end it.
    __nimbusStopReplay.arm(
      __nimbusStdinCanStop() && !!(__startArgs && __startArgs.stdinWriter),
      attachedTty ? "runs attached to a terminal, which Nimbus does not run again"
        : "is a server started from the terminal, whose stdin nothing writes",
    );
    try {
      // \`-r\` and \`--import\` modules first, before the entry is require.main.
      await __nimbusPreload();
      // Compiled here, by the registry, the first time. A SyntaxError in the
      // entry has no location of its own; the wrapper leads its stack with
      // where it is, as Node does. \`-p\`'s returns the value it prints.
      // What it throws is uncaught, as in Node: an ES module's as its
      // evaluation's rejection.
      let __entryResult;
      try {
        __entryResult = __nimbusEntryOutcome(${entry.evaluate});
      } catch (__thrown) {
        if (__thrown instanceof __ProcessExit) throw __thrown;
        __nimbusUncaughtException(__thrown, ${entry.esModule});
      }
      if (attachedTty) {
        // An attached program ends as Node's does, at process.exit or with
        // no live handle left, not when its entry's evaluation completes: a
        // CLI whose top level starts its interface and returns runs on (pi's
        // bin). What the evaluation rejects with is uncaught, as Node's
        // loader rejects.
        if (__entryResult && typeof __entryResult.then === "function") {
          __entryResult.then(undefined, (__error) => { __nimbusUncaughtException(__error, true); });
        }
        await __nimbusRunEventLoop(
          __nimbusPendingStartupWork, __nimbusProcessExitPromise, ${RESIDENT_BOOT_SETTLE_MS}, 8,
        );
      } else {
        await __nimbusSettleEntrypointStartup(__entryResult, ${RESIDENT_BOOT_SETTLE_MS});
        if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
        // Finished during its boot (\`--help\`, a CLI run that also serves):
        // the boot answers with its exit, as an explicit exit's does.
        else if (!__nimbusHeldWithoutHandles) __nimbusEndedAtBoot = await __nimbusHoldsNoHandle() && !await __nimbusBeforeExitHasWork();
      }
    } catch (e) {
      if (e instanceof __ProcessExit) {
        __attachedExplicitExit = true;
        exitCode = e.code;
      } else {
        // The runtime's own failure (a preload, the loop): reported as one.
        __nimbusUncaughtException(e, false);
        if (__nimbusProcessExitCode !== null) exitCode = __nimbusProcessExitCode;
      }
    }

    await new Promise((resolve) => globalThis.__nimbusRawSetTimeout(resolve, 0));
    __nimbusRuntime = {
      supervisor: __supervisor,
      pendingIO: __pendingIO,
      outputPending: __outputPending,
      vfsWrites: __vfsWrites,
      flushVfsWrite: __nimbusFlushVfsWrite,
      drainVfsMutations: __nimbusDrainVfsMutations,
      pendingDrainChain: Promise.resolve(),
    };
    await __nimbusFlushRuntime();

    const __nimbusReportFinalExit = async (code, reason) => {
      if (!__supervisor || __nimbusProcessExitReported) return;
      // Every resident exit path funnels through here, so the unanswered-read
      // report is sited once and cannot be reached around.
      if (globalThis.__nimbusVfsResidencySettle) {
      try { await globalThis.__nimbusVfsResidencySettle(); } catch {}
    }
    const __residencyReport = __nimbusResidencyMissReport();
      if (__residencyReport) {
        stderr += __residencyReport;
        if (Number(code ?? 0) === 0) code = 1;
        await __nimbusReleaseStderr(__residencyReport);
      }
      // A server run again that ended before its listen did not retrace it.
      const __replayShort = __nimbusStopReplay.finish();
      if (__replayShort) {
        stderr += __replayShort;
        code = 1;
        await __nimbusReleaseStderr(__replayShort);
      }
      globalThis.__nimbusMeasureLog?.("node-resident");
      await __supervisor.reportExit(code, reason || "", __nimbusDataReadMisses(), [...(__nimbusProfileStaged || [])], __nimbusRuntimeCodeLedger(), __nimbusExecutedModuleMisses());
      __nimbusProcessExitReported = true;
    };
    const __nimbusReportLifecycleFailure = async (e) => {
      const trace = (e && e.stack) || (e && e.message) || String(e);
      stderr += trace + "\\n";
      if (__supervisor) {
        await __nimbusReleaseStderr(trace + "\\n");
        await __nimbusReportFinalExit(1, trace + "\\n");
      }
    };

    if (__attachedExplicitExit) {
      await __nimbusReportFinalExit(exitCode, stderr);
    } else {
      const __residentExitLifecycle = (async () => {
        let finalCode = 0;
        if (__nimbusEndedAtBoot || __nimbusHeldWithoutHandles) {
          finalCode = __nimbusEndedAtBoot ? 0 : Number(await __nimbusProcessExitPromise);
        } else {
          // process.exit, or the natural end: no live handle left.
          finalCode = Number(await Promise.race([__nimbusProcessExitPromise, __nimbusNaturalExit(__nimbusBeforeExitHasWork).then(() => 0)]));
        }
        if (__nimbusProcessExitCode === null) {
          finalCode = __nimbusExitAtEnd();
          if (__nimbusProcessExitCode !== null) finalCode = __nimbusProcessExitCode;
          __nimbusProgramStopped = true;
        }
        await __nimbusFlushRuntime();
        await __nimbusReportFinalExit(finalCode, "");
      })().catch(async (e) => {
        if (e instanceof __ProcessExit) {
          try {
            await __nimbusFlushRuntime();
            await __nimbusReportFinalExit(e.code, "");
          } catch (flushError) {
            await __nimbusReportLifecycleFailure(flushError);
          }
          return;
        }
        await __nimbusReportLifecycleFailure(e);
      });
      workerCtx.waitUntil(__residentExitLifecycle);
      if (attachedTty) {
        __nimbusAttachedLifecycle = __residentExitLifecycle;
      } else if (__nimbusEndedAtBoot || __nimbusProcessExitCode !== null) {
        // Ended during its boot: its exit is reported before the boot answers.
        await __residentExitLifecycle;
      }
    }

    if (__rpcDrops > 0 && __supervisor) {
      const tail = "[orphan output: " + __rpcDrops + " dropped RPC write(s), ~" +
        __rpcDropBytes + " bytes lost" +
        (__rpcLastError ? "; last error: " + __rpcLastError : "") + "]\\n";
      await __nimbusReleaseStderr(tail);
    }
    if (exitCode !== 0) {
      await __nimbusReportFinalExit(exitCode, stderr || ("exit " + exitCode + "\\n"));
      throw new Error(stderr || ("long-running node startup exited " + exitCode));
    }
    __nimbusStarted = true;
  })();
  return __nimbusStarting;
}

async function __nimbusDispatchHttp(req, workerEnv, workerCtx) {
  await __nimbusEnsureStarted(workerEnv, workerCtx, __nimbusStartArgs);
  // Measurement: a request that asks for it logs what this resident's store holds now.
  if (String(req.url).includes("__nimbus_measure")) globalThis.__nimbusMeasureLog?.("node-resident-http");
  // Streaming dispatch lives in the node-shims http shim (globalThis.__nimbusServeHttp):
  // it returns the in-facet server's response as a streaming host Response the
  // moment headers are known, so SSE / chunked bodies flow live over the RPC
  // boundary instead of being buffered to "finish". Flush process stdout first
  // (independent of the response stream), then make pending synchronous
  // file-content writes durable before returning the response.
  await __nimbusFlushRuntime();
  const response = await globalThis.__nimbusServeHttp(req);
  try {
    await __nimbusFlushRuntime();
  } catch (e) {
    try { await response.body?.cancel(); } catch {}
    throw e;
  }
  return response;
}

let __nimbusStartArgs = null;

export class NimbusProcess extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Its write log is kept in its own store (process-fs-journal.ts).
    globalThis.__nimbusFsJournalSql = ctx.storage.sql;
  }

  async startProcess(startArgs) {
    // Held so an HTTP-first entry (a restart re-entered by a routed request)
    // starts from the same payload startProcess would have used.
    if (startArgs) __nimbusStartArgs = startArgs;
    await __nimbusEnsureStarted(this.env, this.ctx, __nimbusStartArgs);
    // A boot after a stop that finished before the read it stopped at did
    // not retrace the boot before it: it fails, loudly.
    const __replayShort = __nimbusStopReplay.booted();
    if (__replayShort) throw new Error(__replayShort);
    // Booted: what it does from now on is a running server's, and the
    // coordinator boots a resident again only while it is starting.
    __nimbusStopReplay.unreplayable("had already started, and Nimbus runs a resident again only while it boots");
    if (__nimbusAttachedLifecycle) await __nimbusAttachedLifecycle;
    // What this facet's database holds now, and the cap its store keeps
    // under, for the session's storage ledger (N18).
    let databaseSize;
    try { databaseSize = this.ctx.storage.sql.databaseSize; } catch {}
    let storageCap = null;
    try { storageCap = __resident.admission.storageCap(); } catch {}
    return { ok: true, databaseSize, storageCap };
  }
  async fetch(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
  async handleHttpRequest(req) { return __nimbusDispatchHttp(req, this.env, this.ctx); }
}
`;
  return {
    source,
    get code() { return source.text; },
    immutableModules: runtime.immutableModules,
    modules: bundleSource.modules,
    codeModules: { ...bundleSource.codeModules, ...runtime.modules, ...entry.modules },
    esModules: bundleSource.esModules,
  };
}

// ── VFS bundler ─────────────────────────────────────────────────────────

/**
 * Result of preparing facet VFS state.
 *   - bundle:   path → content for the complete static require closure
 *               plus bounded optional snapshot enrichment for dynamic
 *               requires and synchronous filesystem reads. Required files
 *               are never removed to satisfy an enrichment budget.
 *

 * The process's view of names and stats is the namespace its store boots on
 * (vfs/resident), never a spawn-time table.
 */
type FacetVfsDenial = { error: 'EACCES' };
type FacetVfsBundle = Record<string, string | Uint8Array | FacetVfsDenial>;

/** A launch's staged ES modules in numbers, for its debug line: counts, and characters of each part. */
function esmStageSize(esm: EsmStage): Record<string, number> {
  // Counted, not serialized: every build takes it, a launch over pi's 1074 modules included.
  let text = 0;
  let columns = 0;
  for (const staged of esm.modules.values()) {
    text += staged.text.length;
    columns += staged.columns.length;
  }
  let members = 0;
  for (const member of Object.values(esm.members)) members += member.length;
  return { ms: esm.ms, modules: esm.modules.size, rows: esm.table.length, missing: esm.missing.length, text, columns, members };
}

/** A launch's per-module costs, for its exec telemetry record. */
function execBreakdown(state: { cacheHit?: boolean; transforms?: BundleCellTransformStats; esmSize?: Record<string, number>; phases?: Record<string, number>; reachableCount?: number; rawBytes?: number }): Pick<ExecTelemetryRecord, 'transforms' | 'esm' | 'phases' | 'closure'> {
  // A cache hit built nothing: the numbers are the launch that built it.
  if (state.cacheHit) return {};
  const t = state.transforms;
  return {
    ...(t ? { transforms: { cells: t.cells, stored: t.stored, transformed: t.transformed, hostBytes: t.hostBytes, ms: t.ms } } : {}),
    ...(state.esmSize ? { esm: state.esmSize } : {}),
    ...(state.phases ? { phases: state.phases } : {}),
    ...(state.reachableCount !== undefined ? { closure: { files: state.reachableCount, bytes: state.rawBytes ?? 0 } } : {}),
  };
}

/**
 * What a module map costs the facet's store that adopts it (N18), as the store
 * charges itself (vfs/resident cell-cost.ts). A denial is a head row only; a
 * code-only file is none.
 */
function moduleMapStorageBytes(bundle: FacetVfsBundle, codeOnly?: ReadonlySet<string>): number {
  let bytes = 0;
  for (const [path, cell] of Object.entries(bundle)) {
    if (codeOnly?.has(path)) continue;
    bytes += typeof cell === 'string' || cell instanceof Uint8Array ? residentCellCost(cell) : 2 * LEDGER_ROW_BYTES;
  }
  return bytes;
}

interface FacetVfsState {
  /** The shared read profile's entries this launch was offered: staged ones, and those no regular file answered. */
  profileOffer?: { staged: StagedProfileEntry[]; unresolved: string[] };
  // hardening-r5: bundle cells may be Uint8Array for binary content
  // (images, wasm modules, sqlite blobs, etc.). Pre-fix every cell was
  // forced through vfs.readFileString() which UTF-8-decoded binary
  // bytes ≥ 0x80 to U+FFFD; the JSON-embedded module form then
  // serialized U+FFFD as 3 bytes (EF BF BD), and a cross-process
  // read returned 3× the original byte count. See
  // for the canonical 256→512 byte demo.
  bundle: FacetVfsBundle;
  /**
   * The module of each cell a transform changed, by its path: esbuild's emit
   * for a TypeScript source or an ES module, a CommonJS file with its
   * dynamic import() calls rewritten, a diagnostic shim. It becomes the
   * path's module cell, while `bundle` keeps the file a program reads (a
   * code-only file's cell holds the emit: the file is not carried). A cell
   * with none is its own module.
   */
  emits?: Map<string, string>;
  /**
   * The ES modules the map carries, staged (esm-stage.ts): each its own
   * module, which is never also in `emits`. Every other code cell is
   * CommonJS as Node would run it.
   */
  esm?: EsmStage;
  /** Its size and time in numbers (esmStageSize), kept past its release: the launch's debug line. */
  esmSize?: Record<string, number>;
  /** ES modules carried as files only, never as modules of the map: only the passes that carry files to be read staged them. */
  dataModules?: Set<string>;
  /** Where its build's time went, by phase, in ms (the walk, enrichment, transforms, fitting, staging, the rest, serialization). */
  phases?: Record<string, number>;
  /**
   * The files staged only to run whose module is an emit: the map carries the
   * emit and not the file, which no read asked for. A synchronous read of one
   * is a miss the next launch stages, unless a data plan holds the file. Kept
   * past serialization, for the data plans.
   */
  codeOnly?: Set<string>;
  /** What the module map costs the facet's store, taken before its cells are released (N18). */
  moduleStorageBytes?: number;
  /**
   * The VFS cursor these cells were read at.
   *
   * Without it a facet's first ACQUIRE carries a null epoch, which the
   * authority can only answer with a poison — "drop everything" — so the
   * first timer, fetch or frame in every facet threw away the entire resident
   * set and tried to refetch it in one turn. Stamping the bundle with the
   * cursor it was actually built at makes that first ACQUIRE an ordinary
   * delta, which is what it always was.
   */
  cursor?: { epoch: string; rev: number };
  /** Diagnostics: how many files survived the cap (post-greedy-oversample). */
  reachableCount: number;
  /** Diagnostics: did the snapshot's raw-byte bound evict optional files? */
  truncated: boolean;
  /**
   * The raw bytes the snapshot's guard counted for the cells it kept: a
   * cell's file where the map carries it, and its emit. What a build again
   * under the ceiling on the map lowers its bound from (_rebuildUnderCeiling).
   */
  rawBytes?: number;
  /** This state's last one-shot map's owned bytes; a cache hit takes that share before generating it again. */
  oneShotMapBytes?: number;
  /** Diagnostics: how the build's transforms were answered. */
  transforms?: BundleCellTransformStats;
  /**
   * Modules the program reaches only through an \`import()\` (phase 2 of the
   * closure walk), which no static walk from the entry or a staged package
   * entry reaches: they evaluate only if that call runs. Their synchronous
   * reads are not planned at boot; the \`import()\` that evaluates them
   * fetches them first (lazyReadsByTarget).
   */
  lazyModules?: readonly string[];
  /** Each lazy module's lazy importers (PrefetchResult.edges, reversed, within lazyModules). */
  lazyImporters?: Readonly<Record<string, readonly string[]>>;
  /**
   * The modules the snapshot's bound evicted that name a synchronous call
   * (evictedReaders): modules the program may still load late, as runtime
   * code through an \`import()\`. The data plan puts what each reads in the
   * lazy-read table under its own path, for that import()'s closure walk to
   * fetch.
   */
  evictedReaders?: readonly string[];
  /** Telemetry: served from the prefetch-bundle cache (no VFS walk). */
  cacheHit?: boolean;
  /**
   * Identity of the bundle these cells came from, so a residency miss the
   * process reports can be filed against the exact build that missed. Carried
   * on the state rather than recomputed at the exec site, where the inputs
   * would have to be threaded through a second time and could drift.
   */
  bundleKey?: string;
  /**
   * Memoized Worker Loader source for the bundle. Oversized bundles are
   * split across bounded side modules so the complete require closure does
   * not exceed the main module's text-size ceiling.
   */
  bundleSource?: FacetVfsBundleSource;
  /**
   * The wasm images the closure holds, by path and content digest — see
   * `collectClosureWasmImages`. A launch stages each as a wasm map entry.
   */
  wasmImages?: readonly WasmImageRecord[];
  /**
   * Memoized `bundleUsesNodeSqlite(entryCode, bundle)`. Answered while the raw
   * cells are still in hand so `releaseSerializedSources` can drop them — it is
   * the only thing anything downstream still wanted them for.
   */
  usesNodeSqlite?: boolean;
  /**
   * Keys (`<name>@<version>`) of the staged napi binding builds the closure
   * requires (stagedBindingsRequiredBy), answered with `usesNodeSqlite`: the
   * launch carries each, and the main module registers them.
   */
  stagedBindings?: string[];
  /**
   * True once `releaseGeneratedSources` has dropped the serialized forms. The
   * state can still answer for its cursor, key and flags; it can no longer
   * generate a module map, and asking is an error rather than an empty map.
   */
  generatedSourcesReleased?: boolean;
  /**
   * Whether the prefetch cache is holding this state's serialized forms. A
   * refused entry belongs to the invocation that built it and nothing else,
   * which is what makes releasing it safe.
   */
  cacheRetained?: boolean;
  /** Every path the module map carries: the closure a resident launch plans its data from. */
  bundlePaths?: readonly string[];
}

/**
 * What a process's filesystem bundle is built for. The one-shot exec path
 * and the resident launch path differ in nothing else, so this is the whole
 * of what a caller hands `_buildProcessBundle`.
 */
interface ProcessBundleSpec {
  /** The script the process runs, when it runs a file; absent for `-e` code. */
  scriptPath: string | undefined;
  cwd: string;
  entryCode: string;
  /** The entry is an ES module (RuntimeRunOpts.esModule): `-e` or stdin code is staged as one (entryEsModuleKey). */
  esModule?: boolean;
  bundleProfile?: FacetBundleProfile;
  /** Whose scope the runtime runs an ES module in (RuntimeRunOpts.moduleScope): absent, Node's. */
  moduleScope?: ModuleScope;
  /** The program's own conditions, preloads and TypeScript options: the map is what it resolves, loads and compiles under them. */
  node?: Pick<NodeLaunch, 'conditions' | 'require' | 'import' | 'stripTypes' | 'transformTypes' | 'enableSourceMaps'>;
  /**
   * The raw bytes the walked modules may take, for a launch whose map was
   * over the ceiling on it with none of its learned code
   * (_rebuildUnderCeiling): walked again under it, what earlier runs
   * executed as optional roots, never served from the cache.
   */
  maxBundleBytes?: number;
}

/**
 * Drop the raw forms of everything that has been serialized, in place.
 *
 * `bundleSource` is a total encoding of `bundle`: no caller can distinguish
 * a state carrying both from one carrying only the serialized half, because
 * both facet generators read the serialized half and nothing else does.
 * Holding both doubles the cost of a cached entry for its whole lifetime, and
 * that lifetime spans execs.
 *
 * Applied by `_buildProcessBundle` to every state it builds, whether or not
 * the entry turns out small enough to retain: the launch being served reads
 * the serialized forms too. `_stageOpencodeFacet` builds its own uncached
 * state and genuinely re-reads the raw cells
 * (`assertStagedBundleFitsRpcPayload`); it does not go through here.
 */
export function releaseSerializedSources(vfsState: FacetVfsState): void {
  if (!vfsState.bundleSource) return;
  vfsState.bundle = {};
  vfsState.emits = undefined;
  vfsState.esm = undefined;
}

/**
 * Drop the serialized forms once a module map has been generated from them.
 *
 * The generated source is a total encoding of it: every byte of the bundle
 * expression is inside it. Holding them
 * afterwards keeps a second copy of the largest thing this DO builds alive for
 * as long as the facet runs — for pi, 22.7 MB across the ~20 s window in which
 * the isolate was being reset. For the one-shot path that window is the run;
 * for a resident launch — the path every attached-TTY npm bin takes, how a
 * real agentic CLI starts — it is the boot, and holding the copy across it
 * reset the session isolate with exceededMemory, which tears the terminal
 * WebSocket down with no exit frame: the dead screen reading "[process
 * terminal closed]".
 *
 * Only for a state the prefetch cache refused. A retained entry's serialized
 * forms ARE the entry, and a later launch is served from them. An emptied
 * state could still generate a map — one with no program in it — so this
 * marks the state instead of trusting callers to stop.
 */
export function releaseGeneratedSources(vfsState: FacetVfsState): void {
  vfsState.bundleSource = undefined;
  vfsState.generatedSourcesReleased = true;
}

// ── The ceiling on a module map ─────────────────────────────────────────────
//
// A dynamic Worker's module map is refused past DYNAMIC_WORKER_CODE_LIMIT_BYTES
// (fabric budgets.ts), a total every member shares: the main module, the data
// and code modules, the wasm images, the staged bindings and the sidecars.
// What a map must carry is its program's closure and the runtime. What earlier
// runs learned rides beside them as far as the ceiling allows: an astro
// project's second `astro dev` carried its first run's runtime code beside
// 39.4 MB of wasm, and its map, 68.5 MB, was refused at facet start.

/**
 * A launch's map is over the ceiling with none of the runtime code earlier
 * runs learned in it, by `over` bytes: its walked modules take it there. The
 * launch is built again once under a bound that much lower
 * (_rebuildUnderCeiling); a map still over fails the launch here, by name,
 * before any of it is stored or loaded.
 */
export class ModuleMapOverCeilingError extends Error {
  constructor(readonly over: number) {
    super(`Nimbus: the module map is ${(DYNAMIC_WORKER_CODE_LIMIT_BYTES + over).toLocaleString('en-US')} bytes without `
      + `the code earlier runs learned, over the ${DYNAMIC_WORKER_CODE_LIMIT_BYTES.toLocaleString('en-US')}-byte `
      + 'platform ceiling shared by every member');
    this.name = 'ModuleMapOverCeilingError';
  }
}

/**
 * The UTF-8 bytes of a generated map's text (its main module, data modules
 * and code modules), as the platform counts them; null when they cannot
 * reach `room`. Text of N UTF-16 units is at most 3N bytes, so a map that
 * small is answered without being read.
 */
export function generatedMapTextBytes(generated: GeneratedNodeFacetCode, room: number): number | null {
  const sharedBytes = generated.source.byteLength + Object.values(generated.immutableModules).reduce((bytes, source) => bytes + source.byteLength, 0);
  const texts = [...Object.values(generated.modules), ...Object.values(generated.codeModules), ...Object.values(generated.esModules)];
  let units = 0;
  for (const text of texts) units += text.length;
  if (sharedBytes + units * 3 <= room) return null;
  let bytes = sharedBytes;
  for (const text of texts) bytes += utf8Length(text);
  return bytes;
}

/** What the map owns in V8; immutable runtime sources are shared by every launch. */
function generatedMapRetainedBytes(generated: GeneratedNodeFacetCode | null, members: Readonly<Record<string, string | { wasm: ArrayBuffer }>>): number {
  let bytes = 0;
  const texts = generated === null ? [] : [...generated.source.parts.filter((part) => typeof part === 'string'),
    ...Object.values(generated.modules), ...Object.values(generated.codeModules), ...Object.values(generated.esModules)];
  for (const member of Object.values(members)) {
    if (typeof member === 'string') texts.push(member);
    else bytes += member.wasm.byteLength;
  }
  for (const text of texts) {
    bytes += text.length * (/[^\u0000-\u00ff]/.test(text) ? 2 : 1);
  }
  return bytes;
}

/**
 * The learned runtime code (`gen/<key>.js`) a map of `bytes` keeps under
 * `room`: in the order its runs first needed it (the guest's ledger, kept by
 * the launch's profile), each piece that still fits beside what the map holds
 * without any of it. `learned` is each piece's key and module bytes; a piece
 * also costs its key in the main module's list of staged keys (`"<key>"`, and
 * a comma after the first). `over` is what the map holds past `room` with
 * none of it. What is not kept runs as it did in the run that learned it:
 * interpreted (core/_shared/commonjs-cell.ts, RUNTIME CODE).
 */
export function learnedRuntimeCodeWithin(
  bytes: number,
  learned: ReadonlyArray<readonly [key: string, bytes: number]>,
  room: number,
): { kept: string[]; over: number } {
  let held = bytes - Math.max(0, learned.length - 1);
  for (const [key, size] of learned) held -= size + key.length + 2;
  const over = Math.max(0, held - room);
  const kept: string[] = [];
  for (const [key, size] of learned) {
    const cost = size + key.length + 2 + (kept.length > 0 ? 1 : 0);
    if (held + cost > room) continue;
    held += cost;
    kept.push(key);
  }
  return { kept, over };
}

/** What a map's members hold that are not its generated text: sidecars and staged bindings by value. */
function moduleMemberBytes(members: Readonly<Record<string, string | { wasm: ArrayBuffer }>>): number {
  let bytes = 0;
  for (const member of Object.values(members)) bytes += typeof member === 'string' ? utf8Length(member) : member.wasm.byteLength;
  return bytes;
}

/** The entry the one-shot host adds to a map (fabric workerd-facet-host.ts oneShotEntry, about 600 bytes): at most this. */
const ONE_SHOT_HOST_ENTRY_BYTES = 4096;

/**
 * How long a one-shot's launch may wait at one stage before it says so, once
 * (FacetManager._launchStage). A user's command that hangs before it runs
 * leaves only Workers Logs behind: no session to read _diag from.
 */
const LAUNCH_STALL_MS = 10_000;

/** How much of a stalled launch's command its report carries: a command line can be any length, and a log line has a budget. */
const LAUNCH_STALL_COMMAND_CHARS = 200;

type LaunchStage = 'prepare' | 'admission' | 'load';

/** A resident's staged napi bindings: the shared loader's text, the trampoline by value, each build by path. */
interface ResidentStagedBindings {
  loader: string;
  trampoline: ArrayBuffer;
  bindingPaths: Record<string, string>;
}

/**
 * The module-map source for a state, memoized form first.
 *
 * A released state has neither form left, and rebuilding from its emptied raw
 * cells would silently generate a module map with no modules in it — which
 * surfaces inside the facet as "Cannot find module" for the whole require
 * closure, a long way from the cause. Say so here instead.
 */
async function facetVfsBundleSourceFor(
  vfsState: FacetVfsState,
  pacer?: TurnBudget,
): Promise<FacetVfsBundleSource> {
  if (vfsState.generatedSourcesReleased) {
    throw new Error(
      'Nimbus: this facet VFS state was released after its module map was generated; '
        + 'it cannot generate a second one',
    );
  }
  return vfsState.bundleSource
    ?? await buildFacetVfsBundleSource(
      vfsState.bundle, pacer,
      { emits: vfsState.emits, esm: vfsState.esm, codeOnly: vfsState.codeOnly, dataModules: vfsState.dataModules },
    );
}

interface FacetVfsBundleSource {
  /** The data cells: an inline expression, or one joining the side modules. */
  expression: string;
  imports: string;
  modules: Record<string, string>;
  /** The code cells as `{ cjs }` module texts, by module name. */
  codeModules: Record<string, string>;
  /** The staged ES modules and what they link to, as `{ js }` module texts, by module name (esm-stage.ts). */
  esModules: Record<string, string>;
  /** The JSON of the launch's CommonJsCellRow table. */
  codeCells: string;
  /** The JSON of the launch's ES module table and refusals (esm-stage.ts EsmStage), or `null`. */
  esm: string;
  /** The JSON list of runtime-code keys the map carries as `gen/<key>.js`. */
  runtimeCode: string;
  /**
   * What the process's store charges itself to adopt the data cells and the
   * code cells it reads back (vfs/resident residentCellCost).
   */
  storageBytes: number;
}

/**
 * hardening-r5: read a file from the VFS as a cell (fileCell): a string when
 * it is valid UTF-8 (source code, package.json, configs), every byte kept, a
 * leading byte order mark too, so the string round-trips losslessly; else
 * its Uint8Array bytes (wasm modules, images, sqlite blobs).
 *
 * Throws on read errors (caller wraps in try/catch — matches the
 * pre-fix readFileString contract).
 */
async function _readBundleCell(
  vfs: LaunchFs,
  path: string,
): Promise<string | Uint8Array> {
  const bytes = await filesOf(vfs).readBytes(path);
  if (bytes === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT', path });
  return fileCell(bytes);
}

/**
 * hardening-r5: byte-length of a bundle cell for budget accounting.
 * Strings counted as char-length (a slight under-count for non-ASCII
 * but matches the pre-fix behaviour); Uint8Array counted as byteLength.
 */
/** A cell's raw bytes: UTF-8 for text, as the file is on disk. */
function _bundleCellRawBytes(cell: FacetVfsBundle[string]): number {
  if (cell instanceof Uint8Array) return cell.byteLength;
  return typeof cell === 'string' ? utf8Length(cell) : 0;
}

function _bundleCellLength(cell: string | Uint8Array): number {
  return typeof cell === 'string' ? cell.length : cell.byteLength;
}

/**
 * Pre-read admission check for a bundle candidate: refuse BEFORE reading
 * when the file's on-disk size already exceeds the remaining bundle budget
 * or the caller's per-file ceiling. Without this every helper read a file
 * in full, then discarded it when the post-read `cellLen` check tripped —
 * on trees with several 5–10 MiB artifacts that read alone was the memory
 * pressure that reset the isolate.
 *
 * `perFileCeiling` is the pass's own cap (e.g. CWD_SNAPSHOT_MAX_FILE_BYTES,
 * BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES); omit it for budget-only checks.
 */
async function _bundleAdmits(
  vfs: LaunchFs,
  path: string,
  budgetState: { totalBytes: number },
  perFileCeiling?: number,
): Promise<boolean> {
  const stat = await filesOf(vfs).lstat(path).catch(() => null);
  if (stat === null) return false;
  const size = stat.size;
  if (perFileCeiling !== undefined && size > perFileCeiling) return false;
  return budgetState.totalBytes + size <= VFS_BUNDLE_MAX_BYTES;
}

/** What a bundle currently weighs, and so what one more pass over it costs. */
function _bundleWeight(bundle: Record<string, string | Uint8Array>): number {
  let weight = 0;
  for (const cell of Object.values(bundle)) weight += _bundleCellLength(cell);
  return weight;
}

type BundleCellSize = [path: string, bytes: number];

/**
 * Supervisor-heap cost of a FacetVfsState the prefetch LRU is holding on to.
 *
 * `releaseSerializedSources` normally leaves only the serialized source,
 * manifest and metadata behind. Every representation actually present is
 * counted anyway, so the bound stays correct if that release policy changes:
 * counting only the raw cells would under-report a both-forms entry by about
 * half, which is how a count-bounded LRU came to look affordable.
 */
function retainedVfsStateBytes(state: FacetVfsState): number {
  let bytes = 0;
  for (const [path, cell] of Object.entries(state.bundle)) {
    bytes += path.length;
    if (typeof cell === 'string' || cell instanceof Uint8Array) bytes += _bundleCellLength(cell);
  }
  for (const [path, emit] of state.emits ?? []) bytes += path.length + emit.length;
  for (const path of state.codeOnly ?? []) bytes += path.length;
  const source = state.bundleSource;
  if (source) {
    bytes += source.expression.length + source.imports.length + source.codeCells.length + source.runtimeCode.length;
    for (const moduleSource of Object.values(source.modules)) bytes += moduleSource.length;
    for (const [name, text] of Object.entries(source.codeModules)) bytes += name.length + text.length;
    for (const [name, text] of Object.entries(source.esModules)) bytes += name.length + text.length;
    bytes += source.esm.length;
  } else if (state.esm) {
    for (const [key, staged] of state.esm.modules) bytes += key.length + staged.text.length + staged.columns.length * 16;
    for (const [name, text] of Object.entries(state.esm.members)) bytes += name.length + text.length;
  }
  return bytes;
}

/**
 * UTF-8 byte length of `JSON.stringify(value)`, computed without building
 * the string: a source cell can be megabytes on its own, and sizing a
 * generated source never allocates a second copy of anything in it.
 */
function _jsonEncodedBytes(value: string): number {
  let bytes = 2; // the surrounding quotes
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) { bytes += 2; continue; }          // " \
    if (code < 0x20) {
      // \b \t \n \f \r get a two-character escape; every other C0 gets \u00XX.
      bytes += (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) ? 2 : 6;
      continue;
    }
    if (code < 0x80) { bytes += 1; continue; }
    if (code < 0x800) { bytes += 2; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      // A well-formed pair is one 4-byte code point; a lone surrogate is
      // escaped as \uXXXX (JSON.stringify is well-formed since ES2019).
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } else { bytes += 6; }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 6; continue; }
    bytes += 3;
  }
  return bytes;
}

/**
 * Bounded `path (N bytes)` listing, largest first. A snapshot diagnostic has
 * to name the files it is talking about — the facet's own error for a missing
 * one is an unattributable "Cannot find module" — without printing a bundle
 * that can run to thousands of entries.
 */
function describeBundleCells(cells: BundleCellSize[], limit = 8): string {
  const shown = [...cells].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const rest = cells.length - shown.length;
  return shown.map(([path, bytes]) => `${path} (${bytes} bytes)`).join(', ') + (rest > 0 ? `, +${rest} more` : '');
}

/**
 * JSON data as the JavaScript expression that evaluates to it: its JSON text,
 * except that an own `__proto__` key is written computed (`["__proto__"]`),
 * since in an object literal `"__proto__":` sets the prototype instead of
 * making the key. Data without one is its JSON text, byte for byte, so the
 * counters that size generated sources from JSON encodings stay exact.
 */
function jsonDataLiteral(value: unknown): string {
  return holdsProtoKey(value) ? dataLiteral(JSON.parse(JSON.stringify(value))) : JSON.stringify(value);
}

function holdsProtoKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.hasOwn(value, '__proto__')) return true;
  return Object.values(value).some(holdsProtoKey);
}

/** Parsed JSON data as `jsonDataLiteral` writes it. */
function dataLiteral(data: unknown): string {
  if (data === null || typeof data !== 'object') return JSON.stringify(data);
  if (Array.isArray(data)) return `[${data.map(dataLiteral).join(',')}]`;
  return `{${Object.entries(data).map(([key, item]) => `${key === '__proto__' ? '["__proto__"]' : JSON.stringify(key)}:${dataLiteral(item)}`).join(',')}}`;
}

/** Bytes a bundle key costs the generated source: its JSON text, computed when it is `__proto__`. */
function _bundleKeyBytes(path: string): number {
  return _jsonEncodedBytes(path) + (path === '__proto__' ? 2 : 0);
}

/**
 * hardening-r5: emit a JS expression that revives binary cells from base64
 * and preserves permission-denial cells alongside ordinary strings.
 *
 * The output is a SELF-EXECUTING IIFE expression so it can be substituted
 * directly into `const __MODULE_VFS_BUNDLE = ${expr};` template slots.
 */
function _serializeBundleForFacet(bundle: FacetVfsBundle): string {
  const strCells: Record<string, string> = {};
  const binCells: Record<string, string> = {};
  Object.setPrototypeOf(strCells, null);
  Object.setPrototypeOf(binCells, null);
  const deniedPaths: string[] = [];
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v === 'string') {
      strCells[k] = v;
    } else if (v instanceof Uint8Array) {
      // Uint8Array → base64. btoa requires a binary string; we build it
      // 8K chars at a time to avoid String.fromCharCode argument-count
      // limits on large files (~1MB+).
      let bin = '';
      const CHUNK = 8192;
      for (let i = 0; i < v.byteLength; i += CHUNK) {
        bin += String.fromCharCode.apply(
          null,
          Array.from(v.subarray(i, Math.min(i + CHUNK, v.byteLength))),
        );
      }
      binCells[k] = btoa(bin);
    } else {
      deniedPaths.push(k);
    }
  }
  // The IIFE revives binary cells in-place. atob → binary string →
  // Uint8Array (Uint8Array.from(str, c=>c.charCodeAt(0))).
  return `(function(){const __b=${jsonDataLiteral(strCells)};Object.setPrototypeOf(__b,null);const __x=${jsonDataLiteral(binCells)};const __d=${JSON.stringify(deniedPaths)};for(const __k in __x){__b[__k]=Uint8Array.from(atob(__x[__k]),__c=>__c.charCodeAt(0));}for(const __k of __d){__b[__k]={error:"EACCES"};}return __b;})()`;
}

const FACET_VFS_MODULE_PREFIX = '__nimbus_vfs_bundle_';
const FACET_VFS_MODULE_SOURCE_MARGIN = 1024;

function _facetBundleModuleSource(bundle: FacetVfsBundle): string {
  return `export default ${_serializeBundleForFacet(bundle)};`;
}

/**
 * Byte cost of the serializer's fixed scaffolding: the IIFE and the three
 * empty literals it always emits, with and without the `export default …;`
 * a side module wraps it in. Measured off the serializer itself so the
 * counts and the thing they count cannot drift.
 */
const _FACET_INLINE_ENVELOPE_BYTES = utf8Length(_serializeBundleForFacet({}));
const _FACET_MODULE_ENVELOPE_BYTES = utf8Length(_facetBundleModuleSource({}));

/**
 * What one cell adds to a generated bundle source, counted rather than built.
 *
 * `_serializeBundleForFacet` sorts a cell into one of three literals — the
 * text map, the base64 map, or the denied-path array — and each is a plain
 * JSON encoding, so a cell's contribution is additive and knowable without
 * materializing anything. Base64 is pure ASCII of a length fixed by the
 * source byte count, so a binary cell can be sized without being encoded.
 *
 * Sizing a bundle used to mean serializing it: the caller built the whole
 * 22.9 MB source, read `.length` off it, and threw it away — three times per
 * pi launch, once whole and twice more per-cell inside the split loop.
 */
function _facetBundleCellBytes(path: string, cell: FacetVfsBundle[string]): number {
  if (typeof cell === 'string') {
    return _bundleKeyBytes(path) + 1 + _jsonEncodedBytes(cell);
  }
  if (cell instanceof Uint8Array) {
    return _bundleKeyBytes(path) + 1 + 4 * Math.ceil(cell.byteLength / 3) + 2;
  }
  // A denial cell rides in the path array, which carries no key.
  return _jsonEncodedBytes(path);
}

/** Encoded size of the inline bundle expression, without building it. */
function _inlineBundleSourceBytes(bundle: FacetVfsBundle): number {
  let bytes = _FACET_INLINE_ENVELOPE_BYTES;
  const counts = { str: 0, bin: 0, denied: 0 };
  for (const [path, cell] of Object.entries(bundle)) {
    bytes += _facetBundleCellBytes(path, cell);
    if (typeof cell === 'string') counts.str++;
    else if (cell instanceof Uint8Array) counts.bin++;
    else counts.denied++;
  }
  // One separator between siblings in each of the three literals.
  for (const n of Object.values(counts)) if (n > 1) bytes += n - 1;
  return bytes;
}

/**
 * Whether a bundle cell at `path` is one the process can require as code:
 * `.js`, `.mjs`, `.cjs`, and extensionless files — the shape of nearly every
 * npm `bin` script. A TypeScript source is code through its emit instead.
 */
function isCodeCellPath(path: string): boolean {
  const ext = vfsPathExtension(path);
  return ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '';
}

/**
 * Serialize a VFS bundle for Worker Loader without dropping required files.
 *
 * Every code cell becomes its own `{ cjs }` module (commonjs-cell.ts), which
 * the guest's registry compiles the first time the program requires it. A
 * file that is its own module is carried once, as that module: the process's
 * store adopts the file by reading the module back, so the cell is never also
 * data — except where the read-back cannot name it (commonJsCellReadsBack).
 * A cell whose module is an emit (a transform changed it) is never read back,
 * since the emit is not the file: its file is data when it was staged to be
 * read, or is not carried at all (`codeOnly`).
 *
 * The data cells stay one bundle. Small bundles remain inline. Large bundles
 * are partitioned into side modules below the existing per-module encoded
 * ceiling and merged during module evaluation. A single oversized cell is
 * split into ordered fragments; the merge expression concatenates those
 * fragments back to the original string or Uint8Array.
 */
export async function buildFacetVfsBundleSource(
  bundle: FacetVfsBundle,
  pacer?: TurnBudget,
  {
    consume = false,
    emits,
    esm,
    codeOnly,
    dataModules,
    runtimeCode,
  }: {
    consume?: boolean;
    /** The module of each cell a transform changed (FacetVfsState.emits). */
    emits?: ReadonlyMap<string, string>;
    /** The staged ES modules (FacetVfsState.esm). */
    esm?: EsmStage;
    /** Files whose emit the map carries and not the file (FacetVfsState.codeOnly). */
    codeOnly?: ReadonlySet<string>;
    /** ES modules carried as files only (FacetVfsState.dataModules): never a `{ cjs }` module. */
    dataModules?: ReadonlySet<string>;
    /** Runtime code staged for this launch: `{ cjs }` module text by key. */
    runtimeCode?: ReadonlyMap<string, string>;
  } = {},
): Promise<FacetVfsBundleSource> {
  const storageBytes = moduleMapStorageBytes(bundle, codeOnly);
  const codeModules: Record<string, string> = {};
  const esModules: Record<string, string> = { ...esm?.members };
  const rows: CommonJsCellRow[] = [];
  for (const [key, text] of runtimeCode ?? []) codeModules[runtimeCodeModuleName(key)] = text;
  // The facades' names, read only by a graph a program produces after its launch began (core esm-late-link.ts).
  if (esm !== undefined) codeModules[ESM_BINDINGS_MODULE] = JSON.stringify(esm.bindings);
  // An ES module's text is never its file's (its prologue, its specifiers):
  // the map carries the file beside it, when it carries the file.
  for (const [key, staged] of esm?.modules ?? []) {
    const name = commonJsCellModuleName(key);
    esModules[name] = staged.text;
    if (staged.columns.length > 0) codeModules[columnMapModuleName(name)] = JSON.stringify(staged.columns);
    rows.push([key, name, staged.head, staged.tail, staged.hashbang ? 1 : 0, 0, 1]);
    if (pacer) await pacer.spend(staged.text.length);
  }
  // `consume`: the caller releases the raw cells right after (a launch's
  // build), so each is taken as its module is written and the map is never
  // held twice. Otherwise the caller's bundle is left as it was.
  const data: FacetVfsBundle = consume ? bundle : {};
  Object.setPrototypeOf(data, null);
  for (const path of Object.keys(bundle)) {
    const cell = bundle[path];
    const emit = emits?.get(path);
    const staged = esm?.modules.has(path) === true || dataModules?.has(path) === true;
    const code = staged ? undefined : emit ?? (typeof cell === 'string' && isCodeCellPath(path) ? cell : undefined);
    const adopt = code !== undefined && emit === undefined && commonJsCellReadsBack(path);
    if (code !== undefined) {
      const wrapped = wrapCommonJsCell(code);
      const name = commonJsCellModuleName(path);
      codeModules[name] = wrapped.text;
      rows.push([path, name, wrapped.head, wrapped.tail, wrapped.hashbang ? 1 : 0, adopt ? 1 : 0, 0]);
      if (pacer) await pacer.spend(code.length);
    }
    if (adopt || codeOnly?.has(path)) {
      if (consume) delete bundle[path];
    } else if (!consume) {
      data[path] = cell;
    }
  }
  return {
    ...await serializeFacetVfsData(data, pacer, consume),
    codeModules,
    esModules,
    codeCells: JSON.stringify(rows),
    esm: esm === undefined ? 'null' : JSON.stringify({ table: esm.table, missing: esm.missing }),
    runtimeCode: JSON.stringify([...(runtimeCode?.keys() ?? [])]),
    storageBytes,
  };
}

async function serializeFacetVfsData(
  bundle: FacetVfsBundle,
  pacer: TurnBudget | undefined,
  consume: boolean,
): Promise<Pick<FacetVfsBundleSource, 'expression' | 'imports' | 'modules'>> {
  // Consumed, side modules always: an inline expression is copied again into
  // the runner's own source. Otherwise the inline form is sized before it is
  // built: a bundle that will be split has no use for the whole-bundle
  // expression, and building one to read its length off cost a second full
  // copy of the largest string this DO makes.
  if (!consume && _inlineBundleSourceBytes(bundle) <= BUNDLE_MAX_ENCODED_BYTES) {
    return { expression: _serializeBundleForFacet(bundle), imports: '', modules: {} };
  }
  if (Object.keys(bundle).length === 0) {
    return { expression: _serializeBundleForFacet(bundle), imports: '', modules: {} };
  }

  const maxModuleBytes = BUNDLE_MAX_ENCODED_BYTES - FACET_VFS_MODULE_SOURCE_MARGIN;
  type BundlePiece = [path: string, cell: FacetVfsBundle[string]];

  function sourceBytes(path: string, cell: FacetVfsBundle[string]): number {
    return _FACET_MODULE_ENVELOPE_BYTES + _facetBundleCellBytes(path, cell);
  }

  function splitCell(path: string, cell: FacetVfsBundle[string]): BundlePiece[] {
    if (sourceBytes(path, cell) <= maxModuleBytes) return [[path, cell]];
    if (typeof cell !== 'string' && !(cell instanceof Uint8Array)) {
      throw new Error(`Nimbus: VFS denial cell path exceeds facet module limit: ${path}`);
    }

    const pieces: BundlePiece[] = [];
    let offset = 0;
    while (offset < cell.length) {
      let low = 1;
      let high = cell.length - offset;
      let fittingLength = 0;
      while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = typeof cell === 'string'
          ? cell.slice(offset, offset + middle)
          : cell.subarray(offset, offset + middle);
        if (sourceBytes(path, candidate) <= maxModuleBytes) {
          fittingLength = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (fittingLength === 0) {
        throw new Error(`Nimbus: VFS bundle path exceeds facet module limit: ${path}`);
      }
      const fragment = typeof cell === 'string'
        ? cell.slice(offset, offset + fittingLength)
        : cell.subarray(offset, offset + fittingLength);
      pieces.push([path, fragment]);
      offset += fittingLength;
    }
    return pieces;
  }

  const modules: Record<string, string> = {};
  const imports: string[] = [];
  const aliases: string[] = [];
  let chunk: FacetVfsBundle = {};
  Object.setPrototypeOf(chunk, null);
  let chunkPaths: string[] = [];
  let estimatedBytes = 0;

  // A chunk becomes its side module the moment it is full, so the cells it
  // carries and their serialization are never both held for the whole map:
  // consumed, a cell leaves the bundle as its module is written.
  async function flushChunk(): Promise<void> {
    // Pieces of a split cell fill chunks before the cell's path is complete,
    // so emptiness is the chunk's own, not its finished paths'.
    if (estimatedBytes === 0) return;
    const index = aliases.length;
    const moduleName = `${FACET_VFS_MODULE_PREFIX}${index}.js`;
    const alias = `__nimbusVfsBundle${index}`;
    const source = _facetBundleModuleSource(chunk);
    if (utf8Length(source) > BUNDLE_MAX_ENCODED_BYTES) {
      throw new Error(`Nimbus: generated VFS side module exceeds encoded limit: ${moduleName}`);
    }
    modules[moduleName] = source;
    imports.push(`import ${alias} from "${moduleName}";`);
    aliases.push(alias);
    if (consume) for (const path of chunkPaths) delete bundle[path];
    chunk = {};
    Object.setPrototypeOf(chunk, null);
    chunkPaths = [];
    estimatedBytes = 0;
    // Each side module is an independent serialization of its own cells, so
    // the turn may end between any two of them.
    if (pacer) await pacer.spend(source.length);
  }

  for (const path of Object.keys(bundle)) {
    const cell = bundle[path];
    for (const [piecePath, pieceCell] of splitCell(path, cell)) {
      const pieceBytes = sourceBytes(piecePath, pieceCell);
      if (
        piecePath in chunk
        || (estimatedBytes > 0 && estimatedBytes + pieceBytes > maxModuleBytes)
      ) {
        await flushChunk();
      }
      chunk[piecePath] = pieceCell;
      estimatedBytes += pieceBytes;
    }
    chunkPaths.push(path);
  }
  await flushChunk();

  const expression =
    `(function(__parts){const __out=Object.create(null);for(const __part of __parts){` +
    `for(const [__k,__v] of Object.entries(__part)){const __prev=__out[__k];` +
    `if(__prev===undefined){__out[__k]=__v;}` +
    `else if(typeof __prev==="string"&&typeof __v==="string"){__out[__k]=__prev+__v;}` +
    `else if(__prev instanceof Uint8Array&&__v instanceof Uint8Array){` +
    `const __joined=new Uint8Array(__prev.length+__v.length);__joined.set(__prev);` +
    `__joined.set(__v,__prev.length);__out[__k]=__joined;}` +
    `else{throw new Error("Nimbus: invalid split VFS bundle cell: "+__k);}}}` +
    `return __out;})([${aliases.join(',')}])`;

  return {
    expression,
    imports: imports.join('\n'),
    modules,
  };
}

/**
 * A staged spec crosses the fabric as ONE RPC payload, so its snapshot has
 * no side-module relief: `MAX_RPC_SAFE_PAYLOAD_BYTES` is a hard physical
 * ceiling, not a policy knob that can be raised. Base64-reviving binary
 * cells inflates the serialized form ~4/3 over the raw bytes the snapshot's
 * guard measured, so the payload can clear that guard and still not fit.
 *
 * Fail here, naming the cells that dominate the snapshot. Shipping a
 * shortened one instead would surface inside the facet as an
 * unattributable ENOENT or "Cannot find module" — neither require() nor
 * readFileSync can go back to the supervisor for what was left out.
 */
export function assertStagedBundleFitsRpcPayload(
  serialized: string,
  bundle: FacetVfsBundle,
): void {
  const bytes = utf8Length(serialized);
  if (bytes <= MAX_RPC_SAFE_PAYLOAD_BYTES) return;
  const cells: BundleCellSize[] = Object.entries(bundle)
    .map(([path, cell]) => [
      path,
      typeof cell === 'string' || cell instanceof Uint8Array ? _bundleCellLength(cell) : 0,
    ]);
  throw new Error(
    `Nimbus: staged facet VFS snapshot serializes to ${bytes} bytes, over the `
      + `${MAX_RPC_SAFE_PAYLOAD_BYTES}-byte RPC payload ceiling. Largest members: `
      + `${describeBundleCells(cells)}`,
  );
}

/**
 * FNV-1a 32-bit hash, returned as an unsigned hex string. Used only to
 * fold the (possibly large) entry code into a compact, collision-resistant
 * prefetch-bundle cache-key component — not a security primitive.
 */
function _fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

const MANIFEST_MAX_DEPTH = 12;




/**
 * Greedy-oversample every installed package's main entry. The static
 * prefetch via require-resolver covers the require() chain literally
 * present in source; greedy oversampling adds a safety net for dynamic
 * patterns the regex misses (jest/`bindings`/`import-local` style
 * computed-path requires). Each guessed root brings its readable literal
 * closure as one optional admission/eviction unit, within the existing caps.
 *
 * `requiredPaths` is the static require closure. A package the closure
 * already reached — but reached only through a SUBPATH — has its main entry
 * skipped; see `mainIsSpeculative`.
 */
// can verify the hash-chunk + shared/ oversample directly. Pre-X.5-C this
// was a file-local helper. Adding the named export is a pure surface
// addition — no callers other than buildPrefetchBundle (same file) and
// the new probe.
interface OptionalModuleGroup {
  root: string;
  members: ReadonlySet<string>;
}

/**
 * What the size guard keeps of a snapshot over `bound` raw bytes: it drops
 * the `evictable` paths in order until what remains fits. A path is kept
 * while something holds it: `independent` (paths staged on their own), or a
 * kept group it is a member of. Evicting an independent path drops every
 * group that has it (a group missing a member cannot load); evicting a
 * group's root drops the group. `rawTotal` is the snapshot's bytes before any
 * eviction; each eviction leaves the bytes of what is still held.
 *
 * Each path's holders are counted once, and an eviction releases only what
 * it drops: the set used to be built again from every kept group after each
 * eviction, pacing all of it each time, and a pi launch evicting 530 to 838
 * files spent seconds of turns on it.
 */
export async function retainWithinBound(
  bound: number,
  rawTotal: number,
  independent: Set<string>,
  keptGroups: Set<OptionalModuleGroup>,
  evictable: readonly string[],
  rawBytes: ReadonlyMap<string, number>,
  pacer?: { spend(bytes: number): Promise<void> },
): Promise<{ retained: Set<string>; rawTotal: number }> {
  const holders = new Map<string, number>();
  const hold = (path: string) => holders.set(path, (holders.get(path) ?? 0) + 1);
  for (const path of independent) hold(path);
  for (const group of keptGroups) {
    let work = 0;
    for (const path of group.members) { hold(path); work += path.length + 256; }
    if (pacer) await pacer.spend(work);
  }
  let heldBytes = 0;
  for (const path of holders.keys()) heldBytes += rawBytes.get(path) ?? 0;
  const release = (path: string) => {
    const left = (holders.get(path) ?? 0) - 1;
    if (left > 0) { holders.set(path, left); return; }
    if (holders.delete(path)) heldBytes -= rawBytes.get(path) ?? 0;
  };
  const drop = async (group: OptionalModuleGroup) => {
    keptGroups.delete(group);
    let work = 0;
    for (const member of group.members) { release(member); work += member.length + 256; }
    if (pacer) await pacer.spend(work);
  };
  for (const path of evictable) {
    if (rawTotal <= bound) break;
    if (independent.delete(path)) {
      release(path);
      for (const group of [...keptGroups]) if (group.members.has(path)) await drop(group);
    } else {
      for (const group of [...keptGroups]) if (group.root === path) await drop(group);
    }
    rawTotal = heldBytes;
  }
  return { retained: new Set(holders.keys()), rawTotal };
}

export async function greedyAddMainEntries(
  vfs: LaunchFs,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
  requiredPaths: ReadonlySet<string> = new Set(),
  options: { maxBundleBytes?: number; pacer?: TurnBudget; conditions?: readonly string[] } = {},
): Promise<{ added: number; groups: OptionalModuleGroup[] }> {
  let added = 0;
  const groups: OptionalModuleGroup[] = [];
  const bound = Math.min(options.maxBundleBytes ?? VFS_BUNDLE_MAX_BYTES, VFS_BUNDLE_MAX_BYTES);
  const independent = new Set(Object.keys(bundle));
  let rawBytes = 0;
  for (const cell of Object.values(bundle)) rawBytes += _bundleCellRawBytes(cell);
  if (rawBytes >= bound) return { added, groups };
  const cwdStripped = cwd.replace(/^\/+/, '');
  const nmDir = cwdStripped + '/node_modules';
  if (!((await filesOf(vfs).exists(nmDir)) && (await filesOf(vfs).isDirectory(nmDir)))) return { added, groups };

  const exts = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs'];
  // What the admitted groups defer with `import()`; a group does not walk them.
  const deferred: DeferredImport[] = [];

  async function addOne(path: string): Promise<boolean> {
    const stripped = path.replace(/^\/+/, '');
    if ((isBundleModuleCandidate(stripped) || stripped.endsWith('.cjs')) && !isNativeBinPath(stripped)) {
      if (independent.has(stripped)) return false;
      if (bundle[stripped] === undefined && !(await _bundleAdmits(vfs, stripped, budgetState, BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES))) return false;
      const closure = await prefetchForRequire(filesOf(vfs), '', stripped.slice(0, stripped.lastIndexOf('/')),
        '/' + stripped, bound, options.pacer?.spend.bind(options.pacer), {
          purpose: 'dependency-closure', held: bundle,
          maxAdditionalBytes: Math.max(0, bound - rawBytes),
          maxAdditionalFiles: Math.max(0, VFS_BUNDLE_MAX_FILES - budgetState.fileCount),
        }, undefined, options.conditions);
      if ('kind' in closure || closure.bundle[stripped] === undefined) return false;
      for (const deferral of closure.deferred ?? []) if (deferral.alternatives === 1) deferred.push(deferral);
      for (const [member, cell] of Object.entries(closure.bundle)) {
        if (bundle[member] !== undefined) continue;
        bundle[member] = cell;
        rawBytes += _bundleCellRawBytes(cell);
        budgetState.totalBytes += _bundleCellLength(cell);
        budgetState.fileCount++;
        added++;
      }
      groups.push({ root: stripped, members: new Set(Object.keys(closure.bundle)) });
      return true;
    }
    if (stripped in bundle) return false;
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return false;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return false;
    try {
      if (!(await filesOf(vfs).exists(stripped)) || (await filesOf(vfs).isDirectory(stripped))) return false;
      // This is a guess at what a program might require, and the same
      // per-file ceiling the entry-package walk applies bounds it: a
      // multi-MiB main entry is an alternative bundle (typescript's 8.69 MiB
      // `lib/typescript.js` beside the `lib/tsc.js` that actually runs), and
      // one guess must not spend a third of the budget — and a third of the
      // supervisor's headroom — on every invocation that never reads it.
      // Literal dependencies use the closure's byte allowance, not this
      // speculative-root per-file ceiling.
      if (!(await _bundleAdmits(vfs, stripped, budgetState, BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES))) return false;
      // A guess must not be a native binary. Nothing in a Workers isolate can
      // load a `.node` addon or a `.exe` — the ABI policy classifies them
      // native-unsupported and the installer says so at install time — so
      // admitting one spends the budget on bytes no code path can reach.
      // Measured: freeing 1.3 MiB of rollup let `@napi-rs/lzma-linux-x64-gnu`'s
      // 1,445,448-byte `.node` in, which the size guard had been evicting.
      // Only the guess is filtered; a path the closure requires is untouched.
      if (isNativeBinPath(stripped)) return false;
      // hardening-r5: preserve binary content as Uint8Array.
      const stat = await filesOf(vfs).stat(stripped);
      if (stat === null || rawBytes + stat.size > bound) return false;
      const content = (await _readBundleCell(vfs, stripped));
      const cellLen = _bundleCellLength(content);
      const raw = _bundleCellRawBytes(content);
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES || rawBytes + raw > bound) return false;
      bundle[stripped] = content;
      rawBytes += raw;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
      return true;
    } catch { return false; }
  }

  /**
   * Whether guessing at `pkgDir`'s main entry is still a guess.
   *
   * It is, for a package nothing required: that is what this pass exists for,
   * and a dynamic `require(variable)` leaves no edge to follow. It is NOT for
   * a package the closure reached only through a subpath export — there the
   * program has told us exactly which corner of the package it uses, and the
   * main entry is a different graph that no require reaches. Adding it anyway
   * is how `rollup/parseAst` (7.9 KB of binding) dragged in rollup's whole
   * bundler: `dist/shared/rollup.js` at 941 KB and, through the `module`
   * candidate, `dist/es/shared/node-entry.js` at 951 KB — measured together
   * as 46.5% of a real-vite snapshot, reached by no require in it.
   *
   * A package that loads its own main from a subpath at runtime does so
   * through a static edge, so it is in the closure and unaffected.
   */
  function mainIsSpeculative(pkgDir: string): boolean {
    const prefix = pkgDir.replace(/^\/+/, '') + '/';
    let reached = false;
    for (const path of requiredPaths) {
      if (!path.startsWith(prefix)) continue;
      // package.json alone is resolution metadata, not a use of the package.
      if (path === prefix + 'package.json') continue;
      reached = true;
      break;
    }
    return !reached;
  }

  async function addPkgEntry(pkgDir: string) {
    const manifest = (pkgDir + '/package.json').replace(/^\/+/, '');
    if (bundle[manifest] === undefined && !(await addOne(manifest))) return;
    // A package the closure reached keeps exactly what it reached; only an
    // unreached one gets the guess below.
    if (!mainIsSpeculative(pkgDir)) return;
    // Malformed JSON, or a package whose entry fields the resolver cannot
    // read (`main: 7`, `exports: true`) drops that field and keeps the rest;
    // unparseable JSON is a package with no declared entry. Either way the
    // next package is unaffected.
    let pkg: ResolvablePackageJson | null;
    try { const text = bundle[manifest]; pkg = typeof text === 'string' ? parseResolvablePackageJson(text) : null; }
    catch { pkg = null; }
    // The root entry a bare require of this package resolves to, in the
    // order the runtime resolves it (require-resolver.ts resolvePkgSubpathEx):
    // exports under the CJS conditions, then the ESM ones, then legacy main,
    // then an index probe, each tried until one lands. A denied root
    // (`"." : null`) resolves to nothing and falls through the same way. A
    // hand-rolled walk of `exports["."]` read nothing from a root conditional
    // map (on-change@6: `{ types, default }`, no ".", no main) and guessed
    // `index.js`, which does not exist.
    const candidates: string[] = [];
    if (pkg) {
      // Speculative staging may oversample permissively; runtime Node resolution remains strict.
      const entry = requirePackageEntry(pkg, '.', options.conditions ?? [], BUILD_BROWSER_PACKAGE_MAP_POLICY);
      if (entry !== null) candidates.push(entry);
      if (pkg.main !== undefined) candidates.push(pkg.main);
    }
    candidates.push('index.js');
    for (const rel of candidates) {
      const norm = rel.replace(/^\.\//, '');
      const base = pkgDir + '/' + norm;
      let landed = false;
      const tries = /\.[a-z]+$/.test(norm) ? [base] : exts.map((e) => base + e);
      for (const candidate of tries) {
        if ((await filesOf(vfs).exists(candidate.replace(/^\/+/, ''))) &&
            !(await filesOf(vfs).isDirectory(candidate.replace(/^\/+/, '')))) {
          if ((await addOne(candidate))) { landed = true; break; }
        }
      }
      if (landed) {
        // X.5-C Fix #2: when an entry lands, also pull in sibling files
        // that match unbuild's hash-chunk pattern (`<base>.<hash>.cjs|mjs|js`)
        // AND walk one level into a `shared/` subdir if the package has
        // one. The unbuild bundler emits chunked CJS like:
        //   dist/index.cjs        (entry)
        //   dist/shared/<base>.<hash>.cjs  (chunk required by entry)
        //
        // The static walker cannot discover computed hash-chunk imports, so
        // the greedy oversample is the safety net for their reachability.
        const entryDir = base.replace(/\/[^/]+$/, '');
        {
          const sibs = await (async () => vfs.readdir(entryDir))().catch(() => []);
          for (const sib of sibs) {
            if ((await launchEntryType(vfs, entryDir, sib)) !== 'file') continue;
            // Hash-chunk pattern: <name>.<hash>.<cjs|mjs|js>. Hash must
            // be 6+ chars AND look like a hash, not an English word —
            // either contain digits/underscore/dash, or contain BOTH
            // uppercase AND lowercase letters (real bundler hashes are
            // mixed-case base64-shaped: `BSlhyZSM`, `M-eThtNZ`, ...). This
            // discriminator keeps us from false-positiving on common
            // suffixes that happen to be 6+ chars all-lowercase like
            // `minified`, `modern`, `production`, `compiled`.
            const hashMatch = sib.name.match(/\.([A-Za-z0-9_-]{6,})\.(cjs|mjs|js)$/);
            if (!hashMatch) continue;
            const seg = hashMatch[1];
            const hasDigitOrDash = /[0-9_-]/.test(seg);
            const hasMixedCase = /[A-Z]/.test(seg) && /[a-z]/.test(seg);
            if (!hasDigitOrDash && !hasMixedCase) continue;
            (await addOne(entryDir + '/' + sib.name));
          }
          // Walk one level into `shared/` — unconditionally, since the
          // pattern is well-known across unbuild/rolldown/rollup chunked
          // outputs. Bounded by addOne's budget checks; readdir of a
          // typical shared/ dir returns 1-5 files.
          const sharedDir = entryDir + '/shared';
          const sharedStripped = sharedDir.replace(/^\/+/, '');
          if (await (async () => filesOf(vfs).isDirectory(sharedStripped))().catch(() => false)) {
            for (const sh of await (async () => vfs.readdir(sharedDir))().catch(() => [])) {
              if ((await launchEntryType(vfs, sharedDir, sh)) !== 'file') continue;
              if (!/\.(cjs|mjs|js)$/.test(sh.name)) continue;
              (await addOne(sharedDir + '/' + sh.name));
            }
          }
        }
        break;
      }
    }
  }

  for (const pkgDir of (await speculativePackageDirs(vfs, cwdStripped, bundle))) (await addPkgEntry(pkgDir));

  // Then the one `import()` a guessed module defers, when it defers only one
  // and it is a file of its own package, as a guess of its own with its static
  // closure; what that defers joins the queue. That is how a package proxies
  // or splits its own code, and it loads whenever the deferring code runs:
  // vinext imports @vitejs/plugin-rsc by a computed URL (a guess here, as a
  // project dependency); plugin-rsc imports vitefu, whose CommonJS entry loads
  // its ESM build with `import('./index.js')`. A module that defers several
  // chooses among them, and a deferral of another package is an optional
  // dependency (@vercel/og's `import("sharp")`, caught when absent, whose
  // 9.2 MB wasm image the launch would compile): a guess does not guess those.
  const followed = new Set<string>();
  for (let i = 0; i < deferred.length; i++) {
    if (rawBytes >= bound || budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    const target = await resolveDeferredImport(filesOf(vfs), deferred[i]!, options.pacer?.spend.bind(options.pacer), options.conditions);
    // Its own package: where the deferral lands, not how it is spelled.
    const own = packageRootOf(deferred[i]!.fromDir.replace(/^\/+/, '') + '/_');
    if (target === null || own === null || packageRootOf(target) !== own || followed.has(target)) continue;
    followed.add(target);
    await addOne(target);
  }
  return { added, groups };
}

/**
 * The packages a name resolved at runtime — a computed `require(name)`, or a
 * resolver call like exsolve's `resolveModulePath(name, { from: rootDir })` —
 * can plausibly reach: every package ONE `dependencies` hop from a package
 * the project itself declares or that owns a file in the static closure, plus
 * those roots themselves. Never devDependencies, never a second hop.
 *
 * Unbounded, the greedy oversample read every installed package's main:
 * for `node -e "import('got')"` in got's repo — a one-file static closure —
 * that was 1,526 files / 10.9 MB from 706 packages, which every later pass
 * re-scanned and esbuild-wasm transformed, and the exec path's 20 s bundle
 * deadline fired on a program that reads none of it. A bound that followed
 * dependency edges from the project's devDependencies reached all 772 of
 * them (measured), because a library repo's dev toolchain reaches the whole
 * tree. Computed requires almost always target a declared runtime
 * dependency of the package doing the requiring, so the bound is one hop
 * over `dependencies` only. Directories, sorted for a stable bundle.
 *
 * The project's own dependencies are hop ROOTS and not merely members,
 * because a bin runs inside the project and resolves from the project root,
 * where what it names is its host framework's runtime peer rather than
 * anything its own package declares. Measured on staging, `nuxt dev` on a
 * `nuxi init` project: npm points `node_modules/.bin/nuxt` at
 * `@nuxt/cli/bin/nuxi.mjs`, so `@nuxt/cli` owns the entry; `@nuxt/kit` is a
 * devDependency of `@nuxt/cli` and a dependency of `nuxt`, which the project
 * declares. Admitting `nuxt` without hopping from it left
 * `@nuxt/kit/package.json` unstaged, `readFileSync` raised EAGAIN inside
 * exsolve — which swallows every error — and the CLI reported
 * `Cannot resolve module "@nuxt/kit" (from: /home/user/nuxt-probe/mvp/)`.
 * One hop from each project dependency is what the project's own node_modules
 * was hoisted for; it is the same edge kind and the same single level the
 * owner hop already spends.
 */
export async function speculativePackageDirs(
  vfs: LaunchFs,
  cwdStripped: string,
  bundle: Record<string, string | Uint8Array>,
): Promise<string[]> {
  const runtimeDeps = async (pkgJsonPath: string): Promise<string[]> => {
    try {
      const meta = JSON.parse(packageJsonText(await filesOf(vfs).readFileString(pkgJsonPath)));
      const names = new Set<string>();
      for (const field of ['dependencies', 'optionalDependencies']) {
        const deps = meta?.[field];
        if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
      }
      return [...names];
    } catch { return []; }
  };
  // The package that owns a bundle file: the last node_modules segment.
  const ownerOf = (path: string): string | null => {
    const idx = path.lastIndexOf('/node_modules/');
    if (idx === -1) return null;
    const segs = path.slice(idx + '/node_modules/'.length).split('/');
    const name = segs[0]?.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
    return name ? path.slice(0, idx + '/node_modules/'.length) + name : null;
  };
  // Resolve a bare name the way require does from `fromDir`: the nearest
  // node_modules up the tree that has it.
  const resolveDir = async (name: string, fromDir: string): Promise<string | null> => {
    let dir = fromDir;
    for (;;) {
      const candidate = dir + '/node_modules/' + name;
      if ((await filesOf(vfs).exists(candidate + '/package.json'))) return candidate;
      const idx = dir.lastIndexOf('/');
      if (idx <= 0) return null;
      dir = dir.slice(0, idx);
    }
  };
  const reached = new Set<string>();
  const hopped = new Set<string>();
  // Returns what this hop landed on, so a root can be hopped from without
  // reading its manifest twice and without the caller tracking the edges.
  const hop = async (fromDir: string): Promise<string[]> => {
    if (hopped.has(fromDir)) return [];
    hopped.add(fromDir);
    const landed: string[] = [];
    for (const name of (await runtimeDeps(fromDir + '/package.json'))) {
      const dir = (await resolveDir(name, fromDir));
      if (dir === null) continue;
      reached.add(dir);
      landed.push(dir);
    }
    return landed;
  };
  const projectDeps = (await hop(cwdStripped));
  const owners = new Set<string>();
  for (const path of Object.keys(bundle)) {
    const owner = ownerOf(path);
    if (owner !== null) owners.add(owner);
  }
  for (const owner of owners) {
    reached.add(owner);
    (await hop(owner));
  }
  // The second kind of root: what the project declares. A bin resolving from
  // the project root reaches these packages' dependencies, and nothing else
  // in this function would — the project's dependency owns no staged file
  // when the bin that runs belongs to a sibling package.
  for (const dir of projectDeps) (await hop(dir));
  return [...reached].sort();
}

/**
 * What code reads by a path it spells out, which a pass of the launch stages
 * (addStaticReads): the paths the module names in `refs` (static-fs-refs.ts)
 * that the pass wants, and whether a source can name any (`mayName`, a test
 * of its text that spares analyzing one that cannot).
 */
interface StaticReadSelection {
  mayName(source: string): boolean;
  named(refs: StaticFsRefs): Iterable<string>;
}

/**
 * X.5-Z3 and X.5-U: an asset a module reads synchronously by a path it
 * spells out — a stylesheet, page, image, text or JSON file, or a dotfile or
 * digest/hash/version/sha/md5 sentinel — whatever spells it:
 * `fs.readFileSync(path.resolve(__dirname, "<rel>"))`, SWC's
 * `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`, a join,
 * an alias of the path function. jsdom reads `default-stylesheet.css` at
 * module evaluation; ts-jest reads `.ts-jest-digest`. The gate bounds the
 * guess: an ungated read of any `__dirname`-relative file would pull compiled
 * wasm and JSON dictionaries a package reads the same way.
 */
const STATIC_ASSET_READS: StaticReadSelection = {
  mayName: (source) => source.includes('readFileSync'),
  named: (refs) => refs.exact.filter((ref) => {
    const name = ref.path.slice(ref.path.lastIndexOf('/') + 1);
    return ref.sync && (/\.(?:css|html|htm|svg|txt|json)$/i.test(name) || /^\.|digest|hash|version|sha|md5/i.test(name));
  }).map((ref) => ref.path),
};

/**
 * Shell compatibility (2026-05-11): an absolute path the entry code or a
 * staged module spells as a literal (`node -e 'fs.readFileSync("/home/user/
 * x.txt")'`, a module that hardcodes one), outside the mounts a session does
 * not have. No other pass reads the user's own files by an absolute path.
 */
const STATIC_ABSOLUTE_LITERALS: StaticReadSelection = {
  mayName: (source) => /['"`]\//.test(source),
  named: (refs) => refs.literals.filter((path) => !/^\/(proc|sys|dev|lib|lib64|boot|root)(\/|$)/.test(path)),
};

/**
 * Stage, within the bundle's budget, each existing file that `sources` (each
 * a module's path and text) name as `selection` wants, as static-fs-refs.ts
 * finds what code names: comments are not code, and a URL string is not one
 * (the regex passes this replaces stripped `//` to the end of the line, the
 * rest of a line after "http://" included). `refsOf` answers a source's
 * analysis. A file that is missing, a directory or unreadable is skipped.
 */
async function addStaticReads(
  vfs: LaunchFs,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
  sources: Iterable<readonly [path: string, source: string]>,
  refsOf: (path: string, source: string) => Promise<StaticFsRefs | null>,
  selection: StaticReadSelection,
): Promise<void> {
  for (const [path, source] of sources) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES || budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return;
    if (!selection.mayName(source)) continue;
    const refs = await refsOf(path, source);
    if (refs === null) continue;
    for (const named of selection.named(refs)) {
      const key = stripLeadingSlashes(named);
      if (bundle[key] !== undefined) continue;
      if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES || budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return;
      try {
        if (!(await filesOf(vfs).exists(key)) || (await filesOf(vfs).isDirectory(key))) continue;
        if (!(await _bundleAdmits(vfs, key, budgetState))) continue;
        // hardening-r5: preserve binary content as Uint8Array.
        const content = await _readBundleCell(vfs, key);
        const cellLen = _bundleCellLength(content);
        if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) continue;
        bundle[key] = content;
        budgetState.totalBytes += cellLen;
        budgetState.fileCount++;
      } catch { /* missing, unreadable, or gone since */ }
    }
  }
}

/** The JavaScript sources a bundle stages now, by path: what the static-read passes analyze. */
function stagedJavaScript(bundle: Record<string, string | Uint8Array>): Array<readonly [string, string]> {
  const sources: Array<readonly [string, string]> = [];
  for (const [path, cell] of Object.entries(bundle)) {
    if (typeof cell === 'string' && /\.(?:c|m)?js$/.test(path)) sources.push([path, cell]);
  }
  return sources;
}

/**
 * G3 (runtime-pkg wave) — bin-target sibling oversample.
 *
 * When the entry script lives at `node_modules/<pkg>/...` (typical
 * shape: cli.js, bin/foo, dist/index.js), bins commonly do
 * `readFileSync(path.join(__dirname, '<rel>'))` to load assets that
 * the static walker can't see (computed paths, package-internal
 * data files, .cow / .pem / .wasm / .ttf / etc.).
 *
 * Pre-fix: the static asset reads (STATIC_ASSET_READS) cover only a
 * hardcoded extension list (.css/.html/.htm/.svg/.txt/.json). Cowsay's
 * `.cow` files ENOENT at runtime.
 *
 * Fix shape: when entry is inside a `node_modules/<pkg>` directory,
 * walk that pkg dir's contents and pull runtime package files under
 * VFS_BUNDLE_MAX_BYTES, capped at `MAX_PKG_FILES` per-pkg so a
 * 1000-file barrel package can't blow the bundle budget. Scaffold
 * bundle profile keeps full package-template access for `create-*`
 * initializers.
 *
 * Runtime profile skips docs/examples/source maps/images, while scaffold
 * profile preserves initializer template trees.
 *
 * Caller already passed the `cwd` and the `scriptPath`; we only act
 * if scriptPath is /<...>/node_modules/<pkg>/... — anything else
 * (user scripts, npx-cache files outside node_modules, eval) is
 * a no-op.
 */
export async function addBinTargetSiblings(
  vfs: LaunchFs,
  scriptPath: string | undefined,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
  bundleProfile: FacetBundleProfile,
): Promise<{ added: number; wasmPaths: string[] }> {
  if (!scriptPath) return { added: 0, wasmPaths: [] };
  const stripped = scriptPath.replace(/^\/+/, '');
  // Find the *innermost* node_modules/<pkg> root. Handles scoped
  // packages (`@org/name`) too.
  const segs = stripped.split('/');
  let nmIdx = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i] === 'node_modules') { nmIdx = i; break; }
  }
  if (nmIdx < 0) return { added: 0, wasmPaths: [] };
  const isScoped = segs[nmIdx + 1]?.startsWith('@');
  const pkgEnd = isScoped ? nmIdx + 3 : nmIdx + 2;
  if (pkgEnd > segs.length) return { added: 0, wasmPaths: [] };
  const pkgRoot = segs.slice(0, pkgEnd).join('/');

  // npm-create-fix wave (2026-05-12): scaffold profile needs this cap
  // high enough to cover
  // multi-template scaffolds. create-vite ships 242 files + 74 dirs (316
  // visit entries) across 21 template-* subdirs; the 200-cap exhausted
  // BFS budget before late-alphabetical template files (vanilla, vue, etc.)
  // were bundled, causing readFileSync ENOENT in the facet and silent
  // partial scaffolding (only .gitignore + index.html materialized for
  // `npm create vite@latest test-vite -- --template vanilla`).
  //
  // 1000 covers the documented create-* family (create-vite ~316, create-
  // nuxt ~700, create-react-router ~400). Still well below the optional
  // enrichment budget of 4000 files / 24 MiB, which retains the defense
  // against pathological package trees.
  //
  // for the prior wave's empirical investigation (243 manifest entries,
  // only 140/243 readable pre-bump on prod 11df6ca).
  const MAX_PKG_FILES = 1000;

  // BFS walk pkgRoot. Skip nested `node_modules` (those are
  // separate packages with their own walk if/when they become
  // entry points).
  // Phase 1 — enumerate candidates and their sizes. Nothing is read here, so
  // an unread multi-MiB cell costs a stat rather than a transfer.
  let visited = 0;
  const candidates: { path: string; size: number }[] = [];
  // Every wasm image under the package, whatever its size: an image rides in
  // the module map by path and is compiled by the loader, so the bundle's
  // per-file cap does not apply to it (see FacetVfsState.wasmImages).
  const wasmPaths: string[] = [];
  const queue: string[] = [pkgRoot];
  while (queue.length > 0 && visited < MAX_PKG_FILES) {
    const dir = queue.shift()!;
    let entries: RuntimeVfsDirEntry[];
    try { entries = (await vfs.readdir(dir)); } catch { continue; }
    for (const e of entries) {
      if (visited >= MAX_PKG_FILES) break;
      visited++;
      if (e.name === 'node_modules') continue;
      if (e.name === '.git') continue;
      const child = dir + '/' + e.name;
      if ((await launchEntryType(vfs, dir, e)) === 'directory') {
        if (!shouldVisitBinPackageDirectory(pkgRoot, child, bundleProfile)) continue;
        queue.push(child);
        continue;
      }
      // File. Skip if already in bundle (the static walker beat us
      // to it) or outside this profile's package-data policy.
      if (!shouldIncludeBinPackageFile(pkgRoot, child, bundleProfile)) continue;
      if (child.endsWith('.wasm')) wasmPaths.push(child);
      if (bundle[child] !== undefined) continue;
      const stat = await filesOf(vfs).lstat(child).catch(() => null);
      if (stat === null) continue;
      const size = stat.size;
      if (size > BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES) continue;
      candidates.push({ path: child, size });
    }
  }

  // Phase 2 — admit smallest first.
  //
  // The budget is shared with every other pass, so whatever this walk spends
  // is denied to the rest. Ordering by size maximizes the number of files
  // admitted per byte, and the files a program actually reads at runtime are
  // the small ones: typescript's 51 `lib.*.d.ts` cells total 3.3 MiB and are
  // all read, while its single `lib/typescript.js` is 8.69 MiB and is not.
  // In readdir order the latter could exhaust the budget before the former
  // was reached.
  candidates.sort((a, b) => a.size - b.size);

  let added = 0;
  for (const candidate of candidates) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) break;
    if (candidate.size > VFS_BUNDLE_MAX_BYTES - budgetState.totalBytes) continue;
    // hardening-r5: preserve binary content as Uint8Array.
    let content: string | Uint8Array;
    try { content = (await _readBundleCell(vfs, candidate.path)); } catch { continue; }
    const cellLen = _bundleCellLength(content);
    // A cell that does not fit must not abandon the walk: smallest-first
    // ordering means everything after it is smaller and may still fit.
    if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) continue;
    bundle[candidate.path] = content;
    budgetState.totalBytes += cellLen;
    budgetState.fileCount++;
    added++;
  }
  return { added, wasmPaths };
}

/**
 * The table an \`import()\` reads its target's lazy synchronous reads from
 * (FacetVfsState.lazyModules): for each lazy module that an \`import()\` may
 * target, the synchronous reads (static-fs-refs' exact, sync) of every lazy
 * module evaluating it evaluates, itself included, by its lazy importers.
 * \`syncReadsOf\` holds each lazy module that reads; the table is keyed by
 * each of its lazy ancestors. Vite 8's \`import("lightningcss")\` resolves to
 * lightningcss-wasm's wasm-node.mjs, which reads lightningcss_node.wasm
 * (15.8 MB) at module top level: an entry under that target, fetched when the
 * import() runs (a dev server with css.transformer 'lightningcss', a build's
 * CSS minify), never at a launch that does not import it.
 */
export function lazyReadsByTarget(
  syncReadsOf: ReadonlyMap<string, readonly string[]>,
  lazyImporters: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const table: Record<string, Set<string>> = {};
  for (const [module, reads] of syncReadsOf) {
    const seen = new Set<string>([module]);
    const queue = [module];
    while (queue.length > 0) {
      const at = queue.shift()!;
      const entry = table[at] ??= new Set();
      for (const read of reads) entry.add(read);
      for (const importer of lazyImporters[at] ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return Object.fromEntries(Object.entries(table).map(([target, reads]) => [target, [...reads]]));
}

/**
 * The wasm images a program's closure holds, by path and content digest.
 *
 * Three sources, one record: a `.wasm` cell the walk already staged (digested
 * from the cell, no second read); a `.wasm` file the bin-package pass saw but
 * did not stage because it is over the bundle's per-file cap — esbuild-wasm's
 * 11.9 MiB image is the motivating one; and a `.wasm` file a staged module
 * names by a relative literal, resolved against that module's directory —
 * the only way to find an image in a dependency the bin-package pass never
 * walks (lightningcss-wasm's 15.8 MiB `lightningcss_node.wasm`, which Vite 8
 * loads for CSS minification). A launch stages each as a module-map member
 * the loader compiles, registered under both keys, so the program's own
 * `new WebAssembly.Module(bytes)` is answered from the map whether it read
 * the bytes by path or carried them inline. A file that cannot be read is
 * left out; the seam's refusal names the module later.
 */
export async function collectClosureWasmImages(
  vfs: LaunchFs,
  bundle: Record<string, string | Uint8Array | FacetVfsDenial>,
  unstagedPaths: readonly string[],
  /**
   * A module's analysis as the data plan reads it (FacetManager
   * _staticRefsOf: its file, once per revision), or null: then its cell is
   * analyzed here.
   */
  staticRefs?: (path: string) => Promise<StaticFsRefs | null>,
): Promise<WasmImageRecord[]> {
  const byPath = new Map<string, WasmImageRecord>();
  for (const [path, cell] of Object.entries(bundle)) {
    if (!path.endsWith('.wasm') || !(cell instanceof Uint8Array)) continue;
    byPath.set(path, { vfsPath: '/' + stripLeadingSlashes(path), digest: wasmImageDigest(cell) });
  }
  const named = new Set(unstagedPaths);
  for (const [path, cell] of Object.entries(bundle)) {
    if (typeof cell !== 'string' || !cell.includes('.wasm')) continue;
    if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))) continue;
    // wasm-bindgen also uses a folded template/variable path. Reuse the
    // filesystem AST analysis rather than adding another string-pattern rule.
    // The data plan analyzes the same files: one analysis serves both, and
    // every launch after the first of a file's revision (a 487 KB pi chunk's
    // took 1.1 s, warm, each launch).
    const known = staticRefs ? await staticRefs(stripLeadingSlashes(path)) : null;
    if (known !== null) {
      // Its exact references hold its relative-literal images too (_staticRefsOf).
      for (const ref of known.exact) if (ref.path.endsWith('.wasm')) named.add(stripLeadingSlashes(ref.path));
      continue;
    }
    for (const ref of findStaticFsReferences(cell, '/' + stripLeadingSlashes(path)).exact) {
      if (ref.path.endsWith('.wasm')) named.add(stripLeadingSlashes(ref.path));
    }
    for (const image of relativeWasmPaths(cell, path)) named.add(image);
  }
  for (const path of named) {
    if (byPath.has(path)) continue;
    const digest = await streamedWasmImageDigest(vfs, path);
    if (digest === null) continue;
    byPath.set(path, { vfsPath: '/' + stripLeadingSlashes(path), digest });
  }
  return [...byPath.values()];
}

/**
 * Stage the paths an earlier run of the same entry read synchronously and did
 * not have.
 *
 * The speculative passes are all proxies for intent — a call shape, a package
 * layout, a filename — and each one silently drops whatever its author did
 * not think of. A miss is the opposite: direct evidence, from the program
 * itself, that the bundle was wrong about one specific path. So the only
 * policy here is a budget. There is no extension rule and no per-file size
 * rule; a file that does not fit inside the bundle's memory bound is one no
 * policy can stage, and the facet says so by name when it is read again.
 *
 * Admitted smallest-first for the same reason as the entry-package walk: the
 * budget is shared, so ordering by size maximizes the number of misses a
 * fixed number of bytes repairs.
 *
 * `room` is what the snapshot bound leaves after what is already committed
 * (the static closure, and for learned entries this session's own misses), in
 * raw bytes: evidence fills that room and never pushes the snapshot past the
 * bound, so it can never be the reason a launch fails. `bytes` is what this
 * call staged, in the same unit.
 */
export async function addObservedReads(
  vfs: LaunchFs,
  observed: ReadonlySet<string> | undefined,
  bundle: Record<string, string | Uint8Array>,
  requiredPaths: Set<string>,
  budgetState: { totalBytes: number; fileCount: number },
  room = Infinity,
  pacer?: TurnBudget,
): Promise<{ added: number; bytes: number }> {
  if (!observed || observed.size === 0) return { added: 0, bytes: 0 };
  let bytes = 0;

  const candidates: { path: string; size: number }[] = [];
  for (const path of observed) {
    if (path === '') continue;
    // Already staged, but evictable: the evidence is what makes it required.
    if (bundle[path] !== undefined) { requiredPaths.add(path); continue; }
    const stat = await filesOf(vfs).lstat(path).catch(() => null);
    if (stat === null) continue;
    if (stat.type === 'directory') continue;
    candidates.push({ path, size: stat.size });
  }
  candidates.sort((a, b) => a.size - b.size);

  let added = 0;
  for (const candidate of candidates) {
    if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) break;
    if (budgetState.totalBytes + candidate.size > VFS_BUNDLE_MAX_BYTES) continue;
    let content: string | Uint8Array;
    try { content = (await _readBundleCell(vfs, candidate.path)); } catch { continue; }
    const cellLen = _bundleCellLength(content);
    if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) continue;
    const raw = _bundleCellRawBytes(content);
    if (bytes + raw > room) continue;
    bundle[candidate.path] = content;
    requiredPaths.add(candidate.path);
    bytes += raw;
    budgetState.totalBytes += cellLen;
    budgetState.fileCount++;
    added++;
  }
  // A module brings what it loads synchronously, its closure staged whole or
  // not at all: its static imports (learned one miss per launch, nuxt's
  // on-change alone would have cost a relaunch for each of its files) and
  // its require wrappers' loads (a learned @vitejs/plugin-vue without
  // vue/compiler-sfc failed "Failed to resolve vue/compiler-sfc"). A part of
  // a closure is no use: the module it leaves out fails its synchronous read.
  // The file itself was read, so it stays, as data, whether its closure fits
  // or not (observed-read-closure.mjs: Tailwind v3 reads .js content files as
  // text); executed without its closure, the run fails naming what it missed
  // and the next launch stages that (facet-observed-residency.mjs). What the
  // module defers with import() is fetched when it runs, and what the runs
  // executed is evidence of its own.
  for (const path of observed) {
    if (!/\.[cm]?js$/.test(path) || bundle[path] === undefined) continue;
    const closure = await prefetchForRequire(filesOf(vfs), '', '/' + path.slice(0, path.lastIndexOf('/')), '/' + path,
      undefined, pacer?.spend.bind(pacer), {
        purpose: 'dependency-closure', held: bundle,
        // UTF-8 bytes, which bound both the raw bytes `room` counts and the
        // cell lengths the bundle's own cap counts.
        maxAdditionalBytes: Math.max(0, Math.min(room - bytes, VFS_BUNDLE_MAX_BYTES - budgetState.totalBytes)),
        maxAdditionalFiles: Math.max(0, VFS_BUNDLE_MAX_FILES - budgetState.fileCount),
      });
    if ('kind' in closure) continue;
    for (const [dep, content] of Object.entries(closure.bundle)) {
      if (bundle[dep] !== undefined) { requiredPaths.add(dep); continue; }
      const cellLen = _bundleCellLength(content);
      const raw = _bundleCellRawBytes(content);
      bundle[dep] = content;
      requiredPaths.add(dep);
      bytes += raw;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
    }
  }
  return { added, bytes };
}

const RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS = new Set([
  'docs',
  'doc',
  'examples',
  'example',
  'test',
  'tests',
  '__tests__',
  'coverage',
  '.github',
]);

/**
 * Suffixes never *read* at runtime — consumed only by tooling that does not
 * run inside a facet. Excluding them is safe because no program can observe
 * the difference.
 *
 * This list deliberately no longer guesses at content. It previously carried
 * `.d.ts` and `.md`, and both were wrong the same way: the walk that consults
 * it visits ONLY the entry package's own tree (see `addBinTargetSiblings`),
 * which is precisely the package most likely to read its own data at runtime.
 * `.d.ts` stripped TypeScript's `lib.*.d.ts` — the single unsatisfiable read
 * behind every `TS2318` — and `.md` stripped pi's `CHANGELOG.md`. "`.d.ts` is
 * type-only metadata" holds for every package except the one whose runtime
 * data happens to be `.d.ts`, and this walk only ever looks at that one.
 *
 * Size, not extension, is what bounds this walk now.
 */
const RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES = [
  '.map',
  '.tsbuildinfo',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.mp4',
  '.mov',
  '.webm',
];

/**
 * Whether the facet's require path could ever load this cell AS A MODULE.
 *
 * Not a judgement about whether the file is useful — an evicted cell is a
 * real loss either way, since the synchronous read it exists for raises
 * EAGAIN. It is a judgement about what the loss can BREAK. A cell the loader
 * can resolve is one some other module may be importing, and losing it takes
 * every importer down with it; a cell it can never resolve is only ever read
 * as data, by whoever asked for that path specifically.
 *
 * Declaration files are the clean case, and the reason this is a suffix test
 * rather than a content one: `foo.d.ts` is consumed by a type checker and is
 * never the target of a `require`, so shedding one cannot orphan a module.
 * That does not contradict the list above keeping them admissible — a `.d.ts`
 * IS a legitimate runtime read for the one package that reads its own (tsc
 * and `lib.*.d.ts`). This decides only what goes FIRST once a bound has
 * already been breached and something has to.
 */
function _isLoadableModuleCell(path: string): boolean {
  if (isTypescriptDeclarationFile(path)) return false;
  const ext = vfsPathExtension(path);
  return ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.json'
    || ext === '.wasm' || ext === '' || bundleCompiledLoader(path) !== null;
}

/**
 * Per-file ceiling for the speculative passes over installed packages: the
 * entry-package walk (`addBinTargetSiblings`) and the main-entry oversample
 * (`greedyAddMainEntries`).
 *
 * Everything the entry package needs in order to *run* arrives through the
 * require closure, which is uncapped and never evicted. These passes exist
 * only to catch what the static walker cannot see — data files, and modules
 * reached by a computed require — and those are small. Multi-MiB cells in a
 * package tree are overwhelmingly alternative bundles — typescript ships an
 * 8.69 MiB `lib/typescript.js` that `tsc` never reads — rather than data.
 *
 * So one speculative guess must not spend the budget every later invocation
 * then carries: the same reasoning as `CWD_SNAPSHOT_MAX_FILE_BYTES`, applied
 * to the package tree. A miss this causes is loud and self-repairing: the
 * facet reports the unstaged read and the next build stages it from the
 * residency ledger, which has no per-file rule.
 */
const BIN_PACKAGE_SPECULATIVE_MAX_FILE_BYTES = 4 * 1024 * 1024;

function shouldIncludeBinPackageFile(
  pkgRoot: string,
  path: string,
  bundleProfile: FacetBundleProfile,
): boolean {
  if (bundleProfile === 'scaffold') return true;

  if (RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path))) return false;

  const lower = binPackageRelativePath(pkgRoot, path).toLowerCase();
  for (const suffix of RUNTIME_PACKAGE_EXCLUDED_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return false;
  }
  return true;
}

function shouldVisitBinPackageDirectory(
  pkgRoot: string,
  path: string,
  bundleProfile: FacetBundleProfile,
): boolean {
  if (bundleProfile === 'scaffold') return true;
  return !RUNTIME_PACKAGE_EXCLUDED_ROOT_DIRS.has(binPackageRootSegment(pkgRoot, path));
}

function binPackageRootSegment(pkgRoot: string, path: string): string {
  const rel = binPackageRelativePath(pkgRoot, path);
  const firstSlash = rel.indexOf('/');
  return firstSlash >= 0 ? rel.slice(0, firstSlash) : rel;
}

function binPackageRelativePath(pkgRoot: string, path: string): string {
  return path.startsWith(pkgRoot + '/') ? path.slice(pkgRoot.length + 1) : path;
}

/** Directories the project snapshot never enters: dependencies, VCS, Nimbus's own state. */
const CWD_PROJECT_SKIP_DIRS = new Set(['node_modules', '.git', '.nimbus']);

/** The project tree a launch in `cwd` stages its working files from, as a key. */
function cwdProjectRoot(cwd: string): string {
  return (cwd || '/home/user').replace(/^\/+/, '').replace(/\/+$/, '') || 'home/user';
}

/** Whether the file at `path` is in the project tree at `root`, as the snapshot walks it. */
function inCwdProject(root: string, path: string): boolean {
  if (!path.startsWith(root + '/')) return false;
  return !path.slice(root.length + 1).split('/').slice(0, -1).some((name) => CWD_PROJECT_SKIP_DIRS.has(name));
}

async function addCwdProjectFiles(
  vfs: LaunchFs,
  cwd: string,
  bundle: Record<string, string | Uint8Array>,
  budgetState: { totalBytes: number; fileCount: number },
): Promise<{ added: number }> {
  const root = cwdProjectRoot(cwd);
  const MAX_PROJECT_FILES = 512;
  let added = 0;
  let visited = 0;
  const queue: string[] = [root];

  while (queue.length > 0 && visited < MAX_PROJECT_FILES) {
    const dir = queue.shift()!;
    let entries: RuntimeVfsDirEntry[];
    try { entries = (await vfs.readdir(dir)); } catch { continue; }
    for (const e of entries) {
      if (visited >= MAX_PROJECT_FILES) break;
      visited++;
      if (e.name === '.' || e.name === '..') continue;
      const isDirectory = (await launchEntryType(vfs, dir, e)) === 'directory';
      if (isDirectory && CWD_PROJECT_SKIP_DIRS.has(e.name)) continue;
      const child = dir + '/' + e.name;
      if (isDirectory) {
        queue.push(child);
        continue;
      }
      if (bundle[child] !== undefined) continue;
      if (budgetState.fileCount >= VFS_BUNDLE_MAX_FILES) return { added };
      if (budgetState.totalBytes >= VFS_BUNDLE_MAX_BYTES) return { added };
      // Skip an oversized file before reading it: this walk guesses at what
      // the program might read, and one guess must not spend the budget (or
      // the supervisor's headroom) that every later invocation then carries.
      if (!(await _bundleAdmits(vfs, child, budgetState, CWD_SNAPSHOT_MAX_FILE_BYTES))) continue;
      let content: string | Uint8Array;
      try { content = (await _readBundleCell(vfs, child)); } catch { continue; }
      const cellLen = _bundleCellLength(content);
      if (cellLen > CWD_SNAPSHOT_MAX_FILE_BYTES) continue;
      if (budgetState.totalBytes + cellLen > VFS_BUNDLE_MAX_BYTES) return { added };
      bundle[child] = content;
      budgetState.totalBytes += cellLen;
      budgetState.fileCount++;
      added++;
    }
  }
  return { added };
}

/**
 * framework-fixes-F4 (2026-05-12): helper for the "esbuild unavailable
 * or fatally errored" paths. Walks the bundle for ESM-shaped files and
 * gives each a JS-valid diagnostic shim as its module (`placeEmit`), which
 * throws an informative Error at require-time.
 * Mirrors the per-file catch in transformEsmInBundle so the user gets the
 * same actionable error surface regardless of whether transform failed for
 * the whole batch or for one file.
 *
 * Does NOT touch non-ESM files, which run as the CommonJS they are.
 */
function _markBundleEsmAsFailed(
  bundle: Record<string, string | Uint8Array>,
  placeEmit: (path: string, code: string) => void,
  packageTypeOf: (path: string) => PackageType,
  reason: string,
): void {
  for (const path of Object.keys(bundle)) {
    if (!isBundleModuleCandidate(path)) continue;
    const src = bundle[path];
    if (typeof src !== 'string') continue;
    // A TypeScript source is never runnable as staged, so it always needs
    // the emit it cannot get; a JavaScript file only if it is ESM.
    if (bundleCompiledLoader(path) !== null || looksLikeEsm(path, src, packageTypeOf(path))) placeEmit(path, esbuildDiagnosticShim(path, reason));
  }
}

/**
 * The package scope "type" of each JavaScript cell of `paths` it decides
 * the format of (a .js or extensionless file: module-format.ts), read
 * through the resolver's own lookup (require-resolution.ts
 * packageScopeType) once per directory, as a lookup by path.
 */
async function cellPackageTypes(vfs: LaunchFs, paths: Iterable<string>): Promise<(path: string) => PackageType> {
  const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const byDir = new Map<string, PackageType>();
  for (const path of paths) {
    const ext = vfsPathExtension(path);
    if ((ext !== '.js' && ext !== '') || byDir.has(dirOf(path))) continue;
    byDir.set(dirOf(path), await packageScopeType(filesOf(vfs), dirOf(path)));
  }
  return (path) => byDir.get(dirOf(path)) ?? null;
}

/**
 * Run every cell of the bundle that needs it (needsBundleCellTransform)
 * through the module pass: transformBundleCells, over the bundle's cells,
 * with the launch's store and pacer. A module esbuild rejects becomes a
 * diagnostic shim that throws the reason when required
 * (esbuildDiagnosticShim).
 *
 * Each result is the path's emit (`placeEmit`), to become its module cell,
 * and never the file: what a program reads is the file on disk, never the
 * launch's rendering of it (tsc compiling its own project's sources; a
 * script patching an installed module and writing it back). Each ES module's
 * import sites go to `esModules`, as JSON, for its staging.
 */
async function transformBundleModules(
  bundle: Record<string, string | Uint8Array>,
  placeEmit: (path: string, code: string) => void,
  esModules: Map<string, string>,
  packageTypeOf: (path: string) => PackageType,
  scope: ModuleScope,
  stripTypes: NodeTypeScript | null,
  esbuild: EsbuildService,
  pacer?: TurnBudget,
  store?: BundleCellResultStore,
): Promise<BundleCellTransformStats> {
  // Snapshot the cells first — transforms await; never iterate-and-mutate.
  const cells: Array<{ path: string; source: string; packageType: PackageType }> = [];
  for (const path of Object.keys(bundle)) {
    const source = bundle[path];
    const packageType = packageTypeOf(path);
    // hardening-r5: binary cells are not modules.
    if (typeof source === 'string' && needsBundleCellTransform(path, source, packageType)) cells.push({ path, source, packageType });
  }
  return transformBundleCells(cells, { host: esbuild, store, pacer, scope, stripTypes }, (path, result) => {
    placeEmit(path, result.code);
    if (result.sites !== '') esModules.set(path, result.sites);
  });
}

/** What buildPrefetchBundle builds a module map for, and with what. */
export interface PrefetchBundleOptions {
  /** The program's path; absent for `-e` code and stdin. */
  scriptPath?: string;
  cwd: string;
  entryCode: string;
  /** The module pass's transform host (transformBundleModules); absent, ES modules and TypeScript stage as diagnostics. */
  esbuild?: EsbuildService;
  bundleProfile?: FacetBundleProfile;
  /** Whose scope the runtime runs an ES module in (RuntimeRunOpts.moduleScope): absent, Node's. */
  moduleScope?: ModuleScope;
  /** Paths earlier runs of the same entry read synchronously and missed. */
  observedReads?: ReadonlySet<string>;
  /** The launch's pacer; a build without one runs in the caller's turn. */
  pacer?: TurnBudget;
  /** The closure's raw-byte bound (VFS_BUNDLE_MAX_BYTES). */
  maxBundleBytes?: number;
  /** Other sessions' misses in the packages the closure can load (read-profile.ts). */
  learnedFor?: (closure: readonly string[]) => Promise<readonly string[]>;
  /** Modules earlier runs executed, as roots of the required graph; one that arrives with its text is walked from it. */
  executedModules?: readonly RequiredModuleRoot[];
  /** Where the launch's transform results are kept by content. */
  transformStore?: BundleCellResultStore;
  /** The program's own conditions (`node --conditions`), as the process resolves under them. */
  conditions?: readonly string[];
  /** How Node takes the launch's TypeScript (node-cli.ts typeScriptStripOptions); null where it is compiled. */
  stripTypes?: NodeTypeScript | null;
  /** What the command line preloads (`node -r`, `--import`): required roots, walked first, as they run first. */
  preloads?: readonly PreloadModuleRoot[];
  /** `entryCode` is an ES module (`-e` or stdin, entryEsModuleKey): the VFS key it is staged at. */
  entryEsModule?: string;
  /** A module's static filesystem references, as the data plan reads them (collectClosureWasmImages). */
  staticRefs?: (path: string) => Promise<StaticFsRefs | null>;
  /**
   * The files as they are, for a program that runs its own code and only
   * reads them (opencode's snapshot, _stageOpencodeFacet): the same files
   * and bound, without the module pass. Nothing is compiled, and the bound
   * charges what is carried.
   */
  dataOnly?: boolean;
}

/** A tool's config file: `<tool>.config.js|ts|mjs|cjs|mts|cts` (vite.config.ts, astro.config.mjs). */
const TOOL_CONFIG = /^(.+)\.config\.(?:c|m)?(?:j|t)s$/;

/**
 * The working dir's config files of the tool a launch runs. The tool
 * executes them (Vite bundles vite.config.ts and imports the result), so
 * what they import is code that nothing in the program's own graph names,
 * and a first run would miss it. They are optional roots: a command may
 * never read its config (`vite --version`), so a config graph past the
 * map's bound is cut, never a refusal. A config is the tool's when it is
 * named for the launched package or a package that one depends on (Astro
 * runs Vite, Vite runs PostCSS); a config of a tool the launch does not run
 * (eslint.config.js beside Vite) is not. What a config names by a string
 * (PostCSS's plugins) the tool loads by name: those join the walk's phase 2.
 */
export async function toolConfigRoots(vfs: LaunchFs, cwd: string, scriptPath: string | undefined): Promise<RequiredModuleRoot[]> {
  if (scriptPath === undefined) return [];
  // A bin is usually launched by its node_modules/.bin link.
  let script: string;
  try { script = await vfs.realpath(scriptPath); } catch { return []; }
  // Nimbus's bins are require() shims, not links: realpath still names
  // .bin/tool. Its manifest names the package entry whose tool dependencies
  // decide which configs to stage, exactly as a direct invocation does.
  const slash = script.lastIndexOf('/');
  if (slash >= 0) {
    try {
      const manifest = parseNpmBinManifest(await filesOf(vfs).readFileString(`${script.slice(0, slash)}/${NPM_BIN_MANIFEST_NAME}`));
      const linked = manifest?.bins[script.slice(slash + 1)];
      if (linked && await filesOf(vfs).exists(linked.targetPath)) script = await vfs.realpath(linked.targetPath);
    } catch { /* no readable bin manifest: an ordinary script */ }
  }
  const root = packageRootOf(script.replace(/^\/+/, ''));
  if (root === null) return [];
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(packageJsonText(await filesOf(vfs).readFileString(root + '/package.json'))) as Record<string, unknown>; } catch { return []; }
  const tools = new Set<string>(typeof manifest.name === 'string' ? [manifest.name] : []);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const named = manifest[field];
    if (named && typeof named === 'object') for (const name of Object.keys(named)) tools.add(name);
  }
  let entries: RuntimeVfsDirEntry[];
  try { entries = await vfs.readdir(cwd); } catch { return []; }
  const dir = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  return entries.flatMap((entry) => {
    const tool = entry.type === 'file' ? TOOL_CONFIG.exec(entry.name)?.[1] : undefined;
    return tool !== undefined && tools.has(tool) ? [{ path: (dir ? dir + '/' : '') + entry.name, config: true }] : [];
  });
}

/**
 * W2.6a: build the prefetch bundle for FacetManager.exec.
 *
 * The static walker supplies the complete known require closure. Separate
 * file and byte budgets bound optional enrichment for dynamic require and
 * synchronous filesystem patterns without removing required files.
 *
 * Optional files are evicted against the exact JSON-encoded payload size.
 * If required content still exceeds the per-module encoded ceiling, Worker
 * Loader side modules carry the bundle without truncating the closure.
 *
 * The module pass (transformBundleModules) runs on `esbuild`; without it,
 * ES modules and TypeScript stage as diagnostics.
 *
 */
export async function buildPrefetchBundle(vfs: LaunchFs, options: PrefetchBundleOptions): Promise<FacetVfsState> {
  return await withPrefetchAllocation(async (admission) => {
    const state = await gatherPrefetchBundle(vfs, options);
    admission.fit(state.rawBytes ?? 0);
    return state;
  });
}

/**
 * What a launch's build and module map hold live at their peak, per byte of
 * the closure they are made from: its cells, their serialized source and the
 * map made from it. Measured live (after a collection) as a build starts
 * serializing and as its launch ends: a ~17 MiB closure's launch at 45 MB
 * over its base (2.5 times).
 */
const PREFETCH_PEAK_PER_BYTE = 3;
// A speculative admission must fit a small module before paying for a bounced walk.
const PREFETCH_MIN_CLOSURE_BYTES = 4096;
const PREFETCH_ALLOCATION_OWNER: SupervisorAllocationOwner = { owner: 'prefetch bundle/map', attribution: 'prefetchBundleBytes' };

/** An admission to the supervisor's admitted transient budget (Kinu #29). */
interface PrefetchAdmission {
  /** It waited for room while other work ran. */
  readonly queued: boolean;
  /** The bytes it holds now. */
  held(): number;
  /**
   * What it is made from is known (`closureBytes`, and the bytes its map owns
   * beside them): it keeps only what that needs, giving the rest back.
   */
  fit(closureBytes: number, memberBytes?: number): void;
  /** Keeps only what the generated map owns while its launch waits for a worker. */
  retain(bytes: number): void;
  /** Holds `bytes` (within the budget) if what it lacks can be granted now, without waiting; else false. */
  grow(bytes: number): boolean;
  /** Registers its parked map until the worker is granted or the share is released. */
  reclaimable(reclaim: () => void): () => void;
  /** Gives it all back; once. */
  release(): void;
}

/**
 * What work made from a closure of `closureBytes` holds at its peak, within
 * the budget: its build's, or its generated map's `textBytes` if more, beside
 * the `memberBytes` the map owns (its wasm, its staged bindings).
 */
function prefetchNeed(closureBytes: number, memberBytes = 0, textBytes = 0): number {
  return Math.min(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
    Math.max(1, Math.ceil(Math.max(closureBytes * PREFETCH_PEAK_PER_BYTE, textBytes) + memberBytes)));
}

/**
 * What a launch waits for room under (FacetManager._launchEnds): aborted once
 * its process ends; ended by `dispose`.
 */
type LaunchWait = () => { readonly signal: AbortSignal; dispose(): void };

/**
 * An admission (Kinu #29): `bytes` of the supervisor's admitted transient
 * budget, by default the whole of it, taken at once, until its work has
 * measured the closure it is made from (`fit`), then PREFETCH_PEAK_PER_BYTE
 * times that at most, the rest given back to the work queued behind it. A
 * launch's build gathers its cells and serializes them under one, and keeps
 * it until its module map is generated (FacetManager.buildAdmissions), so no
 * other build runs beside them beyond what the budget holds. Nothing asks
 * the pool while holding one (two builds holding their cells while a third
 * queued for more deadlocked every one), and a launch asks it before it
 * holds a worker, never after (FacetManager's lock order: credit, or a
 * build joined, before a worker). One that has to wait for room waits under
 * `wait`: a launch whose process ends meanwhile is never admitted.
 */
async function admitPrefetch(wait?: LaunchWait, bytes = SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, copy = false, owner = PREFETCH_ALLOCATION_OWNER): Promise<PrefetchAdmission> {
  const now = tryAdmitPrefetch(bytes, copy, owner);
  if (now !== null) return now;
  const waiting = wait?.();
  try {
    const lease = await (copy ? acquireSupervisorCopyAllocation : acquireSupervisorAllocation)(bytes, waiting?.signal, owner);
    // Room came as its launch ended: given back, not used.
    if (waiting?.signal.aborted) {
      lease.release();
      throw waiting.signal.reason;
    }
    return admissionOf(lease, true);
  } finally {
    waiting?.dispose();
  }
}

/**
 * admitPrefetch's admission where there is room now, at once (no await);
 * null where it would wait. A `copy` (a map made from a state already
 * staged) takes the credit without shrinking the VFS cache.
 */
function tryAdmitPrefetch(bytes: number, copy = false, owner = PREFETCH_ALLOCATION_OWNER): PrefetchAdmission | null {
  const lease = (copy ? tryAcquireSupervisorCopyAllocation : tryAcquireSupervisorAllocation)(bytes, owner);
  return lease === null ? null : admissionOf(lease, false);
}

function tryAdmitPrefetchBuild(owner: SupervisorAllocationOwner): PrefetchAdmission | null {
  const budget = readSupervisorAllocationBudget();
  const free = budget.capacity - budget.current;
  return free / PREFETCH_PEAK_PER_BYTE < PREFETCH_MIN_CLOSURE_BYTES ? null : tryAdmitPrefetch(free, false, owner);
}

function admissionOf(admitted: SupervisorAllocationLease, queued: boolean): PrefetchAdmission {
  // Attributed so it lands under `prefetchBundleBytes`, not the unattributed remainder.
  const lease = attributeAllocation('prefetchBundleBytes', admitted);
  let released = false;
  let unregister: (() => void) | undefined;
  return {
    queued,
    held: () => (released ? 0 : lease.bytes),
    fit(closureBytes, memberBytes = 0) {
      const need = prefetchNeed(closureBytes, memberBytes);
      if (released || need >= lease.bytes) return;
      lease.shrinkTo(need);
    },
    retain(bytes) {
      const retained = Math.max(1, Math.min(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, bytes));
      if (retained > lease.bytes) throw new Error('Nimbus: a parked module map exceeds its supervisor credit');
      if (!released) lease.shrinkTo(retained);
    },
    grow(bytes) {
      const wanted = Math.min(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, bytes);
      return !released && (wanted <= lease.bytes || lease.tryGrowTo(wanted));
    },
    reclaimable(reclaim) {
      if (released) return () => {};
      unregister?.();
      const leave = reclaimableSupervisorAllocation(reclaim);
      unregister = leave;
      return () => {
        leave();
        if (unregister === leave) unregister = undefined;
      };
    },
    release() {
      unregister?.();
      unregister = undefined;
      released = true;
      lease.release();
    },
  };
}

/** `work` under an admission of its own (admitPrefetch's `wait` and `bytes`), given back as it ends. */
async function withPrefetchAllocation<T>(work: (admission: PrefetchAdmission) => Promise<T>, wait?: LaunchWait, bytes?: number, owner = PREFETCH_ALLOCATION_OWNER): Promise<T> {
  const admission = await admitPrefetch(wait, bytes, false, owner);
  try {
    return await work(admission);
  } finally {
    admission.release();
  }
}

/** The launch's cells, gathered from `vfs` (callers hold withPrefetchAllocation's admission). */
async function gatherPrefetchBundle(vfs: LaunchFs, options: PrefetchBundleOptions, creditLimit?: number): Promise<FacetVfsState> {
  if (creditLimit === undefined && prefetchReadCredit.getStore() === undefined) return gatherPrefetchWithin(vfs, options);
  const gate = creditLimit === undefined ? undefined : new PrefetchCreditGate(creditLimit, options.scriptPath ?? 'entry code');
  return prefetchReadCredit.run(gate, () => gatherPrefetchWithin(vfs, options, creditLimit));
}

async function gatherPrefetchWithin(vfs: LaunchFs, options: PrefetchBundleOptions, creditLimit?: number): Promise<FacetVfsState> {
  try {
    const state = await _buildPrefetchBundle(vfs, options);
    prefetchReadCredit.getStore()?.check();
    return state;
  } catch (error) {
    prefetchReadCredit.getStore()?.check();
    // The modules earlier runs executed are what an earlier run got through
    // without; they must not stop this one starting. A launch they (or
    // their emits, which the walk does not count) take past the bound is
    // built again with them as optional roots (RequiredModuleRoot.optional):
    // each staged whole as far as the bound allows, and what does not fit
    // loads late, as the run that learned it loaded it. Only a launch that
    // overflows pays the second build.
    const learned = options.executedModules ?? [];
    if (!(error instanceof ClosureBoundExceededError) || error.outcome.bound === creditLimit || learned.length === 0 || learned.every((root) => root.optional)) throw error;
    console.warn(`[facet-manager] the modules earlier runs executed take ${options.scriptPath ?? 'the entry code'}'s map past `
      + `its ${options.maxBundleBytes ?? VFS_BUNDLE_MAX_BYTES}-byte bound (${error.outcome.lastPath}); they are staged as optional roots, as far as the bound allows`);
    const state = await _buildPrefetchBundle(vfs, { ...options, executedModules: learned.map((root) => ({ ...root, optional: true })) });
    prefetchReadCredit.getStore()?.check();
    return state;
  }
}

async function _buildPrefetchBundle(
  vfs: LaunchFs,
  {
    scriptPath,
    cwd,
    entryCode,
    esbuild,
    bundleProfile = DEFAULT_FACET_BUNDLE_PROFILE,
    moduleScope = 'node',
    observedReads,
    pacer,
    maxBundleBytes = VFS_BUNDLE_MAX_BYTES,
    learnedFor,
    executedModules,
    transformStore,
    conditions = [],
    stripTypes = null,
    preloads = [],
    entryEsModule,
    staticRefs,
    dataOnly = false,
  }: PrefetchBundleOptions,
): Promise<FacetVfsState> {
  // Read the cursor BEFORE the walk: a mutation that lands while the bundle
  // is being assembled must be reported as invalidated, not silently missed.
  const admitted = await vfs.acquire(null, 0);
  const cursor = { epoch: admitted.epoch, rev: admitted.rev };
  // Where the build's time went, by phase (ms; the clock moves across its turns): its exec telemetry.
  const phases: Record<string, number> = {};
  let phaseFrom = Date.now();
  const phase = (name: string) => { const now = Date.now(); phases[name] = (phases[name] ?? 0) + now - phaseFrom; phaseFrom = now; };

  // Modules earlier runs executed belong to the complete required graph.
  // Adding them later as enrichment let final pruning remove one imported
  // sibling on every launch, so Nuxt/Vinext never reached a complete
  // executable map. A module that arrives with its text (Vite unlinks its
  // temporary config after loading it) is walked from that text. Files runs
  // only READ are observed reads below: data, never roots, whatever their
  // extension (Tailwind scans .js/.ts content files as text). The tool's
  // configs ride along, as optional roots (RequiredModuleRoot.config).
  const configRoots = [...preloads, ...await toolConfigRoots(vfs, cwd, scriptPath)];
  const walkRoots = (roots: Array<RequiredModuleRoot | PreloadModuleRoot>) => prefetchForRequire(filesOf(vfs), entryCode || '', cwd, scriptPath,
    maxBundleBytes, pacer?.spend.bind(pacer), undefined, roots.length > 0 ? roots : undefined, conditions);
  // A launch they take past the bound is built again with them optional (buildPrefetchBundle).
  const prefetch = await walkRoots([...configRoots, ...executedModules ?? []]);
  prefetchReadCredit.getStore()?.check();
  phase('walk');
  if ('kind' in prefetch) {
    // A required closure larger than the bound can never launch as a
    // snapshot. Surface it as the process's own failure rather than a
    // build error: the caller maps it to exit 1 + stderr.
    throw new ClosureBoundExceededError(prefetch);
  }
  const bundle: Record<string, string | Uint8Array> = { ...prefetch.bundle };
  Object.setPrototypeOf(bundle, null);
  const closurePaths: ReadonlySet<string> = new Set(
    Object.keys(prefetch.bundle).filter((path) => !prefetch.speculative.has(path)),
  );
  // Non-executable read evidence and other sessions' profiles may use only
  // the room the required executable graph leaves. Neither may displace it.
  const observedPaths = new Set<string>();
  const learnedPaths = new Set<string>();
  let room = maxBundleBytes;
  for (const path of closurePaths) room -= _bundleCellRawBytes(bundle[path]);
  let truncated = false;
  const budgetState = { totalBytes: 0, fileCount: 0 };
  const emits = new Map<string, string>();
  const codeOnly = new Set<string>();
  // Each enrichment pass below re-scans the bundle accumulated so far, so a
  // pass costs about what the bundle currently weighs however little it adds
  // — which is why the cost reported here is the bundle's weight and not
  // `budgetState.totalBytes`, the enrichment's own running total. A pass that
  // admits nothing still reads everything. Reporting the weight is what makes
  // a large program's build cross turns — pi's passes each scan tens of MB —
  // while a small one never reaches a chunk bound and runs exactly as it
  // always did, with no suspension at all.
  const paceAfterPass = () => {
    prefetchReadCredit.getStore()?.check();
    return pacer ? pacer.spend(_bundleWeight(bundle)) : Promise.resolve();
  };

  // 1.5 Observed reads. Every pass below this line guesses what a program
  //     will read — from a call shape, a package layout, a string literal —
  //     and each of them is wrong for whatever it did not anticipate. These
  //     paths are not a guess: an earlier run of the same entry asked for
  //     them synchronously and the bundle did not have them. So they are
  //     admitted first, ahead of every guess, and they join the required set
  //     rather than the evictable one, because a file evicted here misses
  //     again on the next run and the loop never closes.
  // Other sessions' misses in the packages this closure can load
  // (read-profile.ts) are evidence of the same kind: a learned module joins
  // the module map with its imports, as this session's own misses do.
  const learned = learnedFor ? await learnedFor(Object.keys(bundle)).catch(() => []) : [];
  const own = await addObservedReads(vfs, observedReads ?? new Set(), bundle, observedPaths, budgetState, Math.max(0, room), pacer);
  room -= own.bytes;
  const learnedOnly = new Set(learned.filter((path) => !observedReads?.has(path) && !observedPaths.has(path)));
  await addObservedReads(vfs, learnedOnly, bundle, learnedPaths, budgetState, Math.max(0, room), pacer);
  phase('e.observed');
  for (const path of observedPaths) learnedPaths.delete(path);
  await paceAfterPass();

  // 2. Greedy oversample — every installed pkg's pkg.json + main.
  //    Catches dynamic-require / `bindings()` / plugin-loader cases the
  //    regex prefetch misses. Its budget is independent from the complete
  //    static require closure, which is correctness-critical.
  const independentBeforeGroups = new Set(Object.keys(bundle));
  const greedy = (await greedyAddMainEntries(vfs, cwd, bundle, budgetState, prefetch.entryPaths ?? closurePaths, { maxBundleBytes, pacer, conditions }));
  phase('e.greedy');
  // Each landed learned root's closure (PrefetchResult.units) is one group
  // beside the greedy pass's, kept or evicted whole: a dependency evicted on
  // its own leaves a root in the map that cannot load.
  const learnedGroups: OptionalModuleGroup[] = (prefetch.units ?? []).map((unit) => ({ root: unit.root, members: new Set(unit.members) }));
  const learnedMembers = new Set<string>();
  for (const group of learnedGroups) for (const member of group.members) learnedMembers.add(member);
  const groups: OptionalModuleGroup[] = [...greedy.groups, ...learnedGroups];
  await paceAfterPass();
  // What the passes so far staged to run. Every pass below stages files to
  // be read, and so do the observed reads above.
  const stagedToRun = new Set(Object.keys(bundle));

  // What a source names (static-fs-refs.ts), analyzed once per build: a
  // staged file's by the manager's analysis of it (once per revision of the
  // file, which its data plan reads too), else from its text.
  const analyses = new Map<string, Promise<StaticFsRefs | null>>();
  const refsOf = (path: string, source: string): Promise<StaticFsRefs | null> => {
    let refs = analyses.get(path);
    if (refs === undefined) {
      refs = (async () => {
        const known = staticRefs !== undefined && bundle[path] === source ? await staticRefs(path) : null;
        if (known !== null) return known;
        await pacer?.spend(source.length);
        return findStaticFsReferences(source, '/' + path);
      })();
      analyses.set(path, refs);
    }
    return refs;
  };

  // 2.25 X.5-Z3, X.5-U: the assets staged modules read synchronously by a
  //      path they spell out (STATIC_ASSET_READS). Without them jsdom's
  //      `default-stylesheet.css` and ts-jest's `.ts-jest-digest` raised
  //      ENOENT in the facet though the files were there.
  await addStaticReads(vfs, bundle, budgetState, stagedJavaScript(bundle), refsOf, STATIC_ASSET_READS);
  phase('e.assets');
  await paceAfterPass();

  // 2.30 G3 (runtime-pkg wave): bin-target sibling oversample. Pulls
  //      ALL files under the entry's package root (capped at 200) so
  //      bins like cowsay that readFileSync('cows/X.cow') at runtime
  //      find their data files. Existing greedy/asset passes
  //      cover JS sources + a hardcoded extension list; this one
  //      catches custom extensions (.cow, .pem, .ttf, .wasm bundled
  //      as data, etc.) without needing a per-pkg whitelist.
  //      No-op when entry isn't inside node_modules.
  const binSiblingAdd = (await addBinTargetSiblings(vfs, scriptPath, bundle, budgetState, bundleProfile));
  phase('e.binSiblings');
  // What the passes that stage code have staged (the walk, the runs'
  // evidence, the package entries, a bin's siblings). The passes after them
  // carry files to be read (the working tree, absolute paths the entry
  // names): an ES module only they carry is a file, not a module of the map
  // (dataModules below).
  const codePaths = new Set(Object.keys(bundle));
  await paceAfterPass();

  // 2.34 project-data snapshot: sync Node fs cannot await the
  // supervisor. Include a bounded snapshot of the current working tree
  // for common relative project-file reads while skipping dependency
  // and Nimbus cache directories. Async fs still uses live supervisor
  // reads and child-process staleness fallback.
  const cwdProjectAdd = (await addCwdProjectFiles(vfs, cwd, bundle, budgetState));
  phase('e.cwdProject');
  void cwdProjectAdd;
  await paceAfterPass();

  // 2.35 shell compatibility: the absolute paths the entry code (`-e` or
  //      stdin code; a script is a staged module) and the staged modules
  //      spell as literals (STATIC_ABSOLUTE_LITERALS). The passes above look
  //      at installed packages and __dirname-relative reads, never at the
  //      user's own files by an absolute path, so `node -e
  //      'fs.readFileSync("/home/user/x.txt")'` raised ENOENT for a file
  //      `cat` reads.
  const entryKey = stripLeadingSlashes(scriptPath?.startsWith('/') ? scriptPath : `${cwd.replace(/\/+$/, '')}/[eval]`);
  const entrySource: Array<readonly [string, string]> = entryCode && bundle[entryKey] === undefined ? [[entryKey, entryCode]] : [];
  await addStaticReads(vfs, bundle, budgetState, [...entrySource, ...stagedJavaScript(bundle)], refsOf, STATIC_ABSOLUTE_LITERALS);
  phase('e.absPaths');
  await paceAfterPass();

  // 2.5 The module pass (core bundle-cell-transform.ts): each ES module read
  //     for staging, TypeScript stripped or compiled, CommonJS's import()
  //     routed; each result is the path's emit, and each ES module's import
  //     sites are kept for its staging below. A data-only build has none.
  const esModules = new Map<string, string>();
  // A file staged only to run carries its emit and not itself
  // (FacetVfsState.codeOnly): installed code is most of a map, and each ES
  // module carried twice would halve the closure the bound admits. One staged
  // to be read is carried as itself beside its emit: by a pass after the
  // module walk, because a run read it, or as a file of the working tree, the
  // project that tools read their sources and configs from (Vite bundling
  // vite.config.ts, tsc, a linter).
  const projectRoot = cwdProjectRoot(cwd);
  const runOnly = (path: string) =>
    stagedToRun.has(path) && !observedPaths.has(path) && !learnedPaths.has(path) && !inCwdProject(projectRoot, path);
  // A code-only file's cell is given its emit, the one string, the moment it
  // has one: the build never holds the file's bytes and its module both, and
  // what reads the cells for their code (bundleUsesNodeSqlite, the wasm and
  // binding scans) reads the module, which is all the map carries.
  const placeEmit = (path: string, code: string) => {
    prefetchReadCredit.getStore()?.charge(path, utf8Length(code), 'emit');
    emits.set(path, code);
    if (!runOnly(path)) return;
    bundle[path] = code;
    codeOnly.add(path);
  };
  let transforms: BundleCellTransformStats | undefined;
  phase('enrich');
  if (!dataOnly) {
    const packageTypeOf = await cellPackageTypes(vfs, Object.keys(bundle).filter(isBundleModuleCandidate));
    if (esbuild) {
      // Transient failures propagate through the launch failure path before
      // serialization/cache/LOADER publication. Per-source verdicts still use
      // the lazy diagnostic cells installed by transformBundleModules.
      transforms = await transformBundleModules(bundle, placeEmit, esModules, packageTypeOf, moduleScope, stripTypes, esbuild, pacer, transformStore);
      phase('transforms');
    } else {
      // No esbuild service was given: the ESM cells stage as diagnostics that
      // say so, rather than as source the registry rejects without a reason.
      _markBundleEsmAsFailed(bundle, placeEmit, packageTypeOf, 'no esbuild service was given to this launch');
    }
    // Each module's bundled records of the runtime's provided packages are
    // bound to them: the emit's, or the file's own when it is its module (a
    // TypeScript source never is). A file that changes has the result as its emit.
    for (const path of Object.keys(bundle)) {
      const cell = bundle[path];
      const code = emits.get(path) ?? (isBundleModuleCandidate(path) && bundleCompiledLoader(path) === null ? cell : undefined);
      // An ES module was bound before it was read (esbuild-service.ts preparedTransformSource).
      if (typeof code !== 'string' || esModules.has(path)) continue;
      await pacer?.spend(code.length);
      let bound: string;
      try {
        bound = rewriteProvidedCommonJsModules(code);
      } catch {
        // Unparseable: an emit stays as esbuild wrote it, and its require says
        // why; a file is not a module and has no records to bind (a LICENSE).
        continue;
      }
      if (bound !== code) placeEmit(path, bound);
    }
    await paceAfterPass();
    phase('bind');
  }
  // 4. The snapshot's size guard, in the unit the session DO's memory was
  //    measured in and the require walk counts: raw bytes, a cell's UTF-8
  //    length (VFS_BUNDLE_MAX_BYTES, platform/limits.ts, unless the caller
  //    set its own). The per-module text limit is met by side modules and is
  //    not a reason to evict. Only
  //    OPTIONAL enrichment is evictable; the static require closure stays, and
  //    a closure past the bound by itself fails the launch by name.
  //
  //    Evicting an enrichment file is a real loss — the sync fs reads it
  //    exists for cannot fall back to the supervisor — so the paths that
  //    went are named rather than silently dropped.
  const rawBytes = new Map<string, number>();
  let rawTotal = 0;
  /** What the bound evicts, held until its images and reads are named below. */
  const evictedCells: Record<string, string | Uint8Array> = {};
  Object.setPrototypeOf(evictedCells, null);
  for (const [path, cell] of Object.entries(bundle)) {
    const bytes = codeOnly.has(path) ? 0 : _bundleCellRawBytes(cell);
    rawBytes.set(path, bytes);
    rawTotal += bytes;
  }
  // A module's emit is part of what its path costs, beside its file when that is carried.
  for (const [path, emit] of emits) {
    const bytes = utf8Length(emit);
    rawBytes.set(path, (rawBytes.get(path) ?? 0) + bytes);
    rawTotal += bytes;
  }
  if (rawTotal > maxBundleBytes) {
    // This content ceiling is independent of the transient limit checked after each pass.
    // Only the walk's closure can fail a launch, and the path it names is the
    // one whose bytes (with its emit) crossed the bound, in walk order.
    let closureBytes = 0;
    let crossedAt: string | null = null;
    for (const path of closurePaths) {
      closureBytes += rawBytes.get(path) ?? 0;
      if (crossedAt === null && closureBytes > maxBundleBytes) crossedAt = path;
    }
    if (crossedAt !== null) {
      throw new ClosureBoundExceededError({
        kind: 'closure-exceeds-bound',
        entry: scriptPath ?? 'entry code',
        bytesSeen: closureBytes,
        bound: maxBundleBytes,
        lastPath: crossedAt,
      });
    }
    // An emit goes with its source: required when the source is.
    //
    // Order matters as much as the bound. Largest-first alone ranks a cell by
    // what it costs and never by what losing it costs: an admitted module and
    // the sibling it imports are both "optional", and shedding the sibling
    // leaves a module in the bundle that cannot load. On `astro dev` the
    // snapshot breached its bound by 591 files, and among the largest were
    // modules while 3,291 declaration files (never a require target) stayed.
    //
    // Unloadable cells first, then enrichment largest-first, then dynamic-import
    // subtrees last-discovered first, so a CLI's own `import()` deferral is shed last.
    const speculativeRank = new Map<string, number>();
    for (const path of prefetch.speculative) speculativeRank.set(path, speculativeRank.size);
    const rankOf = (path: string): number => speculativeRank.get(path) ?? -1;
    // Evidence goes after all enrichment: what others learned before this
    // session's own misses, each tier last-admitted first.
    const tierOf = (path: string): number =>
      closurePaths.has(path) ? 3 : observedPaths.has(path) ? 2 : learnedPaths.has(path) ? 1 : 0;
    const members = new Set<string>();
    for (const group of groups) for (const path of group.members) members.add(path);
    // A learned closure was staged before the greedy pass and is a group all the same.
    const independent = new Set(Object.keys(bundle).filter(path =>
      !members.has(path) || (independentBeforeGroups.has(path) && !learnedMembers.has(path))));
    const keptGroups = new Set(groups);
    const weight = (path: string) => rawBytes.get(path) ?? 0;
    const unitBytes = new Map<string, number>();
    for (const group of groups) {
      let total = 0;
      for (const member of group.members) if (!independent.has(member)) total += weight(member);
      unitBytes.set(group.root, total);
      if (pacer) await pacer.spend(group.members.size * 256);
    }
    const lastAdmittedFirst = (tier: Set<string>): string[] => [...tier].reverse().filter(path => independent.has(path));
    const enrichment = [...independent, ...groups.map(group => group.root)]
      .filter(path => tierOf(path) === 0)
      .sort((a, b) => {
        const loadable = (_isLoadableModuleCell(a) ? 1 : 0) - (_isLoadableModuleCell(b) ? 1 : 0);
        if (loadable !== 0) return loadable;
        const rankA = rankOf(a);
        const rankB = rankOf(b);
        if (rankA !== rankB) return rankA < 0 ? -1 : rankB < 0 ? 1 : rankB - rankA;
        return (unitBytes.get(b) ?? weight(b)) - (unitBytes.get(a) ?? weight(a));
      });
    const evictable = [...enrichment, ...lastAdmittedFirst(learnedPaths), ...lastAdmittedFirst(observedPaths)];
    const kept = await retainWithinBound(maxBundleBytes, rawTotal, independent, keptGroups, evictable, rawBytes, pacer);
    const retained = kept.retained;
    rawTotal = kept.rawTotal;
    const evicted: BundleCellSize[] = [];
    for (const k of Object.keys(bundle)) {
      if (retained.has(k)) continue;
      evicted.push([k, rawBytes.get(k) ?? 0]);
      evictedCells[k] = bundle[k]!;
      delete bundle[k];
      emits.delete(k);
      esModules.delete(k);
      codeOnly.delete(k);
    }
    // How many it evicted, beside the phases' times (exec telemetry).
    phases.evicted = evicted.length;
    if (evicted.length > 0) {
      truncated = true;
      console.warn(
        `[facet-manager] prefetch snapshot exceeded ${maxBundleBytes} bytes; `
          + `evicted ${evicted.length} optional file(s). They still exist and `
          + `async reads still return them; synchronous reads raise EAGAIN: `
          + `${describeBundleCells(evicted)}`,
      );
    }
  }

  const fileCount = Object.keys(bundle).length;

  phase('guard');
  // What only an import() reaches: phase 2's modules, less any a staged
  // package entry's static walk reaches (a synchronous require of that entry
  // evaluates them too). Each with the lazy modules that import it.
  const reachedStatically = new Set<string>();
  for (const group of groups) for (const member of group.members) reachedStatically.add(member);
  const lazyModules = [...prefetch.speculative].filter((path) => bundle[path] !== undefined && !reachedStatically.has(path));
  const lazySet = new Set(lazyModules);
  const lazyImporters: Record<string, string[]> = {};
  for (const [from, children] of prefetch.edges ?? []) {
    if (!lazySet.has(from)) continue;
    for (const child of children) if (lazySet.has(child)) (lazyImporters[child] ??= []).push(from);
  }

  // An evicted module is still one the program may load late (as runtime
  // code, through an import()): its images ride in the map, bytes only since
  // they compile on first use, and its reads are named for that import().
  const wasmImages = dataOnly ? [] : await collectClosureWasmImages(vfs, { ...bundle, ...evictedCells }, binSiblingAdd.wasmPaths, staticRefs);
  phase('wasm');
  const readers = evictedReaders(evictedCells);

  // The ES modules the map carries, staged as the process's registry
  // evaluates them (esm-stage.ts), `-e` or stdin code that is one among them
  // (entryModule). A staged module's text supersedes its emit, which no
  // longer needs holding.
  let esm: EsmStage | undefined;
  const dataModules = new Set<string>();
  if (esModules.size > 0 || entryEsModule !== undefined) {
    const cells = new Map<string, { code: string; sites: ImportSites }>();
    if (entryEsModule !== undefined && entryCode !== undefined) {
      cells.set(entryEsModule, { code: entryCode, sites: readEsModule(entryCode, moduleScope) });
    }
    for (const [key, sites] of esModules) {
      const code = emits.get(key);
      if (code === undefined) continue;
      if (codePaths.has(key)) cells.set(key, { code, sites: JSON.parse(sites) as ImportSites });
      else dataModules.add(key);
    }
    // A data module is carried as its file only: staging the working tree's
    // modules (an example app's sources, importing packages not installed)
    // cost every launch in it its listings and refusals, for code no
    // program here imports. One a program does import is loaded as a file
    // the launch did not stage (node-shims' __loadModule), and the next
    // launch walks it from the run's record.
    for (const key of dataModules) emits.delete(key);
    const held = (key: string) => {
      const cell = bundle[key];
      return typeof cell === 'string' ? cell : undefined;
    };
    const entries = async (dir: string) => {
      try { return new Map((await vfs.readdir(dir)).map((entry) => [entry.name, entry.type])); } catch { return null; }
    };
    phase('fit');
    const credit = prefetchReadCredit.getStore();
    // With no module to stage, the map carries no ES module host at all.
    if (cells.size > 0) esm = await stageEsModules({ files: filesOf(vfs), realpath: async (path) => await vfs.realpath(path), entries, held }, cells, {
      conditions,
      cwd,
      scope: moduleScope,
      stripsTypes: stripTypes !== null && stripTypes !== 'javascript',
      typeScript: stripTypes !== 'javascript',
      isCode: (key) => !dataModules.has(key) && (emits.has(key) || (typeof bundle[key] === 'string' && isCodeCellPath(key))),
      gate: true,
      emitted: credit === undefined ? undefined : (path, text) => credit.charge(path, utf8Length(text), 'emit'),
    });
    // Staging reads and rewrites its modules' text, which the map's
    // serialization spends as it carries each one (buildFacetVfsBundleSource),
    // as it spent each lowered module's emit: each staged byte is spent once.
    // A pass's bundle weight here cost a launch over lodash-es a turn of its own.
    for (const key of esm?.modules.keys() ?? []) emits.delete(key);
    phase('stage');
  }
  phase('rest');

  return {
    bundle,
    phases,
    ...(emits.size > 0 ? { emits } : {}),
    ...(esm ? { esm, esmSize: esmStageSize(esm) } : {}),
    ...(dataModules.size > 0 ? { dataModules } : {}),
    ...(codeOnly.size > 0 ? { codeOnly } : {}),
    cursor,
    reachableCount: fileCount,
    truncated,
    rawBytes: rawTotal,
    ...(transforms ? { transforms } : {}),
    ...(lazyModules.length > 0 ? { lazyModules, lazyImporters } : {}),
    ...(readers.length > 0 ? { evictedReaders: readers } : {}),
    ...(wasmImages.length > 0 ? { wasmImages } : {}),
  };
}

/** At most this many evicted readers are planned: the launch's start args carry their reads. */
const EVICTED_READERS_MAX = 256;
const SYNC_CALL_NAME = /[a-z]Sync\b/;

/**
 * The evicted JavaScript modules whose text names a synchronous call: the
 * ones the data plan reads (static-fs-refs.ts, from the VFS as written).
 * Most of what a bound evicts is data or declarations (Astro's 575 shiki
 * grammars and .d.ts files), which this costs a substring search.
 */
export function evictedReaders(cells: Readonly<Record<string, string | Uint8Array>>): string[] {
  const readers: string[] = [];
  for (const [path, cell] of Object.entries(cells)) {
    if (readers.length >= EVICTED_READERS_MAX) break;
    // \`Sync\` and not \`Sync(\`: a bundled module calls \`(0, import_fs.readFileSync)(…)\`.
    if (typeof cell === 'string' && /\.[cm]?js$/.test(path) && SYNC_CALL_NAME.test(cell)) readers.push(stripLeadingSlashes(path));
  }
  return readers;
}

// ── FacetManager ────────────────────────────────────────────────────────

/**
 * Optional hooks wired in by NimbusSession. Kept as callbacks so
 * FacetManager stays unaware of the session / log-store types.
 */
export interface FacetManagerHooks {
  /**
   * The workspace's network (`workspace.network`): every process the manager
   * runs goes out through it, its binding carrying the egress. The session's
   * composition supplies it; absent, the isolate's own network.
   */
  network?: () => WorkspaceNetwork;
  /**
   * The host's own SUPERVISOR for a one-shot (Supervise), handed to it with
   * the call that runs it. Absent, each gets its binding.
   */
  supervise?: Supervise;
  /**
   * Fired when a process was terminated OUTSIDE the facet's own try/
   * finally (timeout via abort, explicit kill, etc.) — the facet never
   * runs its own `reportExit`, so the session side won't hear about the
   * exit unless we call it here.
   */
  onExternalExit?: (pid: number, code: number, reason: string) => void;
  /** Fired right after the supervisor's spawn — lets the session print a notification. */
  onSpawn?: (pid: number, command: string, longRunning: boolean) => void;
  /**
   * Deliver output as the process's own, as its supervisor RPC would: what a
   * run that stopped at a read of stdin had not delivered yet, and why a
   * process that stopped could not go on (runtime/stop-replay.ts).
   */
  deliverOutput?: (pid: number, stream: 'stdout' | 'stderr', bytes: Uint8Array) => void | Promise<void>;
  /**
   * A process's stdin channel, wherever its writer queues it: the session's
   * input store, or a child_process child's queue in the broker. A run that
   * stopped at a read of stdin waits on it, and what it took goes back in
   * front of it (runtime/stop-replay.ts). Null when the pid has none.
   */
  stdinChannel?: (pid: number) => StdinChannel | null;
  /**
   * Close a live process's descriptors: a run of it that stopped at a read of
   * stdin goes, and the next opens its own, numbered as the run before's
   * were (runtime/stop-replay.ts).
   */
  rewindProcessFiles?: (pid: number) => Promise<void>;
  /**
   * Arrange for `pumpResidentLaunches` to run on a fresh Durable Object turn.
   *
   * The session satisfies this with an alarm, which is the only primitive that
   * genuinely re-enters the object: a fresh turn is both a released thread and
   * a fresh CPU budget, and a launch needs each for a different reason.
   */
  requestLaunchTurn?: (notBefore?: number) => void | Promise<void>;
  /**
   * Put a line in front of the user, whether or not a terminal is attached.
   *
   * Distinct from writing to a process's output: what this reports happened to
   * the SESSION, and the socket that would have shown it is typically the one
   * the event destroyed. The session satisfies it with the live terminal when
   * there is one and the persisted scrollback when there is not, so the line
   * survives until someone reconnects to read it.
   */
  notify?: (line: string) => void;
  /**
   * Resolve the launch inputs a journalled worker launch needs re-driven with.
   * Keyed by `recipe.owner`: the embedder's own record of the durable
   * application decides — `null` means it is stopped or removed, so it is not
   * restarted.
   */
  resolveWorkerLaunch?: (recipe: WorkerRecipe) => Promise<ResolvedWorkerLaunch | null>;
  /**
   * The session's own default resolver, reading the durable image store a
   * self-owned spawn persisted under `.nimbus/images/`. Consulted ONLY when
   * `resolveWorkerLaunch` is absent — an embedder's hook still overrides
   * everything. Being the fallback is also what it is *not*: it can never
   * re-mint a live globalOutbound binding, so a durable spawn carrying one
   * is refused unless the embedder hook exists.
   */
  resolveWorkerLaunchFallback?: (recipe: WorkerRecipe) => Promise<ResolvedWorkerLaunch | null>;
  /**
   * The environment a process was launched with, asked for again when it is
   * relaunched: a re-drive after a reset, an on-failure restart, a durable
   * application's relaunch on its port, a dev server's restore. Nimbus keeps
   * no process's environment in any record, image or source (ask 62): a host
   * that answers `null`, throws or composes none fails that relaunch, named.
   */
  resolveProcessEnv?: ResolveProcessEnv;
  /**
   * Where a host that answers resolveProcessEnv from its own keeping keeps
   * each relaunchable launch's environment: a row beside its record, written
   * and deleted with it (the session's, session/process-env.ts). An embedder
   * that knows its processes' environments composes resolveProcessEnv alone.
   */
  keepProcessEnv?: ProcessEnvKeeping;
}

export interface ForegroundLaunch {
  signal: AbortSignal;
  write(stream: 'stdout' | 'stderr', bytes: Uint8Array): void | Promise<void>;
}

export interface LongRunningWorkerSpawnOptions {
  /** Interpreter residents share Node's atomic derived-owner claim. */
  resident?: { runtime: 'ruby' | 'python'; argv: string[] };
  /**
   * The command that launched the process, waiting on its boot: until the
   * boot settles the process's output goes there instead of the shell
   * mirror, and the command's interrupt kills the process.
   */
  foreground?: ForegroundLaunch;
  restart?: ResidentRestartPolicy;
  port?: number;
  /** The process whose command starts this one: its parent, whose credential and exec id it takes. Never journalled. */
  invokerPid?: number;
  /**
   * Who the process is when no invoker says: the argv its identity derives
   * from, the credential it runs as, its exec id, and the process it restarts
   * (a dev server a new incarnation of the session runs again). Exclusive with `invokerPid`, `resident` and
   * `durable`: a journalled launch is re-driven as its row says, which keeps
   * no such identity.
   */
  identity?: { argv: string[]; cred: VfsCred; execId?: string; restartedFrom?: ProcessRestart };
  /** Inline modules: source text, or small wasm carried by value. */
  modules?: Record<string, string | { wasm: ArrayBuffer }>;
  /**
   * Module name → VFS path of a wasm image the process's host materializes
   * for itself. Runtime images belong here, not in `modules`: ruby's is
   * 34.3 MiB, past what any single RPC value may carry.
   */
  vfsWasmModules?: Record<string, string>;
  /**
   * Module name → VFS path of a content-addressed module SOURCE, read as
   * UTF-8 when the facet loads — the same by-path posture as
   * `vfsWasmModules`, through the same kernel image reader, for module text
   * an embedder keeps in its own content store rather than carrying by value.
   * Each path must name its own digest (`…/<sha256>.js`, see fabric's
   * `facetImagePath`); the loader verifies it on read.
   */
  vfsTextModules?: Record<string, string>;
  /**
   * The module the isolate boots from; `workerCode` is placed under this name
   * in the module map. Default `'worker.js'`.
   */
  mainModule?: string;
  compatibilityFlags?: string[];
  compatibilityDate?: string;
  env?: ResidentCodeSpec['env'];
  /** Live bindings beside the process's own SUPERVISOR (ResidentCodeSpec.bindings); exclusive with `env` and `durable`. */
  bindings?: ResidentCodeSpec['bindings'];
  globalOutbound?: ResidentCodeSpec['globalOutbound'];
  /** Forwarded verbatim to the runner's startProcess. */
  startArgs?: unknown;
  /**
   * What an interpreter resident's `startArgs.userEnv` was built from: its
   * command's environment (`base`) and its runtime's facts (core
   * interpreter-env.ts). Never stored whole: its image keeps the facts
   * (`envFacts`), and its relaunch asks the host for the base again
   * (resolveProcessEnv) and builds the rest as the first launch did.
   */
  interpreterEnv?: InterpreterLaunchEnv;
  /**
   * Set for a worker a durable application owns: the launch is journalled and
   * re-driven after an instance reset through `hooks.resolveWorkerLaunch`.
   * A plain spawnWorker stays unjournaled.
   */
  durable?: { owner: string; image?: { runner: string; application: string } };
}

/** The main module name a worker launch boots from unless told otherwise. */
export const DEFAULT_WORKER_MAIN_MODULE = 'worker.js';

/**
 * The narrow handle `spawnWorker` returns beside the pid: the process's own
 * inbound surface, bound to the resident handle's route target, for an
 * embedder that invokes the worker directly rather than through a registered
 * port. It carries NO release — `kill(pid)` remains the one lifecycle owner,
 * and this handle is dead once that pid is; nothing here can end, restart or
 * detach the process.
 */
export interface WorkerFacet {
  /** Inbound HTTP, on the facet's `handleHttpRequest`. */
  fetch(request: Request): Promise<Response>;
  /** Inbound WebSocket upgrade, on the facet's `handleWebSocketRequest`. */
  connect(request: Request): Promise<Response>;
}

/** What `spawnWorker` answers with. */
export interface SpawnedWorker {
  pid: number;
  /** The runner's startProcess payload. */
  boot: unknown;
  facet: WorkerFacet;
}

const ROUTEABLE_PORT_ATTACH_TIMEOUT_MS = 1_000;

/** A port request may wait this long for a durable app's re-drive to boot. */
const DURABLE_ENSURE_BOOT_BUDGET_MS = 12_000;

/** What `spawnNode` needs to build and boot one resident Node process. */
export interface ResidentSpawnOptions {
  argv?: string[];
  /** A node program's command line: its options, conditions, preloads and `-e`/`-p` code (core runtime/node-cli.ts). */
  node?: NodeLaunch;
  env?: Record<string, string>;
  cwd?: string;
  filename?: string;
  dirname?: string;
  /** The program is an ES module (RuntimeRunOpts.esModule). */
  esModule?: boolean;
  /** CommonJS evaluated before the entry (node-runner.ts RunFreshOpts.preamble). */
  preamble?: string;
  /** Whose scope the runtime runs an ES module in (RuntimeRunOpts.moduleScope): absent, Node's. */
  moduleScope?: ModuleScope;
  command?: string;
  port?: number;
  attachedTty?: boolean;
  /**
   * A one-shot that stopped at its first listen (FacetManager._promote): its
   * run, which this boot replays up to that listen before it serves, and the
   * stdin that run took, handed back: its pipe's bytes, or its `< file`.
   */
  resume?: StoppedRunNext;
  /** Its stdin, given whole (exec's `stdin`): a promoted one-shot's, given again. */
  stdin?: string;
  /** Its `< file`, read from the start: a promoted one-shot's, run again from its start unretraced (_promote). */
  stdinFile?: NonNullable<ExecLaunchOpts['stdinFile']>;
  /** The run its output is tagged with, past one that stopped: a promoted one-shot's, run again from its start unretraced. */
  run?: number;
  /**
   * Its launcher writes its stdin and ends it, and does not wait for the
   * boot (RuntimeRunOpts.stdinWriter): the boot may stop at a synchronous
   * read of stdin and boot again once the input is there.
   */
  stdinWriter?: boolean;
  skipSpawn?: boolean;
  callerPid?: number;
  /** The process whose command starts this one: its parent, whose credential and exec id it takes. Never journalled. */
  invokerPid?: number;
  bundleProfile?: FacetBundleProfile;
}

/** The launch inputs a re-drive rebuilds a worker from: content digests and
 *  transport, never env or credentials — the embedder resolves those. */
export interface WorkerRecipe {
  /**
   * Set only for an interpreter resident the SESSION launched itself — a
   * `python`/`ruby` socket server whose image is the runtime the session
   * installed. It is the runtime and argv of that interpreter, never a
   * boolean, and it is what routes the recipe's re-drive to the session's own
   * image-store fallback (`resolveWorkerLaunchFallback`) rather than the
   * embedder's `resolveWorkerLaunch`: the session owns that image and its
   * bookkeeping, and no embedder was asked about the launch. A worker recipe
   * WITHOUT it — every embedder-driven `spawnWorker` — re-drives through the
   * embedder's resolver, with the fallback consulted only when no embedder
   * hook is composed.
   */
  resident?: LongRunningWorkerSpawnOptions['resident'];
  kind: 'worker';
  /** The durable application this process belongs to, keyed by the embedder. */
  owner: string;
  /** Content digests of the two images the launch was built from. */
  image: { runner: string; application: string };
  port: number;
  cwd: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  startArgs?: unknown;
  /**
   * The main module the launch booted from, when it was not the default —
   * so a re-drive whose resolver answers modules alone still boots the same
   * one. Rows written before the field existed booted `worker.js`.
   */
  mainModule?: string;
}
interface NodeRecipe { kind: 'node'; code: string; opts: ResidentSpawnOptions }
/**
 * The port/owner a resident's journal row carries once it has claimed a
 * reserved port — the row-level fields `ensureDurableAppOnPort` and
 * `removeDurableApp` read. A durable worker launch writes them at journal
 * time (its recipe already knows both); a node resident that binds a
 * reserved port at runtime has them stamped at REGISTRATION, which is the
 * moment the reservation's durability contract reaches it. A row without
 * them belongs to a launch no reservation has claimed.
 */
interface ResidentLaunchRecord extends FencedWorkRecord {
  recipe: NodeRecipe | WorkerRecipe;
  port?: number;
  owner?: string;
  /**
   * What to do when the PROCESS ends on its own with a non-zero code — a
   * platform reset re-drives regardless. 'never' (the default) releases the
   * row like a clean exit; 'on-failure' re-drives it under the restart
   * budget with backoff.
   */
  restart?: ResidentRestartPolicy;
  /** The reserved port `$PORT` was injected with — what a registration is checked against. */
  injectedPort?: number;
  /** The resident bound a different port than its reservation holds while `$PORT` was injected. */
  portMismatch?: { listened: number; reserved: number };
  /**
   * The process's exec id (`ProcessEntry.execId`). A re-drive has no
   * invoking process to take it from, so the row carries it to the process
   * it spawns.
   */
  execId?: string;
  /**
   * The credential the process ran under (`ProcessEntry.cred`), carried to
   * the process a re-drive spawns for the same reason. Absent from a row an
   * earlier release wrote, which is not re-driven: it would run as the
   * session user, whoever had started it.
   */
  cred?: VfsCred;
}

/**
 * Who a launch runs as in place of an invoker: a re-drive's journal row, which
 * also names what it restarts, or what a caller restores (a dev server's
 * persisted identity).
 */
interface LaunchIdentity {
  cred: VfsCred;
  execId?: string;
  /** The process the session lost when it restarted, and what it was doing then. */
  restart?: { from: ProcessRestart; doing: string };
}

/** What relaunching `pid` from `record` under `identity` asks its host (facets/process-env.ts). */
function relaunchRequest(record: string, pid: number, identity: LaunchIdentity): ProcessEnvRequest {
  return { pid, cred: identity.cred, record, ...execIdField(identity) };
}

export type ResidentRestartPolicy = 'never' | 'on-failure';
/** The env var a launch reads its restart policy from — set by startProcess({ restart }) and `nimbus start --restart`. */
export const RESTART_POLICY_ENV = 'NIMBUS_RESTART';
/** A process whose host the platform reset ends as a killed one does (SIGKILL's 137). */
const HOST_LOST_EXIT_CODE = 137;
/** Backoff per spent FencedWork attempt; a healthy boot resets that existing budget. */
const RESTART_BACKOFF_BASE_MS = 1_000;

function residentRestartPolicy(env: Record<string, string> | undefined): ResidentRestartPolicy {
  return env?.[RESTART_POLICY_ENV] === 'on-failure' ? 'on-failure' : 'never';
}

/** A record an earlier release wrote with the environment its process ran with in it. */
const RecordHoldingEnvSchema = z.looseObject({ env: z.record(z.string(), z.string()) });

/** What an interpreter resident's environment is built from; no facts for a launch its runtime did not build (an embedder's own). */
interface InterpreterLaunchEnv {
  base: Record<string, string>;
  facts: InterpreterEnvFacts | null;
}

/** An interpreter resident's start payload, as its environment members parse; a launch given none has none. */
const InterpreterStartArgsSchema = z.looseObject({
  userEnv: z.record(z.string(), z.string()).optional(),
  envFacts: InterpreterEnvFactsSchema.optional(),
}).default({});

function interpreterStartArgs(startArgs: unknown): z.infer<typeof InterpreterStartArgsSchema> {
  const parsed = InterpreterStartArgsSchema.safeParse(startArgs);
  if (!parsed.success) throw new Error(`Nimbus: an interpreter resident's start payload is malformed: ${parsed.error.message}`);
  return parsed.data;
}

/** An interpreter resident's start payload as its image keeps it: what its environment is built from, never the environment. */
function storedStartArgs(startArgs: unknown, interpreterEnv: InterpreterLaunchEnv | undefined): unknown {
  const { userEnv: _built, envFacts: _facts, ...rest } = interpreterStartArgs(startArgs);
  return interpreterEnv?.facts ? { ...rest, envFacts: interpreterEnv.facts } : rest;
}

/** What an interpreter resident is relaunched with: its image's payload, its environment built again on the host's answer. */
function relaunchInterpreter(stored: unknown, base: Record<string, string>): { startArgs: unknown; interpreterEnv: InterpreterLaunchEnv } {
  const { envFacts, ...rest } = interpreterStartArgs(stored);
  return {
    startArgs: { ...rest, userEnv: envFacts === undefined ? base : interpreterProcessEnv(base, envFacts) },
    interpreterEnv: { base, facts: envFacts ?? null },
  };
}

/** A relaunch's environment carrying its record's restart policy: Nimbus's own setting, which the host's answer need not. */
function withRestartPolicy(env: Record<string, string>, restart: ResidentRestartPolicy | undefined): Record<string, string> {
  return restart === 'on-failure' ? { ...env, [RESTART_POLICY_ENV]: 'on-failure' } : env;
}

/** One application as `apps.list` reports it — every stamped identity, live or not. */
export interface ResidentAppSummary {
  owner: string;
  name: string | null;
  port: number | null;
  pid: number | null;
  status: 'running' | 'starting' | 'stopped' | 'failed';
  visibility: PortVisibility;
  capability: string | null;
  restart: ResidentRestartPolicy;
  /** Set with status 'failed': what went wrong, in the user's terms. */
  diagnostic: string | null;
  /** The exec id of `pid` (`ProcessEntry.execId`); absent when it has none. */
  execId?: string;
  /** The process `pid` restarts (`ProcessEntry.restartedFrom`); absent when it is no restart. */
  restartedFrom?: ProcessRestart;
}

/** What an app reports of its live process: its exec id and the process it restarts, each when it has one. */
function processReportFields(entry: ProcessEntry | undefined): { execId?: string; restartedFrom?: ProcessRestart } {
  return {
    ...execIdField(entry),
    ...(entry?.restartedFrom === undefined ? {} : { restartedFrom: entry.restartedFrom }),
  };
}

/** What a pid's journal row says about who it is. */
export interface ResidentIdentity {
  owner: string | undefined;
  ephemeral: boolean;
  port: number | undefined;
}

/**
 * The durable owner a journal row serves: the row's stamped field for
 * reservation-claimed residents, falling back to the worker recipe's own
 * owner for rows written before the stamping rule landed.
 */
function residentOwner(record: ResidentLaunchRecord): string | undefined {
  return record.owner ?? (record.recipe.kind === 'worker' ? record.recipe.owner : undefined);
}
/** What the embedder supplies for a re-driven worker launch. */
export interface ResolvedWorkerLaunch {
  startArgs?: unknown;
  /** Null is the absent answer — the same JSON the image blob carries. */
  env: ResidentCodeSpec['env'] | null;
  globalOutbound: ResidentCodeSpec['globalOutbound'];
  /** Module name → source text or inline wasm (`{ wasm }`), including the main module, text, under its name. */
  modules: Record<string, string | { wasm: ArrayBuffer }>;
  /** Module name → VFS path of a wasm image, restored with the launch. */
  vfsWasmModules?: Record<string, string>;
  /** Module name → VFS path of a content-addressed module source, restored with the launch. */
  vfsTextModules?: Record<string, string>;
  /**
   * The name in `modules` the launch boots from. Absent, the recipe's own
   * `mainModule` decides, then `'worker.js'`.
   */
  mainModule?: string;
}

/** 'running' is the measured common case: the platform's reset strikes
 *  seconds after a launch settles, while the resident runs. */
function residentLaunchDoing(record: FencedWorkRecord): string {
  return record.phase === 'running' ? 'running' : 'starting';
}

/**
 * Why a resident is not restarted again: its budget is spent, and it has not
 * run RESIDENT_PROVEN_MS since it was last restarted (fenced-work.ts). One
 * the session lost while running had been restarted already: a new process
 * whose isolate has used about a second of CPU makes Cloudflare restart the
 * session (spike/isolate-move), and restarting it again would only repeat
 * that. One whose host the platform reset again (a peer, process-host.ts)
 * repeats it the same way. One that exited again is in a crash loop.
 */
function residentAbandonedNotice(record: FencedWorkRecord, cause: RedriveCause): string {
  const proven = `${RESIDENT_PROVEN_MS / 1000} s`;
  if (cause.kind === 'exited') {
    return `\x1b[2m[nimbus: "${record.command}" exited with code ${cause.code} again before it had run ${proven} `
      + `since its restart, so it is left stopped; start it again with: ${record.command}]\x1b[0m\r\n`;
  }
  if (cause.kind === 'host-reset') {
    return `\x1b[2m[nimbus: the platform reset the host of "${record.command}" again before it had run ${proven} `
      + 'since its restart, so it is left stopped: Cloudflare resets a process\'s host when a newly started process '
      + `has used about a second of CPU, and restarting it would do that again; start it again with: ${record.command}]\x1b[0m\r\n`;
  }
  if (record.phase === 'running') {
    return `\x1b[2m[nimbus: the session restarted again before "${record.command}" had run ${proven} since its restart, `
      + 'so it is left stopped: Cloudflare restarts a session when a newly started process has used about a second '
      + `of CPU, and restarting it would do that again; start it again with: ${record.command}]\x1b[0m\r\n`;
  }
  return '\x1b[2m[nimbus: the session restarted again while '
    + `"${record.command}" was ${residentLaunchDoing(record)} — leaving it stopped]\x1b[0m\r\n`;
}

export class FacetManager {
  private ctx: DurableObjectState;
  private env: FacetManagerEnv;
  private processes: SessionProcessSupervisor;
  private portRegistry: PortRegistry;
  private vfs: SqliteVFS | null = null;
  private filesystem: NimbusFilesystemAuthority | null = null;
  private hooks: FacetManagerHooks;
  /**
   * The resident-process scheduler (loaders/process-fabric.ts). Every
   * long-lived process — staged opencode, node servers, python/ruby socket
   * servers — is booted through it, and it is the only code that knows which
   * workerd process a facet landed in.
   */
  private processFabric: ProcessFabric;
  /** The residents whose write log may still hold changes (process-journals.ts). */
  readonly processJournals: ProcessJournals;
  /** Per resident whose log is being drained as its facet is released: the drain. */
  private readonly journalDrains = new Map<number, Promise<void>>();
  /** Per resident with a booked log: the binding its drain writes through (NimbusFilesystemAuthority.recovery). */
  private readonly recoveries = new Map<number, NimbusHostFilesystemLease>();
  /** An exit a signal decided, told once its process's log is drained (`_endBySignal`). */
  private readonly endsAfterDrain = new Map<number, () => void>();
  /**
   * The same substrate the fabric runs residents on, held directly because a
   * one-shot has no lifecycle for the fabric to own — it is started, read and
   * gone inside one call.
   */
  private processHost: ProcessHost;
  private readonly network: () => WorkspaceNetwork;
  /** NIMBUS_DEBUG=1: placement diagnostics into the process log store. */
  private debugEnabled = false;
  private processRpcResources = new Map<number, ProcessRpcResources>();
  /**
   * The session's budget for stdin held while a run is stopped (stdin-read.ts,
   * _awaitStoppedInput), held here because the bytes are held in this
   * Durable Object, whichever process waits for them.
   */
  readonly stdinReadAhead = new ReadAheadBudget(STDIN_SYNC_READ_BYTES + 1);
  /** Per one-shot that can stop at a read of stdin: its output across its runs (gateOutput). */
  private readonly outputGates = new Map<number, ReplayOutputGate>();
  /** Per stdin channel of a process that can stop: what its current run took (stdinTakenBy). */
  private readonly stdinTaken = new Map<number, StdinTaken>();
  /** Per process that can stop: its journal, its connections and live fetches, across its runs (runtime/replay-session.ts). */
  readonly replay = new ReplaySessions();
  /**
   * The content-addressed boot-image store (fabric's image-store.ts),
   * writing through this session's kernel-credentialed VFS and rooted off the
   * live process table.
   */
  private readonly imageStore = new ImageStore(
    (pid) => this._imageBlobs(pid),
    (pid) => this.processes.get(pid)?.state === 'running',
  );
  /**
   * The resident-launch journal (fabric's fenced-work.ts): the durable
   * record of every resident this session owes the user, and its recovery
   * after an instance reset. This manager supplies what a launch IS — the
   * recipe `_redrive` re-drives from — and how its loss is reported.
   */
  private readonly launchJournal: FencedWork<ResidentLaunchRecord>;
  /**
   * The granting side of the launch budget (fabric's turn-budget.ts). The
   * session's alarm re-enters the object through `pumpResidentLaunches`;
   * journal recovery rides the first pump.
   */
  private readonly launchPump: PacedWork;
  /**
   * One-shot launches not yet running, by pid: the stage each is at and since
   * when (launchState), and the check that reports one stalled at a stage.
   */
  private readonly launching = new Map<number, { stage: LaunchStage; since: number; command: string; stall: ReturnType<typeof setTimeout> | null }>();
  private readonly launchTasks = new Set<Promise<void>>();
  private launchesClosed = false;
  // attach-pid → serve-pid: the resident serve facet a bare-`opencode` dual
  // spawn created as an OS-child of the attach TUI. When the attach process
  // exits (reported / killed), its serve facet is torn down with it.
  private _pairedServeFacet = new Map<number, number>();
  // The bundle a running pid launched from, so the misses it reports as they
  // happen, and a resident's at its exit, stage into the next launch of the
  // same entry; and the reads it reported refused, which a one-shot that ends
  // without its own exit report (the platform killed it) is failed naming.
  private readonly launchBundles = new Map<number, { key: string; refused: Set<string> }>();
  /** Per resident pid: the shared read profile's entries its launch staged, settled at its exit. */
  private readonly residentProfileOffers = new Map<number, { staged: StagedProfileEntry[]; unresolved: string[] }>();
  /**
   * The service the bundle's module pass transforms with. composeFacetManager
   * sets it: the host's own, or one whose transforms run in the session's
   * transform facet. Never one of this isolate: a transform engine's wasm
   * memory only grows.
   */
  private esbuild: EsbuildService | null = null;
  /** The store `_transformStore` opened over the current VFS and esbuild service; their setters drop it. */
  private transformStore: TransformStore | undefined;

  /**
   * Prefetch-bundle cache. buildPrefetchBundle does a full VFS reachable-set
   * walk + greedy oversample + the module pass on EVERY foreground
   * exec — dominant wall-clock on large node_modules. This memoizes the
   * result (including the serialized facet bundle) keyed on
   * (bundleProfile, cwd, scriptPath, entryCode identity).
   *
   * Correctness watermark: the GLOBAL SqliteVFS revision. buildPrefetchBundle
   * reads from paths that can lie anywhere in the VFS (STATIC_ABSOLUTE_LITERALS
   * pulls absolute-path literals like /tmp/x),
   * so a cwd-scoped subtree revision cannot guarantee invalidation. The
   * global revision bumps on ANY write, so the cache invalidates on every
   * mutation that could change any file the bundle reads — provably
   * conservative. Bounded to a small LRU; the working set per session is a
   * handful of bins (tsc/vite/eslint) plus repeated `node -e` shapes.
   */
  private prefetchBundleCache = new Map<string, {
    revision: number;
    vfsState: FacetVfsState;
    /** Retained supervisor-heap cost of this entry; the LRU's real bound. */
    bytes: number;
  }>();
  private static readonly PREFETCH_CACHE_MAX = 16;
  /** Live sum of the entries' `bytes`, mirrored to the diag gauge on change. */
  private prefetchCacheBytes = 0;
  /**
   * Cache-miss builds in flight, by key and the revision they read, and the
   * launch building it (`leader`): a launch of the same key waits for one,
   * holding nothing, then takes its entry, or (one the cache did not retain)
   * its own copy of the state, built at the revision `done` names (null: it
   * built nothing of its own).
   */
  private readonly prefetchBuilds = new Map<string, { revision: number; leader: number; done: Promise<{ state: FacetVfsState; revision: number } | null> }>();
  /**
   * A launch's share of the supervisor's credit (admitPrefetch), by pid:
   * its build's, held from the build until its module map is generated, or
   * for a state it did not build its map's (_holdMapShare); either taken
   * before it holds a worker. What it built is live until then, and no
   * other build runs beside it beyond what the budget holds. A one-shot keeps
   * only its map's retained share while parked, until the loader takes it;
   * other maps give it back once generated (_generateUnderCeiling). Kept for
   * a rebuild under the ceiling, and given back as its launch ends however it ends.
   */
  private readonly buildAdmissions = new Map<number, PrefetchAdmission>();

  private _releaseBuildAdmission(pid: number): void {
    const admission = this.buildAdmissions.get(pid);
    if (admission === undefined) return;
    this.buildAdmissions.delete(pid);
    admission.release();
  }

  /**
   * What each command's runs learned for its next launch: the modules they
   * tried to execute and the files they read that the launch lacked, and the
   * runtime code they produced (launch-learning-store.ts). Kept in the
   * session's storage: the session is evicted whenever it sits idle between
   * two commands, and a profile that died with it made the next run miss the
   * same file again (Vite's node_modules/ms/index.js on every launch).
   */
  private learning: LaunchLearningStore;
  /** The bins this workspace learned are servers (server-hints.ts). */
  readonly learnedServers: LearnedServers;
  /**
   * Misses shared across sessions per installed package (read-profile.ts),
   * kept in the npm tarball cache bucket (NPM_TARBALL_CACHE) beside the
   * tarballs. Unbound, a miss is learned for this session only
   * (learning).
   */
  private readProfile: ReadProfile | null = null;
  /** Read-profile changes dropped after losing every write race. */
  private readProfileConflicts = 0;
  /** Per credential and module path: its static references at a revision (see _staticRefsOf). */
  private staticRefsMemo = new Map<string, { rev: number | string; refs: StaticFsRefs }>();
  /** Modules whose references are remembered: a few programs' closures. */
  private static readonly STATIC_REFS_MEMO_MAX = 16_384;

  /**
   * What the prefetch cache holds right now, for /api/_diag/memory: each
   * entry's key, the revision it was built at, and its retained bytes, next
   * to the filesystem's live revision and the residency profiles. A launch
   * that rebuilds where a hit was expected is explained by exactly these:
   * the revision moved, the key changed, or a miss profile dropped the entry.
   */
  prefetchCacheDiag(): {
    revision: number | null;
    entries: Array<{ key: string; revision: number; bytes: number }>;
    launchProfiles: Array<{ key: string; executedModules: string[]; dataReads: string[]; codeKeys: string[] }>;
  } {
    return {
      revision: this.vfs ? this.vfs.revision() : null,
      entries: [...this.prefetchBundleCache].map(([key, entry]) => ({
        key, revision: entry.revision, bytes: entry.bytes,
      })),
      launchProfiles: this.learning.cached(),
    };
  }

  /** In-flight request-driven durable-app ensures, single-flight per port. */
  private ensureInflight = new Map<number, Promise<'started' | 'absent' | 'failed'>>();
  /** Per-pid chain of journal-row amendments; see `_amendRow`. */
  private rowAmendments = new Map<number, Promise<void>>();
  /** A process whose host the platform reset (_endByHostLoss), until its terminal hook reads why it ended. */
  private hostLosses = new Map<number, ProcessHostLost>();
  /** Each running resident's uptime proof timer (_proveByUptime). */
  private uptimeProofs = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * pid → the derived owner it duplicates: the second live instance of an
   * identity. Not journalled (nothing re-drives it), so this is the only
   * record of why `expose(pid)` refuses it.
   */
  private ephemeralPids = new Map<number, string>();
  private residentClaims = new Map<number, string>();

  // NOTE: the opencode artifact sources (entry bundle, chunk pack, TUI worker
  // sources, wasm sidecars) are never materialized on the spawn path — this
  // manager only builds the small OpencodeStageSpec (argv/env/VFS snapshot).
  // facets/opencode-staging.ts assembles the module map inside the
  // Worker-Loader cache-miss callback, so the sources exist only while a facet
  // is actually loading.

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    processes: SessionProcessSupervisor,
    portRegistry: PortRegistry,
    host: ProcessHostFactory,
    hooks: FacetManagerHooks = {},
  ) {
    this.ctx = ctx;
    this.learning = new LaunchLearningStore(ctx.storage);
    this.learnedServers = new LearnedServers(ctx.storage);
    this.env = parseFacetManagerEnv(env);
    this.processes = processes;
    this.processes.setWorkObservation(() => hostActivity(ctx).acquire());
    this.portRegistry = portRegistry;
    this.hooks = hooks;
    // The workspace's network (FacetManagerHooks.network); a manager no workspace composed uses the isolate's.
    this.network = hooks.network ?? (() => ISOLATE_NETWORK);
    this.processHost = host(ctx, env, (pid) => this._residentDisk(pid), this.network, hooks.supervise);
    this.processJournals = new ProcessJournals(() => (this.ctx.storage as { sql?: SqlStorage }).sql);
    // Every resident logs its changes in its facet's store: the session
    // books the store when it opens, and drains it when the process is
    // released, before its exit is told (process-fs-journal.ts).
    this.processFabric = new ProcessFabric(this.processHost, {
      journalFor: (pid) => ({
        opened: (facet) => {
          const cred = this.processes.get(pid)?.cred;
          if (cred === undefined) return;
          this.processJournals.opened(facet, pid, cred, generation(this.ctx));
          // What its drain writes through, kept from its release to the drain's end.
          if (this.filesystem !== null && !this.recoveries.has(pid)) this.recoveries.set(pid, this.filesystem.recovery(pid, cred));
        },
        // One drain per log: a second joins it.
        drain: (journal) => {
          const running = this.journalDrains.get(pid);
          if (running !== undefined) return running;
          const drained = this._drainProcessJournal(pid, journal).finally(() => {
            this.journalDrains.delete(pid);
            const end = this.endsAfterDrain.get(pid);
            this.endsAfterDrain.delete(pid);
            end?.();
          });
          this.journalDrains.set(pid, drained);
          return drained;
        },
      }),
    });
    this.debugEnabled = nimbusDebugEnabled(env);
    const profiles = ((typeof env === 'object' || typeof env === 'function') && env !== null)
      ? Reflect.get(env, 'NPM_TARBALL_CACHE')
      : undefined;
    this.readProfile = profiles && typeof profiles === 'object'
      ? new ReadProfile(profiles as ReadProfileBucket, Date.now, () => { this.readProfileConflicts++; })
      : null;
    // A row's delete takes the environment kept beside it in the same
    // storage operation: every way a row goes (release, purge, abandonment,
    // supersession) is a delete through here.
    const journalStorage: FencedWorkStorage = {
      put: (key, value) => ctx.storage.put(key, value),
      delete: (key) => ctx.storage.transaction((txn) => deleteRecord(txn, this.hooks.keepProcessEnv, key)),
      list: <T>(options: { prefix: string }) => ctx.storage.list<T>(options),
      sync: () => ctx.storage.sync(),
    };
    this.launchJournal = new FencedWork<ResidentLaunchRecord>(journalStorage, {
      generationBase: () => this.processes.pidBase,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      redrive: (record, attempt, cause) => this._redrive(record, attempt, cause),
      onRedrive: (record) => {
        // A line in the Worker's logs as well: the platform logs nothing for the restart itself.
        console.warn(`[facet-manager] the session restarted while pid ${record.pid} ("${record.command}") was ${residentLaunchDoing(record)}; restarting it`);
        this.hooks.notify?.(
          '\x1b[2m[nimbus: the session restarted while '
          + `"${record.command}" was ${residentLaunchDoing(record)} — restarting it]\x1b[0m\r\n`,
        );
      },
      onAbandoned: (record, cause) => {
        const notice = residentAbandonedNotice(record, cause);
        console.warn(`[facet-manager] pid ${record.pid} left stopped: ${notice.replace(/\x1b\[[0-9;]*m|\r?\n/g, '')}`);
        this.hooks.notify?.(notice);
      },
      onRedriveFailed: (record, e) => {
        console.warn(`[facet-manager] resident pid ${record.pid} ("${record.command}") not re-driven: ${errorMessage(e)}`);
        this.hooks.notify?.(
          `\x1b[2m[nimbus: "${record.command}" could not be restarted: `
          + `${errorMessage(e)}]\x1b[0m\r\n`,
        );
      },
    });
    this.launchPump = new PacedWork(ctx, {
      requestTurn: hooks.requestLaunchTurn?.bind(hooks),
    });
    // A reset that killed a resident launch left journal rows behind; the
    // first pump after the reset drains this reconciliation before any
    // waiter resumes, OFF the constructor's init gate. Before it: the write
    // logs a previous incarnation's residents left undrained (their names
    // reserved from minting until then). One that cannot be read is said in
    // the worker's log and on the terminal, and kept.
    // First: what an earlier release kept of its processes' environments goes,
    // before any of it is re-driven or read (ask 62).
    onColdStart(ctx, () => this._dropEnvironmentsAtRest());
    onColdStart(ctx, () => this.processJournals.drainPending({
      reserved: reservedFacetNames(this.ctx),
      generation: generation(this.ctx),
      drain: async (row) => {
        await this._drainJournalAs(row.pid, row.cred, facetJournal(this.ctx, this.env, row.facet));
        this.vfs?.forgetSequences(row.pid);
        deleteFacetStorage(this.ctx, row.facet);
      },
      log: (message) => {
        console.error(message);
        this.hooks.notify?.(`\x1b[31m${message}\x1b[0m\r\n`);
      },
    }));
    onColdStart(ctx, () => this.launchJournal.recoverInterrupted());
    // The journal row of a resident lives for the PROCESS's lifetime, so its

    // release belongs on the one seam every end-of-life passes through —
    // exit, kill, self-reported exit and timeout abort all mark the table.
    // Rooted on waitUntil: the hook fires synchronously inside whatever turn
    // ended the process, and the delete must not be a floating promise there.
    this.processes.setOnTerminal((pid) => {
      this.launchBundles.delete(pid);
      // However it ended, nothing of its replay is waited on any more.
      this.replay.close(pid);
      this.residentProfileOffers.delete(pid);
      // Its writers' cursors go with it, unless its log is still to be
      // drained (which numbers against them, and forgets them after).
      if (this.processJournals.of(pid) === undefined) this.vfs?.forgetSequences(pid);
      this.ctx.waitUntil(this.trackLaunchTask(this._onResidentTerminal(pid)));
    });
    this.processes.setDefaultSignalAction((pid, code, signal) => this._endBySignal(pid, code, signal));
  }

  /**
   * What releases before ask 62 kept of their processes' environments, once
   * per session, before anything of it is re-driven or read. Each record
   * moves its environment to where this host keeps environments
   * (keepProcessEnv) in the same storage write that strips it:
   * - a Node resident's journal row, and a dev server's record, held it;
   * - every application blob that held an interpreter's environment, or a
   *   binding env, where every process could read it (named by an index, a
   *   row, or nothing): written again without it, its rows and owner
   *   indexes naming the new blob, the old one unlinked. An application
   *   whose binding env nothing can give back (no embedder
   *   resolveWorkerLaunch) is not restarted, and the session is told. A
   *   blob a reset cut short, which no reader can use, is unlinked too;
   * - a Node resident's generated entry an earlier release left in an image
   *   directory: not removed, as the directory is the embedder's; the
   *   session is told how many look generated (legacy-images.ts).
   * A filesystem snapshot or export taken before keeps what it held.
   */
  private async _dropEnvironmentsAtRest(): Promise<void> {
    if (await this.ctx.storage.get(PROCESS_ENV_DROPPED_KEY) === true) return;
    const keeping = this.hooks.keepProcessEnv;
    const rows = await this.ctx.storage.list<ResidentLaunchRecord>({ prefix: FENCED_WORK_KEY_PREFIX });
    for (const [key, row] of rows) {
      if (row.recipe.kind !== 'node' || row.recipe.opts.env === undefined) continue;
      const { env, ...opts } = row.recipe.opts;
      const rewritten: ResidentLaunchRecord = { ...row, recipe: { ...row.recipe, opts } };
      rows.set(key, rewritten);
      await this.ctx.storage.transaction((txn) => putRecord(txn, keeping, key, rewritten, env));
    }
    for (const [key, row] of await this.ctx.storage.list({ prefix: DEV_SERVER_KEY_PREFIX })) {
      const held = RecordHoldingEnvSchema.safeParse(row);
      if (!held.success) continue;
      const { env, ...record } = held.data;
      await this.ctx.storage.transaction((txn) => putRecord(txn, keeping, key, record, env));
    }
    const vfs = this.vfs;
    if (vfs !== null) {
      const { holdingEnv, corrupt } = await readStoredImages(vfs);
      const rewritten = new Map<string, string>();
      for (const held of holdingEnv) {
        const naming = [...rows].flatMap(([key, row]) => (row.recipe.kind === 'worker' && row.recipe.image.application === held.digest ? [{ key, row, recipe: row.recipe }] : []));
        const application = await rewriteWithoutEnvironment(vfs, held.digest);
        rewritten.set(held.digest, application);
        for (const { key, row, recipe } of naming) {
          // What nothing can give back: a binding env with no embedder
          // resolveWorkerLaunch; an interpreter's whole environment with no
          // keeping here, where an embedder's resolveProcessEnv answers the
          // base its runtime built on, which this image never recorded.
          const unrecoverable = recipe.resident === undefined
            ? held.bindingEnv && this.hooks.resolveWorkerLaunch === undefined
            : held.processEnv !== null && keeping === undefined;
          if (unrecoverable) {
            await this.ctx.storage.transaction((txn) => deleteRecord(txn, keeping, key));
            rows.delete(key);
            this.hooks.notify?.(`\x1b[33m[nimbus: "${row.command}" is not restarted: its image held its environment, which Nimbus no longer keeps; start it again]\x1b[0m\r\n`);
            continue;
          }
          const moved: ResidentLaunchRecord = { ...row, recipe: { ...recipe, image: { runner: recipe.image.runner, application } } };
          rows.set(key, moved);
          await this.ctx.storage.transaction((txn) => putRecord(txn, keeping, key, moved, recipe.resident === undefined ? undefined : held.processEnv ?? undefined));
        }
      }
      for (const [ownerKey, images] of await this.ctx.storage.list<Array<{ runner: string; application: string }>>({ prefix: DURABLE_IMAGES_KEY_PREFIX })) {
        if (!images.some((image) => rewritten.has(image.application))) continue;
        await this.ctx.storage.put(ownerKey, images.map((image) => ({ runner: image.runner, application: rewritten.get(image.application) ?? image.application })));
      }
      unlinkDurableImages(vfs, [...rewritten.keys(), ...corrupt]);
      const left = legacyGeneratedImages(vfs).length;
      if (left > 0) {
        this.hooks.notify?.(`\x1b[33m[nimbus: earlier releases left ${left} generated program image(s) with their environment in them in /.nimbus/facet-images or /var/lib/nimbus/facet-images; GET /api/_diag/session lists them (legacyGeneratedImages)]\x1b[0m\r\n`);
      }
    }
    await this.ctx.storage.put(PROCESS_ENV_DROPPED_KEY, true);
    await this.ctx.storage.sync();
  }

  /**
   * A signal's default action: the process ends with 128+signo whether its
   * facet is still being built (the launch stops at its next ownership gate)
   * or already booted (its resources are released like a kill).
   */
  private _endBySignal(pid: number, code: number, signal: string): void {
    this._end(pid, { code, cause: signal });
  }

  /**
   * The process is over: its ports, writers and RPC resources go, and its
   * end is recorded, once. Every way a process ends comes here: its own exit
   * (reportExit, a run's answer), a signal, a kill, a lost host, a launch or
   * boot that failed.
   */
  private _end(pid: number, ending: ProcessEnding): void {
    if (this.processes.get(pid)?.state !== 'running') return;
    // An end waiting for the drain is already this process's, unless a kill
    // comes: that takes effect at once, in its place.
    if (this.endsAfterDrain.has(pid)) {
      if (!ending.killed) return;
      this.endsAfterDrain.delete(pid);
    }
    this.portRegistry.unregisterByPid(pid, ending.portEnding);
    // A lifetime run reports its own exit before its call ends: its
    // resources and writers go as that call does (_watchLifetime).
    if (ending.cause !== undefined || this.processRpcResources.get(pid)?.releaseOnReportExit !== false) {
      this.releaseProcessRpcResources(pid);
      this.revokeProcessVfsWriters(pid);
    }
    const record = () => {
      if (this.processes.get(pid)?.state !== 'running') return;
      if (ending.killed) this.processes.kill(pid, ending.code, ending.reason);
      else this.processes.exit(pid, ending.code);
      if (ending.cause !== undefined) {
        this.processes.markExit(pid, ending.code, ending.cause);
        this.processes.closeInput(pid);
        this._w5RecordTermination(pid, ending.code, 'facet', ending.cause);
        try { this.hooks.onExternalExit?.(pid, ending.code, ending.cause); } catch {}
      }
      this._teardownPairedServeFacet(pid);
    };
    // A resident's release drains its write log: an end from outside it is
    // told after, so what reads its files next (the next prompt, its parent)
    // sees them. A kill is recorded at once.
    if (ending.cause !== undefined && !ending.killed && this.journalDrains.has(pid)) this.endsAfterDrain.set(pid, record);
    else record();
  }

  /**
   * A lifetime run (its start call held open for its life): when that call
   * ends, so do its resources; one that fails while the process still runs
   * ends it, as `what` failing. One already over (its own exit, a kill)
   * rejects the call as an echo of that end, which records nothing again.
   */
  private _watchLifetime(pid: number, handle: { done: Promise<unknown> }, what: string): void {
    this.ctx.waitUntil(
      handle.done
        .catch((e: unknown) => this._end(pid, { code: 1, cause: `${what} failed: ${errorMessage(e)}` }))
        .finally(() => this.releaseProcessRpcResources(pid)),
    );
  }

  /**
   * The platform reset the host of a running process (ProcessHostLost): the
   * process is over, as if killed (137), and says why, on its stderr. Its
   * ports answer with the cause at once, and its restart policy decides what
   * follows, as for any process that ends on its own (_onResidentTerminal).
   */
  private _endByHostLoss(pid: number, lost: ProcessHostLost): void {
    const entry = this.processes.get(pid);
    if (entry?.state !== 'running') return;
    console.warn(`[facet-manager] pid ${pid} ("${entry.command}") ended: ${lost.message}`);
    this.processes.appendOutput(pid, 'stderr', `[nimbus] process ${pid} ended: ${lost.message}\n`);
    this.hostLosses.set(pid, lost);
    this._end(pid, { code: HOST_LOST_EXIT_CODE, cause: lost.message, portEnding: `"${entry.command}" (pid ${pid}) ended: ${lost.message}` });
  }

  /**
   * The process is over. Every end-of-life passes through here: a clean
   * exit, a kill, a timeout, a crash. Only one of them owes anything more
   * than the journal row's release — a crash under 'on-failure' is re-driven
   * from the row, after a backoff, while the row is still in storage so a
   * reset inside the backoff window recovers it like any other resident.
   */
  /**
   * The evidence a resident ran (fenced-work.ts RESIDENT_PROVEN_MS): this
   * instance's timer, from the boot. If the process is still running with
   * its row when it fires, the row's re-drive budget is whole again. A timer
   * of an instance that died never fires, so time while the session was
   * down never counts. Resolves when the row is amended, or at once when
   * there is nothing to prove.
   */
  private _proveByUptime(pid: number): void {
    this._dropUptimeProof(pid);
    this.uptimeProofs.set(pid, setTimeout(() => {
      this.uptimeProofs.delete(pid);
      if (this.processes.get(pid)?.state !== 'running' || !this.launchJournal.has(pid)) return Promise.resolve(undefined);
      return this._amendRow(pid, (row) => (row.attempt === 0 ? row : { ...row, attempt: 0 }));
    }, RESIDENT_PROVEN_MS));
  }

  /** Stop `pid`'s uptime proof: the process ended, or its proof restarts. */
  private _dropUptimeProof(pid: number): void {
    const proof = this.uptimeProofs.get(pid);
    if (proof === undefined) return;
    clearTimeout(proof);
    this.uptimeProofs.delete(pid);
  }

  private async _onResidentTerminal(pid: number): Promise<void> {
    this._dropUptimeProof(pid);
    const hostLost = this.hostLosses.get(pid);
    this.hostLosses.delete(pid);
    await this.rowAmendments.get(pid);
    this.ephemeralPids.delete(pid);
    await this._releaseResidentClaim(pid);
    if (!this.launchJournal.has(pid)) return;
    const entry = this.processes.get(pid);
    const key = `${FENCED_WORK_KEY_PREFIX}${pid}`;
    const row = (await this.launchJournal.rows()).get(key);
    const crashed = entry?.state === 'exited' && (entry.exitCode ?? 0) !== 0;
    if (this.launchesClosed || row === undefined || row.restart !== 'on-failure' || !crashed) {
      await this.launchJournal.release(pid);
      return;
    }
    const delayMs = RESTART_BACKOFF_BASE_MS * 2 ** row.attempt;
    const ended = hostLost === undefined
      ? `"${row.command}" exited with code ${entry.exitCode}`
      : `the platform reset the host of "${row.command}"`;
    this.hooks.notify?.(
      `\x1b[2m[nimbus: ${ended} — restarting in ${delayMs / 1000}s (FencedWork attempt ${row.attempt + 1})]\x1b[0m\r\n`,
    );
    await this.launchPump.nextTurn(Promise.resolve(), Date.now() + delayMs);
    // The process may have been removed or the session destroyed during the
    // backoff; a row that is gone is owed nothing.
    if (!(await this.launchJournal.rows()).has(key)) return;
    await this.launchJournal.drive(key, row, hostLost === undefined
      ? { kind: 'exited', code: entry.exitCode ?? 1 }
      : { kind: 'host-reset' });
  }

  /**
   * Claim identity AND write its recovery row in one serializable storage
   * transaction, with the environment its relaunch asks for (`env`, when it
   * asks) kept beside the row where this host keeps environments. A claim
   * again of a row already written leaves what is kept beside it.
   */
  private async _claimResident(record: ResidentLaunchRecord, env?: Record<string, string>): Promise<number | null> {
    const owner = residentOwner(record);
    if (owner === undefined) throw new Error('resident launch has no owner');
    const duplicate = await this.ctx.storage.transaction(async (txn) => {
      const key = `${RESIDENT_OWNER_KEY_PREFIX}${owner}`;
      const held = await txn.get<number>(key);
      if (held !== undefined && held !== record.pid && held > this.processes.pidBase
        && this.processes.get(held)?.state === 'running') return held;
      await txn.put(key, record.pid);
      await putRecord(txn, this.hooks.keepProcessEnv, `${FENCED_WORK_KEY_PREFIX}${record.pid}`, record, env);
      return null;
    });
    if (duplicate === null) {
      this.residentClaims.set(record.pid, owner);
      // Adopt into FencedWork's per-instance lifetime bookkeeping and cross
      // its sync barrier before booting. The winning row already exists.
      await this.launchJournal.journal(record);
    }
    return duplicate;
  }

  private async _releaseResidentClaim(pid: number): Promise<void> {
    const owner = this.residentClaims.get(pid);
    if (owner === undefined) return;
    this.residentClaims.delete(pid);
    await this.ctx.storage.transaction(async (txn) => {
      const key = `${RESIDENT_OWNER_KEY_PREFIX}${owner}`;
      if (await txn.get(key) === pid) await txn.delete(key);
    });
    await this.ctx.storage.sync();
  }

  /**
   * Amend one journal row in place — port stamp, owner adoption, settle —
   * serialized per pid so two amendments in flight on the same row cannot
   * interleave their read and write and lose one another's fields.
   */
  private _amendRow(
    pid: number,
    amend: (row: ResidentLaunchRecord) => ResidentLaunchRecord,
  ): Promise<ResidentLaunchRecord | undefined> {
    const key = `${FENCED_WORK_KEY_PREFIX}${pid}`;
    const previous = this.rowAmendments.get(pid) ?? Promise.resolve(undefined);
    const next = previous.then(async () => {
      const row = (await this.launchJournal.rows()).get(key);
      if (row === undefined) return undefined;
      const amended = amend(row);
      if (amended !== row) await this.launchJournal.journal(amended);
      return amended;
    });
    const settled = next.then(() => undefined, () => undefined);
    this.rowAmendments.set(pid, settled);
    void settled.then(() => {
      if (this.rowAmendments.get(pid) === settled) this.rowAmendments.delete(pid);
    });
    return next;
  }

  /** The authority is the caller's: a session composes exactly one, and the
   *  manager credentials its processes through that one rather than a second
   *  authority over the same disk. */
  setVfs(vfs: SqliteVFS, filesystem: NimbusFilesystemAuthority) { this.vfs = vfs; this.filesystem = filesystem; this.transformStore = undefined; }

  /**
   * Send what a released resident's write log still holds (it was killed,
   * ran out of memory or CPU, or ended before its log was answered), as the
   * process would have: under the numbers it gave each change, so the
   * session's cursor answers what already landed and applies the rest once.
   * A change the session refuses is said in the process's own output, named.
   */
  private async _drainProcessJournal(pid: number, journal: ProcessFsJournalSource): Promise<void> {
    const recovery = this.recoveries.get(pid);
    this.recoveries.delete(pid);
    try {
      const pending = this.processJournals.of(pid);
      if (pending === undefined) return;
      await this._drainJournalAs(pending.pid, pending.cred, journal, recovery);
      this.vfs?.forgetSequences(pid);
      this.processJournals.settled(pid);
    } finally {
      await recovery?.dispose();
    }
  }

  /**
   * Drain `journal` into the session as process `pid` (with its credential)
   * would have sent it: through `recovery`, the process's own binding, kept
   * since its log was booked (its descriptions, and the grants that reserved
   * the inodes it numbered); else, for a log an earlier incarnation left, a
   * lease of its credential.
   */
  private async _drainJournalAs(pid: number, cred: VfsCred, journal: ProcessFsJournalSource, recovery?: NimbusHostFilesystemLease): Promise<void> {
    if (!this.filesystem) throw new Error('Process filesystem authority is not initialized');
    // Under the process's credential, numbered as its own waves were.
    const lease = recovery === undefined ? this.filesystem.openHost(cred) : null;
    const drained = await drainProcessFsJournal({ journal, session: journalDrainSession((recovery ?? lease!).fs, pid) }).finally(() => lease?.dispose());
    if (drained.landed > 0 || drained.failures.length > 0) {
      const refused = drained.failures.map((failure) => `  ${failure.op} /${failure.path}: ${failure.errno}: ${failure.message}\n`).join('');
      this.processes.appendOutput(pid, 'stderr',
        `[nimbus] process ${pid} ended with ${drained.landed + drained.failures.length} change${drained.landed + drained.failures.length === 1 ? '' : 's'} not yet in the session: `
          + `${drained.landed} landed after it ended`
          + (drained.failures.length === 0 ? '\n' : `, ${drained.failures.length} refused:\n${refused}`));
    }
  }

  /**
   * What every loader-backed runtime builds its facet pools from: the env and
   * ctx a pool is constructed over, and the workspace's network its facets go
   * out through. One narrow accessor rather than every runtime reaching into
   * the manager's private fields.
   */
  loaderHost(): { env: unknown; ctx: DurableObjectState; network: WorkspaceNetwork } {
    return { env: this.env, ctx: this.ctx, network: this.network() };
  }

  /**
   * The image store's disk for process `pid`'s images: this session's VFS,
   * as the kernel writing on its behalf (_kernelStoreFor) — the store is written
   * by the kernel and read by processes through supervisor bindings that
   * enforce their own credential. Mode 0644 at creation (0666 under the
   * kernel's umask), as POSIX has it, is what makes the read succeed for any
   * process by construction; the store itself decides nothing about modes.
   */
  private _imageBlobs(pid: number): ImageBlobStore {
    if (!this.filesystem) {
      throw new Error(
        'Nimbus: a resident process needs a session filesystem to materialize its boot image',
      );
    }
    const fs = this._kernelStoreFor(pid);
    const at = (path: string) => `/${stripLeadingSlashes(path)}`;
    return {
      mkdirp: (dir) => fs.mkdir(at(dir), { recursive: true, mode: 0o755 }),
      sizeOf: (path) => fs.stat(at(path), { followSymlinks: false })?.size ?? null,
      writeFile: (path, bytes) => { fs.writeFile(at(path), bytes); },
      writeRange: (path, offset, bytes) => { fs.writeRange(at(path), offset, bytes); },
      list: (dir) => fs.readdir(at(dir)).map((entry) => entry.name),
      unlink: (path) => fs.unlink(at(path)),
    };
  }

  /**
   * The session's filesystem as the kernel, writing what process `pid`
   * boots from (its images, the session's copies it loads) on its behalf,
   * through its binding: a write a read lease's recall holds back
   * (SqliteVFS.readRecallAt) is its to read before it is published.
   */
  private _kernelFor(pid: number): RuntimeSynchronousFs {
    return this.filesystem!.bind({ pid, cred: CRED_KERNEL }).synchronous!;
  }

  /**
   * _kernelFor, for the kernel's own stores (KERNEL_STORE_ROOT). That root is
   * checked, not assumed, each time: made if absent, and refused unless it is
   * the kernel's own real directory that no one else may write (only root,
   * through sudo, could have made it anything else). The stores releases
   * through worker 0.19.0 kept below `/var/lib/nimbus` are left: a durable
   * worker one made may still boot from a path there, and a root-owned
   * directory at that name, below the user's `/var`, is no proof the kernel
   * made it.
   */
  private _kernelStoreFor(pid: number): RuntimeSynchronousFs {
    const fs = this._kernelFor(pid);
    ensureKernelStoreRoot({
      stat: (path) => fs.stat(path, { followSymlinks: false }),
      mkdir: (path, mode) => fs.mkdir(path, { mode }),
    });
    return fs;
  }

  /** Give the bundle's module pass the host's esbuild, as composeFacetManager does. */
  setEsbuildService(esbuild: EsbuildService) { this.esbuild = esbuild; this.transformStore = undefined; }

  /**
   * The entry script as the facet compiles it: each dynamic `import()` routed
   * to the process's ESM loader, with the entry's own URL as the parent (Node
   * names `-e` code `<cwd>/[eval]` and stdin `<cwd>/[stdin]`). The parse runs
   * in the transform facet like every cell's, and its result is kept by content
   * in the session's transform store. The module-map walk reads the script as
   * written, before this.
   */
  private async _entryDynamicImports(code: string, filename: string | undefined, cwd: string, pacer: TurnBudget): Promise<string> {
    if (!mayHaveDynamicImport(code)) return code;
    if (this.esbuild === null) throw new Error('entry dynamic import requires the transform service');
    return transformEntryScript(code, entryImporterUrl(filename, cwd), { host: this.esbuild, store: this._transformStore(), pacer });
  }

  /**
   * The store this session's launches keep their transform results in: the
   * session's database, admitted through its storage ledger, bound to the
   * esbuild service's transform host. None when the host has no identity (a
   * result could not be told apart from another host's) or there is no
   * filesystem to admit against. One store serves every launch and module
   * until either changes: it opens its schema once, not per transform.
   */
  private _transformStore(): TransformStore | undefined {
    const hostId = this.esbuild?.transformHostId;
    const sql = this.ctx.storage.sql;
    if (!hostId || !sql || !this.vfs) return undefined;
    return this.transformStore ??= new TransformStore(sql, this.ctx.storage, this.vfs.ledger, hostId);
  }

  /**
   * The pacer every launch is built under: the session's alarm-driven turn
   * pump, the deployment's chunk bound, and the one check a suspended launch
   * makes when it resumes — that the process it is building for still exists.
   */
  private _launchPacer(pid: number): TurnBudget {
    return new TurnBudget(
      this.launchPump,
      turnChunkMaxBytes(this.env),
      () => this._assertLaunchStillOwned(pid),
    );
  }

  /**
   * Assemble the filesystem bundle a process boots on, across as many
   * Durable Object turns as it takes.
   *
   * The one builder for every Node process this manager starts. A one-shot
   * exec and a resident launch used to own two copies of this: exec's was
   * memoized behind the prefetch cache and raced a wall-clock deadline in a
   * single turn; the resident's was paged with a TurnBudget and never cached.
   * Two paths, one job — and a tree large enough to page on one path hit the
   * deadline on the other, failing every `node -e` in it with "assembling the
   * filesystem bundle … exceeded". What the two callers genuinely differ in is
   * the entry, the working directory and the process they build for; that is
   * all they supply. Everything else — the revision-keyed cache and its stale
   * eviction, the residency profile a previous miss learned, the reachable-set
   * walk and its enrichment passes, the module pass, the manifest and
   * metadata, the module-map serialization with its side-module split, the
   * `node:sqlite` answer, and the release of the raw cells once they are
   * serialized — happens here, once, and yields the turn whenever a chunk's
   * worth of it has been done.
   *
   * There is no deadline. A launch that spans turns costs turns, not a held
   * thread, so a large tree is not a defect to be reported at N seconds; the
   * pacer's `stillWanted` check is what ends a build nothing will use — a
   * process killed while its build was suspended throws from the next resume,
   * and the caller reports that as it reports any other launch failure.
   *
   * The returned state carries its serialized forms (`bundleSource`,
   * `serializedManifest`, `serializedMetadata`) and has already released the
   * raw ones: `generateEntrypointCode` and `generateLongRunningNodeCode` read
   * the serialized forms and nothing else. A state the cache retained belongs
   * to the cache — a caller must not release its serialized forms either
   * (`cacheRetained` says which); one the cache refused belongs to the caller
   * alone, and `releaseGeneratedSources` drops it once a map is generated.
   *
   * A session without a filesystem gets an empty state: there is nothing to
   * stage and nothing to yield for.
   */
  /**
   * The closure's wasm images as module-map members for a one-shot facet,
   * read by path under the process's own credential. An image that cannot
   * be read is left out; the program's compile then meets the seam's own
   * refusal, which names the module.
   */
  private async _wasmModulesByValue(
    entry: ProcessEntry,
    wasmImports: readonly FacetWasmImport[],
  ): Promise<Record<string, { wasm: ArrayBuffer }>> {
    const modules: Record<string, { wasm: ArrayBuffer }> = {};
    if (!this.vfs || wasmImports.length === 0) return modules;
    if (!this.filesystem) throw new Error('Process filesystem authority is not initialized');
    const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
    for (const image of wasmImports) {
      // One another launch staged moments ago is read once it is published (a read lease's recall held it).
      const bytes = await withRecall(() => filesOf(vfs).readBytes(stripLeadingSlashes(image.vfsPath))).catch(() => null);
      if (bytes === null) continue;
      modules[image.moduleName] = { wasm: memberBuffer(bytes) };
    }
    return modules;
  }

  /**
   * The module-map members of the staged napi binding builds `names` (each
   * `<name>@<version>`), by value, for a one-shot facet (it has no disk
   * reader at load): the shared loader and trampoline, and each build.
   * Fetched from the worker's own assets — L2-cached, digest-verified —
   * inside the scope that holds the map, and dropped with it.
   */
  private async _stagedBindingModulesByValue(names: readonly string[]): Promise<Record<string, string | { wasm: ArrayBuffer }>> {
    if (names.length === 0) return {};
    const [loader, trampoline, ...bindings] = await Promise.all([
      fetchStagedBindingAsset(this.env, NAPI_WASM_LOADER),
      fetchStagedBindingAsset(this.env, NAPI_WASM_TRAMPOLINE),
      ...names.map((name) => fetchStagedBindingAsset(this.env, stagedBinding(name).wasm)),
    ]);
    const modules: Record<string, string | { wasm: ArrayBuffer }> = {
      [STAGED_BINDING_LOADER_MODULE]: new TextDecoder().decode(loader),
      [STAGED_BINDING_TRAMPOLINE_MODULE]: { wasm: trampoline },
    };
    names.forEach((name, i) => { modules[stagedBinding(name).moduleName] = { wasm: bindings[i] }; });
    return modules;
  }

  /**
   * Stage wasm images that come from no file — those the closure inlines as
   * base64 (findInlineWasmImages), and those earlier runs compiled from bytes
   * in memory (learnedWasmImages) — each as a kernel-owned file named by its
   * content key, and return the records the launch registers it under: by
   * that path, which both launch forms read it from, and by digest, which is
   * how the program's own compile of the decoded bytes is recognised. Small
   * (es-module-lexer's parser is 11.8 KB; a learned one is at most
   * RUNTIME_WASM_MAX_BYTES) and written once per session per image.
   */
  private _stageWasmImageBytes(images: readonly Uint8Array[], pid: number): WasmImageRecord[] {
    if (images.length === 0 || !this.filesystem) return [];
    const fs = this._kernelStoreFor(pid);
    fs.mkdir(INLINE_WASM_DIR, { recursive: true, mode: 0o755 });
    return images.map((bytes) => {
      const digest = wasmImageDigest(bytes);
      const vfsPath = `${INLINE_WASM_DIR}/${digest.replace(':', '-')}.wasm`;
      if (fs.stat(vfsPath, { followSymlinks: false })?.size !== bytes.byteLength) fs.writeFile(vfsPath, bytes);
      return { vfsPath, digest };
    });
  }

  /** In-flight writes of the session's copies of staged bindings, by name; one writer each. */
  private stagedBindingWrites = new Map<string, Promise<void>>();

  /**
   * The staged napi binding builds `names` (each `<name>@<version>`) for a
   * resident facet: the shared loader's text (the caller stores it through the image store with the rest
   * of the map), the trampoline by value, and each binding by PATH. A
   * multi-megabyte member inline in the boot spec would sit in this isolate's
   * heap for the process's life; named by path it is read only while the
   * facet loads, like a runtime's interpreter image.
   *
   * Each path is a kernel-owned copy in the session's VFS, written once per
   * session and version. Completeness is its size — the write only ever grows
   * the file from offset zero — and it goes down in the image store's slice
   * size with a turn between slices, for the same reason boot images do: the
   * platform resets an object over what one turn has outstanding.
   */
  private async _residentStagedBindingMembers(
    names: readonly string[],
    pid: number,
    pacer: TurnBudget,
  ): Promise<ResidentStagedBindings | null> {
    if (names.length === 0) return null;
    if (!this.filesystem) throw new Error('Nimbus: a resident process needs a session filesystem to boot');
    const fs = this._kernelStoreFor(pid);
    const bindingPaths: Record<string, string> = {};
    for (const name of names) {
      const binding = stagedBinding(name);
      const path = binding.vfsPath;
      const complete = () => fs.stat(path, { followSymlinks: false })?.size === binding.wasm.bytes;
      if (!complete()) {
        let write = this.stagedBindingWrites.get(name);
        if (!write) {
          write = (async () => {
            try {
              const bytes = new Uint8Array(await fetchStagedBindingAsset(this.env, binding.wasm));
              fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
              let offset = 0;
              do {
                const slice = bytes.subarray(offset, offset + FACET_IMAGE_WRITE_SLICE_BYTES);
                // The first slice replaces the file, truncating an interrupted
                // write's remains to a known length.
                if (offset === 0) fs.writeFile(path, slice);
                else fs.writeRange(path, offset, slice);
                offset += slice.byteLength;
                await pacer.spend(slice.byteLength);
              } while (offset < bytes.byteLength);
            } finally {
              this.stagedBindingWrites.delete(name);
            }
          })();
          this.stagedBindingWrites.set(name, write);
        }
        await write;
        if (!complete()) throw new Error(`Nimbus: writing the staged ${name} binding to ${path} did not complete`);
      }
      bindingPaths[binding.moduleName] = path;
    }
    const [trampoline, loader] = await Promise.all([
      fetchStagedBindingAsset(this.env, NAPI_WASM_TRAMPOLINE),
      fetchStagedBindingAsset(this.env, NAPI_WASM_LOADER),
    ]);
    return { loader: new TextDecoder().decode(loader), trampoline, bindingPaths };
  }

  /**
   * Which contents a resident process holds from its first instruction,
   * beyond its module map: data-plan.ts over this process's view of the
   * namespace, mounts included where its launch names them. A path the plan
   * leaves out is still named and stat-able; a synchronous read of it is the
   * one honest miss.
   */
  private async _planResidentData(
    entry: ProcessEntry,
    vfsState: FacetVfsState,
    cwd: string,
    home: string | undefined,
    pacer: TurnBudget,
    /** The program's path, which its listing walks mounts for (nameLaunch). */
    program?: string,
    /** The program's own conditions, which its code's resolutions use. */
    conditions: readonly string[] = [],
  ): Promise<{ paths: string[]; storageBytes: number; lazyReads: Record<string, string[]>; sourceRoots: string[] }> {
    const filesystem = this.filesystem;
    if (!this.vfs || !filesystem) return { paths: [], storageBytes: 0, lazyReads: {}, sourceRoots: [] };
    const vfs = filesystem.bind({ pid: entry.pid, cred: entry.cred });
    const started = Date.now();
    const trace = (what: string) => {
      if (!this.debugEnabled) return;
      this.processes.appendOutput(entry.pid, 'stderr', `[nimbus-debug] data plan: ${what} at ${Date.now() - started} ms\n`);
    };
    trace('static references');
    // A lazy module's synchronous reads (FacetVfsState.lazyModules) are no
    // boot data: they move to the table the import() that evaluates it
    // fetches from (lazyReadsByTarget).
    const lazy = new Set(vfsState.lazyModules ?? []);
    const syncReadsOf = new Map<string, string[]>();
    const refs: StaticFsRefs[] = [];
    await this._closureStaticRefs(vfs, entry.cred, vfsState.bundlePaths ?? [], pacer, (path, moduleRefs) => {
      const reads = lazy.has(path) ? moduleRefs.exact.filter((ref) => ref.sync).map((ref) => stripLeadingSlashes(ref.path)) : [];
      if (reads.length === 0) { refs.push(moduleRefs); return; }
      syncReadsOf.set(path, reads);
      refs.push({ ...moduleRefs, exact: moduleRefs.exact.filter((ref) => !ref.sync) });
    });
    const lazyReads = lazyReadsByTarget(syncReadsOf, vfsState.lazyImporters ?? {});
    // An evicted module's reads, under its own path: the import() whose
    // closure walk reaches it fetches them (node-shims.ts __nimbusStageImport).
    await this._closureStaticRefs(vfs, entry.cred, vfsState.evictedReaders ?? [], pacer, (path, moduleRefs) => {
      const reads = moduleRefs.exact.filter((ref) => ref.sync).map((ref) => stripLeadingSlashes(ref.path));
      if (reads.length > 0) lazyReads[path] = [...new Set([...(lazyReads[path] ?? []), ...reads])];
    });
    trace(`${refs.length} modules name paths (${syncReadsOf.size} lazy ones' synchronous reads deferred to their import()); learned reads`);
    // Where this process's listing walks mounts, the plan's below and its own
    // at boot: what its launch names.
    filesystem.nameLaunch?.(entry, () => launchNames(cwd, program, entry.argv, vfsState.bundlePaths ?? [], refs));
    const learned = await this._learnedReads(vfsState, entry.cred);
    trace(`${learned.length} learned; listing`);
    let pages = 0;
    const plan = await planFacetData({
      // A page that meets another holder's delegation waits for its recall (a listing recalls as an lstat would).
      list: async (after) => {
        const page = await withRecall(() => vfs.list(after, FS_LIST_PAGE_LIMIT));
        trace(`page ${++pages}: ${page.entries.length} entries`);
        return { entries: page.entries, next: page.next };
      },
      ...planSourceOf(vfs),
    }, {
      cwd,
      home: home || '/home/user',
      closure: vfsState.bundlePaths ?? [],
      codeOnly: vfsState.codeOnly,
      refs,
      learned,
      conditions,
      spend: (units) => pacer.spend(units),
      nameSources: (read) => filesystem.nameLaunch?.(entry, () => read),
    });
    trace(`planned ${plan.paths.length}`);
    // What the facet's store will hold (N18), in the cost its store charges
    // itself (vfs/resident residentCellCost): the planned bytes on
    // overflow pages (1% over), a head and chunk rows per file, a namespace
    // row per name, and slack for the last write's page.
    const rows = plan.paths.length * 2 + Math.ceil(plan.bytes / RESIDENT_CHUNK_BYTES) + plan.names;
    // And the module map, which the store adopts at boot: the process's code,
    // costed when the map was built (its cells are released once serialized).
    const moduleBytes = vfsState.moduleStorageBytes ?? moduleMapStorageBytes(vfsState.bundle, vfsState.codeOnly);
    const storageBytes = Math.ceil(plan.bytes * 1.01) + rows * LEDGER_ROW_BYTES + moduleBytes + 65_536;
    this._noteSourcesStopped(entry, plan.sourcesStopped);
    return { paths: plan.paths, storageBytes, lazyReads, sourceRoots: plan.sourceRoots };
  }

  /**
   * A one-shot's data plan: what its closure reads synchronously by a path its
   * code spells out (static-fs-refs.ts; readFileSync, or a read-only openSync),
   * any size, through any links on it, that the module map does not hold. It
   * is data-plan.ts's `static` rule for synchronous reads, which needs the
   * closure and a stat per path but no listing. The store fetches it at boot,
   * so it is held beside the module map rather than carried in it: `vite
   * build` reads lightningcss's 15.8 MB image with readFileSync(new
   * URL('lightningcss_node.wasm', import.meta.url)), which as a map cell
   * left the closure no room under the map's bound.
   */
  /** Says on the process's stderr where its stylesheet sources' walk stopped at its bound (planStylesheetSources), if it did. */
  private _noteSourcesStopped(entry: ProcessEntry, stopped: string | null): void {
    if (stopped === null) return;
    this.processes.appendOutput(entry.pid, 'stderr',
      `[nimbus: Tailwind's stylesheet sources: held the first ${STYLESHEET_SOURCE_MAX_FILES} files under ${stopped}; the rest are held as the scanner reads them]\n`);
  }

  private async _staticReadPlan(entry: ProcessEntry, vfsState: FacetVfsState, cwd: string, home: string | undefined, pacer: TurnBudget): Promise<string[]> {
    if (!this.filesystem) return [];
    const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
    const held = new Set(vfsState.bundlePaths ?? []);
    for (const path of vfsState.codeOnly ?? []) held.delete(path);
    const dir = stripLeadingSlashes(cwd).replace(/\/+$/, '');
    const reads = new Set<string>();
    for (const refs of await this._closureStaticRefs(vfs, entry.cred, vfsState.bundlePaths ?? [], pacer)) {
      for (const ref of refs.exact) if (ref.sync) reads.add(stripLeadingSlashes(ref.path));
      for (const ref of refs.cwdRelative) if (ref.sync) reads.add(normalizeVfsPath((dir ? dir + '/' : '') + ref.path));
    }
    const plan = new Set<string>();
    for (const path of reads) {
      let target: string;
      try { target = stripLeadingSlashes(await vfs.realpath('/' + path)); } catch { continue; }
      if (held.has(target)) continue;
      const stat = await filesOf(vfs).stat(target).catch(() => null);
      if (stat?.type === 'file') plan.add(target);
    }
    // And, for Tailwind's oxide, what its stylesheets name (data-plan.ts
    // stylesheet-source), from the stylesheets its bundle holds.
    if (carriesOxide(vfsState.bundlePaths ?? [])) {
      const sheets = (vfsState.bundlePaths ?? []).filter((path) => path.endsWith('.css') && packageRootOf(path) === null);
      const found = await planStylesheetSources(planSourceOf(vfs), { cwd, home: home || '/home/user', sheets, spend: (units) => pacer.spend(units) });
      for (const file of found.files) if (!held.has(file.path)) plan.add(file.path);
      this._noteSourcesStopped(entry, found.stopped);
      // Where its listing walks mounts, as its launch's names are.
      this.filesystem.nameLaunch?.(entry, () => found.read);
    }
    return [...plan];
  }

  /**
   * Per credential: the manifest copies read at one install revision, as the
   * launch body carries them. Kept to MANIFEST_COPIES_MAX_BYTES in all, the
   * most recently used first; one credential's are always kept.
   */
  private readonly manifestCopies = new Map<string, { install: string; json: string }>();

  /**
   * Every package.json the process's credential can see (data-plan.ts's
   * `package-json` rule, which a resident's plan applies itself), as copies a
   * one-shot is handed beside its plan: its store holds each manifest its own
   * listing names from boot (vfs/resident sync.setManifests).
   * A program resolves package names its closure never named, and reads each
   * manifest synchronously to do it: vite's config load, for every import of
   * the config it decides whether to externalize.
   *
   * Read once per install revision (NpmCache.installRevision) and kept as the
   * JSON the body carries, so a launch costs the copies' bytes and no read of
   * each. A copy carries its file's content key and the process holds it only
   * where its listing shows the same key, so a manifest written since (or
   * installed outside npm) is fetched rather than served old. One that is not
   * a single chunk (its content key is not the sha256 of its bytes), or past
   * MANIFEST_COPIES_MAX_BYTES, is fetched as well.
   */
  private async _installedManifests(entry: ProcessEntry, pacer: TurnBudget): Promise<string> {
    if (!this.filesystem) return '{"files":{}}';
    const { cred } = entry;
    const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
    const sql = (this.ctx.storage as { sql?: SqlStorage }).sql;
    const install = sql ? new NpmCache(sql).installRevision() : '';
    const held = this.manifestCopies.get(credKey);
    if (held !== undefined && held.install === install) {
      this.manifestCopies.delete(credKey);
      this.manifestCopies.set(credKey, held);
      return held.json;
    }
    const vfs = this.filesystem.bind({ pid: entry.pid, cred });
    const files: Record<string, [contentKey: string, text: string]> = {};
    let bytes = 0;
    for (let after: string | null = null; ;) {
      const page = await withRecall(() => vfs.list(after, FS_LIST_PAGE_LIMIT));
      await pacer.spend(page.entries.length * 64);
      for (const listed of page.entries) {
        const k = stripLeadingSlashes(listed.path);
        if (listed.kind !== 'file' || listed.contentKey === undefined || !isManifestKey(k)) continue;
        if (listed.size === 0 || listed.size > CHUNK_SIZE || bytes + listed.size > MANIFEST_COPIES_MAX_BYTES) continue;
        const read = await filesOf(vfs).readBytes(k).catch(() => null);
        if (read === null || await sha256Hex(read) !== listed.contentKey) continue;
        // The text is the file's bytes, a byte order mark included.
        const text = fileCell(read);
        if (typeof text !== 'string') continue;
        files[k] = [listed.contentKey, text];
        bytes += read.byteLength;
        await pacer.spend(read.byteLength);
      }
      if (page.next === null) break;
      after = page.next;
    }
    const json = JSON.stringify({ files });
    this.manifestCopies.delete(credKey);
    this.manifestCopies.set(credKey, { install, json });
    let kept = 0;
    for (const copies of this.manifestCopies.values()) kept += copies.json.length;
    for (const [oldest, copies] of this.manifestCopies) {
      if (kept <= MANIFEST_COPIES_MAX_BYTES || oldest === credKey) break;
      this.manifestCopies.delete(oldest);
      kept -= copies.json.length;
    }
    return json;
  }

  /**
   * Paths earlier launches of the same build missed in this session. Other
   * sessions' misses (the shared read profile) join the module map instead,
   * in _buildProcessBundle, where a learned module brings its imports.
   */
  private async _learnedReads(vfsState: FacetVfsState, _cred: ProcessEntry['cred']): Promise<string[]> {
    if (!vfsState.bundleKey) return [];
    const learned = await this.learning.forLaunch(vfsState.bundleKey);
    return [...learned.dataReads, ...learned.executedModules];
  }

  /**
   * The installed packages a closure can load: every package the lockfiles
   * pin whose node_modules directory is on the resolution path of the cwd or
   * of a closure file. A first miss is, by definition, in a package the
   * closure did not already load, so its package's root is found this way.
   */
  private _profileRoots(closure: readonly string[], cwd: string): string[] {
    const sql = (this.ctx.storage as { sql?: SqlStorage }).sql;
    if (!sql) return [];
    const integrities = new NpmCache(sql).installedIntegrities();
    if (integrities.size === 0) return [];
    const dirs = new Set<string>();
    const ancestors = (dir: string) => {
      for (let d = dir; ;) {
        const nm = d === '' ? 'node_modules' : `${d}/node_modules`;
        if (dirs.has(nm)) return;
        dirs.add(nm);
        if (d === '') return;
        d = d.slice(0, Math.max(0, d.lastIndexOf('/')));
      }
    };
    ancestors(cwd.replace(/^\/+|\/+$/g, ''));
    for (const path of closure) {
      const k = path.replace(/^\/+/, '');
      ancestors(k.slice(0, Math.max(0, k.lastIndexOf('/'))));
    }
    return [...integrities.keys()].filter((root) => {
      const i = root.lastIndexOf('/node_modules/');
      const parent = i === -1 ? (root.startsWith('node_modules/') ? 'node_modules' : null) : root.slice(0, i + '/node_modules'.length);
      return parent !== null && dirs.has(parent);
    });
  }


  /**
   * A package directory's identity for the shared read profile: the tarball
   * integrity the session's lockfiles pin, or, for a package no lockfile
   * pins (a link, a git or file dependency), the content key of its
   * package.json as this credential reads it.
   */
  private _packageIdentity(cred: ProcessEntry['cred']): (root: string) => string | null {
    const sql = (this.ctx.storage as { sql?: SqlStorage }).sql;
    const integrities = sql ? new NpmCache(sql).installedIntegrities() : new Map<string, string>();
    const view = this.vfs?.as(cred) ?? null;
    return (root) => {
      const integrity = integrities.get(root);
      if (integrity !== undefined) return integrity;
      if (view === null) return null;
      try { return `pkgjson:${view.contentKey(root + '/package.json')}`; } catch { return null; }
    };
  }

  /**
   * What the closure's JavaScript names by a foldable path (static-fs-refs.ts),
   * read from the VFS as written rather than from the module map, whose ESM
   * cells were rewritten and lost their import.meta. Each module is parsed once
   * per revision of it, in this session.
   */
  private async _closureStaticRefs(
    vfs: LaunchFs,
    /** Whose reads these are: the analysis of a file is kept per credential that read it. */
    cred: Readonly<VfsCred>,
    paths: readonly string[],
    pacer: TurnBudget,
    /** Called with each module that names paths, and what it names. */
    each?: (path: string, refs: StaticFsRefs) => void,
  ): Promise<StaticFsRefs[]> {
    const out: StaticFsRefs[] = [];
    for (const path of paths) {
      if (!/\.(?:c|m)?js$/.test(path)) continue;
      const refs = await this._staticRefsOf(vfs, cred, path, pacer);
      if (refs === null) continue;
      if (refs.exact.length + refs.listed.length + refs.patterns.length + refs.cwdRelative.length + refs.resolves.length + refs.subpaths.length > 0) {
        out.push(refs);
        each?.(path, refs);
      }
    }
    return out;
  }

  /**
   * One module's static filesystem references (_closureStaticRefs), parsed
   * once per revision of its file in this session; null if it has no
   * revision or cannot be read. The launch's image collector reads the same
   * analysis (collectClosureWasmImages).
   */
  private async _staticRefsOf(vfs: LaunchFs, cred: Readonly<VfsCred>, path: string, pacer?: TurnBudget): Promise<StaticFsRefs | null> {
    let rev: number;
    try { rev = await vfs.revision(path); } catch { return null; }
    // A credential's own: one that could not read the file never learns what it names.
    const key = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}\0${path}`;
    const memo = this.staticRefsMemo.get(key);
    if (rev !== 0 && memo && memo.rev === rev) return memo.refs;
    let source: string;
    try { source = await filesOf(vfs).readFileString(path); } catch { return null; }
    // A mounted file has no revision (0): its content's digest is its identity.
    const identity = rev !== 0 ? rev : await sha256Hex(source);
    if (memo && memo.rev === identity) return memo.refs;
    await pacer?.spend(source.length);
    const refs = findStaticFsReferences(source, '/' + path);
    // A registered sibling image is also bytes its loader may read.
    // CommonJS import.meta.url polyfills can hide that path from folding;
    // the image collector's same relative-literal rule still names it.
    for (const image of relativeWasmPaths(source, path)) {
      const name = '/' + image;
      const existing = refs.exact.find((ref) => ref.path === name);
      if (existing) existing.sync = true;
      else refs.exact.push({ path: name, sync: true });
    }
    this.staticRefsMemo.delete(key);
    this.staticRefsMemo.set(key, { rev: identity, refs });
    for (const oldest of this.staticRefsMemo.keys()) {
      if (this.staticRefsMemo.size <= FacetManager.STATIC_REFS_MEMO_MAX) break;
      this.staticRefsMemo.delete(oldest);
    }
    return refs;
  }

  /**
   * The cache's entry for `key` at `revision`, if one is held. An entry built
   * at an older revision can never be SERVED again — the lookup requires an
   * exact match — so from the first write after it was admitted it is
   * retained garbage, held in the isolate that is measurably
   * memory-constrained. Dropped here, before the build that replaces it
   * allocates, so the stale filesystem graph and the new one never co-reside.
   */
  private _takePrefetchEntry(key: string, revision: number, spec: ProcessBundleSpec): FacetVfsState | null {
    let evictedStale = false;
    for (const [staleKey, stale] of this.prefetchBundleCache) {
      if (stale.revision === revision) continue;
      this.prefetchBundleCache.delete(staleKey);
      this.prefetchCacheBytes -= stale.bytes;
      evictedStale = true;
    }
    if (evictedStale) setPrefetchCacheBytes(this.prefetchCacheBytes);
    const cached = this.prefetchBundleCache.get(key);
    if (!cached || cached.revision !== revision || spec.maxBundleBytes !== undefined) return null;
    // Refresh LRU recency.
    this.prefetchBundleCache.delete(key);
    this.prefetchBundleCache.set(key, cached);
    return { ...cached.vfsState, cacheHit: true, cacheRetained: true };
  }

  private async _buildProcessBundle(
    entry: ProcessEntry,
    spec: ProcessBundleSpec,
    pacer: TurnBudget,
  ): Promise<FacetVfsState> {
    // No filesystem: an empty bundle, its map's share taken as any other's.
    if (!this.vfs) return this._holdMapShare(entry, { bundle: {}, reachableCount: 0, truncated: false });
    if (!this.filesystem) throw new Error('Process filesystem authority is not initialized');
    this.imageStore.ensureDir(entry.pid);
    // Its program runs under the node shims, every way out of which waits at
    // the session's output gate or at their own boundary: its writes answer
    // at their commit.
    this.filesystem.continueAtCommit?.(entry.pid);
    const vfs = this.filesystem.bind({ pid: entry.pid, cred: entry.cred });
    const { cred } = entry;
    const profile = spec.bundleProfile ?? DEFAULT_FACET_BUNDLE_PROFILE;
    const moduleScope = spec.moduleScope ?? 'node';
    const credKey = `${cred.uid}:${cred.gid}:${cred.groups.join(',')}`;
    // The program's conditions choose what it resolves, and its preloads what
    // it loads: a map walked under other ones is another map.
    const launch = {
      conditions: spec.node?.conditions ?? [], require: spec.node?.require ?? [], import: spec.node?.import ?? [],
      stripTypes: moduleScope === 'node' ? typeScriptStripOptions(spec.node ?? {}) : null,
    };
    // `-e` code is staged as an ES module or not, as the command line says.
    const evaluatedModule = spec.esModule === true && (spec.scriptPath === undefined || spec.scriptPath === '<eval>' || spec.scriptPath === '[stdin]');
    const key = `${profile}\x00${moduleScope}\x00${credKey}\x00${spec.cwd}\x00${spec.scriptPath ?? ''}\x00${_fnv1a(spec.entryCode)}\x00${JSON.stringify(launch)}\x00${evaluatedModule ? 1 : 0}`;
    // A report still being recorded may drop this entry: let it land first.
    await this.learning.settled();
    let revision = await vfs.revision();
    /** The entry for `key` at the filesystem's revision now, read again (after a wait). */
    const takeCached = async (): Promise<FacetVfsState | null> => {
      await this.learning.settled();
      revision = await vfs.revision();
      return this._takePrefetchEntry(key, revision, spec);
    };
    const cached = this._takePrefetchEntry(key, revision, spec);
    if (cached) return this._holdMapShare(entry, cached);
    // A build of the same launch at the same revision is in flight: its entry is this launch's once it is admitted.
    // (A rebuild under the ceiling takes no entry, and waits for none.)
    const shared = spec.maxBundleBytes === undefined;
    const inFlight = shared ? this.prefetchBuilds.get(key) : undefined;
    if (inFlight !== undefined && inFlight.revision === revision) {
      // Joined holding nothing: its leader (a standalone resident's build, say) may need a worker for its helpers.
      const outside = waitOutsideLedger(this.ctx, entry.pid, () => [inFlight.leader]);
      let built: Awaited<typeof inFlight.done>;
      try {
        built = await inFlight.done;
      } finally {
        outside();
      }
      const published = await takeCached();
      if (published) return this._holdMapShare(entry, published);
      // Not retained (past the entry bound): that build's own result, if the filesystem is still at the revision it read.
      if (built !== null && built.revision === revision) return this._holdMapShare(entry, { ...built.state, cacheHit: true, cacheRetained: false });
    }

    // Kinu #29: the cells are gathered and serialized under one admission,
    // kept until the launch's module map is made, so cache-miss builds queue
    // for room through all three. A launch admitted after a wait, while
    // another of its key published, takes that entry. A build again for this
    // launch under the ceiling builds under the share its map kept: it may
    // hold a worker, and waits for no credit.
    const held = this.buildAdmissions.get(entry.pid);
    this.buildAdmissions.delete(entry.pid);
    const buildUnder = async (admission: PrefetchAdmission, fullBound: number, creditLimit: number | undefined): Promise<{ state: FacetVfsState; shared: { state: FacetVfsState; revision: number } | null }> => {
      const admitted = admission.queued ? await takeCached() : null;
      if (admitted) return { state: admitted, shared: null };
      // It builds the filesystem as it is now, read again after its wait: a
      // launch of its key arriving at that revision joins it.
      inProgress.revision = revision;
      const readProfile = this.readProfile;
      const offered: StagedProfileEntry[] = [];
      const learnedFor = readProfile === null ? undefined : async (closure: readonly string[]) => {
        const roots = this._profileRoots(closure, spec.cwd);
        if (roots.length === 0) return [];
        offered.push(...await readProfile.lookup(roots, this._packageIdentity(cred), READ_PROFILE_LAUNCH_BYTES));
        return offered.map((entry) => entry.path);
      };
      const learning = await this.learning.forLaunch(key);
      // What earlier runs executed roots the required graph; what they read
      // stays data. A module whose file is readable but was not in the map
      // arrives as runtime code with its text; its imports are roots too, so a
      // launch does not discover one static dependency per run (Nuxt/Vinext).
      const executed: RequiredModuleRoot[] = learning.executedModules.map((path) => ({ path }));
      for (const code of learning.code.values()) {
        if (code.kind === 'module' && !code.path.startsWith('data:')) {
          executed.push({ path: code.path.replace(/^\/+/, ''), text: code.text });
        }
      }
      const vfsState = await gatherPrefetchBundle(vfs, {
        scriptPath: spec.scriptPath,
        cwd: spec.cwd,
        entryCode: spec.entryCode,
        esbuild: this.esbuild ?? undefined,
        staticRefs: (path) => this._staticRefsOf(vfs, cred, path, pacer),
        bundleProfile: profile,
        moduleScope,
        observedReads: new Set(learning.dataReads),
        pacer,
        learnedFor,
        // Under the ceiling's bound, what earlier runs executed is staged as far as it allows (_rebuildUnderCeiling).
        executedModules: spec.maxBundleBytes === undefined ? executed : executed.map((root) => ({ ...root, optional: true })),
        maxBundleBytes: fullBound,
        transformStore: this._transformStore(),
        conditions: launch.conditions,
        stripTypes: launch.stripTypes,
        preloads: [
          ...launch.require.map((specifier) => ({ preload: 'require' as const, specifier })),
          ...launch.import.map((specifier) => ({ preload: 'import' as const, specifier })),
        ],
        ...(evaluatedModule ? { entryEsModule: entryEsModuleKey(spec.scriptPath, spec.cwd) } : {}),
      }, creditLimit);
      if (offered.length > 0) {
        const staged: StagedProfileEntry[] = [];
        const unresolved: string[] = [];
        for (const entry of offered) {
          if (vfsState.bundle[entry.path] !== undefined) { staged.push(entry); continue; }
          // Not staged: over the budget, or nothing a regular file answers (then it is pruned).
          const stat = await Promise.resolve(vfs.stat('/' + entry.path, { followSymlinks: false })).catch(() => null);
          if (stat === null || stat.type !== 'file') unresolved.push(entry.path);
        }
        vfsState.profileOffer = { staged, unresolved };
      }
      vfsState.bundleKey = key;
      vfsState.bundlePaths = Object.keys(vfsState.bundle);
      // The only consumers of the raw cells past serialization are these two
      // answers, so they come first; the serialization then consumes the cells.
      vfsState.usesNodeSqlite = bundleUsesNodeSqlite(spec.entryCode, vfsState.bundle);
      // What the closure names, and what the launched bin's own dependency tree
      // installs: a binding is compiled with the launch or not at all, and a
      // program can reach its owner by a specifier no walk follows.
      const declaredWalk = { probes: 0 };
      const declaredBindings = await stagedBindingsDeclaredBy(declaredBindingFs(vfs), spec.scriptPath, undefined, declaredWalk);
      const namedBindings = stagedBindingsRequiredBy(Object.entries(vfsState.bundle));
      const requiredBindings = new Set([...namedBindings, ...declaredBindings]);
      const stagedBindings = STAGED_BINDINGS.filter((b) => requiredBindings.has(b.key)).map((b) => b.key);
      vfsState.stagedBindings = stagedBindings;
      if (this.debugEnabled) {
        this.processes.appendOutput(entry.pid, 'stderr', `[nimbus-debug] staged bindings: [${vfsState.stagedBindings.join(', ')}]`
          + ` (named by the closure: [${namedBindings.join(', ')}]; declared by the bin's dependencies: [${declaredBindings.join(', ')}],`
          + ` ${declaredWalk.probes} filesystem questions)\n`);
      }
      // Wasm a package inlines as base64 in its own source (Vite's copy of
      // es-module-lexer) never passes through the filesystem, so the closure
      // walk's by-path records cannot name it; it is staged here instead.
      // And so do the images earlier runs compiled from bytes in memory (learnedWasmImages).
      const inlineWasm = this._stageWasmImageBytes([...findInlineWasmImages(vfsState.bundle), ...learnedWasmImages(learning.code)], entry.pid);
      if (inlineWasm.length > 0) vfsState.wasmImages = [...(vfsState.wasmImages ?? []), ...inlineWasm];
      // Sized with what its map owns beside the closure, so a launch never
      // gives back what its map takes moments later. A preparation returning
      // for a larger map keeps the share it already sized.
      if (held === undefined) {
        const members = await this._oneShotMemberBytes(entry, facetWasmImports([], vfsState.wasmImages ?? []), stagedBindings);
        admission.fit(vfsState.rawBytes ?? 0, members.owned);
      }
      // And what the module map costs the facet's store, which adopts it at boot
      // (N18): taken now, while the cells exist, for every launch this state
      // serves (a cache hit included).
      vfsState.moduleStorageBytes = moduleMapStorageBytes(vfsState.bundle, vfsState.codeOnly);
      const serializeFrom = Date.now();
      vfsState.bundleSource = await buildFacetVfsBundleSource(
        vfsState.bundle,
        pacer,
        {
          consume: true,
          emits: vfsState.emits,
          esm: vfsState.esm,
          codeOnly: vfsState.codeOnly,
          dataModules: vfsState.dataModules,
          runtimeCode: await this._stagedRuntimeCode(learning, vfs, pacer, moduleScope, launch.stripTypes),
        },
      );
      if (vfsState.phases) vfsState.phases.serialize = Date.now() - serializeFrom;
      vfsState.cacheHit = false;

      // Serialization is total: bundleSource/serializedManifest/serializedMetadata
      // carry every byte the raw cells and objects do, and both generators read
      // only the serialized forms. Retaining both doubled what an entry costs
      // for its whole lifetime — measured for pi at 502af77, per entry: raw
      // 17,253,610 + source 18,262,324 + manifest 600,060 + metadata 3,841,244
      // = 39,957,238 B, of which the raw halves are 21,694,914 B held to answer
      // `usesNodeSqlite`. Dropping them is a pure release: nothing downstream of
      // this method reads them, and a cache MISS rebuilds from the VFS rather
      // than from anything discarded here.
      //
      // Released BEFORE admission so the byte bound prices what the entry costs
      // from here on, not the peak it passed through on the way in.
      releaseSerializedSources(vfsState);
      vfsState.cacheRetained = this._admitPrefetchCacheEntry(key, revision, vfsState);
      // What a launch of this key waiting for this build takes: a state of its own, released by it alone.
      return { state: vfsState, shared: { state: { ...vfsState }, revision } };
    };
    // This build as launches of its key find it (prefetchBuilds), at the revision it reads.
    const inProgress: { revision: number; leader: number; done: Promise<{ state: FacetVfsState; revision: number } | null> } = {
      revision, leader: entry.pid, done: Promise.resolve(null),
    };
    // Its helpers wait for a worker as its process (withLaunchPreparation): a wait nothing can satisfy is one the ledger tells.
    const building = withLaunchPreparation(this.ctx, { pid: entry.pid }, async () => {
      // Held from the moment it is taken: the detector names its holders (_creditHolders).
      const owner = this._allocationOwner(entry.pid);
      let admission = held ?? tryAdmitPrefetchBuild(owner) ?? await admitPrefetch(() => this._launchEnds(entry.pid), undefined, false, owner);
      for (;;) {
        this.buildAdmissions.set(entry.pid, admission);
        const fullBound = spec.maxBundleBytes ?? VFS_BUNDLE_MAX_BYTES;
        const bound = admission.held() < SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES
          ? Math.min(fullBound, Math.floor(admission.held() / PREFETCH_PEAK_PER_BYTE)) : fullBound;
        const creditLimit = bound < fullBound ? bound : undefined;
        try {
          return await buildUnder(admission, fullBound, creditLimit);
        } catch (error) {
          // The failed gather has unwound before its credit is returned; no partial cells survive the bounce.
          this._releaseBuildAdmission(entry.pid);
          if (creditLimit === undefined || !(error instanceof ClosureBoundExceededError) || error.outcome.bound !== creditLimit) throw error;
          admission = await admitPrefetch(() => this._launchEnds(entry.pid), undefined, false, owner);
        }
      }
    });
    inProgress.done = building.then((built) => built.shared, () => null);
    if (shared) this.prefetchBuilds.set(key, inProgress);
    try {
      return (await building).state;
    } finally {
      if (this.prefetchBuilds.get(key) === inProgress) this.prefetchBuilds.delete(key);
    }
  }

  /**
   * Generate a launch's map under the ceiling on it. `others` is what the rest
   * of the map holds (its wasm images, staged bindings and sidecars), sized
   * by the caller; `generate` makes the map's text from a state. A map over
   * the ceiling keeps the learned runtime code learnedRuntimeCodeWithin
   * keeps and is made again from the state without the rest; one over it
   * with none of it throws ModuleMapOverCeilingError.
   */
  private _generateUnderCeiling<G extends GeneratedNodeFacetCode>(
    pid: number,
    vfsState: FacetVfsState,
    others: number,
    generate: (state: FacetVfsState) => Promise<G>,
    keepAdmission = false,
  ): Promise<G> {
    // Under the launch's share of the credit, taken before its worker
    // (_buildProcessBundle: its build's, or its map's): a map made while a
    // worker is held waits for no credit.
    const admission = this.buildAdmissions.get(pid);
    if (admission === undefined) return Promise.reject(new Error(`Nimbus: the module map for pid ${pid} has no share of the credit`));
    return this._generateWithin(pid, vfsState, others, generate, admission, keepAdmission);
  }

  /**
   * _generateUnderCeiling's work, under its admission, which it gives back
   * as it ends; over the ceiling, it is kept for the rebuild under it
   * (_rebuildUnderCeiling), which then waits for no credit.
   */
  private async _generateWithin<G extends GeneratedNodeFacetCode>(
    pid: number,
    vfsState: FacetVfsState,
    others: number,
    generate: (state: FacetVfsState) => Promise<G>,
    admission: PrefetchAdmission,
    keepAdmission: boolean,
  ): Promise<G> {
    let keptForRebuild = false;
    try {
      const room = DYNAMIC_WORKER_CODE_LIMIT_BYTES - others;
      let generated: G | undefined = await generate(vfsState);
      const bytes = generatedMapTextBytes(generated, room);
      if (bytes === null || bytes <= room) {
        keptForRebuild = keepAdmission;
        return generated;
      }
      const source = vfsState.bundleSource;
      const keys: string[] = source ? JSON.parse(source.runtimeCode) : [];
      const learned = keys.map((key) => [key, utf8Length(generated!.codeModules[runtimeCodeModuleName(key)] ?? '')] as const);
      generated = undefined;
      const { kept, over } = learnedRuntimeCodeWithin(bytes, learned, room);
      if (over > 0 || !source) throw new ModuleMapOverCeilingError(over);
      const keep = new Set(kept);
      const codeModules = { ...source.codeModules };
      for (const key of keys) if (!keep.has(key)) delete codeModules[runtimeCodeModuleName(key)];
      const message = `the module map is ${(bytes + others).toLocaleString('en-US')} bytes with the code earlier runs learned, over the `
        + `${DYNAMIC_WORKER_CODE_LIMIT_BYTES.toLocaleString('en-US')}-byte ceiling: it stages ${kept.length} of its ${keys.length} pieces, `
        + 'the first its runs needed, and runs the rest interpreted, as the run that learned them did';
      console.warn(`[facet-manager] pid ${pid}: ${message}`);
      if (this.debugEnabled) this.processes.appendOutput(pid, 'stderr', `[nimbus-debug] ${message}\n`);
      const trimmed = await generate({ ...vfsState, bundleSource: { ...source, codeModules, runtimeCode: JSON.stringify(kept) } });
      keptForRebuild = keepAdmission;
      return trimmed;
    } catch (error) {
      if (error instanceof ModuleMapOverCeilingError) {
        this.buildAdmissions.set(pid, admission);
        keptForRebuild = true;
      }
      throw error;
    } finally {
      if (!keptForRebuild) this._releaseBuildAdmission(pid);
    }
  }

  /**
   * Build a launch's state again when its map was over the ceiling with none
   * of its learned code (ModuleMapOverCeilingError), `over` bytes past it:
   * under a bound on its walked modules that much below what the state's
   * took, what earlier runs executed as optional roots (staged as far as the
   * bound allows, the first-learned first; the rest load late, as the run
   * that learned them loaded them), in place of what the cache held. Every
   * cell costs the map at least its raw bytes, so the map comes in at least
   * `over` lower; a closure that does not fit the bound fails by name
   * (ClosureBoundExceededError), as one past its bound always has.
   */
  private async _rebuildUnderCeiling(
    entry: ProcessEntry,
    spec: ProcessBundleSpec,
    vfsState: FacetVfsState,
    error: ModuleMapOverCeilingError,
    pacer: TurnBudget,
  ): Promise<FacetVfsState> {
    if (vfsState.bundleKey !== undefined) this._dropPrefetchCacheEntry(vfsState.bundleKey);
    releaseGeneratedSources(vfsState);
    const maxBundleBytes = Math.max(0, (vfsState.rawBytes ?? 0) - error.over);
    // Every later credit retry or replay builds this same effective, ceiling-bounded launch.
    spec.maxBundleBytes = maxBundleBytes;
    console.warn(`[facet-manager] pid ${entry.pid}: ${error.message}; building it again with its walked modules bounded at `
      + `${maxBundleBytes.toLocaleString('en-US')} bytes, what earlier runs executed staged as far as that allows`);
    return this._buildProcessBundle(entry, spec, pacer);
  }

  /**
   * What a resident's map holds beside its generated text: its sidecars, its
   * staged bindings' loader and trampoline, the host's adapter around its
   * worker.js, and the wasm images and bindings it reads by path at boot, at
   * their size on the session's disk.
   */
  private _residentMemberBytes(
    pid: number,
    sqliteModules: Readonly<Record<string, { wasm: ArrayBuffer }>>,
    staged: ResidentStagedBindings | null,
    wasmImports: readonly FacetWasmImport[],
  ): number {
    let bytes = moduleMemberBytes(sqliteModules) + hostAdapterBytes('worker.js');
    if (staged) bytes += utf8Length(staged.loader) + staged.trampoline.byteLength;
    // Sized as the process its boot reads them as (_residentDisk).
    const fs = this.vfs?.as(this.processes.cred(pid));
    for (const path of [...wasmImports.map((image) => image.vfsPath), ...Object.values(staged?.bindingPaths ?? {})]) {
      // One that is not there fails the boot, which reads it; it holds nothing here.
      try { bytes += fs?.stat(path).size ?? 0; } catch { /* absent */ }
    }
    return bytes;
  }

  /**
   * Admit an entry and evict, oldest first, until the LRU is inside BOTH its
   * entry count and its byte bound.
   *
   * The count alone bounded nothing — each entry holds a raw bundle plus its
   * serialized source, manifest and metadata, so sixteen of them could hold
   * several times the supervisor ceiling. That is the same defect that let
   * pi's 44 MB boot payload through: a thing sized by count when what matters
   * is bytes.
   */
  /**
   * File what a run learned against the bundle it ran: code it produced,
   * modules it tried to execute and files it read that the launch lacked.
   *
   * A miss the supervisor never hears about is a miss the next run repeats,
   * so this is the whole of the repair: record it (in the session's storage,
   * so the next run learns it however long the user waits), and when that
   * taught the profile anything, drop the cached bundle for the key so the
   * next build is a real one and stages it. A report of nothing new keeps
   * the cache: a miss that cannot be staged would otherwise force a rebuild
   * on every launch. The record is queued ahead of any later read of the
   * profile, so a relaunch that follows at once builds from it. A failed
   * record rejects: its caller says so where the user reads it.
   */
  private async _recordLaunchLearning(key: string | undefined, report: LaunchReport): Promise<void> {
    if (!key) return;
    const empty = (list: readonly unknown[] | undefined) => !Array.isArray(list) || list.length === 0;
    if (empty(report.code) && empty(report.executedModules) && empty(report.dataReads)) return;
    if (await this.learning.record(key, report)) this._dropPrefetchCacheEntry(key);
  }

  /** Tell a process's log that what its run learned was not kept. */
  private _learningLost(pid: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[facet-manager] launch learning for pid ${pid} not recorded:`, error);
    try {
      this.processes.appendOutput(pid, 'stderr', `Nimbus: what this run needed was not recorded for its next launch: ${message}\n`);
    } catch { /* the pid is gone; the platform log above has it */ }
  }

  private _dropPrefetchCacheEntry(key: string): void {
    const cached = this.prefetchBundleCache.get(key);
    if (!cached) return;
    this.prefetchBundleCache.delete(key);
    this.prefetchCacheBytes -= cached.bytes;
    setPrefetchCacheBytes(this.prefetchCacheBytes);
  }

  /**
   * The runtime code recorded for an entry, as `{ cjs }` module text by key:
   * a constructor call as the function module (or the SyntaxError the
   * constructor would throw), a CommonJS file wrapped as a module cell is. A
   * file is staged by its content key even when the launch also carries its
   * path as a cell: the guest looks a path up first and the key only for a
   * path the map lacks — the same text written under a fresh name. An ES
   * module (a data: URL's always) is not staged: each instance of it is the
   * path it was written at, which a module the map fixes cannot be, so each
   * launch interprets it (core native-esm.ts).
   */
  private async _stagedRuntimeCode(
    learning: LaunchLearning, vfs: LaunchFs, pacer: TurnBudget, moduleScope: ModuleScope, stripTypes: NodeTypeScript | null,
  ): Promise<Map<string, string> | undefined> {
    const modules = new Map<string, string>();
    for (const [codeKey, entry] of learning.code) {
      // An image is carried as a wasm member (learnedWasmImages), not as code.
      if (entry.kind === 'wasm') continue;
      if (entry.kind === 'expression') {
        modules.set(codeKey, runtimeExpressionModule(entry.code));
        continue;
      }
      if (entry.kind !== 'module') {
        modules.set(codeKey, runtimeFunctionModule(entry.kind, entry.params, entry.body));
        continue;
      }
      if (entry.path.startsWith('data:')) continue;
      const path = entry.path.replace(/^\/+/, '');
      const file: Record<string, string> = { [path]: entry.text };
      const emits = new Map<string, string>();
      const esModules = new Map<string, string>();
      const placeEmit = (at: string, code: string) => { emits.set(at, code); };
      const packageTypeOf = await cellPackageTypes(vfs, [path]);
      if (this.esbuild) await transformBundleModules(file, placeEmit, esModules, packageTypeOf, moduleScope, stripTypes, this.esbuild, pacer, this._transformStore());
      else _markBundleEsmAsFailed(file, placeEmit, packageTypeOf, 'no esbuild service was given to this launch');
      if (esModules.has(path)) continue;
      let code = emits.get(path) ?? entry.text;
      try {
        code = rewriteProvidedCommonJsModules(code);
      } catch {
        // Unparseable: it stays as written, and requiring it says why.
      }
      modules.set(codeKey, wrapCommonJsCell(code).text);
    }
    return modules.size > 0 ? modules : undefined;
  }

  /** True when the cache is holding this state — see FacetVfsState.cacheRetained. */
  private _admitPrefetchCacheEntry(
    key: string,
    revision: number,
    vfsState: FacetVfsState,
  ): boolean {
    const previous = this.prefetchBundleCache.get(key);
    if (previous) this.prefetchCacheBytes -= previous.bytes;
    const bytes = retainedVfsStateBytes(vfsState);
    this.prefetchBundleCache.delete(key);
    // A bundle larger than the WHOLE bound is not retained. It used to be
    // admitted anyway, on the reasoning that refusing it means never caching
    // the program the session is running — but admission then evicted every
    // other entry to make room for something that still did not fit, leaving
    // the cache over its own bound with nothing else in it. Measured: a
    // 21.50 MiB entry left a 16 MiB cache holding 21.50 MiB with four prior
    // entries gone. The caller still uses this build for the invocation it was
    // made for; it simply does not become permanent supervisor pressure after
    // that. With it refused, the loop below can no longer be asked to evict
    // the entry it just admitted.
    if (bytes > PREFETCH_CACHE_MAX_BYTES) {
      setPrefetchCacheBytes(this.prefetchCacheBytes);
      return false;
    }
    this.prefetchBundleCache.set(key, { revision, vfsState, bytes });
    this.prefetchCacheBytes += bytes;
    for (const [oldest, entry] of this.prefetchBundleCache) {
      if (
        this.prefetchBundleCache.size <= FacetManager.PREFETCH_CACHE_MAX
        && this.prefetchCacheBytes <= PREFETCH_CACHE_MAX_BYTES
      ) break;
      this.prefetchBundleCache.delete(oldest);
      this.prefetchCacheBytes -= entry.bytes;
    }
    setPrefetchCacheBytes(this.prefetchCacheBytes);
    return this.prefetchBundleCache.has(key);
  }

  /**
   * Build the Worker Loader module-map fragment that carries the sql.js
   * WebAssembly.Module into a facet, when that facet imports node:sqlite.
   * Returns `{}` for the common case (no sqlite) so the spread is free.
   * Delegates to the shared per-isolate memoizer in opencode-staging.ts.
   */
  private sqliteModuleEntry(
    usesSqlite: boolean,
  ): Promise<Record<string, { wasm: ArrayBuffer }>> {
    return sqliteWasmModuleEntry(this.env, usesSqlite);
  }

  private trackProcessRpcResources(
    pid: number,
    resources: Iterable<unknown>,
    options: { releaseOnReportExit?: boolean } = {},
  ): void {
    this.releaseProcessRpcResources(pid);
    this.processRpcResources.set(pid, {
      resources: [...resources],
      releaseOnReportExit: options.releaseOnReportExit !== false,
    });
  }

  private releaseProcessRpcResources(pid: number): void {
    const tracked = this.processRpcResources.get(pid);
    if (!tracked) return;
    this.processRpcResources.delete(pid);
    disposeRpcResources(tracked.resources);
  }

  private revokeProcessVfsWriters(pid: number, writerId?: string): void {
    openSupervisorDeliveries(this.ctx).endReadRun(pid, writerId);
  }

  /**
   * True while a resident facet holds this pid — it was adopted through the
   * bin-spawn contract and now owns the process lifecycle, reporting its own
   * exit. A caller that launched the command must not record an exit for it.
   */
  hasResidentProcess(pid: number): boolean {
    return this.processRpcResources.has(pid);
  }

  /** Acknowledge generated code only after storage has accepted it. The
   * launch key comes from the process table, never from guest arguments. */
  async noteProcessRuntimeCode(pid: number, entries: unknown[], executedModules: string[] = [], dataReads: string[] = []): Promise<void> {
    const launch = this.launchBundles.get(pid);
    if (!launch || this.processes.get(pid)?.state !== 'running') throw new Error('Runtime code report has no live launch');
    for (const path of Array.isArray(dataReads) ? dataReads : []) {
      if (typeof path === 'string' && launch.refused.size < LAUNCH_PROFILE_MAX_PATHS) launch.refused.add(path);
    }
    await this._recordLaunchLearning(launch.key, { code: entries, executedModules, dataReads });
  }

  noteProcessReportedExit(
    pid: number,
    exitCode: number,
    dataReads?: string[],
    evidence?: { served: ReadonlySet<string>; profileUnread: readonly string[] | null },
    runtimeCode?: unknown[],
    executedModules?: string[],
  ): void {
    // Filed before the exit marks the table: the terminal hook forgets the key.
    this.ctx.waitUntil(
      this._recordLaunchLearning(this.launchBundles.get(pid)?.key, { code: runtimeCode, executedModules, dataReads })
        .catch((error) => this._learningLost(pid, error)),
    );
    const residencyMisses = [...(dataReads ?? []), ...(executedModules ?? [])];
    const exiting = this.processes.get(pid);
    const offer = this.residentProfileOffers.get(pid);
    this.residentProfileOffers.delete(pid);
    if (this.readProfile && exiting) {
      // The shared profile learns only what this supervisor served the process
      // after a miss, as the process's own credential sees it (read-profile.ts).
      const profile = this.readProfile;
      const identity = this._packageIdentity(exiting.cred);
      const view = this.vfs?.as(exiting.cred) ?? null;
      const served = evidence?.served ?? new Set<string>();
      // Observers and vouchers are principals the router verified, read off
      // this session's Durable Object name; an anonymous session only reads.
      const principal = profilePrincipal(sessionIdentity({ ctx: this.ctx })?.tenantSegment);
      this.ctx.waitUntil((async () => {
        const tag = principal === null ? null : await principalTag(principal);
        if (tag !== null && view !== null && residencyMisses && residencyMisses.length > 0) {
          const found = await verifiedEvidence(residencyMisses, served, async (path) => {
            try { const st = view.lstat(path.replace(/^\/+/, '')); return { type: st.type, size: st.size }; } catch { return null; }
          });
          if (found.length > 0) await profile.observe(found, tag, identity);
        }
        if (tag !== null && offer !== undefined) {
          const unread = evidence?.profileUnread ? new Set(evidence.profileUnread) : null;
          await profile.settle(offer.staged, unread, served, new Set(offer.unresolved), tag);
        }
      })().catch(() => undefined));
    }
    this._end(pid, { code: exitCode });
  }

  /**
   * Tear down the serve facet a dual (`opencode`) spawn paired with this pid.
   * Called when the attach TUI exits (reported / killed) so the OS-child serve
   * facet never outlives its foreground process.
   */
  private _teardownPairedServeFacet(attachPid: number): void {
    const servePid = this._pairedServeFacet.get(attachPid);
    if (servePid === undefined) return;
    this._pairedServeFacet.delete(attachPid);
    try { this.kill(servePid); } catch {}
  }

  /** Execute one-shot JS code in an isolated dynamic Worker. */
  async exec(
    code: string,
    opts: {
      argv?: string[];
      env?: Record<string, string>;
      cwd?: string;
      filename?: string;
      dirname?: string;
      stdin?: string;
      /**
       * G4 (runtime-pkg wave): caller-supplied display label for the
       * process entry. When set, takes precedence over the
       * default `node ${filename}`. Used by the .bin handler in
       * init.ts so `tsc --version` shows up in `ps` as
       * `tsc --version` (the user's typed line) rather than
       * `node /home/user/proj/node_modules/typescript/bin/tsc`.
       *
       * Also: when `command` is provided AND `skipSpawn` is true,
       * the caller has already spawned the process entry (e.g. the
       * .bin wrapper that needs to allocate a PID before parsing
       * the shim). exec() reuses that PID instead of spawning a
       * second one — the G4 double-spawn fix.
       */
      command?: string;
      /** G4: caller already spawned the process entry; don't double-spawn. */
      skipSpawn?: boolean;
      /** G4: when skipSpawn is true, the PID the caller allocated. */
      callerPid?: number;
      /** The process whose command runs the program: its parent, whose credential and exec id it takes. */
      invokerPid?: number;
      /** The program is an ES module (RuntimeRunOpts.esModule). */
      esModule?: boolean;
      /** CommonJS evaluated before the entry (node-runner.ts RunFreshOpts.preamble). */
      preamble?: string;
      /** Whose scope the runtime runs an ES module in (RuntimeRunOpts.moduleScope): absent, Node's. */
      moduleScope?: ModuleScope;
      bundleProfile?: FacetBundleProfile;
      /** Return stdout/stderr in the result while keeping supervisor RPC
       *  available for VFS and child_process operations. */
      captureOutput?: boolean;
      /** Shell abort (Ctrl+C): aborting this aborts the in-flight run. */
      signal?: AbortSignal;
      /**
       * A pipe or redirect as the program's stdin. It streams through the
       * process's input channel as it arrives, from before the program
       * starts; the program is never held for the pipe to end.
       */
      stdinPipe?: StdinBytes;
      foreground?: ForegroundLaunch;
      /**
       * A `< file` redirect: fd 0 is this file from `offset`. `syncRead`: the
       * program reads the file ahead before it starts (a run after one that
       * stopped at a synchronous read of it).
       */
      stdinFile?: { path: string; offset: number; syncRead: boolean };
      /** A node program's command line: its options, conditions, preloads and `-e`/`-p` code (core runtime/node-cli.ts). */
      node?: NodeLaunch;
      /** The bin it runs: learned a server when it runs on as one (_promote). */
      server?: ServerIdentity;
    },
  ): Promise<FacetExecResult> {
    const command = opts.command
      || (opts.filename && opts.filename !== '<eval>'
        ? `node ${opts.filename}` : 'node -e ...');
    let entry: ProcessEntry;
    if (opts.skipSpawn && opts.callerPid != null) {
      // The caller already allocated the PID via the supervisor
      // (with their own user-facing label). Look up the full entry
      // from the table — the exec path needs the canonical
      // ProcessEntry shape. Do NOT reap() either: reaping would
      // clear the caller's just-spawned entry because its startTime
      // is recent (< 60s) but reap() ALSO drops 'running' entries
      // older than the threshold; in any case we don't want side
      // effects when the caller is delegating PID ownership.
      const found = this.processes.get(opts.callerPid);
      if (!found) {
        throw new Error(`facetMgr.exec skipSpawn: callerPid=${opts.callerPid} not in process table`);
      }
      entry = found;
    } else {
      await this.processes.reap();
      // A child of the command that ran it, so under its credential: the
      // program's syscalls answer under the credential the table holds for
      // its pid. At the top of the table it ran as the session user whoever
      // started it.
      entry = this.processes.spawn(command, launchArgv({ execArgv: opts.node?.execArgv, argv: opts.argv }), opts.cwd || '/home/user', { parentPid: opts.invokerPid });
      // The command that ran it awaits it as that command's work (a shell
      // line's `node x`), until it ends: the session tells a shell doing
      // nothing but await its programs by it (SessionProcessSupervisor).
      if (opts.invokerPid !== undefined) this.processes.beginAwait(opts.invokerPid, entry.pid);
      // Short foreground `node -e ...` helpers are quiet by design — only
      // notify for user-facing `node <file>` invocations, which covers the
      // real user intent (running scripts, wrangler, etc.).
      if (opts.filename && opts.filename !== '<eval>') {
        try { this.hooks.onSpawn?.(entry.pid, command, false); } catch {}
      }
    }

    // Started with the launch, so a writer that has finished (echo, head) has
    // delivered all of it, and its end, by the time the program starts: the
    // guest takes what is queued then, for its synchronous reads of fd 0
    // (node-shims.ts, __nimbusPrepareStdin).
    const stdinPump = opts.stdinPipe ? this._pumpStdinPipe(entry.pid, opts.stdinPipe) : null;
    const foreground = opts.foreground ? this._holdForeground(entry.pid, opts.foreground) : null;

    const abortController = new AbortController();
    // Ctrl-C / kill on a user program has to end the in-flight run, not just
    // mark the table row: the runOnce request carries this signal.
    this.processes.setTerminator(entry.pid, () => abortController.abort());
    // A shell Ctrl+C arrives as an abort on the command's signal — it is the
    // same kill, forwarded onto the controller the runOnce request carries.
    const onShellAbort = () => abortController.abort();
    opts.signal?.addEventListener('abort', onShellAbort, { once: true });
    // Kinu #29: follow AGENTS.md's supervisor-credit / Dynamic Worker lock order.
    let admitted = false;
    let prepareFailed = false;
    this._launchStage(entry, 'prepare', abortController.signal);
    // A kill ends the launch where it waits, whether or not that wait hears it.
    abortController.signal.addEventListener('abort', () => this._launchEnded(entry.pid), { once: true });
    // Paced like a resident launch: a tree too large for one turn costs
    // turns, and the pacer's stillWanted check ends a build whose process was
    // killed while it was suspended. The invocation that granted the last
    // chunk awaits `chunkEnded` (PacedWork.pump), so it owns the launch until
    // the pacer settles: once the program is loaded and about to be entered
    // (_execViaLoader's onLoaded), as a resident launch settles once its
    // process has booted, and in the finally below for a launch that ends
    // sooner. Not at the end of the build, which would release that turn
    // with the module map still to assemble and load on it; and not at the
    // end of the run, which held the session's launch alarm for as long as
    // the program ran, so a child it launched and waited on, needing a turn
    // of its own, never got one.
    const pacer = this._launchPacer(entry.pid);
    const failed = async <Failure>(error: Failure): Promise<FacetExecResult> => {
      // A generation or run failure has the same result, wherever the worker wait falls.
      const unsettled = `${UNSETTLED_END_NOTE}\n`;
      if (abortController.signal.aborted) {
        this._end(entry.pid, { code: 137, killed: true });
        if (!opts.captureOutput) await this._deliverOutput(entry.pid, 'stderr', new TextEncoder().encode(unsettled));
        return { exitCode: 130, stdout: '', stderr: opts.captureOutput ? unsettled : '' };
      }
      // A ledger refusal is still the spawn failing: a pid the caller allocated is theirs to mark.
      if (isDynamicWorkerDeadlock(error)) {
        if (!opts.skipSpawn) this._end(entry.pid, { code: 1 });
        throw error;
      }
      const refused = residencyMissReport([...(this.launchBundles.get(entry.pid)?.refused ?? [])]);
      this._end(entry.pid, { code: 1, cause: `runtime worker error: ${errorMessage(error)}` });
      return { exitCode: 1, stdout: '', stderr: `${errorMessage(error)}\n${unsettled}${refused}` };
    };
    const preparationFailed = async <Failure>(error: Failure): Promise<FacetExecResult> => {
      prepareFailed = true;
      pacer.settle();
      stdinPump?.stop();
      foreground?.release();
      return failed(error);
    };
    try {
      const diagOn = isExecDiagEnabled();
      const __bundleStart = diagOn ? Date.now() : 0;
      const bundleSpec: ProcessBundleSpec = { scriptPath: opts.filename, cwd: opts.cwd || '/home/user', entryCode: code, esModule: opts.esModule, bundleProfile: opts.bundleProfile, moduleScope: opts.moduleScope, node: opts.node };
      const diagSink: ExecDiagSink | undefined = diagOn
        ? { loadMs: 0, runMs: 0, moduleMapBytes: 0, bundleBytes: 0 }
        : undefined;
      // Stopped runs replay their input and output; uncaptured runs may replay as residents at listen.
      const inputChannel = opts.stdinPipe ? entry.pid : Number(opts.env?.NIMBUS_CP_CHILD_PID || 0);
      const stoppable = inputChannel > 0 || opts.stdinFile !== undefined;
      const promotable = !opts.captureOutput;
      let launch: ExecLaunchOpts = {
        ...opts,
        stopNonce: crypto.randomUUID(),
        ...(promotable ? { promote: true } : {}),
        ...(stoppable ? { outbound: true, codeDigest: { value: undefined } } : {}),
      };
      // A launch a broker let in before asking (a running program's child,
      // hosted/services.ts) gives that worker back for its preparation, and
      // takes it again for its run.
      let brokered = suspendLaunchAdmission(this.ctx, entry.pid);
      let vfsState: FacetVfsState;
      const prepare = (): Promise<PreparedOneShotCode> => withLaunchPreparation(this.ctx, { pid: entry.pid }, async () => {
        let resized = false;
        let rebuilt = false;
        for (;;) {
          try {
            return await this._prepareOneShotCode(code, launch, entry, vfsState, pacer, diagSink);
          } catch (error) {
            if (error instanceof OneShotAllocationNeeded) {
              if (resized) throw new Error('Nimbus: a regenerated one-shot map exceeded its measured supervisor credit');
              resized = true;
              if (!vfsState.cacheRetained) releaseGeneratedSources(vfsState);
              this._releaseBuildAdmission(entry.pid);
              const admission = await admitPrefetch(() => this._launchEnds(entry.pid), error.bytes, true, this._allocationOwner(entry.pid));
              this.buildAdmissions.set(entry.pid, admission);
              vfsState = await this._buildProcessBundle(entry, bundleSpec, pacer);
              continue;
            }
            if (!(error instanceof ModuleMapOverCeilingError) || rebuilt) throw error;
            rebuilt = true;
            vfsState = await this._rebuildUnderCeiling(entry, bundleSpec, vfsState, error, pacer);
          }
        }
      });
      const prepareAgain = async (): Promise<PreparedOneShotCode> => {
        this._launchStage(entry, 'prepare', abortController.signal);
        if (vfsState.generatedSourcesReleased) vfsState = await this._buildProcessBundle(entry, bundleSpec, pacer);
        else await this._holdMapShare(entry, vfsState);
        return prepare();
      };
      let prepared: PreparedOneShotCode;
      try {
        vfsState = await this._buildProcessBundle(entry, bundleSpec, pacer);
      } catch (err: unknown) {
        // Its failure ends the process here (below), not in the catch further down.
        prepareFailed = true;
        // The require closure that cannot fit the snapshot bound is the
        // process's own answer, not a build failure: exit 1 with a stderr
        // that names the entry, the staged bytes at the stop, the bound,
        // and the remedy — the same shape the got/next guards print.
        pacer.settle();
        stdinPump?.stop();
        foreground?.release();
        if (err instanceof ClosureBoundExceededError) {
          const o = err.outcome;
          const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
          const stderr =
            `require closure for ${o.entry} exceeds the snapshot bound: ` +
            `${mib(o.bytesSeen)} staged when ${o.lastPath} crossed the ` +
            `${mib(o.bound)} bound; the process was not started.\n` +
            `Run it as a server or split the entry; there is no flag to bypass.`;
          this._end(entry.pid, { code: 1, cause: stderr });
          return { exitCode: 1, stdout: '', stderr };
        }
        // A failed build is thrown to the caller exactly as before. What must
        // not be left behind is the process entry: it was spawned above and
        // would otherwise sit 'running' forever for a process that never
        // started. A build ended by a kill finds its entry already exited and
        // reports nothing twice.
        this._end(entry.pid, { code: 1, cause: `assembling the filesystem bundle for \`${command}\` failed: ${errorMessage(err)}` });
        throw err;
      }
      try {
        prepared = await prepare();
      } catch (error) {
        return await preparationFailed(error);
      }
      const admittedRun = async (run: () => Promise<FacetExecResult>): Promise<FacetExecResult> => {
        for (;;) {
          this._launchStage(entry, 'admission', abortController.signal);
          const parked = this._parkOneShotMap(entry.pid, prepared, abortController.signal);
          let brokeredGranted = false;
          try {
            if (brokered) {
              await brokered(parked.signal, parked.reclaimable);
              brokeredGranted = true;
              parked.unregister();
            }
            return await withLaunchAdmission(this.ctx, { pid: entry.pid }, parked.signal, () => {
              parked.unregister();
              parked.signal.throwIfAborted();
              return run();
            }, parked.reclaimable);
          } catch (error) {
            if (!parked.reclaimed || abortController.signal.aborted) throw error;
            if (brokeredGranted) brokered = suspendLaunchAdmission(this.ctx, entry.pid);
            try { prepared = await prepareAgain(); }
            catch (failure) { return preparationFailed(failure); }
          } finally {
            parked.unregister();
          }
        }
      };
      return await admittedRun(async () => {
        admitted = true;
        this._launchStage(entry, 'load', abortController.signal);
        // What it reports missing as it runs is filed against this bundle.
        if (vfsState.bundleKey) this.launchBundles.set(entry.pid, { key: vfsState.bundleKey, refused: new Set() });
        // Where the one-shot's listing of its namespace walks mounts: what its
        // launch names, the literal paths of its own code included.
        const cwd = opts.cwd || '/home/user';
        this.filesystem?.nameLaunch?.(entry, () => launchNames(cwd, opts.filename, opts.argv ?? [], vfsState.bundlePaths ?? [],
          [findStaticFsReferences(code, opts.filename?.startsWith('/') ? opts.filename : `${cwd}/[eval]`)]));
        const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
        // What its \`< file\` is as it starts: a promoted run reads it again.
        const stdinFileIdentity = promotable && opts.stdinFile ? await this._stdinFileIdentity(entry, opts.stdinFile.path) : undefined;
        const held = this.stdinReadAhead.open();
        // A run after a stop that strays is ended here, as a kill ends one, but
        // it is not a kill: the process fails, naming how it strayed.
        const divergence = new AbortController();
        if (stoppable || promotable) this.outputGates.set(entry.pid, new ReplayOutputGate());
        // A promoted run is run again from what it started from: what it
        // changes is kept, to be put back then (_promote).
        if (promotable) this.vfs?.captureRun(entry.pid);
        if (stoppable) {
          const { journal } = this.replay.open(entry.pid, () => {
            this.outputGates.get(entry.pid)?.close();
            divergence.abort();
          });
          if (opts.stdinFile) journal.bindStdinFile({ path: opts.stdinFile.path, offset: opts.stdinFile.offset, limit: STDIN_SYNC_READ_BYTES });
        }
        if (inputChannel > 0) this.stdinTaken.set(inputChannel, new StdinTaken(held, STDIN_SYNC_READ_BYTES));
        // Each run starts from the umask the process started with: a umask the
        // program set is its run's own.
        const startUmask = entry.cred.umask;
        const runSignal = AbortSignal.any([abortController.signal, divergence.signal]);
        let promoted = false;
        try {
          // A one-shot holds its module map and what it was seen to read (both in
          // the bundle), and plans no listing of the namespace (§2.8: the
          // principal's image is where that comes from). What its closure reads
          // synchronously by a path its code spells out needs no listing, and is
          // its data plan.
          let dataPlan = await this._staticReadPlan(entry, vfsState, cwd, opts.env?.HOME, pacer);
          // And every manifest it can see, from what the session read once per install.
          const manifests = await this._installedManifests(entry, pacer);
          let result: FacetExecResult;
          // What the session has of a captured run's output: the last stopped
          // run's, until a run after it gets past the read it stopped at (N8).
          let acceptedCapture: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
          const journal = this.replay.get(entry.pid)?.journal;
          for (let stops = 0; ; stops++) {
            let outcome: FacetExecResult | { stop: StopRecord };
            try {
              outcome = await this._execViaLoader(prepared, launch, entry, vfsState, dataPlan, manifests, runSignal, pacer, diagSink);
            } catch (error) {
              const changed = error instanceof ReplayCodeChanged;
              if (!changed && (!divergence.signal.aborted || abortController.signal.aborted)) throw error;
              outcome = { stop: { v: 3, kind: 'diverged', run: launch.replay?.run ?? 1, out: [], why: changed ? error.message : journal?.diverged ?? errorMessage(error) } };
            }
            if (!('stop' in outcome) && journal?.diverged) {
              outcome = { stop: { v: 3, kind: 'diverged', run: launch.replay?.run ?? 1, out: [], why: journal.diverged } };
            }
            if (!('stop' in outcome)) { result = outcome; break; }
            if (outcome.stop.kind === 'listen') {
              const promotion = await this._promote(entry, code, opts, outcome.stop, { inputChannel, held, signal: abortController.signal, stdinFile: stdinFileIdentity });
              promoted = promotion.promotedPid !== undefined;
              return promotion;
            }
            // The session decides whether the run may go again: what it did
            // outside itself is counted here, whatever the guest counted.
            const refused = outcome.stop.kind === 'stdin' && journal ? journal.unreplayable : null;
            if (outcome.stop.kind === 'stdin' && outcome.stop.captured) acceptedCapture = outcome.stop.captured;
            journal?.stopped();
            // runOneShot released the stopped Worker's nested hold. The child's
            // outer launch admission must go too: only the session waits on its
            // stdin now, and keeping that slot could prevent the parent starting
            // the child whose exit tells it to close this stdin.
            let resumeAdmission = suspendLaunchAdmission(this.ctx);
            // The stopped run's descriptors go with it: the next run opens its
            // own, numbered as the stopped run's were.
            await this.hooks.rewindProcessFiles?.(entry.pid);
            const resumed = await this._resumeStoppedRun(entry, outcome.stop, stops, inputChannel, launch, abortController.signal, held, { accepted: acceptedCapture, refused });
            if ('exit' in resumed) { result = resumed.exit; break; }
            // The stopped run's module map was released once it loaded, unless
            // the prefetch cache keeps it: the next run builds it again, a hit
            // when nothing it holds has changed since. Built, and its map's
            // share of the credit held, before it holds a worker again (the
            // lock order); its helpers wait as its process meanwhile.
            let refusedResume: FacetExecResult | undefined;
            for (;;) {
              prepared = await prepareAgain();
              dataPlan = await this._staticReadPlan(entry, vfsState, cwd, opts.env?.HOME, pacer);
              this._launchStage(entry, 'admission', abortController.signal);
              const parked = this._parkOneShotMap(entry.pid, prepared, abortController.signal);
              let granted = false;
              try {
                await resumeAdmission?.(parked.signal, parked.reclaimable);
                granted = true;
                parked.unregister();
                parked.signal.throwIfAborted();
                break;
              } catch (error) {
                if (parked.reclaimed && !abortController.signal.aborted) {
                  if (granted) resumeAdmission = suspendLaunchAdmission(this.ctx);
                  continue;
                }
                if (abortController.signal.aborted || !isDynamicWorkerDeadlock(error)) throw error;
                // This program already ran: a refusal to resume ends that process, never its spawn.
                const message = `node: could not resume after waiting for stdin (${error.code}): ${error.message}\n`;
                if (!launch.captureOutput) await this._deliverOutput(entry.pid, 'stderr', new TextEncoder().encode(message));
                refusedResume = { exitCode: 1, stdout: acceptedCapture.stdout, stderr: launch.captureOutput ? acceptedCapture.stderr + message : '' };
                break;
              } finally {
                parked.unregister();
              }
            }
            if (refusedResume) { result = refusedResume; break; }
            this.processes.setUmask(entry.pid, startUmask);
            launch = { ...launch, ...resumed.next, stopNonce: crypto.randomUUID() };
          }
          await this._recordLaunchLearning(vfsState.bundleKey, {
            code: result.runtimeCode, executedModules: result.moduleMisses, dataReads: result.residencyMisses,
          }).catch((error) => this._learningLost(entry.pid, error));
          if (result.exitCode !== 0 && this.processes.get(entry.pid)?.state === 'running') {
            this._w5RecordTermination(
              entry.pid, result.exitCode, 'runtime-worker',
              result.stderr || `exit ${result.exitCode}`,
            );
          }
          this._end(entry.pid, { code: result.exitCode });
          if (diagOn && diagSink) {
            recordExecTelemetry({
              command,
              bundleMs,
              loadMs: diagSink.loadMs,
              runMs: diagSink.runMs,
              drainPasses: result.diag?.drainPasses ?? 0,
              moduleMapBytes: diagSink.moduleMapBytes,
              bundleBytes: diagSink.bundleBytes,
              namespaceRefusals: result.diag?.namespaceRefusals ?? 0,
              rpcWrites: result.diag?.rpcWrites ?? 0,
              fsRpcReads: result.diag?.fsRpcReads ?? 0,
              esmAdoptions: result.diag?.esmAdoptions ?? 0,
              cacheHit: vfsState.cacheHit ?? false,
              ...execBreakdown(vfsState),
              turns: pacer.chunks,
              exitCode: result.exitCode,
              at: Date.now(),
            });
          }
          return result;
        } catch (error) {
          return await failed(error);
        } finally {
          pacer.settle();
          // A promoted process reads on, as the resident.
          if (!promoted) stdinPump?.stop();
          foreground?.release();
          if (inputChannel > 0) this.stdinTaken.get(inputChannel)?.release();
          this.stdinTaken.delete(inputChannel);
          held.give();
          this.outputGates.delete(entry.pid);
          if (stoppable) this.replay.close(entry.pid);
          this.vfs?.releaseRun(entry.pid);
        }
      });
    } catch (err: unknown) {
      if (admitted || prepareFailed) throw err;
      // Refused or killed while it waited for a worker, its bundle built.
      pacer.settle();
      stdinPump?.stop();
      foreground?.release();
      if (abortController.signal.aborted) {
        this._end(entry.pid, { code: 137, killed: true });
        return { exitCode: 130, stdout: '', stderr: '' };
      }
      if (isDynamicWorkerDeadlock(err) && !opts.skipSpawn) this._end(entry.pid, { code: 1 });
      throw err;
    } finally {
      this._launchEnded(entry.pid);
      opts.signal?.removeEventListener('abort', onShellAbort);
      this._releaseBuildAdmission(entry.pid);
    }
  }

  /**
   * `entry`'s launch is at `stage` from now, until its run is entered or it
   * is killed (`signal`). One that waits LAUNCH_STALL_MS at a stage logs one
   * line naming it, with the ledger's, the pacer's and the supervisor
   * budget's state, and no more after that.
   */
  private _launchStage(entry: ProcessEntry, stage: LaunchStage, signal: AbortSignal): void {
    if (signal.aborted) return;
    const prior = this.launching.get(entry.pid);
    if (prior?.stall) clearTimeout(prior.stall);
    const reported = prior !== undefined && prior.stall === null;
    const stall = reported ? null : setTimeout(() => {
      const launch = this.launching.get(entry.pid);
      if (!launch) return;
      launch.stall = null;
      const { inFlightWorkers, waiting, pauseMs } = loaderLedgerStats(this.ctx);
      console.warn(`[facet-manager] launch stalled: ${JSON.stringify({
        pid: entry.pid,
        command: launch.command.length > LAUNCH_STALL_COMMAND_CHARS ? `${launch.command.slice(0, LAUNCH_STALL_COMMAND_CHARS)}…` : launch.command,
        stage: launch.stage, ms: Date.now() - launch.since,
        ledger: { inFlight: inFlightWorkers.length, waiting, pauseMs }, pacer: this.launchPump.state(),
        budget: readSupervisorAllocationBudget(),
      })}`);
    }, LAUNCH_STALL_MS);
    this.launching.set(entry.pid, { stage, since: Date.now(), command: entry.command, stall });
  }

  /** `pid`'s launch is over: its run was entered, or it ended before it could be. */
  private _launchEnded(pid: number): void {
    const launch = this.launching.get(pid);
    if (launch?.stall) clearTimeout(launch.stall);
    this.launching.delete(pid);
  }

  /** Launches not yet running (their stage and its age) and the launches waiting for a turn. */
  launchState(now = Date.now()): { launches: Array<{ pid: number; stage: string; ms: number }>; pacer: { waiting: number; oldestMs: number | null } } {
    return {
      launches: [...this.launching].map(([pid, { stage, since }]) => ({ pid, stage, ms: now - since })),
      pacer: this.launchPump.state(now),
    };
  }

  /**
   * A one-shot that stopped at its first listen (stop-replay.ts listen) runs
   * on as a resident, the same process: the resident starts from what the
   * run started from (what the run changed put back, SqliteVFS.restoreRun),
   * replays the run's draws and output up to that listen, then listens and
   * serves. What the one-shot printed is shown once; the resident prints it
   * again only to be checked (the prefix).
   */
  /**
   * A file's identity as the process sees it: which file, and its version;
   * null when it has none to see (gone, or refused, synchronously or not).
   */
  private async _stdinFileIdentity(entry: ProcessEntry, path: string): Promise<string | null> {
    if (!this.filesystem) return null;
    try {
      const stat = await this.filesystem.bind({ pid: entry.pid, cred: entry.cred }).stat(path);
      return stat ? `${stat.ino}:${stat.revision}:${stat.size}:${stat.mtime}:${stat.ctime}` : null;
    } catch {
      return null;
    }
  }

  private async _promote(
    entry: ProcessEntry,
    code: string,
    opts: Parameters<FacetManager['exec']>[1],
    stop: StopRecord,
    /**
     * The run's input channel and read-ahead account, its abort (a kill,
     * Ctrl-C), and the identity its \`< file\` had when it started.
     */
    run: { inputChannel: number; held: ReadAheadAccount; signal: AbortSignal; stdinFile?: string | null },
  ): Promise<FacetExecResult> {
    const pid = entry.pid;
    // `killed`: its resident is running, and is stopped.
    const fail = async (message: string, killed = false): Promise<FacetExecResult> => {
      const text = `node: this program listens as a server, so Nimbus runs it again as one, but ${message}\n`;
      await this._deliverOutput(pid, 'stderr', new TextEncoder().encode(text));
      this._end(pid, { code: 1, cause: text.trimEnd(), killed });
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    // The gate stays while the resident boots: a late chunk of the stopped
    // run is dropped, the resident's are delivered (exec's finally ends it).
    const gate = this.outputGates.get(pid);
    const stopped = gate?.stopped(stop) ?? { fresh: [], prefix: null };
    for (const { stream, bytes } of stopped.fresh) await this._deliverOutput(pid, stream, bytes);
    if (stopped.prefix === null) {
      return fail(`it printed more than ${REPLAY_PREFIX_MAX_BYTES / 1048576} MiB before it listened, more than a second run is checked against.`);
    }
    // The stdin it took goes back in front of its channel, and the resident
    // takes at least as much before it replays the reads that took it.
    const taken = run.inputChannel > 0 ? this.stdinTaken.get(run.inputChannel) : undefined;
    taken?.retire();
    const before = taken ? taken.take() : { chunks: [], bytes: 0 };
    if (before === null) return fail(`it read more than ${Math.round(STDIN_SYNC_READ_BYTES / 1048576)} MiB of stdin before it listened, more than a second run is handed back.`);
    if (before.bytes > 0) {
      const channel = this._stdinChannel(run.inputChannel);
      if (channel === null) return fail('the stdin it read before it listened has no channel to be handed back on.');
      channel.unread(before.chunks.map((data) => ({ data, ended: false })));
      run.held.give(before.bytes);
    }
    // The stopped run's descriptors go with it: the resident opens its own.
    await this.hooks.rewindProcessFiles?.(pid);
    // Every long-running process has an input channel on its pid.
    this.processes.openInput(pid);
    // The resident starts from what the run started from: each file the run
    // changed is put back as the run found it, and the resident's changes are
    // its own. When they cannot all be put back, it starts from its start
    // over the files as they are, unretraced, as a server known to be one is
    // started (server-hints.ts): what it printed is printed again, and it
    // says why.
    // Its waves still being applied land first: none lands after.
    await openSupervisorDeliveries(this.ctx).retireWaveWriters(pid);
    const restored = this.vfs?.restoreRun(pid) ?? { refused: 'what it changed was not kept' };
    if ('refused' in restored) {
      await this._deliverOutput(pid, 'stderr', new TextEncoder().encode(
        `node: this program listens as a server, so Nimbus runs it again as one from its start, over the files as they are: ${restored.refused}. What it printed before it listened is printed again.\n`,
      ));
      // Its run from the start is the next run, unchecked: all it prints is
      // shown, and the stopped run's late chunks still are not.
      gate?.restart(stop.run + 1);
    }
    const resume: StoppedRunNext = {
      replay: {
        run: stop.run + 1,
        tape: stop.tape!,
        listen: true,
        prefix: { stdout: base64(stopped.prefix.stdout), stderr: base64(stopped.prefix.stderr) },
      },
      ...(before.bytes > 0 ? { stdinAtLeast: before.bytes } : {}),
      // A \`< file\` is read again from where the run read it: the same
      // bytes, unless the file changed since the run started (checked below).
      ...(opts.stdinFile ? { stdinFile: { ...opts.stdinFile, syncRead: true } } : {}),
    };
    // Its abort during the hand-off ends it: the resident's launch stops at
    // its next ownership gate.
    const abort = () => this._end(pid, { code: 137, killed: true });
    if (run.signal.aborted) abort();
    run.signal.addEventListener('abort', abort, { once: true });
    // Held until the resident is accepted as the process: through its boot
    // and the check of what it read.
    let changed = false;
    try {
      await this.spawnNode(code, {
        argv: opts.argv, env: opts.env, cwd: opts.cwd, filename: opts.filename, dirname: opts.dirname,
        esModule: opts.esModule, moduleScope: opts.moduleScope, preamble: opts.preamble,
        command: opts.command, invokerPid: opts.invokerPid, bundleProfile: opts.bundleProfile, node: opts.node,
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        skipSpawn: true, callerPid: pid,
        ...('refused' in restored
          ? { run: stop.run + 1, ...(run.inputChannel > 0 ? { stdinWriter: true } : {}), ...(opts.stdinFile ? { stdinFile: { ...opts.stdinFile, syncRead: true } } : {}) }
          : { resume }),
      });
      // Its \`< file\` changed between the run that read it and the resident
      // that read it again: they did not read the same input.
      changed = this.processExitCode(pid) === null && !('refused' in restored) && run.stdinFile !== undefined
        && await this._stdinFileIdentity(entry, opts.stdinFile!.path) !== run.stdinFile;
      run.signal.throwIfAborted();
    } finally {
      run.signal.removeEventListener('abort', abort);
    }
    // Ended while it booted: that is its exit, and it is no server.
    const ended = this.processExitCode(pid);
    if (ended !== null) return { exitCode: ended, stdout: '', stderr: '' };
    if (changed) {
      return fail(`its stdin, ${opts.stdinFile!.path}, changed while it was run again, so the two runs did not read the same input.`, true);
    }
    // Said as any resident's start is: it runs on, and serves.
    try { this.hooks.onSpawn?.(pid, entry.command, true); } catch {}
    // Its next launch starts as a server directly (server-hints.ts).
    if (opts.server) await this.learnedServers.learn(opts.server).catch((error) => this._learningLost(pid, error));
    return { exitCode: 0, stdout: '', stderr: '', promotedPid: pid };
  }

  /**
   * A process stopped at a synchronous read of stdin that needs input not
   * there yet (runtime/stop-replay.ts): deliver what its record carries of
   * its output, wait for the input the read needs (the end of stdin, or any of
   * it), hand the channel back what the run took and the input after it, and
   * say how to run it again; or how the process ends instead. What the run
   * took and what was shown are the session's own account (StdinTaken,
   * ReplayOutputGate), not the record's.
   */
  private async _resumeStoppedRun(
    entry: ProcessEntry,
    stop: StopRecord,
    stops: number,
    inputChannel: number,
    launch: Pick<ExecLaunchOpts, 'captureOutput' | 'stdinFile'>,
    signal: AbortSignal,
    held: ReadAheadAccount,
    // The captured output the session holds (the last stopped run's), and why
    // the session refuses to run it again, when it does.
    session: { accepted: { stdout: string; stderr: string }; refused: string | null } = { accepted: { stdout: '', stderr: '' }, refused: null },
  ): Promise<{ next: StoppedRunNext } | { exit: FacetExecResult }> {
    const pid = entry.pid;
    const taken = this.stdinTaken.get(inputChannel);
    taken?.retire();
    const gate = this.outputGates.get(pid);
    const stopped = gate?.stopped(stop) ?? { fresh: [], prefix: null };
    for (const { stream, bytes } of stopped.fresh) await this._deliverOutput(pid, stream, bytes);
    // Output a captured run printed before it stopped: the result of an exit
    // that does not run it again. A run that does run again prints it again.
    // A run that strayed before the read is not its own: what the session
    // holds is the run's before it (N8).
    const captured = !launch.captureOutput ? { stdout: '', stderr: '' }
      : stop.kind === 'stdin' && stop.captured ? stop.captured : session.accepted;
    const ends = (exitCode: number): { exit: FacetExecResult } => ({ exit: { exitCode, stdout: captured.stdout, stderr: captured.stderr } });
    const fail = async (message: string): Promise<{ exit: FacetExecResult }> => {
      const text = message.endsWith('\n') ? message : `${message}\n`;
      if (!launch.captureOutput) await this._deliverOutput(pid, 'stderr', new TextEncoder().encode(text));
      return { exit: { exitCode: 1, stdout: captured.stdout, stderr: launch.captureOutput ? captured.stderr + text : '' } };
    };
    if (stop.kind === 'diverged') {
      return fail(`node: this program did not retrace its run before when Nimbus ran it again to wait for stdin (${stop.why}), `
        + 'so it was ended; what it printed before its read of stdin had already been shown. A program whose path to such '
        + 'a read depends on more than its input, its clock, its random numbers and the files and responses it reads cannot '
        + 'be run again: read process.stdin instead.');
    }
    if (session.refused !== null) {
      return fail(`ERR_NIMBUS_SYNC_STDIN: fs.readFileSync(0) has to wait for stdin, which is still open. Nimbus waits by running `
        + `the program again from its start once the input is there, but this program ${session.refused}. Read process.stdin `
        + 'instead: it takes the input as it arrives.');
    }
    if (stops + 1 >= STOP_LIMIT) {
      return fail(`node: this program waited for stdin ${STOP_LIMIT} times through synchronous reads, each by running `
        + 'it again from its start; Nimbus runs a program at most that many times. Read process.stdin instead.');
    }
    if (!launch.captureOutput && stopped.prefix === null) {
      return fail(`node: this program printed more than ${REPLAY_PREFIX_MAX_BYTES / 1048576} MiB before a synchronous read of stdin `
        + 'that has to wait, more than a second run is checked against. Read process.stdin instead.');
    }
    const replay: ReplayLaunch = {
      run: stop.run + 1,
      tape: stop.tape!,
      stopAt: stop.stopAt!,
      prefix: stopped.prefix ? { stdout: base64(stopped.prefix.stdout), stderr: base64(stopped.prefix.stderr) } : null,
      observations: this.replay.get(pid)?.journal.observations,
    };
    // A \`< file\` the stopped run read synchronously but the launch had not
    // staged: the next run reads it ahead. Nothing is waited for.
    if (launch.stdinFile) return { next: { stdinFile: { ...launch.stdinFile, syncRead: true }, replay } };
    const channel = inputChannel > 0 ? this._stdinChannel(inputChannel) : null;
    if (channel === null) return fail('node: a synchronous read of stdin stopped a process that has no input channel');
    const before = taken ? taken.take() : { chunks: [], bytes: 0 };
    const full = `node: fs.readFileSync(0) waits for the end of stdin, and stdin passed ${Math.round(STDIN_SYNC_READ_BYTES / 1048576)} MiB `
      + '(the most a synchronous read holds, one budget across the session) without ending. Read process.stdin, '
      + 'which takes it as it arrives, or redirect a file (< file), which a synchronous read takes whole.';
    if (before === null) return fail(full);
    const input = await this._awaitStoppedInput(channel, stop.until === 'data' ? 'data' : 'end', signal, held, before.bytes);
    if ('aborted' in input) {
      this._end(pid, { code: 137, killed: true });
      return ends(130);
    }
    if ('signal' in input) return ends(input.signal === 'SIGINT' ? 130 : input.signal === 'SIGKILL' ? 137 : 143);
    if ('full' in input) return fail(full);
    // Back in front of the channel, in order: what the run took, then what
    // came after. The channel holds them now, not this account.
    const back: ProcessInputPacket[] = before.chunks.map((data) => ({ data, ended: false }));
    channel.unread(back.concat(input.packets));
    held.give(before.bytes + input.bytes);
    return { next: { replay, stdinWhole: input.ended, stdinAtLeast: before.bytes + input.bytes } };
  }

  /**
   * The input a stopped run's read waits for, taken off its channel: until
   * the channel ends (\`end\`), or until it holds any (\`data\`). Held against
   * the session's budget, at most STDIN_SYNC_READ_BYTES with what the run had
   * already taken, as owned pieces however small the writes were; of the
   * channel's control packets only the last resize is kept, and a terminating
   * signal, the shell's abort or a kill ends the wait.
   */
  private async _awaitStoppedInput(channel: StdinChannel, until: 'end' | 'data', signal: AbortSignal, held: ReadAheadAccount, already: number)
    : Promise<{ packets: ProcessInputPacket[]; bytes: number; ended: boolean } | { aborted: true } | { signal: string } | { full: true }> {
    const pieces = new OwnedPieces();
    let resize: ProcessInputPacket['resize'];
    let ended = false;
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const encoder = new TextEncoder();
    for (;;) {
      const packet = await Promise.race([channel.read(1000), aborted]);
      if (packet === 'aborted') { held.give(pieces.bytes); return { aborted: true }; }
      if (packet.signal === 'SIGINT' || packet.signal === 'SIGTERM' || packet.signal === 'SIGKILL') { held.give(pieces.bytes); return { signal: packet.signal }; }
      if (packet.resize) resize = packet.resize;
      const data = typeof packet.data === 'string' ? encoder.encode(packet.data) : packet.data;
      if (data.byteLength > 0) {
        const granted = already + pieces.bytes + data.byteLength > STDIN_SYNC_READ_BYTES ? 0 : held.take(data.byteLength);
        if (granted < data.byteLength) {
          held.give(granted + pieces.bytes);
          return { full: true };
        }
        pieces.add(data);
      }
      if (packet.ended) { ended = true; break; }
      if (until === 'data' && pieces.bytes > 0) break;
    }
    const packets: ProcessInputPacket[] = pieces.finish().map((data) => ({ data, ended: false }));
    if (resize) packets.push({ data: new Uint8Array(0), ended: false, resize });
    return { packets, bytes: pieces.bytes, ended };
  }

  /** `pid`'s stdin channel: the host's, else the session's input store when the pid has one. */
  private _stdinChannel(pid: number): StdinChannel | null {
    if (this.hooks.stdinChannel) return this.hooks.stdinChannel(pid);
    if (!this.processes.hasInput(pid)) return null;
    return {
      read: (waitMs) => this.processes.readInput(pid, waitMs),
      unread: (packets) => this.processes.unreadInput(pid, packets),
    };
  }

  /** A process's output, delivered as its own supervisor RPC delivers it. */
  private async _deliverOutput(pid: number, stream: 'stdout' | 'stderr', bytes: Uint8Array): Promise<void> {
    if (this.hooks.deliverOutput) await this.hooks.deliverOutput(pid, stream, bytes);
    else await this.processes.appendOutputBytes(pid, stream, bytes);
  }

  /**
   * A chunk a process printed, tagged with its run and its offset in what the
   * run printed: the part to deliver (runtime/stop-replay.ts). A process with
   * no gate cannot stop, and every chunk is delivered as it is.
   */
  gateOutput(pid: number, stream: 'stdout' | 'stderr', data: Uint8Array, at: number, run: number): Uint8Array {
    return this.outputGates.get(pid)?.take(stream, data, at, run) ?? data;
  }

  /**
   * The account of what the current run of a process that can stop takes
   * from stdin channel \`pid\` (cpReadStdin notes each packet it hands over,
   * and a read by a stopped run takes nothing); undefined for any other channel.
   */
  stdinTakenBy(pid: number): StdinTaken | undefined {
    return this.stdinTaken.get(pid);
  }

  /**
   * Feed a pipe to `pid`'s input channel as it arrives, a chunk at a time:
   * a full queue waits for the program to read, and the pipe's end ends the
   * channel. stop() leaves the rest of the pipe unread, so a program that
   * finished without reading all of it (`tail -f log | node -e ...`)
   * releases the pipe and its writer ends, as a closed reader ends it in a
   * shell.
   */
  private _pumpStdinPipe(pid: number, pipe: StdinBytes): { stop(): void } {
    return this.processes.pumpInput(pid, pipe);
  }

  /**
   * W5 Lever 5: push a DiagFailure into the OOM ring for every facet
   * termination with a non-zero exit code. This is the supervisor side
   * oom-stress probe asserts that every termination has a matching
   * ring entry.
   *
   * Classification: parse the reason/stderr for SQLITE_NOMEM, OOM,
   * clone-refused, rpc_timeout signatures (oom-classify.ts). Code 124
   * always maps to rpc_timeout regardless of message.
   */
  private _w5RecordTermination(
    pid: number,
    exitCode: number,
    phase: string,
    reason: string,
  ): void {
    try {
      let cause = classifyError(reason);
      if (exitCode === 124 && cause === 'unknown') cause = 'rpc_timeout';
      recordFailure({
        at: Date.now(),
        phase,
        cause,
        rssEstimateBytes: 0,
        heapUsedBytes: 0,
        lruBytes: 0,
        inFlightBytes: 0,
        lastRpcFrame: getLastRpcFrame(),
        lastFacetId: getLastFacetId(),
        exitCode,
        pid,
        message: reason,
      });
    } catch (e: any) {
      // Fail-soft: telemetry must never break the exit path.
      console.warn('[facet-manager/W5] recordFailure threw:', e?.message);
    }
  }

  // ── One-shot dynamic Worker entrypoint ────────────────────────────────

  private _ensureOneShotShare(pid: number, bytes: number): void {
    const need = Math.min(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, Math.max(1, Math.ceil(bytes)));
    const admission = this.buildAdmissions.get(pid);
    if (admission === undefined) throw new Error(`Nimbus: the module map for pid ${pid} has no share of the credit`);
    // What it lacks beside what it holds, or back to its build for the whole: it never waits holding its sources.
    if (!admission.grow(need)) throw new OneShotAllocationNeeded(need);
  }

  private async _oneShotMemberBytes(entry: ProcessEntry, images: readonly FacetWasmImport[], bindings: readonly string[]): Promise<{ owned: number; wire: number }> {
    let bytes = 0;
    const fs = this.filesystem?.bind({ pid: entry.pid, cred: entry.cred });
    for (const image of images) {
      try { bytes += (await fs?.stat(image.vfsPath))?.size ?? 0; } catch { /* an unreadable image is omitted */ }
    }
    let wire = bytes;
    if (bindings.length > 0) {
      // UTF-8 source is at most twice its wire bytes in V8; the parked map is measured exactly after decoding.
      bytes += NAPI_WASM_LOADER.bytes * 2 + NAPI_WASM_TRAMPOLINE.bytes;
      wire += NAPI_WASM_LOADER.bytes + NAPI_WASM_TRAMPOLINE.bytes;
      for (const name of bindings) {
        const size = stagedBinding(name).wasm.bytes;
        bytes += size;
        wire += size;
      }
    }
    return { owned: bytes, wire };
  }

  /**
   * `prepared`'s map, parked for its worker: `reclaimable` lets running work
   * reclaim it, and is called only if the launch has to wait for one. A
   * launch whose worker is free takes it and loads, and running work waits
   * for that load as it waits for any running work's credit.
   */
  private _parkOneShotMap(pid: number, prepared: PreparedOneShotCode, signal: AbortSignal): {
    readonly signal: AbortSignal; readonly reclaimed: boolean; reclaimable(): void; unregister(): void;
  } {
    const reclaimed = new AbortController();
    let unregister = () => {};
    return {
      signal: AbortSignal.any([signal, reclaimed.signal]),
      get reclaimed() { return reclaimed.signal.aborted; },
      reclaimable: () => {
        unregister = this.buildAdmissions.get(pid)?.reclaimable(() => {
          prepared.discard();
          this._releaseBuildAdmission(pid);
          reclaimed.abort(new Error(`Nimbus: the parked module map for pid ${pid} was reclaimed for running work`));
        }) ?? (() => {});
      },
      unregister: () => unregister(),
    };
  }

  /** Generate before waiting for a worker, keeping only the map's retained share until the load takes it. */
  private async _prepareOneShotCode(
    code: string,
    opts: ExecLaunchOpts,
    entry: ProcessEntry,
    vfsState: FacetVfsState,
    pacer: TurnBudget,
    diagSink?: ExecDiagSink,
  ): Promise<PreparedOneShotCode> {
    const usesSqlite = vfsState.usesNodeSqlite ?? bundleUsesNodeSqlite(code, vfsState.bundle);
    const wasmImports = facetWasmImports([], vfsState.wasmImages ?? []);
    const bindingNames = vfsState.stagedBindings ?? [];
    const memberBytes = wasmImports.length + bindingNames.length === 0 ? { owned: 0, wire: 0 }
      : await this._oneShotMemberBytes(entry, wasmImports, bindingNames);
    const [sqliteModules, sources] = await Promise.all([
      this.sqliteModuleEntry(usesSqlite),
      fetchNodeFacetSources(this.env),
    ]);
    const entryCode = await this._entryDynamicImports(code, opts.filename, opts.cwd || '/home/user', pacer);
    const generated = await this._generateUnderCeiling(
      entry.pid, vfsState, moduleMemberBytes(sqliteModules) + memberBytes.wire + ONE_SHOT_HOST_ENTRY_BYTES,
      (state) => generateEntrypointCode(entryCode, state, usesSqlite, sources, wasmImports, opts.filename, opts.cwd || DEFAULT_HOME, opts.esModule, opts.preamble, opts.node?.check === true),
      true,
    );
    const textBytes = generatedMapRetainedBytes(generated, {});
    this._ensureOneShotShare(entry.pid, prefetchNeed(vfsState.rawBytes ?? 0, memberBytes.owned, textBytes));
    const wasmModules = await this._wasmModulesByValue(entry, wasmImports);
    const stagedModules = await this._stagedBindingModulesByValue(bindingNames);
    const ownedMembers = { ...wasmModules, ...stagedModules };
    const members = { ...sqliteModules, ...ownedMembers };
    if (diagSink) {
      diagSink.moduleMapBytes = generated.source.byteLength;
      for (const text of [...Object.values(generated.modules), ...Object.values(generated.codeModules), ...Object.values(generated.esModules)]) {
        diagSink.moduleMapBytes += utf8Length(text);
      }
      for (const source of Object.values(generated.immutableModules)) diagSink.moduleMapBytes += source.byteLength;
      for (const member of [...Object.values(sqliteModules), ...Object.values(wasmModules)]) diagSink.moduleMapBytes += member.wasm.byteLength;
      diagSink.bundleBytes = utf8Length(vfsState.bundleSource?.expression ?? '');
      for (const text of [...Object.values(vfsState.bundleSource?.modules ?? {}), ...Object.values(vfsState.bundleSource?.codeModules ?? {})]) {
        diagSink.bundleBytes += utf8Length(text);
      }
    }
    const digest = opts.codeDigest ? answerDigest([generated.source.recipe(), generated.modules, generated.codeModules, generated.esModules,
      Object.fromEntries(Object.entries(generated.immutableModules).map(([name, source]) => [name, source.asset]))]) : undefined;
    const retained = textBytes + generatedMapRetainedBytes(null, ownedMembers);
    this._ensureOneShotShare(entry.pid, retained);
    if (!vfsState.cacheRetained) releaseGeneratedSources(vfsState);
    const admission = this.buildAdmissions.get(entry.pid);
    admission?.retain(retained);
    vfsState.oneShotMapBytes = retained;
    let map: { generated: GeneratedNodeFacetCode; members: typeof members } | undefined = { generated, members };
    return {
      digest,
      discard: () => { map = undefined; },
      code: async () => {
        if (map === undefined) throw new Error(`Nimbus: the module map for pid ${entry.pid} was already loaded`);
        const taken = map;
        map = undefined;
        this._releaseBuildAdmission(entry.pid);
        const codeModules: Record<string, { cjs: string } | { js: string }> = {};
        for (const [name, text] of Object.entries(taken.generated.codeModules)) codeModules[name] = { cjs: text };
        for (const [name, text] of Object.entries(taken.generated.esModules)) codeModules[name] = { js: text };
        for (const [name, source] of Object.entries(taken.generated.immutableModules)) codeModules[name] = { cjs: source.text };
        return {
          compatibilityDate: CF_COMPAT_DATE,
          compatibilityFlags: [...GUEST_COMPAT_FLAGS],
          mainModule: 'runner.js',
          modules: { 'runner.js': taken.generated.code, ...taken.generated.modules, ...codeModules, ...taken.members },
        };
      },
    };
  }

  private async _execViaLoader(
    prepared: PreparedOneShotCode,
    opts: ExecLaunchOpts,
    entry: ProcessEntry,
    vfsState: FacetVfsState,
    dataPlan: string[],
    /** _installedManifests' JSON. */
    manifests: string,
    signal: AbortSignal,
    pacer: TurnBudget,
    diagSink?: ExecDiagSink,
  ): Promise<FacetExecResult | { stop: StopRecord }> {
    const writerId = crypto.randomUUID();
    let writerActivated = false;
    let __loadStart = 0;
    let __runStart = 0;

    const fields = JSON.stringify({
      pid: entry.pid,
      argv: opts.argv || [],
      nodeCommandLine: opts.node ?? null,
      env: opts.env || {},
      cwd: opts.cwd || '/home/user',
      filename: opts.filename || '<eval>',
      dirname: opts.dirname || '/home/user',
      stdin: opts.stdin || '',
      // A pipe: the input channel it streams through (_pumpStdinPipe), whole
      // or not. A `< file`: the file fd 0 is.
      stdinPid: opts.stdinPipe ? entry.pid : 0,
      ...(opts.stdinWhole ? { stdinWhole: true } : {}),
      ...(opts.stdinFile ? { stdinFile: opts.stdinFile } : {}),
      // A run after a stop: what the stopped run drew, and what it printed,
      // and the stdin it is handed back.
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.stdinAtLeast ? { stdinAtLeast: opts.stdinAtLeast } : {}),
      // Only this run's stop counts (stop-replay.ts stopRecordOf).
      ...(opts.stopNonce ? { stopNonce: opts.stopNonce } : {}),
      ...(opts.promote ? { promote: true } : {}),
      // Its network goes through the session (runOnce's outbound below).
      ...(opts.outbound ? { outbound: true } : {}),
      captureOutput: !!opts.captureOutput,
      cred: { ...entry.cred, groups: [...entry.cred.groups] },
      vfsCursor: vfsState.cursor,
      dataPlan,
      ...(diagSink ? { diag: true } : {}),
    });
    // The manifests ride as the JSON they are kept as, not stringified again per run.
    const body = `${fields.slice(0, -1)},"manifests":${manifests}}`;
    try {
      return await this.processHost.runOnce(
        {
          pid: entry.pid,
          writerId,
          ...(opts.outbound ? { outbound: true } : {}),
          // The preparation drops its map as the loader takes it, not at the end of the run.
          code: async () => {
            // A run after a stop loads what the first run loaded, or nothing:
            // a module map rebuilt from files that changed while it waited
            // would answer it differently with nothing to show for it.
            if (opts.codeDigest) {
              if (opts.codeDigest.value === undefined) opts.codeDigest.value = prepared.digest;
              else if (opts.codeDigest.value !== prepared.digest) throw new ReplayCodeChanged();
            }
            if (diagSink) __loadStart = Date.now();
            return prepared.code();
          },
          request: new Request('http://nimbus-runtime.local/run', {
            method: 'POST',
            body,
            signal,
          }),
          onWriterActivated: (id) => {
            this._activateProcessVfsWriter(entry.pid, id);
            writerActivated = true;
          },
          onEntered: () => this._launchEnded(entry.pid),
          onLoaded: () => {
            pacer.settle();
            if (!diagSink) return;
            diagSink.loadMs = Date.now() - __loadStart;
            __runStart = Date.now();
          },
        },
        async (response) => {
          const result = await response.json() as FacetExecResult;
          if (diagSink) diagSink.runMs = Date.now() - __runStart;
          return result;
        },
      );
    } catch (error) {
      // The run stopped itself with ctx.abort, at a synchronous read of stdin
      // that has to wait (runtime/stop-replay.ts): its reason is the record.
      const stop = opts.stopNonce ? stopRecordOf(error, opts.stopNonce, opts.replay?.run ?? 1) : null;
      if (stop) {
        // Nothing the stopped run asks for afterwards is its to take.
        this.stdinTaken.get(entry.pid)?.retire();
        return { stop };
      }
      throw error;
    } finally {
      // A one-shot worker is unkeyed and cannot be re-resolved into a later
      // request's context, so it can never be a routeable target (server
      // scripts are promoted to the keyed long-running facet instead). But its
      // http shim still calls SUPERVISOR.registerPort on listen(); drop any
      // such reservation here so a dead facet leaves no stale null-stub port.
      this.portRegistry.unregisterByPid(entry.pid);
      if (writerActivated) this.revokeProcessVfsWriters(entry.pid, writerId);
    }
  }

  /**
   * Run a staged-artifact bundle (currently opencode) as an ESM mainModule.
   *
   * The bundle is ESM-only and imports node:sqlite, so it cannot use the
   * CommonJS module-cell path. It rides into the Worker Loader module map
   * as a real ESM module; the generated runner (mainModule) installs the
   * Bun-global polyfill, seeds process state, imports the bundle, and returns
   * buffered stdout/stderr/exit. node:sqlite is supplied as an override map
   * module so the static import links.
   */
  async execStagedArtifact(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; command?: string; attachedTty?: boolean; invokerPid?: number },
  ): Promise<StagedArtifactExecResult> {
    const mode: OpencodeRunnerMode = opts.attachedTty === true ? 'attached' : 'oneshot';
    const staged = await this._stageOpencodeFacet(artifact, opts, mode);

    if (mode === 'attached') return await this._startStagedResident(staged);

    // One-shot: a run like every other (runOneShot), whose ~23 MB module map
    // is assembled from its stage in a stateless isolate, never in this DO.
    const writerId = crypto.randomUUID();
    let writerActivated = false;
    try {
      const result = await this.processHost.runOnce({
        pid: staged.pid,
        writerId,
        code: async () => ({ stage: staged.stageSpec }),
        request: new Request('http://nimbus-runtime.local/run', { method: 'POST', body: JSON.stringify({ env: staged.env }) }),
        onWriterActivated: (id) => {
          this._activateProcessVfsWriter(staged.pid, id);
          writerActivated = true;
        },
      }, async (response) => await response.json() as FacetExecResult);
      this._end(staged.pid, { code: result.exitCode });
      return { ...result, pid: staged.pid };
    } catch (e) {
      this._end(staged.pid, { code: 1 });
      throw e;
    } finally {
      if (writerActivated) this.revokeProcessVfsWriters(staged.pid, writerId);
    }
  }

  /**
   * Prepare a staged-opencode spawn: spawn the process-table entry, snapshot
   * the VFS, and build the small OpencodeStageSpec. The artifact sources
   * (entry bundle, chunk pack, wasm sidecars — ~23 MB of module map) are NOT
   * materialized here: NimbusLoadedEntrypoint assembles them from the spec in
   * a stateless worker isolate on the Worker-Loader cache-miss path, so the
   * supervisor DO never carries them (it OOM-reset at the 128 MiB isolate cap
   * when it did — live-diagnosed 2026-07-16).
   */
  private async _stageOpencodeFacet(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; stdin?: string; command?: string; invokerPid?: number },
    mode: OpencodeRunnerMode,
  ): Promise<StagedOpencode> {
    if (artifact !== 'opencode') {
      throw new Error(`Nimbus: unknown staged artifact '${artifact}'`);
    }
    if (!this.env.ASSETS) {
      throw new Error(
        'staged opencode artifact requires an env.ASSETS binding; this Nimbus ' +
          'deployment is missing the static-assets binding',
      );
    }

    const command = opts.command || `opencode ${opts.argv.join(' ')}`.trim();
    const entry = this.processes.spawn(command, ['opencode', ...opts.argv], opts.cwd, { parentPid: opts.invokerPid });
    // A preparation that fails ends the process it spawned: no caller holds
    // its pid yet to end it, and it never started.
    try {
      return { pid: entry.pid, ...await this._stageOpencodeSpec(entry, opts, mode) };
    } catch (error) {
      this._end(entry.pid, { code: 1, cause: `staging \`${command}\` failed: ${errorMessage(error)}` });
      throw error;
    }
  }

  private async _stageOpencodeSpec(
    entry: ProcessEntry,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; stdin?: string },
    mode: OpencodeRunnerMode,
  ): Promise<Omit<StagedOpencode, 'pid'>> {
    const pid = entry.pid;
    const attached = mode === 'attached';
    // attached TUI + headless serve are resident long-running processes; only the
    // attached TUI grabs the terminal (raw-mode stdin + live geometry).
    if (mode !== 'oneshot') this.processes.setLongRunning(pid);
    if (attached) {
      this.processes.setAttachedTty(pid);
      this.processes.openInput(pid);
    }

    // attached: opencode's shim TTY (node-shims.ts) keys raw-mode stdin and
    // columns/rows off these vars as its module evaluates, exactly like the
    // long-running node path. They describe the terminal, so they ride in the
    // stage; the rest of the env goes with the start or the run (ask 62).
    const terminal: Record<string, string> = attached
      ? {
          NIMBUS_ATTACHED_TTY: '1',
          NIMBUS_CP_CHILD_PID: String(pid),
          TERM: opts.env.TERM || 'xterm-256color',
          COLORTERM: opts.env.COLORTERM || 'truecolor',
          COLUMNS: opts.env.COLUMNS || '80',
          LINES: opts.env.LINES || '24',
        }
      : {};
    const env = attached ? { ...opts.env, ...terminal, FORCE_COLOR: opts.env.FORCE_COLOR || '1' } : opts.env;

    // Snapshot the working tree so opencode's sync fs reads resolve, and a
    // directory manifest so readdir/stat are coherent: the files as they are,
    // since opencode runs its own code and only reads them (dataOnly).
    // opencode creates its home dirs (~/.local/share/opencode, …) via
    // fs.promises.mkdir; those and other writes flush live through the
    // SUPERVISOR RPC bridge.
    if (this.vfs) this.imageStore.ensureDir(entry.pid);
    const processVfs = this.filesystem ? this.filesystem.bind({ pid: entry.pid, cred: entry.cred }) : null;
    // Gathered and serialized under one admission (Kinu #29).
    const { vfsState, vfsBundle } = await withPrefetchAllocation(async (admission) => {
      const gathered: FacetVfsState = processVfs
        ? await gatherPrefetchBundle(processVfs, { cwd: opts.cwd, entryCode: '', dataOnly: true })
        : { bundle: {}, reachableCount: 0, truncated: false };
      admission.fit(gathered.rawBytes ?? 0);
      const serialized = _serializeBundleForFacet(gathered.bundle);
      assertStagedBundleFitsRpcPayload(serialized, gathered.bundle);
      return { vfsState: gathered, vfsBundle: serialized };
    }, () => this._launchEnds(entry.pid), undefined, this._allocationOwner(entry.pid));

    return {
      env,
      stageSpec: {
        mode,
        argv: opts.argv,
        terminal,
        cred: { ...entry.cred, groups: [...entry.cred.groups] },
        cwd: opts.cwd,
        stdin: opts.stdin ?? '',
        vfsBundle,
        vfsCursor: serializeFacetVfsCursor(vfsState.cursor),
      },
    };
  }

  /**
   * Run a headless `opencode serve` as a resident, routeable server facet. The
   * server binds a KNOWN loopback port (honouring an explicit --port/-p/env.PORT,
   * else an allocated free port injected into argv) so the in-session loopback
   * router and external `/port/<n>` both reach it. Returns immediately with the
   * pid once the facet is spawned + its route stub bound; readiness is gated by
   * the caller (dual path health-gates on `/doc`).
   */
  async execStagedArtifactServer(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; command?: string; port?: number; invokerPid?: number },
  ): Promise<StagedArtifactExecResult> {
    const explicit = parsePortFromArgv(opts.argv);
    const port = opts.port
      ?? resolveLongRunningPort({ argv: opts.argv, env: opts.env, fallback: this._allocateLoopbackPort() });
    // opencode's default `--port 0` binds an unroutable ephemeral port; when the
    // user gave no explicit port, inject the resolved one so the bind is known.
    const argv = explicit != null || opts.port != null
      ? opts.argv
      : [...opts.argv, '--port', String(port)];
    const staged = await this._stageOpencodeFacet(artifact, { ...opts, argv }, 'server');
    const result = await this._startStagedResident(staged, port);
    return { ...result, port };
  }

  /**
   * Bare `opencode` (the interactive TUI) as a MULTI-ISOLATE process pair: a
   * headless `opencode serve` facet + an `opencode attach <url>` attached-TTY
   * facet, each in its own 128 MiB isolate, joined by the session loopback port
   * registry. The serve facet is an OS-child of the attach facet: it is health-
   * gated before attach launches, and torn down when the attach TUI exits.
   * Returns the ATTACH pid — the user-facing foreground process.
   */
  async execStagedArtifactDual(
    artifact: string,
    opts: { argv: string[]; env: Record<string, string>; cwd: string; command?: string; invokerPid?: number; plan?: OpenCodeTransportPlan },
  ): Promise<StagedArtifactExecResult> {
    const planned = opts.plan ?? buildOpenCodeTransportPlan(opts.argv, opts.cwd, opts.env);
    if ('error' in planned) throw new Error(planned.error);
    const port = planned.port || this._allocateLoopbackPort();
    // (a) resident serve facet on the allocated loopback port.
    const serveStaged = await this._stageOpencodeFacet(
      artifact,
      {
        argv: [...planned.serveArgv, '--port', String(port)],
        env: opts.env,
        cwd: planned.cwd,
        command: `opencode serve --port ${port}`,
        invokerPid: opts.invokerPid,
      },
      'server',
    );
    const servePid = serveStaged.pid;
    try {
      await this._startStagedResident(serveStaged, port);
      // (b) health-gate: wait for the server to answer /doc through the loopback
      // router (fail loud with the server's log tail on timeout / early exit).
      await this._awaitOpencodeServerReady(servePid, port);
    } catch (e) {
      try { this.kill(servePid); } catch {}
      throw e;
    }

    // (c) attach the interactive TUI to the ready server on the user's terminal.
    let attach: StagedArtifactExecResult;
    try {
      attach = await this.execStagedArtifact(artifact, {
        argv: ['attach', `http://127.0.0.1:${port}`, '--dir', planned.cwd, ...planned.attachArgv],
        env: opts.env,
        cwd: planned.cwd,
        stdin: '',
        command: opts.command || 'opencode',
        attachedTty: true,
        // The pair's exec id, from the serve: the command that ran `opencode`
        // may have ended while the serve booted, and been reaped since.
        invokerPid: servePid,
      });
    } catch (e) {
      try { this.kill(servePid); } catch {}
      throw e;
    }

    // Tie their lifecycles: when the attach TUI exits (reported / killed), tear
    // down the serve facet too.
    this._pairedServeFacet.set(attach.pid, servePid);
    return attach;
  }

  /**
   * A staged opencode resident: the attached TUI, or with `port` a headless
   * serve routed on it. Its runner holds startProcess open for the process's
   * whole life, so that one call is the lifecycle; it reports its own exit.
   * The module map is assembled on the Worker-Loader cache-miss path, so the
   * artifact sources exist only while this facet is loading.
   */
  private async _startStagedResident(
    staged: StagedOpencode,
    port?: number,
  ): Promise<StagedArtifactExecResult> {
    const { pid, stageSpec, env } = staged;
    const what = port === undefined ? 'opencode TUI' : 'opencode serve';
    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;
    try {
      handle = await this.processFabric.startResidentProcess({
        startContract: 'lifetime',
        journaled: true,
        pid,
        workerKey: `nimbus-process:${this.ctx.id.toString()}:${pid}`,
        boot: { kind: 'staged', stage: stageSpec },
        startArgs: { env },
        onWriterActivated: (writerId) => {
          this._activateProcessVfsWriter(pid, writerId);
        },
        onWriterRetired: (writerId) => {
          this.revokeProcessVfsWriters(pid, writerId);
        },
      });
      this._watchHost(pid, handle, false);
      // Bound before the port is announced, so the shim's
      // listen()→SUPERVISOR.registerPort back-fills it. The opencode runner
      // dispatches through node-shims' __nimbusServeHttp, which strips the ACQUIRE.
      if (port !== undefined) this.portRegistry.bindFacetStub(pid, handle.routeTarget, { deliversAcquire: true });
      this.trackProcessRpcResources(pid, [handle], { releaseOnReportExit: false });
      resourcesTracked = true;
      this._watchLifetime(pid, handle, `${what} process`);
      if (port !== undefined) {
        await clearPortCapability({ ctx: this.ctx, portRegistry: this.portRegistry }, port);
        this.portRegistry.register(port, pid);
      }
      return { pid, exitCode: 0, stdout: '', stderr: '' };
    } catch (e) {
      if (!resourcesTracked) handle?.kill();
      this._end(pid, { code: 1, cause: `${what} launch failed: ${errorMessage(e)}` });
      throw e;
    }
  }

  /**
   * NIMBUS_DEBUG live evidence (log-tail channel) of where a resident process
   * was scheduled. The manager logs an opaque description; only the fabric
   * knows what a placement is.
   */
  /**
   * A resident process's handle, as it comes back from the fabric: a host
   * the platform resets under it ends the process (_endByHostLoss). Watched
   * before any caller's own `done` handler, so the process has ended by name
   * when they look. The placement goes to the process log under NIMBUS_DEBUG.
   */
  /**
   * The one watcher of a hosted process's lifecycle: a lost host ends it
   * (ProcessHostLost), and `diesAlone`, a booted resident that logs its
   * changes, dying on its own (out of memory, out of CPU) ends it too, its
   * log drained as it is released and only then its exit told. A boot that
   * fails or stops (to wait for stdin) is its launcher's to handle; a
   * lifetime resident's caller watches its lifecycle itself.
   */
  private _watchHost(pid: number, handle: ResidentProcessHandle, diesAlone: boolean, controlFailure?: (error: unknown) => boolean): void {
    handle.done.catch((error: unknown) => {
      if (controlFailure?.(error)) return;
      if (error instanceof ProcessHostLost) { this._endByHostLoss(pid, error); return; }
      if (diesAlone) void handle.booted().then(() => this._residentDied(pid, error), () => {});
    });
    if (!this.debugEnabled) return;
    try {
      this.processes.appendOutput(pid, 'stderr', `[nimbus-debug] process hosted on ${handle.describePlacement()}\n`);
    } catch { /* best-effort */ }
  }

  /**
   * The reader the fabric completes process `pid`'s boot spec's by-path
   * members with.
   *
   * A member the spec names by path (a project's `.wasm`, a runtime's image)
   * is read as the process, as a peer host's reader already does (its no-run
   * binding acts for the pid), so the boot reads only what the process may;
   * a write it meets that has not published yet (the kernel's own, held while
   * a running process's read lease is recalled, or a parent's delegation) is
   * waited for, as the peer's read waits. The images this manager generated
   * for it (`_imageBlobs`) are read as the kernel that wrote them, which sees
   * its own store writes before they publish, and each is verified against
   * the digest its path names. Uncached because these are the session's
   * largest files — a ruby interpreter image is 34.3 MiB — and pinning one
   * in the VFS content LRU for the life of the session is what once crashed
   * the supervisor.
   */
  private _residentDisk(pid: number): ResidentDiskReader {
    const vfs = this.vfs;
    if (!vfs) {
      throw new Error('Nimbus: a resident process needs a session filesystem to boot');
    }
    const fs = vfs.as(this.processes.cred(pid));
    const kernel = vfs.as(CRED_KERNEL);
    return {
      readFile: (path) => withRecall(() => fs.readFileUncached(path)),
      // A durable worker an earlier release made may name one below /var,
      // which a process may hold: that read waits for it, as readFile's does.
      readImage: (path) => withRecall(() => kernel.readFileUncached(path)),
    };
  }

  /**
   * Fail a paced launch whose process went away while it was suspended.
   *
   * Between turns anything may happen to the process — a kill, a reap, an
   * image sweep that has already unrooted its images. Continuing would
   * spend further turns building a facet for a pid nothing will ever attach
   * to, and would write image files the next sweep immediately collects.
   */
  private _assertLaunchStillOwned(pid: number): void {
    if (this.processes.get(pid)?.state === 'running') return;
    throw new Error(`Nimbus: the launch for pid ${pid} was cancelled while it was suspended`);
  }

  /**
   * What `pid`'s launch waits for room under (admitPrefetch), holding no
   * worker (the lock order: credit, or a build joined, before a worker):
   * aborted once its process ends, so a launch killed or destroyed while it
   * queued is never admitted after its end; and told to the ledger as a
   * wait on the credit's holders (waitOutsideLedger), so a cycle through a
   * running program waiting on its child is refused as a cycle of workers is.
   */
  private _launchEnds(pid: number): { signal: AbortSignal; dispose(): void } {
    this._assertLaunchStillOwned(pid);
    const ended = new AbortController();
    const unsubscribe = this.processes.subscribeTerminal(pid, () => {
      ended.abort(new Error(`Nimbus: the launch for pid ${pid} was cancelled while it waited for room`));
    });
    const outside = waitOutsideLedger(this.ctx, pid, () => this._creditHolders());
    return { signal: ended.signal, dispose: () => { outside(); unsubscribe(); } };
  }

  /** The launches holding the supervisor's credit, or null where some of it is held by other work (another session's, a write wave). */
  private _creditHolders(): readonly number[] | null {
    let own = 0;
    for (const admission of this.buildAdmissions.values()) own += admission.held();
    return readSupervisorAllocationBudget().current > own ? null : [...this.buildAdmissions.keys()];
  }

  private _allocationOwner(pid: number): SupervisorAllocationOwner {
    return { owner: 'launch bundle/map', pid, session: this.ctx?.id?.toString(), attribution: 'prefetchBundleBytes' };
  }

  /**
   * A launch's share of the credit for the module map it makes from `state`
   * (another launch's build, the cache's), taken before it holds a worker:
   * the share it holds already (its build's, kept for a rebuild) is it. A
   * copy of what is staged: the VFS cache is not shrunk for it.
   */
  private _holdMapShare(entry: ProcessEntry, state: FacetVfsState): FacetVfsState | Promise<FacetVfsState> {
    if (this.buildAdmissions.has(entry.pid)) return state;
    const need = Math.min(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
      Math.max(prefetchNeed(state.rawBytes ?? 0), state.oneShotMapBytes ?? 0));
    const now = tryAdmitPrefetch(need, true, this._allocationOwner(entry.pid));
    if (now !== null) {
      this.buildAdmissions.set(entry.pid, now);
      return state;
    }
    return admitPrefetch(() => this._launchEnds(entry.pid), need, true, this._allocationOwner(entry.pid)).then((admission) => {
      this.buildAdmissions.set(entry.pid, admission);
      return state;
    });
  }

  /**
   * The one way this manager boots a resident process. Every resident process
   * is a facet of this session; there is nothing to place and nothing here
   * decides anything about where a program runs.
   */
  private async _startResidentProcess(
    pid: number,
    spec: {
      startContract: StartContract;
      boot: ResidentBootSpec;
      startArgs?: unknown;
      facet?: { name: string; durable: boolean };
      storageBytes?: number;
      /** A Nimbus runtime's process: it logs its changes in its facet's store (ResidentProcessSpawn.journaled). */
      journaled?: boolean;
      /** A boot after a stop (runtime/stop-replay.ts): its own isolate. */
      run?: number;
      controlFailure?: (error: unknown) => boolean;
    },
  ): Promise<ResidentProcessHandle> {
    const { run, controlFailure, ...process } = spec;
    const handle = await this.processFabric.startResidentProcess({
      pid,
      workerKey: `nimbus-process:${this.ctx.id.toString()}:${pid}${run !== undefined && run > 1 ? `:run${run}` : ''}`,
      onWriterActivated: (writerId) => {
        this._activateProcessVfsWriter(pid, writerId);
      },
      onWriterRetired: (writerId) => {
        this.revokeProcessVfsWriters(pid, writerId);
      },
      ...process,
    });
    this._watchHost(pid, handle, spec.startContract === 'boot' && spec.journaled === true, controlFailure);
    return handle;
  }

  /**
   * A stop that ends process `pid` (one `resumed`, a promoted server's run
   * again), unless it has ended: it exits 1, why on its stderr.
   */
  private async _endByStop(pid: number, stop: StopRecord, resumed: boolean): Promise<void> {
    if (this.processes.get(pid)?.state !== 'running') return;
    const message = stop.kind === 'diverged'
      ? (resumed
        ? 'node: this program listens as a server, so Nimbus ran it again as one, and it did not retrace '
          + `its run before up to its listen (${stop.why}), so it was ended.`
        : `node: Nimbus ran this program again, and it did not retrace its run before (${stop.why}), so it was ended.`)
      : `node: this program stopped (${stop.kind === 'stdin' ? 'at a synchronous read of stdin' : `at its ${stop.kind}`}) `
        + 'after it had started, where Nimbus cannot run it again, so it was ended.';
    try {
      await this._deliverOutput(pid, 'stderr', new TextEncoder().encode(`${message}\n`));
    } catch {
      // Its stderr refused it (a parent that closed the reader): its own log keeps why.
      this.processes.appendOutput(pid, 'stderr', `${message}\n`);
    } finally {
      this._end(pid, { code: 1, cause: message });
    }
  }

  /** A booted resident died without anyone ending it: it exits 1, its reason on its stderr. */
  private _residentDied(pid: number, error: unknown): void {
    if (this.processes.get(pid)?.state !== 'running') return;
    const reason = `resident process died: ${errorMessage(error)}`;
    this.processes.appendOutput(pid, 'stderr', `[nimbus] ${reason}\n`);
    this._end(pid, { code: 1, cause: reason });
  }

  private _activateProcessVfsWriter(pid: number, writerId: string): void {
    // The run this writer is reads the process's stdin, and no run before it,
    // and is the one its supervisor calls are answered for.
    this.stdinTaken.get(pid)?.start(writerId);
    this.replay.get(pid)?.journal.start(writerId);
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') {
      throw new Error(`Nimbus: cannot activate append writer for non-running process ${pid}`);
    }
    const journal = this.replay.get(pid)?.journal;
    if (journal) openSupervisorDeliveries(this.ctx).startReadRun(pid, writerId, {
      maxEntries: REPLAY_JOURNAL_MAX_ENTRIES,
      maxBytes: REPLAY_READ_RECEIPT_MAX_BYTES,
      recording: () => journal.recording,
      disqualify: (why) => journal.disqualify(why + ` (REPLAY_JOURNAL_MAX_ENTRIES=${REPLAY_JOURNAL_MAX_ENTRIES}; REPLAY_READ_RECEIPT_MAX_BYTES=${REPLAY_READ_RECEIPT_MAX_BYTES})`),
    });
  }

  /**
   * Grant every suspended launch a chunk of this turn — the session's alarm
   * calls this, and journal recovery rides the first pump. See fabric's
   * `PacedWork.pump` for the ownership argument.
   */
  pumpResidentLaunches(): Promise<void> {
    return this.launchPump.pump();
  }

  private trackLaunchTask(task: Promise<void>): Promise<void> {
    this.launchTasks.add(task);
    void task.then(() => this.launchTasks.delete(task), () => this.launchTasks.delete(task));
    return task;
  }

  async closeLaunches(): Promise<void> {
    this.launchesClosed = true;
    this.launchPump.close();
    while (this.launchTasks.size > 0) await Promise.allSettled([...this.launchTasks]);
    await Promise.all(this.rowAmendments.values());
    await this.processHost.close?.();
  }

  /** Allocate a free loopback port for a resident server facet (from 4096 up). */
  private _allocateLoopbackPort(): number {
    for (let port = 4096; port < 4096 + 4096; port++) {
      if (!this.portRegistry.has(port)) return port;
    }
    return 4096;
  }

  /**
   * Poll `http://127.0.0.1:<port>/doc` through the loopback port router until it
   * answers 200, bounded by `timeoutMs`. Fails loud (with the server's log tail
   * and the last poll outcome) if the serve facet exits early or never becomes
   * ready. Each poll is individually capped at `pollTimeoutMs` so a request
   * wedged in the booting facet cannot starve the loop; the 30s default budget
   * covers the live-measured ~14s cold boot-to-serving time with margin.
   */
  private async _awaitOpencodeServerReady(
    pid: number,
    port: number,
    timeoutMs = 30000,
    pollTimeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastPoll = 'no poll completed';
    while (Date.now() < deadline) {
      const proc = this.processes.get(pid);
      if (!proc || proc.state !== 'running') {
        throw new Error(
          `opencode serve (pid ${pid}) exited before becoming ready on port ${port}\n` +
            this._processLogTail(pid),
        );
      }
      if (this.portRegistry.has(port)) {
        // Cap each poll at pollTimeoutMs and abandon it on overrun: a request
        // that reaches the facet mid-boot can hang until the dispatcher's 30s
        // header timeout (live-measured 2026-07-16), and awaiting it unbounded
        // starves the loop — one wedged poll must not consume the readiness
        // budget while the server comes up behind it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pollPromise = this.portRegistry
          .routeRequest(port, new Request(`http://127.0.0.1:${port}/doc`), '/doc')
          .catch((e: unknown) => { lastPoll = 'error: ' + errorMessage(e); return null; });
        const res = await Promise.race([
          pollPromise,
          new Promise<null>((r) => { timer = setTimeout(() => r(null), pollTimeoutMs); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        // The gate only needs the status; cancel the (streamed) body so the
        // relay pipe and its facet-side resources release — including polls
        // this race abandoned that resolve later.
        const discardBody = (r: Response | null) => { if (r) r.body?.cancel().catch(() => {}); };
        if (res) {
          discardBody(res);
          if (res.status === 200) {
            await this._warmOpencodeServer(port);
            return;
          }
          lastPoll = `status ${res.status}`;
        } else {
          void pollPromise.then(discardBody);
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `opencode serve (pid ${pid}) did not become ready on port ${port} within ` +
        `${timeoutMs}ms (last poll: ${lastPoll})\n${this._processLogTail(pid)}`,
    );
  }

  /**
   * Warm the serve facet's cold once-flight services before the attach TUI
   * fires its startup barrage. The TUI issues its five startup requests
   * concurrently; a COLD provider/agent init under that concurrency deadlocks
   * on its once-flight lock (facet timers only advance across I/O), and the
   * requests die at the dispatcher's 30s header timeout ("3 of 5 requests
   * failed"). A single sequential request per service completes the init
   * reliably (live-measured), so readiness for a TUI includes it. A warmup
   * failure is not fatal here — the TUI surfaces its own precise startup
   * error — but each leg is bounded so a wedged warmup cannot eat the boot.
   */
  private async _warmOpencodeServer(port: number, perRequestTimeoutMs = 25000): Promise<void> {
    for (const path of ['/config/providers', '/agent']) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // ONE deadline bounds the whole leg — headers AND body drain. An
        // unbounded drain here wedged the dual spawn when a cold providers
        // body finished slowly.
        const responseRef: { current: Response | null } = { current: null };
        const leg = this.portRegistry
          .routeRequest(port, new Request(`http://127.0.0.1:${port}${path}`), path)
          .then(async (r) => {
            responseRef.current = r;
            if (r) await r.text();
          })
          .catch(() => {});
        await Promise.race([
          leg,
          new Promise<void>((r) => { timer = setTimeout(() => r(), perRequestTimeoutMs); }),
        ]);
        responseRef.current?.body?.cancel().catch(() => {});
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  /** Recent stderr/stdout tail for a pid, for fail-loud diagnostics. */
  private _processLogTail(pid: number, lines = 40): string {
    try {
      const chunks = this.processes.tailLogs(pid, { lines });
      const text = chunks.map((c) => c.data).join('');
      return text ? `--- ${chunks.length ? 'log tail' : ''} ---\n${text}` : '(no output captured)';
    } catch {
      return '(no output captured)';
    }
  }

  /**
   * Re-drive a journalled launch after an instance reset. What the journal
   * row carries is the recipe, and who the launch ran as (its credential and
   * exec id); never its environment, which the host gives again
   * (`hooks.resolveProcessEnv`), and a worker launch's bindings are
   * re-resolved by the embedder through `hooks.resolveWorkerLaunch`.
   */
  private async _redrive(record: ResidentLaunchRecord, attempt: number, cause: RedriveCause): Promise<unknown> {
    const { recipe } = record;
    if (record.cred === undefined) {
      // Reported through onRedriveFailed, and the row is superseded.
      throw new Error('its journal entry predates the credential a re-drive runs under, so it is not started as anyone else');
    }
    const identity: LaunchIdentity = {
      cred: record.cred,
      ...(record.execId === undefined ? {} : { execId: record.execId }),
      restart: {
        from: cause.kind === 'exited'
          ? { pid: record.pid, cause: 'exited', exitCode: cause.code }
          : { pid: record.pid, cause: cause.kind },
        doing: residentLaunchDoing(record),
      },
    };
    const key = `${FENCED_WORK_KEY_PREFIX}${record.pid}`;
    switch (recipe.kind) {
      case 'node': {
        const env = await relaunchEnv(this.hooks.resolveProcessEnv, relaunchRequest(key, record.pid, identity));
        return this._spawnResident(recipe.code, { ...recipe.opts, env: withRestartPolicy(env, record.restart) }, attempt, identity);
      }
      case 'worker': {
        // Which resolver a worker recipe re-drives through is decided by
        // `recipe.resident`, and it is not a flag: it is the interpreter
        // image (`{ runtime, argv }`) of a python/ruby socket server the
        // SESSION launched for itself. Only those recipes take the
        // image-store fallback, because the session persisted that image and
        // no embedder was ever asked about the launch. Every other worker
        // recipe — an embedder's `spawnWorker`, durable or not — re-drives
        // through the embedder's `resolveWorkerLaunch`, and falls back to the
        // image store only when no embedder hook is composed at all.
        const resolve = recipe.resident
          ? this.hooks.resolveWorkerLaunchFallback
          : this.hooks.resolveWorkerLaunch ?? this.hooks.resolveWorkerLaunchFallback;
        if (!resolve) throw new Error('resident launch journal holds a worker launch but no resolveWorkerLaunch hook is composed');
        const resolved = await resolve(recipe);
        if (resolved === null) return undefined;
        const mainModule = resolved.mainModule ?? recipe.mainModule ?? DEFAULT_WORKER_MAIN_MODULE;
        const { [mainModule]: workerCode, ...modules } = resolved.modules;
        if (typeof workerCode !== 'string') throw new Error(`resolved worker launch carries no ${mainModule} main module source`);
        // An interpreter resident's environment is built again on the host's
        // answer, as its first launch built it (no `image`: the spawn
        // persists one).
        let startArgs = resolved.startArgs ?? recipe.startArgs;
        let interpreterEnv: InterpreterLaunchEnv | undefined;
        if (recipe.resident) {
          ({ startArgs, interpreterEnv } = relaunchInterpreter(startArgs, await relaunchEnv(this.hooks.resolveProcessEnv, relaunchRequest(key, record.pid, identity))));
        }
        return this._spawnWorker(workerCode, record.command, recipe.cwd, {
          port: recipe.resident ? record.port : recipe.port > 0 ? recipe.port : undefined, modules, compatibilityDate: recipe.compatibilityDate,
          compatibilityFlags: recipe.compatibilityFlags, startArgs,
          ...(interpreterEnv !== undefined ? { interpreterEnv } : {}),
          resident: recipe.resident, restart: record.restart,
          env: resolved.env ?? undefined, globalOutbound: resolved.globalOutbound,
          vfsWasmModules: resolved.vfsWasmModules,
          vfsTextModules: resolved.vfsTextModules,
          mainModule,
          durable: { owner: residentOwner(record) ?? recipe.owner, ...(recipe.resident ? {} : { image: recipe.image }) },
        }, attempt, identity);
      }
    }
  }

  /**
   * The process-table entry of a resident launch: a child of its invoker,
   * under its credential, as exec's. A re-drive has no invoker (the journal
   * never holds one): it runs as the row says, records the process it
   * restarts and why, and says so as its first line of output. The terminal
   * a session's restart disconnected is not where the user looks for it.
   * A restored launch runs as its identity says, and restarts nothing.
   */
  private _spawnLaunchEntry(
    command: string,
    argv: string[],
    cwd: string,
    invokerPid: number | undefined,
    who: LaunchIdentity | undefined,
  ): ProcessEntry {
    if (who === undefined) return this.processes.spawn(command, argv, cwd, { parentPid: invokerPid });
    const { cred, execId, restart } = who;
    const entry = this.processes.spawn(command, argv, cwd, { cred, execId, ...(restart === undefined ? {} : { restartedFrom: restart.from }) });
    if (restart === undefined) return entry;
    const why = restart.from.cause === 'exited'
      ? `"${command}" exited with code ${restart.from.exitCode}, so it was restarted (restart on-failure)`
      : restart.from.cause === 'host-reset'
        ? `the platform reset the host of "${command}", so it was restarted (restart on-failure)`
        : `the session restarted while "${command}" was ${restart.doing}, so this process restarted`;
    this.processes.appendOutput(entry.pid, 'stderr', `[nimbus: ${why}; it was pid ${restart.from.pid}]\n`);
    return entry;
  }

  /**
   * Spawn a long-running Node process with the same shimmed require/fs/http
   * environment used by foreground `node <script>` execution.
   *
   * A resident primitive: the process outlives the call, may bind a port, and
   * accumulates memory for as long as it runs.
   *
   * Its module map — the snapshot of the user's disk the facet is built from —
   * is the largest thing Nimbus generates, so it travels by VFS path rather
   * than inside the boot spec and is read only when the facet loads.
   */
  spawnNode(code: string, opts: ResidentSpawnOptions = {}): Promise<{ pid: number }> {
    return this._spawnResident(code, opts, 0);
  }

  /**
   * `attempt` distinguishes the launch the user asked for from the one re-drive
   * an instance reset earns it, and is carried in the journal rather than in
   * the caller's options because no caller has an opinion about it. So is a
   * re-drive's credential and exec id, from the row: the process that invoked
   * the launch went with the instance.
   */
  private async _spawnResident(
    code: string,
    opts: ResidentSpawnOptions,
    attempt: number,
    redriven?: LaunchIdentity,
  ): Promise<{ pid: number }> {
    await this.processes.reap();
    const command = opts.command || (opts.filename ? `node ${opts.filename}` : 'node <script>');
    const cwd = opts.cwd || '/home/user';
    if (!this.processHost.imageDelivery.storageSharedWithSession) {
      const argv = launchArgv({ execArgv: opts.node?.execArgv, argv: opts.argv });
      const derived = await deriveResidentOwner(cwd, argv);
      const declared = opts.port === undefined ? null : await readPortReservation(this.ctx, opts.port);
      const owner = declared?.kind === 'explicit' && declared.owner !== null ? declared.owner : derived;
      if (await readPortReservationByOwner(this.ctx, owner)) this.processHost.assertDurableStorage();
    }
    let entry: ProcessEntry;
    if (opts.skipSpawn && opts.callerPid != null) {
      const found = this.processes.get(opts.callerPid);
      if (!found) {
        throw new Error(`facetMgr.spawnNode skipSpawn: callerPid=${opts.callerPid} not in process table`);
      }
      entry = found;
    } else {
      entry = this._spawnLaunchEntry(command, launchArgv({ execArgv: opts.node?.execArgv, argv: opts.argv }), cwd, opts.invokerPid, redriven);
    }
    this.processes.setLongRunning(entry.pid);
    // Every long-running process has an input channel on its pid, one a
    // launcher reserved included.
    this.processes.openInput(entry.pid);
    if (opts.attachedTty) this.processes.setAttachedTty(entry.pid);
    if (!opts.skipSpawn) {
      try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}
    }

    const launch = this._runResidentLaunch(entry, code, command, opts, attempt);
    if (!opts.attachedTty) {
      // A server's caller is told a port is bound, so it has to wait for the
      // boot that binds it. The wait costs this turn nothing: every chunk of
      // the launch runs on a turn of its own.
      await launch;
      return { pid: entry.pid };
    }
    // An attached TUI has no such handshake — its terminal is already open on
    // this pid and the first thing it will show is the program's own output.
    // Returning now is what lets the shell's response complete while the
    // launch is still being built, which is the whole point: the turn that
    // asked for the process must not be the turn that builds it.
    // Rooted so the launch is not an abandoned promise between turns. A
    // failure has already exited the process and notified the session on its
    // way out, so there is nothing left here to report and nothing to gain
    // from also failing the invocation that started it.
    this.ctx.waitUntil(launch.catch(() => {}));
    return { pid: entry.pid };
  }

  /**
   * Build and boot a resident process across as many turns as it takes.
   *
   * Every phase below is paced: the walk, the ESM transform, the module-map
   * serialization and the image-store write each report the work they do, and
   * the pacer ends the turn whenever a chunk's worth has accumulated. What the
   * session gets back between those chunks is its thread — which is what the
   * terminal WebSocket needs to survive a launch, and what no amount of making
   * the launch faster would have given it.
   */
  private _runResidentLaunch(
    entry: ProcessEntry,
    code: string,
    command: string,
    opts: ResidentSpawnOptions,
    attempt: number,
  ): Promise<void> {
    if (this.launchesClosed) return Promise.reject(new Error('Launch scheduler is closed'));
    const preparing = this.processes.holdWork(entry.pid);
    // Its bundle first, under the credit, then its residency's worker (the
    // lock order); its preparation's helpers wait for a worker as its process.
    // A launch admission it is started in (a broker's, for the child whose
    // command this is; an exec's, promoted at its first listen) is given back
    // while it prepares and taken again before its boot (`admitted`), which
    // claims it: a launch holding a worker waits for no credit and on no build.
    // A deferred launch (an attached TTY: spawnNode answers before it boots)
    // outlives the admission it was started in, which its starter closes: it
    // gives it back for good, and its boot takes a slot of its own, as a
    // resident started in none does (_startResidentProcess).
    const inherited = suspendLaunchAdmission(this.ctx);
    const ended = new AbortController();
    const stopWaiting = this.processes.subscribeTerminal(entry.pid, () => {
      ended.abort(new Error(`Nimbus: the launch for pid ${entry.pid} ended`));
      this._launchEnded(entry.pid);
    });
    this._launchStage(entry, 'prepare', ended.signal);
    const admitted = async () => {
      if (inherited !== undefined && !opts.attachedTty) {
        this._launchStage(entry, 'admission', ended.signal);
        await inherited(ended.signal);
      }
      this._launchStage(entry, 'load', ended.signal);
    };
    const launch = withLaunchPreparation(this.ctx, { pid: entry.pid }, () => this._runResidentLaunchBody(entry, code, command, opts, attempt, admitted));
    return this.trackLaunchTask(launch.finally(() => { this._launchEnded(entry.pid); stopWaiting(); preparing(); }));
  }

  private async _runResidentLaunchBody(
    entry: ProcessEntry,
    code: string,
    command: string,
    opts: ResidentSpawnOptions,
    attempt: number,
    admitted: () => Promise<void>,
  ): Promise<void> {
    const cwd = opts.cwd || '/home/user';
    const pacer = this._launchPacer(entry.pid);
    // Journalled before the first byte of work. A launch that FAILS deletes
    // its row on the way out — its process has already been exited and the
    // user notified, so there is nothing left to owe. A launch that SETTLES
    // rewrites the row as a running resident instead: measured live, the
    // resets this journal exists for strike seconds AFTER the launch settles,
    // and a row deleted at settle was exactly why recovery sat inert while
    // sessions kept dying. The row is finally released by the supervisor's
    // terminal hook when the process ends. A re-drive owns its own process,
    // so the caller's pid goes with the instance that had it.
    //
    // Every resident has an identity from the moment it is spawned: derived
    // from the working directory and the launch's argv, node's options
    // included (launchArgv; never the env), so the same
    // `node server.js` from the same directory is the same application
    // across restarts and resets. A resident that declares a port at spawn
    // which an EXPLICIT reservation holds (an embedder's ensureDurableApp)
    // adopts that reservation's owner instead — the landed contract: the
    // embedder declared the port, so whatever binds it is the application.
    //
    // A second live instance of the same derived identity is ephemeral: it
    // runs, but it is not the durable one — it takes no slot (the slot is
    // the identity's, and a live facet already holds it), claims no
    // reservation, and is not journalled, so nothing re-drives it and a
    // port it binds retires the previous occupant's capability like any
    // unrelated process would.
    const derivedOwner = await deriveResidentOwner(cwd, launchArgv({ execArgv: opts.node?.execArgv, argv: opts.argv }));
    let owner = derivedOwner;
    if (opts.port !== undefined && opts.port > 0 && opts.port < 65536) {
      const declared = await readPortReservation(this.ctx, opts.port);
      if (declared !== null && declared.owner !== null && declared.kind === 'explicit') {
        owner = declared.owner;
      }
    }
    // The recipe is the launch's inputs; the invoker is a pid of this
    // instance, which a re-drive outlives, so the row carries who it ran as.
    // Not its env: a relaunch asks the host for it (resolveProcessEnv).
    const { invokerPid: _invokerPid, env: _env, ...inputs } = opts;
    const recipe: NodeRecipe = { kind: 'node', code, opts: { ...inputs, skipSpawn: undefined, callerPid: undefined } };
    const ranAs = { cred: entry.cred, ...(entry.execId === undefined ? {} : { execId: entry.execId }) };
    const initial: ResidentLaunchRecord = {
      pid: entry.pid, command, attempt, phase: 'starting', owner,
      recipe,
      restart: residentRestartPolicy(opts.env),
      ...ranAs,
    };
    let duplicateOf: number | null;
    let reservedPort: number | undefined;
    let durableFacetName: string | undefined;
    let launchEnv: Record<string, string> | undefined;
    try {
      duplicateOf = await this._claimResident(initial, opts.env ?? {});
      this._assertLaunchStillOwned(entry.pid);
      // The reservation the identity holds, if any: its port is what `$PORT`
      // is set to and what the facet's durable slot is bound for, so the
      // resident's `ctx.storage` persists across resets the way a durable
      // worker's does. Taken inside the claim's cleanup: a slot whose ledger
      // charge fails must not leave the claim held.
      const held = duplicateOf !== null ? null : await readPortReservationByOwner(this.ctx, owner);
      if (held !== null) {
        durableFacetName = await acquireDurableFacetSlot(this.ctx, owner);
        reservedPort = held.port;
        launchEnv = { PORT: String(held.port), NIMBUS_APP: held.reservation.name ?? owner };
      }
    } catch (e: unknown) {
      pacer.settle();
      await this._releaseResidentClaim(entry.pid);
      await this.launchJournal.release(entry.pid);
      this._end(entry.pid, { code: 1, cause: 'long-running node launch failed: ' + errorMessage(e) });
      throw e;
    }
    const ephemeral = duplicateOf !== null;
    if (ephemeral) {
      this.ephemeralPids.set(entry.pid, owner);
      this.hooks.notify?.(
        `\x1b[2m[nimbus: second instance of "${launchArgv({ execArgv: opts.node?.execArgv, argv: opts.argv }).join(' ') || command}" `
        + `is not the durable one — pid ${duplicateOf} keeps the identity]\x1b[0m\r\n`,
      );
    }
    const record: ResidentLaunchRecord = {
      pid: entry.pid,
      command,
      attempt,
      phase: 'starting',
      recipe,
      owner,
      ...(reservedPort !== undefined ? { port: reservedPort, injectedPort: reservedPort } : {}),
      restart: residentRestartPolicy(opts.env),
      ...ranAs,
    };
    try {
      if (!ephemeral) await this.launchJournal.journal(record);
    } catch (e: unknown) {
      // A resident that cannot be journalled does not start; the failure is
      // reported the way a boot failure is.
      pacer.settle();
      this._end(entry.pid, { code: 1, cause: 'long-running node launch failed: ' + errorMessage(e) });
      throw e;
    }
    try {
      await this._residentLaunchBody(entry, code, command, cwd, opts, pacer, admitted, durableFacetName, launchEnv);
    } catch (e: unknown) {
      // Bundle construction and source staging precede the launch body's
      // resource-cleanup try/catch. An attached caller already has its pid;
      // rejecting our background task alone leaves that pid running forever.
      pacer.settle();
      if (entry.exitCode === null) {
        this._end(entry.pid, { code: 1, cause: "long-running node launch failed: " + errorMessage(e) });
      }
      await this.launchJournal.release(entry.pid);
      throw e;
    } finally {
      pacer.settle();
      this._releaseBuildAdmission(entry.pid);
    }
    // Booted and running: its budget is whole again once it has run
    // RESIDENT_PROVEN_MS in this instance (_proveByUptime). If the process
    // already ended inside the launch body's own settlement, the terminal hook
    // has released the row — do not write it back. Amended, not rewritten
    // from `record`: a port the program bound during its boot has already
    // been stamped onto the row, and the settle must not lose it.
    if (this.launchJournal.has(entry.pid)) {
      await this._amendRow(entry.pid, (row) => ({ ...row, phase: 'running' }));
      this._proveByUptime(entry.pid);
    }
  }

  private async _residentLaunchBody(
    entry: ProcessEntry,
    code: string,
    command: string,
    cwd: string,
    opts: ResidentSpawnOptions,
    pacer: TurnBudget,
    /** Its inherited launch admission taken again (_runResidentLaunch), once its bundle and map are settled. */
    admitted: () => Promise<void>,
    durableFacetName?: string,
    launchEnv?: Record<string, string>,
  ): Promise<void> {
    const diagOn = isExecDiagEnabled();
    const __bundleStart = diagOn ? Date.now() : 0;
    if (this.debugEnabled) this.processes.appendOutput(entry.pid, 'stderr', '[nimbus-debug] launch: building the module map\n');
    const spec: ProcessBundleSpec = { scriptPath: opts.filename, cwd, entryCode: code, esModule: opts.esModule, bundleProfile: opts.bundleProfile, moduleScope: opts.moduleScope, node: opts.node };
    let vfsState = await this._buildProcessBundle(entry, spec, pacer);
    const plan = async () => {
      if (this.debugEnabled) {
        this.processes.appendOutput(entry.pid, 'stderr',
          `[nimbus-debug] module map: ${vfsState.reachableCount} files${vfsState.cacheHit ? ' (prefetch cache)' : ''}, `
          + `transforms ${JSON.stringify(vfsState.transforms ?? null)}, ES modules ${JSON.stringify(vfsState.esmSize ?? null)} (${pacer.chunks} turns so far)\n`);
      }
      const planStart = Date.now();
      const planned = await this._planResidentData(entry, vfsState, cwd, opts.env?.HOME, pacer, opts.filename, opts.node?.conditions);
      if (this.debugEnabled) {
        this.processes.appendOutput(entry.pid, 'stderr',
          `[nimbus-debug] data plan: ${planned.paths.length} paths in ${Date.now() - planStart} ms (${pacer.chunks} turns so far)\n`);
      }
      return planned;
    };
    let { paths: dataPlan, storageBytes, lazyReads, sourceRoots } = await plan();
    const bundleMs = diagOn ? Date.now() - __bundleStart : 0;
    // The launch-time overlay (`$PORT`, `$NIMBUS_APP` under a reservation)
    // rides on top of the recipe's env and is never journalled: it is
    // re-derived from the reservation on every launch, so a port the
    // application was given follows the reservation, not the recipe.
    const spawnEnv = launchEnv === undefined ? opts.env : { ...(opts.env || {}), ...launchEnv };
    // Every long-running process has an input channel on its pid, and its
    // stdin reads that channel once the program consumes stdin. A
    // backgrounded server started from the terminal sees its stdin stay open,
    // as a job's terminal stdin does, instead of an immediate EOF; only an
    // attached one is a TTY. The env, like the pid, travels in the start
    // payload (startArgs), in memory: the generated worker is
    // content-addressed into an image every process can read.
    const processEnv = opts.attachedTty
      ? {
          ...(spawnEnv || {}),
          NIMBUS_ATTACHED_TTY: '1',
          NIMBUS_CP_CHILD_PID: String(entry.pid),
          TERM: opts.env?.TERM || 'xterm-256color',
          COLORTERM: opts.env?.COLORTERM || 'truecolor',
          COLUMNS: opts.env?.COLUMNS || '80',
          LINES: opts.env?.LINES || '24',
          FORCE_COLOR: opts.env?.FORCE_COLOR || '1',
        }
      : spawnEnv;
    const userCode = await this._entryDynamicImports(code, opts.filename, cwd, pacer);
    let sqliteModules: Record<string, { wasm: ArrayBuffer }>;
    let staged: ResidentStagedBindings | null;
    let wasmImports: FacetWasmImport[];
    let generatedWorker: GeneratedNodeFacetCode | undefined;
    for (let rebuilt = false; ; rebuilt = true) {
      // Answered by _buildProcessBundle while the raw cells were still in hand.
      const usesSqlite = vfsState.usesNodeSqlite ?? bundleUsesNodeSqlite(code, vfsState.bundle);
      const [sqlite, sources] = await Promise.all([
        this.sqliteModuleEntry(usesSqlite),
        fetchNodeFacetSources(this.env),
      ]);
      sqliteModules = sqlite;
      // Each image is read by path when the facet loads, never by value here.
      const images = wasmImports = facetWasmImports([], vfsState.wasmImages ?? []);
      // The staged napi bindings: the shared loader is module text like the
      // rest of the map, the trampoline a 2 KB asset, each binding a path.
      staged = await this._residentStagedBindingMembers(vfsState.stagedBindings ?? [], entry.pid, pacer);
      try {
        generatedWorker = await this._generateUnderCeiling(
          entry.pid, vfsState, this._residentMemberBytes(entry.pid, sqlite, staged, images),
          (state) => generateLongRunningNodeCode(userCode, state, { ...opts, cred: entry.cred, wasmImports: images }, usesSqlite, sources, pacer),
        );
        break;
      } catch (error) {
        if (!(error instanceof ModuleMapOverCeilingError) || rebuilt) throw error;
        vfsState = await this._rebuildUnderCeiling(entry, spec, vfsState, error, pacer);
        ({ paths: dataPlan, storageBytes, lazyReads, sourceRoots } = await plan());
      }
    }

    // Sized here, while the map is still in hand. Reading these after the load
    // would itself be what keeps the map alive, and the whole point of the
    // scoping below is that nothing does.
    let moduleMapBytes = 0;
    let bundleBytes = 0;
    if (diagOn) {
      for (const source of [...Object.values(generatedWorker.modules), ...Object.values(generatedWorker.codeModules), ...Object.values(generatedWorker.esModules)]) {
        bundleBytes += utf8Length(source);
      }
      moduleMapBytes = generatedWorker.source.byteLength + bundleBytes
        + Object.values(generatedWorker.immutableModules).reduce((bytes, source) => bytes + source.byteLength, 0);
    }
    const cacheHit = vfsState.cacheHit ?? false;

    const vfsCursor = vfsState.cursor;
    if (vfsState.bundleKey) this.launchBundles.set(entry.pid, { key: vfsState.bundleKey, refused: new Set() });
    const profileOffer = vfsState.profileOffer;
    if (profileOffer !== undefined) this.residentProfileOffers.set(entry.pid, profileOffer);
    // The map is generated; the state's only remaining job is its cursor.
    // Released here, before the boot — releasing afterwards keeps the copy
    // alive for exactly the window that was resetting the isolate. A state
    // the cache retained is the cache's to keep, and is served to the next
    // launch of the same entry.
    if (!vfsState.cacheRetained) releaseGeneratedSources(vfsState);

    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;

    try {
      // Assembled as one record of the SAME string objects the generator
      // produced — no copy — and then handed over: this frame drops its own
      // reference before materialize runs, and the sequence below drops each
      // source as the store takes it, so one image's text is resident rather
      // than every image's twice over.
      const sources: Record<string, string> = {
        'worker.js': JSON.stringify(generatedWorker.source.recipe()),
        ...generatedWorker.modules,
      };
      const assetModules = Object.fromEntries(Object.entries(generatedWorker.immutableModules)
        .map(([name, source]) => [name, { kind: 'cjs' as const, source: source.asset }]));
      // The code cells travel as ONE image of many modules: the boot spec
      // names a path, not thousands, and the loader slices them out at load.
      const codePack = encodeCodePack(generatedWorker.codeModules, generatedWorker.esModules);
      generatedWorker = undefined;
      if (staged) sources[STAGED_BINDING_LOADER_MODULE] = staged.loader;
      const { [CODE_PACK_IMAGE]: codePackPath, 'worker.js': mainSourcePath, ...vfsTextModules } = await this.imageStore.materialize(
        entry.pid,
        (function* () { yield* drainSources(sources); yield [CODE_PACK_IMAGE, codePack.splice(0)] as const; })(),
        pacer,
      );
      if (this.debugEnabled) this.processes.appendOutput(entry.pid, 'stderr', '[nimbus-debug] launch: images stored, starting the facet\n');
      // A resident whose launcher writes its stdin can stop at a synchronous
      // read of it while it boots, and boot again once the input is there
      // (runtime/stop-replay.ts). One started from the terminal is awaited by
      // the shell, which nothing could write past; an attached one's stdin is
      // the terminal.
      const stdinWriter = opts.stdinWriter === true && !opts.attachedTty;
      const heldStdin = this.stdinReadAhead.open();
      // A boot after a stop that strays is ended (its facet killed) and the
      // process fails, naming how.
      let strayed: (() => void) | null = null;
      if (stdinWriter) {
        this.outputGates.set(entry.pid, new ReplayOutputGate(opts.run));
        this.stdinTaken.set(entry.pid, new StdinTaken(heldStdin, STDIN_SYNC_READ_BYTES));
        this.replay.open(entry.pid, () => {
          this.outputGates.get(entry.pid)?.close();
          strayed?.();
        });
      }
      // Each boot starts from the umask the process started with.
      const startUmask = entry.cred.umask;
      // A promoted one-shot's boot replays its run up to its listen (_promote).
      let rerun: StoppedRunNext | null = opts.resume ?? null;
      const stoppable = stdinWriter || opts.resume !== undefined;
      let stopNonce: string = crypto.randomUUID();
      // Until it has booted, a stop is this launch's to answer (below); after,
      // nothing runs it again, and a stop ends it, saying why: never a
      // failure the launch and its host's watch both pass over.
      let launching = true;
      try {
      for (let stops = 0; ; stops++) {
      // Last gate before the facet exists. A launch now spans many turns, so
      // a kill can land anywhere inside it; booting a process the table has
      // already exited would leave a facet nothing owns, running against a
      // pid the session has finished reporting on.
      this._assertLaunchStillOwned(entry.pid);
      // Its worker, the launch admission it was started in, before its boot claims it.
      await admitted();
      // The run this boot is: past a stop, the one its replay names; a run from its start past one that stopped, its own.
      const launchingRun = rerun?.replay.run ?? opts.run ?? 1;
      try {
      const launchingNonce = stopNonce;
      handle = await this._startResidentProcess(entry.pid, {
        // The attached-TTY runner holds startProcess open for the process's
        // life; the server/watch runner returns once it is up.
        startContract: opts.attachedTty ? 'lifetime' : 'boot',
        journaled: true,
        ...(stoppable ? {
          controlFailure: (error: unknown) => {
            const stop = stopRecordOf(error, launchingNonce, launchingRun);
            if (stop === null) return false;
            // Booted: a promoted server retraces on past its boot (stop-replay
            // booted), where its launch waits on it no longer.
            if (!launching) this.ctx.waitUntil(this._endByStop(entry.pid, stop, opts.resume !== undefined));
            return true;
          },
        } : {}),
        startArgs: {
          pid: entry.pid, vfsCursor, dataPlan,
          env: processEnv ?? {},
          ...(Object.keys(lazyReads).length > 0 ? { lazyReads } : {}),
          ...(sourceRoots.length > 0 ? { sourceRoots } : {}),
          ...(profileOffer !== undefined && profileOffer.staged.length > 0 ? { profileStaged: profileOffer.staged.map((e) => e.path) } : {}),
          ...(this.debugEnabled ? { diag: true } : {}),
          ...(stdinWriter ? { stdinWriter: true } : {}),
          ...(stoppable ? { stopNonce } : {}),
          // A boot after a stop: what the stopped boot drew and printed, and
          // the stdin it is handed back.
          ...(rerun !== null ? { replay: rerun.replay, stdinAtLeast: rerun.stdinAtLeast ?? 0, ...(rerun.stdinWhole ? { stdinWhole: true } : {}) } : {}),
          // A run from its start after a run that stopped: its output is that next run's.
          ...(rerun === null && opts.run !== undefined ? { run: opts.run } : {}),
          ...(rerun?.stdinFile ? { stdinFile: rerun.stdinFile } : opts.stdinFile ? { stdinFile: opts.stdinFile } : {}),
        },
        // Each boot after a stop is a fresh isolate: a keyed loader keeps the
        // stopped one's module state.
        ...(rerun !== null ? { run: rerun.replay.run } : opts.run !== undefined ? { run: opts.run } : {}),
        storageBytes,
        // A resident whose declared port is reserved binds the owner's
        // durable slot — the same store a durable worker spawn takes — so the
        // reservation's durability reaches this process's storage too.
        ...(durableFacetName !== undefined
          ? { facet: { name: durableFacetName, durable: true } }
          : {}),
        boot: {
          kind: 'code',
          code: {
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: [...GUEST_COMPAT_FLAGS],
            mainModule: 'worker.js',
            // Only fixed-size assets of the worker's own ride by value: the
            // sqlite sidecar and the staged bindings' trampoline.
            modules: staged ? { ...sqliteModules, [STAGED_BINDING_TRAMPOLINE_MODULE]: { wasm: staged.trampoline } } : sqliteModules,
            vfsTextModules,
            vfsComposedModules: { 'worker.js': mainSourcePath },
            assetModules,
            // Wasm images are read by path when the facet loads: the closure's
            // own, and the staged bindings' kernel-owned copies.
            vfsWasmModules: {
              ...Object.fromEntries(wasmImports.map((image) => [image.moduleName, image.vfsPath])),
              ...staged?.bindingPaths,
            },
            vfsCodePacks: [codePackPath],
          },
        },
      });
      // A boot after a stop that strays is killed where it stands.
      const booting = handle;
      strayed = () => booting.kill();
      // Ended while its facet was being created (a signal's default action).
      if (this.processes.get(entry.pid)?.state !== 'running') {
        handle.kill();
        return;
      }
      if (diagOn) {
        recordExecTelemetry({
          command,
          bundleMs,
          // Both spans are pure computation plus SQLite, and workerd's clock
          // only moves on I/O, so timing them here reads 0 however many
          // seconds they burn. The tail's per-turn cpuTime is the authority on
          // what a launch costs; what this record adds is what it is made OF.
          loadMs: 0,
          runMs: 0,
          drainPasses: 0,
          moduleMapBytes,
          // The side modules ARE the VFS bundle whenever the map was split;
          // when it stayed inline it rides inside worker.js and shows up only
          // in the total.
          bundleBytes,
          namespaceRefusals: 0,
          rpcWrites: 0,
          fsRpcReads: 0,
          esmAdoptions: 0,
          cacheHit,
          ...execBreakdown(vfsState),
          turns: pacer.chunks,
          exitCode: 0,
          at: Date.now(),
        });
      }
      this.trackProcessRpcResources(
        entry.pid,
        [handle],
        { releaseOnReportExit: !opts.attachedTty },
      );
      resourcesTracked = true;
      // A node-shims resident: its __nimbusServeHttp takes the delivered ACQUIRE off each request.
      this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget, { deliversAcquire: true });

      if (opts.attachedTty) {
        this._watchLifetime(entry.pid, handle, 'long-running node process');
      } else {
        await handle.booted();
      }
      this._launchEnded(entry.pid);
      launching = false;
      break;
      } catch (e: unknown) {
        // The boot stopped itself at a synchronous read of stdin that has to
        // wait: wait for the input, then boot it again.
        const journal = this.replay.get(entry.pid)?.journal;
        let stop = stoppable ? stopRecordOf(e, stopNonce, launchingRun) : null;
        if (stop === null && journal?.diverged) stop = { v: 3, kind: 'diverged', run: launchingRun, out: [], why: journal.diverged };
        if (stop === null) throw e;
        this.stdinTaken.get(entry.pid)?.retire();
        const refused = stop.kind === 'stdin' && journal ? journal.unreplayable : null;
        journal?.stopped();
        await this.hooks.rewindProcessFiles?.(entry.pid);
        // The stopped facet is released whole (its slot, its name, its
        // storage) before the next boot takes a slot of its own.
        handle?.kill();
        await handle?.done.catch(() => {});
        handle = undefined;
        this.portRegistry.unregisterByPid(entry.pid);
        if (opts.resume && stop.kind === 'diverged') {
          await this._endByStop(entry.pid, stop, true);
          return;
        }
        const waiting = new AbortController();
        this.processes.setTerminator(entry.pid, () => waiting.abort());
        const resumed = await this._resumeStoppedRun(entry, stop, stops, entry.pid, {}, waiting.signal, heldStdin,
          { accepted: { stdout: '', stderr: '' }, refused });
        if ('exit' in resumed) {
          this._end(entry.pid, { code: resumed.exit.exitCode, cause: 'stopped at a synchronous read of stdin' });
          return;
        }
        this.processes.setUmask(entry.pid, startUmask);
        rerun = resumed.next;
        stopNonce = crypto.randomUUID();
      }
      }
      } finally {
        this.stdinTaken.get(entry.pid)?.release();
        this.stdinTaken.delete(entry.pid);
        heldStdin.give();
        if (stdinWriter) {
          this.outputGates.delete(entry.pid);
          // Booted: from here it is a running server, never run again.
          this.replay.close(entry.pid);
        }
      }

      if (opts.port && opts.port > 0 && opts.port < 65536) {
        await this._registerResidentPort(entry.pid, opts.port);
      }
    } catch (e: unknown) {
      // A program classified as long-running that ended on its own during
      // its boot — `json-server --version` prints and exits 0 — reported its
      // exit through the supervisor, which released the facet and rejected
      // the boot handshake with 'resident process released'. That is a
      // completed run, not a failed launch: the process table already holds
      // its real exit code, and the caller reports that code.
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      if (this.processExitCode(entry.pid) !== null) return;
      handle?.kill();
      this._end(entry.pid, { code: 1, cause: 'long-running node boot failed: ' + errorMessage(e) });
      throw e;
    }
  }

  /**
   * The exit code of a launched process that has already ended, or null
   * while it runs. What a caller that started a resident reads to tell a
   * server that is up from a program that finished during its boot.
   */
  processExitCode(pid: number): number | null {
    const entry = this.processes.get(pid);
    if (entry === undefined || entry.state === 'running') return null;
    return entry.exitCode ?? 0;
  }

  /**
   * Spawn a long-running dynamic Worker, boot it, and return its boot payload
   * beside the pid and the process's own inbound facet.
   *
   * The shared primitive for any runtime that serves over
   * handleHttpRequest(Request) — the python and ruby socket servers today —
   * and for an embedder's own Worker-class program: `workerCode` boots as
   * `opts.mainModule` (default `worker.js`), `opts.modules` ride inline,
   * `opts.vfsTextModules` and `opts.vfsWasmModules` are read by path when the
   * facet loads.
   *
   * The interpreter image it carries is the memory that should not sit in the
   * session's own isolate — ruby's interpreter+stdlib alone is 34.3 MiB — and
   * a facet's envelope is independent of the session's, so it does not. It has
   * no readiness coupling back into the session: the runner answers
   * startProcess with its boot payload and the caller waits on that one
   * promise, so nothing polls the port to decide the process is up.
   *
   * The returned `facet` is bound to the resident handle's route target — the
   * same target a registered port routes to — so a port-less process can be
   * invoked directly. It has no release: `kill(pid)` is the one lifecycle
   * owner, and the facet is dead once the pid is.
   */
  async spawnWorker(
    workerCode: string,
    command: string,
    cwd: string,
    opts: LongRunningWorkerSpawnOptions = {},
  ): Promise<SpawnedWorker> {
    return this._spawnWorker(workerCode, command, cwd, opts, 0);
  }

  /** `attempt` is the journal's re-drive budget, and `redriven` who a re-drive runs as, as `_spawnResident` carries them. */
  private async _spawnWorker(
    workerCode: string,
    command: string,
    cwd: string,
    opts: LongRunningWorkerSpawnOptions,
    attempt: number,
    redriven?: LaunchIdentity,
  ): Promise<SpawnedWorker> {
    if (opts.identity !== undefined && (opts.invokerPid !== undefined || opts.resident !== undefined || opts.durable !== undefined)) {
      throw new Error('Nimbus: spawnWorker identity is exclusive with invokerPid, resident and durable');
    }
    if (opts.bindings !== undefined && (opts.env !== undefined || opts.durable !== undefined || opts.resident !== undefined)) {
      throw new Error('Nimbus: spawnWorker bindings go beside the default env: not with an explicit env, nor on a journalled launch, which could not re-mint them');
    }
    const identity = opts.identity === undefined ? undefined : {
      cred: requireVfsCred(opts.identity.cred, 'spawnWorker identity'),
      ...(opts.identity.execId === undefined ? {} : { execId: parseExecId(opts.identity.execId) }),
      ...(opts.identity.restartedFrom === undefined ? {} : { restart: { from: opts.identity.restartedFrom, doing: 'serving' } }),
    };
    if (opts.resident && !opts.durable) {
      opts = { ...opts, durable: { owner: await deriveResidentOwner(cwd, opts.resident.argv) } };
    }
    if (opts.durable && (!opts.resident || await readPortReservationByOwner(this.ctx, opts.durable.owner))) {
      this.processHost.assertDurableStorage();
    }
    await this.processes.reap();
    // The table entry carries the same argv the identity is derived from, so
    // a runtime resident reads the same way through either path.
    const entry = this._spawnLaunchEntry(command, opts.identity?.argv.map(String) ?? opts.resident?.argv ?? [], cwd, opts.invokerPid, redriven ?? identity);
    // Stamp the process-table entry so /api/processes exposes this as a
    // long-running process.
    this.processes.setLongRunning(entry.pid);
    // Resident facets always get a spawn notification — they're visible and
    // users want the PID for later `logs`/`kill`.
    try { this.hooks.onSpawn?.(entry.pid, command, true); } catch {}

    const compatibilityDate = opts.compatibilityDate ?? CF_COMPAT_DATE;
    const compatibilityFlags = opts.compatibilityFlags ?? [];
    const mainModule = opts.mainModule ?? DEFAULT_WORKER_MAIN_MODULE;
    if (opts.modules && Object.hasOwn(opts.modules, mainModule)) {
      throw new Error(`Nimbus: spawnWorker main module '${mainModule}' is also an inline module; workerCode is the main module`);
    }

    let handle: ResidentProcessHandle | undefined;
    let resourcesTracked = false;
    let record: ResidentLaunchRecord | undefined;
    let durableFacetName: string | undefined;
    let launchEnv: Record<string, string> | undefined;
    const foreground = opts.foreground ? this._holdForeground(entry.pid, opts.foreground) : null;
    try {
      if (opts.durable) {
        // A durable spawn on a declared port starts only when a reservation the
        // owner already holds is persisted. Validated before the journal row is
        // written and before the process boots, so a foreign or absent
        // reservation refuses the launch rather than stealing the exposure.
        if (!opts.resident && opts.port && opts.port > 0 && opts.port < 65536) {
          const preFlight = await readPortReservation(this.ctx, opts.port);
          if (preFlight === null || preFlight.owner !== opts.durable.owner) {
            throw new Error('port reservation conflict: durable worker does not own port ' + opts.port);
          }
        }
        // A live outbound binding cannot be journalled — a reset would re-drive
        // the recipe with nothing to stand in for it. Only the EMBEDDER's
        // resolveWorkerLaunch can re-mint one: the session's fallback reads
        // the image store, which never carries a binding, so a durable spawn
        // carrying globalOutbound is refused where no embedder hook exists.
        if (opts.globalOutbound !== undefined && opts.globalOutbound !== null
          && this.hooks.resolveWorkerLaunch === undefined) {
          throw new Error(
            'Nimbus: a durable spawn carrying a live globalOutbound binding '
              + 'cannot be journalled without an embedder resolveWorkerLaunch hook',
          );
        }
        // Nor an env, `{}` included (it is the isolate's whole binding map):
        // what the image store holds every process can read, so it holds no
        // environment, and only the embedder can give one back.
        if (opts.env !== undefined && this.hooks.resolveWorkerLaunch === undefined) {
          throw new Error(
            'Nimbus: a durable spawn carrying an env cannot be journalled without an embedder resolveWorkerLaunch hook: '
              + 'its image is readable by every process, so it never holds an environment',
          );
        }
        // Self-owned applications persist their launch inputs as image blobs —
        // a runner blob for worker.js, an application blob for modules + env —
        // under .nimbus/images/<sha256>, and the journal row names the digests
        // of what was written, never placeholder strings. An embedder-owned
        // spawn is given digests by its own bookkeeping instead.
        // No environment: neither a binding env (refused above) nor the
        // process's own (storedStartArgs), as every process can read it.
        const image = opts.durable.image
          ?? await persistDurableWorkerImage(this._imageBlobs(entry.pid), workerCode, {
            modules: opts.modules ?? {},
            vfsWasmModules: opts.vfsWasmModules,
            vfsTextModules: opts.vfsTextModules,
            ...(opts.mainModule !== undefined ? { mainModule: opts.mainModule } : {}),
            startArgs: opts.resident === undefined ? opts.startArgs : storedStartArgs(opts.startArgs, opts.interpreterEnv),
          });
        await this.ctx.storage.transaction(async (txn) => {
          const key = `${DURABLE_IMAGES_KEY_PREFIX}${opts.durable!.owner}`;
          const images = await txn.get<Array<{ runner: string; application: string }>>(key) ?? [];
          if (!images.some((held) => held.runner === image.runner && held.application === image.application)) {
            await txn.put(key, [...images, image]);
          }
        });
        // Journalled before the launch's first byte of work, so a row a
        // later instance reads proves this process never ended.
        record = {
          pid: entry.pid,
          command,
          attempt,
          phase: 'starting',
          recipe: {
            kind: 'worker',
            owner: opts.durable.owner,
            image,
            port: opts.port ?? 0,
            cwd,
            compatibilityDate,
            compatibilityFlags,
            ...(opts.durable.image && !opts.resident ? { startArgs: opts.startArgs } : {}),
            ...(opts.resident ? { resident: opts.resident } : {}),
            ...(opts.mainModule !== undefined ? { mainModule: opts.mainModule } : {}),
          },
          // The row-level fields `ensureDurableAppOnPort` reads — same values
          // the recipe carries, stamped so port/owner lookup never depends on
          // the recipe's kind.
          owner: opts.durable.owner,
          restart: opts.restart ?? 'never',
          ...(opts.port !== undefined && opts.port > 0 ? { port: opts.port } : {}),
          cred: entry.cred,
          ...(entry.execId !== undefined ? { execId: entry.execId } : {}),
        };
        // The durable facet name is claimed once, ever, from DO storage — a
        // re-drive after a reset, an eviction's re-attach and a relaunch all
        // land on the same `app-slot-<n>`, which is the only thing that keeps
        // the retained SQLite bound to this application.
        // An interpreter resident's relaunch asks for its environment, an empty one included.
        const duplicate = await this._claimResident(record, opts.resident === undefined ? undefined : opts.interpreterEnv?.base ?? {});
        if (duplicate !== null) {
          this.ephemeralPids.set(entry.pid, opts.durable.owner);
          this.hooks.notify?.(`\x1b[2m[nimbus: second instance of "${command}" is not the durable one — pid ${duplicate} keeps the identity]\x1b[0m\r\n`);
        } else if (!opts.resident || await readPortReservationByOwner(this.ctx, opts.durable.owner)) {
          durableFacetName = await acquireDurableFacetSlot(this.ctx, opts.durable.owner);
        }
        if (duplicate === null) {
          const held = await readPortReservationByOwner(this.ctx, opts.durable.owner);
          if (held) {
            launchEnv = { PORT: String(held.port), NIMBUS_APP: held.reservation.name ?? opts.durable.owner };
            await this._amendRow(entry.pid, (row) => ({ ...row, port: held.port, injectedPort: held.port }));
          }
        }
      }
      handle = await this._startResidentProcess(entry.pid, {
        // These runners answer startProcess with a boot payload (listening
        // port, or a completed non-server run) and stay resident after it.
        startContract: 'boot',
        // A python or ruby resident logs its changes in its store; an
        // application's own class keeps its store to itself.
        journaled: opts.resident !== undefined,
        startArgs: opts.resident && opts.startArgs && typeof opts.startArgs === 'object'
          ? { ...opts.startArgs, supervisorPid: entry.pid,
              ...(launchEnv ? { userEnv: { ...z.record(z.string(), z.unknown()).parse(Reflect.get(opts.startArgs, 'userEnv') ?? {}), ...launchEnv } } : {}) }
          : opts.startArgs,
        ...(durableFacetName !== undefined
          ? { facet: { name: durableFacetName, durable: true } }
          : {}),
        boot: {
          kind: 'code',
          code: {
            compatibilityDate,
            compatibilityFlags,
            mainModule,
            modules: { ...(opts.modules || {}), [mainModule]: workerCode },
            vfsWasmModules: opts.vfsWasmModules,
            ...(opts.vfsTextModules !== undefined ? { vfsTextModules: opts.vfsTextModules } : {}),
            ...(opts.env !== undefined || launchEnv !== undefined ? { env: { ...opts.env, ...launchEnv } } : {}),
            ...(opts.bindings !== undefined ? { bindings: opts.bindings } : {}),
            ...(opts.globalOutbound !== undefined ? { globalOutbound: opts.globalOutbound } : {}),
          },
        },
      });
      this.trackProcessRpcResources(entry.pid, [handle]);
      resourcesTracked = true;
      this.portRegistry.bindFacetStub(entry.pid, handle.routeTarget);
      const boot = foreground ? await Promise.race([handle.booted(), foreground.interrupted]) : await handle.booted();
      if (record && this.launchJournal.has(entry.pid)) {
        // Booted and running: its budget is whole again once it has run RESIDENT_PROVEN_MS here (_proveByUptime).
        await this._amendRow(entry.pid, (row) => ({ ...row, phase: 'running' }));
        this._proveByUptime(entry.pid);
      }
      if (opts.port && opts.port > 0 && opts.port < 65536) {
        if (opts.durable && !opts.resident) {
          // Re-read after the boot: a release or reassignment during it wins.
          // The durable launch registers only under a reservation it still
          // owns; it never clears or takes a foreign exposure.
          const reservation = await readPortReservation(this.ctx, opts.port);
          if (reservation === null || reservation.owner !== opts.durable.owner) {
            throw new Error('port reservation conflict: durable worker does not own port ' + opts.port);
          }
          // The owner's hold on the port survives the instance reset that
          // re-drove this launch, and preview URLs minted against it stay
          // valid: the durable capability is re-adopted through the
          // reservation's own path, gated on the stored owner.
        }
        await this._registerResidentPort(entry.pid, opts.port);
      }
      const target = handle.routeTarget;
      return {
        pid: entry.pid,
        boot,
        facet: {
          // The caller reads the body across RPC; the process's work for it ends with the relay.
          fetch: async (request) => {
            const { scope, owner } = responseScope(request.signal);
            try { return relayRpcBody(await target.handleHttpRequest(request, scope), request.method, owner); }
            catch (error) { owner.fail(); throw error; }
          },
          connect: async (request) => {
            if (typeof target.handleWebSocketRequest !== 'function') {
              throw new Error(`Nimbus: worker pid ${entry.pid} accepts no WebSocket upgrades`);
            }
            return target.handleWebSocketRequest(request);
          },
        },
      };
    } catch (e: unknown) {
      this.portRegistry.unregisterByPid(entry.pid);
      if (resourcesTracked) this.releaseProcessRpcResources(entry.pid);
      else handle?.kill();
      // An interrupt already killed the process; it did not fail.
      if (!opts.foreground?.signal.aborted) this._end(entry.pid, { code: 1, cause: 'long-running worker boot failed: ' + errorMessage(e) });
      throw e;
    } finally {
      foreground?.release();
    }
  }

  private _holdForeground(pid: number, launch: ForegroundLaunch): { interrupted: Promise<never>; release(): void } {
    this.processes.setForeground(pid, true);
    const unsubscribe = this.processes.subscribeOutputBytes(pid, (chunk) => launch.write(chunk.stream, chunk.data));
    let onAbort = (): void => {};
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => {
        this.kill(pid);
        reject(new DOMException('the launching command was interrupted', 'AbortError'));
      };
    });
    interrupted.catch(() => {});
    if (launch.signal.aborted) onAbort();
    else launch.signal.addEventListener('abort', onAbort, { once: true });
    return {
      interrupted,
      release: () => {
        launch.signal.removeEventListener('abort', onAbort);
        unsubscribe();
        this.processes.setForeground(pid, false);
      },
    };
  }

  /**
   * A resident process announcing it bound `port`.
   *
   * The stamp is unconditional: the pid's journal row gets `{ port }`
   * whether or not anything reserved it, which is what lets
   * `ensureDurableAppOnPort` re-drive ANY resident a reset killed — the
   * scoped URLs need no capability, so this alone makes every server's
   * preview survive a reset on demand.
   *
   * The capability is bound to identity, not to the port. The stored
   * capability is re-adopted only when the row's owner IS the reservation's
   * owner; any other occupant — an unrelated server, a pid outside the
   * resident lifecycle, the ephemeral second instance of an identity —
   * retires it and mints fresh, so a shared link 404s rather than reaching
   * a program it was never handed out for. An EXPLICIT reservation (an
   * embedder's `ensureDurableApp`) is the one exception, and it is the
   * landed contract: the embedder declared the port, so the row adopts the
   * reservation's owner and the capability with it.
   *
   * Under an injected `$PORT`, a resident that binds a different port is
   * registered anyway — the server must not break — but the row records
   * the mismatch, so `apps.list` reports it as failed and the user is told.
   */
  private async _registerResidentPort(pid: number, port: number): Promise<void> {
    const reservation = await readPortReservation(this.ctx, port);
    let claimedBy: string | undefined;
    if (reservation?.owner && reservation.kind === 'explicit' && !this.ephemeralPids.has(pid)) {
      const owner = reservation.owner;
      const anotherLive = [...(await this.launchJournal.rows()).values()].some((row) =>
        row.pid !== pid && residentOwner(row) === owner
        && row.pid > this.processes.pidBase && this.processes.get(row.pid)?.state === 'running');
      if (!anotherLive) claimedBy = owner;
    }
    let newlyMismatched = false;
    const row = await this._amendRow(pid, (current) => {
      const owner = claimedBy ?? residentOwner(current);
      const injected = current.injectedPort;
      // Under an injected $PORT, the reserved port is the row's port for as
      // long as this pid holds it; a second, different binding is recorded
      // as the mismatch rather than displacing it.
      const holdsInjected = injected !== undefined && injected !== port
        && this.portRegistry.get(injected)?.pid === pid;
      const stampedPort = holdsInjected ? injected : port;
      const portMismatch = injected !== undefined && injected !== port && !holdsInjected
        ? { listened: port, reserved: injected }
        : undefined;
      const same = current.port === stampedPort && residentOwner(current) === owner
        && (current.portMismatch?.listened === portMismatch?.listened)
        && (current.portMismatch?.reserved === portMismatch?.reserved);
      if (same) return current;
      newlyMismatched = portMismatch !== undefined && current.portMismatch === undefined;
      const { portMismatch: _dropped, ...rest } = current;
      return {
        ...rest,
        port: stampedPort,
        ...(owner !== undefined ? { owner } : {}),
        ...(portMismatch !== undefined ? { portMismatch } : {}),
      };
    });
    if (newlyMismatched && row?.portMismatch !== undefined) {
      this.hooks.notify?.(
        `\x1b[2m[nimbus: "${row.command}" listened on ${port} but its reservation owns `
        + `${row.portMismatch.reserved} ($PORT) — the app's URL will not reach it]\x1b[0m\r\n`,
      );
    }
    // A pid nothing journalled — the in-process dev servers, a builtin's
    // adopted wrapper pid — still has an identity: the process table's. It
    // re-adopts a reservation it owns exactly as a resident does; the one
    // thing it cannot do is adopt an EXPLICIT owner, because there is no row
    // to stamp the adoption on, so it registers ephemeral on that port.
    const owner = row === undefined
      ? (await this.residentIdentity(pid))?.owner
      : residentOwner(row);
    if (claimedBy !== undefined && row !== undefined && this.residentClaims.get(pid) !== claimedBy) {
      const previousOwner = this.residentClaims.get(pid);
      await this._releaseResidentClaim(pid);
      const duplicate = await this._claimResident(row);
      if (duplicate !== null) {
        this.ephemeralPids.set(pid, claimedBy);
        await this.launchJournal.release(pid);
      } else if (previousOwner && row.recipe.kind === 'worker') {
        // Adoption moves retained images with the identity, including the
        // index that survives a clean exit after the journal row is released.
        await this.ctx.storage.transaction(async (txn) => {
          const previousKey = `${DURABLE_IMAGES_KEY_PREFIX}${previousOwner}`;
          const nextKey = `${DURABLE_IMAGES_KEY_PREFIX}${claimedBy}`;
          const previous = await txn.get<Array<{ runner: string; application: string }>>(previousKey) ?? [];
          const next = await txn.get<Array<{ runner: string; application: string }>>(nextKey) ?? [];
          const combined = [...next];
          for (const image of previous) {
            if (!combined.some((held) => held.runner === image.runner && held.application === image.application)) combined.push(image);
          }
          await txn.put(nextKey, combined);
          await txn.delete(previousKey);
        });
      }
    }
    if (reservation !== null && reservation.owner !== null && owner === reservation.owner && !this.ephemeralPids.has(pid)) {
      this.portRegistry.register(port, pid);
      await restoreReservedPortCapability(
        { ctx: this.ctx, portRegistry: this.portRegistry },
        port,
        reservation.owner,
      );
      return;
    }
    // Any other occupant retires the previous one's capability — and its
    // directory row, so a public link goes dead rather than dangling — and
    // registers with a fresh one. The owner's reservation survives it.
    if (reservation?.owner) {
      this.hooks.notify?.(`\x1b[2m[nimbus: port ${port} belongs to ${reservation.owner}; pid ${pid} registers ephemeral (owner ${owner ?? 'none'})]\x1b[0m\r\n`);
    }
    if (reservation?.visibility === 'public' && reservation.capability !== null) {
      await unbindPublicPortCapability(this._publicDirectoryHost(), reservation.capability);
    }
    await clearPortCapability({ ctx: this.ctx, portRegistry: this.portRegistry }, port);
    this.portRegistry.register(port, pid);
  }

  /**
   * Who a pid is. One resolver, in precedence order: the ephemeral-duplicate
   * mark, the journal row (the owner a launch this manager made was stamped
   * with — derived from the launch's own cwd+argv, or adopted from an
   * explicit reservation), and finally the process table. The table knows
   * cwd and argv for every pid, so a serving process nothing journalled — the
   * in-process Vite dev server, real-vite, a staged artifact, any wrapper pid
   * a builtin adopted — has the same derived identity shape as a resident
   * and answers to the same app verbs. It just cannot be re-driven after a
   * reset: only a journal row carries a recipe. Null only for a pid that is
   * neither journalled nor running.
   */
  async residentIdentity(pid: number): Promise<ResidentIdentity | null> {
    const duplicated = this.ephemeralPids.get(pid);
    if (duplicated !== undefined) return { owner: duplicated, ephemeral: true, port: undefined };
    const row = (await this.launchJournal.rows()).get(`${FENCED_WORK_KEY_PREFIX}${pid}`);
    if (row !== undefined) return { owner: residentOwner(row), ephemeral: false, port: row.port };
    const entry = this.processes.get(pid);
    if (entry === undefined || entry.state !== 'running') return null;
    return {
      owner: await deriveResidentOwner(entry.cwd, entry.argv),
      ephemeral: false,
      port: this.portRegistry.getAll().find((live) => live.pid === pid)?.port,
    };
  }

  /**
   * Every stamped identity — the reservations, and the journal rows that
   * carry an owner — folded one row per owner. A live pid in THIS instance
   * makes it running (or starting, until its launch settles and its port
   * is registered); a mismatch diagnostic makes it failed; everything else
   * is stopped, which for a row a reset left behind means re-drivable on
   * request.
   */
  async listResidentApps(): Promise<ResidentAppSummary[]> {
    const apps = new Map<string, ResidentAppSummary>();
    for (const [port, reservation] of await listPortReservations(this.ctx)) {
      if (reservation.owner === null) continue;
      apps.set(reservation.owner, {
        owner: reservation.owner,
        name: reservation.name ?? null,
        port,
        pid: null,
        status: 'stopped',
        visibility: reservation.visibility,
        capability: reservation.capability,
        restart: 'never',
        diagnostic: null,
      });
    }
    for (const [, row] of await this.launchJournal.rows()) {
      const owner = residentOwner(row);
      if (owner === undefined) continue;
      const app = apps.get(owner) ?? {
        owner, name: null, port: null, pid: null, status: 'stopped',
        visibility: 'scoped', capability: null, restart: 'never', diagnostic: null,
      };
      if (app.port === null && row.port !== undefined && row.port > 0) app.port = row.port;
      if (row.restart !== undefined) app.restart = row.restart;
      const entry = this.processes.get(row.pid);
      const live = row.pid > this.processes.pidBase && entry?.state === 'running';
      if (live) {
        app.pid = row.pid;
        const bound = app.port !== null && this.portRegistry.get(app.port)?.pid === row.pid;
        app.status = row.phase === 'running' && bound ? 'running' : 'starting';
      }
      if (row.portMismatch !== undefined) {
        app.status = 'failed';
        app.diagnostic = `listened on ${row.portMismatch.listened}, owns ${row.portMismatch.reserved}`;
      }
      apps.set(owner, app);
    }
    // Every process serving a port is an application whether or not a
    // journal row backs it — the identity comes from the same resolver the
    // verbs use, so what `list` shows is what `expose` will bind. A row-backed
    // app already carries its pid from above; this only adds the servers
    // nothing journalled (the dev servers, adopted wrapper pids).
    for (const live of this.portRegistry.getAll()) {
      const identity = await this.residentIdentity(live.pid);
      if (identity === null || identity.ephemeral || identity.owner === undefined) continue;
      const app = apps.get(identity.owner) ?? {
        owner: identity.owner, name: null, port: null, pid: null, status: 'stopped',
        visibility: 'scoped', capability: null, restart: 'never', diagnostic: null,
      };
      if (app.pid !== null) continue;
      app.pid = live.pid;
      if (app.port === null) app.port = live.port;
      if (app.status === 'stopped') app.status = 'running';
      apps.set(identity.owner, app);
    }
    // The live pid's exec id and restart, read from its process: the one place they live.
    return [...apps.values()].map((app) => (app.pid === null ? app : { ...app, ...processReportFields(this.processes.get(app.pid)) }));
  }

  async registerPort(pid: number, port: number): Promise<void> {
    if (port > 0 && port < 65536) {
      await this._registerResidentPort(pid, port);
    }
  }

  waitForRouteablePorts(
    pid: number,
    timeoutMs = ROUTEABLE_PORT_ATTACH_TIMEOUT_MS,
  ): Promise<number[]> {
    return this.portRegistry.waitForRouteablePortsByPid(pid, timeoutMs);
  }

  finishProcess(pid: number, exitCode: number, reason = 'exited'): void {
    this._end(pid, { code: exitCode, ...(exitCode !== 0 ? { cause: reason } : {}) });
  }

  /**
   * Kill a running process by PID. Given the signal that ends it (a name
   * without `SIG`), it exits with that signal's status, 128+signo, and its
   * exit names `SIG<name>`; without one it is SIGKILL's 137, `killed`.
   * `reason` is what the work held for it is stopped with (a destroy's).
   */
  kill(pid: number, signal?: string, reason?: SignalAbortReason): boolean {
    const entry = this.processes.get(pid);
    if (!entry || entry.state !== 'running') return false;
    // One its program takes is its program's (SessionProcessSupervisor.takeSignals): nothing of it ends.
    const sent = signal === undefined ? null : parseProcessSignalName(`SIG${signal}`);
    if (sent !== null && this.processes.deliverSignal(pid, sent)) return true;
    this._end(pid, {
      code: signal === undefined ? 137 : exitCodeForSignal(signal), cause: signal === undefined ? 'killed' : `SIG${signal}`, killed: true,
      ...(reason === undefined ? {} : { reason }),
    });
    return true;
  }

  /**
   * Remove a durable application: the ONLY path that deletes durable facet
   * storage. Owner-checked by construction — `freeDurableFacetSlot` answers
   * only a slot the owner actually holds, and the reservation release refuses
   * a foreign owner's record — so another owner's name cannot be reached.
   *
   * One ordered teardown: the live process is killed first (a released
   * durable facet only aborts, so nothing else ends it), the port reservation
   * is released, the journal rows for the owner are purged (nothing is owed a
   * removed application), the facet's SQLite is deleted, and the slot row is
   * freed last — so a crash mid-removal leaves a name still claimed rather
   * than a store nobody can re-drive.
   */
  async removeDurableApp(owner: string): Promise<boolean> {
    // Kill any live process this owner still has — a durable release aborts
    // without deleting, so the store outlives the process unless removal
    // ends it here.
    const journalRows = await this.ctx.storage.list<ResidentLaunchRecord>({ prefix: 'resident-launch:' });
    const ownedPids: number[] = [];
    const ownedPorts = new Set<number>();
    for (const [, record] of journalRows) {
      // Owner-stamped rows cover every kind the reservation claims — a node
      // resident that bound the port is as much the application as a durable
      // worker spawn is.
      if (residentOwner(record) !== owner) continue;
      ownedPids.push(record.pid);
    }
    for (const pid of ownedPids) this.kill(pid);

    // The reservation may outlive every journal row (spawn never finished
    // writing one), so scan the port records for the owner too.
    const portRows = await this.ctx.storage.list<{ owner?: string; capability?: string | null; visibility?: string }>({ prefix: PORT_CAPABILITY_KEY_PREFIX });
    for (const [key, record] of portRows) {
      if (record?.owner === owner) ownedPorts.add(Number(key.slice(PORT_CAPABILITY_KEY_PREFIX.length)));
      // A public capability leaves the routing directory with the row —
      // before the reservation is released so a mid-removal crash leaves a
      // dead URL rather than a dangling route to this session.
      if (record?.owner === owner && record.visibility === 'public' && typeof record.capability === 'string') {
        await unbindPublicPortCapability(this._publicDirectoryHost(), record.capability);
      }
    }

    for (const port of ownedPorts) {
      // A port stamp is not ownership. Release only a reservation that still
      // belongs to this owner, and never unregister somebody else's listener.
      if ((await readPortReservation(this.ctx, port))?.owner !== owner) continue;
      await releasePortReservation(this.ctx, { owner, port });
      const live = this.portRegistry.get(port);
      if (live && ownedPids.includes(live.pid)) this.portRegistry.unregister(port);
    }

    const imageRows = await this.ctx.storage.list<Array<{ runner: string; application: string }>>({ prefix: DURABLE_IMAGES_KEY_PREFIX });
    const ownedImages = [...(imageRows.get(`${DURABLE_IMAGES_KEY_PREFIX}${owner}`) ?? [])];
    const retainedImages = [...imageRows].filter(([key]) => key !== `${DURABLE_IMAGES_KEY_PREFIX}${owner}`).flatMap(([, images]) => images);
    for (const row of journalRows.values()) {
      if (row.recipe.kind !== 'worker') continue;
      (residentOwner(row) === owner ? ownedImages : retainedImages).push(row.recipe.image);
    }
    const imagesPurged = this.vfs ? purgeDurableWorkerImages(this.vfs, ownedImages, retainedImages) : 0;
    await this.ctx.storage.delete(`${DURABLE_IMAGES_KEY_PREFIX}${owner}`);
    await this.ctx.storage.delete(`${RESIDENT_OWNER_KEY_PREFIX}${owner}`);

    const purged = await this.launchJournal.purgeWhere(
      (record) => residentOwner(record) === owner,
    );

    const name = await freeDurableFacetSlot(this.ctx, owner, (slot) => deleteFacetStorage(this.ctx, slot));
    return name !== null || purged > 0 || ownedPorts.size > 0 || imagesPurged > 0;
  }

  /** The session-shaped view the public-directory helpers read env from. */
  private _publicDirectoryHost(): { env: unknown; ctx: { id?: { name?: unknown } } } {
    return { env: this.env.rawEnv, ctx: this.ctx };
  }
  /**
   * Whether a request addressed to `port` can reach a durable application —
   * and, when the application is journaled but dead, drive its re-drive and
   * wait for the boot, bounded.
   *
   * The port request is the one surface a reset leaves dark: the alarm pump
   * re-drives journaled launches eventually, but a URL a user is holding
   * cannot wait for an alarm that may never fire. 'started' means a live
   * process owns the port now; 'absent' means nothing durable claims it
   * (the caller answers 502 as it always has); 'failed' means a re-drive
   * ran and lost, or outlived its bound — the caller answers 503 and lets
   * the page re-ask.
   *
   * Single-flight per port: parallel requests on a woken page share one
   * ensure, which shares the journal's per-row drive with recovery — a
   * request that lands mid-recovery waits on that boot, it never boots a
   * second process.
   */
  ensureDurableAppOnPort(port: number): Promise<'started' | 'absent' | 'failed'> {
    let inflight = this.ensureInflight.get(port);
    if (inflight === undefined) {
      inflight = this._ensureDurableAppOnPort(port);
      this.ensureInflight.set(port, inflight);
      inflight.finally(() => {
        if (this.ensureInflight.get(port) === inflight) this.ensureInflight.delete(port);
      });
    }
    return inflight;
  }

  private async _ensureDurableAppOnPort(port: number): Promise<'started' | 'absent' | 'failed'> {
    if (this.portRegistry.has(port)) return 'started';
    // The journal row is what makes a port a launch this instance owes —
    // reservation or not: every resident's row is stamped with the port it
    // bound, so any of them re-drives on request. A port with no stamped
    // row (nothing ever bound it, or the app was removed and its rows
    // purged) answers absent — nothing here can bring back an application
    // with no recipe. When more than one row names the port, the
    // reservation's owner wins; otherwise the newest launch does.
    const reservation = await readPortReservation(this.ctx, port);
    const rows = await this.launchJournal.rows();
    const candidates = [...rows].filter(([, record]) => record.port === port);
    const ownerRow = reservation !== null && reservation.owner !== null
      ? candidates.find(([, record]) => residentOwner(record) === reservation.owner)
      : undefined;
    const entry = ownerRow ?? candidates.sort(([, a], [, b]) => b.pid - a.pid)[0];
    if (entry === undefined) return 'absent';
    const [rowKey, record] = entry;

    if (record.pid > this.processes.pidBase) {
      // This instance's own row. A process still launching or running will
      // bind the port: waiting for its registration is the entire ask, and
      // driving the row again would boot a second copy. One that has ended
      // is owed the port only if its restart policy runs it again; otherwise
      // its row is being released (_onResidentTerminal), and nothing will.
      if (this.processes.get(record.pid)?.state === 'exited' && record.restart !== 'on-failure') return 'absent';
      return (await this._waitForPort(port, DURABLE_ENSURE_BOOT_BUDGET_MS))
        ? 'started' : 'failed';
    }

    const { promise: boundHit, resolve: markBound } = withResolvers<true>();
    setTimeout(() => markBound(true), DURABLE_ENSURE_BOOT_BUDGET_MS);
    const failed = await Promise.race([
      // A previous instance's row: the session restarted under it.
      this.launchJournal.drive(rowKey, record, { kind: 'session-restart' }),
      boundHit,
    ]);
    if (failed) return 'failed';
    // A settled drive either owns the port or deliberately answered 'gone':
    // a resolver's null superseded the row, which is absent, not failed.
    return this.portRegistry.has(port) ? 'started' : 'absent';
  }

  /** Poll for a port registration the in-flight launch has not made yet. */
  private async _waitForPort(port: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (this.portRegistry.has(port)) return true;
      const { promise: tick, resolve: tickDone } = withResolvers();
      setTimeout(tickDone, 50);
      await tick;
    }
    return this.portRegistry.has(port);
  }

  get stats() { return { ...this.processes.stats, readProfileConflicts: this.readProfileConflicts }; }
}
