// W3 functional probe — diagnostics_channel Channel.runStores exists + runs fn
//
// Review C2: fastify@5 uses channel.runStores at request time. Workerd's
// node:diagnostics_channel exposes this method. Verify the forward.
import { execProbe } from '../_helpers.mjs';

export default function diagnostics_channel_runStores() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('diagnostics-channel-runStores', `
      const dc = require('diagnostics_channel');
      const ch = dc.channel('w3.runStores');
      console.log('DC_RUNSTORES_TYPE=' + (typeof ch.runStores));
      let inside = null;
      const out = ch.runStores({ tag: 'context' }, function(arg1, arg2) {
        inside = arg1 + ':' + arg2;
        return 'returned';
      }, undefined, 'a', 'b');
      console.log('DC_INSIDE=' + inside);
      console.log('DC_OUT=' + out);
    `);
    if (!r.ok) return assertProbe('diagnostics-channel-runStores', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    // Workerd's runStores semantics may differ slightly. Pass conditions:
    //   1. runStores exists (typeof function).
    //   2. The fn was invoked (inside is set).
    //   3. The return value flows out.
    const ok = so.includes('DC_RUNSTORES_TYPE=function')
      && so.includes('DC_INSIDE=a:b')
      && so.includes('DC_OUT=returned');
    return assertProbe('diagnostics-channel-runStores', ok, 'expected runStores flow, got:\n' + so, r.output);
  });
}
