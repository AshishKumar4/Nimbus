// W3 functional probe — http2 require non-throwing + connect error
//
// axios's `dist/node/axios.cjs` does `var http2 = require('http2')` at
// top level, unconditionally. So `require('http2')` MUST succeed.
//
// http2.connect() on the other hand emits 'error' with code
// ERR_HTTP2_NOT_SUPPORTED — axios only invokes this when user opts
// into HTTP/2 (smoke probe doesn't, so axios passes anyway).

import { execProbe } from '../_helpers.mjs';

export default function http2_load_and_error() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('http2-load-and-error', `
      const http2 = require('http2');
      console.log('H2_TYPEOF=' + (typeof http2));
      console.log('H2_CONNECT_TYPE=' + (typeof http2.connect));
      console.log('H2_CONSTANTS=' + (http2.constants && typeof http2.constants));
      const session = http2.connect('https://example.com');
      session.on('error', (e) => {
        console.log('H2_ERR_CODE=' + (e && e.code));
        console.log('H2_ERR_MSG_OK=' + !!(e && e.message && e.message.length));
      });
      // Wait a moment for the queueMicrotask error
      setTimeout(() => console.log('H2_DONE'), 100);
    `);
    if (!r.ok) return assertProbe('http2-load-and-error', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('H2_TYPEOF=object')
      && so.includes('H2_CONNECT_TYPE=function')
      && so.includes('H2_CONSTANTS=object')
      && so.includes('H2_ERR_CODE=ERR_HTTP2_NOT_SUPPORTED')
      && so.includes('H2_ERR_MSG_OK=true');
    return assertProbe('http2-load-and-error', ok,
      'expected all http2 checks, got:\n' + so, r.output);
  });
}
