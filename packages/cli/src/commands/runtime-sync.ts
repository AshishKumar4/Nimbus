/**
 * cli/commands/runtime-sync — Re-runs the runtime-bundle pipeline that
 * populates an R2 bucket with the clang / python / ruby blobs.
 *
 * Two modes:
 *   - Default (no --bucket): syncs the canonical Nimbus-operated bucket
 *     `nimbus-runtime-cache-public` for the catalog the project ships
 *     today. This is what we run; embedders typically don't need it.
 *   - `--bucket <name>`: BYOA mode — syncs into the embedder's own R2
 *     bucket. Used by embedders who don't want to bind to our shared
 *     bucket (see /workspace/.seal-internal/2026-05-15-sdk-design/research.md
 *     §4.2 "Option Tier-2-B").
 *
 * Implementation: shells out to wrangler r2 object put for each blob
 * listed in `@nimbus-sh/worker`'s bundled `scripts/bundle-runtime.mjs`.
 * The actual fetch+verify+upload work lives in that script; this CLI
 * is a thin proxy.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Sync runtime blobs to an R2 bucket via the bundled
 * `bundle-runtime.mjs` script.
 *
 * @example
 * ```bash
 * # BYOA mode — sync into your own bucket.
 * CLOUDFLARE_ACCOUNT_ID=… npx @nimbus-sh/cli runtime sync --bucket my-nimbus-runtime
 * ```
 */
export async function syncRuntimes(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  const bucket = parsed['--bucket'] ?? 'nimbus-runtime-cache-public';
  const runtimes = parsed['--runtimes']?.split(',') ?? ['clang', 'python', 'ruby'];

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.stderr.write('nimbus runtime sync: CLOUDFLARE_ACCOUNT_ID env var required\n');
    return 78;
  }

  // Locate the bundle-runtime.mjs script in `@nimbus-sh/worker`. When
  // installed via npm, resolve via require; in workspace dogfood, use
  // a relative path.
  const scriptPath = resolveBundleRuntimeScript();
  if (!scriptPath) {
    process.stderr.write('nimbus runtime sync: cannot locate @nimbus-sh/worker/scripts/bundle-runtime.mjs\n');
    return 70;
  }

  process.stderr.write(`nimbus: syncing runtimes [${runtimes.join(', ')}] → r2://${bucket}\n`);

  for (const rt of runtimes) {
    const code = await runOne(scriptPath, [rt, '--bucket', bucket]);
    if (code !== 0) {
      process.stderr.write(`nimbus runtime sync: ${rt} failed (exit ${code})\n`);
      return code;
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, bucket, runtimes }) + '\n');
  return 0;
}

/** `nimbus runtime list` — print the catalog the SDK ships against. */
export async function listRuntimes(_args: string[]): Promise<number> {
  // v0.1: print the static known-list. v0.2 will fetch the live
  // catalog.json from R2.
  const catalog = [
    { name: 'clang', version: 'binji-2020', size_mb: 9, license: 'Apache-2.0-LLVM' },
    { name: 'python', version: 'pyodide-0.29.4', size_mb: 10, license: 'MPL-2.0' },
    { name: 'ruby', version: 'ruby.wasm-2.9.4', size_mb: 25, license: 'BSD-2-Clause' },
  ];
  process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────

function resolveBundleRuntimeScript(): string | null {
  // 1. Try resolving via the @nimbus-sh/worker package (npm-installed).
  try {
    const url = new URL(
      '../../../node_modules/@nimbus-sh/worker/scripts/bundle-runtime.mjs',
      import.meta.url,
    );
    return fileURLToPath(url);
  } catch {
    // fallthrough
  }
  // 2. Workspace dogfood — relative path inside the monorepo.
  try {
    const wsUrl = new URL(
      '../../../worker/scripts/bundle-runtime.mjs',
      import.meta.url,
    );
    return fileURLToPath(wsUrl);
  } catch {
    return null;
  }
}

function runOne(scriptPath: string, args: string[]): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolveExit(code ?? 1));
    child.on('error', (e) => {
      process.stderr.write(`spawn error: ${e.message}\n`);
      resolveExit(70);
    });
  });
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    out[a] = args[i + 1] ?? '';
    i++;
  }
  return out;
}
