import { staticStdinReader } from "@nimbus-sh/core/shell/stdin-adapter.js";
import { loaderOutbound, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { composeFacetManager, type ComposedFacetManager, type FacetManagerHostHooks } from "../facets/compose.js";
import { FacetProcessManager, textBytes, type ChildOrigin, type OutputHooks } from "../facets/process.js";
import { isRuntimeInstallHint } from "../shell/npm-bin-entrypoints.js";
import {
  bindProcessTable,
  isDynamicWorkerDeadlock,
  issueProcessNews,
  withLaunchAdmission,
} from "@nimbus-sh/fabric/budgets.js";
import { CRED_KERNEL, CRED_SESSION_USER, type NimbusFilesystemAuthority, type VfsCred } from "@nimbus-sh/core/runtime/os-contracts.js";
import { ProcessFiles, ProcessView, X_OK } from "@nimbus-sh/core/runtime/process-files.js";
import { resolutionOf } from '@nimbus-sh/core/shell/exec-dispatch.js';
import type { ChildExit, Command, CommandContext, CommandInputStream, RunAsOptions } from "@nimbus-sh/core/substrate/lifo/commands/types.js";
import { KILLED_BY_SIGPIPE } from "@nimbus-sh/core/substrate/lifo/shell/signals.js";
import { isBrokenPipe } from "@nimbus-sh/core/substrate/lifo/utils/bytes-io.js";

import { resolveContext, type CommandRegistry } from "@nimbus-sh/core/substrate/lifo/commands/registry.js";
import { syscallError } from "@nimbus-sh/core/vfs/vfs-error.js";
import { errorText } from "@nimbus-sh/core/_shared/error-text.js";
import { PrebundlePool } from "../facets/prebundle-pool.js";
import { supervisorEsbuildService } from "../facets/esbuild-transform.js";
import type { NpmInstaller } from "../npm/installer.js";
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from "@nimbus-sh/core/constants.js";
import { notifyTerminalEvent } from "../runtime/process-logs-api.js";
// The supervisor terminates a facet's outbound sockets so inbound frames
// arrive as supervisor replies (VFS coherence witness 3).
import { WebSocketRelay } from "../session/ws-relay.js";
// ── Pure helpers in ../session/helpers.ts ────────
//
// renderNoDevServerHtml, BUNDLER_BIN_PREFIXES, NIMBUS_UNSUPPORTED_BINS,
// WRANGLER_IGNORED_FLAGS{,_WITH_VALUE}, WRANGLER_UNSUPPORTED_CONFIG_FIELDS,
// filterWranglerFlags, detectUnsupportedWranglerConfig, _CP_FACET_DIRECT,
// _CP_PURE_BUILTIN, _classifyCommand, detectBundlerBin, checkNodeModulesGuard
// all live in the helpers module now.
//
// They are imported here (so call sites in this file work unchanged) and
// re-exported (so external callers importing them from
// `./nimbus-session.js` keep working — back-compat).
// Helpers needed by this class file's own logic (not just re-export).
import { _classifyCommand } from "../session/helpers.js";
import { z } from "zod/v4";

import type { SessionInternal } from '../session/internal.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { IsolatePoolEnv } from '@nimbus-sh/fabric/isolate-pool.js';

/** What a builtin run for a process inherits from it: its pid, environment, directory and descriptors. */
type BuiltinIo = Pick<CommandContext, 'pid' | 'env' | 'cwd' | 'stdin' | 'stdout' | 'stderr' | 'isFdTerminal'>;

export interface HostedRuntimeEnv extends RuntimeCatalogEnv, IsolatePoolEnv {
  ASSETS?: Fetcher;
}

export type RuntimeServiceHost = Pick<SessionInternal,
  '_cpRegistry' | '_envFlagDefaultOn' | '_reportExternalExit' | '_rpcStderr' | '_rpcStdout' | 'supervisorRewindBridge' | 'buildFetchFn' | 'bundlePool' | 'ensureBundlePool' | 'ensureFacetManager' | 'ensureFetchProxy' | 'ensureSqliteFs' | 'esbuildService' | 'facetManagerComposed' | 'getFilesystemAuthority' | 'facetProcessManager' | 'fetchProxyEntrypoint' | 'npmInstaller' | 'portRegistry' | 'processes' | 'runtimeWorkspace' | 'shell' | 'sqliteFs' | 'terminal'
> & { webSocketRelay: WebSocketRelay | null };

export interface RuntimeServiceContext {
  readonly ctx: DurableObjectState;
  readonly env: HostedRuntimeEnv;
  notify(line: string): void;
  requestLaunchTurn(notBefore?: number): Promise<void>;
  resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch'];
  /**
   * Hold the host actor in memory while a resident process runs:
   * `armResidentKeepalive` (session/hibernation.ts) bound to the host's own
   * scheduler — the fabric timer mux for the session DO, the embedder's
   * lifecycle for a hosted runtime.
   */
  armResidentKeepalive: () => void;
  /** The host's own authority: a session has exactly one, and this is it. */
  filesystem: () => NimbusFilesystemAuthority;
  /** The workspace's network (`workspace.network`): its egress, when the host supplied one. */
  network: () => WorkspaceNetwork;
}

const CpFacetDirectPayloadSchema = z.object({
  command: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
  args: z.array(z.unknown()).optional().transform((value) => (value || []).map((item) => String(item))),
  env: z.record(z.string(), z.unknown()).optional().transform((value) => {
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value || {})) out[key] = String(item);
    return out;
  }),
  cwd: z.unknown().optional().transform((value) => value == null ? '/' : String(value)),
  stdin: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
  processPid: z.number().int().positive(),
}).passthrough();

