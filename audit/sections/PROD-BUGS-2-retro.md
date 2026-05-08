# PROD-BUGS-2 retro

**Branch**: `prod-bugs-2`
**Base**: `main` @ `4c6aacc` (deploy-flag-fix merge)
**Head**: `ae29d9c`
**Date**: 2026-05-08

## Brief

Three production bugs reported on a session running `wrangler dev` +
`npm install` against a fresh project:

1. **Bug 1** — npm warn / progress lines stream **after** the next
   shell prompt redraws, visually corrupting the prompt:
   ```
   user@nimbus:~/app$ [npm] Pre-bundle complete: 5/5 succeeded. ...
   ```
2. **Bug 2** — `wrangler dev` fails with
   `Entry point not found: home/user/app/Nimbus/src/index.ts`. User's
   diagnosis: "VFS expects leading slash" (incorrect — see below).
3. **Bug 3** (heap-line audit) — `[npm]` banners always print
   `supervisor heap 0.0 MiB`, regardless of actual heap. Misleading.

Hard constraints:

- NO setTimeout/sleep/retry-with-delay anywhere.
- NO defensive `if !path.startsWith('/') prepend`. Find strip site.
- NO comment-out / "to ship" patches.
- NO new src/ behavior beyond the 3 bugs.

## Bug 2 — wrangler entry-point path-join

### Strip-site recon

Three normalization sites for `vfsRoot`:

- `src/session/init.ts:754, :759, :1129` — strip leading `/`.
- `src/wrangler/nimbus-wrangler.ts:224` —
  `this.root = opts.root.replace(/^\/+/, '').replace(/\/+$/, '')`.

VFS canonical key shape (verified at `src/vfs/sqlite-vfs.ts:848`):
`path.split('/').filter(Boolean)` — i.e. **no leading slash**, no
internal `//`, no `.` segments. `SqliteVFS.exists(path)` at
`sqlite-vfs.ts:830` does **literal** `inodes.has(path)` lookup with
no normalization on the read path.

User's "VFS expects leading slash" diagnosis is wrong; the canonical
shape is no-leading-slash. But the right code location was flagged.

### Root cause

`src/wrangler/nimbus-wrangler.ts:349` (pre-fix):
```ts
const entryPoint = this.root + '/' + this.config.main;
if (!this.vfs.exists(entryPoint)) { ... 'Entry point not found' ... }
```

Naive string concat. The result is **not** routed through the
canonical normalizer (`normalizeVfsPath` at `src/vfs/path.ts:27`).
Any `main:` value with a leading `./`, leading `/`, or internal `//`
produces a malformed VFS key, and `inodes.has` returns false even
when the file is present.

Reproduction matrix locked in P1 RED probe
(`audit/probes/prod-bugs-2/wrangler-dev-entry-point/`):

| `main:`              | resulting key (pre-fix)              | result   |
|----------------------|--------------------------------------|----------|
| `"src/index.ts"`     | `home/user/app/X/src/index.ts`       | OK       |
| `"./src/index.ts"`   | `home/user/app/X/./src/index.ts`     | FAIL     |
| `"/src/index.ts"`    | `home/user/app/X//src/index.ts`      | FAIL     |
| `"src//index.ts"`    | `home/user/app/X/src//index.ts`      | FAIL     |

The user-reported `home/user/app/Nimbus/src/index.ts` is the control
case (works on `main`). Their bug must come from a `main:` shape with
one of the malformed prefixes — likely an `npm init` template or a
copy-pasted absolute path.

### Fix (P2 — `8135a23`)

Added `private resolveEntryPath()` on `NimbusWrangler` that joins
root + main and routes through `normalizeVfsPath`. Both join sites
(`buildAndLoad` line 349, rebuild-on-VFS-change esbuild call line 938)
now go through the helper. The strip site IS the canonicalization
site — single source of truth, no defensive prepend on the read path.

Probe: `4/4 PASS` post-fix (`1/4` pre-fix). tsc baseline: 2 errors,
unchanged.

## Bug 1 — log queue drain ordering vs prompt return

### Empirical reconnaissance

