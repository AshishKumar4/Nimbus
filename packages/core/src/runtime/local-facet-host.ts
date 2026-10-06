/**
 * local-facet-host.ts — a facet in a realm of its own, beside the caller.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so
 * each facet is a realm (runtime/realm.ts; its side is facet-guest.ts): the
 * wasm table filled, the preamble evaluated once there, and each submitted
 * function evaluated there inside it. The realm is a worker thread of this
 * process, or under Bun a process of its own: Bun 1.4 cannot end a worker
 * running WebAssembly, and a facet runs nothing else. A thread is handed its
 * modules compiled here (a compiled module crosses to a worker without a
 * second compile, and V8 reuses this isolate's compilation of the same
 * bytes); a process, which no compiled module crosses to, their bytes.
 *
 * A realm of its own because a facet used to be built in this realm, so what
 * its program reached of JavaScript was the host's: Ruby's `js` bridge
 * evaluates code (`JS.eval`) and reads and writes any global, so
 * `JS.eval("globalThis.Promise = null")` broke the host's shell, and a guest
 * spinning without a syscall held the host's only thread for good. Now the
 * program reaches the facet's realm, and a call's timeout or abort ends it,
 * even in a loop that never yields.
 *
 * The function is SERIALIZED rather than called in place, as on workerd. A
 * runner's facet function reads names the preamble declares —
 * `__wasiMakeImports`, `__bashBoot` — which exist only in the scope the
 * preamble was evaluated in. Its arguments and answer cross as plain data, and
 * the session capability as calls to this side: each supervisor method, and
 * each of its synchronous view's, is answered here from the facet's
 * filesystem.
 *
 * A facet's network is the workspace's. A realm cannot be handed a Fetcher,
 * so under an egress its `fetch` crosses to this side, which sends it out
 * through the egress (realm-egress.ts, as the inline `node` does); a
 * WebSocket, which cannot cross, is refused by name.
 */

import type {
  Facet,
  FacetFn,
  FacetHost,
  FacetSpec,
  FacetSubmitOptions,
} from './facet-host.js';
import { requireNetwork, type WorkspaceNetwork } from '../_shared/workspace-network.js';
import type { RuntimeFsBridge } from './os-contracts.js';
import { isEgressGuestEvent, RealmEgress } from './realm-egress.js';
import { fromRealmError, isRealmAnswer, startRealm, type Realm, type RealmOutcome } from './realm.js';
import { FILESYSTEM_RPC_METHODS, vfsSupervisor, type FilesystemSupervisor } from './vfs-supervisor.js';
import type { WasiParking } from './wasi/types.js';

// ── The facet's protocol (facet-guest.ts is the other side) ──────────────────

/** Which of the facet's capabilities a call reaches: the supervisor, or its synchronous view. */
export type SupervisorView = 'supervisor' | 'synchronous';

/** What the realm starts with. */
export interface FacetPayload {
  readonly tag: string;
  /** The host's parking: whether the facet's supervisor answers by promise (jspi) or at once (none). */
  readonly parking: WasiParking;
  readonly preamble?: string;
  /** The supervisor's method names, and its synchronous view's when it has one; absent without syscalls. */
  readonly supervisor?: { readonly methods: readonly string[]; readonly synchronous: readonly string[] | null };
  /** The workspace's network goes through an egress: the facet's fetch crosses to the host (realm-egress.ts). */
  readonly egress: boolean;
}

/** A submitted call, host to guest. */
export interface FacetSubmit {
  readonly type: 'submit';
  readonly id: number;
  /** The function's source. */
  readonly source: string;
  readonly args: unknown;
  /** Wasm modules to add to the table before the call: compiled for a thread, bytes for a process to compile. */
  readonly modules: Record<string, WebAssembly.Module | ArrayBuffer>;
}

