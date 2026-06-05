import { spawn } from 'node:child_process';
import { syncRuntimes } from './runtime-sync.js';

interface SetupOptions {
  name?: string;
  bucketPrefix?: string;
  runtimeBucket?: string;
  skipRuntimes: boolean;
}

export async function setupCloudflare(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return 0;
  }

  const opts = parseFlags(args);
  if (!opts.name) {
    process.stderr.write('nimbus setup cloudflare: --name <worker-name> required\n');
    printHelp();
    return 64;
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.stderr.write('nimbus setup cloudflare: CLOUDFLARE_ACCOUNT_ID env var required\n');
    return 78;
  }

  const prefix = opts.bucketPrefix || opts.name;
  const runtimeBucket = opts.runtimeBucket || 'nimbus-runtime-cache-public';
  const buckets = [
    `${prefix}-npm-cache`,
    `${prefix}-npm-packument-cache`,
    runtimeBucket,
  ];

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
    const code = await syncRuntimes(['--bucket', runtimeBucket, 'clang', 'python', 'ruby']);
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

function parseFlags(args: string[]): SetupOptions {
  const out: SetupOptions = { skipRuntimes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name') {
      out.name = args[++i] || '';
      continue;
    }
    if (a === '--bucket-prefix') {
      out.bucketPrefix = args[++i] || '';
      continue;
    }
    if (a === '--runtime-bucket') {
      out.runtimeBucket = args[++i] || '';
      continue;
    }
    if (a === '--skip-runtimes') {
      out.skipRuntimes = true;
      continue;
    }
  }
  return out;
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
