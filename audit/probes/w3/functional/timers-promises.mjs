// W3 functional probe — require('timers/promises').setTimeout(ms, value) resolves
import { execProbe } from '../_helpers.mjs';

export default function timers_promises() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('timers-promises', `
      const tp = require('timers/promises');
      console.log('TP_TYPEOF=' + (typeof tp));
      console.log('TP_ST=' + (typeof tp.setTimeout));
      (async () => {
        // Use 0ms so the promise resolves on the next tick, before the
        // facet's drain. The shim wraps setTimeout(0).
        const v = await tp.setTimeout(0, 'value-x');
        console.log('TP_RESOLVED=' + v);
      })();
    `);
    if (!r.ok) return assertProbe('timers-promises', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('TP_TYPEOF=object')
      && so.includes('TP_ST=function')
      && so.includes('TP_RESOLVED=value-x');
    return assertProbe('timers-promises', ok, 'expected setTimeout resolve, got:\n' + so, r.output);
  });
}
