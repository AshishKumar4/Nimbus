# C5 cold checkout report

Date: 2026-07-15
Base: `a2f6f5f00d20592c3979ee7d13cff582efabc30b`
Scope: checkout continuation only. Prepare and fetch behavior were not changed. No live deployment was run.

## Confirmed cold-path defect and fix

A physical-cold `clone-checkout` invocation reconstructed its authoritative metadata overlay only from the prepare manifest. The continuation cursor and durable marker v2 contained tree position but no worktree directories created by committed prior chunks. The local synthetic adapter masked this gap by synthesizing parents in `writeFile`, while its supervisor had zero latency.

The continuation cursor is now the single source of truth for committed checkout position and directory knowledge:

- `nextCursor.directories` carries relative directories created by all committed chunks so far. Directory and gitlink entries are added deterministically as the tree walk advances.
- Marker v2 already stores `nextCursor` only after the worktree and cumulative index W7 flush succeeds. The directory set therefore advances under the same whole-chunk durability rule, without parallel state or an extra write.
- Every checkout invocation validates the directory count, path shape, uniqueness, and UTF-8 byte total before constructing the overlay. The hard bounds are 20,000 directories and 4 MiB of path bytes. A count or byte overflow is surfaced as `FreshCheckoutDirectoryLimitError` and propagated through `GitNetworkResult.errorCode`.
- Cold checkout seeds only directory metadata from the cursor, not all prior file paths. Files written by the current chunk continue to be answered from the current write buffer and metadata overlay.
- The strict cf-git checkout filesystem now checks each entry's parent before mutation. In cold tests those checks are served locally from prepare metadata, current-chunk writes, or cursor directories; no worktree `stat`/`lstat` reaches the supervisor.

V1 ownership markers remain accepted for abort. Marker-v2 cursor advancement, ownership-gated abort, final marker deletion, W7 ordering, old-cursor replay, and budget errors are unchanged.

## Bounded live instrumentation

Each checkout chunk still emits exactly one completion line. It now ends with:

```text
wall=<ms> w7=<waves> rpc=<facet-supervisor-total> cold=<yes|no>)
```

`cold=yes` means the invocation began without `cloneJobs` module state. The RPC total includes the facet's `stat`, `lstat`, `readdir`, file/range reads, W7 writes, symlink calls, legacy-symlink proof, and bounded progress `stdout` calls. The outer completion-line write itself is not part of the completed facet invocation and is therefore not included.

This distinguishes the remaining live hypotheses directly: a high RPC count identifies an RPC-shape regression; a low count with high wall and high W7 time points at supervisor persistence; a low count with high wall and `cold=yes` points at pack/index reload or local parsing/decoding.

## 30 ms latency model

The retained performance harness runs the real generated facet plus the real patched cf-git packed checkout. Every ordinary supervisor method and W7 call waits 30 ms. Normal continuation chunks are loaded from physically distinct worker modules, so module-local job/cache state is absent on every invocation.

Measured full-suite run:

| Slice | Entries | Wall | RPC | W7 | `stat` | `lstat` | Cold |
|---|---:|---:|---:|---:|---:|---:|---|
| chunk 1 | 10,000 | 4,074 ms | 99 | 87 | 1 | 1 | yes |
| chunk 2 | 10,000 | 4,224 ms | 100 | 87 | 1 | 1 | yes |
| chunk 3 | 10,000 | 4,416 ms | 101 | 88 | 1 | 1 | yes |
| final | 17 | 531 ms | 14 | 2 | 1 | 1 | yes |
| old-cursor replay | 10,000 | 3,969 ms | bounded | 87 | 0 | 0 | no |
| separate cold resume | 10,000 | 4,216 ms | bounded | 87 | 1 | 1 | yes |

Every non-final cold chunk reaches the 10,000-entry bound. Each cold chunk has only one fixed `stat` and one fixed `lstat`, both under `.git`; the harness asserts that no worktree metadata lookup crosses the supervisor boundary. Old-cursor replay selects the same slice and the completed tree/index remain byte-equivalent to one-shot and native checkout fixtures.

The measured cost shape is:

- Fixed cold supervisor work: 12-13 non-W7 calls, or 360-390 ms at 30 ms RTT.
- Fixed local/finalization work: approximately 110-150 ms in this fixture.
- W7 variable work: 87-88 calls per 10,000 entries, or 2.61-2.64 seconds at 30 ms RTT.
- Remaining local checkout/index work: 1.0-1.4 seconds per 10,000 entries, approximately 0.10-0.14 ms per entry.
- Combined model: about 0.5 seconds fixed plus 0.36-0.39 ms per entry.

The fixture pack fits in one supervisor read. A 37 MiB TypeScript pack uses about ten 4 MiB range reads, adding roughly nine calls or 270 ms per physically cold chunk at the modeled RTT. No offset-based object reader was added: after removal of entry-scaled metadata RPCs, nine large chunks amortize the bounded pack reload, and changing pack access would be a separate high-risk cache/object-reader change.

## TypeScript prediction for the live gate

For 84,188 worktree/tree entries, the entry bound should produce nine chunks: eight near 10,000 entries and one near 4,188, unless the 32 MiB decoded-byte bound legitimately fires first.

Under the 30 ms model plus the additional large-pack range reads, expected checkout wall is approximately 38-41 seconds total: about 4.3-4.7 seconds for each full chunk and about 2.1-2.4 seconds for the final chunk. At a 50 ms supervisor RTT, the same bounded RPC shape predicts roughly 55-60 seconds total. These are live-verifiable RPC/RTT predictions, not claims about production SQLite W7 service time.

The coarse wall guard is now 150 seconds. Entry and decoded-byte limits remain the primary CPU/memory safety bounds; the wall guard protects pathological service-time stalls without cutting normal cold chunks down to a few hundred entries.

Expected live completion lines:

- `cold=yes` on physically cold chunk invocations.
- Approximately 100 total facet-supervisor RPCs on a full 10,000-entry chunk, dominated by about 87-88 W7 calls plus bounded metadata/pack/index/progress calls.
- `stat+lstat` remaining constant across chunk sizes, with no worktree path in either category.
- Eight 10,000-entry chunks plus one final partial chunk for TypeScript unless decoded bytes bind earlier.

## Verification

Passed:

```text
all tests/unit/*.mjs (44.3 s, exit 0)
bun tests/unit/cf-git-fresh-checkout-chunks.mjs
bun tests/unit/git-network-facet-checkout-performance.mjs
bun tests/unit/git-network-facet-clone-protocol.mjs
bun tests/unit/git-network-facet-closed-world.mjs
tracked cf-git patch applies to the pristine Bun cache and produces a byte-identical installed index.js
node packages/worker/scripts/patch-install-deps.mjs
bun run bundle
bun run --cwd packages/worker build
bun run --cwd packages/worker typecheck
bun run typecheck
git diff --check
```

The full unit sweep's two OpenTUI source-parity probes remained explicit skips because their optional source checkout is absent; all runnable unit tests passed.

## Residual risks

- Production W7 persistence can cost more than the modeled 30-50 ms RPC transport. The new `rpc`, `w7`, and `cold` fields make that separable in Claude's live gate.
- Every physical-cold chunk still reloads the pack/index and parses the cumulative Git index once. Those are bounded fixed costs, not per-entry supervisor calls.
- Marker v2 now grows with directory count and is capped. TypeScript is expected to remain below both directory bounds; the live line timing will show whether repeated ownership-marker publication materially affects W7 service time.
- The supervisor loop still does not recover its local cursor from marker v2 after a supervisor DO reset. This change preserves and extends the durable cursor format but does not broaden reset reconciliation scope.
