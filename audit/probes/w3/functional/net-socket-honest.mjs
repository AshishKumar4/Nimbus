// W3 functional probe — net.Socket.connect emits 'error' (not silent 'connect')
//
// Pre-build: FAIL — connect emits 'connect' immediately without doing
// any I/O (silent lie at src/node-shims.ts:883).
// Post-build: PASS — emits 'error' with code ERR_NET_SOCKET_NOT_AVAILABLE.

import { execProbe } from '../_helpers.mjs';

export default function net_socket_honest() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('net-socket-honest', `
      const net = require('net');
      // Log directly from the listeners — the facet drain happens
      // after a single setTimeout(0) tick, which is fine for
      // queueMicrotask but unreliable for setTimeout(50). We log
      // INSIDE the connect/error handlers so the output is captured
      // before drain.
      const s = new net.Socket();
      let resolved = false;
      s.on('connect', () => {
        console.log('NS_CONNECT_FIRED=true');
        console.log('NS_ERROR_CODE=null');
        console.log('NS_ERROR_MSG_OK=false');
        resolved = true;
      });
      s.on('error', (e) => {
        console.log('NS_CONNECT_FIRED=false');
        console.log('NS_ERROR_CODE=' + (e && e.code));
        console.log('NS_ERROR_MSG_OK=' + !!(e && e.message));
        resolved = true;
      });
      s.connect(443, 'example.com');
      // Yield once via setTimeout(0) so the queueMicrotask error fires
      // before the facet's first drain pass terminates output.
      setTimeout(() => {
        if (!resolved) console.log('NS_NEITHER_FIRED=true');
      }, 0);
    `);
    if (!r.ok) return assertProbe('net-socket-honest', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('NS_CONNECT_FIRED=false')
      && so.includes('NS_ERROR_CODE=ERR_NET_SOCKET_NOT_AVAILABLE')
      && so.includes('NS_ERROR_MSG_OK=true');
    return assertProbe('net-socket-honest', ok,
      'expected error not connect, got:\n' + so, r.output);
  });
}
