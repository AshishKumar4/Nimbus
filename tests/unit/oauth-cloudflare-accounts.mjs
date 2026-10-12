import assert from 'node:assert/strict';
import { fetchNimbusCloudflareAccounts, NIMBUS_CLOUDFLARE_API } from '../../packages/core/src/_shared/oauth.ts';

const realFetch = globalThis.fetch;
const accountId = 'a'.repeat(32);
const otherId = 'b'.repeat(32);
let response;
try {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `${NIMBUS_CLOUDFLARE_API}/accounts`);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer account-token');
    assert.equal(headers.get('Accept'), 'application/json');
    return response;
  };
  for (const metadata of [{ errors: null }, {}, { error: 123, error_description: {}, errors: 'unused' }]) {
    response = Response.json({ result: [{ id: accountId, name: 'Account' }, { id: otherId }, { id: 'invalid', name: 'Not an account' }], ...metadata });
    assert.deepEqual(await fetchNimbusCloudflareAccounts('account-token'), [
      { id: accountId, name: 'Account' }, { id: otherId, name: otherId },
    ], 'only result controls a successful account lookup');
  }
  response = Response.json({ result: [{ id: accountId, name: '  Account  ' }, { id: otherId, name: ' \n ' }] });
  assert.deepEqual(await fetchNimbusCloudflareAccounts('account-token'), [
    { id: accountId, name: 'Account' }, { id: otherId, name: otherId },
  ], 'names are trimmed; a blank name falls back to its account id');
  response = Response.json({ result: [] });
  assert.deepEqual(await fetchNimbusCloudflareAccounts('account-token'), [], 'a valid empty result stays empty');
  response = Response.json({ result: [{ id: accountId }] });
  assert.deepEqual(await fetchNimbusCloudflareAccounts('account-token'), [{ id: accountId, name: accountId }]);

  for (const body of ['not JSON', 'null', '[]', '42', '"accounts"', '{}', '{"result":null}', '{"result":{}}', '{"result":[{"id":7}]}']) {
    for (const status of [200, 206]) {
      response = new Response(body, { status });
      await assert.rejects(() => fetchNimbusCloudflareAccounts('account-token'), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.status, status);
        assert.ok(error.message.includes(`HTTP ${status}`), error.message);
        assert.ok(error.cause instanceof Error, 'JSON parsing and result validation retain their cause');
        if (body === 'not JSON') assert.ok(error.cause instanceof SyntaxError);
        return true;
      });
    }
  }
  for (const [payload, detail] of [
    [{ error: 'denied', error_description: 'Token expired' }, 'Token expired'],
    [{ error: 'denied' }, 'denied'],
    [{ errors: [{ code: 123 }, { message: 'Account access denied' }] }, 'Account access denied'],
  ]) {
    response = Response.json(payload, { status: 403 });
    await assert.rejects(() => fetchNimbusCloudflareAccounts('account-token'), (error) => {
      assert.equal(error.status, 403);
      assert.ok(error.message.includes(detail), error.message);
      return true;
    });
  }
  response = new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' });
  await assert.rejects(() => fetchNimbusCloudflareAccounts('account-token'), (error) => {
    assert.equal(error.status, 502);
    assert.ok(error.message.includes('HTTP 502'));
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
} finally {
  globalThis.fetch = realFetch;
}
console.log('oauth-cloudflare-accounts: ok');
