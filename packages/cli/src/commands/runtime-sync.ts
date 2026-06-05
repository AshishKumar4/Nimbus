/**
 * cli/commands/runtime-sync — Re-runs the runtime-bundle pipeline that
 * populates an R2 bucket with the clang / python / ruby blobs.
 *
 * Two modes:
 *   - Default (no --bucket): syncs the canonical Nimbus-operated bucket
 *     `nimbus-runtime-cache-public` for the catalog the project ships
 *     today. This is what we run; embedders typically don't need it.
 *   - `--bucket <name>`: BYOA mode. Runtime names may be positional
 *     (`nimbus runtime sync python clang`) or comma-separated via
 *     `--runtimes python,clang`.
 *
 * Implementation: shells out to the runtime bundling helper shipped in
 * `@nimbus-sh/worker`. The CLI is the supported operator entrypoint.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const DEFAULT_RUNTIME_VERSIONS: Record<string, string> = {
  clang: 'binji-2020',
  python: '0.29.4',
  ruby: '3.3.4',
};

/**
 * Sync runtime blobs to an R2 bucket via the bundled worker helper.
 *
 * @example
 * ```bash
 * # BYOA mode — sync into your own bucket.
 * CLOUDFLARE_ACCOUNT_ID=… nimbus runtime sync --bucket my-runtime-cache python
 * ```
 */
export async function syncRuntimes(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  const bucket = parsed.bucket ?? 'nimbus-runtime-cache-public';
  const runtimes = parsed.runtimes.length > 0
    ? parsed.runtimes
    : ['clang', 'python', 'ruby'];

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.stderr.write('nimbus runtime sync: CLOUDFLARE_ACCOUNT_ID env var required\n');
    return 78;
  }

  // Locate the runtime sync helper in `@nimbus-sh/worker`.
  const scriptPath = resolveBundleRuntimeScript();
  if (!scriptPath) {
    process.stderr.write('nimbus runtime sync: cannot locate Nimbus runtime sync helper\n');
    return 70;
  }

  process.stderr.write(`nimbus: syncing runtimes [${runtimes.join(', ')}] → r2://${bucket}\n`);

  for (const rt of runtimes) {
    const [name, explicitVersion] = rt.split('@');
    const version = explicitVersion || DEFAULT_RUNTIME_VERSIONS[name];
    if (!version) {
      process.stderr.write(`nimbus runtime sync: unknown runtime "${rt}" (use name@version)\n`);
      return 64;
    }
    const code = await runOne(scriptPath, [name, version, '--bucket', bucket]);
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
  try {
    const script = nodeRequire.resolve('@nimbus-sh/worker/runtime-sync-helper');
    if (existsSync(script)) return script;
  } catch {
    // Source-workspace mode can run before workspace packages are linked.
  }

  try {
    const script = fileURLToPath(new URL('../../../worker/scripts/bundle-runtime.mjs', import.meta.url));
    return existsSync(script) ? script : null;
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

function parseFlags(args: string[]): { bucket?: string; runtimes: string[] } {
  const out: { bucket?: string; runtimes: string[] } = { runtimes: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bucket') {
      out.bucket = args[i + 1] ?? '';
      i++;
      continue;
    }
    if (a === '--runtimes') {
      out.runtimes.push(...(args[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    out.runtimes.push(a);
  }
  return out;
}
