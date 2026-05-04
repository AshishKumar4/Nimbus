// W3 functional probe — diagnostics_channel pub/sub
import { execProbe } from '../_helpers.mjs';

export default function diagnostics_channel_pubsub() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('diagnostics-channel-pubsub', `
      const dc = require('diagnostics_channel');
      let received = null;
      const ch = dc.channel('w3.test');
      ch.subscribe((msg) => { received = msg; });
      // hasSubscribers may be a getter (real Node) or a method (some
      // workerd versions). Both should yield truthy after a subscribe.
      const has = (typeof ch.hasSubscribers === 'function') ? ch.hasSubscribers() : ch.hasSubscribers;
      console.log('DC_HAS_BEFORE=' + !!has);
      ch.publish({ hello: 'world' });
      console.log('DC_RECEIVED=' + JSON.stringify(received));
    `);
    if (!r.ok) return assertProbe('diagnostics-channel-pubsub', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('DC_HAS_BEFORE=true') && so.includes('DC_RECEIVED={"hello":"world"}');
    return assertProbe('diagnostics-channel-pubsub', ok, 'expected pubsub flow, got:\n' + so, r.output);
  });
}
