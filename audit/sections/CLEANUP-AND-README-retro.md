# Cleanup + README Retro

**Branch**: `cleanup-and-readme`
**Base**: `main` @ `522280b` (architectural rebuild Phase 1-5)
**Final**: `cleanup-and-readme` @ `0376d14`

Four commits, all tsc-baseline-preserving, all cross-wave probe-clean:

```
0376d14 chore: comment density audit — WHY, not WHAT
de50e3b refactor: dead code removal sweep
e910039 chore: README architecture diagrams (post-rebuild)
0912546 refactor: src/ directory structure — kernel/session/facets/loaders/observability/vfs
```

## Cumulative diff

```
282 files changed, 1195 insertions(+), 1651 deletions(-)
                                       net: -456 LOC
```

The line-count drop reflects: dead-code deletion (~280 LOC of orphan
files + ~62 LOC of legacy fallback + ~50 LOC of unused imports/fns)
plus the rest from probe artifact rewrites (path strings updated in
~150 probe files).

## Directory structure delta

### Pre-cleanup (post-rebuild)

```
src/
├── 70+ flat .ts files using naming-prefix conventions
│   (npm-*, vfs-*, nimbus-session-*, facet-*, replica-*, ...)
├── _shared/    (6 files)
├── frameworks/ (5 files: astro, next, nuxt, remix, sveltekit)
├── observability/ (1 file: heap-estimate)
├── parallel/   (loader pool + vendor)
└── session/    (2 files: init-phases, state-store)
```

Read order at `src/`: alphabetical, ~70 files, no architecture
visible.

### Post-cleanup

```
src/
├── index.ts                  # Workers entry point
├── constants.ts              # universal constants
├── *.generated.ts (6 files)  # build artifacts
│
├── _shared/        (8 files; +retry, session-id, session-router)
├── bindings/       (3 files; CF binding shims — was top-level)
├── facets/         (9 files; cirrus-real, ws-terminal, manager, etc.)
├── frameworks/     (1 file; just next.ts after dead-stub deletion)
├── git/            (2 files; commands, network-facet)
├── loaders/        (5 files + vendor; was parallel/)
├── npm/            (10 files; cache, installer, resolver, etc.)
├── observability/  (5 files; +oom-*, diag-counters, heavy-alloc-coord)
├── replica/        (2 files; routing, suspension)
├── runtime/        (14 files; node-shims, esbuild, barrels, etc.)
├── session/        (17 files; full DO state machine + helpers)
├── shell/          (2 files; features, unix-commands)
├── vfs/            (4 files; sqlite-vfs, events, path, seed-project)
└── wrangler/       (1 file; nimbus-wrangler)
```

Read order at `src/`: 14 domain dirs, each is a clear architectural
concern. A new contributor finds vite work in `facets/`, npm in
`npm/`, recovery in `session/state-store.ts`. Naming-prefix
conventions disappeared — a file inside `npm/` is named for its
role (`installer.ts`, `cache.ts`) not for its package
(`npm-installer.ts`).

## LOC removed

| Category | LOC | Files |
|---|---|---|
| Dead orphan files | ~280 | 6 (4 framework stubs + colors.ts + http.ts) |
| Legacy fallback (handleSupervisorRpc) | ~62 | 1 fn body + 14 LOC of route handler |
| Unused imports + functions | ~80 | 12 files |
| **Net code removed** | **~422** | |

The remaining -34 LOC of the -456 net are wash from probe artifact
text updates and re-flow of multi-line imports.

## Diagram count

README.md gained **4 Mermaid diagrams + 1 scorecard table**:

1. **System topology** (`flowchart LR`) — Browser → Worker
   entrypoint → supervisor DO → {Worker Loader fleet, DO Facet,
   R2, DO SQLite}, with 128 MiB isolate boundaries explicit.
2. **R-B-W-O session lifecycle** (`stateDiagram-v2`) — Phase 3
   B'.4 state machine; cold (R→B→W→O→hydrated) and warm
   (R→W→hydrated) paths explicit.
3. **Memory budget breakdown** (`flowchart TB`) — 64 MiB
   supervisor ceiling = baseline 9 MiB + LRU 6 MiB + 5 dynamic
   slots; sum=total invariant shown.
4. **Architectural layers** (`flowchart TB`) — five concentric
   layers (edge / supervisor / Worker Loader / DO Facet /
   storage); cross-isolate platform boundaries explicit.
5. **Primitive fitness scorecard** (table) — every subsystem
   mapped to one of {Worker Loader, DO Facet, DO SQLite, R2},
   citing dossier sections.

Every claim cites a concrete `src/` path under the post-cleanup
layout. Phase 5 measured peak heap (15.24 MiB / 64.0 MiB / 23.8%)
is baked into the memory-budget diagram.

The README's Project Structure section was rewritten to reflect
the new directory tree. The "What Nimbus builds on top" table's 8
path citations were updated (`src/sqlite-vfs.ts` →
`src/vfs/sqlite-vfs.ts`, etc.) including a corrected "Dev server"
row that reflects D'.1's DO Facet for cirrus-real.

