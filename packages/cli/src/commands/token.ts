/**
 * cli/commands/token — `nimbus token mint` + `nimbus token verify`.
 *
 * Both verbs require `JWT_SECRET` in env. Mint writes the JWT to stdout
 * (so `nimbus token mint --tenant acme > /tmp/jwt` works in scripts);
 * verify parses a token from argv and prints the claims as JSON.
 */

import { issueNimbusToken, verifyNimbusToken } from '@nimbus-sh/sdk/token';
import { NimbusAuthError } from '@nimbus-sh/sdk/errors';

/**
 * Programmatic interface for token mint. Used by `bin.ts` and exported
 * from `@nimbus-sh/cli` so embedder scripts can call it directly.
 *
 * @example
 * ```ts
 * import { mintToken } from '@nimbus-sh/cli';
 * const code = await mintToken(['--tenant', 'acme', '--sub', 'alice']);
 * ```
 *
 * @param args Raw CLI args (after the `token mint` prefix).
 * @returns Process exit code (0 success, non-zero per
 *          `CLI_EXIT_CODES` semantics).
 */
export async function mintToken(args: string[]): Promise<number> {
  const parsed = parseArgs(args, ['--tenant', '--sub', '--ttl', '--scopes', '--sid']);
  const tn = parsed['--tenant'];
  const sub = parsed['--sub'];
  const ttlSec = parsed['--ttl'] ? Number(parsed['--ttl']) : undefined;
  const scopes = parsed['--scopes'] ? parsed['--scopes'].split(',').map((s) => s.trim()) : undefined;
  const sid = parsed['--sid'];

  if (!tn) {
    process.stderr.write('nimbus token mint: --tenant required\n');
    return 64;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    process.stderr.write('nimbus token mint: JWT_SECRET env var required\n');
    return 78;
  }

  try {
    const token = await issueNimbusToken(
      { JWT_SECRET: secret },
      { tn, sub, scopes, sid },
      ttlSec !== undefined ? { ttlMs: ttlSec * 1000 } : {},
    );
    process.stdout.write(`${token}\n`);
    return 0;
  } catch (e: unknown) {
    return reportError(e);
  }
}

/** `nimbus token verify <token>` — verify + print claims as JSON. */
export async function verifyTokenCmd(args: string[]): Promise<number> {
  const token = args[0];
  if (!token) {
    process.stderr.write('nimbus token verify: <token> argument required\n');
    return 64;
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    process.stderr.write('nimbus token verify: JWT_SECRET env var required\n');
    return 78;
  }

  try {
    const verified = await verifyNimbusToken({ JWT_SECRET: secret }, token);
    process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
    return 0;
  } catch (e: unknown) {
    return reportError(e);
  }
}

/** Map a NimbusAuthError or unknown error to a JSON stderr report. */
function reportError(e: unknown): number {
  if (e instanceof NimbusAuthError) {
    process.stderr.write(`${JSON.stringify({ error: e.message, code: e.code })}\n`);
    return e.httpStatus >= 500 ? 70 : 65;
  }
  process.stderr.write(`${JSON.stringify({ error: String((e as { message?: string })?.message ?? e), code: 'E_UNKNOWN' })}\n`);
  return 70;
}

/**
 * Mini argv parser. Long flags only (`--key value` or `--key=value`).
 * Returns a record of seen flags. Unknown flags are silently dropped
 * (matches Unix tradition).
 */
function parseArgs(args: string[], known: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    let key: string, val: string;
    if (eq >= 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    } else {
      key = a;
      val = args[i + 1] ?? '';
      i++;
    }
    if (known.includes(key)) out[key] = val;
  }
  return out;
}
