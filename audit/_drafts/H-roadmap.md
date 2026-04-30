# Section H — Roadmap / Future-ahead

> Researched against `wiki.cfdata.org` (STOR / EW / CC / Pricing) and `developers.cloudflare.com/changelog/`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — CF roadmap items affecting Nimbus, ranked by impact

| # | CF item | Status | Owner / Channel | What it unblocks for Nimbus | Effort to integrate |
|---|---|---|---|---|---|
| **H1** | DO read replicas (multi-region reads) | Beta — quick-start exists; pricing TBD; D1's beta is the customer-zero | [`~lambros` / Storage](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API) | Cross-region preview-read latency: 200 ms → 5-20 ms | M (refactor write paths; gated on pricing) |
| **H2** | SQLITE_NOMEM SPEC implementation (per-DO SQLite memory accounting) | Implementation MRs linked, ~2026-Q1; merge status TBC | [`~jhoward` / Storage](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues) | Replace silent DO termination with catchable `SQLITE_NOMEM` | S (catch + retry pattern; Section A Lever A3) |
| **H3** | Container Workers GA | Spring 2026 (per CC FAQ) | [`~mnomitch` / Cloudchamber](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ) | Replaces facets entirely for compute-heavy work; `node` user code could run in container instead of LOADER.get-bound facet | L (architectural change — Nimbus's whole facet model could be containerised) |
| **H4** | Outgoing WebSocket Hibernation | Draft RFC; no GA timeline | [`~harris` / Storage](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) | Supervisor can hibernate during long-running outbound WS (e.g. nimbus-wrangler) | S (await RFC GA) |
| **H5** | Dynamic Workers Observability | Draft RFC; no GA timeline | [`~birvine-broque`](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) | Free per-facet logs/traces; lets us delete `process-logs.ts` | S (observability config; Section F Lever F5) |
| **H6** | Dynamic Worker Sharding | RFC; explicitly excludes ephemeral facets today | [`~pkhanna`](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) | Hot facet on metal A absorbs load from metal B | M (depends on whether Nimbus's long-lived facets qualify as non-ephemeral) |
| **H7** | Dedicated-isolate namespace flag | Internal-only; gated on price/SPEC decisions | [`~gmckeon` / Storage](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) | Eliminates noisy-neighbour OOMs; guaranteed 128 MiB | S (compat-flag once on allowlist) |
| **H8** | Memory pressure notification API | Wishlist (Mini-PRD item 4.iii) | Storage team | Lets Nimbus react to "you're about to be condemned" before condemnation | S (wire-up once API ships) |
| **H9** | Script size limit hike (5MB → 10MB → ?) | 5→10MB landed; further bumps speculative | [`~birvine-broque`](https://wiki.cfdata.org/display/~birvine-broque/Mini-PRD%3A+Rationalizing+default+Worker+limits) | Affects static-script, not LOADER; unblocks static-bundle inlining if Nimbus ever needs it | XS |
| **H10** | Runtime-injected polyfill bundling (Snell's Mini-Spec) | Draft | [`~jsnell`](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) | Saves ~12-20 MiB encoded budget per facet load | M (gated; Section B Lever B3) |
| **H11** | DO multi-region (multi-master) | No SPEC found; speculative | Storage | Current multi-replica is replicas; full multi-master is far-future | n/a (track only) |
| **H12** | Smart Placement for DOs | Adjacent — current Smart Placement is Workers-only | Workers team | DO doesn't move; the gateway Worker can be Smart-Placed (Section G Lever G4) | n/a |
| **H13** | Worker Loader Observability GA (`worker_loaders[].observability`) | Same as H5 | Same | Same | Same |
| **H14** | WebSocket message size: 1 MiB → 32 MiB (already shipped Oct 2025) | GA | Workers team | Bigger HMR / preview payloads; bigger streaming tracts | XS — verify already enabled |

H1, H2, H3, H7 are the highest-impact-when-shipped. H7 is a polite ask away (file with `~gmckeon`). H2 is the most-imminent-to-action.

---

## H.1 DO read replicas

[STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API) — full spec for the API ([Section G.4 covers integration](#)).

> *"Users should be able to enable replicas for individual Durable Objects, and not only at the namespace level. Useful for gradual or selective enablement of read replication (like what D1 did)."*
>
> *"Existing Durable Objects functionality should continue working as currently."*

D1's read-replication beta is the customer zero ([blog post linked in `~lambros/Feedback`](https://blog.cloudflare.com/d1-read-replication-beta/)). API in Nimbus terms:

```ts
// In NimbusSession constructor
ctx.blockConcurrencyWhile(async () => {
  if (!ctx.storage.primaryStub) {
    if (this.shouldEnableReplicas()) {
      await ctx.storage.configureReadReplication({ mode: "auto" });
    }
  }
});
```

### H.1.1 GA timeline

[Quick Start](https://wiki.cfdata.org/spaces/STOR/pages/1110730702/Durable+Objects+Replication+Quick+Start) is marked "Unstable APIs," but functionally usable. ⚠️ speculation: GA likely 2026-H2 once D1 bookmarks API + replica pricing land. Track [STOR-4146 (parent)](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API).

### H.1.2 Partner team

- Storage (Justin / `~lambros`) for the API itself
- D1 team (Krysten Gillett — quoted in MOSSAIC reference) for production-load lessons learned

### H.1.3 Nimbus integration

When GA: implement Section G Lever G3 (write-forwarder + bookmarks API). One-time refactor: every write path in NimbusSession needs an `if (this.isReplica()) return this.ctx.storage.primary.method(...)` shim.

---

## H.2 SQLITE_NOMEM SPEC

[STOR/SPEC: Address SQLITE_NOMEM issues](https://wiki.cfdata.org/spaces/STOR/pages/1372567129/SPEC+Address+SQLITE_NOMEM+issues) — Josh Howard's SPEC, 2026-03-20, edits through 2026-03-26.

Implementation MRs linked:
- [edgeworker MR 12773](https://gitlab.cfdata.org/cloudflare/ew/edgeworker/-/merge_requests/12773)
- [workerd PR 6380](https://github.com/cloudflare/workerd/pull/6380)

⚠️ Status verification: visit those links to confirm merge status. The wiki page hasn't been edited in ~4 weeks; assume implementation is at least in-progress.

### H.2.1 What ships

- Per-DO SQLite memory accounting (separate pool, separate cap)
- Process-wide hard limit raised to 8 GiB (defense-in-depth)
- SQL limits relaxed (column count 100→2000, expression depth 100→1000, VDBE op 25k→250M)

### H.2.2 Nimbus impact

- **Failure mode changes from "DO killswitched silently" to "JS exception thrown."** Catch with try/catch (Section A Lever A3).
- Higher process-wide cap → less noisy-neighbour interference (your install no longer hangs because Tenant N two metals over OOMed SQLite).

### H.2.3 Partner team

[`~jhoward` Josh Howard](https://wiki.cfdata.org/display/~jhoward) is the doc author. Storage team channel.

---

## H.3 Container Workers GA

[CC/Containers - Internal FAQ](https://wiki.cfdata.org/display/CC/Containers+-+Internal+FAQ):

> *"Is this GA? → Not yet. When will it be GA → Spring 2026."*

[CC/The road to Containers on the Developer Platform](https://wiki.cfdata.org/pages/viewpage.action?pageId=1072726833) gives the milestones:

> *"Milestone 1: Internal Testers on the initial Workers Binding - Date: 2025-02-15"*
> *"Milestone 2: External Testers on the initial Workers Binding - Date: 2025-03-15"*

Plus default container limits per [`~agillie/[KB] Workload: Agents and Sandboxing`](https://wiki.cfdata.org/spaces/~agillie/pages/1386221284/KB+Workload+Agents+and+Sandboxing):

> *"**Containers** (Beta) — Full ephemeral Linux environments. Maximum control over lifecycle and environment. 4 GB memory, 4 GB disk, half CPU core (default limits — can be raised for enterprise). Ideal for CI/CD, compilation, full-environment sandboxing."*

### H.3.1 Why it matters for Nimbus

The current Nimbus `node` runner runs JS code in a LOADER.get facet. Limitations imposed by workerd (no `child_process`, no `.node` dlopen, no real `vm`, etc., per [`audit/UNIVERSAL-NODE-COMPAT.md`](../UNIVERSAL-NODE-COMPAT.md)) are unfixable inside workerd. Container Workers offer:

- **4 GB memory** vs 128 MiB
- **Native Linux** (real `child_process`, real fs, real vm)
- **Half CPU core** sustained vs 30s budget per request
- **Native Node.js** (not the workerd-shim, the actual `node` binary)

This is the *escape hatch* for the ~5% irreducible workerd-blocked surface (Section 07 of UNIVERSAL-NODE-COMPAT.md).

### H.3.2 Nimbus integration model

Hybrid: keep the `npm install`, `vite-dev`, `git` flows on facets (cheap, fast cold-start). Route user `node script.js` to Container Workers when:
- The user code requires a workerd-blocked feature (detected by static analysis or by the failure)
- The user explicitly asks (e.g. `node --container script.js`)

Architecture:

```
┌─ NimbusSession DO (supervisor)
│  ├─ shell + VFS + npm + git + vite (today's shape, unchanged)
│  └─ Container Worker binding ──────► one ephemeral container per node-script
                                       (mount VFS via R2 sync? new Container Worker
                                       primitives — see [~naresh/Sandbox SDK: first-class binding])
```

⚠️ Big architectural decision: cold-start container vs facet. Containers have minutes-of-cold-start in v1 (no snapshotting yet). Facets have ~10-100ms cold-start. For 90% of `node` invocations, facets remain the right answer. Containers for the long tail.

### H.3.3 Partner team

[`~mnomitch` Mike Nomitch](https://wiki.cfdata.org/display/~mnomitch) (PM, Sandbox SDK + Containers).

---

## H.4 Outgoing WebSocket Hibernation

[STOR/RFC: Outgoing WebSocket Hibernation: Design Options](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) — Section C covers the technical detail.

### H.4.1 GA timeline

Draft RFC. No SHIP ticket linked. ⚠️ speculation: 2026-H2 at earliest. Layer A (sandbox-side reuse) is "we have the patterns"; Layer B (supervisor liveness) is "new mechanism, needs review."

### H.4.2 Nimbus integration

Section C Lever C5 covers it. Audit Nimbus's outbound WS usage when RFC ships.

### H.4.3 Partner team

[`~harris`](https://wiki.cfdata.org/display/~harris) Storage; document author per the WS Primer.

---

## H.5 Dynamic Workers Observability

[~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability). Section B Lever B2 / Section F Lever F5 covers integration.

### H.5.1 GA timeline

Draft RFC. ⚠️ speculation: 2026-H2.

### H.5.2 Partner team

[`~birvine-broque` Brendan Irvine-Broque](https://wiki.cfdata.org/display/~birvine-broque).

---

## H.6 Dynamic Worker Sharding

[~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding):

> *"Ephemeral dynamic workers & facets are excluded from this implementation."*

⚠️ open question: do Nimbus's *long-lived* facets (resolver, install-batch, vite-dev) qualify as non-ephemeral? Pull thread with author.

### H.6.1 Partner

[`~pkhanna` Pratham Khanna](https://wiki.cfdata.org/display/~pkhanna).

---

## H.7 Dedicated-isolate namespace flag

[STOR/Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) item 4. Section A.1.3 covers integration.

### H.7.1 Partner

[`~gmckeon` Greg McKeon](https://wiki.cfdata.org/display/~gmckeon).

### H.7.2 Action

File a request with `~gmckeon` and Storage chat to be on the dedicated-isolate allowlist. Brief case: "single-script deployment, one DO class, willing to pay premium." See Section A Lever A4.

---

## H.8 Memory pressure notification API

[Mini-PRD: DO shared isolate issues](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) item 4.iii — wishlist. ⚠️ no SPEC page, no jira linked. Track by watching the Mini-PRD for updates.

### H.8.1 Partner

Storage team broadly.

---

## H.9 Script size limit

[~birvine-broque/Mini-PRD: Rationalizing default Worker limits](https://wiki.cfdata.org/display/~birvine-broque/Mini-PRD%3A+Rationalizing+default+Worker+limits):

> *"The default script size limit is changed from 5MB to 10MB"*

This is the **static script upload limit**, not the LOADER.get byte budget. For Nimbus, the binding constraint is the 22 MiB BUNDLE_MAX_ENCODED_BYTES self-imposed cap (Section B Lever B3) plus the 32 MiB structured-clone cap (Section E). Static-script size doesn't directly apply to facet bundles loaded via LOADER.

⚠️ Track for the case where Nimbus wants to ship a static fallback script.

---

## H.10 Runtime-injected polyfills

[~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) — Section B Lever B3 covers integration.

### H.10.1 Partner

[`~jsnell` James Snell](https://wiki.cfdata.org/display/~jsnell).

---

## H.11 DO multi-region (multi-master)

⚠️ No SPEC found. The currently-shipping "multi-replica DO" ([STOR/SPEC: Durable Objects read replication API §Glossary](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API)):

> *"**Multi-replica DO** (SPEC: Multi-replica objects). This is an internal special DO version used by R2 and has nothing to do with this SPEC, since it's not going to have the read replication discussed here."*

Multi-master would be a *write*-side replica. ⚠️ speculation: years out, if ever. Nimbus's write-heavy workload (npm install) doesn't need it; a primary in-region with replicas is sufficient.

---

## H.12 Smart Placement for DOs

[Smart Placement docs](https://developers.cloudflare.com/workers/configuration/placement/) only apply to Workers. ⚠️ DOs don't move once placed. Section A.1 covers placement guidance.

The `locationHint` API at first-`get()` is the closest equivalent. See MOSSAIC reference §6.

---

## H.13 Worker Loader Observability GA

Same as H.5. Watching the same RFC.

---

## H.14 WebSocket message size

[2025-10-31 changelog](https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit/) (referenced in [Browser Rendering CDP PRD](https://wiki.cfdata.org/spaces/BRAPI/pages/1361741267/PRD+CDP+Endpoint)):

> *"WebSockets now support 32 MB messages"*

So the 32 MiB cap that bound RPC messages is **also** the WS frame cap. Nimbus's HMR fan-out in `cirrus-real.ts` should benefit; verify by checking if anything was being chunked-around-1MB previously.

---

## H.15 Watch list — single source of truth

| Item | Wiki / Jira to watch | Action when SHIP-* lands |
|---|---|---|
| H1 (read replicas) | [STOR/SPEC: Durable Objects read replication API](https://wiki.cfdata.org/display/STOR/SPEC%3A+Durable+Objects+read+replication+API) | Implement Section G Lever G3 |
| H2 (SQLITE_NOMEM) | edgeworker MR 12773; workerd PR 6380 | Implement Section A Lever A3 |
| H3 (Container Workers GA) | [CC/The road to Containers](https://wiki.cfdata.org/pages/viewpage.action?pageId=1072726833) | Hybrid integration plan; new Container Worker binding |
| H4 (Outgoing WS hib) | [STOR/RFC: Outgoing WS Hibernation](https://wiki.cfdata.org/spaces/STOR/pages/1372567047/RFC+Outgoing+WebSocket+Hibernation+Design+Options) | Section C Lever C5 |
| H5 (Dynamic Workers Obs) | [~birvine-broque/[RFC] Dynamic Workers Observability](https://wiki.cfdata.org/spaces/~birvine-broque/pages/1365394169/RFC+Dynamic+Workers+Observability) | Section B Lever B2 |
| H6 (Sharding) | [~pkhanna/Dynamic worker sharding](https://wiki.cfdata.org/spaces/~pkhanna/pages/1387665545/Dynamic+worker+sharding) | Audit if Nimbus facets qualify |
| H7 (Dedicated isolate) | [STOR/Mini-PRD](https://wiki.cfdata.org/display/STOR/Mini-PRD%3A+DO+shared+isolate+issues) — file ask now | Section A Lever A4 |
| H8 (Memory pressure API) | Same Mini-PRD | Section A Lever A5 |
| H10 (Polyfill bundling) | [~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling](https://wiki.cfdata.org/pages/viewpage.action?pageId=868863065) | Section B Lever B3 |

---

## H.16 Citations summary

Wiki:
- STOR/SPEC: Durable Objects read replication API
- STOR/Durable Objects Replication Quick Start
- STOR/SPEC: Address SQLITE_NOMEM issues
- STOR/Mini-PRD: DO shared isolate issues
- STOR/RFC: Outgoing WebSocket Hibernation: Design Options
- ~birvine-broque/[RFC] Dynamic Workers Observability
- ~birvine-broque/Mini-PRD: Rationalizing default Worker limits
- ~birvine-broque/WASM Memory limits
- ~pkhanna/Dynamic worker sharding
- ~jsnell/Mini-Spec: Node.js-compat + Polyfill Bundling
- ~jsnell/Import polyfills/scripts
- ~lambros/Feedback for DO read replication API based on D1 read replication beta
- CC/The road to Containers on the Developer Platform
- CC/Containers - Internal FAQ
- ~agillie/[KB] Workload: Agents and Sandboxing
- ~mnomitch/Interacting with Container and Sandbox instances from the user's runtime
- BRAPI/PRD: CDP Endpoint (32 MiB WS frame size landed)

Public docs / changelog:
- developers.cloudflare.com/changelog/post/2025-03-22-smart-placement-stablization/
- developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit/

Nimbus src/ citations:
- `src/constants.ts:46` — BUNDLE_MAX_ENCODED_BYTES (impacted by H10)
- `src/sqlite-vfs.ts:150` — 128 MiB cap (impacted by H2/H7)
- `src/heavy-alloc-coord.ts` — natural integration site for H8
- `src/facet-manager.ts:537` — encoded budget impact (impacted by H10)
- `src/parallel/facet-pool.ts:514` — shared isolate cap (impacted by H7)
- `wrangler.jsonc:5` — compat date (impacted by replica_routing flag for H1)
