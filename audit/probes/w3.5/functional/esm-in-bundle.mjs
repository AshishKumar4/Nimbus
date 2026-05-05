// W3.5 functional probe — ESM source files in __MODULE_VFS_BUNDLE compile and load
//
// Pre-fix: FAIL — facet-manager.ts:208/386 wraps ESM source in `new Function`,
//                 which throws SyntaxError on top-level `import`/`export`. The
//                 try{}catch{} swallows the error, leaving the precompiled-
//                 modules map without an entry. At require time, __loadModule
//                 falls through to a request-time `new Function` which workerd
//                 CSP rejects, producing "file was not pre-bundled".
// Post-fix: PASS — buildPrefetchBundle pre-transforms ESM-detected files via
//                  esbuild → CJS so they compile cleanly.
//
// Strategy: write a CJS entry that requires a `.mjs` file using bare ESM
// syntax. The `.mjs` lands in the bundle with its ESM bytes; at facet
// startup it must be transformed to CJS. Hits the same code path as
// jsdom requiring tldts/dist/es6/index.js.

import { execProbe } from '../_helpers.mjs';

export default function esm_in_bundle() {
  // Use a non-trivial ESM body: top-level import + named export + default
  // export. Esbuild's CJS transform should produce module.exports of an
  // object with named keys + a `default` synthesised key.
  const esmBody =
    'export const greeting = "hello-from-esm";\n' +
    'export function shout(s) { return String(s).toUpperCase() + "!"; }\n' +
    'export default { kind: "esm-default" };\n';

  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('esm-in-bundle', `
      const m = require('./esm-mod.mjs');
      console.log('ESM_TYPE=' + (typeof m));
      console.log('ESM_GREETING=' + (m && m.greeting));
      console.log('ESM_SHOUT=' + (m && typeof m.shout === 'function' ? m.shout('ok') : 'NO_FN'));
      console.log('ESM_DEFAULT_KIND=' + (m && m.default && m.default.kind));
    `, {
      preFileWrites: [
        ['/home/user/app/esm-mod.mjs', esmBody],
        [
          '/home/user/app/package.json',
          JSON.stringify({ name: 'w35-esm-fixture', version: '0.0.0' }),
        ],
      ],
      runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('esm-in-bundle', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('ESM_TYPE=object')
      && so.includes('ESM_GREETING=hello-from-esm')
      && so.includes('ESM_SHOUT=OK!')
      && so.includes('ESM_DEFAULT_KIND=esm-default');
    return assertProbe('esm-in-bundle', ok, 'expected ESM file to load via require, got:\n' + so, r.output);
  });
}
