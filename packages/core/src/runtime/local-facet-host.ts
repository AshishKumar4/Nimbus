/**
 * local-facet-host.ts — a facet in a realm of its own, in the caller's process.
 *
 * The {@link FacetHost} for every embedder that is not workerd. There is no
 * dynamic-worker substrate to reach for and no CSP forbidding a compile, so
 * each facet is a worker thread of this process (runtime/realm.ts; its side is
 * facet-guest.ts): the wasm table is compiled here and handed over (a
 * compiled module crosses to a worker without being compiled again, and V8
 * reuses this isolate's compilation of the same bytes), the preamble
 * evaluated once there, and each submitted function evaluated there inside
 * it.
 *
 * A realm of its own because a facet used to be built in this realm, so what
 * its program reached of JavaScript was the host's: Ruby's `js` bridge
 * evaluates code (`JS.eval`) and reads and writes any global, so
 * `JS.eval("globalThis.Promise = null")` broke the host's shell, and a guest
 * spinning without a syscall held the host's only thread for good. Now the
 * program reaches the facet's realm, and a call's timeout or abort ends it
 * (`terminate()` stops even a loop that never yields).
 *
 * The function is SERIALIZED rather than called in place, as on workerd. A
 * runner's facet function reads names the preamble declares —
 * `__wasiMakeImports`, `__bashBoot` — which exist only in the scope the
 * preamble was evaluated in. Its arguments and answer cross as plain data, and
 * the session capability as calls to this side: each supervisor method, and
 * each of its synchronous view's, is answered here from the facet's
 * filesystem.
 */

import type {
  Facet,
  FacetFn,
  FacetHost,
  FacetSpec,
  FacetSubmitOptions,
} from './facet-host.js';
import type { RuntimeFsBridge } from './os-contracts.js';
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
}

/** A submitted call, host to guest. */
export interface FacetSubmit {
  readonly type: 'submit';
  readonly id: number;
  /** The function's source. */
  readonly source: string;
  readonly args: unknown;
  /** Wasm modules to add to the table before the call, compiled here. */
  readonly modules: Record<string, WebAssembly.Module>;
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
  const supervisor = value.supervisor;
  return supervisor === undefined
    || (record(supervisor) && strings(supervisor.methods) && (supervisor.synchronous === null || strings(supervisor.synchronous)));
}

export function isFacetSubmit(value: unknown): value is FacetSubmit {
  return record(value) && value.type === 'submit' && Number.isSafeInteger(value.id) && typeof value.source === 'string'
    && 'args' in value && record(value.modules) && Object.values(value.modules).every((module) => module instanceof WebAssembly.Module);
}

function isSupervisorCall(value: unknown): value is SupervisorCall {
  return record(value) && value.op === 'supervisor' && (value.view === 'supervisor' || value.view === 'synchronous')
    && typeof value.method === 'string' && Array.isArray(value.args);
}

/** The guest's answer to a submit, named by the submit's id. */
function isFacetDone(value: unknown): value is RealmOutcome & { readonly type: 'done'; readonly id: number } {
  return record(value) && value.type === 'done' && isRealmAnswer(value);
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
function wasmCompiler(): WasmCompiler {
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
 */
export function localFacetHost(): FacetHost {
  return {
    parking: engineParks(),
    // A worker of a Bun or Node process, not a Worker isolate.
    memoryBudgetBytes: 1024 * 1024 * 1024,
    open: (spec) => new RealmFacet(spec),
  };
}

/** Why a call ended without its answer. */
const ended = (tag: string, why: string): Error => new Error(`Nimbus: facet '${tag}' ${why}`);

class RealmFacet implements Facet {
  /** The realm, started on the first call. */
  private realm: Promise<Realm> | null = null;
  /** The image each name was last sent as: the same image is compiled, and sent, once per facet. */
  private readonly sent = new Map<string, ArrayBuffer>();
  /** Submits are serialized: one scope, and a facet's calls are ordered. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, (outcome: RealmOutcome | Error) => void>();
  private ids = 0;
  private disposed = false;
  /** Why the realm ended, once it has. */
  private over: Error | null = null;
  private readonly supervisor: FilesystemSupervisor | null;
  private readonly synchronous: RuntimeFsBridge['synchronous'];

  constructor(private readonly spec: FacetSpec) {
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
    };
    const realm = await startRealm({
      entry: new URL('./facet-guest.js', import.meta.url),
      payload,
      serve: (call) => this.serve(call),
      onEvent: (event) => {
        if (!isFacetDone(event)) return;
        const settle = this.waiting.get(event.id);
        this.waiting.delete(event.id);
        settle?.(event);
      },
    });
    if ('unavailable' in realm) throw ended(this.spec.tag, `has no realm: ${realm.unavailable}`);
    realm.hold(false);
    void realm.ended.then((end) => {
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

  /** The modules a call adds to the facet's table: the spec's, per-call ones over them, but those it holds already. */
  private async modules(callModules: Record<string, ArrayBuffer> | undefined): Promise<Record<string, WebAssembly.Module>> {
    const added: Record<string, WebAssembly.Module> = {};
    for (const [name, bytes] of Object.entries({ ...this.spec.wasmModules, ...callModules })) {
      if (this.sent.get(name) === bytes) continue;
      added[name] = await wasmCompiler()(bytes);
      this.sent.set(name, bytes);
    }
    return added;
  }

  private async call<A, R>(fn: FacetFn<A, R>, args: A, options?: FacetSubmitOptions): Promise<unknown> {
    if (this.disposed) throw ended(this.spec.tag, 'is disposed');
    options?.signal?.throwIfAborted();
    const realm = await this.started();
    if (this.over) throw this.over;
    const submit: FacetSubmit = { type: 'submit', id: ++this.ids, source: fn.toString(), args, modules: await this.modules(options?.wasmModules) };
    const answered = new Promise<RealmOutcome | Error>((resolve) => this.waiting.set(submit.id, resolve));
    if (!realm.post(submit)) {
      this.waiting.delete(submit.id);
      throw ended(this.spec.tag, 'was submitted arguments that cannot cross to its realm');
    }
    // The call holds this process while it runs; its timeout or abort ends the facet.
    realm.hold(true);
    const end = (why: Error) => {
      this.waiting.get(submit.id)?.(why);
      this.waiting.delete(submit.id);
      this.dispose();
    };
    const timer = options?.timeoutMs === undefined ? undefined
      : setTimeout(() => end(ended(this.spec.tag, `timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    const abort = () => end(options?.signal?.reason instanceof Error ? options.signal.reason : ended(this.spec.tag, 'was aborted'));
    options?.signal?.addEventListener('abort', abort, { once: true });
    try {
      const outcome = await answered;
      if (outcome instanceof Error) throw outcome;
      if ('error' in outcome) throw fromRealmError(outcome.error);
      return outcome.value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abort);
      realm.hold(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.realm?.then((realm) => realm.terminate(), () => {});
  }
}