A trivial `npm install is-odd@3.0.1` did **not** reproduce the bug —
the `[npm]` lines all arrived before the prompt. The trigger was
**pre-bundle**: a project that imports `react` queues 5+ pre-bundle
slots, and the post-bundle summary line lands after the prompt.

P3 RED probe captures the matrix at byte level
(`audit/probes/prod-bugs-2/log-queue-drain/`):
- last `[npm]` byte position vs. last prompt-suffix byte position
- pre-fix:  `[npm]` at idx 961, prompt at idx 942
- bytes after prompt: `"user@nimbus:~/app$ [npm] Pre-bundle complete:
  5/5 succeeded. (supervisor heap 0.0 MiB, Δ+0.0 MiB)\r\n"`

### Root cause

`src/npm/installer.ts:376` (pre-fix):
```ts
const prebundlePromise = this.prebundleUsedModules(projDir, resolved)
  .catch((e: any) => log(`[npm] pre-bundle skipped: ${...}`));
void prebundlePromise;
```

Fire-and-forget. `prebundleUsedModules` emits its summary banner via
`safeProgress` (`installer.ts:1548-1552` pre-fix) **inside its own
`finally` block**, which runs after the `await Promise.all(...)` of
the pre-bundle pool slots resolves. By the time that finally runs:
- `install()` has long since returned (line 396).
- The npm registry handler at `src/session/init.ts:1735` has written
  the final `added N packages` line and returned.
- The shell has redrawn its prompt.

The orphan-promise's `safeProgress` then fires through the
`onProgress` closure captured at install-construction time
(`(msg) => ctx.stdout.write('[npm] ' + msg + '\n')` from
`src/session/init.ts:1228`). This writes through the same WS channel
as the shell's prompt — but **after** it.

### Why fire-and-forget is intentional

The long comment block at `installer.ts:351-371` explains: a
`try/catch` on `await prebundleUsedModules()` cannot recover from a
workerd-level isolate kill (wasm-compile-disallowed errors, OOM, eval
blocks). The await simply unwinds **after** the WS has been torn
down, and the `catch` runs too late. The fix here cannot be "just
await it".

### Fix (P4 — `ddfe099`)

Gate **where** late-progress writes go, not whether they happen.

The dispatch site:
1. Captures `installInvocationActive = { v: true }` flag.
2. Wraps `this.onProgress` with a forwarder that routes to the
   persistent `ctx.stdout` closure while `installInvocationActive.v`
   is true, and to `console.log('[npm:late] ' + msg)` once it's
   false.
3. Schedules `queueMicrotask(() => { installInvocationActive.v = false })`.
4. Restores the persistent reference in the prebundle promise's
   `finally` so subsequent `npm install` calls reusing the cached
   `this.npmInstaller` (see `src/session/nimbus-session.ts:892`)
   wire their own `ctx.stdout`.

Microtask ordering proof:
- `prebundleUsedModules()` runs synchronously up to its first
  `await fetchEsbuildWasmBytes` at `installer.ts:1358` post-fix.
  All early sync emissions (`Pre-bundling N modules...`) land
  while the gate is still open.
- `queueMicrotask` is enqueued **after** that sync prefix returns,
  but before `_installInner` finishes its own sync tail.
- `_installInner` is awaited from `install()`. The microtask drains
  before the npm registry handler's `await` resumes.
- Pre-bundle's first `await` continuation queues only when
  `fetchEsbuildWasmBytes` actually resolves (real I/O) — far later
  than our microtask flip.

So: live install progress goes to the user's terminal as before;
post-return progress goes to wrangler dev console (`console.log`) so
the trace isn't lost but the user's shell prompt isn't corrupted.

NO setTimeout. The ordering is enforced by V8's microtask queue.

Probe: GREEN post-fix.
- pre:  last `[npm]` idx=961 > last prompt idx=942
- post: last `[npm]` idx=830 < last prompt idx=913

## Bug 3 — supervisor heap line read 0.0 MiB

### Root cause

`src/npm/installer.ts:1803` (pre-fix) defined `readSupervisorHeap()`
which called `process.memoryUsage()`. workerd returns 0 for **every
field** of `process.memoryUsage()` inside a Durable Object class
context — only dynamic-worker isolates under `nodejs_compat` get the
real implementation. This is documented at
`src/observability/diag-counters.ts:4` and at
`src/observability/heap-estimate.ts:6`, and IS the reason the C'.1
deterministic estimator exists.

