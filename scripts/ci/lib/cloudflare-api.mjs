// The Cloudflare REST API as Nimbus's scripts reach it: the token
// (CLOUDFLARE_API_TOKEN when set, as in CI, otherwise the one wrangler's own
// login holds; never printed or logged), and one call under an account.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.bin', 'wrangler');
const CF_API = 'https://api.cloudflare.com/client/v4';
const run = promisify(execFile);

/** @param {{ cwd: string, account: string, signal?: AbortSignal }} options */
export async function cloudflareApiToken({ cwd, account, signal }) {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // wrangler also writes what it prints to its debug log on disk, unless told
  // not to; what it prints here is the token.
  const { stdout } = await run(WRANGLER, ['auth', 'token', '--json'], {
    cwd, signal, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_WRITE_LOGS: 'false' },
  });
  const { token } = JSON.parse(stdout);
  if (typeof token !== 'string' || !token) throw new Error('wrangler auth token --json printed no token');
  return token;
}

/**
 * A call that never reached the API because this host's resolver could not
 * answer for now (getaddrinfo EAI_AGAIN): nothing was asked, so asking again
 * is safe. Any answer the API gave, a refusal among them, is never one. Seen
 * 2026-10-21 failing two lanes' reads in the same seconds (16:23:45 UTC), and
 * again at 18:40.
 */
export class TransientTransportError extends Error {
  constructor(error) {
    super(error.message, { cause: error });
    this.name = 'TransientTransportError';
  }
}

/**
 * One API call under the account. Answers `{ ok, status, result, errors }`;
 * a transport failure throws, a TransientTransportError when it may pass.
 *
 * @param {string} path
 * @param {{ account: string, token: string, method?: string, body?: object, contentType?: string, signal?: AbortSignal, fetch?: typeof fetch }} options
 */
export async function cfApi(path, { account, token, method = 'GET', body, contentType = 'application/json', signal, fetch: request = globalThis.fetch }) {
  const response = await request(`${CF_API}/accounts/${account}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': contentType }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }).catch((error) => {
    throw error?.code === 'EAI_AGAIN' ? new TransientTransportError(error) : error;
  });
  const json = await response.json().catch((error) => {
    if (signal?.aborted) throw signal.reason ?? error;
    return {};
  });
  signal?.throwIfAborted();
  return { ok: response.ok && json.success === true, status: response.status, result: json.result ?? null, errors: json.errors ?? [] };
}
