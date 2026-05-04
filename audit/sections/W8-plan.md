# W8 Plan — `child_process.spawn` (facet-mapped, Phase 1)

> **Wave:** W8 — node:child_process surface backed by FacetManager
> **Branch:** `w8-child-process` off `main` @ b266d1d
> **Phase:** 1 (facet-mapped pseudo-process). Phase 2 = real Linux process via SHIP-10537 container-in-DO; gated, out of scope.
> **Author:** autonomous wave runner — 2026-05-04

---

## 0. Problem statement

`node:child_process` is currently stubbed in `src/node-shims.ts:1017-1098` to return
"requires supervisor connection" errors. Every install that ships `husky`, `concurrently`,
`cross-spawn`, or any postinstall hook silently fails — and the npm installer has no
postinstall execution path at all (verified: `grep -n postinstall src/` returns only
generated-file mentions and one env var). This is the largest single POSIX gap in the
runtime today.

Phase 1 ships a **real, working `child_process.spawn` backed by the existing facet
infrastructure**. Each spawned child is a freshly-minted dynamic-worker isolate executing
a tiny "command runner" entry that resolves the requested command against the same
registry the supervisor's shell uses. stdin/stdout/stderr stream live over RPC, exit
codes propagate, and SIGTERM/SIGKILL terminate the facet via the abort path that
already works for `kill <pid>` in the terminal.

This is not POSIX. It does not run real binaries. It does not give you `/proc`. It
runs the same command surface the user already runs at the terminal prompt — and every
npm package that calls those commands stops failing.

---

## 1. Architecture: facet-as-process

```
┌────────────────────────────────────────────────────────────────────┐
│  Supervisor DO (NimbusSession)                                     │
│                                                                    │
│  ┌─────────────────────────┐    ┌────────────────────────────┐    │
│  │ Outer node facet (PID 7)│    │ FacetProcessManager        │    │
│  │  user code runs here    │    │  pid → ChildHandle         │    │
│  │  it does:               │    │  pid → log buffers         │    │
│  │    cp.spawn('echo', …)  │    │  pid → exit slot           │    │
│  └─────┬───────────────────┘    └─────┬──────────────────────┘    │
│        │ SUPERVISOR.cpSpawn(req)       │                          │
│        │ ── RPC ────────────────────── │                          │
│        │                                ▼                          │
│        │                        spawn child facet (PID 12)        │
│        │                        via FacetManager.spawn(...)       │
│        │                                                          │
│        │ SUPERVISOR.cpRead(pid,fd)  ←── live stdout/stderr ──┐    │
│        │ SUPERVISOR.cpWrite(pid,d)  ──→ child stdin queue    │    │
│        │ SUPERVISOR.cpKill(pid,sig) ──→ ctx.facets.abort     │    │
│        │ SUPERVISOR.cpWait(pid)     ←── exitCode / signal    │    │
│        ▼                                                     │    │
│  ChildProcess emitter  ── 'data' / 'exit' / 'close' ────────┘    │
│  (in user's parent isolate)                                       │
└────────────────────────────────────────────────────────────────────┘
```

### Key design choices

- **Supervisor as broker.** The parent facet cannot directly speak to the child facet;
  it would need a service binding it doesn't have. The supervisor already owns
  `FacetManager`, the `ProcessTable`, and the per-process `ProcessLogStore` ring buffer.
  All four IPC verbs (spawn, read, write, kill, wait) become RPC methods on
  `SupervisorRPC` and route through a new `FacetProcessManager` on the supervisor side.

- **Reuse, don't reinvent.**
  - `ProcessTable.spawn()` already allocates PIDs and tracks state. ✓
  - `FacetManager.exec()` already runs JS in an isolated facet with timeout. ✓
  - `ProcessLogStore.append()` already maintains the per-PID ring buffer used by `logs <pid>`. ✓
  - `ctx.facets.abort()` already kills facets (`FacetManager.kill()` line 1157). ✓
  - `PortRegistry.unregisterByPid()` already cleans up by PID. ✓

- **No real polling.** The parent's stdout `.on('data', …)` listener fires from
  `cpRead` long-poll RPCs initiated by the parent, not from server pushes. Workers RPC
  is request/response; we cannot "push" from supervisor to child. Long-poll with
  bounded timeout (250ms) keeps latency under typical perceptible thresholds without
  burning the 30s wall-clock budget on idle.

