# ARCH-GAPS — Plan

Status: implement both gaps (NO deferral). G1 profile is the input;
this plan binds each gap to a concrete file:line target.

## §1 Gap #1 — child_process.spawn fresh-isolate-per-call

### §1.1 Today's path (verified by G1 S6)

```
facet (node script.js)
  cp.spawn(cmd, args, opts)
    → __supervisor.cpSpawn({ command, args, env, cwd, stdio, ... })
       (src/runtime/node-shims.ts:1476)
       → SUPERVISOR.cpSpawn (RPC, src/session/supervisor-rpc.ts)
          → NimbusSession.cpSpawn (RPC entry)
             → FacetProcessManager.spawn(req)
               (src/facets/process.ts:230)
               → _dispatch(child, kind, req)
                 ├ kind='pure-builtin' → commandRegistry.runPureBuiltin(...)
                 │                         ←── EXECUTES IN SUPERVISOR ──
                 ├ kind='facet-direct'  → facetMgr.execStream(payload, ...)
                 │                         (current adapter at
                 │                          nimbus-session.ts:675-722
                 │                          ALSO runs in-supervisor by
                 │                          calling registry.cmd(ctx)
                 │                          directly)
                 └ kind='unknown'        → exit 127
```

### §1.2 Decision

- **Per-spawn fresh isolate** for both pure-builtin AND facet-direct
  kinds. `runPureBuiltin` and `execStream` both move into a Worker
  Loader isolate launched per call.
- **Use NimbusFanoutPool** (already proven by F-1 install-batch and
  F-2 resolver fan-out) so we get auto-routing:
  - 1-4 concurrent spawns → POC C in-DO loader-pool
  - 5-32 concurrent spawns → POC B peer-DO with stable-id router
- **No pooling for `exec` short-lived calls** unless G3 measurement
  shows >2× cold-start vs warm-pool win. Default = always fresh.
- **Single-ownership invariant** (carried over from git-freeze Q-fix):
  buffers crossing the supervisor → loader → peer-DO RPC boundary
  get a defensive copy at each ingress (no shared ArrayBuffer/Uint8Array
  references that detach mid-call).

### §1.3 File:line targets

- `src/loaders/child-process/spawn-facet.ts` (NEW): per-spawn task body
  (`runSpawnInIsolate`). Self-contained (no `this`, no closure capture).
  Receives `{command, args, env, cwd, stdin}` + a serialised registry
  resolution; the task runs the registered command function inside the
  loader isolate's V8 context. Returns `{exitCode, stdoutChunks,
  stderrChunks}`. For builtins that need supervisor RPCs (e.g. `cat`
  reading from VFS), `env.SUPERVISOR` is wired via NimbusFanoutPool's
  default extraBindings.
- `src/loaders/child-process/spawn-pool.ts` (NEW): supervisor-side
  `ChildProcessSpawnPool` wrapping `NimbusFanoutPool`. Single
  `submitMany([{key:cmd, args:spec}], runSpawnInIsolate)` per layer of
  concurrent spawns, OR (more commonly) one-task `submitMany` per
  spawn. Tag = `cp-spawn`.
- `src/facets/process.ts:_dispatch` (~line 293): replace direct
  `commandRegistry.runPureBuiltin` and `facetMgr.execStream` calls with
  `await this.spawnPool.runOne(req, hooks)`. Hooks pipe stdout/stderr
  back to the per-pid output ring.
- `src/session/nimbus-session.ts:cpRegistry` setup (around line 670+):
  drop the in-supervisor `execStream` adapter; spawnPool is created at
  session init and held on `this`.

### §1.4 Risks accepted

| Risk | Mitigation |
|------|------------|
| Cold-start cost per spawn (~30-100 ms warm-isolate, ~200-500 ms cold) | Acceptance gate is per-spawn isolation PROVEN, NOT speedup. Cold-start is paid by callers; G7 records the median cold-start time. If users observe >500 ms regression on `npm test` patterns, follow-up wave can layer a tiny LRU pool on TOP of the fresh-isolate primitive. |
| Per-spawn isolate consumes part of the 50-isolate-per-process LRU | NimbusFanoutPool handles this: `IN_DO_THRESHOLD=5` keeps short bursts in-DO; longer bursts (npm test launching jest workers) flip to peer-DO and never touch the supervisor's loader-cap. |
| Builtin commands that read/write VFS (cat, ls, cp) need SUPERVISOR.* RPCs | env.SUPERVISOR auto-wired via NimbusFanoutPool's `extraBindings`. The same RPC surface used by resolve-facet, install-batch-facet works. |
| stdin streaming | Phase A: single-shot stdin (drained at task entry, mirroring `_drainStdinForBuiltin` shape). Phase B (out of scope): incremental stdin via supervisor pull-RPC. |

## §2 Gap #2 — long-running `node script.js` fork-to-loader

### §2.1 Today's path (verified by G1 S3)

```
shell: `node /home/user/app/server.js`
  registry.dispatch('node', ctx)
    → registry.cmd('node')(ctx)            (src/session/init.ts:214-331)
       → facetMgr.exec(code, opts)           (src/facets/manager.ts:1410+)
          → await facet.run(argsJson)         ← BLOCKS until script exits
                                              ← supervisor RPC stuck