## tsc baseline status

**2 errors**, identical to main:

```
src/runtime/esbuild-service.ts(153,28): error TS2307:
  Cannot find module 'esbuild-wasm/esbuild.wasm'
src/session/init.ts(150,39): error TS2345:
  SqliteVFSProvider not assignable to VirtualProvider | MountProvider
```

Both unrelated to cleanup. `bun x tsc --noEmit
--noUnusedLocals --noUnusedParameters` dropped from **79 unused-
declaration warnings** to **17** (remaining are
interface-contract parameters — must keep the slot for the
signature even when the body doesn't use it).

## Cross-wave regression status

After every commit in this branch:

```
audit/probes/phase5-regression/run-all.mjs
  PASS    : 28
  FAIL    : 0
  TIMEOUT : 0
  total PASS lines: 139
  runtime: ~31s
```

Probe coverage:
- Track A' (4 probes): heap reductions
- Track B' (5 probes): recovery correctness
- Track C' (3 probes): observability
- Track D' (2 probes): primitive alignment
- Wave 5 functional (4 probes): ring/lru/sqlite/diag
- Wave 7 functional (8 probes): streaming buffers
- interactive-liveness walltime-distribution
- refactor-gate (tsc + RPC + cmds + exports)

W5 functional probes count: 16 + 11 + 13 + 21 = 61/61 PASS.

## Audit findings worth preserving

### What got fixed

- **`src/parallel/` → `src/loaders/`** at the directory level.
  D'.2 fixed the class name (`NimbusFacetPool` → `NimbusLoaderPool`)
  but left the directory name. Cleanup propagates the rename
  through.
- **One stale "NimbusFacetPool" comment in
  `esbuild-wasm-bundle.generated.ts`** — script template updated
  so the next regeneration writes "NimbusLoaderPool" instead.
- **`handleSupervisorRpc` legacy fallback** removed. Was
  `@deprecated` since the SupervisorRPC class landed; quarantined
  with on-entry warnings; no caller hit it post-rebuild.
- **4 framework stubs** (astro, nuxt, remix, sveltekit) removed.
  W11 planning artifacts; the actual framework-detection logic
  lives in `runtime/framework-detect.ts`.
- **`_shared/http.ts`, `_shared/colors.ts`** — Phase 2 staging
  helpers; "per-call-site migration" never happened; zero
  importers.
- **Pre-rebuild filename references in file headers** — every
  session/ file's first line said `nimbus-session-X.ts` even
  though the file is now `session/X.ts`. All updated.

### What was deliberately NOT touched

- **Inline imperative comments** in vite-dev-server.ts and similar
  long files (~600 inline comments per file). On context most
  contain WHY ("// Strip query parameters for path resolution,
  keep for logic"); rewriting at scale would cost reading time
  more than it saves.
- **Generated files** (`*.generated.ts`, `loaders/generated-workers.ts`):
  comment changes there are downstream of the script templates.
  Updates landed in the scripts; next regeneration propagates.
- **Probe artifact text files** (`audit/probes/**/*.txt`): the
  current text reflects the latest probe runs, not architectural
  state. They auto-rewrite on next probe run.
- **History notes** in headers (e.g., "X.5-L: thin wrapper added
  for back-compat"). These tell future readers when and why a
  pattern landed; deleting them loses context.

### Honest scope check

The original brief asked for "presentable, readable, maintainable"
plus 4 specific tasks (README diagrams, dir reorg, dead-code
removal, comment audit). Each landed:

- **Dir reorg**: 70+ flat files → 14 domain dirs. Architecturally
  honest (each dir is one platform concern). Done.
- **README diagrams**: 4 Mermaid + 1 scorecard, all anchored to
  `src/` paths. Done.
- **Dead-code removal**: 6 files deleted, 1 legacy fallback
  removed, ~80 LOC of unused imports/fns gone. tsc unused-decl
  warnings dropped 79 → 17. Done.
- **Comment audit (WHY, not WHAT)**: 13 file headers rewritten
  to lead with architectural rationale instead of stale filename
  citations. Inline comments left alone (the codebase was
  already in good shape there). Done with explicit
  scope-boundary documentation.

The pragmatic finding: the rebuild already left the codebase in
strong shape. This cleanup was finishing work on top of solid
foundation — naming, structure, presentation — not surgery on
architectural problems. The honest scope was small.

## Branch ready for batch-merge to main

All four commits independent, each tsc-clean, each probe-clean.
Recommended merge: single coherent PR titled "Cleanup + README
diagrams" with body summarising the 4 commits and linking to this
retro.

Pre-merge sanity: re-run
`audit/probes/phase5-regression/run-all.mjs` against fresh
wrangler dev. Expected: 28/28 PASS in ~30s.

Post-merge: regenerate the *.generated.ts files (`bun install`
runs the postinstall scripts; their stale comments mentioning
NimbusFacetPool will get rewritten with the new comments).
