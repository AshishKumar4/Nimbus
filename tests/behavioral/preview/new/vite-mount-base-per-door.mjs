#!/usr/bin/env bun
// preview/new/vite-mount-base-per-door — one dev server, two doors, two bases.
//
// A single `ViteDevServer` answers both `/s/<sid>/preview/` and
// `/s/<sid>/port/<n>/`. The base it serves — `<base href>`, the rewritten
// absolute-path assets, and the module URLs the browser fetches next — must
// match the door the request arrived through. Baking one base at construction
// made the port door emit the preview door's base, so every asset resolved
// under a prefix that door does not serve.

import { fetchPort, fetchPreview, heredocCommand, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/vite-mount-base-per-door';
const a = makeAsserter(label);
console.log(`${label} — BASE=${process.env.BASE}`);

const ROOT = '/home/user/mountapp';
const PORT = 3000;

const INDEX_HTML = [
  '<!doctype html>',
  '<html><head><title>mount base app</title>',
  '<link rel="stylesheet" href="/style.css">',
  '</head><body><main id="root">nimbus-mount-base</main>',
  '<script type="module" src="/src/main.js"></script>',
  '</body></html>',
].join('\n');

const sid = await mintSession();
const term = new Terminal(sid);

try {
  await term.connect();
  await term.waitForPrompt();

  await term.run(`mkdir -p ${ROOT}/src`);
  await term.run(heredocCommand(`${ROOT}/index.html`, INDEX_HTML));
  await term.run(heredocCommand(`${ROOT}/style.css`, '#root { color: rgb(1, 2, 3); }'));
  await term.run(heredocCommand(`${ROOT}/src/main.js`, "document.getElementById('root').dataset.ready = 'yes';"));

  term.cmd(`vite --root ${ROOT} --host 0.0.0.0 --port ${PORT}`);

  // Both doors must answer before anything is asserted about their content.
  let preview = null;
  let port = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    preview = await fetchPreview(sid);
    port = await fetchPort(sid, PORT);
    if (preview.status === 200 && port.status === 200) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  a.check('preview door serves the app', preview?.status === 200, `status=${preview?.status}`);
  a.check('port door serves the app', port?.status === 200, `status=${port?.status}`);

  const previewBase = /<base href="([^"]+)"/.exec(preview?.html || '')?.[1];
  const portBase = /<base href="([^"]+)"/.exec(port?.body || '')?.[1];

  a.check(
    'preview door emits its own base',
    previewBase === `/s/${sid}/preview/`,
    `base=${previewBase}`,
  );
  a.check(
    'port door emits its own base',
    portBase === `/s/${sid}/port/${PORT}/`,
    `base=${portBase}`,
  );
  a.check(
    'port door leaks no /preview/ prefix',
    !(port?.body || '').includes(`/s/${sid}/preview/`),
    'port HTML referenced the preview mount',
  );

  // The bases must actually resolve — a correct `<base href>` over 404ing
  // assets would still be a broken door.
  const css = await fetchPort(sid, PORT, 'style.css');
  const mod = await fetchPort(sid, PORT, 'src/main.js');
  a.check('port door serves an absolute-path asset', css.status === 200, `status=${css.status}`);
  a.check('port door serves a transformed module', mod.status === 200, `status=${mod.status}`);
  a.check(
    'port-door module is JavaScript',
    /javascript/i.test(mod.headers?.get('content-type') || ''),
    `content-type=${mod.headers?.get('content-type')}`,
  );

  const previewCss = await fetchPreview(sid, { path: 'style.css' });
  a.check('preview door still serves its own asset', previewCss.status === 200, `status=${previewCss.status}`);
} finally {
  await term.close().catch(() => {});
}

const { fail } = a.summary();
process.exit(fail === 0 ? 0 : 1);