/** A call the guest makes on its capability. */
interface SupervisorCall {
  readonly op: 'supervisor';
  readonly view: SupervisorView;
  readonly method: string;
  readonly args: readonly unknown[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

export function isFacetPayload(value: unknown): value is FacetPayload {
  if (!record(value) || typeof value.tag !== 'string' || (value.parking !== 'jspi' && value.parking !== 'none')) return false;
  if (value.preamble !== undefined && typeof value.preamble !== 'string') return false;
  if (typeof value.egress !== 'boolean') return false;
  const supervisor = value.supervisor;
  return supervisor === undefined
    || (record(supervisor) && strings(supervisor.methods) && (supervisor.synchronous === null || strings(supervisor.synchronous)));
}

export function isFacetSubmit(value: unknown): value is FacetSubmit {
  return record(value) && value.type === 'submit' && Number.isSafeInteger(value.id) && typeof value.source === 'string'
    && 'args' in value && record(value.modules) && Object.values(value.modules).every((module) => module instanceof WebAssembly.Module || module instanceof ArrayBuffer);
}

function isSupervisorCall(value: unknown): value is SupervisorCall {
  return record(value) && value.op === 'supervisor' && (value.view === 'supervisor' || value.view === 'synchronous')
    && typeof value.method === 'string' && Array.isArray(value.args);
}

/** The guest's answer to a submit, named by the submit's id. */
export type FacetDone = RealmOutcome & {
  readonly type: 'done';
  readonly id: number;
  /** Whether the submit's modules are in the facet's table: all of them, or (when one failed) none. */
  readonly installed: boolean;
};

function isFacetDone(value: unknown): value is FacetDone {
  return record(value) && value.type === 'done' && typeof value.installed === 'boolean' && isRealmAnswer(value);
}

/** The supervisor's names, as a facet calls them. */
const SUPERVISOR_METHODS: readonly string[] = Object.values(FILESYSTEM_RPC_METHODS);
/** Its synchronous view's: the bridge's names, but those with no synchronous form (os-contracts.ts). */
const SYNCHRONOUS_METHODS: readonly string[] = Object.keys(FILESYSTEM_RPC_METHODS)
  .filter((name) => name !== 'writeStream' && name !== 'acquire' && name !== 'copyTree');

type WasmCompiler = (bytes: BufferSource) => Promise<WebAssembly.Module>;

/**
 * The standard `WebAssembly.compile`, checked for rather than assumed.
 *
 * `@cloudflare/workers-types` declares no compiler and an abstract `Module`,
 * which is not an oversight: workerd forbids compiling at request time, and
 * that prohibition is the entire reason facets exist. Core is typed against
 * that surface, so the one host that DOES compile asks for the capability by
 * name and says so plainly when it is absent.
 */
export function wasmCompiler(): WasmCompiler {
  const compile: unknown = Reflect.get(WebAssembly, 'compile');
  if (typeof compile !== 'function') {
    throw new Error(
      'Nimbus: this host cannot compile WebAssembly in place (no WebAssembly.compile), '
      + 'so it needs a facet host with its own isolates rather than this one',
    );
  }
  return compile as WasmCompiler;
}

/**
 * Whether this engine can suspend a wasm guest mid-import: JSPI's
 * `WebAssembly.Suspending` and `WebAssembly.promising` (the ambient
 * declaration is in runtime/wasi/types.ts). Bun's JavaScriptCore ships them;
 * Node 22 does not, and V8 traps a call into a suspending import off a stack
 * `promising` did not enter, so the answer has to come from the engine at
 * hand, not from the process kind.
 */
function engineParks(): WasiParking {
  return typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function' ? 'jspi' : 'none';
}

/**
 * Where a facet runs: a worker thread, or, under Bun, a process. Bun 1.4 does
 * not terminate a worker that is running WebAssembly (its `terminate()` never
 * settles and the thread spins on, a core for good), and a facet's guest is
 * WebAssembly; Node ends one at once. Asked of the engine at hand, as
 * {@link engineParks} is.
 */
function facetIsolation(): 'thread' | 'process' {
  return Reflect.get(globalThis, 'Bun') === undefined ? 'thread' : 'process';
}

/**
 * Run each facet in a realm of its own, a worker thread of this process.
 *
 * `parking` is the engine's (a worker's is the same engine): where it can
 * suspend a guest the facet is entered through `WebAssembly.promising` and a
 * syscall may park on a promise, so a plain-WASI child waits at a full pipe as
 * it would on Linux. Where it cannot, the guest is entered on an ordinary
 * stack, no syscall may suspend it, the supervisor it mints is the authority's
 * synchronous view, and a pipe buffers to the host's
 * {@link FacetHost.memoryBudgetBytes} instead (pipe-rules.ts).
 *
 * {@link FacetSubmitOptions.timeoutMs} and `signal` are honoured: either ends
 * the facet, as a substrate with isolates of its own does. A facet waiting for
 * no call holds no part of this process: it does not keep it alive.
 *
 * `network` is the workspace's (`workspace.network`, or
 * `workspaceNetwork(egress)` for the egress the workspace is created with,
 * `ISOLATE_NETWORK` without one): every facet goes out through it.
 */
export function localFacetHost(network: WorkspaceNetwork): FacetHost {
  requireNetwork(network, 'localFacetHost');
  return {
    parking: engineParks(),
    // A worker of a Bun or Node process, not a Worker isolate.
    memoryBudgetBytes: 1024 * 1024 * 1024,
    open: (spec) => new RealmFacet(spec, network),
  };
}

/** Why a call ended without its answer. */
const ended = (tag: string, why: string): Error => new Error(`Nimbus: facet '${tag}' ${why}`);

class RealmFacet implements Facet {
  /** The realm, started on the first call. */
  private realm: Promise<Realm> | null = null;
  /** The image each name is in the facet's table as: what a call need not send again. */
  private readonly installed = new Map<string, ArrayBuffer>();
  /** Each image compiled for a thread, once, whether or not a call that sent it succeeded. */
  private readonly compiled = new WeakMap<ArrayBuffer, WebAssembly.Module>();
  /** Submits are serialized: one scope, and a facet's calls are ordered. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, (outcome: FacetDone | Error) => void>();
  private ids = 0;
  private disposed = false;
  /** Why the realm ended, once it has. */
  private over: Error | null = null;
  private readonly supervisor: FilesystemSupervisor | null;
  private readonly synchronous: RuntimeFsBridge['synchronous'];
  private readonly isolation = facetIsolation();

  constructor(private readonly spec: FacetSpec, private readonly network: WorkspaceNetwork) {
    this.supervisor = spec.syscalls ? vfsSupervisor(spec.syscalls.vfs) : null;
    this.synchronous = spec.syscalls?.vfs.synchronous;
  }

  submit<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<Awaited<R>> {
    const run = this.queue.then(() => this.call(fn, args, options));
    // The chain must survive a rejected call, or one failure poisons the facet.
    this.queue = run.catch(() => undefined);
    return run as Promise<Awaited<R>>;
  }

  private started(): Promise<Realm> {
    this.realm ??= this.start();
    return this.realm;
  }

  private async start(): Promise<Realm> {
    const payload: FacetPayload = {
      tag: this.spec.tag,
      parking: engineParks(),
      preamble: this.spec.preamble,
      supervisor: this.supervisor ? { methods: SUPERVISOR_METHODS, synchronous: this.synchronous ? SYNCHRONOUS_METHODS : null } : undefined,
      egress: this.network.egress !== undefined,
    };
    let post: (event: unknown) => boolean = () => false;
    const egress = this.network.egress === undefined ? null : new RealmEgress(this.network, (event) => { post(event); });
    const realm = await startRealm({
      entry: new URL('./facet-guest.js', import.meta.url),
      isolation: this.isolation,
      payload,
      serve: (call) => this.serve(call),
      onEvent: (event) => {
        if (isEgressGuestEvent(event)) {
          egress?.handle(event);
          return;
        }
        if (!isFacetDone(event)) return;
        const settle = this.waiting.get(event.id);
        this.waiting.delete(event.id);
        settle?.(event);
      },
    });
    if ('unavailable' in realm) throw ended(this.spec.tag, `has no realm: ${realm.unavailable}`);
    post = (event) => realm.post(event);
    realm.hold(false);
    void realm.ended.then((end) => {
      egress?.close();
      this.over = ended(this.spec.tag, end.terminated ? 'was ended' : `ended (${end.failure?.message ?? `exit ${end.code}`})`);
      for (const settle of this.waiting.values()) settle(this.over);
      this.waiting.clear();
    });
    return realm;
  }

  /** One call the facet makes on its capability: only the methods it was handed, of the view it names. */
  private serve(call: unknown): unknown {
    if (!isSupervisorCall(call)) throw new TypeError('Nimbus: a facet called nothing its host answers');
    const target = call.view === 'synchronous' ? this.synchronous : this.supervisor;
    const names = call.view === 'synchronous' ? SYNCHRONOUS_METHODS : SUPERVISOR_METHODS;
    const method = target && names.includes(call.method) ? Reflect.get(target, call.method) : undefined;
    if (typeof method !== 'function') throw new TypeError(`Nimbus: a facet's ${call.view} has no method ${JSON.stringify(call.method)}`);
    return Reflect.apply(method, target, call.args);
  }

  /**
   * The images a call adds to the facet's table (the spec's, per-call ones
   * over them, but those it holds already), by name, and each as it is sent.
   * Nothing is recorded as held here: only the guest's answer that it
   * installed them does that, so a call that fails sends them all again.
   */
  private async modules(callModules: Record<string, ArrayBuffer> | undefined): Promise<{
    images: Record<string, ArrayBuffer>;
    sent: Record<string, WebAssembly.Module | ArrayBuffer>;
  }> {
    const images: Record<string, ArrayBuffer> = {};
    const sent: Record<string, WebAssembly.Module | ArrayBuffer> = {};
    for (const [name, bytes] of Object.entries({ ...this.spec.wasmModules, ...callModules })) {
      if (this.installed.get(name) === bytes) continue;
      images[name] = bytes;
      sent[name] = this.isolation === 'thread' ? await this.compile(bytes) : bytes;
    }
    return { images, sent };
  }

  private async compile(bytes: ArrayBuffer): Promise<WebAssembly.Module> {
    const cached = this.compiled.get(bytes);
    if (cached) return cached;
    const module = await wasmCompiler()(bytes);
    this.compiled.set(bytes, module);
    return module;
  }

  private async call<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<unknown> {
    if (this.disposed) throw ended(this.spec.tag, 'is disposed');
    const signal = options?.signal;
    signal?.throwIfAborted();
    // From here a timeout or an abort ends the call, and the facet with it,
    // at whatever step it has reached: starting, compiling, or running. Every
    // step waits racing it.
    const state: { stopped: Error | null } = { stopped: null };
    let stop: (why: Error) => void = () => {};
    const stopping = new Promise<never>((_, reject) => {
      stop = (why) => {
        if (state.stopped) return;
        state.stopped = why;
        reject(why);
        this.dispose();
      };
    });
    stopping.catch(() => {});
    const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : ended(this.spec.tag, 'was aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort that came between the check above and the listener.
    if (signal?.aborted) onAbort();
    const timer = options?.timeoutMs === undefined ? undefined
      : setTimeout(() => stop(ended(this.spec.tag, `timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    let realm: Realm | null = null;
    const id = ++this.ids;
    try {
      realm = await Promise.race([this.started(), stopping]);
      if (this.over) throw this.over;
      const { images, sent } = await Promise.race([this.modules(options?.wasmModules), stopping]);
      // Stopped in the turn the modules were ready: not posted.
      if (state.stopped) throw state.stopped;
      const submit: FacetSubmit = { type: 'submit', id, source: fn.toString(), args, modules: sent };
      const answered = new Promise<FacetDone | Error>((resolve) => this.waiting.set(id, resolve));
      if (!realm.post(submit)) throw ended(this.spec.tag, 'was submitted arguments that cannot cross to its realm');
      // The call holds this process while it runs.
      realm.hold(true);
      const outcome = await Promise.race([answered, stopping]);
      if (outcome instanceof Error) throw outcome;
      if (outcome.installed) for (const [name, bytes] of Object.entries(images)) this.installed.set(name, bytes);
      if ('error' in outcome) throw fromRealmError(outcome.error);
      return outcome.value;
    } finally {
      this.waiting.delete(id);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      realm?.hold(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.realm?.then((realm) => realm.terminate(), () => {});
  }
}