The two banner sites (`installer.ts:1252, :1626`) printed
"supervisor heap 0.0 MiB" every time. False signal.

### Fix (P5 — `ae29d9c`)

Replace both `readSupervisorHeap()` calls with a new private method
`NpmInstaller._estimateSupervisorHeapMiB()` that calls
`estimateSupervisorHeap()` from `src/observability/heap-estimate.ts` —
the same estimator `src/session/routes.ts:247` uses for the
`/api/_diag/memory` endpoint. Removed the now-dead module-level
`readSupervisorHeap` helper (replaced with a comment block at the
same location pointing at the estimator).

Verification:
- pre:  `(supervisor heap 0.0 MiB, Δ+0.0 MiB)`
- post:
  - banner: `(supervisor heap 9.0 MiB)` (entering pre-bundle)
  - late banner: `(supervisor heap 13.7 MiB, Δ+4.6 MiB)` (after)
  - `/api/_diag/memory.heap.estimatedBytes` = 9437184 = 9.0 MiB
    (matches banner — same estimator).

## Cross-wave verification (P6)

`audit/probes/phase5-regression/run-all.mjs` against this branch:
- 20 PASS
- 1 FAIL (`D'.1 cirrus-real-do-facet`)
- 8 SKIP (W7 slow probes — QUICK mode)

The lone FAIL was confirmed pre-existing on `main` baseline
(`4c6aacc`) by checking out `4c6aacc` src and re-running the probe —
identical output. Not caused by this work.

tsc baseline: 2 errors (unchanged from `main`):
- `src/runtime/esbuild-service.ts:153` — esbuild-wasm.wasm import.
- `src/session/init.ts:163` — SqliteVFSProvider type mismatch.

## What I changed under src/

| File | Lines (post-fix) | Phase |
|------|------------------|-------|
| `src/wrangler/nimbus-wrangler.ts` | +24, -1 | P2 |
| `src/npm/installer.ts` | +103, -34 | P4 + P5 |

Two files. Three bugs. No new behavior beyond what the bugs
themselves required.

## What I deliberately did NOT change

1. **No defensive `if !path.startsWith('/')` prepends.** The strip
   site IS where canonicalization happens. `normalizeVfsPath` is the
   single source of truth.
2. **No `await prebundleUsedModules()` inside `install()`.** The
   long-standing comment block at `installer.ts:351-371` documents
   exactly why that's wrong (workerd isolate-kill paths defeat
   try/catch). I gated the **write target** instead, preserving the
   fire-and-forget invariant.
3. **No new heap-tracking infrastructure.** The C'.1 deterministic
   estimator already exists; the two install banners just weren't
   using it. One-line wire-up per call site.
4. **No retries / sleeps / setTimeouts anywhere.** Microtask
   ordering enforces the late-progress gate. SQL/VFS lookups are
   strictly synchronous through the canonical normalizer.

## Probes

- `audit/probes/prod-bugs-2/wrangler-dev-entry-point/wrangler-entry-resolves.mjs`
  — Bug 2 RED probe, 4-shape matrix.
- `audit/probes/prod-bugs-2/log-queue-drain/log-queue-drains-before-prompt.mjs`
  — Bug 1 RED probe, byte-level prompt-vs-`[npm]` invariant.
- `audit/probes/prod-bugs-2/log-queue-drain/quick-capture.mjs`
  — diagnostic frame-timing capture (kept for future late-write
  investigations).

## Commits

| SHA | Phase | Description |
|-----|-------|-------------|
| `b24d5f2` | P0 | progress.md tracker |
| `21bd9d4` | P1 | Bug 2 RED probe |
| `8135a23` | P2 | Bug 2 fix — `normalizeVfsPath` at join site |
| `b1390fe` | P3 | Bug 1 RED probe |
| `ddfe099` | P4 | Bug 1 fix — gate late progress to `console.log` |
| `ae29d9c` | P5 | Bug 3 fix — deterministic heap estimator |
