/**
 * session/helpers.ts — pure helpers used by the supervisor.
 *
 * All functions here are pure (no class state, no
 * `cloudflare:workers` import), so they can be unit-tested with bun
 * test without a workerd harness. The cleanup-and-readme reorg moved
 * them here from src/nimbus-session.ts (originally lines 96-523).
 *
 * audit/sections/SESSION-REFACTOR-PLAN.md §B.3.2 + S1.
 *
 * Re-exported by nimbus-session.ts so existing imports keep working.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

/**
 * Render a polished "no dev server" placeholder HTML page for the /preview/
 * route. Matches the Nimbus shell MOTD aesthetic (near-black background,
 * green monospace accents). Auto-reloads when /api/stats reports the named
 * service has flipped to `running: true`.
 *
 * All CSS inlined — no external deps so it works offline.
 */
export function renderNoDevServerHtml(opts: {
  /** Shell hint to display in the code block (already HTML-escaped). */
  hint: string;
  /** Fully-qualified URL path to poll (e.g. `/s/<id>/api/stats`). */
  polled: string;
  /** Stats field to watch for `.running === true`. */
  liveKey: 'vite' | 'wrangler';
}): string {
  const polled = opts.polled;
  const live = opts.liveKey;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nimbus Preview — waiting</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{
    background:#0a192f;
    color:#ccd6f6;
    font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex;align-items:center;justify-content:center;
    background-image:
      radial-gradient(900px 400px at 15% -5%,rgba(100,255,218,0.06),transparent 55%),
      radial-gradient(800px 450px at 100% 105%,rgba(100,255,218,0.04),transparent 55%);
    padding:20px;
  }
  .card{
    width:min(560px,94vw);
    padding:36px 40px;
    background:rgba(17,34,64,0.7);
    border:1px solid #1e3a5f;
    border-radius:10px;
    box-shadow:0 24px 48px rgba(0,0,0,0.4);
    backdrop-filter:blur(6px);
  }
  .brand{
    display:flex;align-items:center;gap:10px;margin-bottom:28px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:12px;letter-spacing:0.08em;text-transform:uppercase;
  }
  .dot{
    width:8px;height:8px;border-radius:50%;background:#64ffda;
    box-shadow:0 0 10px #64ffda;
    animation:pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.75)}}
  .brand-label{color:#64ffda;font-weight:600}
  h1{font-size:22px;font-weight:600;color:#e6f1ff;margin-bottom:8px;letter-spacing:-0.01em}
  .sub{font-size:14px;color:#8892b0;margin-bottom:26px;line-height:1.55}
  .hint-label{
    font-size:10px;color:#64ffda;
    text-transform:uppercase;letter-spacing:0.12em;
    margin-bottom:8px;font-weight:600;
  }
  .hint{
    padding:14px 16px;
    background:#0a192f;
    border:1px solid #1e3a5f;
    border-radius:6px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:13px;color:#ccd6f6;
    overflow-x:auto;
  }
  .hint .prompt{color:#64ffda;user-select:none;margin-right:8px;font-weight:600}
  .footer{
    margin-top:28px;padding-top:18px;border-top:1px solid #1e3a5f;
    display:flex;align-items:center;justify-content:space-between;
    font-size:12px;color:#8892b0;
    font-family:ui-monospace,monospace;
  }
  .status{display:flex;align-items:center;gap:8px}
  .spinner{
    width:10px;height:10px;border-radius:50%;
    border:1.5px solid #1e3a5f;border-top-color:#64ffda;
    animation:spin 0.9s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="dot"></div>
      <div class="brand-label">Nimbus · Preview</div>
    </div>
    <h1>Preview not available</h1>
    <p class="sub">Start a dev server to see your app here. This page auto-reloads the moment the server comes online.</p>
    <div class="hint-label">Run in terminal</div>
    <div class="hint"><span class="prompt">$</span>${opts.hint}</div>
    <div class="footer">
      <div class="status"><div class="spinner"></div>Watching for ${live}</div>
      <div>auto-refresh 2s</div>
    </div>
  </div>
  <script>
    (function(){
      var failures = 0;
      function tick(){
        fetch(${JSON.stringify(polled)},{cache:'no-store'})
          .then(function(r){return r.ok?r.json():null})
          .then(function(s){
            failures=0;
            if(s && s[${JSON.stringify(live)}] && s[${JSON.stringify(live)}].running){
              location.reload();
            }
          })
          .catch(function(){failures++})
          .finally(function(){
            var delay = failures > 3 ? 5000 : 2000;
            setTimeout(tick, delay);
          });
      }
      setTimeout(tick, 1500);
    })();
  </script>
</body>
</html>`;
}

/**
 * Known bundler / framework CLIs that need node_modules to be usable.
 * If an npm script starts with one of these binaries, missing node_modules
 * is a hard error (exit 1) rather than a warning. Scripts that don't match
 * get a soft warning; the script runs anyway in case it's something like
 * `echo hi` that doesn't need deps at all.
 */
export const BUNDLER_BIN_PREFIXES = [
  'vite',
  'next',
  'webpack',
  'rollup',
  'parcel',
  'tsc',
  'tsx',
  'ts-node',
  'esbuild',
  'nuxt',
  'remix',
  'astro',
  'svelte-kit',
  'react-scripts',
];

/**
 * Bins that can't execute inside a Durable Object isolate, with tailored
 * guidance for the user. These are commands that CAN install into
 * node_modules/.bin but that crash or hang at runtime because they depend
 * on primitives (child_process.spawn, native binaries, real sockets) that
 * Nimbus doesn't provide.
 *
 * Used by the `npm run` handler's Fix-1 pre-flight: if a script starts
 * with one of these bins, we short-circuit with a deterministic error
 * instead of letting it enter the shell.execute black hole.
 *
 * Keep the keys as the RAW bin name the user's script would invoke;
 * point to the Nimbus-native alternative if one exists.
 *
 * NOTE: `wrangler` is NOT here anymore — it's registered as a transparent
 * alias for `nimbus-wrangler` in initSession, so `npm run dev` with a
 * wrangler-based dev script Just Works via the DO-in-DO implementation.
 * If a user's Worker uses bindings that nimbus-wrangler can't provide
 * (durable_objects, assets, worker_loaders, etc.), the wrapper prints a
 * loud warning BEFORE building so there are no mysterious runtime errors.
 */
export const NIMBUS_UNSUPPORTED_BINS: Record<string, { reason: string; alternative?: string }> = {
  // Intentionally empty — all previously-listed bins have working
  // Nimbus alternatives. Keep the map in place so future truly-
  // unsupported bins can be added without re-plumbing the call site.
};

/**
 * wrangler CLI flags that have no meaning inside Nimbus (the DO provides
 * its own host/port/log routing). If present in a wrangler/npm-run-dev
 * invocation, we strip them silently rather than failing — user scripts
 * authored for real wrangler shouldn't need modification.
 *
 * Flags are matched by exact name; the following token (value) is also
 * consumed when the flag is a known "takes a value" variant.
 */
export const WRANGLER_IGNORED_FLAGS = new Set<string>([
  '--ip', '--port', '--host',                    // local network flags — DO routes its own
  '--local', '--remote',                         // mode flags — we only do local-ish
  '--log-level', '--logfile',                    // logging routes through DO terminal
  '--inspect', '--inspect-brk', '--inspector-port', // devtools attach — not available
  '--live-reload',                               // HMR is built-in
  '--upstream-protocol', '--protocol',           // protocol selection
  '--experimental-json-config', '--experimental-vectorize-bind-to-prod',
]);
export const WRANGLER_IGNORED_FLAGS_WITH_VALUE = new Set<string>([
  '--ip', '--port', '--host', '--log-level', '--logfile',
  '--inspector-port', '--upstream-protocol', '--protocol',
]);

/**
 * Strip wrangler-specific flags (and their values when applicable) from
 * an argv slice. Returns both the cleaned args AND the list of ignored
 * tokens so the caller can log them (once) for transparency.
 */
export function filterWranglerFlags(argv: string[]): { args: string[]; ignored: string[] } {
  const out: string[] = [];
  const ignored: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Support `--flag=value` too.
    const eq = tok.indexOf('=');
    const base = eq >= 0 ? tok.slice(0, eq) : tok;
    if (WRANGLER_IGNORED_FLAGS.has(base)) {
      ignored.push(tok);
      if (eq < 0 && WRANGLER_IGNORED_FLAGS_WITH_VALUE.has(base) && i + 1 < argv.length) {
        // Consume the value token too (e.g. `--port 8787`).
        ignored.push(argv[i + 1]);
        i++;
      }
      continue;
    }
    out.push(tok);
  }
  return { args: out, ignored };
}

/**
 * wrangler.jsonc binding fields that require real wrangler / the real
 * Cloudflare runtime with proper binding provisioning. nimbus-wrangler
 * can bundle the Worker and load it via env.LOADER, but these bindings
 * are not wired up — the Worker will get `undefined` when it tries to
 * access them, which is usually a runtime crash.
 *
 * We don't refuse to start — some Workers use these bindings only on
 * certain paths or in a way that a runtime-undefined value just causes
 * a specific endpoint to fail. We warn LOUDLY so users know why their
 * Worker might crash.
 */
// Wrangler config top-level fields that represent bindings nimbus-wrangler
// can't fully provision. The warning is printed before build so the user
// knows WHY their inner Worker will crash when it tries to access one.
//
// This list is trimmed as new synthesis code lands:
//   Phase 0 (vars + services)       — removed `services`
//   Phase 1 (assets)                — removed `assets`
//   Phase 2 (worker_loaders)        — removed `worker_loaders`
//   Phase 3 (durable_objects)       — removed `durable_objects`
//   W10 (kv/d1/r2 emulation)        — removed `kv_namespaces`,
//                                     `d1_databases`, `r2_buckets`
//
// `vars` was never in this list because it's trivially synthesizable.
// Remaining fields genuinely can't be synthesized without the real CF
// platform (Queues/Vectorize/AI/Browser/Hyperdrive/Analytics/Dispatch)
// and would require building a full emulation layer.
export const WRANGLER_UNSUPPORTED_CONFIG_FIELDS = [
  'queues',
  'vectorize',
  'ai',
  'browser',
  'hyperdrive',
  'analytics_engine_datasets',
  'dispatch_namespaces',
];

/**
 * Read the user's wrangler config from the VFS and return any field names
 * from WRANGLER_UNSUPPORTED_CONFIG_FIELDS that are present and non-empty.
 *
 * Best-effort: tolerates JSONC comments and syntax errors (returns [] on
 * parse failure). The caller decides whether to warn or block — we only
 * report; nimbus-wrangler itself still runs.
 */
export function detectUnsupportedWranglerConfig(vfs: SqliteVFS, root: string): string[] {
  const candidates = [root + '/wrangler.jsonc', root + '/wrangler.json'];
  let text: string | null = null;
  for (const p of candidates) {
    try {
      if (vfs.exists(p)) { text = vfs.readFileString(p); break; }
    } catch {}
  }
  if (text == null) return [];

  // Strip JSONC comments for JSON.parse. Same logic as NimbusWrangler.readConfig
  // — kept local (and simple) so we don't couple detection to that class.
  let cleaned = '';
  let inString = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { cleaned += ch + (text[i + 1] || ''); i += 2; continue; }
      if (ch === '"') inString = false;
      cleaned += ch; i++;
    } else {
      if (ch === '"') { inString = true; cleaned += ch; i++; }
      else if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; }
      else { cleaned += ch; i++; }
    }
  }
  let cfg: any;
  try { cfg = JSON.parse(cleaned); } catch { return []; }
  if (!cfg || typeof cfg !== 'object') return [];

  const found: string[] = [];
  for (const field of WRANGLER_UNSUPPORTED_CONFIG_FIELDS) {
    const v = cfg[field];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    found.push(field);
  }
  return found;
}

/**
 * W8: classify a child_process spawn target by execution kind. Used by
 * the FacetProcessManager to decide between inline pure-builtin vs
 * facet-direct dispatch. See audit/sections/W8-plan.md §8.5 BLOCKER-2.
 *
 *   pure-builtin  — sync, no facet recursion. echo, cat, true, false,
 *                   ls, cd, env, sleep, mkdir, rm, … (all the unix
 *                   command shims in src/unix-commands.ts).
 *   facet-direct  — needs a fresh isolate. node, npm, npx, git, sh,
 *                   bash, husky, lefthook, the wranglers, vite, …
 *   unknown       — exit 127.
 */
export const _CP_FACET_DIRECT = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'git', 'sh', 'bash',
  'wrangler', 'nimbus-wrangler',
  'husky', 'lefthook', 'simple-git-hooks', 'lint-staged', 'yorkie',
  'vite', 'tsc', 'esbuild', 'rollup', 'webpack',
  // W11: framework CLIs — bare-name dispatch must reach a Node isolate
  // for npm-run-dev / direct-shell invocations to work. See
  // audit/sections/W11-plan.md §5 + reviewer comment 2.
  'astro', 'nuxt', 'nuxi', 'remix', 'svelte-kit', 'next',
]);
export const _CP_PURE_BUILTIN = new Set([
  'echo', 'cat', 'true', 'false', 'ls', 'pwd', 'cd', 'env', 'export',
  'unset', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'stat',
  'sleep', 'date', 'whoami', 'id', 'hostname', 'uname', 'clear',
  'tree', 'find', 'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'sed',
  'awk', 'xargs', 'tee', 'du', 'diff', 'base64', 'seq', 'realpath',
  'basename', 'dirname', 'printf', 'sha256sum', 'file', 'xxd',
  'chmod', 'chown', 'ln', 'test', '[', 'read', 'exit', 'set', 'shopt',
  'trap', 'umask', 'ulimit', 'which', 'uptime',
]);

/**
 * Classify a command name by kind. Returns null for unknown commands.
 *
 * Prefix-form rule: anything starting with `./`, `/`, or `node_modules/`
 * is treated as facet-direct so a registered bin script (or a node
 * fallthrough) can attempt to run it.
 */
export function _classifyCommand(name: string): { kind: 'pure-builtin' | 'facet-direct' | 'unknown' } | null {
  if (_CP_PURE_BUILTIN.has(name)) return { kind: 'pure-builtin' };
  if (_CP_FACET_DIRECT.has(name)) return { kind: 'facet-direct' };
  // Anything in node_modules/.bin or starting with ./ is treated as
  // facet-direct so the registered bin script (or a node fallthrough)
  // can attempt to run it.
  if (name.startsWith('./') || name.startsWith('/') || name.startsWith('node_modules/')) {
    return { kind: 'facet-direct' };
  }
  return null;
}

/**
 * Parse the first token of an npm script's command string and decide whether
 * it's a bundler/framework CLI that requires node_modules. Handles common
 * prefixes like `cross-env FOO=bar vite`, `node ./server.js`, and npx.
 *
 * Returns the detected bundler bin name (e.g. "vite") or null.
 */
export function detectBundlerBin(script: string): string | null {
  if (!script) return null;
  const tokens = script.trim().split(/\s+/);
  // Skip env-var assignments (FOO=bar) and wrapper commands (cross-env, npx).
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) { i++; continue; }        // FOO=bar
    if (t === 'cross-env' || t === 'env') { i++; continue; }     // env/cross-env wrappers
    if (t === 'npx') { i++; continue; }                           // npx vite
    break;
  }
  const bin = (tokens[i] || '').replace(/^\.\/node_modules\/\.bin\//, '');
  for (const pfx of BUNDLER_BIN_PREFIXES) {
    if (bin === pfx || bin.startsWith(pfx + '.')) return pfx;
  }
  return null;
}

/**
 * Check whether a project directory has installed dependencies.
 *
 * Returns { missing: true, depCount } if package.json declares deps AND
 * node_modules/ doesn't exist. `missing: false` when:
 *   - There's no package.json (we're not in a project, no guard needed)
 *   - package.json declares zero deps (no install needed)
 *   - node_modules/ exists (even if stale — caught by runtime error overlay)
 */
export function checkNodeModulesGuard(
  vfs: SqliteVFS,
  projectRoot: string,
): { missing: boolean; depCount: number } {
  try {
    const pkgPath = projectRoot + '/package.json';
    if (!vfs.exists(pkgPath)) return { missing: false, depCount: 0 };
    if (vfs.exists(projectRoot + '/node_modules')) return { missing: false, depCount: 0 };
    let depCount = 0;
    try {
      const pkg = JSON.parse(vfs.readFileString(pkgPath));
      depCount = Object.keys(pkg.dependencies || {}).length +
                 Object.keys(pkg.devDependencies || {}).length;
    } catch { /* unreadable package.json */ }
    // If the project declares zero deps, a missing node_modules/ is fine.
    if (depCount === 0) return { missing: false, depCount: 0 };
    return { missing: true, depCount };
  } catch {
    return { missing: false, depCount: 0 };
  }
}
