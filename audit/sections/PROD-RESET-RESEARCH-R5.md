# PROD-RESET-RESEARCH — R5: Cloudflare Containers (the GA primitive replacing "Cloudchamber")

Research scope: confirm what the user's `SHIP-10537 / Cloudchamber
container-in-DO` actually is in public docs (Cloudflare Containers
shipped GA), document the memory model (DO + container envelopes),
the GA timeline + instance types, and whether this primitive solves
or is relevant to Bug C.

---

## R5.1 Cloudflare Containers — the GA primitive

✓ CONFIRMED ([Cloudflare Containers](https://developers.cloudflare.com/containers/)).

The user's reference to "SHIP-10537 / Cloudchamber container-in-DO"
appears to be the internal-tracking name for what shipped publicly
as **Cloudflare Containers** (the public name for the platform; the
internal Cloudchamber project name does not appear in public docs).

The primitive:
- Each container is an **isolated Linux VM** running an OCI image.
- Each container is **backed by a Durable Object** that owns its
  lifecycle.
- The Worker spawns / addresses containers via DO stubs.
- The DO is the routing + state layer; the container is the
  execution layer.

[Containers Architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/) (via the Sandbox SDK doc, which IS a wrapper):

> Sandbox SDK lets you execute untrusted code safely from your
> Workers. It combines three Cloudflare technologies to provide
> secure, stateful, and isolated execution:
> * Workers — Your application logic that calls the Sandbox SDK
> * Durable Objects — Persistent sandbox instances with unique
>   identities
> * Containers — Isolated Linux environments where code actually
>   runs

The Sandbox SDK (`@cloudflare/sandbox`) is one wrapper. Direct
Container Class API (`@cloudflare/containers`) is another.

---

## R5.2 Memory & resource model — Container instance types

✓ CONFIRMED ([Larger Container instance types — 2025-10-01 changelog](https://developers.cloudflare.com/changelog/post/2025-10-01-new-container-instance-types/)).

| Instance type | vCPU | Memory | Disk |
|---|---|---|---|
| `lite` (dev) | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

[Custom instance types — 2026-01-05 changelog](https://developers.cloudflare.com/changelog/post/2026-01-05-custom-instance-types/):

> Custom instance types are now enabled for all Cloudflare
> Containers users. You can now specify specific vCPU, memory,
> and disk amounts, rather than being limited to pre-defined
> instance types.
>
> Individual limits for custom instance types are based on the
> standard-4 instance type (4 vCPU, 12 GiB memory, 20 GB disk).
> You must allocate at least 1 vCPU for custom instance types.

❗ ARCHITECTURE-IMPACTING — **A single Container instance gets
1-12 GiB of MEMORY**. Compare the DO 128 MB cap. Even the lowest-
tier `lite` is 2× the DO heap cap, and `standard-2` is **48×**.

For Nimbus's npm install + pre-bundle workload, a `standard-1`
(4 GiB memory) container would EASILY hold the largest project
we'd encounter without ever approaching its limit. We'd never
have to think about memory pressure for the install/build path.

---

## R5.3 Concurrency and account-wide limits

✓ CONFIRMED ([Run 15x more Containers — 2026-02-25 changelog](https://developers.cloudflare.com/changelog/post/2026-02-25-higher-container-resource-limits/)):

| Account-wide limit | Current |
|---|---|
| Memory for concurrent live Container instances | **6 TiB** |
| vCPU for concurrent live Container instances | **1500** |
| Disk for concurrent live Container instances | **30 TB** |

> You can now run 15,000 instances of the lite instance type, 6,000
> instances of basic, over 1,500 instances of standard-1, or over
> 1,000 instances of standard-2 concurrently.

So per-account we can spawn O(1000) concurrent containers of the
right size. For Nimbus's per-user-session model, that's plenty —
even with 10K users we'd only need ~1 container per session.

---

## R5.4 The DO + Container envelope

❗ ARCHITECTURE-IMPACTING.

[Sandbox SDK Architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/):

> Layer 2: Durable Object — Manages sandbox lifecycle and routing
> ```
> export class Sandbox extends DurableObject<Env> {
>   // Extends Cloudflare Container for isolation
>   // Routes requests between client and container
>   // Manages preview URLs and state
> }
> ```

[Container Class](https://developers.cloudflare.com/containers/container-class/):

> The Container class from @cloudflare/containers is the standard
> way to interact with container instances from a Worker. It wraps
> the underlying Durable Object interface and provides a higher-
> level API for common container behaviors.

Architecture:
- A Container is technically a **DO subclass** (`extends Container
  extends DurableObject`) that wraps a real Linux container.
- The DO's 128 MB heap cap STILL APPLIES — that's the JS layer
  that ROUTES requests into the container.
- The Container's own memory (1-12 GiB+) is SEPARATE from the DO's
  128 MB.
- They communicate via HTTP (default) or RPC-over-WebSocket
  ([Transport modes](https://developers.cloudflare.com/sandbox/configuration/transport/)) over a localhost socket.

So a Container-backed DO has BOTH envelopes:
- 128 MB JS isolate (the DO's `fetch` handler / RPC methods).
- 1-12 GiB Linux container (the actual workload).

The DO's job becomes pure routing: "I received a Worker request,
forward it to my container, return the container's response."

For Nimbus this would mean:
- `NimbusSession` becomes a Container-backed DO.
- The 128 MB heap cap is for the routing layer only.
- npm install, pre-bundle, vite, etc. all run INSIDE the container
  with full Linux + 4 GiB memory + 8 GB disk.
- No more 128 MB heap-pressure-induced eviction (R1.2.1, R1.2.2).
- No more "can our supervisor heap fit npm install?" questions.

---

## R5.5 Lifecycle and hibernation

✓ CONFIRMED ([Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/), [Container Class — sleepAfter](https://developers.cloudflare.com/containers/container-class/)):

```js
export class SandboxContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080, 9222];
  sleepAfter = "5m";
  // ...
}
```

Containers have their own sleep/wake lifecycle:
- `sleepAfter` (default 5 minutes) — container hibernates after
  inactivity.
- `pingEndpoint` — readiness check.
- Container state on disk persists across sleeps.

This is much more user-friendly than DO hibernation (which discards
in-memory state — R1.3) because the container's filesystem persists.
For Nimbus this would mean `~/app` files survive container sleep,
not just SQLite state.

---

## R5.6 GA timeline

✓ CONFIRMED via changelog dates:

- **2025-09-25**: First public expansion (40 GiB → 400 GiB
  account memory).
- **2025-10-01**: New instance types up to 4 vCPU / 12 GiB
  (standard-4).
- **2026-01-05**: Custom instance types for all users.
- **2026-02-25**: 15× expansion to 6 TiB / 1500 vCPU / 30 TB.

Containers are not just GA — they're at the high end of platform
maturity with multiple capacity expansions in the past 6 months.

⚠ UNVERIFIED: there's no specific "SHIP-10537" reference in public
docs. Most likely it's the internal SHIP number for the GA launch
(SHIP numbers are internal-only). The functionality landed; the
public name is "Cloudflare Containers".

---

## R5.7 Sandbox SDK — REJECTED-BY-CHARTER

The Sandbox SDK is a higher-level wrapper around Cloudflare Containers:

```js
import { getSandbox } from "@cloudflare/sandbox";

