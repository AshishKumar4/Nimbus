# Section I — CF projects similar to Nimbus

> Researched against `wiki.cfdata.org` (Sandbox SDK, Containers, Browser Rendering, Workers for Platforms, Code Mode), `developers.cloudflare.com`. Nimbus HEAD `e93b18d`. Every claim cited.

---

## TL;DR — sibling-products mapping

| CF project | Status | Pattern Nimbus could borrow | Contact |
|---|---|---|---|
| **Sandbox SDK** | Beta | Three-layer Workers→DO→Container model; first-class binding (npmjs.com/@cloudflare/sandbox); preview-URL exposure pattern | [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch), [`~naresh`](https://wiki.cfdata.org/display/~naresh) |
| **Containers (Cloudchamber)** | Beta, Spring 2026 GA | 4 GB RAM / 4 GB disk / half-CPU container as escape hatch for workerd-blocked features (child_process, vm, .node dlopen) | [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch) (PM); [`~thomasc`](https://wiki.cfdata.org/display/~thomasc) (CC team) |
| **Code Mode (`@cloudflare/codemode`)** | GA via npm | Tool-call-as-code pattern using LOADER.get(); Nimbus is structurally a Code-Mode-style consumer | Code Mode team (Workers AI / Agents) |
| **Browser Rendering API** | GA | CDP endpoint as universal-protocol exposure pattern; 32 MiB WS frame size unblocked CDP proxy | [`~rfigueira`](https://wiki.cfdata.org/display/~rfigueira), Browser Rendering team |
| **Workers for Platforms (Dispatcher)** | GA | Mature multi-tenant code execution; the path WfP is taking to migrate onto Worker Loader is the future Nimbus should align with | [`~dkozlov` Dina Kozlov](https://wiki.cfdata.org/display/~dkozlov) |
| **OpenCode Worker** (community) | Workspace clone | Already running OpenCode on Workers + DOs; uses same shape Nimbus uses | [`~karishnu`](https://wiki.cfdata.org/spaces/~karishnu/pages/1386224119/OpenCode+Worker+%E2%80%94+AI+Coding+Agent+on+Cloudflare+s+Edge) (community contributor at CF) |
| **Pyodide / Python Workers** | GA (Python Workers) | Two-layer (package bundle + lockfile in R2) is exactly the npm-mirror pattern recommended in §D | Python Workers team |
| **AI Sandbox / Workers AI** | GA inference | Use Sandbox for code interpretation in Workers AI integrations | Workers AI team |
| **Vibe Coding / Lovable / Mossaic** | External | The biggest target customer category for Sandbox SDK; partial overlap with Nimbus's market | n/a |

The single most-important sibling is **Sandbox SDK**. It's directly competitive with Nimbus's positioning and on the same architectural arc. Nimbus should formally align with Sandbox SDK's roadmap — file the Lever B4 Trust & Safety question against Sandbox SDK's solution.

---

## I.1 Sandbox SDK — the closest sibling

### I.1.1 What it is

[`~agillie/[KB] Workload: Agents and Sandboxing`](https://wiki.cfdata.org/spaces/~agillie/pages/1386221284/KB+Workload+Agents+and+Sandboxing):

> *"**Sandbox SDK** (Beta) — A programmable sandbox API built on Containers. Called from any Worker via `getSandbox(env.Sandbox, 'user-id')`. Provides a TypeScript API for executing commands, managing files, running background processes, and exposing services. Three-layer architecture: Workers → Durable Objects → Containers. Ideal for AI code interpreters, dev environments, and data analysis platforms. PM: Mike Nomitch."*

[`~naresh/Sandbox SDK: first-class binding`](https://wiki.cfdata.org/display/~naresh/Sandbox+SDK%3A+first-class+binding):

> *"The current [Sandbox SDK](http://npmjs.com/package/@cloudflare/sandbox) operates as a library on top of [Containers]…"*

### I.1.2 Compare to Nimbus

| Property | Sandbox SDK | Nimbus |
|---|---|---|
| Compute substrate | Container Workers (4 GB RAM, real Linux) | DO + LOADER facets (128 MiB, workerd) |
| Filesystem | Container's local fs (4 GB disk) | SQLite VFS in DO (10 GB) |
| Spawn pattern | `getSandbox(env.Sandbox, id)` | `LOADER.get('id', getCodeCallback)` |
| Cold start | ~7 s (Jupyter); pre-warming planned | ~10-100 ms (LOADER.get) |
| Run real Python/Node | ✅ via Jupyterlab | ⚠️ Workers Node-shim with workerd-blocked features per UNIVERSAL-NODE-COMPAT.md |
| Network | Real | Workers fetch + facet limits |
| Multi-tenant isolation | Per-container | Per-DO (shared isolate caveat per Section A) |
| Pricing | Container Workers SKU (per-GB-hour) | DO + Dynamic Workers SKU |
| Pre-warming | Manual today; pre-warmed images planned | n/a |
| Snapshot/persistence | n/a today; "biggest turning off points" per `~naresh` | Sessions persist via SQLite VFS — *Nimbus's clear advantage* |

### I.1.3 Pattern to borrow: first-class binding

[`~naresh/Sandbox SDK: first-class binding`](https://wiki.cfdata.org/display/~naresh/Sandbox+SDK%3A+first-class+binding):

> *"Every other Sandbox provider can be used via their SDKs from any platform the user could be using. But our container platform is currently only accessible from workers. By having a first-class binding, very similar to how Workers AI provides a binding as well as a REST API + SDK, we could offer a way for sandboxes to be spun up on Cloudflare regardless of the platform the end user is using."*

**Lever I1**: when Sandbox SDK ships its first-class binding, Nimbus could expose itself the same way:

```ts
// audit-only sketch — future integration shape
const session = env.NIMBUS.get('user-id');
await session.runCommand('npm install');
await session.writeFile('/index.js', 'console.log("hi")');
const result = await session.exec('node index.js');
```

Today this is partially expressed via Nimbus's `/api/*` routes and `/s/<id>/ws` WebSocket. A binding-shaped API is a natural complement.

### I.1.4 Pattern to borrow: pain points list

[`~naresh/Q1 & Q2 2026: Sandbox SDK`](https://wiki.cfdata.org/pages/viewpage.action?pageId=1331846617) lists Sandbox SDK's roadmap pain points. Several apply 1:1 to Nimbus:

> *"The lack of a native snapshotting/persistence story is easily the biggest turning off points for users - the primary usecase seems to be vibe coding, where the agent starts working on a codebase and after long delays still be able to pick up from the same point."*

✅ **Nimbus already does this** — VFS persists across sessions, processes survive disconnect (per [`README.md`](../../README.md) §Status).

> *"Treating sandboxes as a zero trust environment (not to be confused with our ZT product - I just mean treating any secret sent into the sandbox as exfiltrated) is still non-trivial, and a common solution is to have a worker proxy."*

⚠️ Nimbus has the same problem; user shells can `curl` arbitrary URLs. No ZT integration today.

> *"Cold start times keep coming up and on a 1-1 basis, we recommend pre-warming. But it feels like an ad-hoc solution at this point."*

Nimbus's facet-pool already handles this — keeps long-lived facets warm. Section B Lever B1 extends to all facets.

> *"Defining base images dynamically comes up as a recurring problem"*

n/a for Nimbus — VFS+facet model has no "image."

> *"Right now, it's non-trivial to provide sandboxes as an extension/tool that can be accessed by agents running on workers or other runtimes"*

This is the AI-tool integration problem. Section I.4 covers it.

### I.1.5 Action

**File a wiki comment** on `~naresh/Sandbox SDK: first-class binding` introducing Nimbus and asking:
- Is there a path for non-Container-based "sandboxes" (Nimbus is DO+facet) to use the same first-class binding?
- Can Sandbox SDK and Nimbus share the same Trust & Safety story (Lever B4 from Section B)?

Contact: [`~naresh`](https://wiki.cfdata.org/display/~naresh) and [`~mnomitch`](https://wiki.cfdata.org/display/~mnomitch).

---

## I.2 Containers / Cloudchamber

Section H.3 covers the GA timeline. Patterns:

### I.2.1 The Mike-Nomitch model: integrate, don't compete

[CC/The road to Containers on the Developer Platform](https://wiki.cfdata.org/pages/viewpage.action?pageId=1072726833):

> *"Our team's goal is to enable a wide variety of the workloads on the edge via containerized applications."*
>
> *"These users ideally have most of their application working and written on Workers, but call to a container for this specific bit of functionality. This is in contrast to users who might want a general-purpose container platform for hosting full applications."*

This is exactly the right fit for Nimbus: **most user code runs in workerd (cheap, fast); workerd-blocked code runs in a Container.** Section H.3.2 sketches the hybrid architecture.

### I.2.2 First two customers — interesting overlap

[Developer Platform/This week in Cloudchamber: 2025-03-28 edition](https://wiki.cfdata.org/pages/viewpage.action?pageId=1136523234):

> *"Langbase: They want to run AI code in sandboxes - Using Fly Machines for CI/CD but this adds a lot of latency. CI/CD builds is one use case. They linked to E2Bs sandbox docs as a source of good inspiration."*

⚠️ Langbase + Nimbus are *adjacent customers*. Worth following up.

### I.2.3 Action

When Container Workers GAs (Spring 2026), implement Section H.3.2 hybrid integration. Until then, document the long-tail of `node` user code that's currently failing under UNIVERSAL-NODE-COMPAT.md §07 (the 17 platform-blocked items) as "containerizable."

---

## I.3 Code Mode (`@cloudflare/codemode`)

[Cloudflare changelog 2026-02-20: codemode SDK rewrite](https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/):

```ts
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { streamText } from "ai";

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const codemode = createCodeTool({ tools: myTools, executor });
```

[`Pricing Memorandum: Dynamic Workers`](https://wiki.cfdata.org/spaces/PRICE/pages/1361771847/Pricing+Memorandum+Dynamic+Workers):

> *"Code Mode for AI Agents: LLMs are increasingly writing code to execute logic rather than orchestrating inefficient tool calls. This reduces token usage and latency, but requires a secure, instant sandbox to run that code."*

### I.3.1 Pattern: Code Mode is the underlying primitive

Nimbus is conceptually a *Code Mode consumer*: it runs LLM-generated (or user-typed) code in a LOADER.get sandbox. The `@cloudflare/codemode` SDK is the Cloudflare-blessed way to do this. ⚠️ speculation: Nimbus could re-implement its facet manager on top of `@cloudflare/codemode` and inherit improvements (eg. AI-graph integration, tool-call routing) for free.

### I.3.2 Action

Audit Code Mode SDK code shape. Determine if `DynamicWorkerExecutor` is a thin wrapper over LOADER.get that Nimbus could substitute for `src/facet-manager.ts`. Effort: M.

---

## I.4 Browser Rendering API

### I.4.1 Pattern to borrow: CDP endpoint

[BRAPI/PRD: CDP Endpoint](https://wiki.cfdata.org/spaces/BRAPI/pages/1361741267/PRD+CDP+Endpoint):

> *"Browser Rendering requires customers who want to run full, multi-step browser automations to use Cloudflare Workers in order to use Puppeteer and Playwright. This blocks adoption for customers who don't want to rewrite their code to run on Workers."*

> *"Why now: Technical blocker removed - Workers no longer have the WebSocket chunking limitation that previously prevented CDP proxy implementation (WebSockets now support 32 MB messages)"*

So Browser Rendering shipped a *protocol-native* WS endpoint that any CDP client (Puppeteer, Playwright, Claude Code, OpenClaw) connects to **without writing a Worker.**

### I.4.2 Apply to Nimbus

The same pattern: Nimbus exposes a *protocol-native* shell-over-WS endpoint that any tool can connect to. Today's `/s/<id>/ws` is *the right shape*; the gap is documentation + standardization (e.g. SSH-over-WS protocol, or LSP-over-WS for editor integration).

### I.4.3 Pattern: MCP integration

[BRAPI/Testing Browser Rendering CDP](https://wiki.cfdata.org/spaces/BRAPI/pages/1354214192/Testing+Browser+Rendering+CDP):

```js
{
  "mcp": {
    "browser-rendering-cdp": {
      "type": "local",
      "command": [
        "npx", "-y", "chrome-devtools-mcp@latest",
        "--wsEndpoint=wss://api.cloudflare.com/...",
      ]
    }
  }
}
```

Nimbus could ship an `@cloudflare/nimbus-mcp` MCP server that lets Claude Code / Cursor / OpenCode use a Nimbus session as a tool:

```js
// audit-only sketch
{
  "mcp": {
    "nimbus": {
      "command": ["npx", "-y", "@cloudflare/nimbus-mcp@latest",
        "--sessionId=<NIMBUS_SESSION_ID>",
        "--apiToken=<TOKEN>"],
    }
  }
}
```

### I.4.4 Action

Lever I4: ship `@cloudflare/nimbus-mcp` as a public package mirroring `chrome-devtools-mcp`. Effort: M.

---

## I.5 Workers for Platforms (Dispatcher)

### I.5.1 The migration arc

[`~dkozlov/Powering Dispatcher with a Worker Loader`](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731/Powering+Dispatcher+with+a+Worker+Loader+%E2%80%94%C2%A0step+1+feature+parity+with+WFP) details how WfP is migrating onto Worker Loader. Three relevant patterns:

1. **`outbound` worker per dispatch** — WfP wraps outbound traffic with a customer-defined handler. Nimbus equivalent: per-tenant outbound rate limit / audit.

2. **`tags` array** for per-isolate metadata:

   ```ts
   const worker = env.LOADER.get("worker-id", async () => ({
     mainModule: "worker.js",
     modules: { "worker.js": code },
     env: { /* bindings */ },
     tags: ["customer-123", "pro-plan", "production"],
   }));
   ```

   ⚠️ Status: WfP needs this; not in Worker Loader yet. Per Section B Lever B6.

3. **Custom limits per isolate** (CPU-ms, subrequests):

   ```ts
   limits: { cpuMs: customerLimits.cpuMs, subrequests: customerLimits.subrequests }
   ```

   Per [`~dkozlov`](https://wiki.cfdata.org/spaces/~dkozlov/pages/1357511731): *"Worker Loader needs to support custom limits (EW-10547)."*

### I.5.2 What to track

[EW-10547](https://jira.cfdata.org/browse/EW-10547) (Worker Loader custom limits) — when this lands, Nimbus can apply per-tenant limits without script-side enforcement. Useful for free-tier vs paid-tier differentiation.

### I.5.3 Pattern: WfP/`Dispatcher` billing fields

> *"hasDispatcher = 1 OR isNotNull(dispatcherID) — these fields are set by the runtime and flow through the data pipeline"*

Nimbus is **not currently treated as a dispatcher.** Worth checking: does Nimbus's Dynamic Workers Created Daily count get attributed correctly? See Section G Lever G5.

---

## I.6 OpenCode Worker — community sibling

[`~karishnu/OpenCode Worker — AI Coding Agent on Cloudflare's Edge`](https://wiki.cfdata.org/spaces/~karishnu/pages/1386224119/OpenCode+Worker+%E2%80%94+AI+Coding+Agent+on+Cloudflare+s+Edge):

> *"OpenCode Worker takes the open-source OpenCode AI coding agent and runs it entirely on Cloudflare Workers — no servers, no VMs, no containers. Sessions, filesystems, git repos, and live deployment previews all live inside Durable Objects at the edge."*

This is **literally the same architecture as Nimbus**. The repo at `github.com/karishnu/opencode-worker` adapts the OpenCode TUI client to talk to a DO-backed agent space.

Pattern to borrow:
- *"Each workspace is an isolated **Agent Space** — a Durable Object with its own SQLite-backed filesystem and git repo, completely disconnected from any host machine."*
- *"`bash` tool returns an error stub. The agent can't `curl` your metadata endpoint, can't install packages globally, can't spawn processes."*

Nimbus could **integrate with OpenCode** as a remote agent space target. Same shape; Nimbus would be the substrate that OpenCode's TUI talks to.

### I.6.1 Action

Reach out to [`~karishnu`](https://wiki.cfdata.org/display/~karishnu) — likely a useful conversation about overlap. Could also be that OpenCode Worker becomes a customer of Nimbus's hosted version, depending on positioning.

---

## I.7 Pyodide / Python Workers

[EW/SPEC: Python Workers Package Bundling System](https://wiki.cfdata.org/display/EW/SPEC%3A+Python+Workers+Package+Bundling+System) — covered in Section D.

The pattern (R2-bucket of wheels + lockfile + runtime mount) is the *exact* pattern Nimbus should adopt for npm. Section D Levers D1, D2, D4 cover.

---

## I.8 EW-* tickets that would unblock Nimbus

A list of Jira tickets cross-referenced from the wiki research above:

| Ticket | What it would unblock |
|---|---|
| [EW-9653](https://jira.cfdata.org/browse/EW-9653) | "Log content of dynamically loaded isolate script to internal logs" — Section B.6 abuse detection visibility |
| [EW-9655](https://jira.cfdata.org/browse/EW-9655) | "Write dynamic isolate code to storage" — same |
| [EW-9656](https://jira.cfdata.org/browse/EW-9656) | "Add mechanism for killing dynamic isolates (and optionally its parent)" — Trust & Safety integration for Section B.6 |
| [EW-10547](https://jira.cfdata.org/browse/EW-10547) | Worker Loader custom limits — Section I.5 |
| [EW-5707](https://jira.cfdata.org/browse/EW-5707) (referenced) | Concurrent connection limit (6) — Section B.2 |
| [EW-6044](https://jira.cfdata.org/browse/EW-6044) (referenced) | Memory limit error path — Section A |
| [SHIP-3841](https://jira.cfdata.org/browse/SHIP-3841) | "We eventually will want to support more memory for certain larger use cases" — Section A.1 dedicated isolate / memory tiers |
| [SHIP-10537](https://jira.cfdata.org/browse/SHIP-10537) | "Container is accessible via a Durable Object" — Section H.3 hybrid integration |
| [SHIP-11171](https://jira.cfdata.org/browse/SHIP-11171) | ContainerWorker JS Class — same |
| [SHIP-11173](https://jira.cfdata.org/browse/SHIP-11173) | Accessible Logs (Container) — same |
| [SHIP-11174](https://jira.cfdata.org/browse/SHIP-11174) | Accessible Metrics (Container) — same |
| [WR-1069](https://jira.cfdata.org/browse/WR-1069) | OpenTelemetry tracing for Waiting Room (DO) — Section F Lever F6 reference pattern |
| [INCIDENT-7730](https://jira.cfdata.org/browse/INCIDENT-7730) (referenced) | Billing exploit — useful as motivation for Section B.6 abuse handling |

---

## I.9 Citations summary

Wiki:
- ~agillie/[KB] Workload: Agents and Sandboxing (the canonical product-mapping table)
- ~naresh/Sandbox SDK: first-class binding
- ~naresh/Q1 & Q2 2026: Sandbox SDK
- ~mnomitch/Interacting with Container and Sandbox instances
- CC/The road to Containers on the Developer Platform
- CC/Containers - Internal FAQ
- Developer Platform/This week in Cloudchamber: 2025-03-28 edition (first customer stories)
- BRAPI/PRD: CDP Endpoint
- BRAPI/Testing Browser Rendering CDP
- BRAPI/Browser Rendering Agents Week Rename
- ~dkozlov/Powering Dispatcher with a Worker Loader (3 patterns: outbound, tags, custom limits)
- ~jwheeler/WfP & Dynamic Workers: Exploring the Path Forward
- ~karishnu/OpenCode Worker — AI Coding Agent on Cloudflare's Edge
- ~howard/AI Agents & Sandboxing for Developers
- EW/SPEC: Python Workers Package Bundling System
- EW/SPEC: Deploy Python code directly to Workers
- pages/viewpage.action?pageId=1327289817 (1000 popular npm Packages on Workers)

Public docs / changelog / npm:
- developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/
- developers.cloudflare.com/agents/api-reference/codemode/
- npmjs.com/@cloudflare/sandbox
- npmjs.com/@cloudflare/codemode
- npmjs.com/@cloudflare/containers

Nimbus src/ citations:
- `src/facet-manager.ts` — could be re-implemented on `@cloudflare/codemode`'s `DynamicWorkerExecutor`
- `src/sqlite-vfs.ts` — Nimbus's snapshotting/persistence story (Sandbox SDK's biggest pain point)
- `src/nimbus-session.ts:1160` — shell-over-WS endpoint (the Browser-Rendering-CDP pattern)
- `README.md` §What is Nimbus? — positioning vs WebContainers; same neighborhood as Sandbox SDK