function normalizeCpCommandName(name: string): string {
  const text = String(name || '').trim();
  if (!text.startsWith('/')) return text;
  const slash = text.lastIndexOf('/');
  const base = slash >= 0 ? text.slice(slash + 1) : text;
  const dir = text.slice(0, Math.max(0, text.length - base.length));
  if (dir === '/bin/' || dir === '/usr/bin/' || dir === '/usr/local/bin/') {
    return base;
  }
  return text;
}
export function ensureBundlePool(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): PrebundlePool {
    if (!self.bundlePool) self.bundlePool = new PrebundlePool(runtimeContext.env, runtimeContext.ctx);
    return self.bundlePool;
  }

export function ensureFacetManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): ComposedFacetManager {
    if (!self.facetManagerComposed) {
      // The manager is composed over the filesystem, so the filesystem comes
      // first. Cheap and idempotent; every caller already stood it up or is
      // about to.
      self.ensureSqliteFs();
      const filesystem = runtimeContext.filesystem();
      // The manager reaches the disk behind the authority (boot images, the
      // launch journal), so a host that credentials something other than this
      // session's SQLite filesystem cannot compose one.
      if (!(filesystem instanceof ProcessFiles)) {
        throw new Error('Nimbus: the facet manager needs the session ProcessFiles, not a foreign filesystem authority');
      }
      self.facetManagerComposed = composeFacetManager({
        ctx: runtimeContext.ctx,
        env: runtimeContext.env,
        processes: self.processes,
        portRegistry: self.portRegistry,
        vfs: filesystem.engine,
        filesystem,
        network: runtimeContext.network,
        ...(self.esbuildService ? { esbuild: self.esbuildService } : {}),
        hooks: {
          onExternalExit: (pid, code, reason) => self._reportExternalExit(pid, code, reason),
          deliverOutput: (pid, stream, bytes) => (stream === 'stdout' ? self._rpcStdout(pid, bytes) : self._rpcStderr(pid, bytes)),
          rewindProcessFiles: (pid) => self.supervisorRewindBridge(pid),

          requestLaunchTurn: (notBefore) => runtimeContext.requestLaunchTurn(notBefore),
          resolveWorkerLaunch: runtimeContext.resolveWorkerLaunch,
          notify: (line) => runtimeContext.notify(line),
          onSpawn: (pid, command, longRunning) => {
            const attachedTty = self.processes.get(pid)?.attachedTty === true;
            if (longRunning) {
              try { self.processes.openInput(pid); } catch {}
              // The one arming site: the journal's re-drive path comes back
              // through this same hook. See ensureResidentKeepalive.
              runtimeContext.armResidentKeepalive();
            }
            // Only surface long-running / user-visible spawns to keep
            // the terminal uncluttered. Short `node <file>` evals also
            // get a line because users want the pid for `logs`/`kill`.
            if (!self.terminal) return;
            const label = longRunning ? 'started (long-running)' : 'started';
            self.terminal.write(
              `\x1b[2m[facet ${label}: pid=${pid} cmd="${command}"]\x1b[0m\r\n`,
            );
            // Structured event so the tabs UI can auto-open a log tab
            // for long-running processes (vite, wrangler dev, etc.).
            notifyTerminalEvent(self.terminal, {
              type: 'spawn', pid, command, longRunning, attachedTty,
            });
          },
        },
      });
    }
    const composed = self.facetManagerComposed;
    // The session may create its esbuild after the manager exists, so it is
    // offered on every call. Either one transforms in the session's transform facet.
    if (self.esbuildService) {
      composed.manager.setEsbuildService(self.esbuildService);
    }
    return composed;
  }

