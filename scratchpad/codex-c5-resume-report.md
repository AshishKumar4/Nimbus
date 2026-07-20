# C5 checkout resume report

## Result

The remaining cumulative checkout cost was not the DFS cursor and was not
`index.insert`. The cursor already selected the next subtree in O(depth), and
`GitIndex.insert` used keyed map insertion. The quadratic term was the durable
cumulative Git index: every non-final chunk serialized all entries completed so
far, then W7 rewrote that progressively larger `.git/index` before advancing the
marker cursor.

The fixed checkout writes one bounded, standard Git-index fragment for each
non-final chunk. A resumed materialization chunk creates only its current
fragment; it does not read, parse, sort, hash, serialize, or rewrite any prior
index entry. The terminal chunk validates and streams the ordered fragments into
one canonical byte-exact `.git/index`. The facet removes the fragment directory
atomically with terminal marker acknowledgement. The aggregate work is linear:
bounded sort/serialization per materialization chunk plus one O(N) terminal
merge/hash/write.

## Root-cause measurements

Temporary counters were added only to the local latency harness and removed
after diagnosis. This was a warm packed-object run with real pako work and
10,000-entry chunks:

| Chunk | Resume seek | Tree reads | Blobs decoded/materialized | Index parse | Index insert | Cumulative index serialize |
|---:|---:|---:|---:|---:|---:|---:|
| 2 | 18.18 ms | 4 | 10,000 / 10,000 | 0 ms | 10.66 ms | 30.79 ms |
| 3 | 19.97 ms | 4 | 10,000 / 10,000 | 0 ms | 8.83 ms | 42.72 ms |
| 4 | 18.49 ms | 4 | 10,000 / 10,000 | 0 ms | 8.81 ms | 57.90 ms |
| 5 | 17.35 ms | 25 | 9,989 / 9,989 | 0 ms | 9.79 ms | 90.50 ms |
| 6 | 1.31 ms | 26 | 9,990 / 9,990 | 0 ms | 9.89 ms | 104.88 ms |
| 7 | 1.25 ms | 26 | 9,990 / 9,990 | 0 ms | 10.20 ms | 122.68 ms |
| 8 | 1.59 ms | 26 | 9,990 / 9,990 | 0 ms | 10.25 ms | 141.00 ms |

Completed blobs were never decoded again, and tree reads reflected depth and
subtree-boundary changes rather than completed entry count. The only monotonic
term was full-index serialization. Its W7 payload and local buffer/hash work
also grew with the cumulative entry count.

The retained 60k red test makes that slope observable despite timing noise by
using 1,000-entry chunks and five-chunk medians. On `68e0341`, the chunk 2-6
baseline was about 702 ms, chunks 27-31 reached about 826 ms (+17.7%), and late
chunks reached about 1,124 ms. The test's 15% flatness assertion failed.

## Fix and invariants

- Cursor version 2 carries bounded `indexChunks` and `indexEntries` progress.
  Cursor reconstruction caches the tree object for each stack frame, so resume
  reads one tree per frame and performs O(1) work per frame. Completed subtrees
  are selected past without reading their trees or blobs.
- `GitIndexManager.acquireFreshCheckout` owns the fragment protocol. A
  deterministic fragment name makes whole-chunk replay overwrite the same
  bytes. Non-final chunks operate only on their current entries; the final
  merge verifies declared counts and strict cross-fragment path order before
  emitting the canonical index.
- The ordinary one-shot index serializer and entry encoding remain unchanged.
  Small repositories still write `.git/index` directly in one chunk and never
  create a fragment directory.
- The fragment directory is an authoritative cold-resume root narrowly inside
  the clone's `.git` directory. Its reads remain bounded by fragment count; no
  worktree metadata fallback was introduced.
