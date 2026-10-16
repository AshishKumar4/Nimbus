/**
 * isolate-pool.ts — Nimbus loader-isolate pool based on cloudflare-parallel.
 *
 * Adds Nimbus-specific behavior to the upstream pool design:
 *   1. **Stable-slot isolate reuse**. Upstream's #counter++ gives every
 *      dispatch a fresh isolate — fine for one-off AI calls, terrible for
 *      running 67 npm tarball extractions (cold-start dominates). We pin
 *      each job to `slot = cursor % concurrency` and use stable loader
 *      IDs `nfp:${fnHash}:slot-${i}:g${generation}`, so a pool of
 *      concurrency=N keeps at most N warm isolates rather than one per job.
 *   2. **Nimbus defaults**: compatibilityDate = CF_COMPAT_DATE (matches
 *      the supervisor worker), compatibilityFlags = GUEST_COMPAT_FLAGS,
 *      globalOutbound = the egress of the pool's `network` when it has
 *      one, else absent (`ISOLATE_NETWORK`: the parent's network, which
 *      reaches https://registry.npmjs.org without a proxy binding).
 *   3. **Supervisor autoinjection**. The pool grabs the embedder's
 *      registered supervisor entrypoint stub (see `supervisorEntrypoint` in
 *      composition.ts) and forwards it as `env.SUPERVISOR` to every facet,
 *      same pattern as git/network-facet.ts. Callers can add more bindings
 *      via `extraBindings`.
 *   4. **Fail-loud defaults**: timeout 60s, retries 0, a map rejects on its first failure, once all it started have settled.
 *      Caller opts in to leniency.
 *
 * The vendored directory contains only the upstream serialization, error,
 * and binding types used by this implementation.
 */

