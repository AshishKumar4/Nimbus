# `pi --help` — the lost-exit hang

> Edited & maintained by Claude, presented as-is. Investigation notes, not a
> design doc. Written 2026-07-25 against `main` @ `86600af`, re-measured
> 2026-08-06 against `main` @ `efbf831`.

An open handoff. The defect is characterised and reproducible; it is **not
fixed**, and I did not ship a speculative fix because the locus sits in the
shell/bin exec path and staged-facet lifetime rather than in the node shim.

Failing probe: `tests/behavioral/agentic-cli/new/pi-coding-agent-npm-bin.mjs`,
at the `pi --help` step.

---

## 2026-08-06: the missing signal, measured

The 2026-07-25 notes below end at "a facet killed by the platform cannot call
`reportExit`, which fits, but I have no direct signal". There is now a direct
signal. `wrangler tail --format json` over a live reproduction on a throwaway
gives, in 1005 events:

```
Counter({'ok': 988, 'canceled': 11, 'responseStreamDisconnected': 3, 'exceededMemory': 3})

01:43:25  exceededMemory  /s/cheerful-spruce-6747/ws     ← terminal 1's socket
01:44:54  exceededMemory  alarm (scheduledTime 01:44:54) ← the moment `pi --help` was sent
01:46:54  exceededMemory  /s/cheerful-spruce-6747/ws     ← terminal 2's socket
```

**The session Durable Object is killed for memory, and it is the `/ws` request
itself that carries the `exceededMemory` outcome.** That single fact explains
every observation below at once:

- The connection goes silent with an open socket: the WebSocket survives, but
  the execution context driving it is gone.
- A fresh socket to the same sid works: it gets a new context on the restarted
  DO.
- Nothing reports a reason: `BIN_DISPATCH_TIMEOUT_MS` cannot fire, because the
  timer arming that bound died with the context it was armed in. **No bound
  that lives inside the DO can ever report this failure.** That is the design
  constraint any fix has to start from — the reporting has to come from the
  restarted DO or from the client, not from a timeout in the request that is
  being killed.

Two further measurements separate the two failures that were previously
conflated:

- **`pi --help` alone, as the first invocation after the install: it does not
  wedge — it is simply slower than a one-shot facet's life.** Measured 34.4s
  wall, killed at the 30s `FACET_TIMEOUT_MS` bound, and the shell reports it
  honestly: `exited with code 124` / `[process killed: timeout after 30s]`.
  So `pi --help` never renders its help surface within budget at all, before
  memory enters the picture.
- **A second `pi --help` in that same session returns in 5.0s with `[bin
  started: pid=…]`, no output, and exit 0.** A ghost: the invocation reports
  success without running. Separate defect again, and the one that turns a
  loud failure into a silent one.

`node/cwd-data-file-session-survival.mjs` — the "cheap form" named below — now
**passes** (4/4, 5.9s), so the 20 MiB-cwd prefetch-bundle path is no longer
the trigger. The memory ceiling is now reached by pi's own module map (17.4
MiB, the largest observed) being materialised a second time in one session.

### Confirmed not the entry drain, again

Re-A/B'd 2026-08-06 with the handle-based entry loop deployed (the fix for
`npm-bin-explicit-process-exit`, where an unsettled promise used to burn the
whole facet lifetime). `pi --help` hangs identically. The two defects share
nothing but a symptom.

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

## Answered 2026-08-06 (see the section at the top)

- Why the bin facet stops producing output and never reports exit — and why
  the *first* terminal cannot even echo. Both are the same thing: the `/ws`
  request's execution context is killed with `outcome: exceededMemory`. The
  socket stays open with nothing driving it. `wrangler tail` shows no
  exception because a memory kill is an outcome, not a throw, which is why
  the earlier pass reading only `exceptions` came up empty.

## Still not established

- **What the memory is.** `exceededMemory` names the budget, not the holder.
  Whether the residue from the first invocation is the module map itself, a
  retained facet/isolate (the per-owner dynamic-worker LRU cap is 50), a
  serialized bundle held alongside its source, or an exec-slot entry never
  released — that is the next measurement, and it is the same question the
  bundle-pressure / facet-serialization work is already asking.
- **Why `pi --help` needs more than 30s at all**, when `pi --version` on the
  same 17.4 MiB module map returns in 16-20s. Help rendering pulls in the
  provider/model catalogue; whether that is module-init cost or work done
  after init has not been separated.
- **Why the second `pi --help` returns exit 0 in 5s having produced nothing.**
  A warm path answering for a run that never happened is worse than the hang
  it replaces, because it reports success.

## A distinct finding: the shell waits forever with no diagnostic

Independent of whatever kills the facet, **the shell waiting on a bin facet
with no timeout and no error is a defect in its own right.** A wedged terminal
that reports nothing is the same silent-failure class as the truncation and
`execSync` bugs: the user is given no reason and no exit code, and the only
recovery is opening a new connection — which nothing tells them to do.

Note that the one-shot `node` path already has the honest version of this:
`FACET_TIMEOUT_MS` bounds it and the session reports exit 124 with
`[process killed: timeout after 30s]`. `pi --help` on a cold session takes
exactly that path and reports exactly that, measured 2026-08-06.

What the 2026-08-06 tail adds is *why* the bound stops working once the DO is
the thing being killed: `BIN_DISPATCH_TIMEOUT_MS` is a timer inside the same
execution context, so the kill takes the reporter along with the reported. A
diagnostic for this cannot be another in-DO timeout. The two places it can
come from are the **restarted DO** — a process-table row with no exit is a
run that was killed, and the next connection can say so — and the **client**,
which is the only party that can observe "socket open, nothing arriving".

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
