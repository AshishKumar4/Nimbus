# @nimbus-sh/platform

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

The zero-dependency leaf under
[`@nimbus-sh/core`](https://www.npmjs.com/package/@nimbus-sh/core) and
[`@nimbus-sh/fabric`](https://www.npmjs.com/package/@nimbus-sh/fabric): the
measured Cloudflare platform truths both are built on, separated from the
policy Nimbus layers on top of them.

- `limits.js` — the measured limits tables: storage-transaction bounds, the
  RPC payload envelope, and the supervisor memory budgets. Each constant's doc
  comment carries the measurement that set it.
- `oom-classify.js` / `oom-discriminator.js` — the error taxonomy for isolates
  that die without throwing: OOM vs CPU reset vs transient DO reset vs
  overload, and the failure ring that attributes them after the fact.
- `heap-estimate.js` / `heavy-alloc-coord.js` / `weighted-credit-pool.js` —
  the instrumented supervisor heap model and the weighted admission budget
  behind it.
- `diag-counters.js` / `install-phase.js` — the deterministic allocation-site
  counters that replace `process.memoryUsage()` (which returns 0 in a Durable
  Object), and the phase taxonomy they report.
- `rpc-dispose.js` — explicit `Symbol.dispose` handling for RPC resources,
  including on error paths.
- `w7-frame.js` — the incremental typed record format for streamed bulk
  filesystem writes, and the batch payload types it encodes.

No runtime dependencies, no imports from any other Nimbus package. Everything
above it — core's filesystem and shell, fabric's Durable Object machinery, the
worker — consumes this package; nothing here knows about them.

## License

MIT.
