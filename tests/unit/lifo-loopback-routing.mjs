#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { Sandbox } from '../../packages/worker/src/substrate/lifo/sandbox/Sandbox.ts';
import { createHttp } from '../../packages/worker/src/substrate/lifo/node-compat/http.ts';

const box = await Sandbox.create({ persist: false });
const originalFetch = globalThis.fetch;
const routed = [];
const fetched = [];

try {
  box.kernel.routeLoopback = async (port, request) => {
    routed.push({ port, request });
    if (port !== 5000) return null;
    return new Response('facet-loopback-body', {
      status: 200,
      headers: { 'X-Loopback': 'session-port-registry' },
    });
  };
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://dns.google/resolve?')) {
      return Response.json({ Status: 0, Answer: [{ data: '192.0.2.1', type: 1 }] });
    }
    fetched.push({ input, init });
    return new Response('external-body', { status: 200 });
  };

  for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']) {
    const result = await box.commands.run(`curl -s http://${host}:5000/path?q=1`);
    assert.equal(result.exitCode, 0, `${host}: exitCode`);
    assert.equal(result.stdout, 'facet-loopback-body\n', `${host}: stdout`);
    assert.equal(result.stderr, '', `${host}: stderr`);
  }
  assert.equal(routed.length, 4);
  assert.equal(fetched.length, 0, 'loopback registry hits must not reach external fetch');
  assert.equal(routed[0].port, 5000);
  assert.equal(routed[0].request.method, 'GET');
  assert.equal(new URL(routed[0].request.url).pathname, '/path');
  assert.equal(new URL(routed[0].request.url).search, '?q=1');

  const miss = await box.commands.run('curl -s http://127.0.0.1:5999/missing');
  assert.equal(miss.exitCode, 7);
  assert.equal(miss.stdout, '');
  assert.match(miss.stderr, /curl: \(7\) Failed to connect to 127\.0\.0\.1 port 5999/);
  assert.doesNotMatch(miss.stdout + miss.stderr, /error code: 1003/);
  assert.equal(fetched.length, 0, 'loopback registry misses must not reach external fetch');

  const external = await box.commands.run('curl -s https://example.test/resource');
  assert.equal(external.exitCode, 0);
  assert.equal(external.stdout, 'external-body\n');
  assert.equal(external.stderr, '');
  assert.equal(fetched.length, 1, 'non-loopback requests still use external fetch');
  assert.equal(String(fetched[0].input), 'https://example.test/resource');

  const http = createHttp(new Map(), 'http:', box.kernel.routeLoopback);
  const nodeCompatBody = await new Promise((resolve, reject) => {
    http.get('http://0.0.0.0:5000/node-client', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.equal(nodeCompatBody, 'facet-loopback-body');
  assert.equal(fetched.length, 1, 'node-compatible loopback requests must not reach external fetch');

  const nodeCompatError = await new Promise((resolve) => {
    http.get('http://[::1]:5999/missing').on('error', resolve);
  });
  assert.match(String(nodeCompatError), /ECONNREFUSED \[::1\]:5999/);
  assert.equal(fetched.length, 1, 'node-compatible loopback misses must not reach external fetch');
} finally {
  globalThis.fetch = originalFetch;
  box.destroy();
}

console.log('lifo-loopback-routing: ok');
