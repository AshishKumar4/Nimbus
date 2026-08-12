#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

const registry = new PortRegistry();
registry.bindFacetStub(42, {
  async handleHttpRequest(request) {
    return Response.json(Object.fromEntries(request.headers));
  },
});
registry.register(3000, 42);

const response = await registry.routeRequest(
  3000,
  new Request('https://nimbus-os.dev/s/nimble-otter-4271/port/3000/', {
    headers: {
      Authorization: 'Bearer nimbus-secret',
      'Proxy-Authorization': 'Basic nimbus-secret',
      // Every platform cookie must be stripped, not just `nimbus_token`:
      // `nimbus_agent_oauth` and `__Host-nimbus_demo_auth` seal the user's
      // Cloudflare OAuth access/refresh tokens.
      Cookie: [
        'theme=dark',
        'nimbus_token=secret.jwt',
        'nimbus_agent_oauth=sealed.cf.oauth',
        '__Host-nimbus_demo_auth=sealed.demo.auth',
        '__Host-nimbus_demo_state=state',
        'nimbus_token_extra=reserved-namespace',
        'session=user',
      ].join('; '),
      'X-Nimbus-Base': '/s/nimble-otter-4271',
      'X-Nimbus-Tenant': 'acme:alice',
      'X-Nimbus-Custom': 'internal',
      'X-User-Header': 'preserved',
    },
  }),
  '/',
);

assert.ok(response);
assert.equal(response.status, 200);
const received = await response.json();

assert.equal(received.authorization, undefined);
assert.equal(received['proxy-authorization'], undefined);
assert.equal(received['x-nimbus-base'], undefined);
assert.equal(received['x-nimbus-tenant'], undefined);
assert.equal(received['x-nimbus-custom'], undefined);
// `nimbus_` / `__Host-nimbus` / `__Secure-nimbus` is a namespace RESERVED for
// the platform, deliberately matched by prefix rather than by an enumerated
// list: an exact list fails open (it named one cookie of five and leaked the
// sealed OAuth cookies to user code), and this package cannot import the
// embedder's cookie names. A user app must not name its own cookie `nimbus_*`.
assert.equal(received.cookie, 'theme=dark; session=user');
assert.equal(received['x-user-header'], 'preserved');
assert.equal(received['x-nimbus-port'], '3000');

const credentialOnly = await registry.routeRequest(
  3000,
  new Request('https://nimbus-os.dev/s/nimble-otter-4271/port/3000/', {
    headers: { Cookie: 'nimbus_token=secret.jwt' },
  }),
  '/',
);
assert.ok(credentialOnly);
assert.equal((await credentialOnly.json()).cookie, undefined);

console.log('port-registry-credential-strip: ok');