- W7 still flushes the worktree and index fragment before marker-v2 advances.
  The first terminal W7 flush writes the canonical index; the acknowledgement
  W7 wave removes fragments and the marker together. An injected failure between
  those waves proves the old cursor and fragments survive and retry completes.
  Ownership, abort handling, directory-set carry, payload bounds, and old-cursor
  replay behavior are unchanged.
- The wall guard is checked immediately after each blob decode and again before
  materialization. A slow inflate cannot be preempted synchronously, but the
  checkout no longer performs another mutation after an inflate has exhausted
  the wall budget.

## Green flat-cost proof

The retained test builds a 60,001-entry packed repository with 60,000 unique
blobs, uses the real generated facet and real pako, and charges 30 ms to every
supervisor RPC. It runs 60 equal 1,000-entry materialization chunks, followed by
a one-entry terminal index-assembly chunk.

Final full-suite run:

| Measurement | Result |
|---|---:|
| Chunk 2 | 674 ms |
| Equal warm chunks 2-60 | 657-690 ms |
| W7 waves / RPCs per equal warm chunk | 10 / 17 |
| Five-chunk median windows vs. chunk 2-6 baseline | all within 15% |
| Old-cursor replay | 646 ms |
| Physical-cold resume | 759 ms |
| Completed-entry index reads during materialization | 0 |
| Terminal canonical assembly | 4,388 ms; 60 fragments read once each |

The terminal assembly is intentionally separated from equal-entry flatness: a
canonical Git index contains all N entries and therefore has an irreducible
single O(N) encode/hash/write. It occurs once, not once per chunk. Total index
work is O(N); no O(done) term remains in resumed materialization chunks.

## TypeScript live prediction

For 84,188 worktree/tree entries, the 10,000-entry limit alone gives nine
chunks: eight full chunks and one approximately 4,188-entry terminal chunk.
The 32 MiB decoded-byte limit can legitimately produce more, as the supplied
live evidence already demonstrates; without total decoded bytes, nine is a
lower bound and the expected count is the greater of the entry-bound count and
the decoded-byte-bound count.

Under the existing 30 ms large-pack model, the entry-bound case predicts about
eight times 4.3-4.7 seconds plus a 2.6-3.0 second terminal chunk, or roughly
37-41 seconds total. Extra decoded-bound chunks add their own current-entry W7
and decode work, but no cumulative-index slope. Production SQLite/W7 and pako
service times are not modeled exactly; the decisive live signature is similar
entry/decoded chunks remaining similar in wall time as cumulative `index=`
grows.

## Verification

- Full `tests/unit/*.mjs` suite: passed in 75.84 seconds; two existing OpenTUI
  source-dependent tests skipped because their optional source clone is absent.
- 60k 30 ms real-pako regression: passed as part of the full suite.
- `bun run --cwd packages/worker bundle:git`: passed.
- `bun run --cwd packages/worker build`: passed.
- `bun run typecheck`: passed.
- `bun run --cwd packages/worker typecheck`: passed, including frontend.
- The regenerated cf-git patch applied cleanly to the pristine Bun cache and
  reproduced the installed fixed `index.js` byte-for-byte. Both SHA-256 values
  were `eb6ac13e032d9e463c6073e1aedf1c2acbc37cf80581313bc80d4f9c33b7b2dc`.
- `git diff --check`: passed.

## Residual risks

- The one-time terminal canonical-index assembly is linear in repository size
  and will be visibly slower than an equal materialization chunk. Avoiding that
  would require changing the on-disk Git index contract rather than optimizing
  resume.
- A single synchronous pako inflate cannot be interrupted mid-call. The new
  post-decode guard bounds follow-on work but cannot prevent the inflate itself
  from crossing the wall deadline.
- The cursor caps fragment count at 20,000. With the current chunk bounds this
  is far beyond the target repository, while keeping marker payload validation
  finite.
- The 30 ms harness proves algorithmic shape and protocol counts. A live
  TypeScript checkout remains the final check for production workerd CPU and
  SQLite service-time constants.
