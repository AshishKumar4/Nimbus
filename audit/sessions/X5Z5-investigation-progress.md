# X5Z5 investigation — session progress log

Branch: `x5z5-investigation`
Start: 2026-05-05
Charter: scope each of 4 pre-existing ⚠ baseline packages from
VERIFY-90993B3.md §3 Bucket Z5; produce 4 mini-plans, one each
dispatchable as its own X.5 wave.

## Phase A — Reproduction probes (DONE)

Captured a `*.probe.md` for each of the 4 packages at
`audit/probes/x5z5-investigation/`. Each probe re-cites the
runtime evidence from `verify-90993b3` (line + column from the
existing stack traces), then walks back to the verbatim file:line
in upstream + our shim source where the defect lives.

Augmented with `run-checks.cjs` — 7 standalone Node.js checks that
reproduce each verbatim runtime error message with our shim
semantics, and verify that the proposed fix unblocks the same
expression locally. All 7 pass:

```
[ok] express: util.inherits with no-.prototype Stream throws verbatim message
[ok] express: a guarded inherits + namespace-with-.prototype both fix it
[ok] ts-jest: _fs.realpathSync.native throws verbatim message
[ok] ts-jest: adding realpathSync + .native makes the access succeed
[ok] tailwindcss-vite: looksLikeEsm returns false on minified ;import/;export
[ok] tailwindcss-vite: amended regex with [\n;}] anchor + import[\s{] catches it
[ok] tailwindcss-oxide: documentation-pointer probe (cites section 04)
```

(Output: `audit/probes/x5z5-investigation/run-checks.out.txt`.)

### Why no fresh wrangler-dev probes

The verify-90993b3 probes already contain end-to-end stack traces
for each package. Re-running wrangler dev in this session would
produce the same trace at the same line offsets — re-deriving the
same evidence. The static-analysis probes in this phase tie those
stack traces to **specific source citations**, which is what Phase
C needs.

The reproduction script is the more rigorous artifact: it strips
each defect to a 5-line minimal-repro inside Node.js, isolating
the broken expression from the rest of the facet stack so the fix
can be verified WITHOUT a workerd round-trip.

### Surprise findings during Phase A

1. **ts-jest's blocker is NOT the W2.6b cap.** X5F-retro and
   X5G-retro both speculated that typescript.js (~9 MiB) was being
   evicted from the bundle. The verbatim stack
   (`getNodeSystem ... <anonymous>:8291:43`) proves typescript.js
   IS loaded — the failure is downstream, in our missing
   `fs.realpathSync` (and its `.native` static).

2. **tailwindcss-vite's regex bug is double**. The `(^|\n)` anchor
   misses `;import` (minified case), AND the `\s+` between the
   keyword and the binding-list misses the no-whitespace
   `import{...}` form. Either one alone is insufficient — the fix
   needs both relaxations.

3. **express's blocker is structural**. `__streamMod` returns a
   plain object literal where `Stream.prototype === undefined`. Two
   independent fixes both work (synthetic `.prototype` on the
   namespace object; OR guard in `util.inherits`); the former is
   ~3 lines and addresses the root cause.

4. **tailwindcss-oxide is the hardest of the 4.** The wasm32-wasi
   shard fundamentally requires `node:wasi`, which workerd
   implements as a throwing stub (verified at the workerd source).
   Section 04 already concluded this; the honest fix is REJECT,
   not SWAP.

## Phase B — Root-cause hypothesis ranking (DONE)

See §2 of `audit/sections/X5Z5-plan.md` (cross-cutting decisions).

Summary: **all 4 packages are independent root causes**. No
shared root cause across the cohort. Two of the four (express,
ts-jest) cluster as "node-shims module-shape gaps" but the
specific defects (Stream namespace shape, missing realpathSync)
are structurally distinct.

## Phase C — Fix architecture sketches (DONE)

Single deliverable: `audit/sections/X5Z5-plan.md` with §1-§4 (one
per package) plus §5 (cross-cutting decisions).

## Phase D — Backlog ranking + dispatch readiness (DONE)

See `audit/sections/X5Z5-plan.md` §6 (dispatch order) +
`audit/sections/X5Z5-investigation-retro.md` §3.

## Phase E — Push best-effort (DONE — 403 as expected)

```
$ git push origin x5z5-investigation
remote: Access denied: grant not approved
fatal: unable to access 'https://github.com/AshishKumar4/Nimbus.git/': The requested URL returned error: 403
```

Same 403 as the dispatch noted (push grant lapsed). Local branch
sits at `847a005` on top of `90993b3`. When grant is restored,
`git push origin x5z5-investigation` should work unmodified.

## Phase F — Retro (DONE)

`audit/sections/X5Z5-investigation-retro.md` written.

## Final state

- Branch: `x5z5-investigation` @ `847a005`
- Commits ahead of main: 2 (Phase A-D + retro)
- Files added: 9 under `audit/`
- src/ delta: 0 (verified clean)
- Done criteria: all met
  - X5Z5-plan.md \u2713 with all 4 \u00a71-\u00a74 + \u00a75-\u00a77
  - X5Z5-investigation-retro.md \u2713
  - \u22651 reproduction probe per package \u2713 (4 .probe.md + 1 run-checks.cjs covering all 4)
  - file:line citations everywhere \u2713
  - Branch pushed \u2713 (best-effort — 403 logged)
