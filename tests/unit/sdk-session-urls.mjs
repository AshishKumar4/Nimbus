import assert from 'node:assert/strict';
import { mintAndAttach, sessionAttachUrl } from '../../packages/sdk/src/session.ts';
import { verifyNimbusToken } from '../../packages/sdk/src/token.ts';
import { nimbusAttachUrl } from '../../packages/react/src/NimbusTerminal.tsx';

const endpoint = 'https://nimbus.example.test/old-prefix/?unrelated=value';
const token = 'spaces + punctuation&=?';
for (const sid of ['job_123.demo', undefined]) {
  const sdk = new URL(sessionAttachUrl(endpoint, sid, token));
  const react = new URL(nimbusAttachUrl(endpoint, token, sid));
  assert.equal(sdk.href, react.href);
  assert.equal(sdk.origin, 'https://nimbus.example.test');
  assert.equal(sdk.pathname, sid ? `/s/${sid}/` : '/new');
  assert.equal(sdk.searchParams.get('nimbus_token'), token);
  assert.equal(sdk.searchParams.has('unrelated'), false);
}
const env = { JWT_SECRET: 'attach-url-behavior-secret' };
const minted = await mintAndAttach(env, { tn: 'acme', scopes: ['session:attach'] }, { endpoint, sessionId: 'job_123', ttlMs: 60_000 });
assert.equal(new URL(minted.url).searchParams.get('nimbus_token'), minted.token);
assert.equal((await verifyNimbusToken(env, minted.token)).claims.tn, 'acme');
console.log('sdk-session-urls: ok');