export function _ensureWebSocketRelay(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): WebSocketRelay {
    if (!self.webSocketRelay) self.webSocketRelay = new WebSocketRelay(runtimeContext.network);
    return self.webSocketRelay;
  }

export function _ensureFacetProcessManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext) {
    if (self.facetProcessManager) return self.facetProcessManager;
    self.ensureSqliteFs();
    self.ensureFacetManager();
    /** The namespace as process `pid` sees it under `cred`. */
    const processView = (pid: number, cred: VfsCred): ProcessView => new ProcessView(self.getFilesystemAuthority().bind({ pid, cred }));
    // FacetProcessManager is statically imported at top-of-file (W8).
    // No lazy-import: workerd doesn't ship CJS require, and the dynamic
    // import would be async — making _ensureFacetProcessManager async
    // would force every cp* RPC entry point to also be async on the
    // promise-resolution path, which is fine but uglier. Compile-time
    // tree-shaking handles unused-when-no-cp-RPC paths.
    // Adapter for FacetManagerLike — wraps the existing FacetManager.exec
    // with a streaming surface. Phase 1 simplification: facet-direct
    // commands are dispatched through the shell registry the same way
    // shell.execute does, but with the per-PID hooks routed.
    const facetMgrAdapter = {
      execStream: async (
        codeJson: string,
        opts: { facetName?: string; cwd?: string; env?: Record<string, string>; argv?: string[]; stdin?: CommandInputStream },
        hooks: OutputHooks,
      ): Promise<number> => {
        // codeJson is a payload from FacetProcessManager._dispatch facet-direct
        // path: {command, args, env, cwd, stdin}. We dispatch through the
        // existing shell registry by resolving the command and invoking
        // it with synthesized output streams that route to hooks.
        let payload: z.infer<typeof CpFacetDirectPayloadSchema>;
        try {
          const parsed = CpFacetDirectPayloadSchema.safeParse(JSON.parse(codeJson));
          if (!parsed.success) {
            hooks.onStderr(textBytes('child_process: facet dispatch requires a broker-assigned process pid\n'));
            return 1;
          }
          payload = parsed.data;
        } catch {
          hooks.onStderr(textBytes('child_process: invalid facet dispatch payload\n'));
          return 1;
        }
        const registry = self._cpRegistry;
        if (!registry) {
          hooks.onStderr(textBytes('child_process: command registry unavailable\n'));
          return 127;
        }
        // Only a child the broker is still running is launched. One it has
        // ended (killed before its program started) or forgotten is refused,
        // never run apart from the parent that spawned it.
        if (!self.facetProcessManager?.isRunning(payload.processPid)) {
          hooks.onStderr(textBytes(`child_process: process ${payload.processPid} is not a running child\n`));
          return 1;
        }
        const commandName = normalizeCpCommandName(payload.command);
        const cred = self.processes.cred(payload.processPid);
        const vfs = processView(payload.processPid, cred);
        const cmd = await registry.resolve(commandName, resolveContext(payload.cwd || '/home/user', payload.env, vfs));
        if (!cmd) {
          hooks.onStderr(textBytes(`${payload.command}: command not found\n`));
          return 127;
        }
        // Synthesize a CommandContext for the internal shell substrate.
        const ac = new AbortController();
        const io = processIo(payload.processPid, payload.env || {}, payload.cwd || '/home/user', opts.stdin ?? staticStdinReader(payload.stdin || ''), hooks);
        const ctx = {
          ...io,
          cred,
          args: payload.args || [],
          vfs,
          signal: ac.signal,
          setUmask: (mask: number) => { self.processes.setUmask(payload.processPid, mask); },
          runAs: (targetCred: VfsCred, argv: string[], options?: RunAsOptions) => spawnBuiltin(options?.parent ?? io, targetCred, argv),
          // Reuse the broker's pid and let runtime RPC output reach its
          // live queues. A direct inline invocation without a managed child
          // still needs a captured result.
          __nimbusCaptureOutput: !self.facetProcessManager?.isChild(payload.processPid),
          // A child's runtime reads its stdin from its own live channel, the
          // broker's queue for its pid (NIMBUS_CP_CHILD_PID), as the parent writes it.
          ...(self.facetProcessManager?.isChild(payload.processPid) ? {
            __nimbusBinSpawn: { callerPid: payload.processPid, command: [payload.command, ...payload.args].join(' '), liveInput: true },
          } : {}),
        };
        // Admitted once on the Dynamic Worker ledger, before its preparation:
        // its transform, its prebundle and its program are that one worker,
        // in turn (withLaunchAdmission). A synchronous-stdin stop gives its
        // admission back while it waits, and requeues before preparing the
        // replay. A kill while it waits for room ends the wait; the launch
        // registers its own terminator once it runs, and aborting ctx.signal
        // still reaches it.
        self.processes.setTerminator(payload.processPid, () => ac.abort());
        try {
          const code = await withLaunchAdmission(
            runtimeContext.ctx,
            { pid: payload.processPid },
            ac.signal,
            () => { hooks.onStarted?.(); return cmd(ctx); },
          );
          return typeof code === 'number' ? code : 0;
        } catch (e: any) {
          // A program the ledger refused to start never ran: its spawn failed, for the broker to report.
          if (isDynamicWorkerDeadlock(e)) throw e;
          // Killed while it waited for room: nothing ran, and the kill has said how it ended.
          if (ac.signal.aborted) return 130;
          hooks.onStderr(textBytes(`${payload.command}: ${e?.message || String(e)}\n`));
          return 1;
        }
      },
      kill: (pid: number, signal: string): boolean => self.ensureFacetManager().manager.kill(pid, signal),
    };
    // Adapter for CommandRegistryLike. The shared shell registry is
    // attached to `this._cpRegistry` by the shell-init path (see
    // construction near line 2058 — registry passed as ctor arg there).
    const cmdRegistryAdapter = {
      // The static tables keep their kinds (node/npm/git/... run in a facet
      // even though they are registry entries too). Another registered
      // command runs inline, as a pure builtin. Any other name (a runtime
      // that is not installed is not registered) is a program
      // the child's PATH may find, which runs as one named by its path does
      // (facet-direct): its own pid, live stdin, its output on its queues.
      // That dispatch searches PATH from the child's cwd, as execvp does, and
      // finding nothing is "command not found", 127. Null (also 127) only
      // while no registry is attached.
      resolve: async (name: string, from: ChildOrigin) => {
        const commandName = normalizeCpCommandName(name);
        const classified = _classifyCommand(commandName);
        const registry: CommandRegistry | null = self._cpRegistry;
        if (!registry) return null;
        const view = processView(from.pid, self.processes.cred(from.pid));
        if (commandName.includes('/')) await view.access(commandName.startsWith('/') ? commandName : `${from.cwd}/${commandName}`, X_OK);
        const registered = await registry.resolve(commandName, { ...resolveContext(from.cwd, from.env, view), search: false });
        if (registered && !isRuntimeInstallHint(registered)) return classified ?? { kind: 'pure-builtin' as const };
        const program = await registry.resolve(commandName, resolveContext(from.cwd, from.env, view));
        if (!program || isRuntimeInstallHint(program)) return null;
        const resolved = resolutionOf(program);
        if (resolved?.kind === 'program') await view.access(resolved.path, X_OK);
        return { kind: 'facet-direct' as const };
      },
      runPureBuiltin: async (
        pid: number,
        name: string,
        args: string[],
        env: Record<string, string>,
        cwd: string,
        stdin: CommandInputStream,
        hooks: OutputHooks,
      ): Promise<number> => {
        const registry: CommandRegistry | null = self._cpRegistry;
        if (!registry) { hooks.onStderr(textBytes('cp: registry unavailable\n')); return 127; }
        const view = processView(pid, self.processes.cred(pid));
        const cmd = await registry.resolve(normalizeCpCommandName(name), resolveContext(cwd, env, view));
        if (!cmd) { hooks.onStderr(textBytes(`${name}: command not found\n`)); return 127; }
        return (await runBuiltin(cmd, name, args, processIo(pid, env, cwd, stdin, hooks))).status;
      },
    };
    /**
     * A process's descriptors, environment and directory: its stdin, and its
     * output over the broker's hooks. They are pipes (or /dev/null), never a
     * terminal: the broker has none to give a child, and a shell that took
     * its stdin for one read nothing from it.
     */
    const processIo = (pid: number, env: Record<string, string>, cwd: string, stdin: CommandInputStream, hooks: OutputHooks): BuiltinIo => ({
      pid,
      env,
      cwd,
      stdout: { write: (d: string) => hooks.onStdout(textBytes(String(d))), writeBytes: (d: Uint8Array) => hooks.onStdout(d) },
      stderr: { write: (d: string) => hooks.onStderr(textBytes(String(d))), writeBytes: (d: Uint8Array) => hooks.onStderr(d) },
      stdin,
      isFdTerminal: () => false,
    });
    /** A registry command run as process `io.pid`, on `io`'s descriptors, and how it ended. */
    const runBuiltin = async (cmd: Command, name: string, args: string[], io: BuiltinIo): Promise<ChildExit> => {
      const cred = self.processes.cred(io.pid);
      const ac = new AbortController();
      const ctx: CommandContext = {
        ...io,
        cred,
        args,
        vfs: processView(io.pid, cred),
        signal: ac.signal,
        setUmask: (mask: number) => { self.processes.setUmask(io.pid, mask); },
        runAs: (targetCred, argv, options) => spawnBuiltin(options?.parent ?? io, targetCred, argv),
      };
      try {
        const code = await cmd(ctx);
        return { status: typeof code === 'number' ? code : 0, signal: null };
      } catch (e) {
        // A write that finds its reader gone ends the process, silently.
        if (isBrokenPipe(e)) return KILLED_BY_SIGPIPE;
        await io.stderr.write(`${name}: ${errorText(e)}\n`);
        return { status: 1, signal: null };
      }
    };
    /**
     * runAs for a builtin run on a process's behalf: execvp of `argv` in a
     * child of `parent` under `cred`, inheriting `parent`'s descriptors,
     * environment and directory. A program that is not there is ENOENT, as
     * execvp fails, for the caller to report.
     */
    const spawnBuiltin = async (parent: BuiltinIo, cred: VfsCred, argv: string[]): Promise<ChildExit> => {
      const [name, ...args] = argv;
      if (name === undefined) return { status: 0, signal: null };
      const registry: CommandRegistry | null = self._cpRegistry;
      // Found as the child will run it: under its credential.
      const view = processView(parent.pid, cred);
      const cmd = registry ? await registry.resolve(normalizeCpCommandName(name), resolveContext(parent.cwd, parent.env, view)) : undefined;
      if (!cmd) throw syscallError('ENOENT', 'execvp', name);
      const child = self.processes.spawn(argv.join(' '), argv, parent.cwd, { parentPid: parent.pid, cred });
      // Its starter awaits it, and its program is its own work (as the
      // workspace's runAs counts them).
      const endAwait = self.processes.beginAwait(parent.pid, child.pid);
      const endWork = self.processes.beginWork(child.pid);
      let exitCode = 1;
      try {
        const ended = await runBuiltin(cmd, name, args, { pid: child.pid, env: parent.env, cwd: parent.cwd, stdin: parent.stdin, stdout: parent.stdout, stderr: parent.stderr, isFdTerminal: parent.isFdTerminal });
        exitCode = ended.status;
        return ended;
      } finally {
        endWork();
        endAwait();
        self.processes.exit(child.pid, exitCode);
      }
    };
    // The Dynamic Worker ledger's wait-for edges are the session's own
    // account of its processes: the table's children, and what a shell line
    // awaits (fabric ProcessWaitGraph); a change to either may let it tell a
    // wait nothing can satisfy.
    const ledgerCtx = runtimeContext.ctx;
    bindProcessTable(ledgerCtx, self.processes);
    self.facetProcessManager = new FacetProcessManager({
      facetMgr: facetMgrAdapter,
      processes: self.processes,
      vfsForProcess: (pid) => new ProcessView(self.getFilesystemAuthority().bind({ pid, cred: self.processes.cred(pid) })),
      commandRegistry: cmdRegistryAdapter,
      issueNews: (parentPid) => issueProcessNews(ledgerCtx, parentPid),
      shellExecutor: {
        execute: async (
          pid: number,
          commandLine: string,
          env: Record<string, string>,
          cwd: string,
          stdin: CommandInputStream,
          hooks: OutputHooks,
        ): Promise<number> => {
          const workspace = self.runtimeWorkspace;
          if (!workspace) {
            hooks.onStderr(textBytes('sh: shell unavailable\n'));
            return 127;
          }
          const cred = self.processes.cred(pid);
          const setUmask = (mask: number) => { self.processes.setUmask(pid, mask); };
          // The child inherits from the command that starts it: its pipes and redirections, and the directory a `cd` moved to.
          const runAs = (parent: CommandContext, targetCred: VfsCred, argv: string[]): Promise<ChildExit> =>
            spawnBuiltin(parent, targetCred, argv);
          // A shell of the child's own, from its cwd and environment. The
          // session shell is the terminal's, and children run at once: two
          // lines on it would each save and restore the shell's cwd and
          // variables over the other's. Its descriptors close as it ends.
          const shell = workspace.shellFor(pid, { cwd: cwd || '/home/user', env });
          try {
            const result = await shell.execute(String(commandLine), {
              onStdout: hooks.onStdout,
              onStderr: hooks.onStderr,
              stdin,
              commandContext: { pid, cred, setUmask },
              runAs,
            });
            return typeof result?.exitCode === 'number' ? result.exitCode : 0;
          } finally {
            await shell.closeDescriptors();
          }
        },
      },
    });
    return self.facetProcessManager;
  }

