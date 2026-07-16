# Codex cleanup execution report

Branch: `fix/session-reset-hardening`

Baseline: `e1441b4`

## Critical tooling hazard

Done. Commit `214dfc3` replaced the literal NUL bytes in
`packages/worker/src/facets/manager.ts` with `\x00` source escapes. The runtime
key remains byte-equivalent, while ordinary text search now reads the file.
Zero-caller checks for all later deletions were repeated after this commit.

## Wave 1

1. **Dead in-supervisor resolver — done.** Removed `resolveTree`,
   `resolvePackage`, and their exclusive helpers while retaining the live hoist
   and registry conversion surface. Removed the now-writer-less resolver,
   install-facet, response-stub, heap-estimate, reset, LRU, eviction-label,
   compatibility re-export, and pre-bundle diagnostic state listed in the
   brief.
2. **Dead loader surface — done.** Deleted the loader barrel and dead error
   re-exports/options/constants. Routed session routes through the shared
   topology helpers, removed the duplicate inline topology logic, narrowed the
   spawn-facet state, and removed dead spawn-pool state and guards. Updated the
   facet bundle generator and regenerated its output.
3. **Dead runner surface — done.** Removed the node long-running fallback,
   `FacetManager.spawn`, the `runNodeScript` alias/casts, dead runtime spec and
   manifest fields, dead clang/ruby/node/Python facet plumbing, the unused
   preview-port helper, redundant catalog key helpers, and the requested F16
   dead/stale items. The removed `pyodidePackages` path was specifically the
   hard-coded-empty `PythonFacetArgs`/facet CDN-load path; the distinct live
   Python pip artifact metadata remains.
4. **`FORCE_TTY` alias — done.** Removed both aliases, regenerated the Node
   shims, and passed artifact parity checks. The generated runtime asset changed
   from `node-shims-58dce625ae94f0c4.js` to
   `node-shims-128de00b9b294632.js`.
5. **Impossible-state guards and `globalThis` singletons — done.** Moved heavy
   allocation and OOM discriminator state to typed module scope, removed legacy
   singleton/cast guards, made OOM rehydration v2-only, and typed cache-event
   folding.
6. **Duplicated constants — done.** Added one shared source of truth for the
   pre-bundle slice cap and concurrency and imported it from the installer and
   heap estimator.
7. **Dead vendor files — done.** Deleted `pool.ts`, `codegen.ts`,
   `primitives.ts`, and `index.ts`; corrected the trimmed-subset version note
   and loader-pool title.
8. **R2 counter consolidation — done.** Removed the eight flat hit/miss/put
   counters and their supervisor RPC writers. Retained the four live pipelined
   race counters and `recordR2RaceCounters`.
9. **Comment/doc corrections — done.** Corrected the requested stale headers,
   paths, transport descriptions, truncated prose, phantom citations, typos,
   and cleanup narration. `shellExecuteTracked` now stamps explicit
   long-running intent, allowing the display-regex fallback to be deleted.
10. **Type safety — done.** Narrowed caught values from `unknown`, changed port
    routing trust-boundary inputs from `any` to `unknown`, and removed the dead
    OOM casts.

No required Wave 1 item was skipped.

## Wave 2

1. **Leading runtime flags — done.** Added one shared leading-flags scanner and
   used it for Python, Ruby, and clang. Red: Ruby and clang incorrectly treated
   a script argument such as `script.rb --version` as a runtime version request.
   Green: `tests/unit/runtime-leading-flags.mjs` proves scanning stops at the
   script operand for both runners.
2. **`Bun.serve` honesty — done.** Replaced fake success with a precise
   unsupported-operation error and removed the global stash. Red: the shim
   returned a fake server and installed `__nimbus_bun_serve`. Green:
   `tests/unit/bun-serve-honesty.mjs` proves the call throws and no stash exists.
3. **Runtime `HOME` defaults — done.** Python and Ruby now apply `/home/user`
   only when `HOME` is absent, preserving explicit runtime homes. Red: explicit
   `HOME` values were overwritten at the loader boundary. Green:
   `tests/unit/runtime-home-env.mjs` covers explicit and default homes through
   the real loader path.
4. **curl discarded DoH lookup — done.** Removed curl's unused external DNS
   resolution and retained local `/etc/hosts` loopback routing. Red: one
   external curl made two fetches, including a discarded dns.google request.
   Green: `tests/unit/lifo-loopback-routing.mjs` proves custom loopback hosts
   still route locally and external URLs issue exactly one fetch. The separate
   `dig` command's intentional DNS implementation remains.
5. **PortRegistry double bind — done.** Made `attachFacetStubByPid` private and
   pre-normalized, removed `FacetManager.attachReservedPorts`, and eliminated
   the second bind. Red: route-target normalization ran twice. Green:
   `tests/unit/port-registry-routeable-stub.mjs` proves it runs once.

Each Wave 2 test was observed failing against the pre-fix source and passing
after its corresponding implementation. No required Wave 2 item was skipped.

## Audit claims and scope decisions

- No Wave 1 or Wave 2 zero-caller claim failed reproduction after the NUL-byte
  fix.
- The VFS-era suggestion to delete clone-marker v1 acceptance is disproved by
  the git audit and by current unit-test consumers: v1 is required to prove
  ownership after a crash between prepare generations. It was deliberately
  left unchanged.
- A broad search still finds `pyodidePackages`, but only in the live pip
  artifact/startup-module path identified by the runtime audit as distinct from
  the dead facet argument. It was retained.
- A broad search still finds dns.google in `dig`; the bug was curl performing a
  discarded lookup, not removal of DNS query functionality from the shell.

## Deliberately residual work

- The large in-shell Node/network stack removal and the lifo Sandbox product
  decision remain separate structural slices, as required.
- Runtime-audit items outside Waves 1-2 remain, including mode-specializing the
  opencode facet bundle (F4), consolidating Python/Ruby socket machinery (F13),
  and wiring opencode piped stdin (F15).
- Clone-marker v1 acceptance, `__pendingIO`, the W7 protocol, and all heuristics
  marked KEEP were not changed.
- Live production gates were not run because this task explicitly prohibited
  network access; they remain for the owner/Claude environment.

## LOC accounting

Measured from `e1441b4` through the regenerated artifacts, excluding this
report:

- Production source and owning scripts: 2,865 deleted, 423 added, **2,442 net
  lines removed**.
- Generated `dist`: 2,883 deleted, 548 added, **2,335 net lines removed**.
- Unit tests: 20 deleted, 241 added, **221 net lines added**.
- Hashed runtime asset rename: one line replaced.
- Repository total: **5,769 lines deleted**, 1,213 added, **4,556 net lines
  removed**.

## Verification transcript summary

Wave 1 and final Wave 2 gates both completed successfully:

- `npx tsc --noEmit -p packages/worker`
- `bun tests/unit/*.mjs`
- `npm run build -w @nimbus-sh/worker`
- `npm run bundle:shims -w packages/worker`
- facet worker bundle regeneration through its owning script
- Node shims artifact parity check
- `git diff --check`

The final unit run covered all 92 unit files. All runnable tests passed; three
OpenTUI source-dependent files reported their existing explicit skips because
the external OpenTUI source tree was unavailable. The worker build regenerated
and committed all changed `packages/worker/dist` output.
