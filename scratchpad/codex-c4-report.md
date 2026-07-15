# Commit 4 report: split clone prepare and checkout invocations

Date: 2026-07-15

Branch: `fix/session-reset-hardening`

Starting HEAD: `15a3063` (`7c1f8d7` Commit 1 plus the live-verified indexer optimization)

## Protocol design

`execGitNetwork` still creates exactly one `LOADER.load(...)` worker and one
entrypoint. Clone now uses three internal request types on that entrypoint:

1. `clone-prepare` calls `git.clone({ noCheckout: true, cache, ... })`. It
   preserves the existing shallow depth/auth/ref behavior, resolves HEAD and
   the commit's tree, flushes the final W7 wave, and only then returns a
   prepared result.
2. `clone-checkout` validates the prepared job/options identity, reconstructs
   the closed-world metadata overlay, resolves durable HEAD again, reads its
   commit/tree, compares commit/tree/branch identity to the prepared result,
   and only then calls `git.checkout({ ref: "HEAD", noUpdateHead: true, ... })`.
   Its final W7 flush includes the worktree and index before success returns.
3. `clone-abort` clears the job cache, recursively deletes only `<dir>/.git`
   through the existing buffered-FS/W7 delete contract, and flushes the delete.
   It is idempotent. Already committed worktree paths are deliberately left
   inspectable.

The prepared result is bounded metadata, not repository bytes. It contains the
job/options identity, normalized destination, exact commit/tree/HEAD identity,
persisted `.pack`/`.idx` paths and byte sizes, pack SHA, a pack-only object-store
proof, and the metadata-only overlay manifest needed by a later invocation.
Protocol values and paths are validated before the checkout adapter trusts
them. No clone-complete result is possible until checkout's final flush
succeeds.

An empty remote preserves cf-git's existing successful metadata-only clone
semantics. Prepare records the durable unborn symbolic HEAD with `commit/tree`
set to `null`; checkout revalidates that the branch is still unborn and does
not invoke worktree materialization.

The outer timeout remains the complete-operation deadline. Prepare and
checkout each have a typed, shorter 240-second deadline capped by the remaining
outer time; abort gets one best-effort 30-second attempt within the remaining
outer deadline. There is no retry. The primary phase error is preserved in
`error`/`errorPhase`; abort failure is reported separately as `cleanupError`.
The caller's exclusive mutation lease remains held because `execGitNetwork`
does not return or dispose any stub until checkout succeeds or the abort
attempt finishes.

## Warm cache and correct cold fallback

The generated worker owns a module-scoped map keyed by an unguessable clone
job ID. Prepare creates one cf-git cache object and passes it to `git.clone`;
checkout reuses that exact object when the loaded worker retained it. This lets
Commit 1's seeded `PackfileCache` retain the fetched `GitPackIndex` and pack
without a second pack copy or supervisor reload.

Cache retention is not part of correctness. Every checkout request also carries
the prepared metadata manifest. If module/job state is absent, checkout creates
a fresh cf-git cache, reconstructs `.git` visibility from that manifest, and
lets cf-git's normal packed-object lookup read the persisted index and pack.
The existing fd08d8a adapter path handles a pack above the ordinary RPC envelope
with contiguous 4 MiB `fsReadRange` calls. Durable HEAD/commit/tree validation
occurs before any worktree materialization on both warm and cold paths.

The forced cache-loss unit test imports the same generated worker source as a
fresh module (so its job map is empty), inflates the prepared pack metadata
above the 28 MiB whole-value RPC ceiling, and proves that checkout performs only
bounded range reads and produces the same checked-out content as the warm path.

## Separate-invocation accounting and diagnostics

Each child request has a distinct URL and UUID:

- `/git/clone-prepare/<invocationId>`
- `/git/clone-checkout/<invocationId>`
- `/git/clone-abort/<invocationId>`

This makes the staging assumption measurable: Claude can join each dynamic
Worker trace/invocation CPU record to the exact phase and prove that prepare
and checkout received separate accounting. JavaScript elapsed time is labeled
wall time, never CPU time.

Each facet response contains exactly one compact structured phase diagnostic:

- phase and invocation ID;
- start/end timestamps and monotonic wall elapsed;
- success/error outcome and last bounded progress position;
- W7 wave count;
- the complete per-phase supervisor RPC counter set (`stat`, `lstat`,
  `readdir`, `readFile`, `fsReadRange`, `writeBatchStream`, symlink calls, and
  `stdout`).

`GitNetworkResult.phases` retains those records. The supervisor also writes one
bounded completion/error line per finished phase containing invocation ID,
wall milliseconds, W7 waves, and aggregate RPC count. Internal progress keeps
phase transitions/completions; prepare and ordinary network operations may
emit at most one timed update every two seconds, while checkout has no timed
per-file updates.

## Regression coverage and verification

Red-to-green coverage:

- `git-network-facet-clone-protocol.mjs` initially observed the old single
  `/git/op` request and failed. It now proves one loader, one entrypoint, two
  distinct sequential fetch invocations, durable prepare before checkout,
  shared job/options identity, result/counter aggregation, checkout-failure
  abort, preserved primary error, no false success, and preserved committed
  prefix.
- `git-network-facet-closed-world.mjs` was converted from the removed
  monolithic clone request to the real prepare/checkout protocol. It proves
  durable `.git` publication before checkout starts, warm cache reuse, cold
  cache loss with 4 MiB range reconstruction and identical output, and actual
  idempotent abort deletion of `.git` without deleting the worktree prefix.
- Existing large-read, closed-world, W7, cf-git repair/indexer, clone lease,
  shallow argument, and existing-repository operation tests remain green.
  Empty-remote coverage also proves the split does not turn an unborn HEAD
  into a clone failure or invent a worktree.

Commands run successfully:

- `bun run --cwd packages/worker bundle:git`
- `./node_modules/.bin/tsc --noEmit`
- `bun run --cwd packages/worker typecheck`
- `bun run --cwd packages/worker build`
- every `tests/unit/*.mjs` file, sequentially: green; the two existing
  OpenTUI source-dependent tests reported their established SKIP condition
  because that optional external source tree is absent.
- `git diff --check`

No network, deployment, Cloudflare probe, or CPU measurement was attempted.

## Residual risks and live gates

The split still relies on a staging-only platform assumption: two sequential
`entrypoint.fetch` calls on one loaded dynamic worker must produce distinct
invocation records with independent CPU/subrequest budgets. The UUID request
paths and phase records make that directly testable, but only Claude's
Cloudflare trace can prove it.

The supplied post-`15a3063` evidence shows the exact TypeScript run getting
past fetch, all 81,369 analyze entries, and into worktree updates, so fetch now
fits at least that observed 30-second invocation. This implementation did not
and cannot measure its CPU margin locally. Claude should still record repeated
`clone-prepare` CPU values and require safe headroom. If `_fetch`/`fromPack`
alone ever reaches the 30-second ceiling, Commit 5's checkout cursor cannot
help: the fetch/index-pack monolith would need another fetch-side boundary,
further indexer work, or a higher-CPU execution topology.

The supplied evidence also suggests 81k-path checkout may exceed its fresh
30-second budget. This commit intentionally does not add continuation. Claude's
fresh-budget `clone-checkout` measurement is the Commit 5 decision gate.

Other live gates remain the plan's existing ones: DOOM/React/TypeScript clone
completion, manifest/mode/symlink/gitlink equality, no reset, bounded memory,
phase CPU/wall/RPC/W7 records, and abort behavior after a real dynamic-worker
resource kill.
