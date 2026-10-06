#!/usr/bin/env bun
// behavioral/preview/subpath-imports — `package.json#imports` (subpath
// imports, `#X`) MUST be resolved by the dev-server's bare-import
// rewriter so the browser never sees a literal `#X` specifier.
//
// User repro (Markflow on prod 0a488bab):
//   npm i markflow → vfile/unified/remark/mdx all use `#minpath`,
//   `#minurl`, etc. internally. Preview crashes with
//   `Uncaught TypeError: Failed to resolve module specifier "#minpath"`.
//
// What we test: serve a tiny package with a `package.json#imports`
// entry through /preview/@modules/<pkg>. The rewritten module body
// must NOT contain a literal `"#X"` import — it must be rewritten to
// either a /@modules/ URL OR a relative path that the browser can
// resolve.
//
// failing before fix: rewriteAllImports' SPECIFIER_WITH_QUERY regex
// requires the first char to be [A-Za-z0-9_@] — `#` is rejected — so
// `import x from "#minpath"` survives untouched in the served bundle.
//
// Black-box. ONLY public surfaces: POST /new, WS terminal, GET
// /preview/. Per-bug evidence saved by the parent task.

import { BASE, Terminal, deleteSession, makeAsserter, mintSession, requestHeaders } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('subpath-imports');

const sid = await mintSession();
console.log(`behavioral/preview/subpath-imports — BASE=${BASE} sid=${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(10_000);

// ── scaffold project ──

await t.run('cd /home/user', 5000);
await t.run('mkdir -p /home/user/imp-test/src', 5000);
await t.run('mkdir -p /home/user/imp-test/node_modules/vfile-mini/lib', 5000);

// vfile-mini package: declares #minpath and uses it in lib/index.js.
const vfileMiniPkg = JSON.stringify({
  name: 'vfile-mini',
  version: '1.0.0',
  type: 'module',
  main: 'lib/index.js',
  imports: {
    // Browser condition wins for ESM dev-server resolution.
    '#minpath': {
      browser: './lib/minpath.browser.js',
      default: './lib/minpath.node.js',
    },
  },
}, null, 2);
const vfileMiniIndex = `
import { sep } from '#minpath';
export const VFILE_SEP = sep;
export default { sep };
`;
const vfileMiniBrowser = `export const sep = '/';\nexport default { sep };\n`;
const vfileMiniNode = `import { sep } from 'path';\nexport { sep };\nexport default { sep };\n`;

await t.writeFile('/home/user/imp-test/node_modules/vfile-mini/package.json', vfileMiniPkg, 8000);
await t.writeFile('/home/user/imp-test/node_modules/vfile-mini/lib/index.js', vfileMiniIndex, 8000);
await t.writeFile('/home/user/imp-test/node_modules/vfile-mini/lib/minpath.browser.js', vfileMiniBrowser, 8000);
await t.writeFile('/home/user/imp-test/node_modules/vfile-mini/lib/minpath.node.js', vfileMiniNode, 8000);

// User project entry that imports the package.
const indexHtml = `<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>`;
const mainJs = `import vf from 'vfile-mini';\ndocument.body.textContent = 'sep=' + vf.sep;\n`;
const pkgJson = JSON.stringify({
  name: 'imp-test',
  version: '0.0.0',
  type: 'module',
  scripts: { dev: 'vite --host 0.0.0.0 --port 5173' },
}, null, 2);

await t.writeFile('/home/user/imp-test/index.html', indexHtml, 8000);
await t.writeFile('/home/user/imp-test/src/main.js', mainJs, 8000);
await t.writeFile('/home/user/imp-test/package.json', pkgJson, 8000);

// ── start dev server ──
await t.run('cd /home/user/imp-test', 5000);
t.reset();
t.cmd('npm run dev');
// Wait for the Nimbus banner that confirms vite is up.
await t.waitFor((b) => /Nimbus Vite Dev Server|Local:|Preview:/i.test(b),
  30_000, 'vite banner');

// ── assert: GET /preview/@modules/vfile-mini does NOT contain `"#minpath"` ──
{
  const url = `${BASE}/s/${sid}/preview/@modules/vfile-mini`;
  const resp = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
  const code = await resp.text().catch(() => '');
  a.check('vfile-mini bundle 200',
    resp.status === 200, `status=${resp.status} url=${url}`);
  // Stronger check: no literal `"#minpath"` or `'#minpath'` import in the served body.
  const hasLiteralHash = /from\s+["']#[a-zA-Z]/.test(code) || /import\s*\(\s*["']#/.test(code) || /import\s+["']#[a-zA-Z]/.test(code);
  a.check('served bundle has NO literal "#X" subpath-import specifier',
    !hasLiteralHash,
    hasLiteralHash
      ? `bundle still contains literal #X: ${(code.match(/["']#[a-zA-Z][a-zA-Z0-9_/-]*["']/g) || []).slice(0,3).join(', ')}`
      : '');
  // Sanity: bundle should reference the resolved file or its content.
  const referencesResolved = code.includes("sep = '/'") || code.includes("sep=\"/\"") || code.includes('VFILE_SEP') || code.includes('minpath.browser');
  a.check('served bundle references resolved minpath target',
    referencesResolved,
    referencesResolved ? '' : `code head=${code.slice(0, 300)}`);
}

// ── assert: GET /preview/@modules/vfile-mini/lib/index.js (the importer) ──
//    The bundle path through serveModule may bundle index.js into a
//    single module, so this might be the same response. We accept either
//    the inlined-resolved form or a 200 that doesn't expose `#X`.
{
  const url = `${BASE}/s/${sid}/preview/@modules/vfile-mini`;
  const resp = await fetch(url, { redirect: 'manual', headers: requestHeaders() });
  const code = await resp.text();
  // Must not contain a bare `#minpath` reachable to the browser as a literal.
  const lit = (code.match(/["']#minpath["']/g) || []).length;
  a.check('zero literal "#minpath" tokens in served bundle', lit === 0,
    `count=${lit}`);
}

// ── teardown ──
await t.close();
await deleteSession(sid);
process.exit(a.summary().fail === 0 ? 0 : 1);
