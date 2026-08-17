# @nimbus-sh/fabric

> Part of [Nimbus](https://github.com/AshishKumar4/Nimbus), my hobby/research
> cloud OS. This README is edited and maintained with Claude (AI) and
> presented as-is.

The Cloudflare-specific half of Nimbus: the machinery for running programs as
Durable Object facets and dynamic workers. Where `@nimbus-sh/core` is the
backend-agnostic OS (filesystem, shell, process contracts), this package is
what that OS runs on when the host is Cloudflare — and it never imports the
OS's policy, only its shared primitives.

What lives here:

- **Resident-process fabric** (`process-fabric.ts`, `workerd-facet-host.ts`,
  `process-host.ts`) — boot specs, the one `openResidentFacet` path a process
  becomes a running facet through, and the facet/peer substrate switch.
- **Loader pools** (`loader-pool.ts`, `fanout-pool.ts`) — keyed-slot warm
  isolate reuse over `env.LOADER`, and the two-tier fan-out that stays under
  workerd's per-DO dynamic-worker ceilings.
- **Launch pacing** (`launch-pacer.ts`) — spreading a large launch across DO
  turns so one launch never pins the actor thread or its CPU budget, and the
  pump that grants those turns from the embedder's alarm.
- **Launch journal** (`launch-journal.ts`) — the durable record of every
  resident launch, synced past the put/durability gap, and its recovery after
  an instance reset.
- **Image store** (`facet-image-store.ts`) — materializing boot images into
  the content-addressed store in reset-safe slices, and the mark-sweep rooted
  off live processes; the disk arrives through a small blob-store port.
- **Alarm machinery** (`alarms.ts`) — the multi-reason alarm multiplexer and
  the isolate-generation counter that survive DO hibernation.
- **Binding shims** (`bindings.ts`) — the chained `WorkerEntrypoint` proxies
  (`NimbusLoaderRPC`, `NimbusAssetsRPC`, …) that give a dynamically-loaded
  inner Worker working `env` bindings.
- **WS hibernation config** (`ws-hibernation-config.ts`) and small leaves
  (`ctx-exports.ts`, `inner-do-registry.ts`, `vendor/`).

The doc comments carry measured production numbers (platform ceilings, spawn
costs, memory envelopes) that are the design record for this machinery; they
travel with the code on purpose.

An embedder supplies two things at composition time: the name of its
supervisor `WorkerEntrypoint` (`setSupervisorEntrypointName`) and, if it uses
staged boots, an assembler for them (`setStagedBootAssembler`).
`@nimbus-sh/worker` is the canonical embedder.