import { loaderOutbound, requireNetwork, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { supervisorEntrypoint, type HostRoute } from './composition.js';
import { infrastructureSupervisorProps, supervisorLoaderKey, mintProcessSupervisor, type SupervisorBindingProps } from './supervisor-props.js';
import { applyFacetLimits, facetCallDeadlineMs, facetLimits, facetLoaderKey, type FacetKind } from './facet-limits.js';
import { unsettledEnd } from '@nimbus-sh/core/_shared/process-fs-client.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hashSource } from './vendor/serialize.js';
import { requireFacetTaskSource, type FacetTaskSource } from '@nimbus-sh/core/runtime/facet-task.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import {
  beginLoaderFetch,
  readmitRefused,
  claimAdmission,
  withDynamicWorkerCapNamed,
  type DynamicWorkerClaim,
  type EndLoaderFetch,
} from './budgets.js';
import { assertModuleMapWithinCodeLimit } from './budgets.js';
import { recordFailure, setLastFacetId, getLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import {
  BindingError,
  ExecutionError,
  RetryExhaustedError,
  TimeoutError,
} from './vendor/errors.js';
import type { FacetBindings } from '@nimbus-sh/core/runtime/facet-host.js';
import type { ModuleContent, WorkerLoader } from './vendor/types.js';
import { hostWasmIdentity } from './host-wasm.js';


/** The one binding a pool needs off whichever env its host hands it. */
export interface IsolatePoolEnv {
  LOADER?: WorkerLoader;
}

/** Options handed to IsolatePool's constructor. */
export interface IsolatePoolOptions {
  /** Policy for this pool's loaded workers; generic submitted code is an isolate. */
  facetKind?: FacetKind;
  /**
   * Maximum concurrent in-flight facets, each a distinct Dynamic Worker
   * spent from the hosting DO's `DO_DYNAMIC_WORKER_LIMIT`. Default 1; a
   * caller that wants more sizes it against that budget (Fanout does).
   */
  concurrency?: number;
  /**
   * The width the caller claimed for this pool's dispatches
   * (`claimDynamicWorkers`): they are held inside it rather than on top of
   * it, and a refused one waits for a slot of the claim.
   */
  claim?: DynamicWorkerClaim;
  /**
   * Per-task wall timeout in ms; 0 is none. Defaults to this facet kind's
   * call deadline (facetCallDeadlineMs), and to none for a kind that runs
   * processes, which have no wall deadline.
   */
  timeoutMs?: number;
  /**
   * Per-task retry attempts AFTER the initial failure. Default 0.
   * Set to a small number only if transient RPC errors are common.
   */
  retries?: number;
  /**
   * Additional bindings forwarded to each facet. These merge on top of the
   * default `{ SUPERVISOR: supervisorRpc({ doId, pid:0 }) }`. Use this to
   * give facets access to KV, R2, AI, or additional supervisor-level APIs.
   */
  extraBindings?: Record<string, unknown>;
  /**
   * Optional tag used in loader IDs for debugging (e.g. "npm-install").
   * Does NOT affect isolate identity — same fn + same tag = same slot.
   */
  tag?: string;
  /**
   * If true, omit the default SUPERVISOR binding. Use this for pools
   * that don't need DO callbacks (e.g. a pure CPU compute pool).
   */
  omitSupervisor?: boolean;
  /**
   * Loader cache scope. Defaults to `session`, which bakes the owning DO id
   * into the loader key so stateful facets cannot leak bindings or globals
   * across sessions. Use `global` only for stateless compute modules that do
   * not receive a Supervisor binding and do not retain user state.
   */
  cacheScope?: 'session' | 'global';
  /**
   * The network the pool's facets use. For a pool that runs work on behalf
   * of a workspace (its registry fetches, a program's requests), the
   * workspace's (`workspace.network`); the pool takes its supervisor
   * process's own from it (WorkspaceNetwork.forProcess), whose egress
   * becomes each facet's globalOutbound and whose id is baked into the
   * loader id, so a warm isolate made under one egress never serves another. Nimbus's own work
   * states `ISOLATE_NETWORK`: the facets keep the parent's network. Required,
   * so each pool's network is chosen where it is made.
   */
  network: WorkspaceNetwork;
  /**
   * Baked into the loader id. Two pools sharing tag, preamble, wasm and
   * supervisor but differing in `scope` never reuse each other's warm
   * workers: an interpreter scope that ENDS (REPL close, Ctrl-C reset)
   * must not resurrect the loader-cached heap for the next owner.
   * Default '' preserves the existing id bytes — only scoped pools get
   * the extra segment.
   */
  scope?: string;
  /**
   * Override the `doId` baked into the auto-injected SUPERVISOR binding.
   * Default: `ctx.id.toString()` (the DO that constructs the pool).
   *
   * Used by Fanout's peer-DO branch (peer-DO fanout): peer DOs
   * construct their per-task IsolatePool from inside
   * `executeFanoutShard`, where `ctx` is the PEER DO's ctx. Without this
   * override the peer's auto-injected SUPERVISOR routes back to the
   * peer DO itself — so writes (e.g. install-batch-facet's
   * writeBatchStream) land in the peer's VFS instead of the
   * COORDINATOR's. The user's terminal session is on the coordinator;
   * writes-to-peer are invisible. See INSTALL-HONESTY-retro.md.
   *
   * When set, the auto-injected supervisor binding uses this string as the
   * `props.doId`, routing all SUPERVISOR.* calls back to the
   * coordinator. Effective only when `omitSupervisor !== true`.
   */
  supervisorDoIdOverride?: string;
  /**
   * The coordinator's route, forwarded with `supervisorDoIdOverride`: the
   * binding is the coordinator's, so its way back is the coordinator's
   * too, whatever this peer's isolate composed.
   */
  supervisorRoute?: HostRoute;
  /**
   * Process pid baked into the auto-injected SUPERVISOR binding's props.
   * The supervisor derives the write credential from this pid
   * (`SupervisorRPC[PID]()` → `processes.cred(pid)`), so any facet that
   * calls a filesystem RPC (`writeBatchStream`, `writeFile`, …) must be
   * dispatched with the invoking process's real pid — otherwise the RPC
   * throws "missing or invalid process pid in props". npm install threads
   * the shell command's `ctx.pid` here so package files land as the user.
   * Left 0 (default) for pools whose facets touch only cache/registry RPCs
   * (npm resolve, pre-bundle), which never call `[PID]()`.
   */
  supervisorPid?: number;
  /** A runtime program's explicit pid/run capability; helpers keep their infrastructure binding. */
  processSupervisor?: SupervisorBindingProps;
  /**
   * Hand the SUPERVISOR binding to each call (`execute`'s second argument,
   * merged into the function's env) instead of the worker's env. The loader
   * key then names no process, so a warm worker made for one process's call
   * can serve the next process's, and never holds a capability between them.
   * Only an RPC dispatch carries it: `submitRequest` refuses such a pool.
   */
  supervisorPerCall?: boolean;
  /**
   * Raw JavaScript source prepended to every generated worker module.
   * Lets callers inject bundled helpers, such as a tar parser. The user
   * function can reference top-level names declared in the preamble as if
   * they were in lexical scope.
   *
   * Example: `preamble: 'export const parse = ...; const helper = ...;'`
   * — the preamble runs at module-load time; any side effects happen
   * inside the facet isolate.
   *
   * Preamble text is bytes-stable for a given pool — it's part of the
   * loader-cache key (fnHash), so changing the preamble invalidates all
   * warm slots.
   */
  preamble?: string;
  /**
   * WebAssembly modules to ship into the facet via the LOADER's
   * `modules` map. Map keys are module specifier paths (e.g.
   * `'esbuild.wasm'`); values are the raw bytes, or a module the host
   * already holds compiled.
   *
   * Workerd registers each entry as `{ wasm }` in the worker's modules
   * map. The pool prepends a static
   * `import __NIMBUS_WASM_<id> from './<key>';` to the generated
   * worker.js; bytes are compiled at the facet's module-load (startup
   * phase, where wasm code generation is permitted), and a compiled
   * module is shared with the facet as is, its compiled code included
   * (workerd src/workerd/api/worker-loader.c++,
   * extractWasmModuleContent). The Modules are exposed via
   * `globalThis.__NIMBUS_WASM[<key>]` for the user function to read at
   * request time.
   *
   * Why this works when other paths don't:
   *   - request-time `WebAssembly.compile()` — disallowed by workerd
   *     in this deploy.
   *   - request-time RPC of a pre-compiled Module — workerd
   *     structured-clone refuses ("Unable to deserialize cloned data").
   *   - inlining bytes in the preamble — 16 MiB string per dispatch
   *     OOMs the supervisor at module-source allocation time.
   *   - LOADER modules-map (this) — the module rides INSIDE the worker
   *     code blob, never crossing structured-clone, never executing JS
   *     eval.
   *
   * A compiled module must be described (host-wasm.ts describeHostWasm):
   * its identity keys warm slots, as the bytes' fingerprint does, and its
   * size counts toward the dynamic-worker code limit.
   */
  wasmModules?: Record<string, ArrayBuffer | WebAssembly.Module>;
}

/** Per-call override (merged with pool defaults). */
export interface IsolateCallOptions {
  timeoutMs?: number;
  retries?: number;
  /**
   * Per-call WebAssembly modules. Merged with the pool's
   * constructor-time `wasmModules` at dispatch time and shipped via
   * the LOADER's modules map (same `{ wasm: ArrayBuffer }` shape).
   *
   * Shipping path validated empirically against prod (see
   * `WebAssembly.instantiate(bytes)` is blocked at request-time but
   * the LOADER-modules path compiles bytes during the inner
   * worker's module-load phase, where wasm code generation IS
   * permitted. The bytes ride INSIDE the worker code blob; workerd
   * never crosses structured-clone, never executes user-eval.
   *
   * Cache key impact: per-call bytes are identified as constructor
   * bytes are (name, length, SHA-256; wasmIdentity) and folded into
   * the loader cache key. Identical bytes on the same
   * slot → warm reuse; different bytes → fresh isolate. The pool's
   * `wasmHash` field captures CONSTRUCTOR-time bytes only; per-call
   * bytes get their own fingerprint mixed into the slot id at dispatch.
   *
   * Naming collision rule: a per-call key MUST NOT collide with a
   * constructor-time key (after identifier sanitisation). The
   * dispatch path throws BindingError if it does — silently
   * shadowing the constructor's wasm would break the cache-key
   * invariant downstream callers rely on.
   *
   * Used by the `wasm-runner` shell command in src/runtime/
   * wasm-runner.ts to ship user-supplied .wasm bytes from VFS into
   * a fresh facet isolate per invocation.
   */
  wasmModules?: Record<string, ArrayBuffer>;
}

/** Per-map override. */
export interface IsolateMapOptions extends IsolateCallOptions {
  /** Concurrency override for this call. Defaults to pool's concurrency. */
  concurrency?: number;
}

/** One item's outcome: its value, or what it failed with. */
export type Settled<R> = { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: Error };

interface ResolvedResilience {
  timeoutMs: number;
  retries: number;
}

/** Result ownership shared by guest tasks that call the supervisor. */
const FACET_RPC_PREAMBLE = [
  'const __nimbusDisposeRpcResult = (value) => {',
  '  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;',
  '  const dispose = value[Symbol.dispose];',
  '  if (typeof dispose === "function") { try { dispose.call(value); } catch {} }',
  '};',
  'const __nimbusUseRpcResult = async (promise, use) => {',
  '  const value = await promise;',
  '  try { return await use(value); }',
  '  finally { __nimbusDisposeRpcResult(value); }',
  '};',
].join('\n');

export interface LoaderWorkerModuleSourceOptions {
  fnSource: string;
  preamble?: string;
  wasmEntries?: ReadonlyArray<{ name: string; id: string }>;
  hasBindings: boolean;
  /** `execute(arg, bindings)`: the call's bindings, over the worker's env (IsolatePoolOptions.supervisorPerCall). */
  callBindings?: boolean;
}

/** Assemble the exact JavaScript module parsed by a dynamic loader worker. */
export function assembleLoaderWorkerModuleSource(
  options: LoaderWorkerModuleSourceOptions,
): string {
  const lines: string[] = [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
  ];
  const wasmEntries = options.wasmEntries ?? [];

  if (wasmEntries.length > 0) {
    lines.push('');
    lines.push('// ── Pool-injected WebAssembly modules ─────────────────────');
    for (const entry of wasmEntries) {
      lines.push(`import __NIMBUS_WASM_${entry.id} from ${JSON.stringify(`./${entry.name}`)};`);
    }
    lines.push('globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};');
    for (const entry of wasmEntries) {
      lines.push(
        `globalThis.__NIMBUS_WASM[${JSON.stringify(entry.name)}] = __NIMBUS_WASM_${entry.id};`,
      );
    }
    lines.push('// ── End pool-injected WebAssembly modules ─────────────────');
  }

  lines.push(
    '',
    FACET_RPC_PREAMBLE,
    '',
  );
  if (options.preamble) {
    lines.push(
      '// ── Preamble (pool-level helpers) ─────────────────────────',
      options.preamble,
      '// ── End preamble ──────────────────────────────────────────',
      '',
    );
  }
  lines.push(`const __fn__ = ${options.fnSource};`);
  lines.push('');
  const callExpr = options.callBindings
    ? '__fn__(args[0], { ...this.env, ...args[1] })'
    : options.hasBindings
      ? '__fn__(...args, this.env)'
      : '__fn__(...args)';
  const requestCallExpr = options.hasBindings
    ? '__fn__(request, this.env)'
    : '__fn__(request)';
  lines.push(
    'export default class extends WorkerEntrypoint {',
    '  execute(...args) {',
    `    return ${callExpr};`,
    '  }',
    '',
    '  // Request/Response transport: the ONE dispatch path whose abort is',
    '  // real. workerd cancels the inner execution context when the request',
    '  // signal aborts while the fn is suspended on I/O; RPC execute() above',
    '  // has no equivalent (measured: Symbol.dispose on a pending RPC does',
    '  // not cancel). The fn is request-shaped — it encodes and decodes its',
    '  // own payload; nothing generic is serialized here.',
    '  async fetch(request) {',
    '    try {',
    `      const result = await ${requestCallExpr};`,
    '      if (result instanceof Response) return result;',
    '      return Response.json(result ?? null);',
    '    } catch (err) {',
    '      // Fail loud inside the response so an abort of the transport is',
    '      // not conflated with a guest exception: the caller sees 500 only',
    '      // for a real fn failure, and aborts arrive as fetch rejections.',
    '      const message = err instanceof Error && err.message ? err.message : String(err);',
    '      return Response.json({ __nimbusFacetError: message }, { status: 500 });',
    '    }',
    '  }',
    '}',
  );
  return lines.join('\n');
}

/** One image in a loader cache key: a host-compiled module's described identity, or bytes to digest. */
type WasmKeyPart = string | { name: string; bytes: ArrayBuffer };

/** A wasm module of the generated worker: the name it is imported by, and the identifier its import binds. */
interface WasmEntry<W> {
  name: string;
  id: string;
  wasm: W;
}

/**
 * `name`'s entry, its identifier being the name with every character an
 * identifier cannot hold replaced. Two names whose identifiers agree would
 * bind one import twice, so a name is refused when `bound` already holds
 * its identifier (keyed to who took it), and recorded there otherwise.
 */
function wasmEntry<W>(name: string, wasm: W, bound: Map<string, string>, scope: string): WasmEntry<W> {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
  const holder = bound.get(id);
  if (holder !== undefined) {
    throw new BindingError(
      `IsolatePool: ${scope} key '${name}' and ${holder} both bind the identifier ${id}. Pick distinct module names.`,
    );
  }
  bound.set(id, `${scope} key '${name}'`);
  return { name, id, wasm };
}

/**
 * The images' part of a loader cache key: '0' for none, so a pool without
 * wasm keeps one stable key, else the SHA-256 of every image's name and
 * identity. Bytes are identified by their SHA-256, never by a short hash: a
 * key two images share runs one image's module for the other. clang's ./a
 * and ./b were both 7572 bytes with equal first and last bytes, differing
 * only at offset 651, and a length+endpoints key ran ./a's module for ./b.
 */
async function wasmIdentity(parts: readonly WasmKeyPart[]): Promise<string> {
  if (parts.length === 0) return '0';
  const described = await Promise.all(parts.map(async (part) => (typeof part === 'string'
    ? part
    : `${part.name}:${part.bytes.byteLength}:${await sha256Hex(part.bytes)}`)));
  return sha256Hex(described.join('|'));
}

/**
 * Nimbus-scoped parallel dispatch over `env.LOADER`. Tasks are pure
 * functions whose last argument is an `env` object containing the
 * forwarded bindings (default: `{ SUPERVISOR }`).
 *
 * Typical use:
 *
 *   const pool = new IsolatePool(env, ctx, {
 *     concurrency: 2,
 *     tag: 'npm-install',
 *     network: workspace.network,
 *   });
 *   const results = await pool.map(
 *     async (pkg, env) => env.SUPERVISOR.writeBatch(buildPayload(pkg)),
 *     toFetch,
 *   );
 */
export class IsolatePool {
  private readonly loader: WorkerLoader;
  /** The hosting actor, as the loader budget ledger's per-DO key. */
  private readonly ctx: DurableObjectState;
  /** The width this pool's dispatches are held inside (IsolatePoolOptions.claim). */
  private readonly claim: DynamicWorkerClaim | undefined;
  private readonly concurrency: number;
  readonly defaultTimeoutMs: number;
  private readonly facetKind: FacetKind;
  private readonly defaultRetries: number;
  private readonly tag: string;
  private readonly slotGenerations = new Map<number, number>();
  /**
   * Per-slot execution ownership: the tail of each slot's in-flight
   * dispatch chain. Two dispatches on the same warm isolate at once
   * interleave on its QueueState — map() callers used to trust the
   * caller's slot round-robin, which could not prevent submit() (slot
   * 0) or a second map() landing on a slot a task still occupied. Every
   * dispatch now waits for the slot's previous execution to settle
   * before touching it.
   */
  private readonly slotTails = new Map<number, Promise<void>>();
  /** Set by dispose() — queued dispatches reject instead of running. */
  private disposed = false;
  private bindings: Record<string, unknown> | undefined;
  /** The bindings each call carries (IsolatePoolOptions.supervisorPerCall). */
  private callBindings: { SUPERVISOR: unknown } | undefined;

  private readonly preamble: string | undefined;
  private readonly preambleHash: string;
  /**
   * WASM modules to ship in the LOADER `modules` map. See
   * IsolatePoolOptions.wasmModules for the rationale. Stored in
   * insertion order so the per-import preamble we generate matches
   * across pool dispatches (cache-key stability).
   */
  private readonly wasmModules: Array<WasmEntry<ArrayBuffer | WebAssembly.Module>>;
  /** The identifiers wasmModules bind, each to the key that took it: a per-call module takes none of them. */
  private readonly wasmIds = new Map<string, string>();
  /** Every constructor-time wasm module, as the loader cache key names it
   *  (wasmIdentity), so a change invalidates warm slots: a compiled module
   *  by the identity its host described, bytes by their SHA-256. Bytes are
   *  not pinned at deploy time: an interpreter image can be read from the
   *  filesystem. */
  private readonly wasmKeyParts: WasmKeyPart[];
  /** wasmIdentity of wasmKeyParts, digested on the first dispatch. */
  #wasmHash: Promise<string> | null = null;
  /**
   * Short prefix of the owning DO's id, baked into the loader.get()
   * cache key so warm isolates are scoped to ONE session. Without this,
   * session A's pool and session B's pool (same `tag` + `fnHash`) share
   * an isolate — which means B's writeBatch RPCs routed through A's
   * env.SUPERVISOR binding (minted with A's doId at construction
   * time). B's install reports success but the writes land in A's VFS,
   * leaving B with only the git-clone seed files (~119 instead of ~1491).
   * 12 chars is enough entropy for DO ids to collide-free per process.
   */
  private readonly doIdShort: string;
  /**
   * The supervisor identity the minted worker's env.SUPERVISOR binding
   * bakes (doId short-form + pid), folded into the loader cache key. 's-none'
   * when no SUPERVISOR binding was minted, so a supervisor-less pool keeps
   * the old key shape and its warm slots stay shared.
   */
  private readonly supervisorKey: string;

  /** Extra loader-id segment from options.scope — see IsolatePoolOptions. */
  private readonly scope: string;
  /** IsolatePoolOptions.network: each facet's outbound, and a loader-id segment. */
  private readonly network: WorkspaceNetwork;
  /** The process the pool's facets write as, when they are bound to one (supervisorPid). */
  private readonly writerPid: number | undefined;
  constructor(
    env: unknown,
    ctx: DurableObjectState,
    opts: IsolatePoolOptions,
  ) {
    // A host hands its whole env over; the binding is claimed here and the
    // claim is checked on the next line.
    const loader = (env as IsolatePoolEnv | null | undefined)?.LOADER;
    if (!loader || typeof loader.get !== 'function') {
      throw new BindingError(
        'IsolatePool: env.LOADER binding missing or invalid. ' +
          'Add a [[worker_loaders]] entry to wrangler.jsonc.',
      );
    }
    this.loader = loader;
    this.ctx = ctx;
    this.claim = opts.claim;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.facetKind = opts.facetKind ?? 'isolate';
    this.defaultTimeoutMs = opts.timeoutMs ?? facetCallDeadlineMs(this.facetKind) ?? 0;
    this.defaultRetries = Math.max(0, opts.retries ?? 0);
    this.tag = opts.tag ?? 'facet';
    this.writerPid = opts.omitSupervisor || opts.supervisorPid === undefined ? undefined : opts.supervisorPid;
    this.preamble = opts.preamble;
    // Include preamble in the cache-bucket key so changes to bundled helpers
    // invalidate warm slots. Empty preamble → '0' suffix (stable).
    this.preambleHash = this.preamble ? hashSource(this.preamble) : '0';
    this.doIdShort = opts.cacheScope === 'global'
      ? 'global'
      : ctx.id.toString().slice(0, 12);
    this.scope = opts.scope ?? '';
    // The network of the process the pool's facets act for (WorkspaceNetwork.forProcess), the one its binding carries.
    this.network = requireNetwork(opts.network, 'IsolatePool').forProcess(opts.processSupervisor?.pid ?? opts.supervisorPid ?? 0);

    // The wasm-modules table, in the order given.
    const wasmEntries: Array<WasmEntry<ArrayBuffer | WebAssembly.Module>> = [];
    const keyParts: WasmKeyPart[] = [];
    if (opts.wasmModules) {
      for (const [name, wasm] of Object.entries(opts.wasmModules)) {
        let keyPart: WasmKeyPart;
        if (wasm instanceof ArrayBuffer) {
          keyPart = { name, bytes: wasm };
        } else if (wasm instanceof WebAssembly.Module) {
          const identity = hostWasmIdentity(wasm);
          if (!identity) {
            throw new BindingError(
              `IsolatePool: wasmModules['${name}'] is a WebAssembly.Module nobody described; ` +
              'pass it through describeHostWasm (@nimbus-sh/fabric/host-wasm.js) so warm slots ' +
              'can be keyed by it and the code limit can count it.',
            );
          }
          keyPart = `${name}:host:${identity.id}:${identity.bytes}`;
        } else {
          // Reached only when a caller broke the declared option type, so the
          // value is whatever it really was rather than the union here.
          const got = (wasm as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;
          throw new BindingError(
            `IsolatePool: wasmModules['${name}'] must be an ArrayBuffer or a WebAssembly.Module ` +
            `(got ${got || typeof wasm}).`,
          );
        }
        wasmEntries.push(wasmEntry(name, wasm, this.wasmIds, 'pool wasmModules'));
        keyParts.push(keyPart);
      }
    }
    this.wasmModules = wasmEntries;
    this.wasmKeyParts = keyParts;

    const bindings: Record<string, unknown> = { ...(opts.extraBindings ?? {}) };
    this.supervisorKey = 's-none';
    if (!opts.omitSupervisor) {
      const supervisorRpc = supervisorEntrypoint();
      if (supervisorRpc) {
        // INSTALL-HONESTY: peer-DO branch supplies coordinator's doId
        // via supervisorDoIdOverride so SUPERVISOR.* RPCs route back
        // to the user's session DO, not the peer DO. Default to the
        // local ctx.id (single-DO callers and the in-DO in-DO fanout path).
        // A helper's binding acts as no run, on the pool's network
        // (IsolatePoolOptions.network): its SUPERVISOR calls that reach the
        // network for the workspace (an npm packument read) go out through
        // the same egress as the facet.
        const supervisor = opts?.processSupervisor ?? infrastructureSupervisorProps(ctx, opts?.supervisorPid ?? 0, {
          doId: opts?.supervisorDoIdOverride,
          route: opts?.supervisorRoute,
          network: this.network,
        });
        const minted = opts?.processSupervisor
          ? mintProcessSupervisor(supervisorRpc, opts.processSupervisor) : supervisorRpc({ props: supervisor });
        if (opts.supervisorPerCall) this.callBindings = { SUPERVISOR: minted };
        else bindings.SUPERVISOR = minted;
        // Whatever the minted worker's env carries must be in its loader
        // cache key — workerd's loader cache survives a DO hibernation
        // wake while generation-strided pids (1000001 → 2000001) do not:
        // a warm slot keyed without the supervisor identity returns in
        // the new generation still credentialed to the dead pid, and
        // every pid-authorized RPC from it fails "process pid … does
        // not exist". doIdShort alone cannot cover this — it changes
        // across sessions, not across wakes of the same session. So does
        // the instance a binding delivers mutations to, when it names one.
        const run = supervisor.bindingKind === 'process' ? `:${supervisor.writerId}` : '';
        this.supervisorKey = this.callBindings === undefined
          ? supervisorLoaderKey(`s${supervisor.doId.slice(0, 12)}-${supervisor.pid}${run}`, supervisor)
          : 's-call';
      } else {
        // Supervisor entrypoint unavailable — running without ctx.exports
        // (e.g. unit-test harness, or LOADER.load contexts where the
        // bindings.SUPERVISOR auto-wire isn't set up). We still construct
        // the pool but the facet will get env.SUPERVISOR === undefined.
        // Callers that need SUPERVISOR should check availability before
        // dispatch. (A facet that tries to call env.SUPERVISOR.writeBatch
        // will throw a plain TypeError; that's the clearest failure mode.)
      }
    }
    this.bindings = Object.keys(bindings).length > 0 ? bindings : undefined;
  }

  /** Effective concurrency used when no per-call override is supplied. */
  get defaultConcurrency(): number {
    return this.concurrency;
  }

  #resolve(opts?: IsolateCallOptions): ResolvedResilience {
    return {
      timeoutMs: Math.max(0, opts?.timeoutMs ?? this.defaultTimeoutMs),
      retries: Math.max(0, opts?.retries ?? this.defaultRetries),
    };
  }

  /**
   * The call's own wasm modules, as entries after the pool's: bytes only,
   * and none may bind an identifier the pool's modules bind.
   *
   * Returns [] when there are no per-call entries — that's the hot
   * path (every existing pool dispatch).
   */
  #materialisePerCallWasm(
    perCall: Record<string, ArrayBuffer> | undefined,
  ): Array<WasmEntry<ArrayBuffer>> {
    if (!perCall) return [];
    const out: Array<WasmEntry<ArrayBuffer>> = [];
    const bound = new Map(this.wasmIds);
    for (const [name, bytes] of Object.entries(perCall)) {
      if (!(bytes instanceof ArrayBuffer)) {
        const got = (bytes as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;
        throw new BindingError(
          `IsolatePool: per-call wasmModules['${name}'] must be ` +
            `ArrayBuffer (got ${got || typeof bytes}).`,
        );
      }
      out.push(wasmEntry(name, bytes, bound, 'per-call wasmModules'));
    }
    return out;
  }

  /**
   * Build the WorkerCode blob that the loader callback will return.
   * Same bytes every time for a given function and slot, allowing workerd
   * to reuse the isolate.
   *
   * Always prepends the ESBUILD_RUNTIME_SHIM so stringified functions that
   * reference esbuild-emitted helpers (__name, __defProp, etc.) don't
   * crash the facet with "__name is not defined". User preambles are
   * appended below the shim.
   */
  #buildCode(
    fnSource: string,
    perCallWasmEntries?: Array<WasmEntry<ArrayBuffer>>,
  ) {
    const workerOpts = {
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: [...GUEST_COMPAT_FLAGS],
      env: this.bindings,
    };

    // ── WASM module imports ───────────────────────────────────────────
    // Each entry in `wasmModules` (constructor-time + per-call) is
    // registered in the LOADER's modules map (below) as
    // `{ wasm: ArrayBuffer }`. workerd compiles each during the
    // worker's module-load phase (eval permitted there) and the
    // standard ESM import binding receives the resulting
    // WebAssembly.Module. We expose them on `globalThis.__NIMBUS_WASM`
    // so the user fn can read them at request time without having to
    // re-import (task expressions bind only the guest's supplied modules).
    //
    // Per-call entries (passed via IsolateCallOptions.wasmModules
    // — used by the wasm-runner shell command) are appended to the same
    // table. Naming collision with constructor entries is rejected
    // upstream in #materialisePerCallWasm so the import block here
    // doesn't have to deduplicate.
    const allWasmEntries = [
      ...this.wasmModules,
      ...(perCallWasmEntries ?? []),
    ];
    const moduleSource = assembleLoaderWorkerModuleSource({
      fnSource,
      preamble: this.preamble,
      wasmEntries: allWasmEntries,
      hasBindings: this.bindings !== undefined,
      callBindings: this.callBindings !== undefined,
    });

    // Modules map: the entry worker.js source plus any wasm modules the
    // pool was constructed with. Workerd parses the modules map at
    // worker-load time and resolves the static `import` statements
    // we generated above against this map. The wasm-shape entry
    // (`{ wasm: ArrayBuffer }`) tells workerd to compile during the
    // module-load phase — the only phase where wasm code generation
    // is permitted in this deploy.
    //
    // Per-call entries are appended after constructor entries so the
    // map order matches the import order in the generated worker.js
    // (matters only for human-readable diffs; workerd doesn't care).
    const modules: Record<string, ModuleContent> = { 'worker.js': moduleSource };
    for (const w of allWasmEntries) {
      modules[w.name] = { wasm: w.wasm };
    }
    assertModuleMapWithinCodeLimit(modules);

    return {
      compatibilityDate: workerOpts.compatibilityDate,
      compatibilityFlags: workerOpts.compatibilityFlags,
      mainModule: 'worker.js',
      modules,
      env: workerOpts.env,
      // The workspace's egress when the pool works for one; else the key is
      // absent and the facet inherits the parent's network.
      ...loaderOutbound(this.network),
    } as const;
  }

  /**
   * Dispatch a single task to the slot isolate. `slotIndex` picks which
   * warm isolate services the call; callers round-robin slots themselves.
   * Serialized per slot: this call waits for the slot's previous
   * execution to settle before touching the warm isolate.
   *
   * `invoke` is the single-attempt call against the slot's entrypoint
   * stub. `execute` dispatches call `entrypoint.execute(...args)`;
   * `fetch` dispatches call `entrypoint.fetch(<per-attempt Request>)` —
   * the attempt index lets a fetch invoke mint a fresh clone for retries,
   * since a Request's body is consumed once.
   */
  async #dispatchSlot<T>(
    fnSource: string,
    fnHash: string,
    slotIndex: number,
    invoke: (entrypoint: { execute(...args: unknown[]): Promise<unknown>; fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }, attempt: number) => Promise<T>,
    resilience: ResolvedResilience,
    perCallWasm?: Record<string, ArrayBuffer>,
    signal?: AbortSignal,
    /** Collects this dispatch's tail: it settles once every execution the dispatch started has. */
    tails?: Promise<void>[],
  ): Promise<T> {
    // A warm slot executes one dispatch at a time: queue behind the
    // previous owner, then record this dispatch as the new tail. The
    // tail outlives the caller's outcome: a timeout rejects the
    // Promise.race while runOnce's RPC is still live on the Worker, so
    // release waits for every execution the owned body started to
    // settle — never the caller's settle alone.
    const previous = this.slotTails.get(slotIndex) ?? Promise.resolve();
    let release: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.slotTails.set(slotIndex, tail);
    tails?.push(tail);
    await previous;
    if (this.disposed) {
      release!();
      throw new BindingError(`IsolatePool(${this.tag}) is disposed`);
    }
    const inFlight: Promise<unknown>[] = [];
    try {
      return await this.#dispatchSlotOwned(fnSource, fnHash, slotIndex, invoke, resilience, perCallWasm, inFlight, signal);
    } finally {
      // Do not delay the caller's own outcome — the tail releases when
      // the RPCs the body launched have actually settled.
      void Promise.allSettled(inFlight).then(() => release!());
    }
  }


  async #dispatchSlotOwned<T>(
    fnSource: string,
    fnHash: string,
    slotIndex: number,
    invoke: (entrypoint: { execute(...args: unknown[]): Promise<unknown>; fetch(input: RequestInfo, init?: RequestInit): Promise<Response> }, attempt: number) => Promise<T>,
    resilience: ResolvedResilience,
    perCallWasm: Record<string, ArrayBuffer> | undefined,
    inFlight: Promise<unknown>[],
    signal?: AbortSignal,
  ): Promise<T> {
    // Per-call wasm fingerprint. Mixed into the cache key so two calls
    // with different bytes hit different slots (no cache poisoning).
    // For the common case (no per-call wasm) the fingerprint is '0',
    // which is bytes-stable so warm reuse is unaffected.
    const perCallWasmEntries = this.#materialisePerCallWasm(perCallWasm);
    this.#wasmHash ??= wasmIdentity(this.wasmKeyParts);
    const [wasmHash, perCallWasmHash] = await Promise.all([
      this.#wasmHash,
      wasmIdentity(perCallWasmEntries.map(({ name, wasm }) => ({ name, bytes: wasm }))),
    ]);

    // Cache key includes the short DO id so warm isolates are scoped to
    // ONE session (see the doIdShort field comment), and the supervisor
    // identity so a wake of that same session can never reuse a warm
    // worker whose SUPERVISOR binding still names the dead generation's
    // pid. See the supervisorKey field comment for the failure mode.
    const buildId = (generation: number): string =>
      `nfp:${facetLoaderKey(this.facetKind, this.tag)}:${this.doIdShort}:${fnHash}:${this.preambleHash}:${wasmHash}:${perCallWasmHash}:${this.supervisorKey}:slot-${slotIndex}:g${generation}${this.scope ? `:${this.scope}` : ''}${this.network?.id ? `:${this.network.id}` : ''}`;
    let id = buildId(this.slotGenerations.get(slotIndex) ?? 0);
    const code = this.#buildCode(fnSource, perCallWasmEntries);

    // W5 Lever 5: record the dispatch so /api/_diag/memory shows the
    // last-facet-id even on a hang or silent kill. Bounded — single
    // slot updated on every dispatch.
    try { setLastFacetId(id, slotIndex); } catch { /* best-effort */ }

    // A hold the ledger already took for the next attempt, when a refused
    // call waited on it for room; otherwise the attempt begins its own.
    let admitted: EndLoaderFetch | undefined;
    // The hold the latest attempt ran on: a refused one is readmitted on its terms.
    let held: EndLoaderFetch | undefined;
    const runOnce = async (): Promise<T> => {
      // loader.get() is synchronous from the caller's POV; the callback
      // is only invoked on cache miss. We wrap the callback tightly so a
      // retry doesn't rebuild workerCode — that's already stable here.
      //
      // The returned `stub` is the cached worker reference. We deliberately
      // do NOT dispose it: loader.get() is designed for warm-slot reuse
      // across dispatches (same `id` returns the same cached worker),
      // and disposing would invalidate that cache.
      //
      // We USED to also dispose the per-dispatch `entrypoint` stub in a
      // finally block here (added in 3c47b44 to prevent QueueState::ACTIVE
      // during cold-start install). Empirically that broke dispatch on
      // every slot after the first: once the finally ran
      // `entrypoint[Symbol.dispose]()`, subsequent dispatches on the
      // same cached slot hung — SupervisorRPC.writeBatch logged
      // 'canceled', the DO-side _rpcWriteBatch completed OK, but the
      // pool never saw the result and every task stalled to the 60s
      // per-task timeout at 0/13 packages. Removing the per-dispatch
      // dispose restored 13/13 in ~2.3s in dev.
      //
      // The pool-level dispose() method below (also from 3c47b44) is
      // fine and stays — it only tears down the long-lived SUPERVISOR
      // binding stub once the whole pool is done, which does NOT
      // invalidate any in-flight slot's entrypoint reference.
      //
      // The hold comes first, so it ends whatever setup throws: a retry's
      // was taken when the ledger let it in.
      // Inside an admitted launch (a child's python, ruby or wasm runtime
      // dispatching here), the first dispatch is the launch's own worker.
      const endFetch = admitted ?? (this.claim ? undefined : claimAdmission(this.ctx)) ?? beginLoaderFetch(this.ctx, id, this.claim);
      admitted = undefined;
      held = endFetch;
      try {
        const stub = this.loader.get(id, async () => applyFacetLimits(this.facetKind, code));
        const entrypoint = stub.getEntrypoint(undefined, { limits: facetLimits(this.facetKind) });
        // Direct property call, awaited by this frame — bracketed, never
        // wrapped. See beginLoaderFetch for the measured DO-poisoning hazard.
        return await invoke(entrypoint, attempt);
      } catch (err) {
        // The ledger learns a limit refusal from the hold it ends.
        endFetch(err);
        if (err instanceof Error) {
          throw new ExecutionError(err.message, err.stack);
        }
        throw new ExecutionError(String(err));
      } finally {
        endFetch();
      }
    };

    const maxAttempts = 1 + resilience.retries;
    let lastError: Error | undefined;
    let retriedCloneRefusal = false;
    // When the platform first refused this call (readmitRefused).
    let firstRefusal: number | undefined;
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        if (resilience.timeoutMs > 0) {
          // Race runOnce() against a settable timer. CRITICAL: clear
          // the timer in a finally so the timer's reject closure (which
          // transitively roots `args` — i.e. the per-task payload sent
          // to the slot, including 28 MiB pre-bundle slices) doesn't
          // hold its references for the full timeoutMs after the race
          // settles.
          //
          // Before this fix: a facet OOM at t=0 left the slice rooted
          // for the remaining timeoutMs (default 60s for pre-bundle).
          // With concurrency=2, two consecutive OOMs could pin
          // ~56 MiB of slice memory in the supervisor heap for a full
          // minute — alongside an in-flight cirrus-real boot, that's
          // enough to push a shared isolate over the 128 MiB cap.
          // See plan in close-plan-2026-04-28.
          let timerId: ReturnType<typeof setTimeout> | undefined;
          try {
            const attemptPromise = runOnce();
            inFlight.push(attemptPromise);
            return await Promise.race([
              attemptPromise,
              new Promise<never>((_, reject) => {
                timerId = setTimeout(
                  () => reject(new TimeoutError(resilience.timeoutMs)),
                  resilience.timeoutMs,
                );
              }),
            ]);
          } finally {
            if (timerId !== undefined) clearTimeout(timerId);
          }
        }
        const attemptPromise = runOnce();
        inFlight.push(attemptPromise);
        return await attemptPromise;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const cause = classifyError(lastError);
        // W5 Lever 5: classify + record. We push on EVERY failed
        // attempt (not just the final retry-exhausted throw) so the
        // ring captures transient SQLITE_NOMEM / clone-refused
        // patterns that still ultimately succeed. Ring is bounded
        // (50 entries) so noise is self-limiting.
        try {
          recordFailure({
            at: Date.now(),
            phase: 'rpc',
            cause,
            rssEstimateBytes: 0, heapUsedBytes: 0,
            lruBytes: 0, inFlightBytes: 0,
            lastRpcFrame: getLastRpcFrame(),
            lastFacetId: { codeId: id, slotIndex, atMs: Date.now() },
            message: lastError.message,
          });
        } catch { /* fail-soft */ }
        if (signal?.aborted) {
          // The caller aborted this dispatch's Request. workerd cancelled
          // the isolate's execution context wherever it was suspended —
          // mid-syscall, mid-stream — so the interpreter's heap may hold
          // half-applied state. Bump the slot generation: the next
          // dispatch lands on a FRESH worker under a new id rather than
          // reusing the abandoned one. Retrying is wrong — the user
          // interrupted; surface the abort.
          const generation = (this.slotGenerations.get(slotIndex) ?? 0) + 1;
          this.slotGenerations.set(slotIndex, generation);
          throw lastError;
        }
        if (cause === 'clone_refused' && !retriedCloneRefusal) {
          retriedCloneRefusal = true;
          const generation = (this.slotGenerations.get(slotIndex) ?? 0) + 1;
          this.slotGenerations.set(slotIndex, generation);
          id = buildId(generation);
          try { setLastFacetId(id, slotIndex); } catch { /* best-effort */ }
          // If the supervisor DO is stale, a newer loader still cannot
          // deserialize back into it; only recycling that DO heals the
          // reverse direction. This refresh targets the stale-loader case.
          continue;
        }
        if (cause === 'dynamic_worker_cap' && held) {
          // The platform refused to start this call: nothing ran, so it is
          // sent again, without spending an attempt, once the ledger lets it in.
          firstRefusal ??= Date.now();
          admitted = await readmitRefused(held, { since: firstRefusal, signal });
          if (admitted) continue;
          // The caller aborted while waiting: surface its abort as above.
          if (signal?.aborted) throw lastError;
        }
        if (attempt < maxAttempts - 1) {
          // 100 * 2^attempt, capped at 2s so retries don't compound waiting.
          const delay = Math.min(2000, 100 * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, delay));
        }
        attempt++;
      }
    }
    // On the way out only, so retries do not stack the annotation: a limit
    // hit carries the ledger — which workers were in flight — instead of the
    // platform's bare message.
    const named = withDynamicWorkerCapNamed(this.ctx, lastError!);
    if (maxAttempts > 1) {
      throw new RetryExhaustedError(maxAttempts, named);
    }
    throw named;
  }

  #prepare<A, R>(fn: FacetTaskSource<A, R>): { fnSource: string; fnHash: string } {
    const fnSource = requireFacetTaskSource(fn);
    const fnHash = hashSource(fnSource);
    return { fnSource, fnHash };
  }

  /**
   * Run `fn` once with `arg` on a slot isolate. Returns the result or
   * throws TimeoutError / RetryExhaustedError / ExecutionError.
   */
  async submit<T, R>(
    fn: FacetTaskSource<T, R>,
    arg: T,
    opts?: IsolateCallOptions,
  ): Promise<Awaited<R>> {
    const { fnSource, fnHash } = this.#prepare(fn);
    const resilience = this.#resolve(opts);
    try {
      return (await this.#dispatchSlot(
        fnSource,
        fnHash,
        0,
        (entrypoint) => this.#execute(entrypoint, arg) as Promise<Awaited<R>>,
        resilience,
        opts?.wasmModules,
      ));
    } catch (error) {
      throw this.#ended(error);
    }
  }

  /**
   * A run that failed (its facet died, was killed or timed out) of a process
   * that writes (bound to a pid) ended abnormally: its error says what may be
   * lost (unsettledEnd), every time; whether it acknowledged writes it never
   * sent, the session cannot know.
   */
  #ended(error: unknown): unknown {
    return this.writerPid === undefined ? error : unsettledEnd(error);
  }

  /**
   * Dispatch `fn` through the fetch transport — the pool's only
   * cancellable path: aborting `request.signal` cancels the inner
   * execution context at its next I/O suspension (a synchronous CPU
   * section cannot be preempted — the platform's honest limit), the
   * call rejects, and the slot generation bumps so the next dispatch
   * gets a fresh interpreter. `fn` is request-shaped: it encodes and
   * decodes its own payload.
   */
  async submitRequest(
    fn: FacetTaskSource<Request, Response>,
    request: Request,
    opts?: IsolateCallOptions,
  ): Promise<Response> {
    if (request.bodyUsed) {
      throw new BindingError(
        'IsolatePool.submitRequest: request body is already consumed — ' +
          'pass an unconsumed Request so retries can re-issue it.',
      );
    }
    if (this.callBindings !== undefined) {
      throw new BindingError('IsolatePool.submitRequest: a per-call supervisor rides an RPC dispatch (submit or map), not a Request.');
    }
    const { fnSource, fnHash } = this.#prepare(fn);
    const resilience = this.#resolve(opts);
    // Every attempt fetches a clone: a Request's body is consumed once,
    // so the caller's original stays unspent and retries get a fresh
    // body that follows the same signal.
    try {
      return await this.#dispatchSlot(
        fnSource,
        fnHash,
        0,
        (entrypoint) => entrypoint.fetch(request.clone()),
        resilience,
        opts?.wasmModules,
        request.signal,
      );
    } catch (error) {
      throw this.#ended(error);
    }
  }


  /**
   * Run `fn` on every item in `items`, at most `concurrency` at a time,
   * pinned to stable slots so warm isolates are reused. Results are in input
   * order. After an item fails no item starts, and the map rejects with the
   * first failure once every execution it started has settled, a timed-out
   * one included: nothing it dispatched is still running when it returns.
   */
  async map<T, R>(
    fn: FacetTaskSource<T, R>,
    items: T[],
    opts?: IsolateMapOptions,
  ): Promise<Array<Awaited<R>>> {
    if (items.length === 0) return [];
    const { fnSource, fnHash } = this.#prepare(fn);
    return valuesOf(await this.#mapInternal<T, R>(fnSource, fnHash, items, opts, true));
  }

  /** `map`, where every item runs whatever the others do: each item's outcome. */
  async mapSettled<T, R>(
    fn: FacetTaskSource<T, R>,
    items: T[],
    opts?: IsolateMapOptions,
  ): Promise<Array<Settled<Awaited<R>>>> {
    if (items.length === 0) return [];
    const { fnSource, fnHash } = this.#prepare(fn);
    return this.#mapInternal<T, R>(fnSource, fnHash, items, opts, false);
  }

  /**
   * The peer-DO transport of `map` (`stopOnFailure`) and `mapSettled`: the
   * coordinator forwards the task's already compiled expression, whose exact
   * bytes key the same warm slots. Each item's outcome.
   */
  async mapSource<T, R>(
    fnSource: string,
    items: T[],
    stopOnFailure: boolean,
    opts?: IsolateMapOptions,
  ): Promise<Array<Settled<Awaited<R>>>> {
    if (items.length === 0) return [];
    return this.#mapInternal<T, R>(fnSource, hashSource(fnSource), items, opts, stopOnFailure);
  }

  async #mapInternal<T, R>(
    fnSource: string,
    fnHash: string,
    items: T[],
    opts: IsolateMapOptions | undefined,
    stopOnFailure: boolean,
  ): Promise<Array<Settled<Awaited<R>>>> {
    const resilience = this.#resolve(opts);
    const concurrency = Math.max(
      1,
      Math.min(opts?.concurrency ?? this.concurrency, items.length),
    );
    const settled: Array<Settled<Awaited<R>>> = new Array(items.length);
    const tails: Promise<void>[] = [];
    let cursor = 0;
    let failed = false;

    const runSlot = async (slotIndex: number): Promise<void> => {
      while (!(stopOnFailure && failed)) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          const value = (await this.#dispatchSlot(
            fnSource,
            fnHash,
            slotIndex,
            (entrypoint) => this.#execute(entrypoint, items[idx]),
            resilience,
            opts?.wasmModules,
            undefined,
            tails,
          )) as Awaited<R>;
          settled[idx] = { ok: true, value };
        } catch (err) {
          settled[idx] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
          failed = true;
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, (_, slotIndex) => runSlot(slotIndex)),
    );
    // An item that timed out answered its caller, but its execution may
    // still be live on the Worker (#dispatchSlot's tail): the map returns
    // once every execution it started has settled, so none outlives it,
    // and waits for nothing else that shares its slots.
    await Promise.all(tails);
    for (let idx = 0; idx < items.length; idx++) {
      settled[idx] ??= { ok: false, error: new Error('not started: an earlier item failed') };
    }
    return settled;
  }

  /**
   * Release any RPC stubs held by the pool. Call this once the caller
   * is done with the pool (post-`map`/`submit`) so the underlying
   * stubs don't linger in workerd's deferred-destruction queue.
   *
   * Primary target: the SUPERVISOR binding stub we minted at
   * construction time (via the registered supervisor entrypoint). It's
   * a cross-isolate RPC stub — without explicit disposal it stays
   * referenced until the parent isolate's event-handler context
   * finishes, which during npm install means "until the whole install
   * completes" — long enough to accumulate alongside other leaked
   * stubs and trip the QueueState::ACTIVE fatal.
   *
   * Safe to call more than once; idempotent.
   */
  dispose(): void {
    this.disposed = true;
    disposeRpcResource(this.callBindings?.SUPERVISOR);
    this.callBindings = undefined;
    if (!this.bindings) return;
    for (const key of Object.keys(this.bindings)) {
      disposeRpcResource(this.bindings[key]);
    }
    // Prevent double-dispose from re-running the loop.
    this.bindings = undefined;
  }

  /** One `execute` of an argument, with the call's bindings when the pool hands them per call. */
  #execute(entrypoint: { execute(...args: unknown[]): Promise<unknown> }, arg: unknown): Promise<unknown> {
    return this.callBindings === undefined ? entrypoint.execute(arg) : entrypoint.execute(arg, this.callBindings);
  }
}

/** Every value of `settled`, or (once all have settled) the first failure. */
export function valuesOf<R>(settled: ReadonlyArray<Settled<R>>): R[] {
  const failure = settled.find((outcome) => !outcome.ok);
  if (failure && !failure.ok) throw failure.error;
  return settled.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
}
