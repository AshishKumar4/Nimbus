#!/usr/bin/env bun

/**
 * The port registry reports what each port's documents say about
 * cross-origin isolation, as the browser will read the same headers.
 *
 * The shell decides whether to offer the isolated workspace from this report
 * (`stats.ports[].document`), so it must come from the guest's own navigation
 * responses: a subresource or a redirect is not the document the browser
 * isolates, and a new process on the port starts with no report. COEP and
 * COOP are Structured Field items (RFC 8941), so a value that does not parse
 * is the default policy; CORP is compared byte for byte.
 */

import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';

function registryAnswering(headersFor) {
  const registry = new PortRegistry();
  registry.bindFacetStub(7, {
    handleHttpRequest: async (request) => {
      const { status = 200, headers = {} } = headersFor(new URL(request.url).pathname);
      return new Response(status === 302 || status === 304 ? null : 'body', { status, headers });
    },
  });
  registry.register(3000, 7);
  return registry;
}

async function visit(registry, path, mode = 'navigate') {
  const response = await registry.routeRequest(
    3000,
    new Request(`https://nimbus-os.dev/s/quiet-otter-1/port/3000${path}`, { headers: { 'Sec-Fetch-Mode': mode } }),
    path,
  );
  await response.body?.cancel();
}

const reported = (registry) => registry.stats.ports.find((entry) => entry.port === 3000).document;

// Nothing is reported before the port has served a document.
{
  const registry = registryAnswering(() => ({}));
  assert.equal(reported(registry), null);
}

// COEP and COOP as the browser obtains them.
for (const [coep, embedderPolicy] of [
  ['require-corp', 'require-corp'],
  ['credentialless', 'credentialless'],
  ['  require-corp  ', 'require-corp'],
  ['require-corp; report-to="coep"', 'require-corp'],
  ['credentialless;report-to="a;b"', 'credentialless'],
  ['require-corp;report-to=endpoint;v=1.5;flag', 'require-corp'],
  ['unsafe-none', 'unsafe-none'],
  // Tokens are case-sensitive, a list is not an item, and a value that fails
  // to parse anywhere is no policy at all.
  ['Require-Corp', 'unsafe-none'],
  ['require-corp, credentialless', 'unsafe-none'],
  ['require-corp;', 'unsafe-none'],
  ['require-corp;report-to="unterminated', 'unsafe-none'],
  ['"require-corp"', 'unsafe-none'],
  ['require-corp credentialless', 'unsafe-none'],
  ['constructor', 'unsafe-none'],
]) {
  const registry = registryAnswering(() => ({ headers: { 'Cross-Origin-Embedder-Policy': coep } }));
  await visit(registry, '/');
  assert.equal(reported(registry).embedderPolicy, embedderPolicy, `COEP ${JSON.stringify(coep)}`);
}
for (const [coop, openerPolicy] of [
  ['same-origin', 'same-origin'],
  ['same-origin-allow-popups; report-to="x"', 'same-origin-allow-popups'],
  ['noopener-allow-popups', 'noopener-allow-popups'],
  ['Same-Origin', 'unsafe-none'],
]) {
  const registry = registryAnswering(() => ({ headers: { 'Cross-Origin-Opener-Policy': coop } }));
  await visit(registry, '/');
  assert.equal(reported(registry).openerPolicy, openerPolicy, `COOP ${JSON.stringify(coop)}`);
}

// CORP byte for byte.
for (const [corp, resourcePolicy] of [
  ['same-origin', 'same-origin'],
  ['same-site', 'same-site'],
  ['cross-origin', 'cross-origin'],
  ['Cross-Origin', null],
  ['same-site, same-origin', null],
]) {
  const registry = registryAnswering(() => ({ headers: { 'Cross-Origin-Resource-Policy': corp } }));
  await visit(registry, '/');
  assert.equal(reported(registry).resourcePolicy, resourcePolicy, `CORP ${JSON.stringify(corp)}`);
}

// Only documents count: a subresource and a redirect leave the report alone.
{
  const registry = registryAnswering((path) => {
    if (path === '/app') return { headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } };
    if (path === '/go') return { status: 302, headers: { Location: '/app' } };
    return {};
  });
  await visit(registry, '/app');
  const app = { embedderPolicy: 'require-corp', openerPolicy: 'unsafe-none', resourcePolicy: 'same-origin' };
  assert.deepEqual(reported(registry), app);
  await visit(registry, '/style.css', 'no-cors');
  await visit(registry, '/api', 'cors');
  assert.deepEqual(reported(registry), app, 'a subresource is not the document');
  await visit(registry, '/go');
  assert.deepEqual(reported(registry), app, 'a redirect is not the document');
  await visit(registry, '/plain');
  assert.deepEqual(reported(registry), { embedderPolicy: 'unsafe-none', openerPolicy: 'unsafe-none', resourcePolicy: null }, 'the last document wins');
}

// A new process on the port starts over.
{
  const registry = registryAnswering(() => ({ headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' } }));
  await visit(registry, '/');
  assert.equal(reported(registry).embedderPolicy, 'require-corp');
  registry.bindFacetStub(8, { handleHttpRequest: async () => new Response('next') });
  registry.register(3000, 8);
  assert.equal(reported(registry), null, 'a new registration has served nothing yet');
}

console.log('port-registry-document-policy: ok');
