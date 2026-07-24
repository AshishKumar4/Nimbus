#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';

const registry = new PortRegistry();
registry.register(3000, 42, {
  async handleHttpRequest(request) {
    return Response.json(Object.fromEntries(request.headers));
  },
});

const response = await registry.routeRequest(
  3000,
  new Request('https://nimbus-os.dev/s/nimble-otter-4271/port/3000/', {
    headers: {
      Authorization: 'Bearer nimbus-secret',
      Cookie: 'theme=dark; nimbus_token=secret.jwt; nimbus_token_extra=user-value; session=user',
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
assert.equal(received['x-nimbus-base'], undefined);
assert.equal(received['x-nimbus-tenant'], undefined);
assert.equal(received['x-nimbus-custom'], undefined);
assert.equal(
  received.cookie,
  'theme=dark; nimbus_token_extra=user-value; session=user',
);
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
