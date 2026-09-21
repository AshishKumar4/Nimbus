import { registerHostedCommands } from '../hosted/commands.js';
import { runtimeCatalogSource } from '../runtime/runtime-catalog.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { parentVfsPath, stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
// Runtime factories (clang/python/ruby/bash/wasm) are imported lazily at
// first-use inside their registered handlers — see the registrations below.
// Keeping them off the top-level import graph shaves their module-eval cost
// (zod, embedded socket-kernel/shim sources, wasm loaders) out of the
// one-time Worker Startup Time paid on every fresh-isolate cold run.
// Runtime factories (clang/python/ruby/bash/wasm) are imported lazily at
// first-use inside their registered handlers — see the registrations below.
// Keeping them off the top-level import graph shaves their module-eval cost
// (zod, embedded socket-kernel/shim sources, wasm loaders) out of the
// one-time Worker Startup Time paid on every fresh-isolate cold run.
import { hasSeededProject, SEED_PROJECT_DIR, SEED_PROJECT_NAME, SEED_PROJECT_TILDE } from '@nimbus-sh/core/vfs/seed-project.js';
import { generation } from '@nimbus-sh/fabric/generation.js';
import { DEFAULT_MOUNT_POINTS } from '@nimbus-sh/core/constants.js';
import { ensureSessionStateSchema, loadShellState, stampHydratedAt, countSessionStateKeys, loadKernelMounts, persistKernelMounts, loadScrollback } from './state-store.js';
import { recordRecoveryEvent } from '@nimbus-sh/platform/oom-discriminator.js';
import { sessionAiEnv } from './ai.js';
import { setPhase } from './init-phases.js';
import { shellTerminalTee } from './ws.js';
function quoteShellArgument(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export async function initSession(self, ws, options = {}) {
    const replayScrollback = options.resume !== 'wake';
    self.ensureSqliteFs();
    const kernelFs = self.sqliteFs.as(CRED_KERNEL);
    self.ensureFacetManager();
    self.seedFilesystem();
    // ── Phase R: rehydrate session state from DO SQLite [B'.1] ──────────
    //
    // Track B' invariant: every observable session field has a SQL-backed
    // source of truth. The fresh Shell/Kernel/Terminal we build below are
    // CACHES of those rows — initialised from the snapshot if a row
    // exists (silent re-init), defaults otherwise (true cold start).
    //
    // hasPersistedState is the cold-vs-rehydrate discriminator. The
    // `hydratedAt` field lets the /api/_diag/session debug endpoint
    // surface "this DO instance found a row at <ts>" for forensic
    // tooling.
    // [B'.4] Phase R — Rehydrate. Read persisted state values from DO
    // SQLite. Pure SQL reads; the actual application of these values
    // (Shell ctor params, mount list, scrollback bytes) happens in
    // later phases.
    setPhase(self, 'rehydrate', 'init-session');
    ensureSessionStateSchema(self.ctx);
    const persisted = loadShellState(self.ctx);
    // [B'.4] Phase W (early-wire) — construct WebSocketTerminal with
    // the B'.3 scrollback tee. Marked as 'wire' here even though
    // 'build' hasn't run yet because the terminal is the WS-facing
    // facet and the scrollback replay below is wire-phase work.
    // Phase B will tag in once we start building the kernel.
    setPhase(self, 'wire', 'init-session');
    self.terminal = new WebSocketTerminal(ws, shellTerminalTee(self));
    // [B'.3] Replay persisted scrollback BEFORE the cold-start UI gate.
    // On rehydrate (hasPersistedState=true) we emit the prior
    // session's terminal contents as a single batched write — the
    // user reconnects to "where they left off" + a fresh prompt.
    // On cold start (no row) loadScrollback returns '' so this is a
    // no-op and the MOTD/Phase O block below runs normally.
    //
    // The replay itself goes through terminal.write → flush → tee,
    // so the replayed bytes also re-append to scrollback. That's the
    // correct semantics: a user who reconnects twice should see the
    // same scrollback both times. The cap eviction keeps total bytes
    // bounded.
    if (persisted.hasPersistedState) {
        if (replayScrollback) {
            try {
                const replay = loadScrollback(self.ctx);
                if (replay.length > 0)
                    self.terminal.write(replay);
            }
            catch (e) {
                try {
                    console.warn('[B\'.3] scrollback replay failed:', e?.message || e);
                }
                catch { }
            }
        }
        // The scrollback stops mid-command when the previous instance was
        // reset under it — the platform kills the isolate without running a
        // line of our code, so nothing could be said at the time and the
        // socket died with close code 1006 and no frame. Say it now, on the
        // first socket that exists to say it on: this is the only moment the
        // session can tell a user why their terminal went dead.
        //
        // Deliberately claims nothing about the cause. A restarted instance
        // cannot observe whether it was evicted, redeployed, or killed for
        // memory — that verdict only ever reaches an operator's `wrangler
        // tail`, and inventing one here would be worse than the silence.
        // What IS certain is stated: the process table is this instance's,
        // and it starts empty.
        self.terminal.write('\x1b[33m[nimbus] this session resumed on a new instance. Anything still '
            + 'running was lost with the old one — re-run it if it had not finished.\x1b[0m\r\n');
    }
    // A reset that killed a resident launch left its journal row behind
    // (fabric's FencedWork.recoverInterrupted). The alarm the dying
    // instance was using for launch turns is NOT a trigger recovery can rely
    // on — measured live, a launch killed early in its first chunks rolls the
    // alarm-map put back with the rest of the dying turn, so the replacement
    // instance never fires an alarm at all. What always follows a dead session
    // is this reconnect, so recovery runs here: after the terminal exists (the
    // report lands in front of the user, live) and after the constructor's
    // pidBase gate (the journal predicate needs this instance's generation).
    // Idempotent per instance; a no-op whenever no launch was interrupted.
    await self.facetManager.pumpResidentLaunches();
    // [B'.4] Phase B — Build. Compose the workspace (kernel + mounts +
    // shell + the OS command set), then install the session's own
    // commands and wiring on top. CPU-intensive phase. Spans from here
    // through Phase O.
    setPhase(self, 'build', 'init-session');
    // ── Mount list = DEFAULT_MOUNT_POINTS ∪ persisted-mounts [B'.2] ──
    //
    // The defaults are always present (they're platform invariants);
    // any extras a future custom-mount feature might add survive
    // reconnect via the nimbus_kernel_mounts table. The persist step
    // below writes the merged list back so the table tracks the live
    // mount tree — today the same 7 rows every initSession.
    const persistedMounts = loadKernelMounts(self.ctx);
    const mountPoints = Array.from(new Set([
        ...DEFAULT_MOUNT_POINTS,
        ...persistedMounts,
    ]));
    // ── What the session adds to the workspace's environment [B'.1] ──
    //
    // The platform defaults — PATH, PS1, HOME, PORT, HOST and the rest —
    // belong to the workspace (core/workspace/nimbus-workspace.ts) because
    // they are the OS's, not this transport's. What is genuinely the
    // session's layers here:
    //
    //   NIMBUS_SESSION_ID — derived from sessionBasePath = "/s/<id>". Set
    //                here as a placeholder ("") and patched below right
    //                after the shell exists, so the user's first command
    //                sees the real id. Sentry / Datadog / any ops
    //                integration that wants a session-stable token reads it.
    //
    //   sessionAiEnv() — the session AI gateway (session/ai.ts). A coding
    //                agent, a user's own script or curl reaches the
    //                session's models from these without being configured:
    //                by OPENAI_BASE_URL if it reads one, and otherwise by
    //                CLOUDFLARE_API_KEY, this session's capability token,
    //                which mediates the tool's own egress back to the
    //                gateway (_shared/ai-egress.ts).
    //
    //   persisted.env — the user's own `export FOO=bar`, which survives
    //                reconnect and wins over everything above. A user who
    //                exports their own OPENAI_BASE_URL or CLOUDFLARE_API_KEY
    //                still wins; their key is not this session's token, so
    //                their request goes to their own account.
    const envOverlay = {
        NIMBUS_SESSION_ID: '',
        ...sessionAiEnv(),
        ...(persisted.env || {}),
    };
    // ── The identity the shell acts under ──
    //
    // Every command the shell runs is credentialed by a live entry in the
    // session's process table, which is what makes `sudo`, `chown` and the
    // per-process umask mean anything. A workspace with no host process
    // table falls back to a bare uid-1000 identity; this one has one.
    if (self.shellProcessPid !== null) {
        self.processes.exit(self.shellProcessPid, 0);
    }
    // ── The workspace: one recipe for kernel + mounts + shell + coreutils ──
    //
    // No `facets`: the session registers its own runtime factories below,
    // because the ones it needs carry REPLs, a resident-process substrate
    // and clang, none of which a bare facet host reaches. Everything the
    // workspace does register is the OS, and is identical either way.
    const workspace = await NimbusWorkspace.create({
        sql: self.ctx.storage.sql,
        // The filesystem this DO already opened. `ensureSqliteFs` above may
        // have been called many requests ago; a second SqliteVFS over the
        // same rows would be a second cache serving stale reads.
        vfs: self.sqliteFs,
        filesystem: () => self.getFilesystemAuthority(),
        mounts: mountPoints,
        env: envOverlay,
        terminal: self.terminal,
        processes: self.processes,
        runtimeSource: runtimeCatalogSource(self.env),
    });
    self.runtimeWorkspace = workspace;
    self.shellProcessPid = workspace.shellProcessPid;
    self.kernel = workspace.kernel;
    self.shell = workspace.shell;
    const kernel = workspace.kernel;
    const registry = workspace.registry;
    const processRegistry = kernel.processRegistry;
    const env = workspace.env;
    const sqliteFs = self.sqliteFs;
    const facetMgr = self.facetManager;
    try {
        persistKernelMounts(self.ctx, mountPoints);
    }
    catch { /* fail-soft */ }
    // ── editor/monaco (2026-05-13): editor-pane fs bridge ──
    //
    // The terminal hosts the WS that the editor pane reuses for
    // fs-read / fs-write / fs-list messages. We install the handler
    // here because this is the first point in init where sqliteFs is
    // in scope; the terminal stays a stable instance across warm
    // rejoins (attach() swaps ws ref), so installing once is enough.
    //
    // Protocol (all replies are paired `<type>-result` frames):
    //   IN  { type:'fs-read',  path }
    //   OUT { type:'fs-read-result',  path, content?, error?, binary? }
    //   IN  { type:'fs-write', path, content }
    //   OUT { type:'fs-write-result', path, ok, error? }
    //   IN  { type:'fs-list',  dir, recursive? }
    //   OUT { type:'fs-list-result',  dir, entries:[{path,type}], error? }
    //
    // Binary refuse: fs-read uses readFile(bytes) + fatal:true UTF-8
    // decode. Throws on invalid bytes → reply { binary:true } with no
    // content. The editor pane shows a friendly placeholder; this is
    // the same heuristic hardening-r5 already uses for VFS<->facet
    // serialization (see manager.ts _readBundleCell).
    //
    self.terminal.onFs((msg, reply) => {
        try {
            if (msg.type === 'fs-read') {
                const p = stripLeadingSlashes(String(msg.path || ''));
                if (!kernelFs.exists(p)) {
                    reply({ type: 'fs-read-result', path: msg.path, error: 'ENOENT: no such file or directory' });
                    return;
                }
                if (kernelFs.isDirectory(p)) {
                    reply({ type: 'fs-read-result', path: msg.path, error: 'EISDIR: is a directory' });
                    return;
                }
                // Read bytes; attempt strict UTF-8 decode. Non-UTF-8 → mark
                // binary so the editor shows a friendly placeholder rather
                // than mojibake.
                const bytes = kernelFs.readFile(p);
                try {
                    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    reply({ type: 'fs-read-result', path: msg.path, content });
                }
                catch {
                    reply({
                        type: 'fs-read-result',
                        path: msg.path,
                        binary: true,
                        error: 'binary file (non-UTF-8) — editor cannot display',
                    });
                }
                return;
            }
            if (msg.type === 'fs-write') {
                const p = stripLeadingSlashes(String(msg.path || ''));
                if (!p) {
                    reply({ type: 'fs-write-result', path: msg.path, ok: false, error: 'empty path' });
                    return;
                }
                const parent = parentVfsPath(p);
                if (parent)
                    try {
                        kernelFs.mkdir(parent, { recursive: true });
                    }
                    catch { }
                const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
                kernelFs.writeFile(p, content);
                reply({ type: 'fs-write-result', path: msg.path, ok: true });
                return;
            }
            if (msg.type === 'fs-list') {
                const dir = stripLeadingSlashes(String(msg.dir || ''));
                const recursive = msg.recursive === true;
                if (dir && !kernelFs.exists(dir)) {
                    reply({ type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOENT' });
                    return;
                }
                if (dir && !kernelFs.isDirectory(dir)) {
                    reply({ type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOTDIR' });
                    return;
                }
                // BFS walk with per-call cap so a 10k-file project doesn't
                // ship a megabyte JSON frame. 2000 entries is well above
                // typical project sizes (vite scaffold = ~30 files; even
                // node_modules tree of a 50-dep project under 2000).
                const MAX_ENTRIES = 2000;
                const out = [];
                const queue = [dir];
                while (queue.length > 0 && out.length < MAX_ENTRIES) {
                    const cur = queue.shift();
                    let entries;
                    try {
                        entries = kernelFs.readdir(cur);
                    }
                    catch {
                        continue;
                    }
                    for (const e of entries) {
                        if (out.length >= MAX_ENTRIES)
                            break;
                        if (e.name === 'node_modules' || e.name === '.git')
                            continue; // skip noisy
                        const child = cur ? cur + '/' + e.name : e.name;
                        out.push({ path: '/' + child, type: e.type });
                        if (recursive && e.type === 'directory')
                            queue.push(child);
                    }
                }
                reply({
                    type: 'fs-list-result',
                    dir: msg.dir,
                    entries: out,
                    truncated: out.length >= MAX_ENTRIES,
                });
                return;
            }
            reply({ type: msg.type + '-result', ok: false, error: 'unknown fs message type' });
        }
        catch (e) {
            reply({
                type: msg.type + '-result',
                path: msg.path,
                dir: msg.dir,
                ok: false,
                error: (e?.message || String(e)),
            });
        }
    });
    // W8: hand the registry to the cp broker so child_process.spawn from
    // a parent facet can resolve and dispatch commands the same way the
    // shell does.
    const sessionIdFromBase = (self.sessionBasePath || '').replace(/^\/s\//, '');
    if (sessionIdFromBase) {
        // Shell.env is declared private but mutable at runtime — there's
        // no public setter. We `any`-cast deliberately; the alternative
        // (replacing the whole Shell after construction) would lose the
        // kernel + registry wiring. Anti-req note: this is NOT a defensive
        // cast, it's a deliberate single-write operation to plug the
        // contract gap that env-construction couldn't fill (sessionBasePath
        // wasn't yet hydrated when the workspace was composed).
        const shellAny = self.shell;
        if (!shellAny.env.NIMBUS_SESSION_ID) {
            shellAny.env.NIMBUS_SESSION_ID = sessionIdFromBase;
        }
    }
    if (persisted.cwd) {
        try {
            self.shell.setCwd(persisted.cwd);
        }
        catch { /* fail-soft */ }
    }
    await registerHostedCommands(self, workspace);
    // ── Phase O: one-shot online output [B'.1] ─────────────────────────
    //
    // Only emit cold-start UI (MOTD, starter-app hint, framework-detect)
    // when this initSession is actually a cold start. A silent re-init —
    // the same DO instance reaccepting a /ws upgrade after wsClose —
    // skips this block entirely. The user sees their persisted shell
    // (cwd preserved, env preserved) without a banner reprint that would
    // make the recovery look like a reset.
    //
    // The cold-vs-rehydrate discriminator is `persisted.hasPersistedState`
    // — true iff at least one nimbus_session_kv row was found at Phase R.
    // A truly cold DO (or one whose session-state was explicitly cleared
    // via /api/_test/session/reset) reads zero rows and falls through to
    // the cold-start path below.
    // [B'.4] Phase boundary: Build complete, transition to either
    // Online (cold start) or hydrated (warm re-init). Phase O runs
    // only on cold start; warm sessions skip the MOTD block and go
    // directly to hydrated.
    if (!persisted.hasPersistedState) {
        setPhase(self, 'online', 'init-session');
        // ── Show MOTD ──
        try {
            const motd = kernelFs.readFileString('etc/motd');
            self.terminal.write(motd + '\r\n');
        }
        catch { }
        // ── Starter-app hint (only if seed sentinel still exists) ──
        // We check the live VFS, not a static file, so that if the user
        // deletes ~/.nimbus-seeded (or the project dir) the hint stops
        // appearing on next login.
        try {
            if (hasSeededProject(self.sqliteFs) && kernelFs.exists(SEED_PROJECT_DIR)) {
                self.terminal.write(`\x1b[2mStarter app ready at \x1b[36m${SEED_PROJECT_TILDE}\x1b[0m\x1b[2m — try:\x1b[0m\r\n` +
                    `  \x1b[36mcd ${SEED_PROJECT_NAME} && npm install && npm run dev\x1b[0m\r\n\r\n`);
            }
        }
        catch { }
        // ── W11: framework detection MOTD line ──
        // If the seeded project dir has a recognizable framework, print one informational line.
        // Purely advisory — does not change boot behaviour. Fire-and-forget
        // because initSession is sync; any failure is silently swallowed.
        void (async () => {
            try {
                const projDir = SEED_PROJECT_DIR;
                const pkgPath = projDir + '/package.json';
                if (!kernelFs.exists(pkgPath))
                    return;
                const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
                const files = new Set();
                try {
                    for (const e of kernelFs.readdir(projDir))
                        files.add(e.name);
                }
                catch { }
                const fileContents = {};
                for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
                    if (files.has(c)) {
                        try {
                            fileContents[c] = kernelFs.readFileString(projDir + '/' + c);
                        }
                        catch { }
                    }
                }
                const { detectFramework, describeDetect } = await import('@nimbus-sh/core/runtime/framework-detect.js');
                const result = detectFramework({
                    pkg: { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, scripts: pkg.scripts },
                    files,
                    fileContents,
                });
                if (result.framework !== 'unknown' && result.framework !== 'vite' && self.terminal) {
                    self.terminal.write('\x1b[2m[nimbus]\x1b[0m \x1b[36m' + describeDetect(result) + '\x1b[0m\r\n\r\n');
                }
            }
            catch { /* MOTD line is non-critical */ }
        })();
    }
    // ── Phase O cont.: record the lifecycle transition [B'.1] ──────────
    //
    // C'.2 recovery_event ring entry — every initSession call records
    // either a cold→hydrated (first connect) or drained→hydrated
    // interactive-liveness/error-recovery/ asserts both states show
    // dataLoss=false. Track B' guarantees this for in-isolate transitions;
    // a true cold-isolate boot reads no SQL row and shows
    // snapshotKeysRehydrated=0 (still dataLoss=false because there was
    // no state to lose).
    //
    // [B'.4] We also set the live phase indicator to 'hydrated' here.
    // For cold starts, the prior phase was 'online' (Phase O ran);
    // for warm re-inits, the prior phase was 'build' (Phase O
    // skipped). Setting to 'hydrated' is the terminal init phase
    // both paths end on.
    {
        const fromState = persisted.hasPersistedState ? 'drained' : 'cold';
        const snapshotKeys = countSessionStateKeys(self.ctx);
        try {
            recordRecoveryEvent({
                at: Date.now(),
                fromState: fromState,
                toState: 'hydrated',
                trigger: 'init-session',
                isolateGen: generation(self.ctx),
                dataLoss: false,
                snapshotKeysRehydrated: snapshotKeys,
            });
        }
        catch { /* observability is non-critical */ }
        // [B'.4] Update live phase. setPhase records its own transition
        // recovery_event; this one is the legacy/coarse marker that
        // C'.3 + B'.1 probes look for.
        self._b4Phase = 'hydrated';
        // Stamp hydrated_at for the /api/_diag/session debug endpoint.
        try {
            stampHydratedAt(self.ctx, Date.now());
        }
        catch { /* non-critical */ }
    }
    // ── Start shell ──
    //
    // Now, and not inside the workspace, because the login files are the
    // user's and may name any of the commands registered above. On a
    // reconnect it is not awaited: `shell.start()` registers the input
    // handler synchronously and the rc files apply as they finish, which is
    // what the terminal has always done. On a wake the caller has the
    // peer's frame in hand and delivers it the moment this returns, so the
    // prompt has to be on the terminal first — otherwise the line runs
    // alongside the rc files and its prompt lands before the shell's own.
    // Either way a user's broken rc file must not take the socket down.
    const started = workspace.start().catch((e) => {
        console.warn('[nimbus] shell start failed:', errorText(e));
    });
    if (options.resume === 'wake')
        await started;
    ws?.send(JSON.stringify({ type: 'ready' }));
}