const sandbox = getSandbox(env.Sandbox, "my-sandbox");
const result = await sandbox.exec("python script.py");
```

Public APIs include `sandbox.exec()`, `sandbox.readFile()`,
preview-URL management, etc.

**This is exactly what Nimbus is designed to emulate without.**
Nimbus's `Shell`, `Kernel`, vfs-mount, and the LIFO command system
are JavaScript implementations of capabilities a real Linux
container provides natively — and emulating them inside DO+Loader
is the project's purpose. Adopting Sandbox SDK / Cloudflare
Containers as a Nimbus substrate would defeat that purpose.

**Verdict: REJECTED.** Cloudchamber container-in-DO (the platform
substrate behind Cloudflare Containers + Sandbox SDK) is tracked as
a primitive that exists ([cf-internal-dossier.md §6](../../docs/research/cf-internal-dossier.md))
but the Nimbus roadmap deliberately does not depend on it.

The pros/cons matrix the original research weighed (real bash vs JS
shell, 4-12 GiB workload memory vs 128 MiB JS heap, real fs vs
SQLite VFS, etc.) is moot in the face of the charter: if we wanted
to ship a Cloud-native dev env running on Containers, we would have
done that — many other projects already do. Nimbus is the
DO-only-emulation answer to the same problem.

---

## R5.8 R5 summary — what changes for plan §3

| Claim from current plan §3 / current code | R5 verdict |
|---|---|
| "Cloudchamber / SHIP-10537" | Public name is "Cloudflare Containers"; ✓ GA, capacity 6 TiB / 1500 vCPU / 30 TB account-wide |
| "Container memory: 128 MB isolate + N MB container" | ✓ CONFIRMED — DO 128 MB JS heap (routing) + Container 256 MiB-12 GiB+ memory (workload) are SEPARATE envelopes (reference only — NOT a Nimbus path) |
| "Containers solve Bug C trivially" | ✓ True at the architectural level, but adopting them is out of charter (Nimbus is DO-only emulation; emulating Cloudchamber is the point) |
| "Sandbox SDK exists" | ✓ CONFIRMED — `@cloudflare/sandbox` wraps the pattern Nimbus emulates in JS without |

**Plan §3 implications**:
- Plan §3 / §5 reference Cloudflare Containers as a primitive that
  exists at the platform level. Nimbus deliberately does NOT adopt
  it — the project's identity ("DO-only emulation of a
  Linux-container dev environment") makes Cloudchamber adoption
  out-of-charter, not just out-of-this-plan.
- Track A' is the ONLY substrate Nimbus uses. The "are we choosing
  to stay in workerd-isolate or do we have to" question has a clean
  answer: choosing. The project's value is in the choice.
- The user's question "is supervisor at 64 MiB the right ceiling
  or should we shed supervisor and orchestrate peer DOs?" gets a
  cleaner answer: within Nimbus's DO-only charter, "minimize
  supervisor resident set, fan to dynamic Workers" is the path.
  Shedding the supervisor for a container substrate is what
  Cloudflare Containers does — and that's a different product,
  not Nimbus.

---

## R5.9 Open follow-ups

⚠ UNVERIFIED:
- Whether the Container DO's 128 MB JS heap can co-tenant with
  other DOs of the same script (R1.1's same-class-cohort risk
  applies here too).
- Whether running multiple containers per supervisor (e.g. one
  container per user session, all routed through one Worker) hits
  any account-wide quota faster than vanilla DOs.

These don't gate plan §3 because we're NOT migrating to Containers.
But they should be resolved if the strategic decision later changes.
