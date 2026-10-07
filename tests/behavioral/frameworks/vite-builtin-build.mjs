#!/usr/bin/env bun
// frameworks/vite-builtin-build — `npm run build` in a create-vite React
// project runs Nimbus's built-in `vite build` (esbuild underneath), which
// must emit what Vite emits: dist/index.html referencing hashed JS, hashed
// copies of imported assets (svg/png), and public/ copied to the dist root.
// `npm run dev` still serves the app through the port route afterwards.
//
// Before the fix the built-in build handed asset imports to the JS loader
// and the template failed with "Unexpected" / "JSX syntax" errors while
// `npm run dev` worked. The SvelteKit half of that fix (the honest refusal
// of framework plugins) is asserted in frameworks/sveltekit-real.

import {
  BASE, Terminal, mintSession, deleteSession, makeAsserter, stripAnsi, fetchPort, sleep,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('frameworks/vite-builtin-build');
const sid = await mintSession();
console.log(`[vite-builtin-build] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
/** A command's output and exit status. */
async function run(cmd, timeoutMs) {
  const output = stripAnsi((await t.run(`${cmd}; echo "___EXIT=$?___"`, timeoutMs)).output);
  return { code: Number(output.match(/___EXIT=(\d+)___/)?.[1] ?? -1), output };
}
const tail = (s, n = 20) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const created = await run('cd /home/user && npm create vite@latest vt -- --template react 2>&1', 300_000);
  a.check('create-vite scaffolds the React template', created.code === 0, tail(created.output));
  if (created.code !== 0) throw new Error('scaffold failed');
  const installed = await run('cd /home/user/vt && npm install 2>&1', 600_000);
  a.check('npm install succeeds', installed.code === 0, tail(installed.output));
  if (installed.code !== 0) throw new Error('install failed');

  const built = await run('npm run build 2>&1', 300_000);
  a.check('npm run build exits 0', built.code === 0, tail(built.output));
  a.check('the build reports no asset-as-JS errors', !/Build error|Unexpected|JSX syntax/.test(built.output), tail(built.output));

  const dist = (await run('ls dist dist/assets && cat dist/index.html', 30_000)).output;
  a.check('dist/assets holds hashed JS', /(index|main)-[\w-]+\.js/.test(dist), tail(dist, 30));
  a.check('imported assets are emitted hashed', /-[\w-]+\.(svg|png)/.test(dist), tail(dist, 30));
  a.check('public/ is copied to the dist root', /(favicon|vite)\.svg/.test(dist), tail(dist, 30));
  a.check('dist/index.html references the hashed JS', /\/assets\/[\w-]+-[\w-]+\.js/.test(dist), tail(dist, 30));

  // The dev server still serves, through /port/<n>/ (not a loopback listener).
  t.reset();
  t.cmd('npm run dev');
  await t.waitFor((b) => /Preview:|pid=\d+|Local:/.test(b), 60_000, 'dev server banner');
  const banner = stripAnsi(t.buf);
  const port = Number((banner.match(/port=(\d+)/) || banner.match(/Port:\s*(\d+)/) || [])[1] ?? 5173);
  let page = null;
  for (const until = Date.now() + 30_000; Date.now() < until;) {
    page = await fetchPort(sid, port).catch(() => null);
    if (page && page.status === 200 && /<div id="root"/.test(page.body)) break;
    await sleep(1_000);
  }
  a.check('npm run dev serves the app through the port route', page?.status === 200 && /<div id="root"/.test(page.body),
    `port=${port} status=${page?.status} ${String(page?.body ?? '').slice(0, 200)}`);
} finally {
  await t.close();
  const deleted = await deleteSession(sid);
  a.check('probe session deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
