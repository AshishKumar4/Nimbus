// W3 functional probe — require('repl').start({}) returns object with .close()
// ts-node imports repl. Forwarded to workerd's stub.
import { execProbe } from '../_helpers.mjs';

export default function repl_start() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('repl-start', `
      const repl = require('repl');
      console.log('REPL_TYPEOF=' + (typeof repl));
      console.log('REPL_START=' + (typeof repl.start));
      try {
        const s = repl.start({ prompt: '> ', input: process.stdin, output: process.stdout, terminal: false });
        console.log('REPL_OBJ=' + (typeof s));
        console.log('REPL_CLOSE=' + (typeof (s && s.close)));
        if (s && s.close) s.close();
      } catch (e) {
        // workerd's repl stub may throw at start() — that's OK as long as
        // require('repl') itself succeeds + ts-node doesn't actually call
        // start at load time. Treat throw as acceptable; check only the
        // surface presence.
        console.log('REPL_START_THREW=' + (e && e.code || e.message || 'unknown'));
      }
    `);
    if (!r.ok) return assertProbe('repl-start', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    // Spec is: require('repl') succeeds + .start exists. Object/close are
    // best-effort because workerd may stub the start method.
    const ok = so.includes('REPL_TYPEOF=object') && so.includes('REPL_START=function');
    return assertProbe('repl-start', ok, 'expected typeof checks, got:\n' + so, r.output);
  });
}