export function ensureFetchProxy(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, log?: (msg: string) => void): any | null {
    if (self.fetchProxyEntrypoint) return self.fetchProxyEntrypoint;

    try {
      const env = runtimeContext.env as any;
      if (!env?.LOADER?.load) {
        log?.('LOADER.load not available — using global fetch');
        return null;
      }

      // Buffered proxy: reads the entire response body into an ArrayBuffer
      // and returns it in ONE message instead of forwarding a ReadableStream.
      // In workerd local dev, streaming responses across a service-binding
      // RPC fabric opens a separate loopback socket PER chunk (~16KB), which
      // exhausts ephemeral ports for larger installs (npm registry packuments
      // are 500KB-3MB, tarballs up to 5MB). Buffering to arrayBuffer means
      // 1 stub call = 1 loopback connection, not N connections.
      //
      // 32MB cap prevents a malformed giant response from OOMing the proxy
      // isolate. Packages with tarballs larger than 32MB will fail to install
      // cleanly (returned as 413 → caller treats as failed fetch).
      const proxyCode = [
        'const MAX_BYTES = 32 * 1024 * 1024;',
        'export default {',
        '  async fetch(request, workerEnv) {',
        '    try {',
        '      const body = await request.json();',
        '      const resp = await fetch(body.url, {',
        '        method: body.method || "GET",',
        '        headers: body.headers || {},',
        '      });',
        '      // Check advertised Content-Length before buffering',
        '      const clStr = resp.headers.get("content-length");',
        '      if (clStr) {',
        '        const cl = parseInt(clStr, 10);',
        '        if (cl > MAX_BYTES) {',
        '          return new Response(',
        '            JSON.stringify({ error: "response too large: " + cl + " bytes (cap " + MAX_BYTES + ")" }),',
        '            { status: 413, headers: { "Content-Type": "application/json" } }',
        '          );',
        '        }',
        '      }',
        '      // Buffer entire body — ONE message, not streamed chunks',
        '      const buf = await resp.arrayBuffer();',
        '      if (buf.byteLength > MAX_BYTES) {',
        '        return new Response(',
        '          JSON.stringify({ error: "response exceeded cap: " + buf.byteLength + " bytes" }),',
        '          { status: 413, headers: { "Content-Type": "application/json" } }',
        '        );',
        '      }',
        '      return new Response(buf, {',
        '        status: resp.status,',
        '        statusText: resp.statusText,',
        '        headers: Object.fromEntries(resp.headers.entries()),',
        '      });',
        '    } catch (e) {',
        '      return new Response(JSON.stringify({ error: e.message }), {',
        '        status: 502,',
        '        headers: { "Content-Type": "application/json" },',
        '      });',
        '    }',
        '  }',
        '};',
      ].join('\n');

      const worker = env.LOADER.load({
        compatibilityDate: CF_COMPAT_DATE,
        compatibilityFlags: [...GUEST_COMPAT_FLAGS],
        mainModule: 'fetch-proxy.js',
        modules: { 'fetch-proxy.js': proxyCode },
        // The registry is reached through the workspace's egress, when it has one.
        ...loaderOutbound(runtimeContext.network()),
      });
      self.fetchProxyEntrypoint = worker.getEntrypoint();
      log?.('Fetch proxy worker created (singleton)');
      return self.fetchProxyEntrypoint;
    } catch (e: any) {
      log?.(`Fetch proxy creation failed: ${e?.message}`);
      return null;
    }
  }