- **stdin is a queue.** The supervisor maintains a per-PID stdin byte queue. Child
  facets call `SUPERVISOR.cpReadStdin(pid)` in their startup loop; the supervisor
  returns whatever's queued (or empty after a short wait). Parent's
  `child.stdin.write(data)` enqueues. EOF = `child.stdin.end()` enqueues a sentinel.

- **No fork(), no exec().** `spawn` is the primitive. `exec`, `execFile`, `execSync`,
  and `fork` are built on top of `spawn` per the Node docs. `execSync` cannot truly
  block in V8 — it'll return a synchronous-looking promise wrapper that swaps the
  return value once the spawn settles, matching the "best effort" stance W3 took for
  `crypto.randomFillSync` etc. We document this limit explicitly.

### Command resolution

The child facet runs a generated entry script that does:

1. Inspect `argv[0]` — the requested command name.
2. Look it up in the shell command registry (built-ins like `echo`, `node`, `npm`,
   `git`, `husky`, …) by RPC: `SUPERVISOR.cpResolveCommand(name)`.
3. If the supervisor returns `kind: 'builtin'`, the child runs the command via
   `SUPERVISOR.cpRunBuiltin(name, args, env, cwd, stdin)` — the supervisor invokes its
   registered command and streams stdout/stderr back via `cpStdoutWrite`/`cpStderrWrite`
   RPCs already on the wire for the existing facet I/O path.
4. If the supervisor returns `kind: 'node-script'` (npm-bin shim, e.g.
   `node_modules/.bin/husky` is a shebang script), the child reads the script from
   VFS and dispatches it as a `node` invocation back into FacetManager.exec — same
   path the existing `node` registry command uses, but recursive.
5. If neither resolves, exit 127 ("command not found") — same shell semantics.

### Why two-level recursion is OK

