# C5 checkout performance and durability report

Date: 2026-07-15
Base: \`efe7cfd910db173bfcd0c955915e470fb9611fe7\`
Scope: checkout only; fetch/prepare behavior was not changed. No network or live deployment was run.

## Root cause and fix

\`checkoutFreshChunk\` reused a job-scoped cf-git cache, but \`GitIndexManager.acquire\` still ran its generic index staleness check at every facet invocation. The checkout facet's closed-world metadata is the prepare-time snapshot, so that check could invalidate the warm parsed index as the durable \`.git/index\` changed. Every continuation then reread and reparsed the cumulative index before doing new checkout work. The cost grew with the total index, causing the wall bound to fire before the 10,000-entry bound.

The cf-git checkout now passes an explicit \`trustIndexCache\` option while Nimbus holds the exclusive fresh-checkout lease. This skips only the staleness check when a parsed index is already in the job cache. \`GitIndexManager.acquire\` still serializes the current index after every chunk, and the facet still durably flushes it before acknowledging the chunk. Other cf-git callers retain the normal stat-based invalidation behavior.

The facet also stores a cold-reconstructed job in \`cloneJobs\` after its first checkout invocation. A narrowly scoped closed-world fallback permits only \`<clone>/.git/index\` to be read from the supervisor during checkout. This is required because a no-checkout prepare can legitimately have no index in its initial metadata snapshot, while a later worker incarnation must recover the index written by a prior chunk. A cold invocation parses the durable index once; subsequent same-isolate chunks use the parsed instance.

The pack cache is warm as intended. The counting harness observed no warm \`.idx\` or \`.pack\` reload after the first invocation. A physically separate worker module read the cumulative index, pack index, and pack exactly once each.

## Measurements

The production failure supplied for build 30761033 was:

| Source | Entries | Reported wall | Cost per entry | Cumulative index |
|---|---:|---:|---:|---:|
| TypeScript chunk 10 | 461 | 25.623s | 55.6ms | 8,809 |
| TypeScript chunk 11 | 346 | 26.673s | 77.1ms | 9,155 |

The new offline regression drives the real bundled facet and real cf-git packed-object checkout over a 30,017-entry tree (one 15,000-entry directory plus 15 nested 1,000-entry directories), with a counting in-memory supervisor that decodes and persists real W7 streams.

| Run | Chunk entries | Wall | Cost per entry | W7 waves | Supervisor reads |
|---|---:|---:|---:|---:|---:|
| Fixed warm 1 | 10,000 | 1.196s | 0.120ms | 87 | 8 |
| Fixed warm 2 | 10,000 | 1.284s | 0.128ms | 87 | 6 |
| Fixed warm 3 | 10,000 | 1.448s | 0.145ms | 88 | 6 |
| Fixed final | 17 | 0.168s | 9.88ms | 2 | 6 |
| Old-cursor replay | 10,000 | 1.202s | 0.120ms | 87 | 6 |
| Physical cold worker | 10,000 | 1.284s | 0.128ms | 87 | 9 |

All non-final normal chunks hit the 10,000-entry bound. Across the run, warm continuations performed zero cumulative-index reads; the physical cold worker performed exactly one. Warm \`.idx\` and \`.pack\` reads also stayed at zero after the initial load. Supervisor calls are bounded by metadata/object reads plus W7 waves, not one RPC per entry.

For diagnosis, the same harness was temporarily run with the exclusive cache trust disabled. It added four warm cumulative-index reads/parses in addition to the required physical-cold read. Full 10,000-entry chunk timings were 1.139s, 1.318s, and 1.429s. Local Node parsing is cheap enough that these wall times overlap the fixed run; the deterministic evidence is the eliminated cumulative parse count and restored entry-bound chunks. The 55.6-77.1ms production cost is not presented as reproduced locally.

An earlier exploratory SQLiteVFS-backed harness reached 7,373 entries at the 20s wall bound because its path-atomic W7 persistence dominated. That harness was not retained because the requested counting supervisor isolates the checkout/facet operation shape, but it leaves a real residual risk: production workerd plus SQLite/W7 latency must be validated by the TypeScript live gate. The change guarantees entry-bound behavior in the real checkout path when supervisor persistence is not the wall limiter; it does not claim the offline fake reproduces production storage latency.

## Clone timeout contract

- Default total clone budget: 30 minutes.
- Explicit \`opts.timeout\`: still controls the total operation budget.
- Non-clone default: unchanged at 5 minutes.
- Prepare and each checkout invocation retain the 240-second phase limit.
- If the remaining total budget limits a phase, the result is typed as \`GitCloneBudgetExceeded\`, with phase, completed chunks, processed entries, decoded bytes, elapsed milliseconds, and total limit. It no longer reports a misleading short phase timeout.
- Clone abort receives an independent 30-second cleanup deadline, so exhausting the clone budget cannot starve ownership-gated cleanup.

A protocol test advances the clock by 290 seconds during prepare and proves that the next checkout still receives a full 240-second phase deadline under the new default.

## Durable marker v2

The durable marker is now:

\`\`\`json
{
  "version": 2,
  "jobId": "...",
  "optionsHash": "...",
  "prepared": {
    "commit": "<oid-or-null>",
    "tree": "<oid-or-null>",
    "headRef": "<ref-or-null>"
  },
  "cursor": "<last-committed-nextCursor-or-null>",
  "cursorSeq": 0
}
\`\`\`

Prepare first writes the existing v1 ownership marker before mutation, then upgrades it to v2 in prepare's existing final durable flush once commit/tree/ref are known. V1 remains valid for ownership-gated abort and is interpreted as \`cursor=null\`, \`cursorSeq=0\`.

For every non-final chunk:

1. Worktree and cumulative index changes flush while the previous marker remains pinned.
2. Only after that W7 flush succeeds does a marker-only W7 write publish \`nextCursor\` and increment \`cursorSeq\`.

The final chunk flushes worktree/index first, then durably deletes the ownership marker. This is the terminal acknowledgement and avoids adding a new W7 round trip to one-chunk clones. The marker parser validates job identity, prepared identity, OIDs, cursor tree/stack shape, and sequence. A regression test round-trips the exact v2 marker, replays an older cursor, proves the replay is idempotent, and verifies the final tree and marker deletion.

## Verification

Passed:

\`\`\`text
all tests/unit/cf-git-*.mjs and tests/unit/git-*.mjs
node packages/worker/scripts/patch-install-deps.mjs
bun run --cwd packages/worker bundle:git
bun run --cwd packages/worker build
bun run --cwd packages/worker typecheck
bun run typecheck
git diff --check
\`\`\`

The Git suite includes checkout repair, fresh chunk/cold-cache, indexer, clone argument/lifecycle, 30k checkout performance, clone protocol/budget, closed-world W7/cursor durability, and large-read tests. The regenerated cf-git patch was also applied to the pristine cached dependency and compared byte-for-byte with the installed fixed source.

## Residual risks and live gate

- The decisive remaining validation is microsoft/TypeScript on production workerd/SQLite/W7. The offline harness proves cache behavior, cursor bounds, W7 ordering, and RPC shape, not production persistence latency.
- A cold worker must reread and parse the durable cumulative index and reload its pack state once. This is replay-correct but can make the first post-reset chunk slower.
- Index serialization remains once per committed chunk. At 10,000-entry chunks, TypeScript should require about nine normal chunks rather than hundreds; the live gate must measure final-index serialization cost.
- The supervisor loop does not yet consume the marker cursor after a DO reset. The v2 format and validated read/write path make that future reconciliation possible without redefining durability semantics.
- Fetch/prepare CPU marginality is unchanged and intentionally outside this round.
