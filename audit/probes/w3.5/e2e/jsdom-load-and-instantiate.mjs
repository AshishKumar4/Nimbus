// W3.5 e2e — npm install jsdom; require it; instantiate JSDOM('<html>...</html>')
//
// Pre-fix: FAIL — `tldts/dist/es6/index.js: file was not pre-bundled` (W3 retro S4).
// Post-fix: PASS — buildPrefetchBundle ESM-transforms tldts's es6 entry; jsdom
//                  loads + parses HTML. (Script execution inside HTML still
//                  blocked by workerd vm — out of scope per W3 retro S5).
//
// Asserts:
//   - typeof JSDOM === 'function'
//   - new JSDOM('<html><body>hi</body></html>').window.document.body.textContent === 'hi'

import { execProbe } from '../_helpers.mjs';

export default function e2e_jsdom_load_and_instantiate() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('e2e-jsdom-load-and-instantiate', `
      const { JSDOM, VirtualConsole } = require('jsdom');
      console.log('JSDOM_TYPE=' + (typeof JSDOM));
      console.log('VC_TYPE=' + (typeof VirtualConsole));
      try {
        const dom = new JSDOM('<html><body><p id="x">hi</p></body></html>');
        const text = dom.window.document.getElementById('x').textContent;
        console.log('JSDOM_TEXT=' + text);
        console.log('JSDOM_TITLE_PROP=' + (typeof dom.window.document.title));
      } catch (e) {
        console.log('JSDOM_INSTANTIATE_ERR=' + (e && e.message ? e.message : String(e)));
      }
    `, {
      preCmds: ['cd app && npm install jsdom'],
      runInDir: '/home/user/app',
      installTimeoutMs: 240_000,
      snippetTimeoutMs: 30_000,
    });
    if (!r.ok) return assertProbe('e2e-jsdom-load-and-instantiate', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('JSDOM_TYPE=function')
      && so.includes('VC_TYPE=function')
      && so.includes('JSDOM_TEXT=hi');
    return assertProbe('e2e-jsdom-load-and-instantiate', ok, 'expected JSDOM to instantiate + parse HTML, got:\n' + so, r.output);
  });
}
