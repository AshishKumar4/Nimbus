import { spawn } from 'node:child_process';
import { syncRuntimes } from './runtime-sync.js';
import { parseArgs } from 'node:util';
import { buildNimbusWranglerConfig } from '@nimbus-sh/config';

export async function setupCloudflare(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: {
      name: { type: 'string' }, 'bucket-prefix': { type: 'string' },
      'runtime-bucket': { type: 'string' }, 'skip-runtimes': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    } }).values;
  } catch (error) {
    process.stderr.write(`nimbus setup cloudflare: ${error instanceof Error ? error.message : error}\n`);
    return 64;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const opts = {
    name: parsed.name, bucketPrefix: parsed['bucket-prefix'],
    runtimeBucket: parsed['runtime-bucket'], skipRuntimes: parsed['skip-runtimes'],
  };
  if (!opts.name) {
    process.stderr.write('nimbus setup cloudflare: --name <worker-name> required\n');
    printHelp();
    return 64;
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.stderr.write('nimbus setup cloudflare: CLOUDFLARE_ACCOUNT_ID env var required\n');
    return 78;
  }

  const config = buildNimbusWranglerConfig({
    name: opts.name, r2BucketPrefix: opts.bucketPrefix || undefined,
    runtimeCache: opts.runtimeBucket ? { mode: 'byoa', bucket: opts.runtimeBucket } : 'shared',
  });
  const buckets = config.r2_buckets.map(({ bucket_name }) => bucket_name);
  const runtimeBucket = config.r2_buckets.find(({ binding }) => binding === 'NIMBUS_RUNTIME_CACHE')!.bucket_name;

  process.stderr.write(`nimbus: preparing Cloudflare account for ${opts.name}\n`);
  for (const bucket of buckets) {
    const code = await runWrangler(['r2', 'bucket', 'create', bucket], {
      okOnAlreadyExists: true,
    });
    if (code !== 0) {
      process.stderr.write(
        'nimbus setup cloudflare: R2 bucket setup failed. If Wrangler printed code 10042, enable R2 in the Cloudflare Dashboard and rerun this command.\n',
      );
      return code;
    }
  }

  if (!opts.skipRuntimes) {
    const code = await syncRuntimes(['--bucket', runtimeBucket]);
    if (code !== 0) return code;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    worker: opts.name,
    buckets,
    runtimeBucket,
    runtimesSynced: !opts.skipRuntimes,
  }) + '\n');
  return 0;
}

function runWrangler(args: string[], opts: { okOnAlreadyExists?: boolean } = {}): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn('npx', ['wrangler', ...args], {
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let combined = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      combined += text;
      process.stderr.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      combined += text;
      process.stderr.write(text);
    });
    child.on('exit', (code) => {
      if (code === 0) return resolveExit(0);
      if (opts.okOnAlreadyExists && /already exists|bucket.*exists/i.test(combined)) {
        return resolveExit(0);
      }
      return resolveExit(code ?? 1);
    });
    child.on('error', (e) => {
      process.stderr.write(`nimbus setup cloudflare: failed to run wrangler: ${e.message}\n`);
      resolveExit(70);
    });
  });
}

function printHelp(): void {
  process.stdout.write(`nimbus setup cloudflare

Usage:
  nimbus setup cloudflare --name <worker-name>

Options:
  --name <worker-name>       Deployed Cloudflare Worker name. Required.
  --bucket-prefix <prefix>   Prefix for npm cache buckets. Defaults to --name.
  --runtime-bucket <bucket>  Runtime cache bucket. Defaults to nimbus-runtime-cache-public.
  --skip-runtimes            Create buckets only; do not upload Python/Ruby/clang runtime blobs.

Env:
  CLOUDFLARE_ACCOUNT_ID      Cloudflare account to prepare. Required.
`);
}
