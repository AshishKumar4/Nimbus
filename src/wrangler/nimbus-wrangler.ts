/**
 * nimbus-wrangler.ts — Lightweight wrangler dev replacement for Nimbus.
 *
 * Architecture (from spec §8):
 *   nimbus-wrangler dev:
 *     1. Reads wrangler.jsonc/toml from VFS
 *     2. Bundles user's Worker code via EsbuildService
 *     3. Creates a dynamic worker via LOADER.load() with the bundled code
 *     4. Routes /worker/* requests to the dynamic worker's fetch()
 *     5. On VFS file change: re-bundles and recreates the dynamic worker
 *     6. Simulates KV via the worker's own storage
 *
 * The dynamic worker IS the user's Worker — running on the actual
 * Cloudflare Workers runtime, not a simulation.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
import type { VfsEvent } from '../vfs/events.js';
import { registerInnerDoClass, clearInnerDoClasses } from '../facets/inner-do-registry.js';
import { KvEmulator } from '../bindings/kv.js';
import { D1Emulator } from '../bindings/d1.js';
import { R2Emulator } from '../bindings/r2.js';

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Subset of wrangler.jsonc we actually understand. Unknown top-level
 * fields are ignored; known fields in WRANGLER_UNSUPPORTED_CONFIG_FIELDS
 * (in nimbus-session.ts) are warned about at call time.
 */
interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  kv_namespaces?: { binding: string; id?: string; preview_id?: string }[];
  d1_databases?: {
    binding: string;
    database_id?: string;
    database_name?: string;
    migrations_dir?: string;
    preview_database_id?: string;
  }[];
  r2_buckets?: {
    binding: string;
    bucket_name?: string;
    preview_bucket_name?: string;
    jurisdiction?: string;
  }[];
  /** Inline env-vars (strings) delivered to the inner worker as env.<KEY>. */
  vars?: Record<string, string>;
  /**
   * Service bindings. In the outer session the `service` field names
   * another deployed Worker; here we honor it only if the outer env
   * happens to have a field by the same name (i.e. wrangler dev --local
   * with a companion worker). Otherwise we warn and leave undefined.
   */
  services?: { binding: string; service: string; entrypoint?: string }[];
  /** Static assets directory + binding name. */
  assets?: { directory?: string; binding?: string; [k: string]: any };
  /** Worker Loader bindings. */
  worker_loaders?: { binding: string }[];
  /** Durable Object bindings. */
  durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
  /** DO migrations — informational; we don't apply them (facets auto-create SQLite). */
  migrations?: any[];
}

export interface NimbusWranglerOptions {
  vfs: SqliteVFS;
  esbuild: EsbuildService;
  env: any; // Worker env with LOADER binding
  /**
   * Supervisor DO's DurableObjectState. Required for ctx.facets.get()
   * when synthesizing durable_objects bindings (Phase 3). Also used for
   * ctx.exports loopback bindings when synthesizing assets / loaders.
   */
  ctx?: any;
  root: string;
  onLog: (msg: string) => void;
  onHmrMessage: (msg: any) => void;
}

// ── Proxy helpers ──────────────────────────────────────────────────────

/**
 * Rewrite a Location header emitted by the inner Worker so that, when
 * the browser follows it, the browser hits the outer-prefixed URL.
 *
 * Cases handled:
 *   - Same-origin absolute URL (http://localhost:.../s/foo/)
 *       → prepend outerWorkerBase to the pathname
 *   - Origin-relative (/s/foo/, /new)
 *       → prepend outerWorkerBase
 *   - Path-relative (foo/bar)
 *       → leave untouched (browser resolves against current URL, which
 *         is already outer-prefixed)
 *   - Cross-origin absolute URL (https://example.com/...)
 *       → leave untouched
 *   - Malformed / non-URL strings
 *       → leave untouched
 *
 * The outerWorkerBase is the full path prefix (e.g.
 * "/s/nimble-otter-4271/worker"); do not include a trailing slash.
 */
export function rewriteLocationForOuter(
  location: string,
  outerWorkerBase: string,
  currentRequestUrl: string,
): string {
  if (!location) return location;
  const base = outerWorkerBase.replace(/\/+$/, '');

  // Path-relative (no leading slash, no scheme): browser resolves
  // against the current request URL, which is already outer-prefixed,
  // so the right thing happens naturally.
  if (!location.startsWith('/') && !/^[a-z]+:\/\//i.test(location)) {
    return location;
  }

  // Origin-relative starting with /. Prepend the outer base.
  if (location.startsWith('/')) {
    // Don't double-prefix if the inner already emitted an outer path
    // (defensive — it shouldn't, but caches / badly-behaved inner
    // workers could produce one).
    if (location.startsWith(base + '/') || location === base) return location;
    return base + location;
  }

  // Absolute URL. Rewrite only when same-origin; pass cross-origin through.
  try {
    const current = new URL(currentRequestUrl);
    const loc = new URL(location);
    if (loc.origin !== current.origin) return location;
    if (loc.pathname.startsWith(base + '/') || loc.pathname === base) return location;
    loc.pathname = base + loc.pathname;
    return loc.toString();
  } catch {
    return location;
  }
}