export function buildFetchFn(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, log?: (msg: string) => void): ((url: string, init?: RequestInit) => Promise<Response>) | undefined {
    const entrypoint = self.ensureFetchProxy(log);
    if (!entrypoint) return undefined;

    return async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else if (typeof init.headers === 'object') {
          Object.assign(headers, init.headers);
        }
      }
      return entrypoint.fetch(new Request('http://fetch-proxy/do-fetch', {
        method: 'POST',
        body: JSON.stringify({ url, method: init?.method || 'GET', headers }),
      }));
    };
  }

export async function ensureNpmInstaller(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, onProgress?: (msg: string) => void): Promise<NpmInstaller> {
    self.ensureSqliteFs();
    if (!self.esbuildService) {
      if (!self.sqliteFs) throw new Error('Session VFS is not initialized');
      self.esbuildService = supervisorEsbuildService(runtimeContext.ctx, runtimeContext.env, self.getFilesystemAuthority().namespaceFs(CRED_KERNEL));
    }
    // Lazy-load the installer (+ its ~216 KB resolver/facet/loader-pool
    // subgraph) on first npm use so it stays out of the cold script-eval
    // graph. The install command paths that call this are already async.
    const { NpmInstaller } = await import('../npm/installer.js');
    // ── Lazy fetch-proxy ────────────────────────────────────────────
    // The fetch-proxy is a singleton dynamic worker (LOADER.load) that
    // buffers registry responses to dodge wrangler-local-dev port
    // exhaustion. It is only needed for the in-supervisor npm paths.
    // When the resolver and install paths run in facets (default-on),
    // they use bare globalThis.fetch and need no proxy, so the proxy is
    // built only when a facet path is disabled via its env flag.
    const useFacetResolver = self._envFlagDefaultOn('NIMBUS_FACET_RESOLVER');
    const useFacetInstall  = self._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL');
    const useBatchFacet    = self._envFlagDefaultOn('NIMBUS_FACET_NPM_INSTALL_BATCH');
    const needProxy = !(useFacetResolver && useFacetInstall && useBatchFacet);
    const fetchFn = needProxy ? self.buildFetchFn(onProgress) : undefined;
    if (!needProxy) {
      onProgress?.(`[npm] Lazy fetch-proxy: skipped (all facet paths default-on)`);
    }
    self.npmInstaller = new NpmInstaller(
      self.getFilesystemAuthority(),
      runtimeContext.ctx.storage.sql,
      {
        esbuild: self.esbuildService,
        bundlePool: self.ensureBundlePool(),
        ctx: runtimeContext.ctx,
        env: runtimeContext.env,
        onProgress,
        fetchFn,
        network: runtimeContext.network(),
      },
    );
    return self.npmInstaller;
  }

