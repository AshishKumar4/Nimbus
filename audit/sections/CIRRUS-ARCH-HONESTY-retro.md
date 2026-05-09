# CIRRUS-ARCH-HONESTY retro

**Branch**: `cirrus-arch-honesty`
**Base**: `origin/main` @ `a4d518e`
**Head**: `192c9cf`
**Date**: 2026-05-09

## Brief

Architecture docs claimed cirrus-real runs on DO Facet (own
SQLite, own hibernation). Prod reality since 2026-05-08T22:07Z
(deploy-flag-fix `$experimental` strip) is the fetcher-fallback
path. The deploy-flag-fix retro had claimed `experimental` was
"dead config" — that was wrong; `worker.getDurableObjectClass()`
requires it. D'.1 root-causing in the d1-fix wave exposed the
gap. Make docs honest about prod reality without rewriting the
architectural story.

Constraints: no src/ changes, no retroactive deletions of
original wrong conclusions (corrections must be APPENDED), no
new safety nets.

## What was wrong

Three doc surfaces overstated the cirrus-real topology:

1. **README.md (4 places)**:
   - §1 Features "Dev server" row claimed "DO Facet (own SQLite,
     own hibernation lifecycle)" with no caveat.
   - §1 System topology mermaid diagram showed a `DOFacet` subgraph
     for cirrus-real with "own ctx.storage.sql" — implying the DO
     Facet path was live.
   - §4 Architectural-layers mermaid diagram described L4 as
     "Stateful child — DO Facet — own SQLite" with cirrus-real
     inside it.
   - §5 Primitive fitness scorecard listed cirrus-real's primitive
     as "DO Facet" with no current/target distinction, claiming
     "Has own SQLite, hibernation, and preserves identity across
     supervisor reconnects (D'.1)".
   - Source-tree comment: `cirrus-real.ts # Real Vite as a DO
     Facet (D'.1)`.

2. **DEPLOY-FLAG-FIX-retro.md (line 70)**:
   - "Verdict: dead config. Removing has zero runtime impact."
     The grep audit at lines 61-70 missed `getDurableObjectClass`
     because the call site uses `(worker as any)` casts — the
     `as any` hid it from the static type-driven audit.

3. **PROD-RESET-INVESTIGATION-retro.md (Phase 4 D'.1 entry)**:
   - "✅ GREEN. 9/9 probe assertions pass." Held at the time
     D'.1 shipped, but didn't survive the deploy-flag-fix that
     landed hours later. Nobody updated the verdict when the
     probe regressed.

The accumulating effect: 4 successive cross-wave runs
(prod-bugs-2 P6, cache-and-scrub P6, two-tier-fanout P6, and
the regression's own opening before d1-fix) all reported D'.1
FAIL but treated it as "pre-existing — confirmed unchanged".
The README told a story that diverged from the live system
without anyone noticing.

## What got fixed

**P1 README updates** (commit `d50359f`, README.md only):
- §1 Features "Dev server" row: rewritten to say target =
  DO Facet, current = `WorkerEntrypoint` fetcher-fallback,
  with a pointer to "Platform-gated future state in §5".
- §1 System topology mermaid: cirrus-real node now shows
  "**fetcher-fallback (current)**", subgraph title now
  "DO Facet (cirrus-real) — 128 MiB isolate (target)" with
  the "own SQLite cookie pending RM-27238" footnote.
- §1 prose paragraph: prepended "would-be" to "stateful child";
  appended a callout block describing the prod reality
  (`$experimental` rejected by deploy validator → fetcher-
  fallback) with citations to D1-FIX-retro and RM-27238.
- §4 Architectural-layers mermaid: L4 subgraph title now
  "Child isolate — DO Facet (target) / fetcher-fallback
  (current)"; L4A node shows "**kind=fetcher-fallback** in
  prod*".
- §4 prose paragraph: appended a footnote explaining the
  asterisk and pointing at §5.
- §5 Primitive fitness scorecard: added new "Current state
  (prod)" column distinct from "Target primitive". Most rows
  show "✓ matches"; cirrus-real row explicitly shows the
  divergence.
- §5 New "Platform-gated future state" subsection with a
  per-row table (one row for cirrus-real today) describing the
  gap and what unblocks it (RM-27238).
- Source-tree comment: updated to "Real Vite — DO Facet target
  / fetcher-fallback in prod".

**P2 retro corrections** (commit `966bca4`, two retros):
- `DEPLOY-FLAG-FIX-retro.md`: appended `## Correction
  (2026-05-09)` section at the end. The "dead config" claim
  was wrong; `getDurableObjectClass` was hidden behind a `as any`
  cast. The wave's overall conclusion (remove `$experimental`
  flags) was correct; only the runtime-impact sub-claim was
  wrong. Original verdict text preserved verbatim.
- `PROD-RESET-INVESTIGATION-retro.md`: appended `### Correction
  (2026-05-09)` at the end of the Phase 4 D'.1 entry,
  describing the regression timeline (PASS at 22:03Z, FAIL by
  next run after 1909718 at 22:07Z), the 4-wave precedent-
  acceptance anti-pattern, the d1-fix graceful-degrade, and
  the current `kind = 'fetcher-fallback'` reality. Cross-
  references D1-FIX-retro for the full root-cause analysis.

Both retro corrections are surgical APPENDS — no original
content deleted, no original conclusions rewritten. Future
readers see the original claim alongside the correction.

## What kind of fix this was

Probe vs src/ vs prod-only mechanism: **docs only**. The src/
graceful-degrade was already shipped in d1-fix `c0a2b8e`. This
wave brought the docs in line with what the code actually does
in prod. Zero new code paths, zero new safety nets, zero
alternative architecture proposals.

## Other lies surfaced (or not)

Per the brief: "whether anything in docs surfaced ANOTHER lie
that needs follow-up."

I swept `audit/sections/*.md`, `docs/research/*.md`, README,
and `src/` comments. No additional false claims surfaced:

- `audit/sections/CLEANUP-AND-README-retro.md` line 117
  references "D'.1's DO Facet for cirrus-real" but as a
  meta-claim about what the README HAD at that wave's time —
  accurate description of historical state, not a forward
  claim. The README has now been updated; the historical retro
  describes the historical README. No correction needed.
- `audit/sections/PROD-RESET-INVESTIGATION-PHASE2-RETRO.md`
  line 18 references "A'.4 (cirrus-real → DO Facet) was
  deferred to Phase 4 D'" — accurate description of the
  Phase 2 wave's deferral decision. Still true.
- `audit/sections/PROD-RESET-INVESTIGATION-plan.md` §6.5
  describes Track D' as a future migration plan — accurate
  future-tense, no correction needed.
- `audit/sections/REBUILD-RECONNAISSANCE.md` Phase 4 D'
  section is a forward-looking plan ("Convert", "To: A loaded
  DO class run via ctx.facets.get") — historical artifact of
  the rebuild plan, not a current-state claim.
- `src/facets/cirrus-real.ts` has comments like "real Vite in
  a DO Facet [D'.1]" inside the generated facet module
  template. Comments are mildly out of date but the surrounding
  src code IS the runtime feature-probe + two-path bind, so
  the file as a whole is honest. Brief explicitly excludes
  src/ changes; leave alone.
- `src/loaders/index.ts:11` comment "not a DO Facet pool — the
  old 'Facet' name collided with..." is about NimbusLoaderPool's
  rename history; unrelated to cirrus-real. No issue.
- `docs/research/*.md` has zero cirrus-real references.

**No follow-up needed for additional lies.** The
cirrus-arch-honesty wave's edits cover the docs surface that
overstated the cirrus-real topology.

## Cross-wave verification

`audit/probes/phase5-regression/run-all.mjs` (full set):

- **29 PASS, 0 FAIL, 0 SKIP, 0 TIMEOUT, 0 MISS**

D'.1 specifically: 7/7 PASS at `kind = 'fetcher-fallback'` —
matches the docs we just made honest.

tsc baseline: 2 errors (unchanged from main).

This was expected. Docs-only wave shouldn't change runtime
behavior.

## Files touched (count: 4)

| File | What changed |
|------|--------------|
| `README.md` | §1 Features row, §1 topology mermaid, §1 prose callout, §4 layers mermaid, §4 footnote, §5 scorecard adds "Current state (prod)" column, §5 new "Platform-gated future state" subsection, source-tree comment |
| `audit/sections/DEPLOY-FLAG-FIX-retro.md` | Appended `## Correction (2026-05-09)` section at end. Original verdict preserved verbatim. |
| `audit/sections/PROD-RESET-INVESTIGATION-retro.md` | Appended `### Correction (2026-05-09)` section at end of Phase 4 D'.1 entry. Original "✅ GREEN" verdict preserved verbatim. |
| `audit/sections/CIRRUS-ARCH-HONESTY-retro.md` | This file (P4). |

## What I deliberately did NOT change

1. **No src/ changes.** Brief constraint. The src/ graceful-
   degrade was already shipped in d1-fix; this wave is docs-only.
2. **No retroactive edits to past retros that delete original
   conclusions.** Corrections are APPENDED at the end with explicit
   `## Correction (2026-05-09)` markers. The original "dead
   config" verdict and the original "✅ GREEN. 9/9 probe
   assertions pass" verdict are both preserved verbatim. Future
   readers MUST see what was claimed at the time.
3. **No new safety nets, no alternative architecture proposals.**
   The fetcher-fallback IS the prod path; the docs now describe
   it accurately. RM-27238 GA is what would unblock the DO Facet
   target — that's a Cloudflare-side change, tracked in the
   "Platform-gated future state" subsection, not a Nimbus
   roadmap item.
4. **No edits to source-tree comments inside `src/facets/cirrus-real.ts`.**
   The comments inside the generated facet-module template
   (e.g. `// real Vite in a DO Facet [D'.1]` at line 138) are
   slightly out of date but they describe the TARGET topology
   the file ALSO implements via the fallback. Brief excludes
   src/ changes; leaving alone is the right call.

## Commits

| SHA       | Phase | Description                                                          |
|-----------|-------|----------------------------------------------------------------------|
| `d50359f` | P1    | README scorecard + topology diagram show prod truth                  |
| `966bca4` | P2    | Append corrections to two retros (originals preserved verbatim)      |
| `192c9cf` | P3    | Cross-wave 29/29 PASS preserved (docs-only)                          |
| (this)    | P4    | Retro at audit/sections/CIRRUS-ARCH-HONESTY-retro.md                 |
