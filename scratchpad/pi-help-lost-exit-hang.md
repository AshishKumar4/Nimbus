# `pi --help` — the lost-exit hang

> Edited & maintained by Claude, presented as-is. Investigation notes, not a
> design doc. Written 2026-07-25 against `main` @ `86600af`.

An open handoff. The defect is characterised and reproducible; it is **not
fixed**, and I did not ship a speculative fix because the locus sits in the
shell/bin exec path and staged-facet lifetime rather than in the node shim.

Failing probe: `tests/behavioral/agentic-cli/new/pi-coding-agent-npm-bin.mjs`,
at the `pi --help` step.

---

## Read this first: it does not reproduce under `wrangler dev`

Under a local `wrangler dev`, `pi --help` **succeeds** (measured 2.4s). It only
fails on a real deployed Worker. If you try to reproduce it locally you will
conclude the probe is flaky and lose hours.

Reproduce on a throwaway Worker instead (account-pin
`CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1`, delete it after).
Never gate on a versioned preview URL on the custom domain — `*.nimbus-os.dev/*`
routes those to live production.

## It is not the entry-drain truncation bug

Ruled out by A/B on the same deployed Worker: `pi --help` hangs **identically**
before and after the `fix/node-shim-bugs` drain fix (`main` @ `86600af`). Same
step, same 60s timeout, same empty buffer. It is a separate defect.

---

## Reproduction

One session, in this order — **the ordering is the discriminator**:

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # ~60-95s
pi --version                                                      # 16-24s, OK
pi --help                                                         # HANGS
```

- `pi --help` **alone** after the install succeeds, in ~22s. Measured twice.
- `pi --help` **after `pi --version`** hangs. Measured 4/4, pre-fix and post-fix.

So the first `pi` invocation is what arms the failure. Both are the same binary
down the same npm-bin path; `--version` is simply the cheaper one.

## What was observed at the hang

1. **The terminal buffer is completely empty** — `tail: ""`. Not even the
   echo of the command comes back. The shell never rendered `pi --help`.
2. **The WebSocket is still open** (`ws closed flag: false`). It is not closed,
   not errored — it just never delivers another byte.
3. **The session is healthy.** A *fresh* WebSocket to the same sid gets a
   prompt immediately and runs `echo STILL_ALIVE` fine. So the Durable Object
   is alive; it is that one connection's command loop that is wedged.
4. **`ps` on the fresh terminal shows only `sh`.** The wedged terminal's
   `pi --help` never entered the process table — the command never started.
5. **On the fresh terminal, `pi --help` *does* start and then hangs too**: it
   echoes, prints `[bin started: pid=3000002 cmd="pi --help"]`, and then
   produces no output and never reports exit for 45s+.

Put together: `pi --help` starts a bin facet that never produces output and
never reports exit, and the shell waits on it forever.

## The shared trigger — the most useful lead

The identical shape reproduces with **no `pi` involved at all**:

```
node -e 'const fs=require("fs"); const fd=fs.openSync("/home/user/a.bin","w");
         const c=Buffer.alloc(65536,65);
         for(let i=0;i<384;i++) fs.writeSync(fd,c);   // 24 MiB
         fs.closeSync(fd); console.log("done");'
```

in a session that already holds a 20 MiB file: the terminal goes silent
permanently, empty buffer, socket open — the same signature. At 20 MiB the same
loop completes and reads back byte-exact.

That points at a **resource ceiling** (memory / accumulated session state)
rather than anything specific to pi, and it gives a far cheaper reproduction
than a 90-second npm install. Start here.

Consistent with this: the failure is size- and history-sensitive, not
deterministic on the command. `pi --help` is simply an expensive invocation
(it renders a large help surface including the provider/model catalogue) run
*second*, after `pi --version` has already left the session warm.

## What has been eliminated

- **Not the entry-drain / pending-work bug.** Identical pre- and post-fix.
- **Not the Durable Object dying.** A fresh socket to the same session works.
- **Not the WebSocket closing.** It stays open and silent.
- **Not `--help` argument handling.** `pi --help` alone succeeds; the same
  command hangs only when it is the second invocation.
- **Not local-only or config-related.** Clean on `wrangler dev`, fails on a
  real Worker.

## Not yet established

- Why the bin facet stops producing output and never reports exit. A facet
  killed by the platform (memory, CPU) cannot call `reportExit`, which fits,
  but I have no direct signal — `wrangler tail` captured `canceled` outcomes
  and **no exceptions**, and `observability/oom-classify.ts` folds CPU
  exhaustion into the `'oom'` bucket, so the ring buffer would not distinguish
  them either.
- Whether the first-invocation residue is memory, a retained facet/isolate
  (the per-owner dynamic-worker LRU cap is 50), or a process-table/exec-slot
  entry that is never released.
- Why the *first* terminal cannot even echo, when the process table shows the
  command never started. The block is upstream of command execution, in that
  connection's input/exec serialisation.

## A distinct finding: the shell waits forever with no diagnostic

Independent of whatever kills the facet, **the shell waiting on a bin facet
with no timeout and no error is a defect in its own right.** A wedged terminal
that reports nothing is the same silent-failure class as the truncation and
`execSync` bugs: the user is given no reason and no exit code, and the only
recovery is opening a new connection — which nothing tells them to do.

Note that the one-shot `node` path already has the honest version of this:
`FACET_TIMEOUT_MS` bounds it and the session reports exit 124 with
`[process killed: timeout after 30s]`. The npm-bin/staged path evidently
reaches a state where neither that bound nor the facet's own exit reporting
fires. Worth fixing on its own merits even before the underlying cause is
found, because it converts a permanent silent wedge into a bounded, explained
failure.

## Where to look

- `packages/worker/src/shell/npm-bin-entrypoints.ts` — the npm-bin dispatch
  (`runRuntime` with `__nimbusBinSpawn.skipSpawn`), and the `finally` that
  marks exit.
- `packages/worker/src/facets/manager.ts` — `_execWithTimeout` /
  `FACET_TIMEOUT_MS`, and whether the bin path is actually covered by it.
- `packages/worker/src/session/rpc.ts` — `_reportExternalExit`, the path that
  should fire when a facet dies outside its own try/finally.
- `packages/worker/src/loaders/process-fabric.ts` — facet lifetime is pinned to
  the holding request context; a cancelled inbound call kills the facet without
  it reporting anything.

## Harness used

`tests/behavioral/_driver.mjs` (`mintSession` / `Terminal` / `deleteSession`),
driven against a throwaway Worker deployed from `apps/probe` with a
`name`-overridden wrangler config and a `JWT_SECRET` secret. Probe tokens come
from `tests/behavioral/_mint-probe-token.mjs`.

The decisive step was, on hang: open a **second** `Terminal` on the same sid
and run `echo` / `ps` / the same command there. That is what separated "the
session is dead" from "this connection is wedged" from "the command itself
hangs" — all three were live hypotheses and each needed a different fix.
