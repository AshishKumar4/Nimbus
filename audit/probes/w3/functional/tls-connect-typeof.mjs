// W3 functional probe — tls module surface
import { execProbe } from '../_helpers.mjs';

export default function tls_connect_typeof() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('tls-connect-typeof', `
      const tls = require('tls');
      console.log('TLS_TYPEOF=' + (typeof tls));
      console.log('TLS_CONNECT=' + (typeof tls.connect));
      console.log('TLS_TLSSOCKET=' + (typeof tls.TLSSocket));
      console.log('TLS_CSC=' + (typeof tls.createSecureContext));
    `);
    if (!r.ok) return assertProbe('tls-connect-typeof', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('TLS_TYPEOF=object')
      && so.includes('TLS_CONNECT=function')
      && so.includes('TLS_TLSSOCKET=function')
      && so.includes('TLS_CSC=function');
    return assertProbe('tls-connect-typeof', ok, 'expected tls surface, got:\n' + so, r.output);
  });
}
