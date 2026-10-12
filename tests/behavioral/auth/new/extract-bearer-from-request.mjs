#!/usr/bin/env bun
// auth/new/extract-bearer-from-request — extractBearerToken pulls the
// token from each of the three places (header / query / cookie) with
// the documented precedence.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/extract-bearer-from-request');

const { extractBearerToken } = await import('../../../../packages/worker/src/auth/middleware.ts');

// 1. Authorization header.
{
  const r = new Request('https://x/y', { headers: { Authorization: 'Bearer abc123' } });
  a.check('header → token', extractBearerToken(r) === 'abc123');
}
// 2. Authorization header — case-insensitive Bearer.
{
  const r = new Request('https://x/y', { headers: { Authorization: 'bearer abc123' } });
  a.check('header lowercase bearer', extractBearerToken(r) === 'abc123');
}
// 3. Query parameter.
{
  const r = new Request('https://x/y?nimbus_token=qtok');
  a.check('query → token', extractBearerToken(r) === 'qtok');
}
// 4. Cookie: the route's own per-session name, then the legacy global name.
{
  const r = new Request('https://x/sid-1/', { headers: { Cookie: '__Host-nimbus_token-sid-1=ctok; other=z' } });
  a.check('route cookie → token', extractBearerToken(r, 'sid-1') === 'ctok');
}
{
  const r = new Request('https://x/sid-1/', { headers: { Cookie: '__Host-nimbus_token=legacy; other=z' } });
  a.check('legacy cookie → token', extractBearerToken(r, 'sid-1') === 'legacy');
}
{
  const r = new Request('https://x/sid-1/', { headers: { Cookie: '__Host-nimbus_token-sid-2=other; other=z' } });
  a.check('another session cookie is not selected', extractBearerToken(r, 'sid-1') === null);
}
{
  const r = new Request('https://x/y', { headers: { Cookie: '__Host-nimbus_token-sid-1=ctok' } });
  a.check('no sid → no cookie consulted', extractBearerToken(r) === null);
}
// 5. Precedence: header beats query beats cookie.
{
  const r = new Request('https://x/y?nimbus_token=qtok', {
    headers: { Authorization: 'Bearer htok', Cookie: '__Host-nimbus_token-sid-1=ctok' },
  });
  a.check('header beats query+cookie', extractBearerToken(r, 'sid-1') === 'htok');
}
{
  const r = new Request('https://x/y?nimbus_token=qtok', {
    headers: { Cookie: '__Host-nimbus_token-sid-1=ctok' },
  });
  a.check('query beats cookie', extractBearerToken(r, 'sid-1') === 'qtok');
}
// 6. None present → null.
{
  const r = new Request('https://x/y');
  a.check('nothing → null', extractBearerToken(r) === null);
}
// 7. URL-encoded cookie value.
{
  const r = new Request('https://x/sid-1/', { headers: { Cookie: '__Host-nimbus_token-sid-1=ab%2B%2Fcd' } });
  a.check('url-encoded cookie decoded', extractBearerToken(r, 'sid-1') === 'ab+/cd');
}
// 8. Empty Authorization → fall through.
{
  const r = new Request('https://x/y?nimbus_token=qtok', { headers: { Authorization: '' } });
  a.check('empty Authorization → fall through to query', extractBearerToken(r) === 'qtok');
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
