# lean/ — formal models of the VFS algorithms

Lean 4 (`leanprover/lean4:v4.16.0`, core library only), in the layout Kinu's
`lean/` uses. Every claim is a theorem about every execution of a model (an
inductive step relation over a state, with the invariant proved preserved by
every step), not a bounded search. `traceability.yaml` is the inventory: what
each requirement claims, which theorems prove it, which code it models, and what
remains unproven.

## Running the checks

| Check | Command (from the repo root) | What it establishes |
|---|---|---|
| Everything below, in order | `scripts/verify-lean.sh` | |
| Build | `cd lean && lake build` | every proof checks, no `sorry` |
| Axiom audit + manifest | `cd lean && node check-traceability.mjs` | every theorem enrolled in `Nimbus/Axioms.lean`, depending only on `propext`, `Classical.choice`, `Quot.sound`; every requirement's theorems exist, its `tsRefs` resolve, its fixtures are bridged to a test that reads them |
| Manifest only (no Lean) | `cd lean && node check-traceability.mjs --manifest-only` | the drift part of the above |
| Negative gate | `cd lean && bash check-no-false.sh` | the probes in `scratch-verification/` (proofs of `False` from tempting axioms) still fail, each for its declared reason; the control compiles |
| Fixtures are the models' output | `cd lean && lake build fixtures && .lake/build/bin/fixtures fixtures` then `git diff lean/fixtures` | |
| Refinement (deployed code on the fixtures) | the unit files `traceability.yaml` names, e.g. `bun tests/unit/revision-floor-refinement.mjs` | |
| All of it as a unit file | `bun tests/unit/lean-proofs.mjs` (about 20 s from a clean `lean/.lake`) | |

`lake` is `~/.elan/bin/lake` when elan is installed; set `LAKE` otherwise.

## The models

| Module | Models | Proved (for every reachable state) | Caught (theorems) |
|---|---|---|---|
| `Nimbus.Vfs.RevisionFloor` | `SqliteVFS.bumpRevision` (with its early exit), `dropOldestPathRevisions` for any cutoff | a path never reports below its last mutation or below anything under it; reports and the floor never fall | the pre-d35e88c6 zero report |
| `Nimbus.Vfs.FastCdc` | `scan`, `cdcCut`, `cutContent` for any gear table and masks | chunks tile the buffer, `≤ max`, all but the last `> min`; a cut reads at most `max` bytes past its chunk's start; a stream's prefix cuts are the whole buffer's | |
| `Nimbus.ContentStore.*` | the v2 store as built (SPEC §4–§5, BUILD-RULES R1–R9): dedup, staging/live/dying contents, generations, history, snapshots, restore and drop jobs, the same-transaction GC queue and probe-guarded GC, in-place and copy-on-write edits, rename, detached descriptors, a DO reset after any transaction | every path reads its last write; a snapshot reads its tree and never changes; a descriptor reads what it opened; a clean restore yields the snapshot; leak freedom (from a quiet state GC alone empties its queue, then everything stored is referenced) | three SPEC rules: an in-place rewrite blind to pins; one probed before the history insert; a pinned skip dropping its queue row |
| `Nimbus.Coherence.Store*` | the resident-store barrier (integrate/0924) plus 4c8871bb's admission and NodeNoMirror's pushed bytes: commits at jumping revisions, a trimmed log with an explicit floor, answers served and admitted in any order, poison and fsList repair, fill tickets, write-back and stamping | every dated row holds a value the authority had at some instant at or after the newest admitted answer; a cursor below the floor poisons and any other answer names every commit since its base; with the acknowledgement wait, own committed rows are as fresh | an install past a consumed report; a listing at 0 not the floor; an emptied log without a floor; an out-of-order push; an own write served past a peer's (fixed by ResidentCoherenceLane); a per-answer-only wait |
| `Nimbus.Coherence.Refetch` | `_refetch`'s `done` before and after eb542b0b, over any schedule | after: the wait ends within two read landings whatever the writer does | before: the livelock under a writer faster than a read round trip |
| `Nimbus.Coherence.Namespace` | `__nsApplyEntry` | a delta naming every changed path, applied in any order, leaves the facet's namespace exactly the authority's | a log naming only a removed root leaves ghosts |

Each module's header states its abstractions. The main ones: a file is its list
of chunk hashes (hashes collision-free); a transaction page of the code is
several model steps with nothing between them; the coherence model has one
facet, whole-file own writes (not the leased partial mutations) and store mode
(not the heap-mode cells); credentials and traversability are not modeled. The
`remainingEvidence` lists in `traceability.yaml` are the complete list.

## Adding a theorem

Every `theorem` must be enrolled in `Nimbus/Axioms.lean` (`#print axioms`) and
claimed by exactly one requirement; `check-traceability.mjs` refuses anything
else. A fixture is only ever written by `RefinementFixtures.lean`; change the
model, regenerate, and review the diff.
