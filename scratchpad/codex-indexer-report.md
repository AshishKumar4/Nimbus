# cf-git pack indexer optimization report

Date: 2026-07-15
Branch/base: `fix/session-reset-hardening` at `7c1f8d7`

## Outcome

`GitPackIndex.fromPack` now hashes every non-delta object from the bytes that
`listpack` has already inflated, so the resolve pass no longer inflates those
objects a second time. Delta objects still follow the existing `readSlice`
path, including Commit 1's read-context cache and external-ref fallback.

`GitPackIndex.toBuffer` now builds the cumulative v2 fanout table with one
hash pass plus one 256-entry prefix sum instead of scanning every hash 256
times.

The installed cf-git source, tracked patch, generated facet bundle, and worker
build artifacts all carry the change. No public API, pack/index format, clone
behavior, or deployment configuration changed.

## Root cause and implementation

### `listpack`

The scanner and its boundary detection are unchanged. It still fully inflates
one object at a time, verifies the declared inflated length, backs the reader
up to `inflator.strm.avail_in`, and reports the exact `offset`/`end` boundaries.
This avoids changing the correctness-critical compressed-stream parsing.

### `GitPackIndex.fromPack`

For pack types 1-4 (`commit`, `tree`, `blob`, and `tag`), the `listpack`
callback now computes:

```text
SHA-1("<type> <inflated-byte-length>\0" || inflated-bytes)
```

through the existing `GitObject.wrap` and `shasum` implementations. This is
the identical byte sequence the old resolve loop produced after calling
`readSlice`; pako's scanner result and `readSlice` result are the same inflated
object bytes, and the differential tests cover all four object types.

The callback records only the OID on the existing per-offset metadata. It does
not retain `data`. The original pack-order resolve loop remains the sole owner
of inserting OIDs into `hashes`, `offsets`, and `crcs`. That ordering is
important: it preserves the pristine implementation's behavior when the same
OID has both delta and non-delta representations, including which later pack
entry wins the offset and CRC maps. It also preserves the existing timing of
ref-delta lookups and external fallback.

When the resolve loop reaches a pre-hashed non-delta entry, it registers the
OID/offset/CRC and skips `readSlice`. OFS and REF deltas still use the unchanged
`readSlice` path, so delta application, declared-length checks, recursive base
resolution, external-ref behavior, and Commit 1's depth cache remain intact.

Memory remains bounded by the current object being scanned: during the
callback, pako's one inflated result and the temporary wrapped hash input are
live; both are released after the awaited hash completes. No inflated object
payload is accumulated or cached. The only retained addition is the OID string
that the final index already requires, stored on metadata that already exists
for every pack offset.

### `GitPackIndex.toBuffer`

The new code increments one of 256 `Uint32Array` counters for each sorted hash's
leading byte, then prefix-sums those counters while writing the existing
big-endian table. For each fanout slot `i`, the written value is still exactly
the count of hashes whose first byte is `<= i`; only the computation changes.
All later idx fields and the final idx SHA are untouched.

For 75,447 deterministic hashes on this local machine, a one-off Bun
micro-measurement was 1,376.98 ms for the old nested scan and 5.30 ms for the
new counter/prefix-sum path (259.7x for fanout alone). This is a local CPU
measurement, not a Cloudflare Worker timing prediction.

## Byte-exact tests and RED to GREEN evidence

Added:

- `tests/unit/cf-git-indexer.mjs`
- `tests/fixtures/cf-git-indexer/real.pack` (9.7 KiB, 10 objects, two real OFS
  deltas, SHA-256
  `2ff8c999908080eb9b4749a1083426aa8756e5a9a0fd4147789f3ab54cdbf102`)

The unit test reconstructs pristine cf-git 1.0.5 by reverse-applying the
tracked patch to the installed source in a temporary directory. It loads both
implementations and compares:

- sorted hashes, OID-to-offset maps, CRCs, and pack trailer SHA;
- every byte of `toBuffer()`;
- every indexed object's returned type and content bytes;
- a captured pack produced by Git itself;
- deterministic standalone commit/tree/blob/tag objects;
- eight-level OFS and REF delta chains;
- a thin external REF delta through `getExternalRefDelta`;
- duplicate delta/non-delta representations of one OID; and
- fanout bytes for deterministic randomized sets of 1, 17, 257, and 1,024
  hashes.

Initial RED against `7c1f8d7`:

- the four-object standalone pack performed four second-pass pako inflations
  instead of zero (`4 !== 0`);
- one hash caused 256 leading-prefix parses, violating the single-pass bound.

A first implementation then exposed a second useful RED: eagerly populating
the maps during scanning made a duplicate OID's delta entry at offset 35 win,
where pristine correctly preserved the later non-delta entry at offset 65,
with a corresponding CRC mismatch. Moving all map registration back into the
pack-order resolve loop fixed that semantic regression.

Final GREEN: all six indexer cases pass against the reconstructed pristine
implementation, including full `.idx` byte equality.

## Verification

Passed locally:

- `bun tests/unit/cf-git-indexer.mjs`
- `bun tests/unit/cf-git-checkout-repairs.mjs` unchanged
- all 71 `tests/unit/*.mjs` scripts, run sequentially; no failures. The two
  OpenTUI source-checkout tests reported their existing explicit skip because
  the optional `@opentui/core` source tree is absent.
- `node packages/worker/scripts/patch-install-deps.mjs` (patch recognized as
  already applied)
- `bun run --cwd packages/worker bundle:git`
- `bun run --cwd packages/worker build`
- `./node_modules/.bin/tsc --noEmit`
- `bun run --cwd packages/worker typecheck`
- `git diff --check`

The regenerated `packages/worker/src/git-bundle.generated.ts` was inspected
for the first-pass hash, pack-order registration, and `Uint32Array(256)` fanout
counter code. The generated worker `dist` artifacts were rebuilt from source.

No deployment or live probe was attempted.

## Expected CPU effect and residual risk

The inflation saving is exact: one top-level second-pass pako inflation is
removed for every non-delta object. The first `listpack` inflation remains for
every object, and all delta-stream and recursive base inflations remain.

For a heavily deltified pack where only 10-30% of objects are non-deltas, this
removes 10-30% of the mandatory top-level resolve-pass inflations. Once the
unchanged first scan and recursive delta-base work are included, a realistic
estimate is roughly 3-15% of aggregate inflation calls, with byte-weighted CPU
potentially above or below that range depending on base object sizes and chain
shape. The actual TypeScript pack histogram is not available locally, so a
more precise claim would be speculative. The separate fanout reduction removes
about 19.3 million prefix parses at 75,447 objects and was about 1.37 seconds
locally.

Together these should be a meaningful `fromPack` reduction, plausibly a few
seconds at TypeScript scale, but there is not enough local evidence to claim
the 30-second facet cap now has safe headroom. The remaining dominant risk is
that TypeScript's delta share and recursive resolution cost are high enough
that the saved non-delta reinflations plus fanout are insufficient. Claude's
fresh production clone/CPU trace is still the decisive gate.

Correctness residual risk is limited to pack shapes not represented by the
captured and crafted differential corpus. The implementation deliberately
leaves scanner boundaries, CRC slicing, delta mechanics, hashing primitives,
pack-order registration, and idx serialization unchanged, which keeps that
risk narrow.
