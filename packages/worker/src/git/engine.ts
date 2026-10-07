/**
 * git/engine.ts — the GitPackStream engine, bound to a session: what real
 * git's remote helper (git-remote-http, git-remote-https) asks of the
 * network. Each operation runs in the git network facet (network-facet.ts),
 * as the calling process (its credential and filesystem) and through the
 * workspace's network, on the pack layer's own protocol code
 * (pack/remote.ts):
 *
 *   listRefs   the remote's refs (upload-pack's, or receive-pack's for a push)
 *   fetchPack  the pack the wants need, with its .idx and .rev (a .promisor
 *              for a filtered fetch) and .git/shallow, written into the
 *              repository; a pack past one invocation's decoding budget
 *              goes on in the same facet until it is whole
 *   pushPack   the ref updates and the caller's pack, streamed through to
 *              receive-pack, and its report
 *
 * None of them writes a ref: git does, after (remote-tracking refs, tags,
 * FETCH_HEAD), and decides before what may be pushed.
 */
import { execGitNetwork, type GitNetworkResult } from './network-facet.js';
import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';

/** Credentials for the remote, as the builtin git takes them (GIT_USERNAME, GIT_PASSWORD or GIT_TOKEN). */
export interface RemoteAuth {
  username: string;
  password: string;
}

/** A ref the remote advertises: its value, or the ref a symbolic one (HEAD) names. */
export interface RemoteRef {
  name: string;
  oid: string | null;
  symref?: string;
}

export interface ListRefsRequest {
  url: string;
  auth?: RemoteAuth;
  /** For a push: the receive-pack side's refs. */
  forPush: boolean;
  /** Only refs under these, when the protocol can narrow it (v2 ls-refs ref-prefix): protocol v0 cannot, and lists all. */
  refPrefixes?: string[];
}

export interface ListRefsResult {
  refs: RemoteRef[];
  objectFormat: 'sha1' | 'sha256';
}

export interface FetchPackRequest {
  url: string;
  auth?: RemoteAuth;
  /** The repository's git directory, as an engine path: where the pack and .git/shallow are written. */
  gitDir: string;
  wants: string[];
  depth?: number;
  /** Seconds since the epoch. */
  deepenSince?: number;
  deepenNot?: string[];
  deepenRelative?: boolean;
  filter?: string;
  /** Annotated tags that point into what is fetched come with it. */
  includeTag: boolean;
  /** git allows .git/shallow to grow (fetch --update-shallow, clone). */
  updateShallow: boolean;
}

export interface FetchPackResult {
  /** The pack written (pack-<hash>), or null when nothing was needed. */
  packName: string | null;
  objects: number;
  bytes: number;
  /** .git/shallow was written. */
  shallow: boolean;
  /** The pack is a promisor pack (a filtered fetch). */
  promisor: boolean;
  /** Every object the wants reach is in the pack or was already here: git may skip its own check. */
  selfContained: boolean;
}

export interface PushCommand {
  ref: string;
  /** The value the remote must still have (all zeros: none), checked by the remote as it updates. */
  old: string;
  /** All zeros deletes the ref. */
  new: string;
}

export interface PushPackRequest {
  url: string;
  auth?: RemoteAuth;
  commands: PushCommand[];
  /** What the remote lacks of the new values; null when every command is a deletion. */
  pack: ReadableStream<Uint8Array> | null;
  atomic: boolean;
  pushOptions: string[];
}

export interface PushPackResult {
  refs: Array<{ ref: string; ok: boolean; reason?: string }>;
}

/** The GitPackStream engine, bound to the session (remote-helper.ts takes it). */
export interface RemoteEngine {
  listRefs(request: ListRefsRequest): Promise<ListRefsResult>;
  fetchPack(request: FetchPackRequest): Promise<FetchPackResult>;
  pushPack(request: PushPackRequest): Promise<PushPackResult>;
}

/** The process an engine works for, and the session it runs in. */
export interface EngineBinding {
  /** The DO's state and env, as execGitNetwork takes them. */
  ctx: DurableObjectState;
  env: unknown;
  /** The calling process: the facet acts as it (its credential, its filesystem). */
  pid: number;
  network: WorkspaceNetwork;
  /** One operation's limit (the facet's default when absent). */
  timeoutMs?: number;
  /** Verification knob: a fetch's decoding budget per invocation (processor.ts WORK_BUDGET_UNITS by default). */
  budgetUnits?: number;
}

/** A failed operation, as the helper reports it to git. */
export class RemoteEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteEngineError';
  }
}

/** The worktree whose .git `gitDir` is: the pack layer writes below a worktree's .git. */
function worktreeOf(gitDir: string): string {
  const trimmed = gitDir.replace(/\/+$/, '');
  if (!trimmed.endsWith('/.git')) {
    throw new RemoteEngineError(`fatal: the engine writes into a repository's .git, not '${gitDir}' (a bare repository is not supported yet)`);
  }
  return trimmed.slice(0, -'/.git'.length) || '/';
}

/** The answer of an operation that succeeded, or its error. */
function answer<T>(result: GitNetworkResult, op: string): T {
  if (!result.success || result.remote === undefined) throw new RemoteEngineError(result.error ?? `git ${op} failed`);
  return result.remote as T;
}

export function createRemoteEngine(binding: EngineBinding): RemoteEngine {
  const base = {
    pid: binding.pid,
    quiet: true,
    ...(binding.timeoutMs !== undefined ? { timeout: binding.timeoutMs } : {}),
    ...(binding.budgetUnits !== undefined ? { historyBudgetUnits: binding.budgetUnits } : {}),
  };
  return {
    async listRefs(request) {
      const result = await execGitNetwork(binding.ctx, binding.env, {
        ...base, op: 'remote-list', dir: '/', url: request.url, auth: request.auth, forPush: request.forPush,
      }, binding.network);
      return answer<ListRefsResult>(result, 'ls-remote');
    },
    async fetchPack(request) {
      const result = await execGitNetwork(binding.ctx, binding.env, {
        ...base,
        op: 'remote-fetch',
        dir: worktreeOf(request.gitDir),
        url: request.url,
        auth: request.auth,
        remoteFetch: {
          wants: request.wants,
          ...(request.depth !== undefined ? { depth: request.depth } : {}),
          ...(request.deepenSince !== undefined ? { deepenSince: request.deepenSince } : {}),
          ...(request.deepenNot?.length ? { deepenNot: request.deepenNot } : {}),
          ...(request.deepenRelative ? { deepenRelative: true } : {}),
          ...(request.filter !== undefined ? { filter: request.filter } : {}),
          includeTag: request.includeTag,
          updateShallow: request.updateShallow,
        },
      }, binding.network);
      const step = answer<FetchPackResult & { pending?: unknown }>(result, 'fetch');
      const { pending: _pending, ...done } = step;
      return done;
    },
    async pushPack(request) {
      const result = await execGitNetwork(binding.ctx, binding.env, {
        ...base,
        op: 'remote-push',
        dir: '/',
        url: request.url,
        auth: request.auth,
        remotePush: { commands: request.commands, atomic: request.atomic, pushOptions: request.pushOptions },
        remotePushPack: request.pack,
      }, binding.network);
      return answer<PushPackResult>(result, 'push');
    },
  };
}
