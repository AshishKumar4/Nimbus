<p align="center">
  <br />
  <img src="https://img.shields.io/badge/runtime-Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/storage-Durable_Objects_+_SQLite-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Durable Objects" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
</p>

<h1 align="center">Nimbus</h1>

<p align="center">
  <strong>A complete cloud development environment running on a single Cloudflare Durable Object.</strong>
  <br />
  Browser terminal. 10 GB persistent filesystem. npm, Node.js, Git, Vite, esbuild — all at the edge.
</p>

---

## What is Nimbus?

Nimbus is a browser-native Linux-like development environment that runs **entirely** on Cloudflare's edge infrastructure. A single Durable Object instance serves as both the operating system kernel and persistent storage layer, backed by a 10 GB SQLite virtual filesystem. Connect via WebSocket from any browser, and you get a full shell with 60+ Unix commands, an npm installer, a Node.js runtime, Git operations, and a Vite-compatible dev server — with zero local dependencies.

Think WebContainers, but running on Cloudflare's global network with real persistence across sessions.

## Built on LIFO OS

Nimbus stands on the shoulders of [**LIFO OS**](https://github.com/lifo-sh/lifo) — a pure-JavaScript, web-API-native Linux-like OS engine by [Sanket Sahu](https://github.com/sanketsahu) (MIT licensed). LIFO provided the kernel seed that made "a Unix shell inside a Worker" feasible in the first place. From there, Nimbus builds out the rest — storage, package management, Git, dev tooling, and the Cloudflare-native compute architecture — so you get a working cloud dev environment, not just a shell in a browser tab.

### What LIFO contributes

- **Shell interpreter** — bash-like lexer/parser/AST with pipes, redirects, operators, and job control
- **Coreutils** — 60+ commands (`ls`, `cat`, `grep`, `find`, `awk`, etc.) as pure JS `async function(ctx)` handlers
- **Web-API-native design** — "browser APIs as syscalls" (no WASM, no emulation) is what makes the whole stack fit inside a Durable Object
- **VFS shape** — the in-memory POSIX-like inode interface that Nimbus preserves while swapping the backing store
- **Node.js shim surface** — starting point for `fs`, `path`, `os`, `process` compatibility

### What Nimbus builds on top

| Subsystem | LIFO OS | Nimbus |
|-----------|---------|--------|
| **Storage** | In-memory inode tree + optional IndexedDB snapshot | **10 GB SQLite VFS** inside a Durable Object — demand-paged, LRU-cached, batched transactions, durable on every write (`src/sqlite-vfs.ts`) |
| **npm** | — | Production installer with content-addressed cache, pipelined resolution, bounded concurrency (`pLimit`), batched VFS writes, singleton fetch proxy (`src/npm-*.ts`) |
| **Module resolution** | Basic | Full Node compat — `exports` with conditions, subpath imports (`#foo`), legacy flat subpaths, `../` normalization |
| **Git** | — | [isomorphic-git](https://github.com/AshishKumar4/cf-git) (Cloudflare fork) inlined into a dedicated facet worker with pre-bundled runtime (`src/git-network-facet.ts`) |
| **Dev server** | — | In-process Vite-compatible server: esbuild-wasm transforms, `@/` aliases, Tailwind Play CDN (auto-skipped for real projects), SPA routing, auto-injected React Router basename, runtime error overlay (`src/vite-dev-server.ts`) |
| **Bundler** | — | `esbuild-wasm` with a VFS plugin for in-process transforms and dependency pre-bundling (shared React runtime — no duplicate instances across pre-bundled packages) |
| **Isolation model** | Single JS isolate | Supervisor DO + dynamic-worker facets via `LOADER` — heavy I/O (registry fetches, tarball decompression, git packfile work) runs in sandboxed isolates; storage stays with the supervisor (`src/facet-manager.ts`, `src/supervisor-rpc.ts`) |
| **IPC** | — | `WorkerEntrypoint` RPC with `ctx.exports` loopback between supervisor and facets |
| **Seed + UX** | — | Polished Vite + React + TS starter project seeded on first boot, auto-refreshing preview placeholders, install guard rails |

Remove `@lifo-sh/core` and the shell plus coreutils would break; everything else — SQLite VFS, npm installer, facet-based git, in-process dev server, preview UX, multi-session routing — is Nimbus's own work.

## Features

### Shell

- **60+ Unix coreutils** — `ls`, `cat`, `grep -r`, `find`, `tree`, `sed`, `awk`, `sort`, `diff`, `tar`, `gzip`, `curl`, and more
- **Full shell syntax** — pipes (`|`), redirects (`>`, `>>`), operators (`&&`, `||`, `;`), environment variable expansion, glob patterns, heredoc (`<<`)
- **Job control** — background processes, `ps`, `jobs`, `fg`, `bg`, `kill`

### npm

- **Production-grade installer** — pipelined dependency resolution, parallel tarball fetching, batched VFS writes
- **Content-addressed SQLite cache** — previously resolved versions and fetched tarballs are cached in-DO. Reinstalls complete in milliseconds with zero network requests
- **100+ dependency installs** — tested with Express, React, and other large dependency trees without hitting memory limits
- **Full lifecycle support** — `npm install`, `npm run`, `npm test`, `npm start`, `npm init`, `npm ls`

### Node.js

- **Real `require()` resolution** — bare specifiers, relative paths, scoped packages, subpath imports, `package.json` `exports`/`main`/`module` fields
- **Built-in module shims** — `fs`, `path`, `os`, `crypto`, `http`, `net`, `dns`, `zlib`, `stream`, `events`, `Buffer`, `child_process`, `util`, and more
- **TypeScript auto-transform** — `.ts` and `.tsx` files are transparently compiled via esbuild
- **Module caching** — with circular dependency handling

### Git

- **Full operations** — `clone`, `pull`, `push`, `commit`, `branch`, `checkout`, `merge`, `diff`, `log`, `tag`, `remote`, `fetch`, `reset`
- **Progress streaming** — clone and fetch progress displayed in real-time
- **Powered by isomorphic-git** — via a [Cloudflare-compatible fork](https://github.com/AshishKumar4/cf-git) with VFS adapter

### Vite Dev Server

- **In-process transforms** — JSX, TSX, TypeScript via esbuild-wasm
- **Path aliases** — `@/` resolves to project source root
- **CSS modules & Tailwind** — Play CDN injection, CSS module support
- **SPA routing** — `index.html` fallback for client-side routes
- **HMR-ready architecture** — file change events propagate from VFS to connected clients

### Developer Experience

- **Seeded starter project** — every fresh session boots with a polished Vite + React + TypeScript app at `~/app` (Tailwind, Framer Motion, Lucide, React Router) so you can `cd app && npm install && npm run dev` and see something immediately
- **Auto-injected basename** — React Router's `createBrowserRouter` and `<BrowserRouter>` pick up `basename: "/preview"` automatically, so real-world apps route correctly under the preview URL without config changes. Opt out with `// nimbus-no-basename` or `nimbusInjectBasename: false` in `vite.config`
- **Polished preview placeholder** — when no dev server is running, `/preview/` renders a dark-themed page with auto-reload polling. The moment `vite` starts, the preview flips to your app
- **Runtime error overlay** — uncaught errors, failed dynamic imports, or missing exports surface as a red banner in the preview with a Reload button and, when relevant, a `run npm install first` hint
- **Install guard rails** — `vite`, `next`, `webpack`, and similar bundlers (invoked directly or via `npm run …`) hard-fail with a clear error if `node_modules/` is missing. Override with `--force`

### esbuild

- **In-process bundling** — transforms and dependency pre-bundling via esbuild-wasm
- **VFS-aware resolver** — reads directly from the SQLite filesystem

### Filesystem

- **10 GB capacity** — SQLite-backed virtual filesystem inside a Durable Object
- **Demand-paged I/O** — 512-entry LRU cache with 64 KB pages (32 MB hot working set)
- **Transactional writes** — batched via `transactionSync()` with write throttling
- **Persistent across sessions** — data survives disconnects, deploys, and DO migrations

## Architecture

```
  Browser                        Cloudflare Edge
 ┌──────────────┐               ┌──────────────────────────────────────────┐
 │  xterm.js    │               │         NimbusSession (Durable Object)   │
 │  terminal    │◄──WebSocket──►│                                          │
 │              │               │  ┌─────────┐  ┌──────────┐  ┌────────┐  │
 │  Split-pane  │               │  │  Shell   │  │  VFS     │  │ SQLite │  │
 │  preview     │               │  │  60+ cmd │  │  10 GB   │──│ pages  │  │
 └──────┬───────┘               │  └────┬────┘  └────┬─────┘  └────────┘  │
        │                       │       │             │                    │
        │  /preview/* ─────────►│  ┌────┴─────────────┴──────────────┐     │
        │  /port/:n/* ─────────►│  │         SupervisorRPC           │     │
        │  /worker/*  ─────────►│  │  readFile · writeFile · stdout  │     │
        │                       │  │  transform · prefetch · ports   │     │
        │                       │  └────┬────────────────────────────┘     │
        │                       │       │                                  │
        │                       │  ┌────▼──────────────────────────────┐   │
        │                       │  │  Facets (Dynamic Workers / LOADER) │   │
        │                       │  │                                    │   │
        │                       │  │  ┌──────┐  ┌─────┐  ┌──────────┐ │   │
        │                       │  │  │ Node │  │ npm │  │ Vite Dev │ │   │
        │                       │  │  │ V8   │  │ pkg │  │ Server   │ │   │
        │                       │  │  └──────┘  └─────┘  └──────────┘ │   │
        │                       │  └───────────────────────────────────┘   │
        │                       │                                          │
        │                       │  ┌──────────────┐  ┌─────────────────┐   │
        │                       │  │ esbuild-wasm │  │ isomorphic-git  │   │
        │                       │  └──────────────┘  └─────────────────┘   │
        │                       └──────────────────────────────────────────┘
```

**Facets** are dynamically spawned Workers (via `LOADER`) that run CPU/network-heavy work — npm resolution, tarball fetching, Node.js script execution, and the Vite dev server — in isolated V8 contexts. They communicate back to the supervisor DO through `SupervisorRPC`, a service binding that provides VFS access, terminal I/O, and esbuild transforms.

| Operation | Execution Context | I/O Method |
|-----------|------------------|------------|
| Shell commands | Supervisor DO | Direct VFS access |
| `node` scripts | Facet (LOADER) | Pre-compiled VFS bundle |
| `npm install` | Facet (LOADER) | RPC writeFile per package |
| `vite` dev server | Facet (FacetManager) | RPC readFile + transform |
| `git clone` | Supervisor (background) | Direct VFS access |
| `esbuild` | Supervisor | Direct VFS access |

## Quick Start

```bash
git clone https://github.com/AshishKumar4/Nimbus.git
cd Nimbus
npm install
npx wrangler dev
# Open http://localhost:8787
```

The landing page at `/` has a **Launch** button that spawns a fresh
sandbox and redirects you to a shareable URL like
`/s/nimble-otter-4271/`. That URL is the sole identity of your Durable
Object — send it to a teammate and they join the same session
(same filesystem, same running processes) instantly. Anyone with the
URL can reconnect at any time; bookmark it to come back later.

URL scheme:

| Path | What it does |
|------|--------------|
| `/` | Landing page (static, cached, no Worker invocation) |
| `POST /new` | Mint a fresh session ID, 302 to `/s/<id>/` |
| `/s/<id>/` | xterm + preview UI for that session |
| `/s/<id>/preview/` | Vite dev server output |
| `/s/<id>/worker/` | nimbus-wrangler dev Worker output |
| `/s/<id>/api/*`, `/s/<id>/ws` | WebSocket + HTTP APIs |

Once the terminal loads, a starter Vite + React + TypeScript app is already waiting at `~/app`:

```bash
# Run the seeded starter
cd app
npm install
npm run dev
# Preview flips to the running app automatically
```

Or clone any real-world project:

```bash
git clone https://github.com/user/my-react-app.git
cd my-react-app
npm install
npm run dev
```

Basics:

```bash
# Write a file with heredoc
cat > hello.js << 'EOF'
const http = require('http');
http.createServer((req, res) => {
  res.end('Hello from Nimbus!');
}).listen(8080);
EOF

node hello.js

# Scaffold a project from scratch
npm init -y
npm install express
```

## How It Works

### SQLite Virtual Filesystem

The VFS stores every file and directory as rows in a SQLite database inside the Durable Object's persistent storage. File content is split into 64 KB pages and served through a 512-entry LRU cache, giving a 32 MB hot working set without loading the full filesystem into memory. Writes are batched into `transactionSync()` calls with a throttle to stay within DO storage limits.

### npm Installer

The npm installer runs as a facet worker. It resolves the full dependency tree with pipelined network requests, fetches tarballs in parallel, extracts them in-memory, and writes the resulting `node_modules` tree back to the supervisor's VFS over RPC. A content-addressed SQLite cache stores both resolved version metadata and raw tarball bytes — so a second `npm install` of the same dependencies completes instantly with zero fetches.

### Vite Dev Server

Vite runs as a long-lived facet worker that handles HTTP requests for the `/preview/*` path. It reads source files from the VFS via RPC, transforms TypeScript/JSX/TSX through esbuild-wasm, resolves `@/` path aliases, injects the Tailwind Play CDN for CSS utility classes, and serves the result. File change events from the VFS propagate to connected browser clients for fast feedback loops.

### Node.js Runtime

Node scripts execute in isolated V8 facet workers. The supervisor pre-bundles the script's dependency graph from the VFS into a single evaluation payload, which the facet loads via `new Function()`. Built-in modules (`fs`, `path`, `http`, etc.) are shimmed to route through RPC back to the supervisor — so `fs.readFileSync()` reads from the SQLite VFS, and `http.createServer()` registers with the port registry for external access.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers + Durable Objects |
| Storage | DO SQLite (10 GB per instance) |
| Process isolation | DO Facets / Dynamic Workers (LOADER) |
| Shell | [@lifo-sh/core](https://www.npmjs.com/package/@lifo-sh/core) |
| Git | [isomorphic-git](https://github.com/AshishKumar4/cf-git) (Cloudflare fork) |
| Bundler | esbuild-wasm 0.24.2 |
| Frontend | xterm.js + split-pane preview |
| IPC | SupervisorRPC via `WorkerEntrypoint` + `ctx.exports` loopback |
| Language | TypeScript, strict mode |

## Project Structure

```
src/
├── index.ts              # Workers entry point, HTTP/WebSocket routing
├── nimbus-session.ts     # NimbusSession Durable Object — the supervisor
├── sqlite-vfs.ts         # 10 GB SQLite-backed virtual filesystem
├── shell-features.ts     # Pipes, redirects, globs, heredoc, env expansion
├── unix-commands.ts      # 50+ coreutil implementations
├── git-commands.ts       # Git operations via isomorphic-git
├── npm-resolver.ts       # Dependency tree resolution
├── npm-installer.ts      # Package extraction and VFS writes
├── npm-tarball.ts        # Tarball fetching and decompression
├── npm-cache.ts          # Content-addressed SQLite cache
├── require-resolver.ts   # Node.js require() with full module resolution
├── node-shims.ts         # fs, path, os, crypto, http, net, etc. shims
├── vite-dev-server.ts    # In-process Vite with JSX/TSX transforms
├── esbuild-service.ts    # esbuild-wasm integration
├── facet-manager.ts      # Dynamic worker lifecycle management
├── supervisor-rpc.ts     # Facet ↔ Supervisor IPC protocol
├── ws-terminal.ts        # WebSocket ↔ xterm.js terminal bridge
├── nimbus-wrangler.ts    # wrangler dev on the actual Workers runtime
├── port-registry.ts      # Node HTTP server port mapping
├── process-table.ts      # Process tracking for ps/kill/jobs
├── vfs-events.ts         # File change events for HMR
├── streams.ts            # Stream utilities
└── constants.ts          # Version, defaults, compatibility flags
```

## Status

**What works:**
- Full shell with pipes, redirects, operators, globs, heredocs, job control
- npm install with caching — tested end-to-end on real-world repos (100+ direct deps resolving to ~450+ packages / ~57,000 files in ~60s on a cold cache)
- Node.js execution with `require()` resolution, subpath imports (`#foo`), legacy flat subpaths, and built-in module shims
- Git clone, pull, commit, push with progress streaming
- Vite dev server with JSX/TSX/CSS transforms, `@/` aliases, Tailwind Play CDN, SPA routing, and auto-injected React Router basename
- esbuild transforms and dependency pre-bundling with shared React runtime (no duplicate React instances across pre-bundled packages)
- Seeded starter project, polished preview placeholder, runtime error overlay, and install guard rails
- 10 GB persistent filesystem across sessions

**Known limitations:**
- 128 MB DO memory limit — large repos may need `--depth 1` for clone
- Synchronous crypto uses FNV-1a (fast hash, not cryptographic) — use `digestAsync()` for real SHA-256
- `gzipSync`/`gunzipSync` throw — use async variants
- `child_process.fork()`/`spawn()` require supervisor routing

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws` | WebSocket | Terminal session |
| `/preview/*` | GET | Vite dev server output |
| `/port/:n/*` | * | Node HTTP server proxy |
| `/worker/*` | * | Wrangler dev worker |
| `/api/stats` | GET | VFS, cache, process stats |
| `/api/write-file` | POST | Write file to VFS |
| `/api/mkdir` | POST | Create directory |
| `/api/start-vite` | POST | Start Vite dev server |

## License

MIT
