// _mint-probe-token.mjs — mint a short-lived token for the probe target.
//
// Usage:
//   NIMBUS_PROBE_JWT_SECRET=<secret> bun tests/behavioral/_mint-probe-token.mjs
//
// Prints a JWT (default 1h TTL) carrying the scopes the behavioral
// driver needs: session create/attach/destroy plus remote sandbox use.
// CI runs this right before run-all.mjs and exports the output as
// NIMBUS_PROBE_TOKEN; only the signing secret is stored durably.
//
// `_throwaway-target.mjs` imports `mintProbeToken` for the same job
// against a self-deployed throwaway target.

const { issueNimbusToken } = await import('../../packages/worker/src/auth/token.ts');

/** Every scope the behavioral driver exercises against a probe target. */
export const PROBE_SCOPES = [
  'session:create',
  'session:attach',
  'session:destroy',
  'sandbox:use',
];

/**
 * Mint an unpinned probe token. No `sid` claim, so one token drives every
 * session the run creates.
 */
export async function mintProbeToken(secret, ttlMs) {
  return issueNimbusToken(
    { JWT_SECRET: secret },
    { tn: 'probe', scopes: PROBE_SCOPES },
    ttlMs ? { ttlMs } : {},
  );
}

if (import.meta.main) {
  const secret = process.env.NIMBUS_PROBE_JWT_SECRET;
  if (!secret) {
    console.error('NIMBUS_PROBE_JWT_SECRET is required');
    process.exit(2);
  }
  const ttlMs = process.env.NIMBUS_PROBE_TOKEN_TTL_MS
    ? Number(process.env.NIMBUS_PROBE_TOKEN_TTL_MS)
    : undefined;
  process.stdout.write(await mintProbeToken(secret, ttlMs));
}