/**
 * Small HTML body that stands in for the inner Worker's missing-root
 * handler. Nimbus, when loaded as an inner worker via worker_loaders,
 * has no ASSETS binding to serve its landing page at `/`, so the raw
 * src/index.ts fallthrough emits a 9-byte "Not found". This page
 * replaces that so users visiting `/s/<outer>/worker/` see a useful
 * orientation instead of a scary 404.
 *
 * Style is kept minimal and in line with the outer Nimbus "no dev
 * server running" placeholder so the visual transition when wrangler
 * comes up is not jarring.
 */
function renderWorkerRunningHtml(opts: { workerName: string; outerWorkerBase: string }): string {
  const safeName = String(opts.workerName).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
  const base = opts.outerWorkerBase.replace(/\/+$/, '');
  const newHref = base + '/new';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName} — Worker running</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{background:#0a0a0a;color:#e6edf3;font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px;
       background-image:radial-gradient(800px 500px at 50% -10%,rgba(100,255,218,0.06),transparent 60%)}
  .card{max-width:560px;text-align:center}
  .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block;
       box-shadow:0 0 6px rgba(63,185,80,0.8);animation:pulse 1.6s ease-in-out infinite;margin-right:8px;vertical-align:middle}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .badge{display:inline-block;padding:6px 14px;border:1px solid #30363d;border-radius:999px;
         font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#8b949e;margin-bottom:18px}
  h1{font-size:26px;color:#64ffda;margin-bottom:10px;font-family:ui-monospace,Menlo,monospace}
  p{color:#8b949e;margin-bottom:22px}
  code{font-family:ui-monospace,Menlo,monospace;background:#111;padding:2px 8px;border-radius:4px;color:#e6edf3;font-size:13px}
  .links{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:12px}
  a.btn{display:inline-block;background:#64ffda;color:#000;font-weight:700;padding:9px 18px;border-radius:6px;text-decoration:none}
  a.btn.secondary{background:transparent;color:#8b949e;border:1px solid #30363d}
  a.btn:hover{filter:brightness(1.1)}
</style></head>
<body><div class="card">
<span class="badge"><span class="dot"></span>${safeName} is running</span>
<h1>Worker has no route for <code>/</code></h1>
<p>The inner Worker is running, but it didn't define a handler for the root path. If this is Nimbus-in-Nimbus, visit <code>/new</code> to spawn a session.</p>
<div class="links">
  <a class="btn" href="${newHref}">Open /new</a>
</div>
</div></body></html>`;
}

// ── NimbusWrangler ────────────────────────────────────────────────────────

export class NimbusWrangler {
  private vfs: SqliteVFS;
  private esbuild: EsbuildService;
  private loaderEnv: any;
  private supervisorCtx: any; // ctx.facets for DO facets, ctx.exports for bindings
  private root: string;
  private onLog: (msg: string) => void;
  private onHmrMessage: (msg: any) => void;

  private running = false;
  private config: WranglerConfig | null = null;
  private workerStub: any = null;
  private buildVersion = 0;
  private unsubVfs: (() => void) | null = null;
  private rebuildTimer: any = null;
  /** DO class map: binding name → DurableObjectClass from the inner worker. */
  private doClassMap: Map<string, any> = new Map();
  /** Facet names we've created via ctx.facets.get — aborted on rebuild / stop. */
  private doFacetNames: Set<string> = new Set();

  constructor(opts: NimbusWranglerOptions) {
    this.vfs = opts.vfs;
    this.esbuild = opts.esbuild;
    this.loaderEnv = opts.env;
    this.supervisorCtx = opts.ctx || null;
    this.root = opts.root.replace(/^\/+/, '').replace(/\/+$/, '');
    this.onLog = opts.onLog;
    this.onHmrMessage = opts.onHmrMessage;
  }

  /** Start the wrangler dev server. */
  async start(): Promise<boolean> {
    // 1. Read wrangler config
    this.config = this.readConfig();
    if (!this.config) {
      this.onLog('\x1b[31mNo wrangler.jsonc or wrangler.toml found in ' + this.root + '\x1b[0m\n');
      return false;
    }

    // 2. Build and load the worker
    const ok = await this.buildAndLoad();
    if (!ok) return false;

    // 3. Watch for file changes
    this.running = true;
    this.unsubVfs = this.vfs.events.on((events) => {
      this.handleVfsEvents(events);
    });

    return true;
  }

  /** Stop the wrangler dev server. */
  stop(): void {
    this.running = false;
    if (this.unsubVfs) { this.unsubVfs(); this.unsubVfs = null; }
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
    // Abort live inner-DO facets so their stubs drop. Storage persists per
    // docs — next start() or `nimbus-wrangler reset` controls deletion.
    if (this.doFacetNames.size > 0 && this.supervisorCtx?.facets?.abort) {
      for (const name of this.doFacetNames) {
        try { this.supervisorCtx.facets.abort(name, new Error('nimbus-wrangler stopped')); } catch {}
      }
    }
    this.doFacetNames.clear();
    this.doClassMap.clear();
    this.workerStub = null;
  }

  get isRunning() { return this.running; }

  // ── Config reading ────────────────────────────────────────────────────

  private readConfig(): WranglerConfig | null {
    // Try wrangler.jsonc first, then wrangler.json, then wrangler.toml
    const jsonPaths = [
      this.root + '/wrangler.jsonc',
      this.root + '/wrangler.json',
    ];

    for (const p of jsonPaths) {
      if (this.vfs.exists(p)) {
        try {
          let text = this.vfs.readFileString(p);
          // Strip JSONC comments while preserving content inside strings.
          // Walk character by character, skip // and /* */ outside of quotes.
          let cleaned = '';
          let i = 0;
          let inString = false;
          while (i < text.length) {
            if (inString) {
              if (text[i] === '\\') { cleaned += text[i] + (text[i + 1] || ''); i += 2; continue; }
              if (text[i] === '"') inString = false;
              cleaned += text[i]; i++;
            } else {
              if (text[i] === '"') { inString = true; cleaned += text[i]; i++; }
              else if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
              else if (text[i] === '/' && text[i + 1] === '*') { i += 2; while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
              else { cleaned += text[i]; i++; }
            }
          }
          return JSON.parse(cleaned);
        } catch (e: any) {
          this.onLog(`\x1b[33mWarning: could not parse ${p}: ${e?.message}\x1b[0m\n`);
        }
      }
    }

    // Try wrangler.toml (minimal parse)
    const tomlPath = this.root + '/wrangler.toml';
    if (this.vfs.exists(tomlPath)) {
      try {
        const text = this.vfs.readFileString(tomlPath);
        return this.parseMinimalToml(text);
      } catch (e: any) {
        this.onLog(`\x1b[33mWarning: could not parse ${tomlPath}: ${e?.message}\x1b[0m\n`);
      }
    }

    return null;
  }

  /** Minimal TOML parser — handles key = "value" and main/name/compatibility_date. */
  private parseMinimalToml(text: string): WranglerConfig {
    const config: WranglerConfig = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      // Strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key === 'main') config.main = val;
      else if (key === 'name') config.name = val;
      else if (key === 'compatibility_date') config.compatibility_date = val;
    }
    return config;
  }

  // ── Build & load ──────────────────────────────────────────────────────

  private async buildAndLoad(): Promise<boolean> {
    if (!this.config?.main) {
      this.onLog('\x1b[31mNo "main" entry point in wrangler config\x1b[0m\n');
      return false;
    }

    const entryPoint = this.root + '/' + this.config.main;
    if (!this.vfs.exists(entryPoint)) {
      this.onLog(`\x1b[31mEntry point not found: ${entryPoint}\x1b[0m\n`);
      return false;
    }

    // Bundle via esbuild
    this.onLog('  Building Worker...\n');
    try {
      const result = await this.esbuild.build([entryPoint], {
        bundle: true,
        format: 'esm',
        target: 'esnext',
        platform: 'neutral',
        minify: false,
        // `node:*` handles prefixed imports; bare names (fs, path, etc.)
        // are used by legacy CJS packages like esbuild-wasm's main.js.
        // Mark both forms external so dynamic require('fs') round-trips
        // to the inner runtime's nodejs_compat-provided modules.
        external: [
          'cloudflare:*',
          'node:*',
          'fs', 'path', 'os', 'crypto', 'util', 'stream', 'events',
          'buffer', 'url', 'querystring', 'http', 'https', 'net', 'tls',
          'child_process', 'worker_threads', 'perf_hooks', 'zlib',
          'assert', 'fs/promises', 'process',
        ],
      });

      if (result.errors?.length) {
        for (const e of result.errors) {
          this.onLog(`  \x1b[31merror: ${e.text}\x1b[0m\n`);
        }
        return false;
      }

      if (!result.outputFiles?.length) {
        this.onLog('  \x1b[31mNo output from esbuild\x1b[0m\n');
        return false;
      }

      const bundledCode = result.outputFiles[0].contents;
      this.buildVersion++;

      // On rebuild, abort any live DO facets so the NEXT get() runs the
      // startup callback with the fresh class. Docs: abort invalidates
      // all existing stubs but preserves storage; the next get() is the
      // code-update pattern.
      if (this.doFacetNames.size > 0 && this.supervisorCtx?.facets?.abort) {
        for (const name of this.doFacetNames) {
          try { this.supervisorCtx.facets.abort(name, new Error('nimbus-wrangler rebuilding')); } catch {}
        }
      }

      // Two-pass load to break the chicken-and-egg:
      //   Pass 1: load with NO env to extract any durable_objects classes.
      //           buildInnerEnv needs this.doClassMap to synthesize DO
      //           namespace bindings, but getDurableObjectClass() needs a
      //           worker stub, which we get only by loading.
      //   Pass 2: re-load with FULL env (including DO namespace shims)
      //           that the inner Worker actually uses.
      //
      // workerd caches by content hash, so the second load is cheap —
      // it reuses the same compiled isolate and just swaps env.

      const wrangCompatDate = this.config.compatibility_date || '2026-04-01';
      // Filter flags that workerd refuses on dynamic-worker LOADER.load().
      // `experimental` gates behind the parent process's --experimental
      // CLI flag; dynamic workers can't inherit that, so workerd rejects
      // the load with:
      //   "The compatibility flag experimental is experimental and may
      //    break or be removed in a future version of workerd. To use
      //    this flag, you must pass --experimental on the command line."
      // The inner Worker rarely needs `experimental` — it's only required
      // when the inner itself returns chained WorkerEntrypoint stubs
      // across RPC (the NimbusLoaderRPC pattern, which WE implement but
      // typical user Workers do not). Strip it here; document in the
      // warning log so users who legitimately need it know.
      const rawFlags = this.config.compatibility_flags || [];
      const wrangCompatFlags = rawFlags.filter((f) => f !== 'experimental');
      if (rawFlags.length !== wrangCompatFlags.length) {
        this.onLog(`  \x1b[2mnote: stripped 'experimental' from inner compat_flags (not propagatable via LOADER.load)\x1b[0m\n`);
      }
      const baseWorkerCode = {
        compatibilityDate: wrangCompatDate,
        compatibilityFlags: wrangCompatFlags,
        mainModule: 'worker.js',
        modules: { 'worker.js': bundledCode },
      } as any;

      // Pass 1: class extraction (no env, no DO shims).
      this.doClassMap.clear();
      const doBindings = this.config.durable_objects?.bindings || [];
      if (doBindings.length > 0) {
        let probeWorker: any;
        try {
          probeWorker = this.loaderEnv.LOADER.load(baseWorkerCode);
        } catch (e: any) {
          this.onLog(`  \x1b[31mBuild error (probe load): ${e?.message || e}\x1b[0m\n`);
          return false;
        }
        for (const b of doBindings) {
          if (b.script_name && b.script_name !== this.config.name) {
            this.onLog(`  \x1b[31merror: durable_objects binding '${b.name}' references external script '${b.script_name}'. nimbus-wrangler cannot load external Workers by name.\x1b[0m\n`);
            return false;
          }
          try {
            const cls = probeWorker.getDurableObjectClass(b.class_name);
            this.doClassMap.set(b.name, cls);
          } catch (e: any) {
            this.onLog(`  \x1b[31merror: durable_objects binding '${b.name}' => class '${b.class_name}' not found in bundle: ${e?.message || e}\x1b[0m\n`);
            return false;
          }
        }
      }

      // Pass 2: real load with the full synthesized env. buildInnerEnv
      // reads this.doClassMap populated above.
      const innerEnv = this.buildInnerEnv();
      const worker = this.loaderEnv.LOADER.load({
        ...baseWorkerCode,
        env: innerEnv,
      });
      this.workerStub = worker.getEntrypoint();

      for (const w of result.warnings || []) {
        this.onLog(`  \x1b[33mwarning: ${w.text}\x1b[0m\n`);
      }

      this.onLog(`  \x1b[32mWorker built (v${this.buildVersion}, ${bundledCode.length} bytes)\x1b[0m\n`);
      return true;
    } catch (e: any) {
      this.onLog(`  \x1b[31mBuild error: ${e?.message || e}\x1b[0m\n`);
      return false;
    }
  }

  // ── Inner env synthesis ──────────────────────────────────────────────
  //
  // buildInnerEnv assembles the `env` object that the inner Worker's
  // fetch(request, env, ctx) will see. Each binding category is built
  // by a dedicated helper so they can be added/removed in isolation.
  //
  // Phases land in this order:
  //   Phase 0: vars + services (+ preflight of unsupported fields)
  //   Phase 1: assets         → env[binding] = ctx.exports.NimbusAssetsRPC(...)
  //   Phase 2: worker_loaders → env[binding] = ctx.exports.NimbusLoaderRPC(...)
  //   Phase 3: durable_objects → env[binding] = synthesized DO namespace shim
  //
  // At the end of each phase the inner Worker has one more kind of binding
  // it can access by name. Phase 0 is the plumbing: adding the `env` field
  // to LOADER.load() at all, plus forwarding plain string vars.

  private buildInnerEnv(): Record<string, any> {
    const env: Record<string, any> = {};

    // ── vars ──
    // Straight string copy. Collisions with synthesized binding names
    // (later phases) would be surprising, so later phases will warn if
    // they overwrite a vars-provided key.
    if (this.config?.vars) {
      for (const [k, v] of Object.entries(this.config.vars)) {
        env[k] = v;
      }
    }

    // ── services ──
    // Honor a service binding only if the outer env has a field with the
    // same NAME as the declared binding. In wrangler the `binding` field
    // is the variable name inside the worker, while `service` is the name
    // of the target deployed worker; in dev we only have the outer env's
    // existing bindings to forward. Warn on every other case so the user
    // knows not to expect real-wrangler passthrough.
    if (this.config?.services?.length) {
      for (const s of this.config.services) {
        const name = s.binding;
        if (!name) continue;
        if (this.loaderEnv && name in this.loaderEnv) {
          env[name] = this.loaderEnv[name];
        } else {
          this.onLog(`  \x1b[33mwarning: services binding '${name}' not present in outer env; env.${name} will be undefined\x1b[0m\n`);
        }
      }
    }

    // ── assets ──
    // Inner worker: env[binding].fetch(request) → reads a file under
    // <vfsRoot>/<assetsDir>/<pathname>. Implemented via a WorkerEntrypoint
    // loopback binding (NimbusAssetsRPC, re-exported from index.ts so
    // ctx.exports auto-populates it).
    if (this.config?.assets) {
      const binding = this.config.assets.binding || 'ASSETS';
      const directory = String(this.config.assets.directory || 'public');
      const assetsDir = directory.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      const ctxExports = this.supervisorCtx?.exports;
      const doId = this.supervisorCtx?.id?.toString?.() || '';
      if (!ctxExports?.NimbusAssetsRPC) {
        this.onLog(`  \x1b[33mwarning: ctx.exports.NimbusAssetsRPC unavailable; env.${binding} will not work\x1b[0m\n`);
      } else if (!doId) {
        this.onLog(`  \x1b[33mwarning: supervisor DO id unavailable; env.${binding} will not work\x1b[0m\n`);
      } else {
        if (binding in env) {
          this.onLog(`  \x1b[33mwarning: assets binding '${binding}' overwrites a vars/services key with the same name\x1b[0m\n`);
        }
        env[binding] = ctxExports.NimbusAssetsRPC({
          props: {
            vfsRoot: this.root,
            assetsDir,
            doId,
          },
        });
      }
    }

    // ── worker_loaders ──
    // Inner worker: env[binding].load({...}) / env[binding].get(id, cb).
    // Implemented as a WorkerEntrypoint that forwards to the OUTER
    // env.LOADER. Each inner call increments the `depth` prop; the
    // handler rejects once depth exceeds the configured cap (default 4,
    // override via the outer session's NIMBUS_INNER_LOADER_DEPTH env).
    if (this.config?.worker_loaders?.length) {
      const ctxExports = this.supervisorCtx?.exports;
      if (!ctxExports?.NimbusLoaderRPC) {
        for (const wl of this.config.worker_loaders) {
          this.onLog(`  \x1b[33mwarning: ctx.exports.NimbusLoaderRPC unavailable; env.${wl.binding} will not work\x1b[0m\n`);
        }
      } else {
        const currentDepth = (this.loaderEnv as any)?.NIMBUS_INNER_LOADER_DEPTH_CURRENT
          ? parseInt(String((this.loaderEnv as any).NIMBUS_INNER_LOADER_DEPTH_CURRENT), 10) || 0
          : 0;
        const nextDepth = currentDepth + 1;
        for (const wl of this.config.worker_loaders) {
          const binding = wl.binding;
          if (!binding) continue;
          if (binding in env) {
            this.onLog(`  \x1b[33mwarning: worker_loaders binding '${binding}' overwrites a previous key\x1b[0m\n`);
          }
          env[binding] = ctxExports.NimbusLoaderRPC({
            props: { depth: nextDepth },
          });
        }
      }
    }

    // ── durable_objects ──
    // Inner worker: env[binding].idFromName(name) + env[binding].get(id).fetch(req).
    // The class list was resolved and stored in this.doClassMap during
    // buildAndLoad(); register each class into the module-level
    // registry consulted by _rpcInnerDoFetch, then synthesize the
    // namespace stub via ctx.exports.NimbusDurableObjectNamespace(...).
    if (this.doClassMap.size > 0) {
      const ctxExports = this.supervisorCtx?.exports;
      const doId = this.supervisorCtx?.id?.toString?.() || '';
      if (!ctxExports?.NimbusDurableObjectNamespace) {
        for (const [bindingName] of this.doClassMap) {
          this.onLog(`  \x1b[33mwarning: ctx.exports.NimbusDurableObjectNamespace unavailable; env.${bindingName} will not work\x1b[0m\n`);
        }
      } else if (!doId) {
        for (const [bindingName] of this.doClassMap) {
          this.onLog(`  \x1b[33mwarning: supervisor DO id unavailable; env.${bindingName} will not work\x1b[0m\n`);
        }
      } else {
        // Clear + repopulate the registry for this supervisor DO id.
        clearInnerDoClasses(doId);
        for (const [bindingName, cls] of this.doClassMap) {
          registerInnerDoClass(doId, bindingName, cls);
          if (bindingName in env) {
            this.onLog(`  \x1b[33mwarning: durable_objects binding '${bindingName}' overwrites a previous key\x1b[0m\n`);
          }
          env[bindingName] = ctxExports.NimbusDurableObjectNamespace({
            props: {
              bindingName,
              supervisorDoId: doId,
            },
          });
          // Track facet names we might create later so stop() can abort
          // them cleanly. Exact ids aren't known until inner calls
          // .get(id), so we just track the base name.
          this.doFacetNames.add('innerDO-' + bindingName + '-*');
        }
      }
    }

    // ── kv_namespaces ── (W10)
    // Inner worker: env[binding].get(key) / put / delete / list /
    // getWithMetadata. Implementation is a plain JS class (KvEmulator)
    // backed by SqliteVFS file blobs at <root>/.nimbus/kv/<binding>/.
    // No ctx.exports loopback needed: KV is pure data, no callbacks
    // back into the supervisor's fetch handlers. Each emulator instance
    // is bound to one (binding, root) pair.
    if (this.config?.kv_namespaces?.length) {
      for (const kv of this.config.kv_namespaces) {
        if (!kv.binding) continue;
        if (kv.binding in env) {
          this.onLog(`  \x1b[33mwarning: kv_namespaces binding '${kv.binding}' overwrites a previous key\x1b[0m\n`);
        }
        env[kv.binding] = new KvEmulator({
          vfs: this.vfs,
          root: this.root,
          binding: kv.binding,
          onLog: this.onLog,
        });
      }
    }

    // ── d1_databases ── (W10)
    // Inner worker: env[binding].prepare(query) / batch / exec.
    // Implementation: D1Emulator backed by the supervisor's SqlStorage
    // with per-binding table-prefix isolation. See plan §14.1 — a
    // child-DO-facet-per-binding upgrade is the W10.5 candidate.
    //
    // migrations_dir is honored: applyMigrations() walks the directory
    // alphabetically and replays each .sql file once (idempotent via
    // a per-binding ledger table).
    if (this.config?.d1_databases?.length) {
      const sqlStorage = this.supervisorCtx?.storage?.sql;
      if (!sqlStorage) {
        for (const d1 of this.config.d1_databases) {
          this.onLog(`  \x1b[33mwarning: ctx.storage.sql unavailable; env.${d1.binding} will not work\x1b[0m\n`);
        }
      } else {
        for (const d1 of this.config.d1_databases) {
          if (!d1.binding) continue;
          if (d1.binding in env) {
            this.onLog(`  \x1b[33mwarning: d1_databases binding '${d1.binding}' overwrites a previous key\x1b[0m\n`);
          }
          const emu = new D1Emulator({
            sqlStorage,
            binding: d1.binding,
            vfs: this.vfs,
            root: this.root,
            migrationsDir: d1.migrations_dir,
            onLog: this.onLog,
          });
          env[d1.binding] = emu;
          // Fire migrations in the background. They're idempotent so
          // racing rebuilds is safe.
          if (d1.migrations_dir) {
            emu.applyMigrations().then((r) => {
              if (r.applied > 0) {
                this.onLog(`  \x1b[2mD1 ${d1.binding}: applied ${r.applied} migrations\x1b[0m\n`);
              }
            }).catch((e: any) => {
              this.onLog(`  \x1b[33mwarning: D1 ${d1.binding} migrations failed: ${e?.message || e}\x1b[0m\n`);
            });
          }
        }
      }
    }

    // ── r2_buckets ── (W10)
    // Inner worker: env[binding].get(key) / put / head / list / delete.
    // Implementation: R2Emulator backed by SqliteVFS file blobs at
    // <root>/.nimbus/r2/<binding>/. Etag is sha256(body); conditionals
    // (etagMatches/etagDoesNotMatch/uploaded*) are honored.
    //
    // Multipart upload methods throw a clear "not supported" error
    // (W10.5 candidate; see plan §13 review B4).
    if (this.config?.r2_buckets?.length) {
      for (const r2 of this.config.r2_buckets) {
        if (!r2.binding) continue;
        if (r2.binding in env) {
          this.onLog(`  \x1b[33mwarning: r2_buckets binding '${r2.binding}' overwrites a previous key\x1b[0m\n`);
        }
        env[r2.binding] = new R2Emulator({
          vfs: this.vfs,
          root: this.root,
          binding: r2.binding,
          onLog: this.onLog,
        });
      }
    }

    return env;
  }

  // ── VFS event handling (hot reload) ───────────────────────────────────

  private handleVfsEvents(events: VfsEvent[]): void {
    if (!this.running) return;

    // Check if any changed file is under our project root
    let needsRebuild = false;
    for (const event of events) {
      if (event.type !== 'change' && event.type !== 'add' && event.type !== 'unlink') continue;
      if (event.path.startsWith(this.root) &&
          !event.path.includes('node_modules/') &&
          !event.path.includes('/.nimbus/')) {
        // W10: skip writes by KV/D1/R2 emulators (they live under
        // <root>/.nimbus/{kv,r2}/...) — otherwise every emulator put
        // triggers a rebuild and the system feedback-loops itself.
        needsRebuild = true;
        break;
      }
    }

    if (!needsRebuild) return;

    // Debounce rebuilds (250ms — allows rapid saves to coalesce)
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(async () => {
      this.rebuildTimer = null;
      this.onLog('\n  \x1b[33mFile change detected, rebuilding...\x1b[0m\n');
      const ok = await this.buildAndLoad();
      if (ok) {
        this.onHmrMessage({ type: 'nimbus-hmr', event: 'full-reload' });
      }
    }, 250);
  }

  // ── Request handling ──────────────────────────────────────────────────

  /**
   * Forward a request to the user's Worker.
   * Called from the DO's fetch() handler for /worker/* paths.
   *
   * Three things this proxy does besides a raw fetch:
   *  1. Buffers the request body to an ArrayBuffer before forwarding.
   *     The inner Worker can legitimately respond with a 302 (e.g.
   *     Nimbus-in-Nimbus: POST /new → 302 /s/<id>/). Workerd's `fetch`
   *     defaults to follow-redirects which requires replaying the body;
   *     a stream body can only be read once. Buffering first sidesteps
   *     the "one-time-use body encountered a redirect" error. POSTs to
   *     Nimbus's own /new endpoint are typically empty, but KV/D1 sims
   *     and user workers may send non-trivial bodies.
   *  2. Uses `redirect: 'manual'` so the inner's Location header comes
   *     back unchanged. We rewrite it below to prepend the outer worker
   *     prefix — otherwise the browser follows a bare `/s/<id>/` URL,
   *     which is an OUTER route and spawns a different session, not
   *     what the user wanted.
   *  3. Replaces a "Not found" 404 at the inner root with a small
   *     landing page. Nimbus itself (the likely inner worker) has no
   *     route for `/` when loaded without an ASSETS binding — users
   *     hitting `/s/<outer>/worker/` directly would otherwise see a
   *     bare 9-byte "Not found" response and think the whole thing
   *     broke. The landing page explains the Worker is running and
   *     points them at `/worker/new` / their own routes.
   */
  async handleRequest(
    request: Request,
    pathname: string,
    /**
     * Outer-facing prefix of this proxy (e.g. "/s/nimble-otter-4271/worker").
     * Used to rewrite inner-emitted Location headers that reference
     * their own origin-relative paths. When absent, Location headers
     * are passed through unchanged.
     */
    outerWorkerBase?: string,
  ): Promise<Response> {
    if (!this.workerStub) {
      return new Response('Worker not loaded', { status: 503 });
    }

    try {
      // Build a new Request with the rewritten URL
      const workerUrl = new URL(request.url);
      workerUrl.pathname = pathname;

      // Buffer the body up front. Necessary even when we set
      // redirect: 'manual' (see below) because workerd's internal
      // fetch plumbing can still try to replay a streaming body in
      // some paths (e.g. retry-after errors). Capturing once here is
      // both correct and cheap — user worker requests are small.
      let bodyBuffer: ArrayBuffer | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        bodyBuffer = await request.arrayBuffer();
      }

      const workerReq = new Request(workerUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: bodyBuffer,
        // Don't auto-follow: a 302 to /s/<id>/ from the inner is its
        // OWN path, not a path we can resolve — we need to rewrite
        // and propagate it to the browser so the user lands on the
        // correctly-prefixed outer URL.
        redirect: 'manual',
      });

      const response = await this.workerStub.fetch(workerReq);

      // ── Response post-processing ─────────────────────────────────
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', '*');

      // (2) Rewrite Location headers so browser-follow lands on the
      // outer-prefixed URL. Only rewrite for same-origin redirects —
      // absolute cross-origin URLs pass through untouched.
      if (outerWorkerBase && (response.status === 301 || response.status === 302 ||
          response.status === 303 || response.status === 307 ||
          response.status === 308)) {
        const loc = response.headers.get('Location');
        if (loc) {
          const rewritten = rewriteLocationForOuter(loc, outerWorkerBase, request.url);
          if (rewritten !== loc) newHeaders.set('Location', rewritten);
        }
      }

      // (3) Replace a bare "Not found" at the root with a helpful landing.
      // We detect this conservatively: only a literal "Not found" body
      // with status 404 for a request to "/", which is exactly what
      // Nimbus-as-inner emits when its default fallthrough runs. User
      // workers that deliberately return 404 at other paths are untouched.
      if (response.status === 404 && pathname === '/') {
        const bodyText = await response.clone().text();
        if (bodyText === 'Not found' || bodyText.length === 0) {
          const html = renderWorkerRunningHtml({
            workerName: this.config?.name || 'user worker',
            outerWorkerBase: outerWorkerBase || '/worker',
          });
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (e: any) {
      return Response.json(
        { error: e?.message || String(e) },
        { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }
  }

  get stats() {
    return {
      running: this.running,
      name: this.config?.name || 'unknown',
      main: this.config?.main || 'unknown',
      root: this.root,
      buildVersion: this.buildVersion,
    };
  }

  // ── Test seams (W10 probes) ───────────────────────────────────────────
  //
  // These exist so probes can drive specific code paths (config parse,
  // env synthesis, watcher installation) without running the full
  // start() pipeline (which requires a real esbuild + LOADER + ctx).
  //
  // Production code does NOT use these; they're stable contracts only
  // for the test probes. Naming convention: leading underscore + ForTest
  // suffix.

  /** @internal — test seam: parse the wrangler config and store it. Returns true on success. */
  _readConfigForTest(): boolean {
    this.config = this.readConfig();
    return this.config != null;
  }

  /** @internal — test seam: invoke buildInnerEnv() without a probe-load pass. */
  _buildInnerEnvForTest(): Record<string, any> {
    return this.buildInnerEnv();
  }

  /** @internal — test seam: install the VFS file-watch listener and the
   * mock-rebuild path (esbuild.build() is called, but the real
   * buildAndLoad() pipeline is bypassed in favour of just calling
   * esbuild). Used for hot-reload latency + nimbus-paths-not-watched
   * probes. Production calls start() which installs the watcher AND the
   * full rebuild pipeline. */
  _installWatchersForTest(): void {
    this.running = true;
    this.unsubVfs = this.vfs.events.on(async (events: VfsEvent[]) => {
      let needsRebuild = false;
      for (const event of events) {
        if (event.type !== 'change' && event.type !== 'add' && event.type !== 'unlink') continue;
        if (event.path.startsWith(this.root) &&
            !event.path.includes('node_modules/') &&
            !event.path.includes('/.nimbus/')) {
          needsRebuild = true;
          break;
        }
      }
      if (!needsRebuild) return;
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(async () => {
        this.rebuildTimer = null;
        try {
          await this.esbuild.build([this.root + '/' + (this.config?.main || 'src/index.ts')], {
            bundle: true, format: 'esm', target: 'esnext', platform: 'neutral',
          } as any);
          this.onHmrMessage({ type: 'nimbus-hmr', event: 'full-reload' });
        } catch {}
      }, 250);
    });
  }
}
