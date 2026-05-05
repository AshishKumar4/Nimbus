// W3.5 functional probe — require() of a directory falls back to <dir>/index.js
//
// Pre-fix: FAIL — `__resolveFile` in node-shims.ts returns the bare directory
//                 path (because __fileExists matches via __vfsDirs / prefix
//                 scan), then __loadModule tries to read a directory as a
//                 file → "Cannot read module: <dir>".
// Post-fix: PASS — the empty-extension probe is gated on __pathIsFile (strict
//                  file membership), so the loop continues to /index.js.
//
// Strategy: write a fixture package to VFS with `main: "lib"` (a directory),
// then `require('./fixture')`. Hits the same bug path as fastify's
// `ret/dist/types` directory require.

import { execProbe } from '../_helpers.mjs';

export default function directory_as_index() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('directory-as-index', `
      const m = require('./fixture');
      console.log('FIX_TYPE=' + (typeof m));
      console.log('FIX_HELLO=' + (m && m.hello));
      console.log('FIX_VAL=' + (m && m.value));
    `, {
      preFileWrites: [
        // Fixture: a CJS package whose 'main' is a directory.
        [
          '/home/user/app/fixture/package.json',
          JSON.stringify({ name: 'fixture', main: 'lib' }),
        ],
        [
          '/home/user/app/fixture/lib/index.js',
          'module.exports = { hello: "world", value: 42 };\n',
        ],
        // Top-level package.json so cwd resolution is sensible.
        [
          '/home/user/app/package.json',
          JSON.stringify({ name: 'w35-fixture-app', version: '0.0.0' }),
        ],
      ],
      runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('directory-as-index', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FIX_TYPE=object')
      && so.includes('FIX_HELLO=world')
      && so.includes('FIX_VAL=42');
    return assertProbe('directory-as-index', ok, 'expected directory-as-index require to work, got:\n' + so, r.output);
  });
}
