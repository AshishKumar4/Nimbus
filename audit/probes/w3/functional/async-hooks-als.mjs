// W3 functional probe — AsyncLocalStorage.run + getStore
import { execProbe } from '../_helpers.mjs';

export default function async_hooks_als() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('async-hooks-als', `
      const ah = require('async_hooks');
      console.log('AH_ALS_TYPE=' + (typeof ah.AsyncLocalStorage));
      const als = new ah.AsyncLocalStorage();
      const result = als.run({ user: 'alice' }, () => {
        const s = als.getStore();
        return s && s.user;
      });
      console.log('AH_RESULT=' + result);
    `);
    if (!r.ok) return assertProbe('async-hooks-als', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('AH_ALS_TYPE=function') && so.includes('AH_RESULT=alice');
    return assertProbe('async-hooks-als', ok, 'expected ALS flow, got:\n' + so, r.output);
  });
}