export function _envFlagDefaultOn(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, name: string): boolean {
    const raw = (runtimeContext.env as any)?.[name];
    if (raw === undefined || raw === null) return true;
    const s = String(raw).toLowerCase();
    if (s === '0' || s === '' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  }

export function ensureGlobalPrefixDirs(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, prefix: string): void {
    const fs = self.sqliteFs!.as(CRED_SESSION_USER);
    const dirs = [
      prefix,
      `${prefix}/lib`,
      `${prefix}/lib/node_modules`,
      `${prefix}/bin`,
    ];
    for (const dir of dirs) {
      if (!fs.exists(dir)) fs.mkdir(dir, { recursive: true });
    }
  }

export function bindRuntimeServices(host: RuntimeServiceHost, context: RuntimeServiceContext) {
  return {
    ensureBundlePool: ensureBundlePool.bind(null, host, context),
    ensureFacetManager: ensureFacetManager.bind(null, host, context),
    _ensureWebSocketRelay: _ensureWebSocketRelay.bind(null, host, context),
    _ensureFacetProcessManager: _ensureFacetProcessManager.bind(null, host, context),
    ensureFetchProxy: ensureFetchProxy.bind(null, host, context),
    buildFetchFn: buildFetchFn.bind(null, host, context),
    ensureNpmInstaller: ensureNpmInstaller.bind(null, host, context),
    _envFlagDefaultOn: _envFlagDefaultOn.bind(null, host, context),
    ensureGlobalPrefixDirs: ensureGlobalPrefixDirs.bind(null, host, context),
  };
}
