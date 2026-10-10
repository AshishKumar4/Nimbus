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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseRuntimeCatalog } from '@nimbus-sh/worker/runtime/catalog';

const nodeRequire = createRequire(import.meta.url);
const DEFAULT_BUCKET = 'nimbus-runtime-cache-public';

/**
 * Sync runtime blobs to an R2 bucket via the bundled worker helper.
 *
 * @example
 * ```bash
 * # BYOA mode — sync into your own bucket.
 * CLOUDFLARE_ACCOUNT_ID=… nimbus runtime sync --bucket my-runtime-cache python
 * ```
 */
export async function syncRuntimes(args: string[], options: { scriptPath?: string } = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      bucket: { type: 'string' }, runtimes: { type: 'string', multiple: true },
    } });
  } catch (error) {
    process.stderr.write(`nimbus runtime sync: ${error instanceof Error ? error.message : error}\n`);
    return 64;
  }
  const bucket = parsed.values.bucket ?? DEFAULT_BUCKET;

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.stderr.write('nimbus runtime sync: CLOUDFLARE_ACCOUNT_ID env var required\n');
    return 78;
  }

  // Locate the runtime sync helper in `@nimbus-sh/worker` (a test names its own copy).
  const scriptPath = options.scriptPath ?? resolveBundleRuntimeScript();
  if (!scriptPath) {
    process.stderr.write('nimbus runtime sync: cannot locate Nimbus runtime sync helper\n');
    return 70;
  }

  const { SPECS } = await import(new URL('./runtime-specs.mjs', pathToFileURL(scriptPath)).href) as {
    SPECS: Record<string, { cliDefaultSync?: boolean; ingest_only?: boolean }>;
  };
  const publishers = Object.entries(SPECS).filter(([, spec]) => !spec.ingest_only);
  const requested = parsed.tokens.flatMap((token) => {
    if (token.kind === 'positional') return [token.value];
    return token.kind === 'option' && token.name === 'runtimes'
      ? token.value.split(',').map((name) => name.trim()).filter(Boolean) : [];
  });
  const runtimes = requested.length ? requested
    : publishers.filter(([, spec]) => spec.cliDefaultSync).map(([key]) => key.split('/')[0]);
  const selected = [];
  for (const rt of runtimes) {
    const [name, explicitVersion] = rt.split('@');
    const versions = publishers.filter(([key]) => key.startsWith(`${name}/`));
    const version = explicitVersion || (versions.length === 1 ? versions[0][0].slice(name.length + 1) : undefined);
    if (!version || !SPECS[`${name}/${version}`] || SPECS[`${name}/${version}`].ingest_only) {
      process.stderr.write(`nimbus runtime sync: unknown or ambiguous runtime "${rt}" (use a publisher-supported name@version)\n`);
      return 64;
    }
    selected.push({ rt, name, version });
  }

  process.stderr.write(`nimbus: syncing runtimes [${runtimes.join(', ')}] → r2://${bucket}\n`);

  let catalogSha256: string | null = null;
  for (const { rt, name, version } of selected) {
    const { code, catalogSha256: published } = await runOne(scriptPath, [name, version, '--bucket', bucket]);
    if (code !== 0) {
      process.stderr.write(`nimbus runtime sync: ${rt} failed (exit ${code})\n`);
      return code;
    }
    catalogSha256 = published;
  }
  if (catalogSha256 === null) {
    process.stderr.write('nimbus runtime sync: the publisher did not report the catalog it wrote\n');
    return 70;
  }
  // Each publish rewrote the catalog: the last one is what the bucket holds now.
  process.stderr.write(
    `nimbus: the Worker that binds r2://${bucket} must carry\n` +
    `  "vars": { "NIMBUS_RUNTIME_CATALOG_SHA256": "${catalogSha256}" }\n` +
    '  (buildNimbusWranglerConfig: runtimeCatalogSha256). Redeploy it after changing the value.\n',
  );
  process.stdout.write(JSON.stringify({ ok: true, bucket, runtimes, catalogSha256 }) + '\n');
  return 0;
}

/** `nimbus runtime list` — print the selected bucket's actual defaults. */
export async function listRuntimes(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { bucket: { type: 'string' } } }).values;
  } catch (error) {
    process.stderr.write(`nimbus runtime list: ${error instanceof Error ? error.message : error}\n`);
    return 64;
  }
  try {
    const catalog = parseRuntimeCatalog(JSON.parse(await readCatalog(parsed.bucket ?? DEFAULT_BUCKET)));
    const rows = Object.entries(catalog.runtimes).map(([name, entry]) => {
      const version = entry.versions[entry.default];
      if (!version) throw new Error(`Catalog runtime ${name} has no default version ${entry.default}`);
      return { name, version: entry.default, size_mb: version.size_bytes / 1024 / 1024, license: version.license };
    });
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(`nimbus runtime list: ${error instanceof Error ? error.message : error}\n`);
    return 70;
  }
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

/** The line bundle-runtime.mjs prints after every catalog it writes, whatever the bucket: the catalog it left there. */
const CATALOG_PIN_LINE = /^NIMBUS_RUNTIME_CATALOG_SHA256=([a-f0-9]{64})$/m;

/**
 * Run the publisher for one runtime, its output passed through as it comes,
 * and the catalog digest it reports (null if it reported none).
 */
function runOne(scriptPath: string, args: string[]): Promise<{ code: number; catalogSha256: string | null }> {
  return new Promise((resolveExit) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => resolveExit({ code: code ?? 1, catalogSha256: CATALOG_PIN_LINE.exec(output)?.[1] ?? null }));
    child.on('error', (e) => {
      process.stderr.write(`spawn error: ${e.message}\n`);
      resolveExit({ code: 70, catalogSha256: null });
    });
  });
}

function readCatalog(bucket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/catalog/v1.json`, '--pipe', '--remote'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env, shell: process.platform === 'win32',
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { errors += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(errors.trim() || `Wrangler exited ${code}`)));
  });
}
