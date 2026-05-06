#!/usr/bin/env bun
// X5M-M1 functional: http.Server class has a setTimeout(ms, cb) method.
//
// fastify's lib/server.js calls server.setTimeout(connectionTimeout); the
// pre-fix Server class lacks this method. This probe inspects the generated
// shim source (since the shim references runtime globals we can't easily
// instantiate in a probe) and asserts the method is declared inside the
// http.Server class body with a chainable shape.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';
import { getShimSource, extractClass } from './_eval-shims.mjs';

const src = getShimSource();
const serverClass = extractClass(src, 'Server');

group('http.Server class is present in shim source', () => {
  ok('extractClass("Server") found a block', serverClass !== null);
  ok('Server extends __eventsMod', /class Server extends __eventsMod/.test(src));
});

group('Server.setTimeout method declaration is present', () => {
  ok('serverClass body contains "setTimeout"',
    serverClass !== null && /\bsetTimeout\s*\(/.test(serverClass),
    serverClass ? '' : 'no Server class extracted'
  );
  // Find the setTimeout method body (handle nested braces by counting from
  // the opening brace).
  const stIdx = serverClass ? serverClass.indexOf('setTimeout') : -1;
  let stBody = '';
  if (stIdx >= 0) {
    const openBrace = serverClass.indexOf('{', stIdx);
    if (openBrace >= 0) {
      let depth = 0;
      for (let i = openBrace; i < serverClass.length; i++) {
        const c = serverClass[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { stBody = serverClass.slice(openBrace, i + 1); break; } }
      }
    }
  }
  ok('serverClass.setTimeout returns this (chainable)',
    /return\s+this\s*;/.test(stBody),
    'method should "return this;" — body=' + stBody.slice(0, 200),
  );
});

group('Server.setKeepAlive method declaration is present (defensive partner)', () => {
  ok('serverClass body contains setKeepAlive',
    serverClass !== null && /\bsetKeepAlive\s*\(/.test(serverClass),
  );
});

// Also verify net.Socket pattern at line ~1753 still has its setTimeout — we
// don't break the existing pattern.
group('regression: net.Socket.setTimeout still present', () => {
  // The net.Socket class is in the same source. Find it by looking for the
  // distinctive ERR_NET_SOCKET_NOT_AVAILABLE comment block.
  const netBlock = src.match(/class Socket extends __eventsMod[\s\S]+?ERR_NET_SOCKET_NOT_AVAILABLE[\s\S]+?return this[\s\S]*?address\(\)/);
  ok('net.Socket class still present', netBlock !== null);
  ok('net.Socket.setTimeout still no-op (return this)',
    src.includes('setTimeout() { return this; }') || src.includes('setTimeout(') && /Socket extends __eventsMod[\s\S]+?setTimeout\s*\([^)]*\)\s*\{\s*return this/.test(src),
  );
});

summary('m1-http-server-setTimeout');
