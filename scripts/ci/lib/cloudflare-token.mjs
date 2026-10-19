// The token Nimbus's scripts reach the Cloudflare API with: CLOUDFLARE_API_TOKEN
// when set (CI), otherwise the one wrangler's own login holds. Never printed.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.bin', 'wrangler');

/** @param {{ cwd: string, account: string }} options */
export function cloudflareApiToken({ cwd, account }) {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const done = spawnSync(WRANGLER, ['auth', 'token', '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new Error(`wrangler auth token --json exited ${done.status}: ${(done.stderr || '').slice(-300)}`);
  const { token } = JSON.parse(done.stdout);
  if (typeof token !== 'string' || !token) throw new Error('wrangler auth token --json printed no token');
  return token;
}
