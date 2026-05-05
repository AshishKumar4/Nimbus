// W3.5 functional probe — broken-syntax modules surface a real SyntaxError
//
// Pre-fix: FAIL — a .js file with invalid syntax fails `new Function` at
//                 facet startup; the try{}catch{} swallows the error; at
//                 require time the user sees "file was not pre-bundled"
//                 which is confusing because the file IS in the bundle.
// Post-fix: PASS — the pre-compile step records failures into a list shipped
//                  alongside the bundle; __loadModule consults the list and
//                  surfaces the original SyntaxError text.
//
// Strategy: write a .js file whose contents are syntactically broken AND
// not regex-detectable as ESM (so the ESM transform doesn't catch it),
// then require it. Assert the error message names a SyntaxError or quotes
// the broken token, NOT "file was not pre-bundled".

import { execProbe } from '../_helpers.mjs';

export default function silent_compile_failure_surfaces() {
  // `let x =` is invalid CJS too: incomplete declaration. Esbuild's
  // ESM-detector (regex) won't match it (no top-level import/export), so
  // the file flows through to the new-Function precompile and fails with
  // SyntaxError "Unexpected end of input" or similar.
  const brokenBody = 'let x =\n';

  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('silent-compile-failure-surfaces', `
      try {
        require('./broken.js');
        console.log('UNEXPECTED_OK');
      } catch (e) {
        console.log('CAUGHT_MSG=' + (e && e.message ? e.message : String(e)));
      }
    `, {
      preFileWrites: [
        ['/home/user/app/broken.js', brokenBody],
        [
          '/home/user/app/package.json',
          JSON.stringify({ name: 'w35-broken-fixture', version: '0.0.0' }),
        ],
      ],
      runInDir: '/home/user/app',
    });
    if (!r.ok) return assertProbe('silent-compile-failure-surfaces', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    // Must NOT show the misleading legacy error.
    const wrong = so.includes('file was not pre-bundled');
    // Should show a SyntaxError or pre-compile narrative; we accept either:
    //   - "pre-compile failed at facet startup: <err>" (Fix C narrative)
    //   - "Unexpected end of input" / "Unexpected token" (raw SyntaxError)
    const right = /CAUGHT_MSG=/.test(so)
      && (so.includes('pre-compile failed') || so.includes('Unexpected') || so.includes('SyntaxError'));
    const ok = right && !wrong;
    const why = wrong
      ? 'still emits the misleading "file was not pre-bundled" error:\n'
      : 'expected a SyntaxError-mentioning message, got:\n';
    return assertProbe('silent-compile-failure-surfaces', ok, why + so, r.output);
  });
}