A child facet that needs to run `node script.js` recurses into the supervisor's
`facetMgr.exec`, which spawns a *grandchild* facet. Each level adds one isolate plus
one RPC hop. The DO-Facets API (LOADER.get keyed by codeId) reuses warm slots, so
the overhead is "cold isolate or warm hit" per command, not "cold isolate per
command unconditionally". Recursion depth is naturally bounded by the user's script
graph (a husky postinstall isn't going to recurse 50 deep).

We cap explicit recursion at depth 8 (config: `CHILD_PROCESS_MAX_DEPTH`) to defend
against pathological loops and emit `EAGAIN` on exceed — better than running the
30s wall clock to abort.

---

## 2. IPC contract (parent ↔ supervisor ↔ child)

### Parent facet → supervisor RPC (added to `SupervisorRPC`)

```ts
// All take a parent PID for accounting; return a child PID.
async cpSpawn(req: {
  command: string;            // e.g. 'echo' or '/bin/sh' or 'node'
  args: string[];
  env: Record<string,string>;
  cwd: string;
  stdio: ('pipe'|'ignore'|'inherit')[]; // [stdin, stdout, stderr]
  detached?: boolean;
  shell?: boolean | string;   // run via shell? (we map to executeCommandLine)
}): Promise<{ childPid: number }>;

// stdin push (parent → child queue)
async cpStdinWrite(childPid: number, data: string): Promise<{ ok: boolean }>;
async cpStdinEnd(childPid: number): Promise<void>;

// stdout/stderr long-poll drain (parent pulls)
async cpReadOutput(childPid: number, fd: 1|2, sinceSeq: number, waitMs: number):
  Promise<{ chunks: { seq: number; data: string }[]; closed: boolean }>;

// signals
async cpKill(childPid: number, signal: string): Promise<boolean>;

// wait — long-poll exit. Returns immediately if already exited.
async cpWait(childPid: number, waitMs: number):
  Promise<{ done: boolean; exitCode: number | null; signal: string | null }>;
```

### Supervisor ↔ child facet RPCs (added to `SupervisorRPC`)

```ts
// Child reads pending stdin (long-poll)
async cpReadStdin(childPid: number, waitMs: number):
  Promise<{ data: string; ended: boolean }>;

// Child streams output back (already mirrors stdout/stderr but keyed by childPid
// rather than the supervisor's "active" pid). Reuses the ring buffer.
async cpStdoutChunk(childPid: number, data: string): Promise<void>;
async cpStderrChunk(childPid: number, data: string): Promise<void>;
async cpReportExit(childPid: number, exitCode: number, signal: string | null): Promise<void>;

// Child asks supervisor to resolve / run a command (the recursion knot)
async cpResolveCommand(name: string, cwd: string):
  Promise<{ kind: 'builtin' | 'node-script' | 'unknown'; nodeScriptPath?: string }>;

async cpRunBuiltinCommand(req: {
  childPid: number;        // for log routing
  name: string;
  args: string[];
  env: Record<string,string>;
  cwd: string;
  stdin: string;           // already-drained, since builtins are sync-style
}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

### `ChildProcess` emitter shape (parent isolate)

Returned by `child_process.spawn`. Inherits from `EventEmitter`. Fields:

| field        | type                          | notes                                      |
|--------------|-------------------------------|--------------------------------------------|
| `pid`        | `number`                      | child PID from `cpSpawn`                   |
| `exitCode`   | `number \| null`              | set on `exit`                              |
| `signalCode` | `string \| null`              | set on signal-induced exit                 |
| `killed`     | `boolean`                     | true after `kill()` even before exit fires |
| `connected`  | `boolean`                     | true while RPC channel is alive            |
| `stdin`      | `Writable`                    | `.write(d)` → `cpStdinWrite`               |
| `stdout`     | `Readable` (emitter)          | emits `'data'` from `cpReadOutput` poller  |
| `stderr`     | `Readable` (emitter)          | same as stdout, fd=2                       |
| `stdio`      | `[stdin, stdout, stderr]`     |                                            |
| `kill(sig)`  | `(s?:string)=>boolean`        | calls `cpKill`                             |
| `send(msg)`  | `(m:any)=>boolean`            | only for `fork()`; uses stdin queue + JSON |

Events:
- `'spawn'` — emitted once after first successful `cpSpawn` reply
- `'data'` (on stdout/stderr) — chunks from poll
- `'end'` — fd closed (after `closed: true` from poll)
- `'exit'` — `(code, signal)` from `cpWait`
- `'close'` — fired after `'exit'` AND after both stdio streams emitted `'end'`
- `'error'` — RPC failures, ENOENT, EAGAIN

---

## 3. Pipe shim implementation

Streams live entirely in the parent isolate; they don't traverse the wire. The
"backing" of `child.stdout` is a poll-loop fed by `cpReadOutput`:

```js
// pseudo-impl in node-shims.ts (CHILD code, embedded in __childProcessMod)
function _spawn(cmd, args, opts) {
  const child = new __eventsMod();           // EventEmitter
  child.pid = 0; child.exitCode = null; child.signalCode = null;
  child.killed = false; child.connected = false;

  // Stdio Readables — minimal: support .on('data'), .on('end'), .pipe()
  const mkReadable = () => {
    const r = new __eventsMod();
    r.readable = true;
    r._chunks = [];
    r.read = () => r._chunks.shift() || null;
    r.pipe = (dest) => { r.on('data', (d) => dest.write(d)); r.on('end', () => dest.end?.()); return dest; };
    return r;
  };
  child.stdout = mkReadable();
  child.stderr = mkReadable();

  // Stdin Writable — buffers, flushes via supervisor
  child.stdin = {
    writable: true,
    write: (d) => { __pendingIO.push(__supervisor.cpStdinWrite(child.pid, String(d)).catch(()=>{})); return true; },
    end: (d) => { if (d) child.stdin.write(d); __pendingIO.push(__supervisor.cpStdinEnd(child.pid).catch(()=>{})); },
  };

  // RPC: cpSpawn — async, but child needs to look "spawned" synchronously.
  // We return the emitter immediately and back-fill child.pid on resolve.
  __pendingIO.push((async () => {
    try {
      const { childPid } = await __supervisor.cpSpawn({
        command: cmd, args: args || [],
        env: { ...(__processMod.env || {}), ...(opts && opts.env) },
        cwd: (opts && opts.cwd) || cwd,
        stdio: (opts && opts.stdio) || ['pipe','pipe','pipe'],
        shell: (opts && opts.shell) || false,
      });
      child.pid = childPid; child.connected = true;
      child.emit('spawn');
      _runReadLoops(child);     // 250ms long-poll for fd 1 & 2
      _runWaitLoop(child);      // long-poll for exit
    } catch (e) {
      child.emit('error', e);
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
    }
  })());

  child.kill = (sig) => {
    child.killed = true;
    __pendingIO.push(__supervisor.cpKill(child.pid, sig || 'SIGTERM').catch(()=>{}));
    return true;
  };

  return child;
}
```

The key insight: `_runReadLoops` and `_runWaitLoop` enqueue their promises onto
`__pendingIO`, the same array `node-shims.ts` already drains in the
"flush writes" phase before reportExit. This means a parent script that fires off
a spawn and immediately exits *without* awaiting still gets the child's stdout
emitted synchronously enough to land in stdout buffers before the parent's exit
report — same semantics as the SUPERVISOR.stdout path on line 247 of facet-manager.

---

## 4. Signal/exit semantics

- `SIGTERM` → child facet's wait loop polls and sees the supervisor flagged it killed;
  the wait-loop driver in the child facet calls `cpReportExit(pid, 143, 'SIGTERM')`.
  In Phase 1 we don't actually send a software interrupt — we mark and let the next
  yield-point pick it up. `setTimeout(0)` checkpoints in our inner runner are
  sufficient for any of the targets (echo, husky, etc.) whose work happens in
  small units.
- `SIGKILL` → `ctx.facets.abort(facetName, new Error('SIGKILL'))` mirrors the existing
  `FacetManager.kill()` path (line 1160). Exit code 137 (128 + 9) per POSIX
  convention. The supervisor stamps the exit slot before `abort()` returns so the
  parent's `cpWait` resolves correctly.
- Process exit codes are propagated unchanged from the child facet's run via the
  existing `FacetExecResult.exitCode` field.
- Signals other than `SIGTERM`/`SIGKILL` are accepted at the API but treated as
  SIGTERM internally (no real signal delivery infra). Documented limit; matches the
  honest-net-Socket posture from W3.

---

## 5. Code-diff sketches

### `src/facet-process.ts` (NEW, ~350 lines)

```ts
// Owns: childPid → ChildEntry map; per-child stdin queue; per-child stdout/stderr
// ring buffers; per-child exit slot. Exposes the methods that SupervisorRPC's
// cp* RPCs delegate to.

export interface ChildEntry {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string,string>;
  startedAt: number;
  // Stdin queue
  stdinChunks: string[];
  stdinClosed: boolean;
  stdinWaiters: Array<(d: { data: string; ended: boolean }) => void>;
  // Stdout/stderr ring (per fd)
  outputs: { 1: ChunkRing; 2: ChunkRing };
  // Exit slot
  exitCode: number | null;
  signal: string | null;
  exitWaiters: Array<(r: { exitCode: number|null; signal: string|null }) => void>;
}

export class FacetProcessManager {
  private children = new Map<number, ChildEntry>();
  constructor(
    private facetMgr: FacetManager,
    private processTable: ProcessTable,
    private processLogs: ProcessLogStore,
    private vfs: SqliteVFS,
    private commandRegistry: any, // shared with the shell
  ) {}

  async spawn(req: SpawnReq): Promise<{ childPid: number }> { ... }
  stdinWrite(pid: number, data: string): { ok: boolean } { ... }
  stdinEnd(pid: number): void { ... }
  async cpReadStdin(pid: number, waitMs: number): Promise<{data:string;ended:boolean}> { ... }
  appendOutput(pid: number, fd: 1|2, data: string): void { ... }
  async readOutput(pid: number, fd: 1|2, sinceSeq: number, waitMs: number) { ... }
  kill(pid: number, signal: string): boolean { ... }
  async wait(pid: number, waitMs: number) { ... }
  async resolveCommand(name: string, cwd: string) { ... }
  async runBuiltinCommand(req: RunBuiltinReq) { ... }
}
```

### `src/supervisor-rpc.ts` (PATCH, +~80 lines)

Add 9 new methods that are pure delegates to `_getStub()._cp*` calls; the
NimbusSession-side `_cp*` methods do parameter unpacking and call into the new
`facetProcMgr` it owns.

### `src/nimbus-session.ts` (PATCH, +~120 lines)

- Construct `FacetProcessManager` after `facetMgr`.
- Add `_rpcCpSpawn`, `_rpcCpStdinWrite`, …, `_rpcCpReadOutput`, `_rpcCpWait`,
  `_rpcCpKill`, `_rpcCpResolveCommand`, `_rpcCpRunBuiltin` methods.
- These are RPC entry points only; logic lives in `FacetProcessManager`.

### `src/node-shims.ts` (PATCH, ~150 line replacement)

Replace `__childProcessMod` (lines 1017-1098) with the real `_spawn` from §3,
plus `exec`/`execFile`/`fork` built on top.

### `src/facet-manager.ts` (PATCH, +~20 lines)

Expose `spawn-like` lower-level helper used by `FacetProcessManager.spawn` to
run the child-runner code in a new facet. The existing `exec()` is close but
returns the result; we want a non-blocking spawn that streams. Add
`execStream(code, opts, onStdout, onStderr): Promise<exitCode>` that calls
`_execViaFacets` but gives the supervisor's per-PID hooks instead of waiting
for the joined result.

### `src/index.ts` and `src/_shared/real-node-imports.ts`

No changes — `child_process` is supplied by our shim, and we don't require the
real `node:child_process` import.

---

## 6. Test plan (Phase B)

### `audit/probes/w8/functional/`

1. **spawn-echo-stdout.mjs** — spawn `echo hello world`, await `'data'` on stdout,
   assert content. Verifies the read-loop + cpReadOutput plumbing.
2. **spawn-exit-code.mjs** — spawn `true` and `false`, assert exitCode 0 vs 1.
3. **exec-callback.mjs** — `exec('echo a; echo b')` returns `(err=null, stdout, stderr)`.
4. **stdin-pipe.mjs** — spawn `cat`, write 3 lines to stdin, end(), assert echoed back.
5. **kill-sigterm.mjs** — spawn `sleep 5`, `kill('SIGTERM')`, assert `exit` fires
   with non-null signal within 1s.
6. **fork-ipc-channel.mjs** — `fork('worker.js')`, `child.send({hello:'world'})`,
   worker sends back `{ack:true}`, parent receives via `'message'` event.
7. **shell-pipeline.mjs** — `spawn('sh', ['-c', 'echo a | grep a'])`, verify stdout=`a\n`.
8. **execfile-args.mjs** — `execFile('node', ['-e', 'console.log(42)'])` returns 42.

### `audit/probes/w8/regression/`

1. **install-pipeline-coverage.mjs** — bring forward W5's regression probe verbatim
   (it's a counter-shape check that doesn't depend on child_process). Asserts no
   new symbols leaked into `npm-installer.ts`'s public surface.
2. **node-shims-builtins-shape.mjs** — every previously-shimmed `node:*` builtin
   still exposes the same top-level keys after our patch (snapshot test —
   `Object.keys(builtins.fs).sort()` etc).

### `audit/probes/w8/e2e/`

1. **husky-install.mjs** — fresh project tmp, write `package.json` + `.husky/`,
   run `npm install husky`, then `npx husky install` — assert `.git/hooks/`
   would have been written (we synthesize a minimal git dir for the probe). Pass
   condition: exit code 0, no `ERR_CHILD_PROCESS_UNAVAILABLE` in stderr.
2. **concurrently-two-echo.mjs** — `npx concurrently 'echo a' 'echo b'`, assert
   both lines appear in stdout. Verifies real two-child stdout multiplexing.
3. **cross-spawn-echo.mjs** — `require('cross-spawn').sync('echo', ['hi'])`
   returns `{ stdout: 'hi\n', status: 0 }`. Verifies the `spawnSync`-shaped path.
4. **postinstall-success-rate.mjs** — synthetic test set: 10 packages with
   postinstall (husky, esbuild, sqlite3-wasm, lefthook, …). Run install; count
   how many postinstalls report exit 0. Acceptance: ≥ 60%.

### Test harness

Probes follow the W5 pattern: **node-side runners** that import `_mock-sql.mjs`
to instantiate a `SqliteVFS`, then directly construct `FacetProcessManager` with
mock dependencies (a fake `FacetManager` whose `execStream` we drive in-process).
Key insight: we don't need real workerd to test the FacetProcessManager — the
isolation only matters at runtime, and the spawn/stream/kill state machine is
pure JS.

For the `node-shims` half (parent-side `child_process` API), we evaluate the
generated SHIMS code as a function (mirroring how the facet does it) and inject
a mock `__supervisor` that records cpSpawn/cpReadOutput/etc. calls. This is
the same pattern W3 used to test the http2/repl shims.

---

## 7. Risk register

| # | Risk                                                        | Mitigation                                            |
|---|-------------------------------------------------------------|-------------------------------------------------------|
| 1 | Recursion: child needs to spawn → grandchild facet → 30s    | Cap depth via `__cpDepth` env propagation; EAGAIN     |
| 2 | Long-poll RPC budgets: 250ms × N polls per stdout chunk     | Coalesce: cpReadOutput drains *all* pending chunks    |
| 3 | Stdin queue grows unbounded if child slow to drain          | 256 KiB cap per child; cpStdinWrite returns ok=false  |
| 4 | EventEmitter `data` listener attached after spawn settles   | Buffer until first `'newListener'` event for `'data'` |
| 5 | `execSync` callers expect synchronous return                | Document limit; throw `ENOTSUP` rather than fake-sync |
| 6 | Postinstall scripts that call `chmod` / fs ops on /usr/bin  | Already no-op'd in unix-commands; success is good     |
| 7 | husky writes to `.git/hooks/` outside repo root             | VFS-backed git already supports it via cf-git fork    |
| 8 | concurrently uses pty/tty to color output                   | child.stdout.isTTY=false; concurrently degrades OK    |

---

## 8. Acceptance gate

- All `audit/probes/w8/**/*.mjs` exit 0 locally
- `bun x tsc --noEmit` produces no NEW errors (baseline = 2 pre-existing)
- ≥ 60% of postinstall-success-rate test set succeeds
- W5 regression probes still green (we share `install-pipeline-coverage`)

---

## 8.5. Sub-agent review revisions (2026-05-04, post-review)

The initial plan went out for sub-agent review and came back with three BLOCKERs
and seven MAJORs. The plan is updated below; the original sections above are
preserved for diff context but are superseded by these revisions.

### BLOCKER-1: read-loop draining vs unawaited parent exit

**Original §3:** parent isolate runs `_runReadLoops` polls on `__pendingIO`,
relies on the existing two-pass drain in facet-manager.ts:282-308 to flush.

**Problem:** `cpReadOutput` self-reschedules; `Promise.allSettled` only waits
for the in-flight poll, not the full output stream. Subsequent chunks after
the second drain are dropped before `reportExit`.

**Resolution:** Replace the long-poll-on-`__pendingIO` pattern with a
**parent-exit synchronous flush**. The exit path in node-shims.ts (the existing
`reportExit` block in facet-manager.ts:309-326) is patched to, before calling
`reportExit`, walk the live `__cpChildren` map and synchronously call
`__supervisor.cpDrainOutput(childPid)` for each. `cpDrainOutput` is a single
non-polling RPC that returns ALL pending output and a final `closed` flag.
The supervisor side (FacetProcessManager) drains the per-child ring buffer,
emits one final batch of `'data'` events, then closes the streams.

Read-loops during normal execution still happen via 250ms `cpReadOutput` polls
(otherwise live `console.log` from a long-running child wouldn't surface) but
they're **best-effort** during normal execution and **deterministic on parent
exit**.

### BLOCKER-2: cpRunBuiltinCommand recursion deadlock

**Original §1:** child facet calls `cpRunBuiltinCommand` for every resolved
shell builtin, including `node`/`npm`/`npx`/`git`.

**Problem:** running `node` in the supervisor isolate via `facetMgr.exec`
spawns a grandchild facet *while* the supervisor is mid-RPC to the child.
Memory blowup (no streaming), potential deadlock, redundant child hop.

**Resolution:** **Two execution kinds, chosen at the parent's `cpSpawn` time.**

```ts
// in FacetProcessManager.spawn (supervisor-side):
const kind = resolveCommandKind(req.command);
//   'pure-builtin'  — echo, cat, true, false, ls, env, sleep, … (sync, no facet recursion)
//   'facet-direct'  — node, npm, npx, git, sh, bash, husky, lefthook, …
//                     parent's cpSpawn directly mints a child facet that runs
//                     this command via FacetManager.execStream — no
//                     child→supervisor→grandchild recursion. The "child facet"
//                     IS the command's facet.

if (kind === 'pure-builtin') {
  // Run inline in supervisor isolate (no facet at all). Stream output to
  // the per-child ring buffer. Stamp exit slot. No recursion possible.
  this._runBuiltinInline(child, req);
} else {
  // Mint a facet directly. The facet's generated code is a thin wrapper
  // around the command's runner — for `node` that's the existing
  // generateFacetCode(); for `npm` it's a script-runner shim. There is
  // NO cpRunBuiltinCommand call from the child back to the supervisor.
  this._runViaFacet(child, req);
}
```

This eliminates the child→supervisor→grandchild recursion entirely. The child
facet is *the* facet; cpRunBuiltinCommand is dead and removed from the IPC
contract. The recursion-depth counter (`__cpDepth`) is still propagated via
env to defend against `node script.js` where script.js itself spawns more
children, but it never grows from a child→supervisor hop, only from
parent-script→spawned-child→that-child-spawning-more.

### BLOCKER-3: kill ordering / exit-slot stamping

**Original §4:** "supervisor stamps the exit slot before abort returns"
(unspecified).

**Resolution:** Make the FacetProcessManager kill path explicit:

```ts
kill(childPid: number, signal: string): boolean {
  const child = this.children.get(childPid);
  if (!child || child.exitCode !== null) return false;
  // 1. Stamp synchronously — first writer wins (mirrors ProcessTable.exit).
  child.signal = signal;
  child.exitCode = signal === 'SIGKILL' ? 137 : 143;
  child.killed = true;
  // 2. Resolve all pending waiters BEFORE we abort the facet — they read
  //    the just-stamped exit slot and see the right value, regardless of
  //    whether the facet's reportExit ever lands.
  for (const w of child.exitWaiters.splice(0)) w({ exitCode: child.exitCode, signal });
  for (const w of child.outputWaiters.splice(0)) w({ chunks: [], closed: true });
  for (const w of child.stdinWaiters.splice(0)) w({ data: '', ended: true });
  // 3. Now abort the facet. Best-effort; the slot is already stamped.
  try { (this.ctx as any).facets?.abort?.(child.facetName, new Error(signal)); } catch {}
  // 4. Defer delete to next microtask so any in-flight reportExit RPC
  //    finds the entry (and is no-op'd by the idempotent guard).
  queueMicrotask(() => {
    try { (this.ctx as any).facets?.delete?.(child.facetName); } catch {}
  });
  return true;
}

reportExit(childPid: number, exitCode: number, signal: string | null) {
  const child = this.children.get(childPid);
  if (!child) return;                             // already cleaned up
  if (child.exitCode !== null) return;            // first writer wins
  child.exitCode = exitCode;
  child.signal = signal;
  for (const w of child.exitWaiters.splice(0)) w({ exitCode, signal });
}
```

### MAJOR-A: spawnSync / execSync — fake-sync, not throw

**Original §1:** `execSync` throws ENOTSUP.

**Conflict:** §6 ships `cross-spawn-echo.mjs` calling `cross-spawn.sync`
(which calls `spawnSync`); cross-spawn is a headline target.

**Resolution:** ship `spawnSync` and `execSync` as **fake-sync**. They issue
a synchronous-style facade over an async cpSpawn + cpWait + cpDrainOutput
sequence, blocking the parent isolate via a busy-await pattern. The exact
Node semantics ("blocks the event loop") are unachievable in V8 from JS
land, but the *return value shape* and *order of side effects* match Node
closely enough for the targets:

```js
function execSync(cmd, opts) {
  let done = false; let result;
  exec(cmd, opts, (err, stdout, stderr) => { result = { err, stdout, stderr }; done = true; });
  // Fake-block: drain microtasks until done. We're in a facet, so parent
  // hasn't returned to its event loop yet — this works because facet
  // exits synchronously join all __pendingIO before reportExit (the same
  // mechanism the existing fs.readFileSync shim leans on).
  while (!done) { /* drain */ }
  if (result.err) throw result.err;
  return Buffer.from(result.stdout);
}
```

Because facets run with allow-microtasks-during-sync semantics already used
by other "Sync" shims in node-shims.ts (e.g. crypto.randomBytesSync, the
existing fs.readFileSync), this is consistent with the codebase's existing
posture. We document the limit in node-shims.ts comments.

### MAJOR-B: `git` resolution

**Resolution:** the FacetProcessManager's `resolveCommandKind` table treats
`git` as `'facet-direct'` AND wires a child-facet template that imports
`isomorphic-git` (cf-git fork) and dispatches a tiny CLI shim covering the
specific git subcommands husky uses (`config`, `rev-parse`, `init`, `add`,
plus a passthrough that errors on unsupported subcommands). The shim is
generated inline like `generateViteFacetCode` — ~80 lines.

Husky's hot path is `git config core.hooksPath .husky` + `git rev-parse
--git-common-dir`. We implement just those two correctly; everything else
exits 0 with stderr `"git: subcommand not yet wired"`. That's enough.

### MAJOR-C: real-workerd integration probes

**Resolution:** add two probes to `audit/probes/w8/e2e/` that attempt to
run against `wrangler dev` if `NIMBUS_W8_E2E_LIVE=1` is set; otherwise
they no-op-pass with a logged note. This matches the W5 e2e pattern's
`NIMBUS_W5_E2E_PROD=1` gating. The probes:

- `spawn-unawaited-exit.mjs` — parent script does `cp.spawn('echo','hi')`
  and immediately `process.exit(0)`. Asserts via `logs <pid>` that "hi\n"
  was captured (proves cpDrainOutput on parent exit).
- `spawn-then-kill-race.mjs` — parent spawns `sleep 5`, kills it after
  100ms, asserts exit code 137 + signal 'SIGTERM'/'SIGKILL'.

We don't have wrangler auth in this autonomous session so the probes will
run in no-op-pass mode at the local audit gate; they're scaffolded for when
wrangler comes back and run against prod (mirrors W3/W5 deferred prod
gating).

### MAJOR-D: stream shape — back with real Readable/Writable

**Resolution:** child.stdout / child.stderr use the codebase's existing
`__streamMod.Readable` (already imported in node-shims:1029-1031 stub).
chunks are `push()`ed by the read-loop. Implements `setEncoding('utf8')`,
`pause`, `resume`, `Symbol.asyncIterator`, and `pipe` with the standard
`Readable` semantics workerd ships. No bespoke EventEmitter. Same for
`child.stdin` ⇒ `__streamMod.Writable`.

### MAJOR-E: fork IPC — document JSON limit, add roundtrip probe

**Resolution:** keep JSON for IPC. Add `fork-ipc-types.mjs` probe that
sends a Buffer + Date + plain object; asserts the plain object survives
exactly, and Buffer/Date come back as their JSON projections (Buffer →
`{type:'Buffer',data:[…]}`, Date → ISO string). Probe documents the limit
in its assertion messages so future readers see it.

### MAJOR-F: postinstall basket honesty

**Resolution:** split the postinstall test set into:
- `should-pass` (husky, lefthook, yorkie, simple-git-hooks, lint-staged) —
  100% required.
- `expected-fail-platform` (esbuild, sqlite3-node-prebuilt, sharp) — counted
  separately; their failure is acceptable Phase 1 behavior. Plan §0
  acceptance becomes "100% should-pass" rather than "60% of 10".

### MINOR / NIT items

- **kill before spawn settles:** add `pendingKill: boolean` flag to
  ChildProcess; if set when childPid back-fills, immediately fire cpKill.
- **cpReadOutput sinceSeq:** add `seq` to per-chunk records in
  `ChunkRing`; supervisor returns max-seq alongside the chunks.
- **cpDepth env propagation:** every `cpSpawn` reads
  `req.env.NIMBUS_CP_DEPTH || '0'`, increments, propagates to the child.
  EAGAIN at depth 8.

These revisions tighten the contract from 9 RPC methods to 7 (cpRunBuiltin
and cpResolveCommand are removed; cpDrainOutput is added). The
FacetProcessManager grows by ~50 LOC for the kill/reportExit idempotency
and the resolveCommandKind table.

---

## 9. What we're NOT building

- Real fork() copy-on-write semantics
- Real Linux processes (Phase 2, gated on SHIP-10537)
- /proc, /sys, posix_spawn, /dev/pts
- Real signal numbers (only SIGTERM/SIGKILL as facet-abort flavors)
- pty/tty allocation (everything is `isTTY: false`)
- detached subreaping (subprocess outlives parent)
- uid/gid switching (already noop'd in unix-commands)

These are explicit Phase 2 deferrals, tracked in the wave's retro.
