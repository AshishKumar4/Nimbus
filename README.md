# Nimbus

A full Linux-like development environment that runs entirely in your browser, on Cloudflare's edge. Open a URL, get a real shell with `node`, `npm`, `git`, `python`, `ruby`, and 60+ Unix commands. No Docker. No containers. No cold-start wait. Sessions hibernate at $0 idle cost and resume in milliseconds.

🌐 **Try it now:** https://nimbus.ashishkmr472.workers.dev

![Demo](docs/demo.gif)

## Why Nimbus

Cloud dev environments today are either heavy VMs (slow to start, expensive to idle) or browser sandboxes that can't run real toolchains. Nimbus is different:

- **Real Linux-like userland.** Real `node`, real `bun`, real `git clone` over HTTPS, real `npm install` against the live npm registry. Real `python` and `ruby` runtimes. Not a stub.
- **Sub-500ms cold start.** Each session is a Cloudflare Durable Object backed by SQLite. No VM boot. No image pull.
- **$0 when idle.** Sessions hibernate. Your filesystem persists. Come back tomorrow, the URL still works, your files are still there.
- **The URL is the session.** Bookmark it, share it, hand it to a teammate — they join the same filesystem.
- **10 GB of persistent storage per session**, SQLite-backed, durable across reconnects and DO eviction.

## Quickstart

### Try the live demo

```
1. Visit https://nimbus.ashishkmr472.workers.dev
2. Click "Launch" — you'll be redirected to /s/<your-session-id>/
3. The URL is now your dev environment. Bookmark it.
```

You're in a real shell. Try:

```bash
node --version              # native node via Workers nodejs_compat
git clone https://github.com/AshishKumar4/Markflow   # real git over HTTPS
cd Markflow && npm install  # real npm against registry.npmjs.org
npm run dev                  # vite dev server — preview in the iframe
```

The preview iframe on the right shows your running app at `/s/<id>/preview/`.

### Run it locally

```bash
git clone https://github.com/AshishKumar4/Nimbus.git
cd Nimbus
bun install
bun run dev      # wrangler dev --ip 0.0.0.0 --port 8787
```

Open http://localhost:8787 and click **Launch**.

## What works today

Verified against the live deploy by behavioral probes in `tests/behavioral/`.

| Capability | Status |
|---|:---:|
| Real shell, 60+ Unix commands, persistent 10 GB filesystem | ✅ |
| `node`, `bun` natively (Workers `nodejs_compat`) | ✅ |
| `python` / `python3` — Pyodide-based CPython 3.13 | ✅ |
| `ruby` / `ruby3` — ruby.wasm-based Ruby 3.3 | ✅ |
| `clang` — LLVM 8 compiling to wasm | ✅ (libc fuller via sysroot-swap in progress) |
| `npm install` against the live registry, with cross-session L2 cache | ✅ |
| `git clone` over HTTPS (small repos + 1 600-file repos in 12–17 s) | ✅ |
| Vite SPA dev server — full HMR to the preview iframe | ✅ |
| `wrangler dev` for single-file Workers; Workers + Static Assets | ✅ |
| `npx <pkg>` — first-class shebang + auto-install fallback | ✅ |
| `node_modules/.bin/*` resolves and executes | ✅ |
| Binary file round-trip via `fs.writeFileSync` / `readFileSync` | ✅ |
| Session recovery — WebSocket drop → reconnect preserves cwd, env, files | ✅ |

### Status: alpha

Nimbus is under active development. Some frameworks work, others surface bugs we're chasing wave-by-wave:

- **Stable:** Vite + React, the Cloudflare Vite Plugin, single-file Workers, Workers with Static Assets, npm + git workflows, Python and Ruby scripts.
- **Partial:** Astro, Next.js, Nuxt, Remix, SvelteKit — some scaffold and run, others hit known bugs in the package-resolver or runtime shim. We add probes and fix as we go.
- **Not yet supported:** Cloudflare Pages (`wrangler pages dev` not wired), multi-tab concurrent sessions, `cirrus-real` Vite DO-Facet path (gated on a Cloudflare compatibility-flag promotion to GA).

## Performance

Measured against the live deploy.

| Operation | Wall time |
|---|---|
| `git clone` 1 600-file repo | 12–17 s |
| `npm install zod` (cold session) | ~6 s |
| `node -e 'console.log(...)'` (warm) | 102–152 ms |
| Vite hot reload | 302 ms median |

Cross-session caching gives 9–16× speedups for warm package installs vs cold.

## Architecture (high level)

![System topology](docs/architecture/topology.svg)

One session = one Cloudflare Durable Object with SQLite storage. The Durable Object is your shell, your filesystem, your port registry, and your process table. CPU-heavy work (npm resolution, esbuild bundling, git clone, WASM execution) fans out to ephemeral Worker Loader isolates that run, return results, and die. Hot reads are cached at the per-colo edge; cross-session assets (npm tarballs, esbuild-wasm) live in R2.

![Layered architecture](docs/architecture/layers.svg)

Four layers, each owning a single concern: the browser terminal talks to the supervisor DO over WebSocket; the supervisor routes RPC; isolates do compute; R2 + `caches.default` hold cross-session state.

## Tests

`tests/behavioral/` contains 91+ black-box probes that drive a real session via `POST /new` + WebSocket. Run them against the live deploy:

```bash
BASE=https://nimbus.ashishkmr472.workers.dev bun test:behavioral
```

Or just one probe:

```bash
BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/large-install.mjs
```

## License + credits

MIT. Built by [Ashish Kumar Singh](https://github.com/AshishKumar4) on top of [LIFO OS](https://github.com/lifo-sh/lifo) by [Sanket Sahu](https://github.com/sanketsahu), which seeded the shell interpreter, coreutils, and Node.js shim (MIT). The Cloudflare-native primitives — Durable Objects with SQLite storage, Worker Loaders, R2, `caches.default`, and WorkerEntrypoint RPC — are the architectural backbone.

Contributions welcome. Open an issue or PR at https://github.com/AshishKumar4/Nimbus.