```

### §2.2 Decision

- **Long-running detection** before `facetMgr.exec` is awaited:
  - **Static AST shape**: top-level `await`, `http.createServer`,
    `require('http').createServer`, `import http from 'http'`,
    `Bun.serve`, `Deno.serve`, `--watch` flag in argv.
  - **--watch** flag check on `args` is a fast-path (~free).
  - **Source scan**: substring sniff for the canonical patterns above
    (no AST parse — preamble has no parser; sniff with bounded regex
    same as `looksLikeEsm` in src/facets/manager.ts:933).
- **Fork** to `FacetManager.spawn` (already exists for vite, line 1778).
  It returns `{pid, facetStub}` immediately. The shell handler returns
  exit code 0 with `[started (long-running): pid=N cmd="node …"]`,
  matching the existing dev-server convention.
- **Short scripts stay on `facetMgr.exec`** (the existing fresh-isolate
  per-call path). G3 measures cold-start; G7 documents the threshold.

### §2.3 File:line targets

- `src/runtime/node-runner.ts` (NEW): centralizes long-running
  detection + dispatch. Exports
  - `detectLongRunning(code: string, args: string[]): boolean`
  - `runNodeScript(facetMgr, opts): Promise<{exitCode, stdout, stderr,
    spawnedPid?}>`
- `src/session/init.ts:214-331` (the `node` registry handler):
  refactored to call `runNodeScript(facetMgr, …)` instead of
  `facetMgr.exec` directly. Keeps the same VFS read + esbuild transform
  pre-pass; only the dispatch leg changes.
- `src/facets/manager.ts:spawn` (line 1778): unchanged primitive.

### §2.4 Long-running detection rules

```typescript
function detectLongRunning(code: string, args: string[]): boolean {
  if (args.includes('--watch') || args.includes('--inspect')) return true;
  // Substring sniff (cheap; same shape as looksLikeEsm).
  const stripped = code
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bhttp\.createServer\b/.test(stripped) ||
    /\bhttps\.createServer\b/.test(stripped) ||
    /require\(\s*['"]http['"]/.test(stripped) ||
    /import\s+.*\sfrom\s+['"]https?['"]/.test(stripped) ||
    /\bBun\.serve\b/.test(stripped) ||
    /\bDeno\.serve\b/.test(stripped) ||
    /\bapp\.listen\b/.test(stripped) ||  // express-style
    /\bserver\.listen\b/.test(stripped) ||
    /^\s*await\b/m.test(stripped); // top-level await
}
```

False-positive class accepted: a script that *imports* http but
exits quickly (e.g. `require('http').STATUS_CODES`) gets forked.
Penalty: caller sees `[started (long-running)]` instead of inline
output. Acceptable; user can add `--no-long-running` (out of scope
this wave) or just write the result to stdout via a dedicated short
script.

False-negative class: scripts that listen via a non-detected pattern
(e.g. `koa`, third-party servers using a constructor not in the sniff
set). Penalty: shell blocks until the 5-min facet timeout. Logged
class for follow-up; accept as known limitation.

### §2.5 Risks accepted

| Risk | Mitigation |
|------|------------|
| Mis-detection of short scripts as long-running | False-positive class only delays output; user sees the start line and can `kill <pid>`. Acceptable shape change. |
| Spawned long-running facet can't be killed if it crashes the supervisor | `FacetManager.kill(pid)` already exists (line 1808). The shell registers a SIGTERM handler. Existing behaviour. |
| Detached process leak on session disconnect | `processTable.reap()` runs on each spawn; orphaned long-running facets get cleaned via the same ctx.facets eviction path used by vite. Existing behaviour. |

## §3 Anti-requirements

- ✅ NO `setTimeout` / sleep / retry on hot paths. Long-running fork
  uses `await pool.spawn(...)` returning `{pid, facetStub}`.
- ✅ NO fallback to in-supervisor execution on missing env.LOADER.
  NimbusFanoutPool throws BindingError at construction.
- ✅ NO predicted-GREEN. G3 probes assert distinct isolate IDs and
  supervisor-heap stability via diag; G6 re-runs the same probes
  against prod.
- ✅ Single-ownership: stdin/stdout buffers crossing the
  supervisor→loader RPC boundary get defensive copies at ingress
  (mirror of git-freeze Q-fix in network-facet.ts).
- ✅ No files outside the worktree until merge-ready.
- ✅ No push to main until prod-verify GREEN.

## §4 Acceptance gate

- All G3 probes GREEN (RED before G4 build, GREEN after).
- phase5-regression cohort 37+ probes GREEN at every commit.
- tsc baseline (2 errors) preserved.
- Mossaic + W1 + clone-large-repo + long-form-replay + X.5-U + F-2
  cohorts still GREEN.
- Prod e2e re-verifies: G3 probes against
  `https://nimbus.ashishkmr472.workers.dev` after deploy.
- Branch merged to main only after prod-verify GREEN.

## §5 Phase order

| Phase | Scope |
|-------|-------|
| G3 | TDD RED probes (4 probes) |
| G4 | Build (spawn-facet.ts + spawn-pool.ts + node-runner.ts + dispatch) |
| G5 | Cross-wave regression (37+ GREEN) |
| G6 | Deploy + prod e2e probe re-run |
| G7 | Retro |
| G8 | Merge to main |
