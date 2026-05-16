#!/usr/bin/env bun
// auth/new/extract-bearer-from-request — extractBearerToken pulls the
// token from each of the three places (header / query / cookie) with
// the documented precedence.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('auth/new/extract-bearer-from-request');

const { extractBearerToken } = await import('../../../../src/auth/middleware.ts');

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
// 4. Cookie.
{
  const r = new Request('https://x/y', { headers: { Cookie: 'nimbus_token=ctok; other=z' } });
  a.check('cookie → token', extractBearerToken(r) === 'ctok');
}
// 5. Precedence: header beats query beats cookie.
{
  const r = new Request('https://x/y?nimbus_token=qtok', {
    headers: { Authorization: 'Bearer htok', Cookie: 'nimbus_token=ctok' },
  });
  a.check('header beats query+cookie', extractBearerToken(r) === 'htok');
}
{
  const r = new Request('https://x/y?nimbus_token=qtok', {
    headers: { Cookie: 'nimbus_token=ctok' },
  });
  a.check('query beats cookie', extractBearerToken(r) === 'qtok');
}
// 6. None present → null.
{
  const r = new Request('https://x/y');
  a.check('nothing → null', extractBearerToken(r) === null);
}
// 7. URL-encoded cookie value.
{
  const r = new Request('https://x/y', { headers: { Cookie: 'nimbus_token=ab%2B%2Fcd' } });
  a.check('url-encoded cookie decoded', extractBearerToken(r) === 'ab+/cd');
}
// 8. Empty Authorization → fall through.
{
  const r = new Request('https://x/y?nimbus_token=qtok', { headers: { Authorization: '' } });
  a.check('empty Authorization → fall through to query', extractBearerToken(r) === 'qtok');
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
